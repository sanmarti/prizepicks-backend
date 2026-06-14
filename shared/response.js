const headers = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*"
}

const ok = (data, status = 200) => ({
  statusCode: status,
  headers,
  body: JSON.stringify(data)
})

const error = (status, message) => ({
  statusCode: status,
  headers,
  body: JSON.stringify({ error: message })
})

const unauthorized = () => error(401, "Unauthorized")

module.exports = { ok, error, unauthorized }
