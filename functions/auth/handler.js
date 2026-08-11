const bcrypt = require("bcryptjs")
const { v4: uuidv4 } = require("uuid")
const { getPool } = require("../../shared/db")
const { signToken } = require("../../shared/auth")
const { ok, error } = require("../../shared/response")
const { sendEmail, createEmailLog, updateEmailLogResendId, injectTracking, passwordResetEmail } = require("../../shared/email")
const { signToken, verifyToken } = require("../../shared/auth")

exports.handler = async (event) => {
  const routeKey = event.routeKey
  try {
    if (routeKey === "POST /auth/register")        return await register(event)
    if (routeKey === "POST /auth/login")           return await login(event)
    if (routeKey === "POST /auth/forgot-password")         return await forgotPassword(event)
    if (routeKey === "GET /auth/reset-password-magic")    return await resetPasswordMagic(event)
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
    "INSERT INTO energy_wallets (id, user_id, balance) VALUES ($1, $2, 0)",
    [uuidv4(), userId]
  )

  // Auto-assign Academy division (OddsRivals)
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

async function forgotPassword(event) {
  const body = JSON.parse(event.body || "{}")
  const { email } = body
  if (!email) return error(400, "Email is required")

  const pool = await getPool()
  const result = await pool.query(
    "SELECT id, display_name, notifications_enabled FROM users WHERE email = $1 AND role = 'user'",
    [email.toLowerCase()]
  )

  // Always return success to avoid email enumeration
  if (result.rows.length === 0) return ok({ message: "If that email is registered, you'll receive a new password shortly." })

  const user = result.rows[0]
  const newPassword = generatePassword()
  const hash = await bcrypt.hash(newPassword, 10)

  await pool.query("UPDATE users SET password_hash = $1 WHERE id = $2", [hash, user.id])

  const displayName = user.display_name || 'there'
  const subject = `🔑 Your new OddsRivals password`
  const logId = await createEmailLog(pool, { userId: user.id, type: 'password_reset', subject })
  const { html } = passwordResetEmail({ displayName, newPassword, logId })
  const trackedHtml = injectTracking(html, logId)
  const resendId = await sendEmail(email.toLowerCase(), subject, trackedHtml)
  await updateEmailLogResendId(pool, logId, resendId)

  return ok({ message: "If that email is registered, you'll receive a new password shortly." })
}

async function resetPasswordMagic(event) {
  const token = event.queryStringParameters?.token
  const htmlPage = (title, msg, color = '#22c55e') => ({
    statusCode: 200,
    headers: { 'Content-Type': 'text/html' },
    body: `<!DOCTYPE html><html><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>OddsRivals</title></head>
<body style="margin:0;padding:40px 20px;background:#060a10;font-family:'Helvetica Neue',Arial,sans-serif;display:flex;align-items:center;justify-content:center;min-height:80vh;">
<div style="max-width:420px;width:100%;text-align:center;">
  <div style="font-size:22px;font-weight:900;letter-spacing:0.06em;color:#fff;margin-bottom:32px;">ODDS<span style="color:#22c55e;">RIVALS</span></div>
  <div style="background:#0d1117;border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:36px 28px;">
    <div style="font-size:48px;margin-bottom:16px;">${color === '#22c55e' ? '📬' : '⚠️'}</div>
    <h1 style="margin:0 0 12px;font-size:22px;font-weight:900;color:#fff;">${title}</h1>
    <p style="margin:0 0 28px;font-size:14px;color:rgba(255,255,255,0.45);line-height:1.7;">${msg}</p>
    <a href="https://oddsrivals.com/login" style="display:inline-block;padding:13px 32px;background:linear-gradient(90deg,#22c55e,#16a34a);color:#fff;font-size:14px;font-weight:700;text-decoration:none;border-radius:10px;letter-spacing:0.06em;">GO TO LOGIN →</a>
  </div>
</div></body></html>`,
  })

  if (!token) return htmlPage('Invalid link', 'This link is missing a token. Please request a new password from the login page.', '#f87171')

  let payload
  try {
    payload = await verifyToken(token)
  } catch {
    return htmlPage('Link expired', 'This link has expired or is invalid. Please request a new password from the login page.', '#f87171')
  }

  if (payload.purpose !== 'password_reset') return htmlPage('Invalid link', 'This link is not valid for password reset.', '#f87171')

  const pool = await getPool()
  const result = await pool.query("SELECT id, email, display_name FROM users WHERE id = $1", [payload.userId])
  if (result.rows.length === 0) return htmlPage('User not found', 'No account found. Please register at oddsrivals.com.', '#f87171')

  const user = result.rows[0]
  const newPassword = generatePassword()
  const hash = await bcrypt.hash(newPassword, 10)
  await pool.query("UPDATE users SET password_hash = $1 WHERE id = $2", [hash, user.id])

  const subject = `🔑 Your new OddsRivals password`
  const logId = await createEmailLog(pool, { userId: user.id, type: 'password_reset', subject })
  const { html } = passwordResetEmail({ displayName: user.display_name || 'there', newPassword, logId })
  const trackedHtml = injectTracking(html, logId)
  const resendId = await sendEmail(user.email, subject, trackedHtml)
  await updateEmailLogResendId(pool, logId, resendId)

  return htmlPage('Password sent!', `We've sent a new password to <strong style="color:rgba(255,255,255,0.8);">${user.email}</strong>. Check your inbox and use it to log in.`)
}

function generatePassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'
  let pw = ''
  for (let i = 0; i < 12; i++) {
    if (i > 0 && i % 4 === 0) pw += '-'
    pw += chars[Math.floor(Math.random() * chars.length)]
  }
  return pw
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

  await pool.query(
    "UPDATE users SET last_login_at = NOW(), login_count = login_count + 1 WHERE id = $1",
    [user.id]
  )
  pool.query(
    `INSERT INTO user_daily_activity (user_id, day) VALUES ($1, CURRENT_DATE) ON CONFLICT DO NOTHING`,
    [user.id]
  ).catch(() => {})

  const token = await signToken({
    userId:       user.id,
    email:        user.email,
    display_name: user.display_name,
    role:         user.role,
  })
  return ok({ token, userId: user.id, email: user.email, display_name: user.display_name, role: user.role })
}
