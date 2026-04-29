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
    CREATE TABLE IF NOT EXISTS contacts (
      id SERIAL PRIMARY KEY,
      nome TEXT DEFAULT '',
      telefone TEXT NOT NULL,
      empresa TEXT DEFAULT '',
      extra TEXT DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS autoreplies (
      id TEXT PRIMARY KEY,
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
      name TEXT NOT NULL,
      phones JSONB DEFAULT '[]',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS lid_map (
      lid TEXT PRIMARY KEY,
      jid TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS draft (
      id INTEGER PRIMARY KEY DEFAULT 1,
      content TEXT DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT DEFAULT 'admin',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL
    );
    INSERT INTO draft (id, content) VALUES (1, '') ON CONFLICT DO NOTHING;
  `)
}

// ── Contacts ──────────────────────────────────────────────────────────────────

async function getContacts() {
  const { rows } = await pool.query('SELECT nome, telefone, empresa, extra FROM contacts ORDER BY id')
  return rows
}

async function saveContacts(contacts) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('DELETE FROM contacts')
    for (const c of contacts) {
      await client.query(
        'INSERT INTO contacts (nome, telefone, empresa, extra) VALUES ($1,$2,$3,$4)',
        [c.nome || '', c.telefone, c.empresa || '', c.extra || '']
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

async function addContact(c) {
  await pool.query(
    'INSERT INTO contacts (nome, telefone, empresa, extra) VALUES ($1,$2,$3,$4)',
    [c.nome || '', c.telefone, c.empresa || '', c.extra || '']
  )
}

async function updateContact(oldTelefone, c) {
  await pool.query(
    'UPDATE contacts SET nome=$1, telefone=$2, empresa=$3, extra=$4 WHERE telefone=$5',
    [c.nome || '', c.telefone || oldTelefone, c.empresa || '', c.extra || '', oldTelefone]
  )
}

async function deleteContact(telefone) {
  await pool.query('DELETE FROM contacts WHERE telefone=$1', [telefone])
}

// ── Draft template ────────────────────────────────────────────────────────────

async function getDraft() {
  const { rows } = await pool.query('SELECT content FROM draft WHERE id=1')
  return rows[0]?.content || ''
}

async function saveDraft(content) {
  await pool.query('UPDATE draft SET content=$1 WHERE id=1', [content])
}

// ── Named templates ───────────────────────────────────────────────────────────

async function getTemplates() {
  const { rows } = await pool.query(
    'SELECT id, name, content, created_at as "createdAt" FROM templates ORDER BY created_at'
  )
  return rows
}

async function addTemplate(t) {
  const { rows } = await pool.query(
    'INSERT INTO templates (id, name, content, created_at) VALUES ($1,$2,$3,$4) RETURNING id, name, content, created_at as "createdAt"',
    [t.id, t.name, t.content, t.createdAt]
  )
  return rows[0]
}

async function updateTemplate(id, updates) {
  await pool.query(
    'UPDATE templates SET name=$1, content=$2 WHERE id=$3',
    [updates.name, updates.content, id]
  )
}

async function deleteTemplate(id) {
  await pool.query('DELETE FROM templates WHERE id=$1', [id])
}

// ── Autoreplies ───────────────────────────────────────────────────────────────

async function getAutoreplies() {
  const { rows } = await pool.query('SELECT * FROM autoreplies ORDER BY created_at')
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

async function addAutoreply(r) {
  await pool.query(
    `INSERT INTO autoreplies
      (id, name, trigger, keywords, response, delay, active, media_base64, media_mimetype, media_filename, created_at, template_id, template_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      r.id, r.name, r.trigger,
      JSON.stringify(r.keywords || []),
      r.response || '', r.delay || 1500, r.active !== false,
      r.mediaBase64 || null, r.mediaMimetype || null, r.mediaFilename || null,
      r.createdAt, r.templateId || null, r.templateName || null
    ]
  )
}

async function updateAutoreply(id, updates) {
  const { rows } = await pool.query('SELECT * FROM autoreplies WHERE id=$1', [id])
  const cur = rows[0]
  if (!cur) return
  await pool.query(
    `UPDATE autoreplies SET
      name=$1, trigger=$2, keywords=$3, response=$4, delay=$5, active=$6,
      media_base64=$7, media_mimetype=$8, media_filename=$9,
      template_id=$10, template_name=$11
     WHERE id=$12`,
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
      id
    ]
  )
}

async function deleteAutoreply(id) {
  await pool.query('DELETE FROM autoreplies WHERE id=$1', [id])
}

// ── Campaign log ──────────────────────────────────────────────────────────────

async function getCampaignLog() {
  const { rows } = await pool.query(
    `SELECT id, template_id as "templateId", template_name as "templateName",
            phones, contacts_data as contacts, sent, failed, sent_at as "sentAt"
     FROM campaign_log ORDER BY sent_at`
  )
  return rows
}

async function addCampaignLog(entry) {
  await pool.query(
    `INSERT INTO campaign_log (id, template_id, template_name, phones, contacts_data, sent, failed, sent_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      entry.id, entry.templateId || null, entry.templateName || '',
      JSON.stringify(entry.phones || []),
      JSON.stringify(entry.contacts || []),
      entry.sent || 0, entry.failed || 0, entry.sentAt
    ]
  )
  await pool.query(`
    DELETE FROM campaign_log WHERE id NOT IN (
      SELECT id FROM campaign_log ORDER BY sent_at DESC LIMIT 50
    )
  `)
}

// ── Groups ────────────────────────────────────────────────────────────────────

async function getGroups() {
  const { rows } = await pool.query(
    'SELECT id, name, phones, created_at as "createdAt" FROM groups_table ORDER BY created_at'
  )
  return rows
}

async function addGroup(g) {
  const { rows } = await pool.query(
    'INSERT INTO groups_table (id, name, phones, created_at) VALUES ($1,$2,$3,$4) RETURNING id, name, phones, created_at as "createdAt"',
    [g.id, g.name, JSON.stringify(g.phones || []), g.createdAt]
  )
  return rows[0]
}

async function updateGroup(id, updates) {
  const { rows } = await pool.query('SELECT * FROM groups_table WHERE id=$1', [id])
  const cur = rows[0]
  if (!cur) return
  await pool.query(
    'UPDATE groups_table SET name=$1, phones=$2 WHERE id=$3',
    [updates.name ?? cur.name, JSON.stringify(updates.phones ?? cur.phones), id]
  )
}

async function deleteGroup(id) {
  await pool.query('DELETE FROM groups_table WHERE id=$1', [id])
}

// ── LID map ───────────────────────────────────────────────────────────────────

async function getLidEntry(lid) {
  const { rows } = await pool.query('SELECT jid FROM lid_map WHERE lid=$1', [lid])
  return rows[0]?.jid || null
}

async function saveLidEntry(lid, jid) {
  await pool.query(
    'INSERT INTO lid_map (lid, jid) VALUES ($1,$2) ON CONFLICT (lid) DO UPDATE SET jid=$2',
    [lid, jid]
  )
}

// ── Auth ──────────────────────────────────────────────────────────────────────

async function upsertUser(email, passwordHash, role = 'admin') {
  await pool.query(
    `INSERT INTO users (email, password_hash, role)
     VALUES ($1,$2,$3)
     ON CONFLICT (email) DO UPDATE SET password_hash=$2, role=$3`,
    [email, passwordHash, role]
  )
}

async function getUserByEmail(email) {
  const { rows } = await pool.query('SELECT * FROM users WHERE email=$1', [email])
  return rows[0] || null
}

async function createSession(token, email) {
  const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 dias
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

module.exports = {
  init,
  getContacts, saveContacts, addContact, updateContact, deleteContact,
  getDraft, saveDraft,
  getTemplates, addTemplate, updateTemplate, deleteTemplate,
  getAutoreplies, addAutoreply, updateAutoreply, deleteAutoreply,
  getCampaignLog, addCampaignLog,
  getGroups, addGroup, updateGroup, deleteGroup,
  getLidEntry, saveLidEntry,
  upsertUser, getUserByEmail, createSession, getSession, deleteSession
}
