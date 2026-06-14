const { SSMClient, GetParametersCommand } = require("@aws-sdk/client-ssm")
const client = new SSMClient({ region: "eu-west-3" })
let cache = null

async function getSecrets() {
  if (cache) return cache
  const { Parameters } = await client.send(new GetParametersCommand({
    Names: [
      "/prizepicks/db/url",
      "/prizepicks/jwt/secret",
      "/prizepicks/api_football/key",
      "/prizepicks/stripe/secret"
    ],
    WithDecryption: true
  }))
  cache = {}
  Parameters.forEach(p => {
    const key = p.Name.split("/").pop()
    cache[key] = p.Value
  })
  return cache
}

module.exports = { getSecrets }
