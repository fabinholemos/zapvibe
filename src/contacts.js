const fs = require('fs')
const { parse } = require('csv-parse/sync')
const chalk = require('chalk')

function loadContacts(filePath) {
  if (!fs.existsSync(filePath)) {
    console.error(chalk.red(`Arquivo nao encontrado: ${filePath}`))
    console.log(chalk.gray('Crie o arquivo data/contatos.csv com: nome,telefone,empresa,extra'))
    process.exit(1)
  }

  const content = fs.readFileSync(filePath, 'utf-8')
  const records = parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true
  })

  const valid = []
  const invalid = []

  for (const row of records) {
    const phone = row.telefone?.replace(/\D/g, '')
    if (!phone || phone.length < 10 || phone.length > 13) {
      invalid.push({ ...row, motivo: 'telefone invalido' })
      continue
    }
    if (!row.nome || row.nome.trim() === '') {
      invalid.push({ ...row, motivo: 'nome vazio' })
      continue
    }
    valid.push(row)
  }

  if (invalid.length > 0) {
    console.log(chalk.yellow(`⚠  ${invalid.length} contato(s) ignorado(s) por dados invalidos`))
    invalid.forEach(c => console.log(chalk.gray(`   - ${c.telefone || 'sem tel'}: ${c.motivo}`)))
  }

  return valid
}

module.exports = { loadContacts }
