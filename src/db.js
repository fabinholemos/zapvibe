require('dotenv').config()
const { Pool } = require('pg')

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost')
    ? { rejectUnauthorized: false }
    : false
})

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT DEFAULT 'user',
      status TEXT DEFAULT 'pending',
      instance_name TEXT,
      name TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      trial_ends_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS contacts (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      nome TEXT DEFAULT '',
      telefone TEXT NOT NULL,
      empresa TEXT DEFAULT '',
      extra TEXT DEFAULT '',
      vencimento TEXT DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS templates (
      id TEXT PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS autoreplies (
      id TEXT PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      trigger TEXT DEFAULT 'keywords',
      keywords JSONB DEFAULT '[]',
      response TEXT DEFAULT '',
      delay INTEGER DEFAULT 1500,
      active BOOLEAN DEFAULT TRUE,
      media_base64 TEXT,
      media_mimetype TEXT,
      media_filename TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      template_id TEXT,
      template_name TEXT
    );
    CREATE TABLE IF NOT EXISTS campaign_log (
      id TEXT PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      template_id TEXT,
      template_name TEXT,
      phones JSONB DEFAULT '[]',
      contacts_data JSONB DEFAULT '[]',
      sent INTEGER DEFAULT 0,
      failed INTEGER DEFAULT 0,
      sent_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS groups_table (
      id TEXT PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      phones JSONB DEFAULT '[]',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS lid_map (
      lid TEXT PRIMARY KEY,
      jid TEXT NOT NULL,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS draft (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      content TEXT DEFAULT ''
    );
  `)
  // Migração segura: adiciona colunas novas se tabelas já existiam
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS instance_name TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS name TEXT DEFAULT '';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT DEFAULT '';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ;
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS vencimento TEXT DEFAULT '';
    ALTER TABLE templates ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
    ALTER TABLE autoreplies ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
    ALTER TABLE campaign_log ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
    ALTER TABLE groups_table ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
    ALTER TABLE lid_map ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
    ALTER TABLE draft ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
  `).catch(() => {})

  // Atribui dados órfãos (user_id NULL) ao primeiro admin
  await pool.query(`
    DO $$
    DECLARE admin_id INTEGER;
    BEGIN
      SELECT id INTO admin_id FROM users WHERE role='admin' ORDER BY id LIMIT 1;
      IF admin_id IS NOT NULL THEN
        UPDATE contacts SET user_id=admin_id WHERE user_id IS NULL;
        UPDATE templates SET user_id=admin_id WHERE user_id IS NULL;
        UPDATE autoreplies SET user_id=admin_id WHERE user_id IS NULL;
        UPDATE campaign_log SET user_id=admin_id WHERE user_id IS NULL;
        UPDATE groups_table SET user_id=admin_id WHERE user_id IS NULL;
        UPDATE lid_map SET user_id=admin_id WHERE user_id IS NULL;
      END IF;
    END $$;
  `).catch(() => {})
}

// ── Contacts ──────────────────────────────────────────────────────────────────

async function getContacts(userId) {
  const { rows } = await pool.query('SELECT nome, telefone, empresa, extra, vencimento FROM contacts WHERE user_id=$1 ORDER BY id', [userId])
  return rows
}

async function saveContacts(contacts, userId) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('DELETE FROM contacts WHERE user_id=$1', [userId])
    for (const c of contacts) {
      await client.query(
        'INSERT INTO contacts (user_id, nome, telefone, empresa, extra, vencimento) VALUES ($1,$2,$3,$4,$5,$6)',
        [userId, c.nome || '', c.telefone, c.empresa || '', c.extra || '', c.vencimento || '']
      )
    }
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
}

async function addContact(c, userId) {
  await pool.query(
    'INSERT INTO contacts (user_id, nome, telefone, empresa, extra, vencimento) VALUES ($1,$2,$3,$4,$5,$6)',
    [userId, c.nome || '', c.telefone, c.empresa || '', c.extra || '', c.vencimento || '']
  )
}

async function updateContact(oldTelefone, c, userId) {
  await pool.query(
    'UPDATE contacts SET nome=$1, telefone=$2, empresa=$3, extra=$4, vencimento=$5 WHERE telefone=$6 AND user_id=$7',
    [c.nome || '', c.telefone || oldTelefone, c.empresa || '', c.extra || '', c.vencimento || '', oldTelefone, userId]
  )
}

async function deleteContact(telefone, userId) {
  await pool.query('DELETE FROM contacts WHERE telefone=$1 AND user_id=$2', [telefone, userId])
}

// ── Draft template ────────────────────────────────────────────────────────────

async function getDraft(userId) {
  const { rows } = await pool.query('SELECT content FROM draft WHERE user_id=$1', [userId])
  return rows[0]?.content || ''
}

async function saveDraft(content, userId) {
  await pool.query(
    'INSERT INTO draft (user_id, content) VALUES ($1,$2) ON CONFLICT (user_id) DO UPDATE SET content=$2',
    [userId, content]
  )
}

// ── Named templates ───────────────────────────────────────────────────────────

async function getTemplates(userId) {
  const { rows } = await pool.query(
    'SELECT id, name, content, created_at as "createdAt" FROM templates WHERE user_id=$1 ORDER BY created_at',
    [userId]
  )
  return rows
}

async function addTemplate(t, userId) {
  const { rows } = await pool.query(
    'INSERT INTO templates (id, user_id, name, content, created_at) VALUES ($1,$2,$3,$4,$5) RETURNING id, name, content, created_at as "createdAt"',
    [t.id, userId, t.name, t.content, t.createdAt]
  )
  return rows[0]
}

async function updateTemplate(id, updates, userId) {
  await pool.query(
    'UPDATE templates SET name=$1, content=$2 WHERE id=$3 AND user_id=$4',
    [updates.name, updates.content, id, userId]
  )
}

async function deleteTemplate(id, userId) {
  await pool.query('DELETE FROM templates WHERE id=$1 AND user_id=$2', [id, userId])
}

// ── Autoreplies ───────────────────────────────────────────────────────────────

async function getAutoreplies(userId) {
  const { rows } = await pool.query('SELECT * FROM autoreplies WHERE user_id=$1 ORDER BY created_at', [userId])
  return rows.map(r => ({
    id: r.id,
    name: r.name,
    trigger: r.trigger,
    keywords: r.keywords,
    response: r.response,
    delay: r.delay,
    active: r.active,
    mediaBase64: r.media_base64,
    mediaMimetype: r.media_mimetype,
    mediaFilename: r.media_filename,
    createdAt: r.created_at,
    templateId: r.template_id,
    templateName: r.template_name
  }))
}

async function addAutoreply(r, userId) {
  await pool.query(
    `INSERT INTO autoreplies
      (id, user_id, name, trigger, keywords, response, delay, active, media_base64, media_mimetype, media_filename, created_at, template_id, template_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      r.id, userId, r.name, r.trigger,
      JSON.stringify(r.keywords || []),
      r.response || '', r.delay || 1500, r.active !== false,
      r.mediaBase64 || null, r.mediaMimetype || null, r.mediaFilename || null,
      r.createdAt, r.templateId || null, r.templateName || null
    ]
  )
}

async function updateAutoreply(id, updates, userId) {
  const { rows } = await pool.query('SELECT * FROM autoreplies WHERE id=$1 AND user_id=$2', [id, userId])
  const cur = rows[0]
  if (!cur) return
  await pool.query(
    `UPDATE autoreplies SET
      name=$1, trigger=$2, keywords=$3, response=$4, delay=$5, active=$6,
      media_base64=$7, media_mimetype=$8, media_filename=$9,
      template_id=$10, template_name=$11
     WHERE id=$12 AND user_id=$13`,
    [
      updates.name       ?? cur.name,
      updates.trigger    ?? cur.trigger,
      JSON.stringify(updates.keywords ?? cur.keywords),
      updates.response   ?? cur.response,
      updates.delay      ?? cur.delay,
      updates.active     !== undefined ? updates.active     : cur.active,
      updates.mediaBase64    !== undefined ? updates.mediaBase64    : cur.media_base64,
      updates.mediaMimetype  !== undefined ? updates.mediaMimetype  : cur.media_mimetype,
      updates.mediaFilename  !== undefined ? updates.mediaFilename  : cur.media_filename,
      updates.templateId     !== undefined ? updates.templateId     : cur.template_id,
      updates.templateName   !== undefined ? updates.templateName   : cur.template_name,
      id, userId
    ]
  )
}

async function deleteAutoreply(id, userId) {
  await pool.query('DELETE FROM autoreplies WHERE id=$1 AND user_id=$2', [id, userId])
}

// ── Campaign log ──────────────────────────────────────────────────────────────

async function getCampaignLog(userId) {
  const { rows } = await pool.query(
    `SELECT id, template_id as "templateId", template_name as "templateName",
            phones, contacts_data as contacts, sent, failed, sent_at as "sentAt"
     FROM campaign_log WHERE user_id=$1 ORDER BY sent_at`,
    [userId]
  )
  return rows
}

async function addCampaignLog(entry, userId) {
  await pool.query(
    `INSERT INTO campaign_log (id, user_id, template_id, template_name, phones, contacts_data, sent, failed, sent_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      entry.id, userId, entry.templateId || null, entry.templateName || '',
      JSON.stringify(entry.phones || []),
      JSON.stringify(entry.contacts || []),
      entry.sent || 0, entry.failed || 0, entry.sentAt
    ]
  )
  await pool.query(`
    DELETE FROM campaign_log WHERE user_id=$1 AND id NOT IN (
      SELECT id FROM campaign_log WHERE user_id=$1 ORDER BY sent_at DESC LIMIT 50
    )
  `, [userId])
}

// ── Groups ────────────────────────────────────────────────────────────────────

async function getGroups(userId) {
  const { rows } = await pool.query(
    'SELECT id, name, phones, created_at as "createdAt" FROM groups_table WHERE user_id=$1 ORDER BY created_at',
    [userId]
  )
  return rows
}

async function addGroup(g, userId) {
  const { rows } = await pool.query(
    'INSERT INTO groups_table (id, user_id, name, phones, created_at) VALUES ($1,$2,$3,$4,$5) RETURNING id, name, phones, created_at as "createdAt"',
    [g.id, userId, g.name, JSON.stringify(g.phones || []), g.createdAt]
  )
  return rows[0]
}

async function updateGroup(id, updates, userId) {
  const { rows } = await pool.query('SELECT * FROM groups_table WHERE id=$1 AND user_id=$2', [id, userId])
  const cur = rows[0]
  if (!cur) return
  await pool.query(
    'UPDATE groups_table SET name=$1, phones=$2 WHERE id=$3 AND user_id=$4',
    [updates.name ?? cur.name, JSON.stringify(updates.phones ?? cur.phones), id, userId]
  )
}

async function deleteGroup(id, userId) {
  await pool.query('DELETE FROM groups_table WHERE id=$1 AND user_id=$2', [id, userId])
}

// ── LID map ───────────────────────────────────────────────────────────────────

async function getLidEntry(lid, userId) {
  const { rows } = await pool.query('SELECT jid FROM lid_map WHERE lid=$1 AND user_id=$2', [lid, userId])
  return rows[0]?.jid || null
}

async function saveLidEntry(lid, jid, userId) {
  await pool.query(
    'INSERT INTO lid_map (lid, jid, user_id) VALUES ($1,$2,$3) ON CONFLICT (lid) DO UPDATE SET jid=$2',
    [lid, jid, userId]
  )
}

// ── Auth ──────────────────────────────────────────────────────────────────────

async function upsertUser(email, passwordHash, role = 'user', status = 'pending', instanceName = null) {
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, role, status, instance_name)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (email) DO UPDATE SET password_hash=$2, role=$3, status=EXCLUDED.status
     RETURNING id`,
    [email, passwordHash, role, status, instanceName]
  )
  return rows[0]
}

async function getUserByEmail(email) {
  const { rows } = await pool.query('SELECT * FROM users WHERE email=$1', [email])
  return rows[0] || null
}

async function getUserByInstance(instanceName) {
  const { rows } = await pool.query('SELECT * FROM users WHERE instance_name=$1', [instanceName])
  return rows[0] || null
}

async function getUserById(id) {
  const { rows } = await pool.query('SELECT * FROM users WHERE id=$1', [id])
  return rows[0] || null
}

async function getAllUsers() {
  const { rows } = await pool.query(
    'SELECT id, email, name, phone, role, status, instance_name, trial_ends_at, created_at FROM users ORDER BY created_at'
  )
  return rows
}

async function registerUser(name, email, phone, passwordHash) {
  const { rows } = await pool.query(
    `INSERT INTO users (name, email, phone, password_hash, role, status)
     VALUES ($1,$2,$3,$4,'user','pending') RETURNING id`,
    [name, email, phone, passwordHash]
  )
  const id = rows[0].id
  await pool.query('UPDATE users SET instance_name=$1 WHERE id=$2', ['zv' + id, id])
  return id
}

async function updateUser(id, updates) {
  const allowed = ['status', 'role', 'instance_name', 'password_hash', 'trial_ends_at', 'name', 'phone']
  const sets = []
  const vals = []
  let i = 1
  for (const key of allowed) {
    if (updates[key] !== undefined) {
      sets.push(`${key}=$${i++}`)
      vals.push(updates[key])
    }
  }
  if (!sets.length) return
  vals.push(id)
  await pool.query(`UPDATE users SET ${sets.join(', ')} WHERE id=$${i}`, vals)
}

async function deleteUser(id) {
  await pool.query('DELETE FROM users WHERE id=$1', [id])
}

async function createSession(token, email) {
  const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
  await pool.query(
    'INSERT INTO sessions (token, email, expires_at) VALUES ($1,$2,$3)',
    [token, email, expires]
  )
}

async function getSession(token) {
  const { rows } = await pool.query(
    'SELECT * FROM sessions WHERE token=$1 AND expires_at > NOW()',
    [token]
  )
  return rows[0] || null
}

async function deleteSession(token) {
  await pool.query('DELETE FROM sessions WHERE token=$1', [token])
}

async function ping() {
  await pool.query('SELECT 1')
}

module.exports = {
  init, ping,
  getContacts, saveContacts, addContact, updateContact, deleteContact,
  getDraft, saveDraft,
  getTemplates, addTemplate, updateTemplate, deleteTemplate,
  getAutoreplies, addAutoreply, updateAutoreply, deleteAutoreply,
  getCampaignLog, addCampaignLog,
  getGroups, addGroup, updateGroup, deleteGroup,
  getLidEntry, saveLidEntry,
  upsertUser, getUserByEmail, getUserByInstance, getUserById, getAllUsers, updateUser, deleteUser, registerUser,
  createSession, getSession, deleteSession
}
