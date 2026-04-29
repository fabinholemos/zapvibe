require('dotenv').config()
const { connectInstance, checkStatus } = require('./whatsapp')
const { loadContacts } = require('./contacts')
const { dispatch } = require('./dispatcher')
const { printSummary } = require('./logger')
const chalk = require('chalk')

const args = process.argv.slice(2)

async function main() {
  console.log(chalk.bold.hex('#534AB7')('\n🚀 ZapVibe — Disparador Inteligente de WhatsApp\n'))

  if (args.includes('--connect')) {
    await connectInstance()
    return
  }

  if (args.includes('--status')) {
    const status = await checkStatus()
    console.log(chalk.green(`✔ Status: ${status}`))
    return
  }

  const status = await checkStatus()
  if (status !== 'open') {
    console.log(chalk.yellow('⚠  WhatsApp nao conectado. Rode: npm run connect'))
    process.exit(1)
  }

  const contacts = await loadContacts('./data/contatos.csv')
  console.log(chalk.blue(`📋 ${contacts.length} contatos carregados\n`))

  const results = await dispatch(contacts)
  await printSummary(results)
}

main().catch(err => {
  console.error(chalk.red('Erro fatal:'), err.message)
  process.exit(1)
})
