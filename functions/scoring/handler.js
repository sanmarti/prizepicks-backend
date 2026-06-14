const axios = require("axios")
const { v4: uuidv4 } = require("uuid")
const { getPool } = require("../../shared/db")
const { getSecrets } = require("../../shared/ssm")
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

  if (user.role !== "admin") return error(403, "Admin only")

  try {
    if (routeKey === "POST /scoring/resolve") return await resolve(event, user)
    return error(404, "Not found")
  } catch (err) {
    console.error(err)
    return error(500, "Internal server error")
  }
}

async function resolve(event, user) {
  const { gameweek_id } = JSON.parse(event.body || "{}")
  if (!gameweek_id) return error(400, "gameweek_id is required")

  const pool = await getPool()
  const secrets = await getSecrets()

  const gwResult = await pool.query("SELECT id FROM gameweeks WHERE id = $1 AND status = 'LOCKED'", [gameweek_id])
  if (gwResult.rows.length === 0) return error(404, "Gameweek not found or not in LOCKED status")

  const eventsResult = await pool.query(
    "SELECT id, event_type, fixture_id, player_name FROM events WHERE gameweek_id = $1",
    [gameweek_id]
  )

  for (const ev of eventsResult.rows) {
    let fixtureData = null
    try {
      const res = await axios.get(`https://v3.football.api-sports.io/fixtures`, {
        params: { id: ev.fixture_id },
        headers: { "x-apisports-key": secrets.key }
      })
      fixtureData = res.data?.response?.[0]
    } catch (e) {
      console.error(`Failed to fetch fixture ${ev.fixture_id}:`, e.message)
      continue
    }

    if (!fixtureData) continue

    const homeGoals = fixtureData.goals?.home ?? 0
    const awayGoals = fixtureData.goals?.away ?? 0
    const totalGoals = homeGoals + awayGoals
    const fixtureEvents = fixtureData.events || []

    const options = await pool.query(
      "SELECT id, label FROM event_options WHERE event_id = $1",
      [ev.id]
    )

    for (const opt of options.rows) {
      let result = "LOST"
      const label = opt.label.toLowerCase()

      if (ev.event_type === "MATCH_RESULT") {
        if (label === "home win" && homeGoals > awayGoals) result = "WON"
        else if (label === "away win" && awayGoals > homeGoals) result = "WON"
        else if (label === "draw" && homeGoals === awayGoals) result = "WON"
      } else if (ev.event_type === "GOALS") {
        const match = label.match(/(over|under)\s+([\d.]+)/)
        if (match) {
          const direction = match[1]
          const threshold = parseFloat(match[2])
          if (direction === "over" && totalGoals > threshold) result = "WON"
          if (direction === "under" && totalGoals < threshold) result = "WON"
        }
      } else if (ev.event_type === "PLAYER_SCORE") {
        const scored = fixtureEvents.some(
          fe => fe.type === "Goal" && fe.player?.name?.toLowerCase().includes(ev.player_name?.toLowerCase())
        )
        if (scored) result = "WON"
      } else if (ev.event_type === "CLEAN_SHEET") {
        if (label.includes("home") && awayGoals === 0) result = "WON"
        if (label.includes("away") && homeGoals === 0) result = "WON"
      }

      await pool.query("UPDATE event_options SET result = $1 WHERE id = $2", [result, opt.id])
    }
  }

  const cardPicks = await pool.query(
    `SELECT cp.id AS pick_id, cp.card_id, eo.result AS option_result
     FROM card_picks cp
     JOIN event_options eo ON eo.id = cp.event_option_id
     JOIN user_cards uc ON uc.id = cp.card_id
     WHERE uc.gameweek_id = $1`,
    [gameweek_id]
  )

  const cardScores = {}
  for (const cp of cardPicks.rows) {
    const pickStatus = cp.option_result === "WON" ? "WON" : "LOST"
    await pool.query("UPDATE card_picks SET pick_status = $1 WHERE id = $2", [pickStatus, cp.pick_id])
    if (!cardScores[cp.card_id]) cardScores[cp.card_id] = 0
    if (pickStatus === "WON") cardScores[cp.card_id]++
  }

  for (const [cardId, score] of Object.entries(cardScores)) {
    await pool.query("UPDATE user_cards SET final_score = $1, status = 'LOCKED' WHERE id = $2", [score, cardId])
  }

  const matchups = await pool.query(
    "SELECT * FROM matchups WHERE gameweek_id = $1 AND status != 'FINISHED'",
    [gameweek_id]
  )

  for (const matchup of matchups.rows) {
    const homeCard = await pool.query(
      "SELECT id, final_score, total_energy_used FROM user_cards WHERE gameweek_id = $1 AND user_id = $2",
      [gameweek_id, matchup.home_user_id]
    )
    const awayCard = await pool.query(
      "SELECT id, final_score, total_energy_used FROM user_cards WHERE gameweek_id = $1 AND user_id = $2",
      [gameweek_id, matchup.away_user_id]
    )

    const homeScore = homeCard.rows[0]?.final_score || 0
    const awayScore = awayCard.rows[0]?.final_score || 0
    const homeEnergy = homeCard.rows[0]?.total_energy_used || 0
    const awayEnergy = awayCard.rows[0]?.total_energy_used || 0

    let winnerId = null
    let homePoints = 0, awayPoints = 0

    if (homeScore > awayScore) {
      winnerId = matchup.home_user_id
      homePoints = 3
    } else if (awayScore > homeScore) {
      winnerId = matchup.away_user_id
      awayPoints = 3
    } else {
      if (homeEnergy < awayEnergy) {
        winnerId = matchup.home_user_id
        homePoints = 3
      } else if (awayEnergy < homeEnergy) {
        winnerId = matchup.away_user_id
        awayPoints = 3
      } else {
        homePoints = 1
        awayPoints = 1
      }
    }

    await pool.query(
      `UPDATE matchups SET winner_user_id = $1, home_score = $2, away_score = $3, status = 'FINISHED' WHERE id = $4`,
      [winnerId, homeScore, awayScore, matchup.id]
    )

    const homeResult = homePoints === 3 ? "wins" : homePoints === 1 ? "draws" : "losses"
    const awayResult = awayPoints === 3 ? "wins" : awayPoints === 1 ? "draws" : "losses"

    await pool.query(
      `UPDATE standings SET ${homeResult} = ${homeResult} + 1, points = points + $1, total_energy_used = total_energy_used + $2
       WHERE league_id = (SELECT league_id FROM gameweeks WHERE id = $3) AND user_id = $4`,
      [homePoints, homeEnergy, gameweek_id, matchup.home_user_id]
    )
    await pool.query(
      `UPDATE standings SET ${awayResult} = ${awayResult} + 1, points = points + $1, total_energy_used = total_energy_used + $2
       WHERE league_id = (SELECT league_id FROM gameweeks WHERE id = $3) AND user_id = $4`,
      [awayPoints, awayEnergy, gameweek_id, matchup.away_user_id]
    )

    if (winnerId) {
      await pool.query("UPDATE energy_wallets SET balance = balance + 1 WHERE user_id = $1", [winnerId])
      await pool.query(
        `INSERT INTO energy_transactions (id, user_id, amount, type, description, created_at)
         VALUES ($1, $2, 1, 'REWARD', $3, NOW())`,
        [uuidv4(), winnerId, `Matchup win reward - gameweek ${gameweek_id}`]
      )
    }
  }

  await pool.query("UPDATE gameweeks SET status = 'FINISHED' WHERE id = $1", [gameweek_id])

  return ok({ resolved: true, gameweek_id })
}
