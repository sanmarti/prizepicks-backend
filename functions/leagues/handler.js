const { v4: uuidv4 } = require("uuid")
const { getPool } = require("../../shared/db")
const { verifyToken, extractFromEvent } = require("../../shared/auth")
const { ok, error, unauthorized } = require("../../shared/response")

exports.handler = async (event) => {
  const routeKey = event.routeKey

  let user
  try {
    user = await verifyToken(extractFromEvent(event))
  } catch {
    return unauthorized()
  }

  try {
    if (routeKey === "GET /leagues") return await listLeagues(event, user)
    if (routeKey === "POST /leagues") return await createLeague(event, user)
    if (routeKey === "GET /leagues/{id}") return await getLeague(event, user)
    if (routeKey === "PUT /leagues/{id}") return await updateLeague(event, user)
    if (routeKey === "POST /leagues/join/{code}") return await joinLeague(event, user)
    if (routeKey === "GET /leagues/{id}/standings") return await getStandings(event, user)
    return error(404, "Not found")
  } catch (err) {
    console.error(err)
    return error(500, "Internal server error")
  }
}

async function listLeagues(event, user) {
  const pool = await getPool()
  const result = await pool.query(
    `SELECT l.id, l.name, l.competition, l.season, l.status, l.max_teams,
            s.points, s.wins, s.losses, s.draws,
            (SELECT COUNT(*) FROM league_members lm2 WHERE lm2.league_id = l.id) AS member_count,
            (SELECT g.lock_time FROM gameweeks g WHERE g.league_id = l.id AND g.status = 'PUBLISHED' ORDER BY g.lock_time ASC LIMIT 1) AS next_lock_time
     FROM leagues l
     JOIN league_members lm ON lm.league_id = l.id AND lm.user_id = $1
     LEFT JOIN standings s ON s.league_id = l.id AND s.user_id = $1
     ORDER BY l.created_at DESC`,
    [user.userId]
  )
  return ok(result.rows)
}

async function createLeague(event, user) {
  const body = JSON.parse(event.body || "{}")
  const { name, competition, season, max_teams, entry_fee, missed_week_rule, league_format } = body

  if (!name || !competition || !season) return error(400, "name, competition and season are required")

  const pool = await getPool()
  const leagueId = uuidv4()
  const inviteCode = "PRZE-" + Math.random().toString(36).toUpperCase().slice(2, 6)

  await pool.query(
    `INSERT INTO leagues (id, name, competition, season, creator_id, max_teams, entry_fee, missed_week_rule, league_format, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'ACTIVE')`,
    [leagueId, name, competition, season, user.userId, max_teams || 12, entry_fee || 0,
     missed_week_rule || "RANDOM", league_format || "STANDINGS"]
  )
  await pool.query(
    "INSERT INTO invites (id, league_id, code) VALUES ($1, $2, $3)",
    [uuidv4(), leagueId, inviteCode]
  )
  await pool.query(
    "INSERT INTO league_members (id, league_id, user_id, payment_status) VALUES ($1, $2, $3, 'FREE')",
    [uuidv4(), leagueId, user.userId]
  )
  await pool.query(
    "INSERT INTO standings (id, league_id, user_id) VALUES ($1, $2, $3)",
    [uuidv4(), leagueId, user.userId]
  )

  return ok({ leagueId, inviteCode }, 201)
}

async function getLeague(event, user) {
  const { id } = event.pathParameters
  const pool = await getPool()

  const league = await pool.query(
    `SELECT l.*, i.code AS invite_code,
            (SELECT COUNT(*) FROM league_members lm WHERE lm.league_id = l.id) AS member_count
     FROM leagues l
     LEFT JOIN invites i ON i.league_id = l.id
     WHERE l.id = $1`,
    [id]
  )
  if (league.rows.length === 0) return error(404, "League not found")

  const standings = await pool.query(
    `SELECT u.display_name, u.avatar_url, s.*
     FROM standings s JOIN users u ON u.id = s.user_id
     WHERE s.league_id = $1 ORDER BY s.points DESC, s.total_energy_used ASC`,
    [id]
  )

  const nextMatchup = await pool.query(
    `SELECT m.* FROM matchups m
     JOIN gameweeks g ON g.id = m.gameweek_id
     WHERE g.league_id = $1 AND (m.home_user_id = $2 OR m.away_user_id = $2) AND m.status = 'PENDING'
     ORDER BY g.lock_time ASC LIMIT 1`,
    [id, user.userId]
  )

  return ok({ ...league.rows[0], standings: standings.rows, nextMatchup: nextMatchup.rows[0] || null })
}

async function updateLeague(event, user) {
  const { id } = event.pathParameters
  const body = JSON.parse(event.body || "{}")
  const pool = await getPool()

  const league = await pool.query("SELECT creator_id FROM leagues WHERE id = $1", [id])
  if (league.rows.length === 0) return error(404, "League not found")
  if (league.rows[0].creator_id !== user.userId) return error(403, "Only the creator can update this league")

  const { name, missed_week_rule } = body
  await pool.query(
    "UPDATE leagues SET name = COALESCE($1, name), missed_week_rule = COALESCE($2, missed_week_rule) WHERE id = $3",
    [name || null, missed_week_rule || null, id]
  )
  return ok({ updated: true })
}

async function joinLeague(event, user) {
  const { code } = event.pathParameters
  const pool = await getPool()

  const invite = await pool.query(
    "SELECT i.league_id, l.max_teams FROM invites i JOIN leagues l ON l.id = i.league_id WHERE i.code = $1",
    [code.toUpperCase()]
  )
  if (invite.rows.length === 0) return error(404, "Invalid invite code")

  const { league_id, max_teams } = invite.rows[0]

  const memberCount = await pool.query(
    "SELECT COUNT(*) AS count FROM league_members WHERE league_id = $1",
    [league_id]
  )
  if (parseInt(memberCount.rows[0].count) >= max_teams) return error(409, "League is full")

  const existing = await pool.query(
    "SELECT id FROM league_members WHERE league_id = $1 AND user_id = $2",
    [league_id, user.userId]
  )
  if (existing.rows.length > 0) return error(409, "Already a member of this league")

  await pool.query(
    "INSERT INTO league_members (id, league_id, user_id, payment_status) VALUES ($1, $2, $3, 'FREE')",
    [uuidv4(), league_id, user.userId]
  )
  await pool.query(
    "INSERT INTO standings (id, league_id, user_id) VALUES ($1, $2, $3)",
    [uuidv4(), league_id, user.userId]
  )

  return ok({ leagueId: league_id, joined: true })
}

async function getStandings(event, user) {
  const { id } = event.pathParameters
  const pool = await getPool()

  const result = await pool.query(
    `SELECT u.display_name, u.avatar_url, s.wins, s.losses, s.draws, s.points, s.total_energy_used,
            ROW_NUMBER() OVER (ORDER BY s.points DESC, s.total_energy_used ASC) AS position
     FROM standings s JOIN users u ON u.id = s.user_id
     WHERE s.league_id = $1
     ORDER BY s.points DESC, s.total_energy_used ASC`,
    [id]
  )
  return ok(result.rows)
}
