const jwt = require("jsonwebtoken")
const { getSecrets } = require("./ssm")

async function signToken(payload) {
  const secrets = await getSecrets()
  return jwt.sign(payload, secrets.secret, { expiresIn: "7d" })
}

async function verifyToken(token) {
  const secrets = await getSecrets()
  return jwt.verify(token, secrets.secret)
}

function extractFromEvent(event) {
  const header = event.headers?.authorization || event.headers?.Authorization || ""
  return header.replace("Bearer ", "")
}

module.exports = { signToken, verifyToken, extractFromEvent }
