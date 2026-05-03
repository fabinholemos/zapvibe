const crypto = require('crypto')
const db = require('./db')

function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString('hex')
    crypto.scrypt(password, salt, 64, (err, key) => {
      if (err) reject(err)
      else resolve(`${salt}:${key.toString('hex')}`)
    })
  })
}

function verifyPassword(password, hash) {
  return new Promise((resolve, reject) => {
    const [salt, key] = hash.split(':')
    crypto.scrypt(password, salt, 64, (err, derived) => {
      if (err) reject(err)
      else resolve(derived.toString('hex') === key)
    })
  })
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex')
}

function parseCookies(req) {
  const header = req.headers.cookie || ''
  return Object.fromEntries(header.split(';').map(c => c.trim().split('=').map(decodeURIComponent)))
}

async function getAuthSession(req) {
  const cookies = parseCookies(req)
  if (!cookies.session) return null
  return db.getSession(cookies.session)
}

module.exports = { hashPassword, verifyPassword, generateToken, parseCookies, getAuthSession }
