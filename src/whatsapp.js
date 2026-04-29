const axios = require('axios')
const chalk = require('chalk')
const fs = require('fs')
const path = require('path')
const { exec } = require('child_process')

const api = axios.create({
  baseURL: process.env.EVOLUTION_API_URL,
  headers: { apikey: process.env.EVOLUTION_API_KEY }
})

const INSTANCE = process.env.INSTANCE_NAME

async function connectInstance() {
  try {
    await api.post('/instance/create', {
      instanceName: INSTANCE,
      qrcode: true,
      integration: 'WHATSAPP-BAILEYS'
    }).catch(() => {})

    const { data } = await api.get(`/instance/connect/${INSTANCE}`)

    if (data.base64) {
      const qrPath = path.resolve('qrcode.html')
      fs.writeFileSync(qrPath, `<html><body style="background:#000;display:flex;justify-content:center;align-items:center;height:100vh;margin:0"><img src="${data.base64}" style="max-width:400px"/></body></html>`)
      console.log(chalk.yellow('\n📱 QR Code salvo! Abrindo no navegador...'))
      exec(`start "" "${qrPath}"`)
      console.log(chalk.gray(`Arquivo: ${qrPath}`))
      console.log(chalk.yellow('Aguardando conexao...'))
      await waitForConnection()
    } else {
      console.log(chalk.green('✔ Instancia ja conectada!'))
    }
  } catch (err) {
    console.error(chalk.red('Erro ao conectar:'), err.message)
    console.log(chalk.gray('Verifique se o Docker esta rodando: docker-compose up -d'))
  }
}

async function waitForConnection(maxAttempts = 40) {
  for (let i = 0; i < maxAttempts; i++) {
    await sleep(3000)
    const status = await checkStatus()
    if (status === 'open') {
      console.log(chalk.green('\n✔ WhatsApp conectado com sucesso!\n'))
      return
    }
    process.stdout.write('.')
  }
  console.log(chalk.red('\nTimeout. Tente novamente com: npm run connect'))
}

async function checkStatus() {
  try {
    const { data } = await api.get(`/instance/connectionState/${INSTANCE}`)
    return data?.instance?.state || 'close'
  } catch {
    return 'close'
  }
}

async function sendMessage(phone, message) {
  const { data } = await api.post(`/message/sendText/${INSTANCE}`, {
    number: formatPhone(phone),
    textMessage: { text: message }
  })
  return data
}

function formatPhone(phone) {
  let num = phone.replace(/\D/g, '')
  if (!num.startsWith('55')) num = '55' + num
  return num
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

module.exports = { connectInstance, checkStatus, sendMessage }
