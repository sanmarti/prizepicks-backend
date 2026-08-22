const { getPool } = require('../../shared/db')
const { verifyToken, extractFromEvent } = require('../../shared/auth')
const { ok, error, unauthorized } = require('../../shared/response')
const { v4: uuidv4 } = require('uuid')

exports.handler = async (event) => {
  const routeKey = event.routeKey

  let user
  try {
    user = await verifyToken(extractFromEvent(event))
  } catch {
    return unauthorized()
  }

  try {
    if (routeKey === 'GET /leagues')                                return await listMyLeagues(event, user)
    if (routeKey === 'POST /leagues')                               return await createLeague(event, user)
    if (routeKey === 'GET /leagues/{id}')                           return await getLeague(event, user)
    if (routeKey === 'PUT /leagues/{id}')                           return await updateLeague(event, user)
    if (routeKey === 'POST /leagues/join/{code}')                   return await joinLeague(event, user)
    if (routeKey === 'GET /leagues/{id}/standings')                 return await getStandings(event, user)
    if (routeKey === 'GET /leagues/{id}/matchup')                   return await getMatchupForUser(event, user)
    if (routeKey === 'POST /leagues/{id}/picks')                    return await submitLeaguePicks(event, user)
    if (routeKey === 'GET /leagues/{id}/calendar')                  return await getLeagueCalendar(event, user)
    if (routeKey === 'PUT /leagues/{id}/members/{userId}/payment')  return await togglePayment(event, user)
    if (routeKey === 'DELETE /leagues/{id}/leave')                  return await leaveLeague(event, user)
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
      l.status, l.current_week, l.total_weeks, l.season_name,
      m.role, m.has_paid, m.league_points,
      (SELECT COUNT(*) FROM private_league_members WHERE league_id = l.id) AS member_count,
      (
        SELECT COUNT(*) + 1
        FROM private_league_members m2
        WHERE m2.league_id = l.id AND m2.league_points > m.league_points
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

  const membership = await pool.query(`
    SELECT role FROM private_league_members WHERE league_id = $1 AND user_id = $2
  `, [id, user.userId])
  if (membership.rows.length === 0) return error(403, 'Not a member of this league')

  const { rows: [league] } = await pool.query(`
    SELECT l.*, (SELECT COUNT(*) FROM private_league_members WHERE league_id = l.id) AS member_count
    FROM private_leagues l WHERE l.id = $1
  `, [id])
  if (!league) return error(404, 'League not found')

  const { rows: members } = await pool.query(`
    SELECT
      m.user_id, m.role, m.has_paid, m.joined_at,
      m.league_points, m.wins, m.draws, m.losses, m.goals_for, m.goals_against, m.played,
      u.display_name, u.avatar_url, u.email
    FROM private_league_members m
    JOIN users u ON u.id = m.user_id
    WHERE m.league_id = $1
    ORDER BY m.league_points DESC, m.role DESC, m.joined_at ASC
  `, [id])

  return ok({
    ...league,
    my_role: membership.rows[0].role,
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
    SELECT id, name, status FROM private_leagues WHERE invite_code = $1
  `, [code.toUpperCase()])
  if (!league) return error(404, 'Invalid invite code')
  if (league.status === 'active' || league.status === 'completed') {
    return error(409, 'This league has already started and is not accepting new members')
  }

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
  const pool = await getPool()

  const mem = await pool.query(`
    SELECT role FROM private_league_members WHERE league_id = $1 AND user_id = $2
  `, [id, user.userId])
  if (mem.rows.length === 0) return error(403, 'Not a member')

  const { rows } = await pool.query(`
    SELECT
      u.id AS user_id, u.display_name, u.avatar_url,
      m.role, m.has_paid,
      m.league_points, m.wins, m.draws, m.losses, m.goals_for, m.goals_against, m.played,
      (m.goals_for - m.goals_against) AS goal_diff,
      ROW_NUMBER() OVER (
        ORDER BY m.league_points DESC,
                 (m.goals_for - m.goals_against) DESC,
                 m.goals_for DESC,
                 u.display_name ASC
      ) AS position,
      d.name AS division_name
    FROM private_league_members m
    JOIN users u ON u.id = m.user_id
    LEFT JOIN user_division_status uds ON uds.user_id = u.id
    LEFT JOIN divisions d ON d.id = uds.division_id
    WHERE m.league_id = $1
    ORDER BY position
  `, [id])

  return ok({ standings: rows })
}

// ── GET /leagues/{id}/matchup ─────────────────────────────────────────────────
async function getMatchupForUser(event, user) {
  const { id } = event.pathParameters
  const pool = await getPool()

  const mem = await pool.query(`
    SELECT role FROM private_league_members WHERE league_id = $1 AND user_id = $2
  `, [id, user.userId])
  if (mem.rows.length === 0) return error(403, 'Not a member')

  const { rows: [league] } = await pool.query(`
    SELECT current_week, total_weeks, status FROM private_leagues WHERE id = $1
  `, [id])
  if (!league || league.status === 'draft') return ok({ matchup: null })

  const { rows: [matchup] } = await pool.query(`
    SELECT m.*,
      hu.display_name AS home_display_name, hu.avatar_url AS home_avatar,
      au.display_name AS away_display_name, au.avatar_url AS away_avatar
    FROM matchups m
    JOIN users hu ON hu.id = m.home_user_id
    JOIN users au ON au.id = m.away_user_id
    WHERE m.league_id = $1
      AND m.league_week = $2
      AND (m.home_user_id = $3 OR m.away_user_id = $3)
  `, [id, league.current_week, user.userId])

  if (!matchup) return ok({ matchup: null, current_week: league.current_week })

  const isHome = matchup.home_user_id === user.userId
  const myUserId   = user.userId
  const rivalId    = isHome ? matchup.away_user_id : matchup.home_user_id
  const rivalName  = isHome ? matchup.away_display_name : matchup.home_display_name
  const rivalAvatar = isHome ? matchup.away_avatar : matchup.home_avatar

  let gameweek = null
  let events = []
  let myPicks = []
  let rivalPicks = []

  if (matchup.gameweek_id) {
    const gwRes = await pool.query(`
      SELECT gw.id, gw.week_number, gw.year, gw.lock_time, gw.reveal_time, gw.status
      FROM gameweeks gw WHERE gw.id = $1
    `, [matchup.gameweek_id])
    gameweek = gwRes.rows[0] || null

    const evRes = await pool.query(`
      SELECT e.*, array_agg(
        json_build_object('id', eo.id, 'label', eo.label, 'outcome', eo.outcome)
        ORDER BY eo.id
      ) AS options
      FROM events e
      LEFT JOIN event_options eo ON eo.event_id = e.id
      WHERE e.gameweek_id = $1
      GROUP BY e.id
      ORDER BY e.match_time ASC
    `, [matchup.gameweek_id])
    events = evRes.rows

    const picksQuery = `
      SELECT up.event_id, up.event_option_id, up.pick_status, eo.label AS pick_label
      FROM user_picks up
      JOIN event_options eo ON eo.id = up.event_option_id
      WHERE up.user_id = $1 AND up.gameweek_id = $2
    `
    const [myRes, rivalRes] = await Promise.all([
      pool.query(picksQuery, [myUserId, matchup.gameweek_id]),
      pool.query(picksQuery, [rivalId, matchup.gameweek_id]),
    ])
    myPicks    = myRes.rows
    rivalPicks = rivalRes.rows
  }

  const myCorrect    = myPicks.filter(p => p.pick_status === 'won').length
  const rivalCorrect = rivalPicks.filter(p => p.pick_status === 'won').length
  const outlook = myCorrect > rivalCorrect ? 'Winning' : myCorrect < rivalCorrect ? 'Losing' : 'Drawing'

  return ok({
    matchup,
    gameweek,
    events,
    my_picks:    myPicks,
    rival_picks: rivalPicks,
    rival: { user_id: rivalId, display_name: rivalName, avatar_url: rivalAvatar },
    my_correct:    myCorrect,
    rival_correct: rivalCorrect,
    outlook,
    current_week:  league.current_week,
    total_weeks:   league.total_weeks,
  })
}

// ── POST /leagues/{id}/picks ──────────────────────────────────────────────────
async function submitLeaguePicks(event, user) {
  const { id } = event.pathParameters
  const { picks } = JSON.parse(event.body || '{}')
  if (!Array.isArray(picks) || picks.length === 0) return error(400, 'picks array required')

  const pool = await getPool()

  const mem = await pool.query(`
    SELECT role FROM private_league_members WHERE league_id = $1 AND user_id = $2
  `, [id, user.userId])
  if (mem.rows.length === 0) return error(403, 'Not a member')

  const { rows: [league] } = await pool.query(`
    SELECT current_week FROM private_leagues WHERE id = $1
  `, [id])

  const { rows: [matchup] } = await pool.query(`
    SELECT * FROM matchups
    WHERE league_id = $1 AND league_week = $2
      AND (home_user_id = $3 OR away_user_id = $3)
  `, [id, league.current_week, user.userId])

  if (!matchup) return error(404, 'No active matchup this week')
  if (!matchup.gameweek_id) return error(400, 'Gameweek not yet linked to this matchup')

  const { rows: [gw] } = await pool.query(`
    SELECT status FROM gameweeks WHERE id = $1
  `, [matchup.gameweek_id])
  if (!gw || gw.status !== 'PUBLISHED') return error(400, 'Picks are not open for this gameweek')

  // Upsert the entry record
  const { rows: [entry] } = await pool.query(`
    INSERT INTO user_gameweek_entries (user_id, gameweek_id)
    VALUES ($1, $2)
    ON CONFLICT (user_id, gameweek_id) DO UPDATE SET updated_at = NOW()
    RETURNING id
  `, [user.userId, matchup.gameweek_id])

  // Upsert each pick
  for (const pick of picks) {
    if (!pick.event_id || !pick.event_option_id) continue
    await pool.query(`
      INSERT INTO user_picks (id, entry_id, user_id, gameweek_id, event_id, event_option_id, pick_status)
      VALUES ($1, $2, $3, $4, $5, $6, 'pending')
      ON CONFLICT (entry_id, event_id) DO UPDATE
        SET event_option_id = EXCLUDED.event_option_id,
            pick_status     = 'pending'
    `, [uuidv4(), entry.id, user.userId, matchup.gameweek_id, pick.event_id, pick.event_option_id])
  }

  await pool.query(`
    UPDATE user_gameweek_entries
    SET picks_submitted = $1
    WHERE id = $2
  `, [picks.length, entry.id])

  return ok({ submitted: true, picks_count: picks.length })
}

// ── GET /leagues/{id}/calendar ────────────────────────────────────────────────
async function getLeagueCalendar(event, user) {
  const { id } = event.pathParameters
  const pool = await getPool()

  const mem = await pool.query(`
    SELECT role FROM private_league_members WHERE league_id = $1 AND user_id = $2
  `, [id, user.userId])
  if (mem.rows.length === 0) return error(403, 'Not a member')

  const { rows } = await pool.query(`
    SELECT
      m.id, m.league_week, m.status, m.gameweek_id,
      m.home_user_id, hu.display_name AS home_name, hu.avatar_url AS home_avatar,
      m.away_user_id, au.display_name AS away_name, au.avatar_url AS away_avatar,
      m.home_score, m.away_score, m.home_league_points, m.away_league_points,
      gw.week_number, gw.year, gw.lock_time
    FROM matchups m
    JOIN users hu ON hu.id = m.home_user_id
    JOIN users au ON au.id = m.away_user_id
    LEFT JOIN gameweeks gw ON gw.id = m.gameweek_id
    WHERE m.league_id = $1
    ORDER BY m.league_week ASC, m.home_user_id ASC
  `, [id])

  // Group by week
  const calendar = {}
  for (const row of rows) {
    const w = row.league_week
    if (!calendar[w]) calendar[w] = []
    calendar[w].push(row)
  }

  return ok({ calendar })
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
