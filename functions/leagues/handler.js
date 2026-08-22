const { getPool } = require('../../shared/db')
const { verifyToken, extractFromEvent } = require('../../shared/auth')
const { ok, error, unauthorized } = require('../../shared/response')

exports.handler = async (event) => {
  const routeKey = event.routeKey

  let user
  try {
    user = await verifyToken(extractFromEvent(event))
  } catch {
    return unauthorized()
  }

  try {
    if (routeKey === 'GET /leagues')                           return await listMyLeagues(event, user)
    if (routeKey === 'POST /leagues')                          return await createLeague(event, user)
    if (routeKey === 'GET /leagues/{id}')                      return await getLeague(event, user)
    if (routeKey === 'PUT /leagues/{id}')                      return await updateLeague(event, user)
    if (routeKey === 'POST /leagues/join/{code}')              return await joinLeague(event, user)
    if (routeKey === 'GET /leagues/{id}/standings')            return await getStandings(event, user)
    if (routeKey === 'POST /leagues/{id}/periods')             return await createPeriod(event, user)
    if (routeKey === 'PUT /leagues/{id}/periods/{periodId}')   return await updatePeriod(event, user)
    if (routeKey === 'GET /leagues/sprints')                   return await listSprints(event, user)
    if (routeKey === 'PUT /leagues/{id}/members/{userId}/payment') return await togglePayment(event, user)
    if (routeKey === 'DELETE /leagues/{id}/leave')                return await leaveLeague(event, user)
    return error(404, 'Not found')
  } catch (err) {
    console.error(err)
    return error(500, 'Internal server error')
  }
}

// ── GET /leagues ───────────────────────────────────────────────────────────────
async function listMyLeagues(event, user) {
  const pool = await getPool()
  const { rows } = await pool.query(`
    SELECT
      l.id, l.name, l.invite_code, l.image_url, l.entry_fee_euros, l.created_at,
      m.role, m.has_paid,
      (SELECT COUNT(*) FROM private_league_members WHERE league_id = l.id) AS member_count,
      (SELECT row_to_json(p) FROM (
        SELECT id, name, status, created_at
        FROM private_league_periods
        WHERE league_id = l.id
        ORDER BY created_at DESC LIMIT 1
      ) p) AS current_period,
      (
        SELECT COUNT(*) + 1
        FROM private_league_members m2
        LEFT JOIN (
          SELECT user_id, COALESCE(SUM(league_points + COALESCE(perfect_week_bonus, 0)), 0) AS pts
          FROM user_gameweek_entries GROUP BY user_id
        ) agg ON agg.user_id = m2.user_id
        WHERE m2.league_id = l.id
          AND COALESCE(agg.pts, 0) > (
            SELECT COALESCE(SUM(league_points + COALESCE(perfect_week_bonus, 0)), 0)
            FROM user_gameweek_entries WHERE user_id = $1
          )
      ) AS my_position
    FROM private_leagues l
    JOIN private_league_members m ON m.league_id = l.id AND m.user_id = $1
    ORDER BY l.created_at DESC
  `, [user.userId])
  return ok(rows)
}

// ── POST /leagues ──────────────────────────────────────────────────────────────
async function createLeague(event, user) {
  const body = JSON.parse(event.body || '{}')
  const { name, entry_fee_euros, image_url } = body
  if (!name?.trim()) return error(400, 'name is required')

  const pool = await getPool()
  const invite_code = generateCode()

  const { rows } = await pool.query(`
    INSERT INTO private_leagues (name, invite_code, image_url, created_by, entry_fee_euros)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING id, name, invite_code
  `, [name.trim(), invite_code, image_url || null, user.userId, entry_fee_euros || 0])

  const league = rows[0]

  // Creator is admin member
  await pool.query(`
    INSERT INTO private_league_members (league_id, user_id, role)
    VALUES ($1, $2, 'admin')
  `, [league.id, user.userId])

  return ok(league, 201)
}

// ── GET /leagues/{id} ──────────────────────────────────────────────────────────
async function getLeague(event, user) {
  const { id } = event.pathParameters
  const pool = await getPool()

  // Must be a member
  const membership = await pool.query(`
    SELECT role FROM private_league_members WHERE league_id = $1 AND user_id = $2
  `, [id, user.userId])
  if (membership.rows.length === 0) return error(403, 'Not a member of this league')

  const { rows: [league] } = await pool.query(`
    SELECT l.*, (SELECT COUNT(*) FROM private_league_members WHERE league_id = l.id) AS member_count
    FROM private_leagues l WHERE l.id = $1
  `, [id])
  if (!league) return error(404, 'League not found')

  const { rows: periods } = await pool.query(`
    SELECT * FROM private_league_periods WHERE league_id = $1 ORDER BY created_at DESC
  `, [id])

  const { rows: members } = await pool.query(`
    SELECT
      m.user_id, m.role, m.has_paid, m.joined_at,
      u.display_name, u.avatar_url, u.email
    FROM private_league_members m
    JOIN users u ON u.id = m.user_id
    WHERE m.league_id = $1
    ORDER BY m.role DESC, m.joined_at ASC
  `, [id])

  return ok({
    ...league,
    my_role: membership.rows[0].role,
    periods,
    members,
  })
}

// ── PUT /leagues/{id} ─────────────────────────────────────────────────────────
async function updateLeague(event, user) {
  const { id } = event.pathParameters
  const body = JSON.parse(event.body || '{}')
  const pool = await getPool()

  const mem = await pool.query(`
    SELECT role FROM private_league_members WHERE league_id = $1 AND user_id = $2
  `, [id, user.userId])
  if (mem.rows.length === 0 || mem.rows[0].role !== 'admin') return error(403, 'Admin only')

  const { name, image_url, entry_fee_euros } = body
  await pool.query(`
    UPDATE private_leagues
    SET name = COALESCE($1, name),
        image_url = COALESCE($2, image_url),
        entry_fee_euros = COALESCE($3, entry_fee_euros),
        updated_at = NOW()
    WHERE id = $4
  `, [name || null, image_url || null, entry_fee_euros ?? null, id])

  return ok({ updated: true })
}

// ── POST /leagues/join/{code} ─────────────────────────────────────────────────
async function joinLeague(event, user) {
  const { code } = event.pathParameters
  const pool = await getPool()

  const { rows: [league] } = await pool.query(`
    SELECT id, name FROM private_leagues WHERE invite_code = $1
  `, [code.toUpperCase()])
  if (!league) return error(404, 'Invalid invite code')

  const existing = await pool.query(`
    SELECT id FROM private_league_members WHERE league_id = $1 AND user_id = $2
  `, [league.id, user.userId])
  if (existing.rows.length > 0) return error(409, 'Already a member')

  await pool.query(`
    INSERT INTO private_league_members (league_id, user_id, role) VALUES ($1, $2, 'member')
  `, [league.id, user.userId])

  return ok({ league_id: league.id, league_name: league.name, joined: true })
}

// ── GET /leagues/{id}/standings ───────────────────────────────────────────────
async function getStandings(event, user) {
  const { id } = event.pathParameters
  const allTime = event.queryStringParameters?.all_time === 'true'
  const pool = await getPool()

  const mem = await pool.query(`
    SELECT role FROM private_league_members WHERE league_id = $1 AND user_id = $2
  `, [id, user.userId])
  if (mem.rows.length === 0) return error(403, 'Not a member')

  const { rows: [period] } = await pool.query(`
    SELECT * FROM private_league_periods WHERE league_id = $1 ORDER BY created_at DESC LIMIT 1
  `, [id])

  // Build date filter unless all_time requested
  let dateFilter = ''
  let dateParams = [id]
  if (!allTime && (period?.start_matchweek_id || period?.end_matchweek_id)) {
    const { rows: [bounds] } = await pool.query(`
      SELECT MIN(start_date) AS from_dt, MAX(end_date) AS to_dt
      FROM sprints WHERE id IN ($1, $2)
    `, [period.start_matchweek_id || period.end_matchweek_id, period.end_matchweek_id || period.start_matchweek_id])
    if (bounds?.from_dt) {
      dateFilter = `AND g.start_date >= $2 AND g.end_date <= $3`
      dateParams = [id, bounds.from_dt, bounds.to_dt]
    }
  }

  const { rows } = await pool.query(`
    SELECT
      u.id AS user_id, u.display_name, u.avatar_url,
      m.has_paid,
      COALESCE(SUM(uge.league_points + COALESCE(uge.perfect_week_bonus, 0)), 0) AS total_points,
      COALESCE(SUM(uge.correct_picks), 0) AS correct_picks,
      COUNT(DISTINCT uge.gameweek_id) AS gameweeks_played,
      ROW_NUMBER() OVER (ORDER BY COALESCE(SUM(uge.league_points + COALESCE(uge.perfect_week_bonus, 0)), 0) DESC, u.display_name ASC) AS position,
      d.name AS division_name
    FROM private_league_members m
    JOIN users u ON u.id = m.user_id
    LEFT JOIN user_gameweek_entries uge ON uge.user_id = m.user_id
    LEFT JOIN gameweeks g ON g.id = uge.gameweek_id ${dateFilter}
    LEFT JOIN user_division_status uds ON uds.user_id = u.id
    LEFT JOIN divisions d ON d.id = uds.division_id
    WHERE m.league_id = $1
    GROUP BY u.id, u.display_name, u.avatar_url, m.has_paid, d.name
    ORDER BY total_points DESC, u.display_name ASC
  `, dateParams)

  return ok({ period: period || null, standings: rows })
}

// ── POST /leagues/{id}/periods ────────────────────────────────────────────────
async function createPeriod(event, user) {
  const { id } = event.pathParameters
  const body = JSON.parse(event.body || '{}')
  const pool = await getPool()

  const mem = await pool.query(`
    SELECT role FROM private_league_members WHERE league_id = $1 AND user_id = $2
  `, [id, user.userId])
  if (mem.rows.length === 0 || mem.rows[0].role !== 'admin') return error(403, 'Admin only')

  const { name, start_matchweek_id, end_matchweek_id, prize_config } = body
  if (!name?.trim()) return error(400, 'name is required')

  // Close any live periods first
  await pool.query(`
    UPDATE private_league_periods SET status = 'completed' WHERE league_id = $1 AND status = 'live'
  `, [id])

  const { rows: [period] } = await pool.query(`
    INSERT INTO private_league_periods (league_id, name, start_matchweek_id, end_matchweek_id, status, prize_config)
    VALUES ($1, $2, $3, $4, 'live', $5)
    RETURNING *
  `, [id, name.trim(), start_matchweek_id || null, end_matchweek_id || null, prize_config ? JSON.stringify(prize_config) : '{}'])

  return ok(period, 201)
}

// ── GET /leagues/sprints ──────────────────────────────────────────────────────
async function listSprints(event, user) {
  const pool = await getPool()
  const { rows } = await pool.query(`
    SELECT id, name, status, start_date, end_date
    FROM sprints
    WHERE end_date >= NOW() - INTERVAL '8 weeks'
    ORDER BY start_date ASC
    LIMIT 20
  `)
  return ok(rows)
}

// ── PUT /leagues/{id}/periods/{periodId} ──────────────────────────────────────
async function updatePeriod(event, user) {
  const { id, periodId } = event.pathParameters
  const { name, start_sprint_id, end_sprint_id } = JSON.parse(event.body || '{}')
  const pool = await getPool()

  const mem = await pool.query(
    'SELECT role FROM private_league_members WHERE league_id = $1 AND user_id = $2',
    [id, user.userId]
  )
  if (!mem.rows.length || mem.rows[0].role !== 'admin') return error(403, 'Admin only')

  const { rows: [period] } = await pool.query(
    'SELECT id FROM private_league_periods WHERE id = $1 AND league_id = $2',
    [periodId, id]
  )
  if (!period) return error(404, 'Period not found')

  // Store sprint IDs directly in the matchweek columns (now UUID type)
  await pool.query(
    `UPDATE private_league_periods
     SET name               = COALESCE($1, name),
         start_matchweek_id = COALESCE($2::uuid, start_matchweek_id),
         end_matchweek_id   = COALESCE($3::uuid, end_matchweek_id)
     WHERE id = $4`,
    [name?.trim() || null, start_sprint_id || null, end_sprint_id || null, periodId]
  )

  return ok({ updated: true })
}

// ── PUT /leagues/{id}/members/{userId}/payment ────────────────────────────────
async function togglePayment(event, user) {
  const { id, userId } = event.pathParameters
  const body = JSON.parse(event.body || '{}')
  const pool = await getPool()

  const mem = await pool.query(`
    SELECT role FROM private_league_members WHERE league_id = $1 AND user_id = $2
  `, [id, user.userId])
  if (mem.rows.length === 0 || mem.rows[0].role !== 'admin') return error(403, 'Admin only')

  const { has_paid } = body
  await pool.query(`
    UPDATE private_league_members SET has_paid = $1 WHERE league_id = $2 AND user_id = $3
  `, [!!has_paid, id, userId])

  return ok({ updated: true })
}

// ── DELETE /leagues/{id}/leave ────────────────────────────────────────────────
async function leaveLeague(event, user) {
  const { id } = event.pathParameters
  const pool = await getPool()

  const { rows: [mem] } = await pool.query(`
    SELECT role FROM private_league_members WHERE league_id = $1 AND user_id = $2
  `, [id, user.userId])
  if (!mem) return error(404, 'Not a member')

  if (mem.role === 'admin') {
    const { rows: [{ admin_count }] } = await pool.query(`
      SELECT COUNT(*) AS admin_count FROM private_league_members WHERE league_id = $1 AND role = 'admin'
    `, [id])
    if (parseInt(admin_count) <= 1) return error(400, 'Transfer admin role before leaving')
  }

  await pool.query(`
    DELETE FROM private_league_members WHERE league_id = $1 AND user_id = $2
  `, [id, user.userId])

  return ok({ left: true })
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code = ''
  for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)]
  return code
}
