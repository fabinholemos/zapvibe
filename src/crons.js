const db = require('./db')
const { sendWhatsapp, sendWhatsappMedia, applyTemplate, INSTANCE } = require('./whatsapp')
const { runCampaign } = require('./campaign')

function parseVencimentoDate(str) {
  if (!str) return null
  // DD/MM/YYYY
  let m = str.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (m) return new Date(parseInt(m[3]), parseInt(m[2]) - 1, parseInt(m[1]))
  // DD/MM (assume current year)
  m = str.trim().match(/^(\d{1,2})\/(\d{1,2})$/)
  if (m) return new Date(new Date().getFullYear(), parseInt(m[2]) - 1, parseInt(m[1]))
  // YYYY-MM-DD
  m = str.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (m) return new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]))
  return null
}

async function checkSchedules() {
  try {
    const users = await db.getAllUsers().catch(() => [])
    for (const user of users) {
      if (user.status !== 'active' && user.role !== 'admin') continue
      const schedules = await db.getPendingSchedules(user.id).catch(() => [])
      for (const s of schedules) {
        await db.updateScheduleStatus(s.id, 'running')
        let contacts = (await db.getContacts(user.id).catch(() => [])).filter(c => !c.optout)
        if (s.group_id) {
          const groups = await db.getGroups(user.id).catch(() => [])
          const grp = groups.find(g => g.id === s.group_id)
          if (grp) contacts = contacts.filter(c => grp.phones.includes(c.telefone.replace(/\D/g, '')))
        }
        const instanceName = user.instance_name || INSTANCE
        runCampaign(contacts, s.template, s.delay_min, s.delay_max, s.daily_limit, s.use_ai, null, s.template_id, s.template_name, user.id, instanceName)
          .then(() => db.updateScheduleStatus(s.id, 'sent').catch(() => {}))
          .catch(() => db.updateScheduleStatus(s.id, 'failed').catch(() => {}))
      }
    }
  } catch (e) { console.error('[checkSchedules]', e.message) }
}

async function checkVencimentos() {
  try {
    const today = new Date()
    const todayStr = today.toISOString().slice(0, 10)
    const users = await db.getAllUsers().catch(() => [])
    for (const user of users) {
      if (user.status !== 'active' && user.role !== 'admin') continue
      const rules = await db.getVencimentoRules(user.id).catch(() => [])
      for (const rule of rules) {
        if (!rule.active || rule.lastRunDate === todayStr) continue
        const targetDate = new Date(today)
        targetDate.setDate(targetDate.getDate() + parseInt(rule.daysBefore))
        const contacts = (await db.getContacts(user.id).catch(() => [])).filter(c => {
          if (!c.vencimento || c.optout) return false
          const d = parseVencimentoDate(c.vencimento)
          if (!d) return false
          return d.getDate() === targetDate.getDate() && d.getMonth() === targetDate.getMonth()
        })
        if (contacts.length) {
          const instanceName = user.instance_name || INSTANCE
          runCampaign(contacts, rule.templateContent, 8000, 20000, 500, false, null, rule.templateId, rule.name, user.id, instanceName)
            .catch(e => console.error('[Vencimento]', e.message))
        }
        await db.setVencimentoRuleLastRun(rule.id, todayStr, user.id).catch(() => {})
      }
    }
  } catch (e) { console.error('[checkVencimentos]', e.message) }
}

async function checkDrips() {
  try {
    const users = await db.getAllUsers().catch(() => [])
    for (const user of users) {
      if (user.status !== 'active' && user.role !== 'admin') continue
      const items = await db.getPendingDripItems(user.id).catch(() => [])
      for (const item of items) {
        const drip = await db.getDrip(item.drip_id, user.id).catch(() => null)
        if (!drip) { await db.updateDripItemStatus(item.id, 'skipped').catch(() => {}); continue }
        const step = drip.steps[item.step_index]
        if (!step) { await db.updateDripItemStatus(item.id, 'done').catch(() => {}); continue }
        await db.updateDripItemStatus(item.id, 'running')
        const contact = { nome: item.nome, telefone: item.phone }
        const instanceName = item.instance_name || user.instance_name || INSTANCE
        try {
          await sendWhatsapp(item.phone, applyTemplate(step.message, contact), instanceName)
          await db.updateDripItemStatus(item.id, 'sent')
          await db.addCampaignLog({
            id: `drip_${item.id}`,
            templateId: null,
            templateName: `🔁 ${drip.name} — Etapa ${item.step_index + 1}`,
            phones: [item.phone.replace(/\D/g, '')],
            contacts: [{ nome: item.nome, telefone: item.phone }],
            sent: 1,
            failed: 0,
            sentAt: new Date().toISOString()
          }, user.id).catch(() => {})
          const nextIdx = item.step_index + 1
          if (nextIdx < drip.steps.length) {
            const nextStep = drip.steps[nextIdx]
            const sendAt = new Date(Date.now() + (nextStep.delayDays || 1) * 86400000).toISOString()
            await db.addDripQueueItems([{ id: `${Date.now()}_${item.phone}_${nextIdx}`, dripId: item.drip_id, userId: user.id, phone: item.phone, nome: item.nome, instanceName, stepIndex: nextIdx, sendAt }])
          }
        } catch (e) {
          await db.updateDripItemStatus(item.id, 'failed').catch(() => {})
        }
      }
    }
  } catch (e) { console.error('[checkDrips]', e.message) }
}

async function checkFollowups() {
  try {
    const users = await db.getAllUsers().catch(() => [])
    for (const user of users) {
      if (user.status !== 'active' && user.role !== 'admin') continue
      const items = await db.getPendingFollowups(user.id).catch(() => [])
      for (const item of items) {
        await db.updateFollowupStatus(item.id, 'running')
        const contact = { nome: item.nome, telefone: item.phone }
        const instanceName = item.instance_name || user.instance_name || INSTANCE
        try {
          await sendWhatsapp(item.phone, item.message, instanceName)
          await db.updateFollowupStatus(item.id, 'sent')
          await db.addCampaignLog({
            id: `fup_${item.id}`,
            templateId: null,
            templateName: `↩ Seguimento — Etapa ${item.step_index + 1}`,
            phones: [item.phone.replace(/\D/g, '')],
            contacts: [contact],
            sent: 1, failed: 0,
            sentAt: new Date().toISOString()
          }, user.id).catch(() => {})
        } catch (e) {
          await db.updateFollowupStatus(item.id, 'failed').catch(() => {})
        }
      }
    }
  } catch (e) { console.error('[checkFollowups]', e.message) }
}

setInterval(checkSchedules, 60000)
setInterval(checkVencimentos, 3600000)
checkVencimentos()
setInterval(checkDrips, 60000)
setInterval(checkFollowups, 60000)

module.exports = { parseVencimentoDate, checkSchedules, checkVencimentos, checkDrips, checkFollowups }
