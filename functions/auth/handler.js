const bcrypt = require("bcryptjs")
const { v4: uuidv4 } = require("uuid")
const { getPool } = require("../../shared/db")
const { signToken } = require("../../shared/auth")
const { ok, error } = require("../../shared/response")

exports.handler = async (event) => {
  const routeKey = event.routeKey
  try {
    if (routeKey === "POST /auth/register") return await register(event)
    if (routeKey === "POST /auth/login")    return await login(event)
    return error(404, "Not found")
  } catch (err) {
    console.error(err)
    return error(500, "Internal server error")
  }
}

async function register(event) {
  const body = JSON.parse(event.body || "{}")
  const { email, password } = body
  // Accept both 'name' (sent by frontend) and 'display_name'
  const display_name = (body.display_name || body.name || "").trim() || null

  if (!email || !password) return error(400, "Email and password are required")
  if (password.length < 8)  return error(400, "Password must be at least 8 characters")
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return error(400, "Invalid email format")

  const pool = await getPool()
  const existing = await pool.query("SELECT id FROM users WHERE email = $1", [email.toLowerCase()])
  if (existing.rows.length > 0) return error(409, "Email already registered")

  const passwordHash = await bcrypt.hash(password, 10)
  const userId = uuidv4()

  await pool.query(
    "INSERT INTO users (id, email, password_hash, display_name, created_at) VALUES ($1, $2, $3, $4, NOW())",
    [userId, email.toLowerCase(), passwordHash, display_name]
  )
  await pool.query(
    "INSERT INTO energy_wallets (id, user_id, balance) VALUES ($1, $2, 5)",
    [uuidv4(), userId]
  )

  // Auto-assign Academy division (6 to Glory)
  try {
    const academy = await pool.query("SELECT id FROM divisions WHERE is_initial=TRUE LIMIT 1")
    if (academy.rows.length) {
      const activeSprint = await pool.query(
        "SELECT id FROM sprints WHERE status IN ('live','scheduled') ORDER BY start_date ASC LIMIT 1"
      )
      const rookieUntilId = activeSprint.rows[0]?.id ?? null
      await pool.query(
        "INSERT INTO user_division_status (user_id,division_id,is_rookie,rookie_until_sprint_id) VALUES ($1,$2,TRUE,$3) ON CONFLICT (user_id) DO NOTHING",
        [userId, academy.rows[0].id, rookieUntilId]
      )
    }
  } catch {}  // non-fatal: ensureDivisionStatus in glory handler will fix it

  const token = await signToken({
    userId,
    email: email.toLowerCase(),
    display_name,
    role: "user",
  })
  return ok({ token, userId, email: email.toLowerCase(), display_name }, 201)
}

async function login(event) {
  const body = JSON.parse(event.body || "{}")
  const { email, password } = body

  if (!email || !password) return error(400, "Email and password are required")

  const pool = await getPool()
  const result = await pool.query(
    "SELECT id, email, password_hash, display_name, role FROM users WHERE email = $1",
    [email.toLowerCase()]
  )
  if (result.rows.length === 0) return error(401, "Invalid credentials")

  const user = result.rows[0]
  const valid = await bcrypt.compare(password, user.password_hash)
  if (!valid) return error(401, "Invalid credentials")

  const token = await signToken({
    userId:       user.id,
    email:        user.email,
    display_name: user.display_name,
    role:         user.role,
  })
  return ok({ token, userId: user.id, email: user.email, display_name: user.display_name, role: user.role })
}
