const Stripe = require("stripe")
const { v4: uuidv4 } = require("uuid")
const { getPool } = require("../../shared/db")
const { getSecrets } = require("../../shared/ssm")
const { verifyToken, extractFromEvent } = require("../../shared/auth")
const { ok, error, unauthorized } = require("../../shared/response")

const PACKS = {
  starter: { units: 4, amount: 399, label: "Starter Pack - 4 Energy Units" },
  value: { units: 10, amount: 799, label: "Value Pack - 10 Energy Units" },
  pro: { units: 20, amount: 1499, label: "Pro Pack - 20 Energy Units" }
}

exports.handler = async (event) => {
  const routeKey = event.routeKey

  let user
  try {
    user = await verifyToken(extractFromEvent(event))
  } catch {
    return unauthorized()
  }

  try {
    if (routeKey === "GET /energy") return await getEnergy(event, user)
    if (routeKey === "POST /energy/buy") return await buyEnergy(event, user)
    return error(404, "Not found")
  } catch (err) {
    console.error(err)
    return error(500, "Internal server error")
  }
}

async function getEnergy(event, user) {
  const pool = await getPool()

  const wallet = await pool.query(
    "SELECT balance FROM energy_wallets WHERE user_id = $1",
    [user.userId]
  )
  const transactions = await pool.query(
    `SELECT id, amount, type, description, created_at
     FROM energy_transactions WHERE user_id = $1
     ORDER BY created_at DESC LIMIT 10`,
    [user.userId]
  )

  return ok({
    balance: wallet.rows[0]?.balance || 0,
    transactions: transactions.rows
  })
}

async function buyEnergy(event, user) {
  const { pack } = JSON.parse(event.body || "{}")
  if (!pack || !PACKS[pack]) return error(400, "Invalid pack. Choose starter, value or pro")

  const secrets = await getSecrets()
  const stripe = new Stripe(secrets.secret)
  const packDetails = PACKS[pack]

  const paymentIntent = await stripe.paymentIntents.create({
    amount: packDetails.amount,
    currency: "eur",
    metadata: {
      userId: user.userId,
      pack,
      units: packDetails.units
    },
    description: packDetails.label
  })

  return ok({
    clientSecret: paymentIntent.client_secret,
    pack,
    units: packDetails.units,
    amount: packDetails.amount,
    currency: "eur"
  })
}
