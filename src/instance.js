const axios = require('axios')

const api = axios.create({
  baseURL: process.env.EVOLUTION_API_URL,
  headers: { apikey: process.env.EVOLUTION_API_KEY }
})

async function createInstance(instanceName) {
  const { data } = await api.post('/instance/create', {
    instanceName,
    qrcode: true,
    integration: 'WHATSAPP-BAILEYS'
  })
  return data
}

async function deleteInstance(instanceName) {
  const { data } = await api.delete(`/instance/delete/${instanceName}`)
  return data
}

async function listInstances() {
  const { data } = await api.get('/instance/fetchInstances')
  return data
}

async function getQRCode(instanceName) {
  const { data } = await api.get(`/instance/connect/${instanceName}`)
  return data
}

async function getStatus(instanceName) {
  const { data } = await api.get(`/instance/connectionState/${instanceName}`)
  return data
}

module.exports = { createInstance, deleteInstance, listInstances, getQRCode, getStatus }
