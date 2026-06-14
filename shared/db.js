const { Pool } = require("pg")
const { getSecrets } = require("./ssm")
let pool = null

async function getPool() {
  if (pool) return pool
  const secrets = await getSecrets()
  pool = new Pool({
    connectionString: secrets.url,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    ssl: false
  })
  return pool
}

module.exports = { getPool }
