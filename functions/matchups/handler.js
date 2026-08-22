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

  const isParticipant = matchup.home_user_id === user.userId || matchup.away_user_id === user.userId

  // Non-participants can view if they're a member of the same league
  if (!isParticipant) {
    if (!matchup.league_id) return error(403, "Forbidden")
    const mem = await pool.query(
      "SELECT id FROM private_league_members WHERE league_id=$1 AND user_id=$2",
      [matchup.league_id, user.userId]
    )
    if (!mem.rows.length) return error(403, "Forbidden")
  }

  if (!matchup.gameweek_id) return ok({ ...matchup, homePicks: [], awayPicks: [], isParticipant })

  // Only reveal picks once the gameweek is locked/settled — spectators can't see picks while open
  const gwRes = await pool.query("SELECT status FROM gameweeks WHERE id=$1", [matchup.gameweek_id])
  const gwStatus = gwRes.rows[0]?.status ?? 'DRAFT'
  const picksVisible = isParticipant || ['LOCKED','FINISHED','SETTLED'].includes(gwStatus)

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
    picksVisible ? pool.query(picksQuery, [matchup.home_user_id, matchup.gameweek_id]) : { rows: [] },
    picksVisible ? pool.query(picksQuery, [matchup.away_user_id, matchup.gameweek_id]) : { rows: [] },
  ])

  const homeCorrect = homePicks.rows.filter(p => p.pick_status === 'won').length
  const awayCorrect = awayPicks.rows.filter(p => p.pick_status === 'won').length

  const isHome = matchup.home_user_id === user.userId
  const myCorrect    = isHome ? homeCorrect : awayCorrect
  const rivalCorrect = isHome ? awayCorrect : homeCorrect
  const outlook = myCorrect > rivalCorrect ? 'Winning' : myCorrect < rivalCorrect ? 'Losing' : 'Drawing'

  return ok({
    ...matchup,
    isParticipant,
    picksVisible,
    gwStatus,
    homeCorrect,
    awayCorrect,
    outlook,
    homePicks: homePicks.rows,
    awayPicks: awayPicks.rows,
  })
}
