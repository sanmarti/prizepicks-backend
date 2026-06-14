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
    if (routeKey === "GET /gameweeks") return await listGameweeks(event, user)
    if (routeKey === "GET /gameweeks/{id}") return await getGameweek(event, user)
    return error(404, "Not found")
  } catch (err) {
    console.error(err)
    return error(500, "Internal server error")
  }
}

async function listGameweeks(event, user) {
  const pool = await getPool()
  const result = await pool.query(
    `SELECT g.id, g.week_number, g.competition, g.lock_time, g.reveal_time, g.status, g.league_id,
            l.name AS league_name,
            uc.status AS user_card_status,
            uc.final_score
     FROM gameweeks g
     JOIN leagues l ON l.id = g.league_id
     JOIN league_members lm ON lm.league_id = g.league_id AND lm.user_id = $1
     LEFT JOIN user_cards uc ON uc.gameweek_id = g.id AND uc.user_id = $1
     WHERE g.status = 'PUBLISHED'
     ORDER BY g.lock_time ASC`,
    [user.userId]
  )
  return ok(result.rows)
}

async function getGameweek(event, user) {
  const { id } = event.pathParameters
  const pool = await getPool()

  const gw = await pool.query(
    `SELECT g.*, l.name AS league_name
     FROM gameweeks g
     JOIN leagues l ON l.id = g.league_id
     JOIN league_members lm ON lm.league_id = g.league_id AND lm.user_id = $1
     WHERE g.id = $2`,
    [user.userId, id]
  )
  if (gw.rows.length === 0) return error(404, "Gameweek not found")

  const events = await pool.query(
    `SELECT e.id, e.event_type, e.fixture_id, e.fixture_name, e.player_name,
            e.competition, e.match_time, e.status,
            json_agg(
              json_build_object(
                'id', eo.id,
                'label', eo.label,
                'energy_cost', eo.energy_cost,
                'result', eo.result
              ) ORDER BY eo.energy_cost ASC
            ) AS options
     FROM events e
     JOIN event_options eo ON eo.event_id = e.id
     WHERE e.gameweek_id = $1
     GROUP BY e.id
     ORDER BY e.match_time ASC`,
    [id]
  )

  return ok({ ...gw.rows[0], events: events.rows })
}
