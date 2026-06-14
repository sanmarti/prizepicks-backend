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
    if (routeKey === "GET /matchups/{id}") return await getMatchup(event, user)
    return error(404, "Not found")
  } catch (err) {
    console.error(err)
    return error(500, "Internal server error")
  }
}

function pickStatusToProjected(pickStatus, energyCost) {
  switch (pickStatus) {
    case "SLEEPING": return energyCost / 10
    case "LIVE_FAVORABLE": return 0.75
    case "LIVE_NEUTRAL": return 0.50
    case "LIVE_RISK": return 0.25
    case "WON": return 1.0
    case "LOST": return 0.0
    default: return 0.0
  }
}

function calcOutlook(diff) {
  if (diff >= 2.0) return "Strong lead"
  if (diff >= 1.0) return "Leading"
  if (diff >= 0.25) return "Slight edge"
  if (diff > -0.25) return "Too close to call"
  if (diff > -1.0) return "Slightly behind"
  if (diff > -2.0) return "Behind"
  return "Needs comeback"
}

async function getMatchup(event, user) {
  const { id } = event.pathParameters
  const pool = await getPool()

  const matchupResult = await pool.query(
    `SELECT m.*,
            hu.display_name AS home_display_name, hu.avatar_url AS home_avatar,
            au.display_name AS away_display_name, au.avatar_url AS away_avatar
     FROM matchups m
     JOIN users hu ON hu.id = m.home_user_id
     JOIN users au ON au.id = m.away_user_id
     WHERE m.id = $1`,
    [id]
  )
  if (matchupResult.rows.length === 0) return error(404, "Matchup not found")

  const matchup = matchupResult.rows[0]

  if (matchup.home_user_id !== user.userId && matchup.away_user_id !== user.userId) {
    return error(403, "Forbidden")
  }

  const homePicks = await pool.query(
    `SELECT cp.pick_status, cp.energy_cost_final
     FROM user_cards uc
     JOIN card_picks cp ON cp.card_id = uc.id
     WHERE uc.gameweek_id = $1 AND uc.user_id = $2`,
    [matchup.gameweek_id, matchup.home_user_id]
  )

  const awayPicks = await pool.query(
    `SELECT cp.pick_status, cp.energy_cost_final
     FROM user_cards uc
     JOIN card_picks cp ON cp.card_id = uc.id
     WHERE uc.gameweek_id = $1 AND uc.user_id = $2`,
    [matchup.gameweek_id, matchup.away_user_id]
  )

  const homeProjected = homePicks.rows.reduce(
    (sum, p) => sum + pickStatusToProjected(p.pick_status, p.energy_cost_final), 0
  )
  const awayProjected = awayPicks.rows.reduce(
    (sum, p) => sum + pickStatusToProjected(p.pick_status, p.energy_cost_final), 0
  )

  const diff = homeProjected - awayProjected
  const outlook = calcOutlook(
    matchup.home_user_id === user.userId ? diff : -diff
  )

  return ok({
    ...matchup,
    homeProjectedScore: Math.round(homeProjected * 100) / 100,
    awayProjectedScore: Math.round(awayProjected * 100) / 100,
    outlook,
    homePicks: homePicks.rows,
    awayPicks: awayPicks.rows
  })
}
