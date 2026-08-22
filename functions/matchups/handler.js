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

async function getMatchup(event, user) {
  const { id } = event.pathParameters
  const pool = await getPool()

  const { rows: [matchup] } = await pool.query(`
    SELECT m.*,
      hu.display_name AS home_display_name, hu.avatar_url AS home_avatar,
      au.display_name AS away_display_name, au.avatar_url AS away_avatar
    FROM matchups m
    JOIN users hu ON hu.id = m.home_user_id
    JOIN users au ON au.id = m.away_user_id
    WHERE m.id = $1
  `, [id])
  if (!matchup) return error(404, "Matchup not found")

  if (matchup.home_user_id !== user.userId && matchup.away_user_id !== user.userId) {
    return error(403, "Forbidden")
  }

  if (!matchup.gameweek_id) return ok({ ...matchup, homePicks: [], awayPicks: [] })

  const picksQuery = `
    SELECT up.event_id, up.event_option_id, up.pick_status,
           eo.label AS pick_label,
           e.fixture_name, e.event_type, e.match_time, e.competition
    FROM user_picks up
    JOIN event_options eo ON eo.id = up.event_option_id
    JOIN events e ON e.id = up.event_id
    WHERE up.user_id = $1 AND up.gameweek_id = $2
    ORDER BY e.match_time ASC
  `
  const [homePicks, awayPicks] = await Promise.all([
    pool.query(picksQuery, [matchup.home_user_id, matchup.gameweek_id]),
    pool.query(picksQuery, [matchup.away_user_id, matchup.gameweek_id]),
  ])

  const homeCorrect = homePicks.rows.filter(p => p.pick_status === 'won').length
  const awayCorrect = awayPicks.rows.filter(p => p.pick_status === 'won').length

  const isHome = matchup.home_user_id === user.userId
  const myCorrect    = isHome ? homeCorrect : awayCorrect
  const rivalCorrect = isHome ? awayCorrect : homeCorrect
  const outlook = myCorrect > rivalCorrect ? 'Winning' : myCorrect < rivalCorrect ? 'Losing' : 'Drawing'

  return ok({
    ...matchup,
    homeCorrect,
    awayCorrect,
    outlook,
    homePicks: homePicks.rows,
    awayPicks: awayPicks.rows,
  })
}
