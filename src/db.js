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
      webhook_token TEXT,
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
    CREATE TABLE IF NOT EXISTS user_instances (
      id TEXT PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      instance_name TEXT UNIQUE NOT NULL,
      label TEXT DEFAULT 'Principal',
      enabled BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS scheduled_campaigns (
      id TEXT PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      template TEXT NOT NULL DEFAULT '',
      template_id TEXT,
      template_name TEXT DEFAULT '',
      group_id TEXT DEFAULT '',
      contact_phones JSONB DEFAULT '[]',
      scheduled_at TIMESTAMPTZ NOT NULL,
      delay_min INTEGER DEFAULT 8000,
      delay_max INTEGER DEFAULT 20000,
      daily_limit INTEGER DEFAULT 150,
      use_ai BOOLEAN DEFAULT FALSE,
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS vencimento_rules (
      id TEXT PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL DEFAULT '',
      days_before INTEGER NOT NULL DEFAULT 3,
      template_content TEXT NOT NULL DEFAULT '',
      template_id TEXT,
      template_name TEXT DEFAULT '',
      group_id TEXT DEFAULT '',
      active BOOLEAN DEFAULT TRUE,
      last_run_date TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS drips (
      id TEXT PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL DEFAULT '',
      steps JSONB DEFAULT '[]',
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS drip_queue (
      id TEXT PRIMARY KEY,
      drip_id TEXT NOT NULL,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      phone TEXT NOT NULL,
      nome TEXT DEFAULT '',
      instance_name TEXT,
      step_index INTEGER DEFAULT 0,
      send_at TIMESTAMPTZ NOT NULL,
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS campaign_responses (
      campaign_log_id TEXT NOT NULL,
      phone TEXT NOT NULL,
      user_id INTEGER,
      responded_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (campaign_log_id, phone)
    );
    CREATE TABLE IF NOT EXISTS wa_groups (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      instance_name TEXT NOT NULL,
      jid TEXT NOT NULL,
      name TEXT NOT NULL,
      participants INTEGER DEFAULT 0,
      synced_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, jid)
    );
  `)
  // Migração segura: adiciona colunas novas se tabelas já existiam
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS instance_name TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS name TEXT DEFAULT '';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT DEFAULT '';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS webhook_token TEXT;
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS vencimento TEXT DEFAULT '';
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS optout BOOLEAN DEFAULT FALSE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS max_instances INTEGER DEFAULT 1;
    ALTER TABLE user_instances ADD COLUMN IF NOT EXISTS enabled BOOLEAN DEFAULT TRUE;
    ALTER TABLE templates ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
    ALTER TABLE templates ADD COLUMN IF NOT EXISTS media_type TEXT;
    ALTER TABLE templates ADD COLUMN IF NOT EXISTS media_data TEXT;
    ALTER TABLE templates ADD COLUMN IF NOT EXISTS media_name TEXT;
    ALTER TABLE templates ADD COLUMN IF NOT EXISTS media_mimetype TEXT;
    ALTER TABLE autoreplies ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
    ALTER TABLE autoreplies ADD COLUMN IF NOT EXISTS active_days TEXT;
    ALTER TABLE autoreplies ADD COLUMN IF NOT EXISTS active_start TEXT;
    ALTER TABLE autoreplies ADD COLUMN IF NOT EXISTS active_end TEXT;
    ALTER TABLE autoreplies ADD COLUMN IF NOT EXISTS drip_id TEXT;
    ALTER TABLE autoreplies ADD COLUMN IF NOT EXISTS off_hours_msg TEXT;
    ALTER TABLE autoreplies ADD COLUMN IF NOT EXISTS followup_steps TEXT;
    ALTER TABLE autoreplies ADD COLUMN IF NOT EXISTS instance_name TEXT;
    CREATE TABLE IF NOT EXISTS autoreply_followup_queue (
      id TEXT PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      rule_id TEXT NOT NULL,
      phone TEXT NOT NULL,
      nome TEXT DEFAULT '',
      instance_name TEXT NOT NULL,
      step_index INTEGER NOT NULL,
      message TEXT NOT NULL,
      send_at TIMESTAMPTZ NOT NULL,
      status TEXT DEFAULT 'pending'
    );
    ALTER TABLE campaign_log ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
    ALTER TABLE campaign_log ADD COLUMN IF NOT EXISTS responses INTEGER DEFAULT 0;
    ALTER TABLE groups_table ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
    ALTER TABLE lid_map ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
    ALTER TABLE draft ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
    ALTER TABLE drip_queue ADD COLUMN IF NOT EXISTS instance_name TEXT;
    ALTER TABLE vencimento_rules ADD COLUMN IF NOT EXISTS group_id TEXT DEFAULT '';
    ALTER TABLE scheduled_campaigns ADD COLUMN IF NOT EXISTS contact_phones JSONB DEFAULT '[]';
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

  // Migra instance_name existente de users → user_instances
  await pool.query(`
    INSERT INTO user_instances (id, user_id, instance_name, label)
    SELECT 'primary_' || id, id, instance_name, 'Principal'
    FROM users WHERE instance_name IS NOT NULL
    ON CONFLICT (instance_name) DO NOTHING
  `).catch(() => {})
}

// ── Contacts ──────────────────────────────────────────────────────────────────

async function getContacts(userId) {
  const { rows } = await pool.query('SELECT nome, telefone, empresa, extra, vencimento, optout FROM contacts WHERE user_id=$1 ORDER BY id', [userId])
  return rows
}

async function saveContacts(contacts, userId) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // Preserve optout flags before wiping
    const { rows: existing } = await client.query('SELECT telefone, optout FROM contacts WHERE user_id=$1', [userId])
    const optoutMap = new Map(existing.map(c => [c.telefone, c.optout]))
    await client.query('DELETE FROM contacts WHERE user_id=$1', [userId])
    for (const c of contacts) {
      const optout = optoutMap.get(c.telefone) || false
      await client.query(
        'INSERT INTO contacts (user_id, nome, telefone, empresa, extra, vencimento, optout) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [userId, c.nome || '', c.telefone, c.empresa || '', c.extra || '', c.vencimento || '', optout]
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
    'INSERT INTO contacts (user_id, nome, telefone, empresa, extra, vencimento, optout) VALUES ($1,$2,$3,$4,$5,$6,FALSE)',
    [userId, c.nome || '', c.telefone, c.empresa || '', c.extra || '', c.vencimento || '']
  )
}

async function setOptout(telefone, userId) {
  await pool.query('UPDATE contacts SET optout=TRUE WHERE telefone=$1 AND user_id=$2', [telefone, userId])
}

async function clearOptout(telefone, userId) {
  await pool.query('UPDATE contacts SET optout=FALSE WHERE telefone=$1 AND user_id=$2', [telefone, userId])
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

// Upsert usado pelo webhook de planilha (Google Sheets/Excel): atualiza se o telefone
// já existe pra esse usuário, cria se não existe. Nunca duplica.
async function upsertContactByPhone(c, userId) {
  const telefone = (c.telefone || '').replace(/\D/g, '')
  if (!telefone) throw new Error('telefone obrigatório')
  const { rows } = await pool.query('SELECT id FROM contacts WHERE user_id=$1 AND telefone=$2', [userId, telefone])
  if (rows[0]) {
    await pool.query(
      'UPDATE contacts SET nome=$1, empresa=$2, extra=$3, vencimento=$4 WHERE id=$5',
      [c.nome || '', c.empresa || '', c.extra || '', c.vencimento || '', rows[0].id]
    )
    return { created: false, updated: true }
  }
  await pool.query(
    'INSERT INTO contacts (user_id, nome, telefone, empresa, extra, vencimento, optout) VALUES ($1,$2,$3,$4,$5,$6,FALSE)',
    [userId, c.nome || '', telefone, c.empresa || '', c.extra || '', c.vencimento || '']
  )
  return { created: true, updated: false }
}

// ── Webhook token (integração planilha → ZapVibe) ─────────────────────────────

async function getOrCreateWebhookToken(userId) {
  const { rows } = await pool.query('SELECT webhook_token FROM users WHERE id=$1', [userId])
  if (rows[0]?.webhook_token) return rows[0].webhook_token
  const token = require('crypto').randomBytes(20).toString('hex')
  await pool.query('UPDATE users SET webhook_token=$1 WHERE id=$2', [token, userId])
  return token
}

async function getUserByWebhookToken(token) {
  if (!token) return null
  const { rows } = await pool.query('SELECT * FROM users WHERE webhook_token=$1', [token])
  return rows[0] || null
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
    `SELECT id, name, content, media_type as "mediaType", media_name as "mediaName", media_mimetype as "mediaMimetype", created_at as "createdAt"
     FROM templates WHERE user_id=$1 ORDER BY created_at`,
    [userId]
  )
  return rows
}

async function getTemplateById(id, userId) {
  const { rows } = await pool.query(
    `SELECT id, name, content, media_type as "mediaType", media_data as "mediaData", media_name as "mediaName", media_mimetype as "mediaMimetype", created_at as "createdAt"
     FROM templates WHERE id=$1 AND user_id=$2`,
    [id, userId]
  )
  return rows[0] || null
}

async function addTemplate(t, userId) {
  const { rows } = await pool.query(
    `INSERT INTO templates (id, user_id, name, content, media_type, media_data, media_name, media_mimetype, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING id, name, content, media_type as "mediaType", media_name as "mediaName", media_mimetype as "mediaMimetype", created_at as "createdAt"`,
    [t.id, userId, t.name, t.content, t.mediaType || null, t.mediaData || null, t.mediaName || null, t.mediaMimetype || null, t.createdAt]
  )
  return rows[0]
}

async function updateTemplate(id, updates, userId) {
  if (updates.mediaData !== undefined) {
    await pool.query(
      'UPDATE templates SET name=$1, content=$2, media_type=$3, media_data=$4, media_name=$5, media_mimetype=$6 WHERE id=$7 AND user_id=$8',
      [updates.name, updates.content, updates.mediaType || null, updates.mediaData || null, updates.mediaName || null, updates.mediaMimetype || null, id, userId]
    )
  } else {
    await pool.query(
      'UPDATE templates SET name=$1, content=$2 WHERE id=$3 AND user_id=$4',
      [updates.name, updates.content, id, userId]
    )
  }
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
    templateName: r.template_name,
    activeDays: r.active_days ? JSON.parse(r.active_days) : null,
    activeStart: r.active_start || null,
    activeEnd: r.active_end || null,
    dripId: r.drip_id || null,
    offHoursMsg: r.off_hours_msg || null,
    followupSteps: r.followup_steps ? JSON.parse(r.followup_steps) : [],
    instanceName: r.instance_name || null
  }))
}

async function addAutoreply(r, userId) {
  await pool.query(
    `INSERT INTO autoreplies
      (id, user_id, name, trigger, keywords, response, delay, active, media_base64, media_mimetype, media_filename, created_at, template_id, template_name, active_days, active_start, active_end, drip_id, off_hours_msg, followup_steps, instance_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
    [
      r.id, userId, r.name, r.trigger,
      JSON.stringify(r.keywords || []),
      r.response || '', r.delay || 1500, r.active !== false,
      r.mediaBase64 || null, r.mediaMimetype || null, r.mediaFilename || null,
      r.createdAt, r.templateId || null, r.templateName || null,
      r.activeDays ? JSON.stringify(r.activeDays) : null,
      r.activeStart || null, r.activeEnd || null,
      r.dripId || null, r.offHoursMsg || null,
      r.followupSteps?.length ? JSON.stringify(r.followupSteps) : null,
      r.instanceName || null
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
      template_id=$10, template_name=$11,
      active_days=$12, active_start=$13, active_end=$14, drip_id=$15, off_hours_msg=$16,
      followup_steps=$17, instance_name=$18
     WHERE id=$19 AND user_id=$20`,
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
      updates.activeDays     !== undefined ? (updates.activeDays ? JSON.stringify(updates.activeDays) : null) : cur.active_days,
      updates.activeStart    !== undefined ? updates.activeStart    : cur.active_start,
      updates.activeEnd      !== undefined ? updates.activeEnd      : cur.active_end,
      updates.dripId         !== undefined ? updates.dripId         : cur.drip_id,
      updates.offHoursMsg    !== undefined ? updates.offHoursMsg    : cur.off_hours_msg,
      updates.followupSteps  !== undefined ? (updates.followupSteps?.length ? JSON.stringify(updates.followupSteps) : null) : cur.followup_steps,
      updates.instanceName   !== undefined ? updates.instanceName   : cur.instance_name,
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

async function updateCampaignLogCounts(id, sent, failed, userId) {
  await pool.query('UPDATE campaign_log SET sent=$1, failed=$2 WHERE id=$3 AND user_id=$4', [sent, failed, id, userId])
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

// ── WA Groups ─────────────────────────────────────────────────────────────────

async function getWaGroups(userId, instanceName) {
  const q = instanceName
    ? 'SELECT jid, name, participants, instance_name FROM wa_groups WHERE user_id=$1 AND instance_name=$2 ORDER BY name'
    : 'SELECT jid, name, participants, instance_name FROM wa_groups WHERE user_id=$1 ORDER BY name'
  const params = instanceName ? [userId, instanceName] : [userId]
  const { rows } = await pool.query(q, params)
  return rows
}

async function syncWaGroups(userId, instanceName, groups) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('DELETE FROM wa_groups WHERE user_id=$1 AND instance_name=$2', [userId, instanceName])
    for (const g of groups) {
      await client.query(
        'INSERT INTO wa_groups (user_id, instance_name, jid, name, participants) VALUES ($1,$2,$3,$4,$5)',
        [userId, instanceName, g.jid, g.name || g.jid, g.participants || 0]
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
  const { rows } = await pool.query(
    `SELECT u.* FROM users u
     LEFT JOIN user_instances ui ON u.id = ui.user_id AND ui.instance_name = $1
     WHERE (ui.instance_name = $1 AND COALESCE(ui.enabled, TRUE) = TRUE)
        OR (u.instance_name = $1 AND (ui.enabled IS NULL OR COALESCE(ui.enabled, TRUE) = TRUE))
     LIMIT 1`,
    [instanceName]
  )
  return rows[0] || null
}

async function getUserById(id) {
  const { rows } = await pool.query('SELECT * FROM users WHERE id=$1', [id])
  return rows[0] || null
}

async function getAllUsers() {
  const { rows } = await pool.query(
    'SELECT id, email, name, phone, role, status, instance_name, trial_ends_at, max_instances, created_at FROM users ORDER BY created_at'
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
  const instanceName = 'zv' + id
  await pool.query('UPDATE users SET instance_name=$1 WHERE id=$2', [instanceName, id])
  await pool.query(
    `INSERT INTO user_instances (id, user_id, instance_name, label) VALUES ($1,$2,$3,'Principal') ON CONFLICT DO NOTHING`,
    ['primary_' + id, id, instanceName]
  )
  return id
}

async function updateUser(id, updates) {
  const allowed = ['status', 'role', 'instance_name', 'password_hash', 'trial_ends_at', 'name', 'phone', 'max_instances']
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

// ── User instances ────────────────────────────────────────────────────────────

async function getUserInstances(userId) {
  const { rows } = await pool.query(
    `SELECT id, instance_name as "instanceName", label, COALESCE(enabled, TRUE) as enabled, created_at as "createdAt"
     FROM user_instances WHERE user_id=$1 ORDER BY created_at`,
    [userId]
  )
  return rows
}

async function countUserInstances(userId) {
  const { rows } = await pool.query('SELECT COUNT(*) as count FROM user_instances WHERE user_id=$1', [userId])
  return parseInt(rows[0].count)
}

async function addUserInstance(userId, instanceName, label) {
  const { rows } = await pool.query(
    `INSERT INTO user_instances (id, user_id, instance_name, label)
     VALUES ($1,$2,$3,$4)
     RETURNING id, instance_name as "instanceName", label, COALESCE(enabled, TRUE) as enabled, created_at as "createdAt"`,
    [Date.now().toString(), userId, instanceName, label || 'WhatsApp']
  )
  return rows[0]
}

async function updateUserInstanceLabel(userId, instanceName, label) {
  await pool.query(
    'UPDATE user_instances SET label=$1 WHERE instance_name=$2 AND user_id=$3',
    [label, instanceName, userId]
  )
}

async function updateUserInstanceEnabled(userId, instanceName, enabled) {
  await pool.query(
    'UPDATE user_instances SET enabled=$1 WHERE instance_name=$2 AND user_id=$3',
    [enabled === false ? false : true, instanceName, userId]
  )
}

async function deleteUserInstance(userId, instanceName) {
  await pool.query('DELETE FROM user_instances WHERE instance_name=$1 AND user_id=$2', [instanceName, userId])
}

// ── Scheduled campaigns ───────────────────────────────────────────────────────

async function getSchedules(userId) {
  const { rows } = await pool.query(
    `SELECT id, template, template_id as "templateId", template_name as "templateName",
            group_id as "groupId", contact_phones as "contactPhones", scheduled_at as "scheduledAt",
            delay_min as "delayMin", delay_max as "delayMax", daily_limit as "dailyLimit",
            use_ai as "useAi", status, created_at as "createdAt"
     FROM scheduled_campaigns WHERE user_id=$1 ORDER BY scheduled_at`,
    [userId]
  )
  return rows
}

async function getPendingSchedules(userId) {
  const { rows } = await pool.query(
    `SELECT * FROM scheduled_campaigns WHERE user_id=$1 AND status='pending' AND scheduled_at <= NOW()`,
    [userId]
  )
  return rows
}

async function addSchedule(s, userId) {
  const { rows } = await pool.query(
    `INSERT INTO scheduled_campaigns (id, user_id, template, template_id, template_name, group_id, contact_phones, scheduled_at, delay_min, delay_max, daily_limit, use_ai)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING id, template, template_id as "templateId", template_name as "templateName",
               group_id as "groupId", contact_phones as "contactPhones", scheduled_at as "scheduledAt",
               delay_min as "delayMin", delay_max as "delayMax", daily_limit as "dailyLimit",
               use_ai as "useAi", status, created_at as "createdAt"`,
    [s.id, userId, s.template, s.templateId || null, s.templateName || '', s.groupId || '',
     JSON.stringify(s.contactPhones || []), s.scheduledAt, s.delayMin || 8000, s.delayMax || 20000, s.dailyLimit || 150, s.useAi || false]
  )
  return rows[0]
}

async function updateScheduleStatus(id, status) {
  await pool.query('UPDATE scheduled_campaigns SET status=$1 WHERE id=$2', [status, id])
}

async function deleteSchedule(id, userId) {
  await pool.query('DELETE FROM scheduled_campaigns WHERE id=$1 AND user_id=$2', [id, userId])
}

// ── Vencimento rules ──────────────────────────────────────────────────────────

async function getVencimentoRules(userId) {
  const { rows } = await pool.query(
    `SELECT id, name, days_before as "daysBefore", template_content as "templateContent",
            template_id as "templateId", template_name as "templateName", group_id as "groupId",
            active, last_run_date as "lastRunDate", created_at as "createdAt"
     FROM vencimento_rules WHERE user_id=$1 ORDER BY created_at`,
    [userId]
  )
  return rows
}

async function addVencimentoRule(r, userId) {
  const { rows } = await pool.query(
    `INSERT INTO vencimento_rules (id, user_id, name, days_before, template_content, template_id, template_name, group_id, active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING id, name, days_before as "daysBefore", template_content as "templateContent",
               template_id as "templateId", template_name as "templateName", group_id as "groupId",
               active, last_run_date as "lastRunDate"`,
    [r.id, userId, r.name, r.daysBefore, r.templateContent, r.templateId || null, r.templateName || '', r.groupId || '', r.active !== false]
  )
  return rows[0]
}

async function updateVencimentoRule(id, updates, userId) {
  const { rows } = await pool.query('SELECT * FROM vencimento_rules WHERE id=$1 AND user_id=$2', [id, userId])
  const cur = rows[0]; if (!cur) return
  await pool.query(
    `UPDATE vencimento_rules SET name=$1, days_before=$2, template_content=$3, template_id=$4, template_name=$5, group_id=$6, active=$7
     WHERE id=$8 AND user_id=$9`,
    [
      updates.name !== undefined ? updates.name : cur.name,
      updates.daysBefore !== undefined ? updates.daysBefore : cur.days_before,
      updates.templateContent !== undefined ? updates.templateContent : cur.template_content,
      updates.templateId !== undefined ? updates.templateId : cur.template_id,
      updates.templateName !== undefined ? updates.templateName : cur.template_name,
      updates.groupId !== undefined ? updates.groupId : cur.group_id,
      updates.active !== undefined ? updates.active : cur.active,
      id, userId
    ]
  )
}

async function deleteVencimentoRule(id, userId) {
  await pool.query('DELETE FROM vencimento_rules WHERE id=$1 AND user_id=$2', [id, userId])
}

async function setVencimentoRuleLastRun(id, date, userId) {
  await pool.query('UPDATE vencimento_rules SET last_run_date=$1 WHERE id=$2 AND user_id=$3', [date, id, userId])
}

// ── Campaign responses ────────────────────────────────────────────────────────

async function trackCampaignResponse(campaignLogId, phone, userId) {
  const { rowCount } = await pool.query(
    `INSERT INTO campaign_responses (campaign_log_id, phone, user_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
    [campaignLogId, phone, userId]
  )
  if (rowCount > 0) {
    await pool.query('UPDATE campaign_log SET responses=COALESCE(responses,0)+1 WHERE id=$1', [campaignLogId])
  }
}

// ── Drips ─────────────────────────────────────────────────────────────────────

async function getDrips(userId) {
  const { rows } = await pool.query(
    'SELECT id, name, steps, active, created_at as "createdAt" FROM drips WHERE user_id=$1 ORDER BY created_at',
    [userId]
  )
  return rows
}

async function getDrip(id, userId) {
  const { rows } = await pool.query('SELECT * FROM drips WHERE id=$1 AND user_id=$2', [id, userId])
  return rows[0] || null
}

async function addDrip(d, userId) {
  const { rows } = await pool.query(
    `INSERT INTO drips (id, user_id, name, steps, active) VALUES ($1,$2,$3,$4,$5)
     RETURNING id, name, steps, active, created_at as "createdAt"`,
    [d.id, userId, d.name, JSON.stringify(d.steps || []), d.active !== false]
  )
  return rows[0]
}

async function updateDrip(id, updates, userId) {
  const { rows } = await pool.query('SELECT * FROM drips WHERE id=$1 AND user_id=$2', [id, userId])
  const cur = rows[0]; if (!cur) return
  await pool.query(
    'UPDATE drips SET name=$1, steps=$2, active=$3 WHERE id=$4 AND user_id=$5',
    [
      updates.name !== undefined ? updates.name : cur.name,
      JSON.stringify(updates.steps !== undefined ? updates.steps : cur.steps),
      updates.active !== undefined ? updates.active : cur.active,
      id, userId
    ]
  )
}

async function deleteDrip(id, userId) {
  await pool.query('DELETE FROM drips WHERE id=$1 AND user_id=$2', [id, userId])
  await pool.query('DELETE FROM drip_queue WHERE drip_id=$1 AND user_id=$2', [id, userId])
}

async function getDripQueue(userId, dripId) {
  const query = dripId
    ? `SELECT id, drip_id as "dripId", phone, nome, instance_name as "instanceName", step_index as "stepIndex", send_at as "sendAt", status FROM drip_queue WHERE user_id=$1 AND drip_id=$2 ORDER BY send_at`
    : `SELECT id, drip_id as "dripId", phone, nome, instance_name as "instanceName", step_index as "stepIndex", send_at as "sendAt", status FROM drip_queue WHERE user_id=$1 ORDER BY send_at`
  const { rows } = await pool.query(query, dripId ? [userId, dripId] : [userId])
  return rows
}

async function getPendingDripItems(userId) {
  const { rows } = await pool.query(
    `SELECT * FROM drip_queue WHERE user_id=$1 AND status='pending' AND send_at <= NOW() ORDER BY send_at LIMIT 100`,
    [userId]
  )
  return rows
}

async function addDripQueueItems(items) {
  for (const item of items) {
    await pool.query(
      `INSERT INTO drip_queue (id, drip_id, user_id, phone, nome, instance_name, step_index, send_at, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending') ON CONFLICT (id) DO NOTHING`,
      [item.id, item.dripId, item.userId, item.phone, item.nome, item.instanceName || null, item.stepIndex, item.sendAt]
    )
  }
}

async function updateDripItemStatus(id, status) {
  await pool.query('UPDATE drip_queue SET status=$1 WHERE id=$2', [status, id])
}

// ── Autoreply followup queue ──────────────────────────────────────────────────

async function addFollowupItems(items) {
  for (const item of items) {
    await pool.query(
      `INSERT INTO autoreply_followup_queue (id, user_id, rule_id, phone, nome, instance_name, step_index, message, send_at, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending') ON CONFLICT (id) DO NOTHING`,
      [item.id, item.userId, item.ruleId, item.phone, item.nome || '', item.instanceName, item.stepIndex, item.message, item.sendAt]
    )
  }
}

async function getPendingFollowups(userId) {
  const { rows } = await pool.query(
    `SELECT * FROM autoreply_followup_queue WHERE user_id=$1 AND status='pending' AND send_at <= NOW() ORDER BY send_at LIMIT 100`,
    [userId]
  )
  return rows
}

async function updateFollowupStatus(id, status) {
  await pool.query('UPDATE autoreply_followup_queue SET status=$1 WHERE id=$2', [status, id])
}

module.exports = {
  init, ping,
  getContacts, saveContacts, addContact, updateContact, deleteContact, setOptout, clearOptout, upsertContactByPhone,
  getOrCreateWebhookToken, getUserByWebhookToken,
  getUserInstances, countUserInstances, addUserInstance, updateUserInstanceLabel, updateUserInstanceEnabled, deleteUserInstance,
  getDraft, saveDraft,
  getTemplates, getTemplateById, addTemplate, updateTemplate, deleteTemplate,
  getAutoreplies, addAutoreply, updateAutoreply, deleteAutoreply,
  getCampaignLog, addCampaignLog, updateCampaignLogCounts, trackCampaignResponse,
  getGroups, addGroup, updateGroup, deleteGroup,
  getLidEntry, saveLidEntry,
  getWaGroups, syncWaGroups,
  getSchedules, getPendingSchedules, addSchedule, updateScheduleStatus, deleteSchedule,
  getVencimentoRules, addVencimentoRule, updateVencimentoRule, deleteVencimentoRule, setVencimentoRuleLastRun,
  getDrips, getDrip, addDrip, updateDrip, deleteDrip, getDripQueue, getPendingDripItems, addDripQueueItems, updateDripItemStatus,
  addFollowupItems, getPendingFollowups, updateFollowupStatus,
  upsertUser, getUserByEmail, getUserByInstance, getUserById, getAllUsers, updateUser, deleteUser, registerUser,
  createSession, getSession, deleteSession
}
