const bcrypt = require('bcryptjs')
const { getPool } = require('../../shared/db')
const { verifyToken, extractFromEvent } = require('../../shared/auth')
const { ok, error, unauthorized } = require('../../shared/response')

exports.handler = async (event) => {
  const routeKey = event.routeKey
  try {
    if (routeKey === 'GET /users/me')           return await getProfile(event)
    if (routeKey === 'PUT /users/me')           return await updateProfile(event)
    if (routeKey === 'PUT /users/me/password')  return await changePassword(event)
    return error(404, 'Not found')
  } catch (err) {
    console.error(err)
    return error(500, 'Internal server error')
  }
}

async function authenticate(event) {
  const token = extractFromEvent(event)
  if (!token) return null
  try { return await verifyToken(token) } catch { return null }
}

async function getProfile(event) {
  const user = await authenticate(event)
  if (!user) return unauthorized()

  const pool = await getPool()
  const { rows } = await pool.query(
    `SELECT u.id, u.email, u.display_name, u.avatar_url, u.role, u.created_at,
            COALESCE(w.balance, 0) AS energy_balance,
            COALESCE(s.wins, 0)   AS wins,
            COALESCE(s.losses, 0) AS losses,
            COALESCE(s.draws, 0)  AS draws,
            COALESCE(s.points, 0) AS points
     FROM users u
     LEFT JOIN energy_wallets w ON w.user_id = u.id
     LEFT JOIN (
       SELECT user_id,
              SUM(wins) AS wins, SUM(losses) AS losses,
              SUM(draws) AS draws, SUM(points) AS points
       FROM standings GROUP BY user_id
     ) s ON s.user_id = u.id
     WHERE u.id = $1`,
    [user.userId]
  )
  if (!rows.length) return error(404, 'User not found')
  return ok({ user: rows[0] })
}

async function updateProfile(event) {
  const me = await authenticate(event)
  if (!me) return unauthorized()

  const body = JSON.parse(event.body || '{}')
  const { display_name, avatar_url } = body

  if (display_name !== undefined && (typeof display_name !== 'string' || display_name.trim().length < 2)) {
    return error(400, 'Display name must be at least 2 characters')
  }

  // avatar_url is a base64 data URL compressed client-side — cap at 250 KB
  if (avatar_url !== undefined) {
    if (typeof avatar_url !== 'string') return error(400, 'Invalid avatar')
    if (avatar_url.length > 250 * 1024) return error(400, 'Avatar too large (max 250 KB)')
    if (avatar_url !== '' && !avatar_url.startsWith('data:image/')) return error(400, 'Invalid avatar format')
  }

  const pool = await getPool()
  const fields = []
  const vals   = []
  let idx = 1

  if (display_name !== undefined) { fields.push(`display_name = $${idx++}`); vals.push(display_name.trim()) }
  if (avatar_url   !== undefined) { fields.push(`avatar_url = $${idx++}`);   vals.push(avatar_url) }

  if (!fields.length) return error(400, 'Nothing to update')

  vals.push(me.userId)
  const { rows } = await pool.query(
    `UPDATE users SET ${fields.join(', ')} WHERE id = $${idx}
     RETURNING id, email, display_name, avatar_url, role`,
    vals
  )
  return ok({ user: rows[0] })
}

async function changePassword(event) {
  const me = await authenticate(event)
  if (!me) return unauthorized()

  const body = JSON.parse(event.body || '{}')
  const { current_password, new_password } = body

  if (!current_password || !new_password) return error(400, 'current_password and new_password are required')
  if (new_password.length < 8) return error(400, 'New password must be at least 8 characters')

  const pool = await getPool()
  const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [me.userId])
  if (!rows.length) return error(404, 'User not found')

  const valid = await bcrypt.compare(current_password, rows[0].password_hash)
  if (!valid) return error(401, 'Current password is incorrect')

  const hash = await bcrypt.hash(new_password, 10)
  await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, me.userId])
  return ok({ message: 'Password updated' })
}
