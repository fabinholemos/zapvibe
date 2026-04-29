const fs = require('fs')
const path = require('path')
const chalk = require('chalk')
const Table = require('cli-table3')

async function printSummary(results) {
  const enviados = results.filter(r => r.status === 'enviado').length
  const falhos = results.filter(r => r.status === 'falhou').length
  const taxa = results.length > 0 ? Math.round((enviados / results.length) * 100) : 0

  console.log(chalk.bold('\n📊 Relatorio da Campanha ZapVibe\n'))

  const table = new Table({
    head: [chalk.cyan('Metrica'), chalk.cyan('Resultado')],
    colWidths: [25, 20]
  })

  table.push(
    ['✔ Enviados', chalk.green(enviados)],
    ['✘ Falhas',   chalk.red(falhos)],
    ['📋 Total',    results.length],
    ['📈 Sucesso',  `${taxa}%`]
  )

  console.log(table.toString())

  const dir = './data/logs'
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const logPath = path.join(dir, `campanha-${timestamp}.json`)
  fs.writeFileSync(logPath, JSON.stringify(results, null, 2), 'utf-8')

  const csvPath = path.join(dir, `campanha-${timestamp}.csv`)
  const header = 'nome,telefone,empresa,status,timestamp\n'
  const rows = results.map(r =>
    `"${r.nome}","${r.telefone}","${r.empresa || ''}","${r.status}","${r.timestamp}"`
  ).join('\n')
  fs.writeFileSync(csvPath, header + rows, 'utf-8')

  console.log(chalk.gray(`\n💾 Log JSON: ${logPath}`))
  console.log(chalk.gray(`💾 Log CSV:  ${csvPath}\n`))
}

module.exports = { printSummary }
