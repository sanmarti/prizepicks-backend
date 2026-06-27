const { v4: uuidv4 } = require("uuid")
const { getPool } = require("../../shared/db")
const { verifyToken, extractFromEvent } = require("../../shared/auth")
const { ok, error, unauthorized } = require("../../shared/response")

// ── Player name fuzzy matching ────────────────────────────────────────────────
function normalizeStr(s) {
  return (s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')  // strip diacritics (é→e, ü→u)
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function lastName(s) {
  const parts = normalizeStr(s).split(' ')
  // Skip single-letter initials (e.g. "h. " → skip "h")
  const words = parts.filter(p => p.length > 1)
  return words[words.length - 1] || ''
}

function levenshtein(a, b) {
  const m = a.length, n = b.length
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0)
  )
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1])
  return dp[m][n]
}

function playerNameMatches(adminName, apiName) {
  const na = normalizeStr(adminName)
  const nb = normalizeStr(apiName)
  if (!na || !nb) return false

  // 1. Exact normalized match
  if (na === nb) return true

  // 2. Contains check — handles "Haaland" matching "E. Haaland" or "Erling Haaland"
  if (nb.includes(na) || na.includes(nb)) return true

  // 3. Last-name match — handles "Mbappe" ↔ "K. Mbappe" or "Kylian Mbappe"
  const la = lastName(na), lb = lastName(nb)
  if (la.length >= 3 && la === lb) return true

  // 4. Fuzzy last-name match (1 edit distance) — covers minor typos
  if (la.length >= 4 && lb.length >= 4 && levenshtein(la, lb) <= 1) return true

  // 5. Fuzzy full-name match (2 edit distance) — covers "Ronaldo" ↔ "Ronaldc" etc.
  if (na.length >= 5 && nb.length >= 5 && levenshtein(na, nb) <= 2) return true

  return false
}

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

// Determines WON/LOST for a single event option using the cached fixture row
// and the structured result_key (falls back to label-based matching for legacy rows).
function evaluateOption(resultKey, label, eventType, fixture, cornerTotal) {
  const rk = resultKey || ''
  const lb = (label || '').toLowerCase()

  if (eventType === 'MATCH_RESULT') {
    const h = fixture.home_goals ?? 0, a = fixture.away_goals ?? 0
    if (rk === 'HOME_WIN'  || lb === 'home win')  return h > a ? 'WON' : 'LOST'
    if (rk === 'AWAY_WIN'  || lb === 'away win')  return a > h ? 'WON' : 'LOST'
    if (rk === 'DRAW'      || lb === 'draw')       return h === a ? 'WON' : 'LOST'
  }

  if (eventType === 'GOALS') {
    const total = (fixture.home_goals ?? 0) + (fixture.away_goals ?? 0)
    // result_key format: OVER_2.5 / UNDER_2.5
    const rkMatch = rk.match(/^(OVER|UNDER)_([\d.]+)$/)
    if (rkMatch) {
      const threshold = parseFloat(rkMatch[2])
      return rkMatch[1] === 'OVER' ? (total > threshold ? 'WON' : 'LOST')
                                   : (total < threshold ? 'WON' : 'LOST')
    }
    // Legacy label fallback
    const lbMatch = lb.match(/(over|under)\s+([\d.]+)/)
    if (lbMatch) {
      const threshold = parseFloat(lbMatch[2])
      return lbMatch[1] === 'over' ? (total > threshold ? 'WON' : 'LOST')
                                   : (total < threshold ? 'WON' : 'LOST')
    }
  }

  if (eventType === 'BTTS') {
    const h = fixture.home_goals ?? 0, a = fixture.away_goals ?? 0
    const bothScored = h > 0 && a > 0
    if (rk === 'BTTS_YES' || lb.includes('yes') || lb.includes('both')) return bothScored ? 'WON' : 'LOST'
    if (rk === 'BTTS_NO'  || lb.includes('no'))                          return bothScored ? 'LOST' : 'WON'
  }

  if (eventType === 'CLEAN_SHEET') {
    const h = fixture.home_goals ?? 0, a = fixture.away_goals ?? 0
    if (rk === 'HOME_CLEAN_SHEET' || lb.includes('home')) return a === 0 ? 'WON' : 'LOST'
    if (rk === 'AWAY_CLEAN_SHEET' || lb.includes('away')) return h === 0 ? 'WON' : 'LOST'
  }

  if (eventType === 'CORNER_OVER') {
    const total = cornerTotal ?? 0
    const rkMatch = rk.match(/^CORNER_(OVER|UNDER)_([\d.]+)$/)
    if (rkMatch) {
      const threshold = parseFloat(rkMatch[2])
      return rkMatch[1] === 'OVER' ? (total > threshold ? 'WON' : 'LOST')
                                   : (total < threshold ? 'WON' : 'LOST')
    }
    // Legacy label fallback
    const lbMatch = lb.match(/(over|under)\s+([\d.]+)/)
    if (lbMatch) {
      const threshold = parseFloat(lbMatch[2])
      return lbMatch[1] === 'over' ? (total > threshold ? 'WON' : 'LOST')
                                   : (total < threshold ? 'WON' : 'LOST')
    }
  }

  if (eventType === 'PLAYER_SCORE') {
    // Resolved separately via fixture_events table — handled in resolve()
    return null
  }

  return 'LOST'
}

async function resolve(event, user) {
  const { gameweek_id } = JSON.parse(event.body || "{}")
  if (!gameweek_id) return error(400, "gameweek_id is required")

  const pool = await getPool()

  const gwResult = await pool.query(
    "SELECT id FROM gameweeks WHERE id = $1 AND status = 'LOCKED'",
    [gameweek_id]
  )
  if (gwResult.rows.length === 0) return error(404, "Gameweek not found or not in LOCKED status")

  const eventsResult = await pool.query(
    "SELECT id, event_type, fixture_id, player_name FROM events WHERE gameweek_id = $1",
    [gameweek_id]
  )

  for (const ev of eventsResult.rows) {
    // Read fixture result from our DB (no live API call)
    const fixtureRow = ev.fixture_id
      ? (await pool.query(
          "SELECT home_goals, away_goals, status_short FROM fixtures WHERE id = $1",
          [ev.fixture_id]
        )).rows[0]
      : null

    if (!fixtureRow) {
      console.warn(`No cached fixture for event ${ev.id} fixture_id=${ev.fixture_id}`)
      continue
    }

    // Only settle finished fixtures
    const doneStatuses = ['FT', 'AET', 'PEN', 'AWD', 'WO']
    if (!doneStatuses.includes(fixtureRow.status_short)) {
      console.log(`Fixture ${ev.fixture_id} not finished yet (${fixtureRow.status_short}), skipping`)
      continue
    }

    // For CORNER_OVER — fetch corner total from fixture_statistics
    let cornerTotal = null
    if (ev.event_type === 'CORNER_OVER') {
      const cs = await pool.query(
        `SELECT COALESCE(SUM(stat_value::int), 0) AS total
         FROM fixture_statistics
         WHERE fixture_id = $1 AND stat_type = 'Corner Kicks'`,
        [ev.fixture_id]
      )
      cornerTotal = cs.rows[0]?.total ?? 0
    }

    // For PLAYER_SCORE — fetch goal scorers from fixture_events (column is `player`, type is `type`)
    let scorers = []
    if (ev.event_type === 'PLAYER_SCORE' && ev.player_name) {
      const pe = await pool.query(
        `SELECT player FROM fixture_events
         WHERE fixture_id = $1
           AND type = 'Goal'
           AND (detail IS NULL OR detail NOT ILIKE '%own goal%')`,
        [ev.fixture_id]
      )
      scorers = pe.rows.map(r => r.player || '')
      console.log(`PLAYER_SCORE event ${ev.id} — player_name="${ev.player_name}" scorers=[${scorers.join(', ')}]`)
    }

    const options = await pool.query(
      "SELECT id, label, result_key FROM event_options WHERE event_id = $1",
      [ev.id]
    )

    for (const opt of options.rows) {
      let result

      if (ev.event_type === 'PLAYER_SCORE') {
        const rk = opt.result_key || ''
        const lb = (opt.label || '').toLowerCase()
        const scored = scorers.some(s => playerNameMatches(ev.player_name, s))
        console.log(`  → opt="${opt.label}" rk="${rk}" scored=${scored}`)
        if (rk === 'PLAYER_SCORES' || lb.includes('scores') || lb === 'yes') {
          result = scored ? 'WON' : 'LOST'
        } else {
          result = scored ? 'LOST' : 'WON'
        }
      } else {
        result = evaluateOption(opt.result_key, opt.label, ev.event_type, fixtureRow, cornerTotal)
        if (result === null) result = 'LOST'
      }

      await pool.query("UPDATE event_options SET result = $1 WHERE id = $2", [result, opt.id])
    }
  }

  // Score user picks
  const userPicks = await pool.query(
    `SELECT up.id AS pick_id, up.user_id,
            eo.result AS option_result
     FROM user_picks up
     JOIN event_options eo ON eo.id = up.event_option_id
     JOIN events e ON e.id = up.event_id
     WHERE e.gameweek_id = $1`,
    [gameweek_id]
  )

  const userScores = {}
  for (const pick of userPicks.rows) {
    const pickStatus = pick.option_result === 'WON' ? 'WON' : 'LOST'
    await pool.query("UPDATE user_picks SET pick_status = $1 WHERE id = $2", [pickStatus, pick.pick_id])
    if (!userScores[pick.user_id]) userScores[pick.user_id] = 0
    if (pickStatus === 'WON') userScores[pick.user_id]++
  }

  // Also update the old card_picks flow if it exists
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
    const pickStatus = cp.option_result === 'WON' ? 'WON' : 'LOST'
    await pool.query("UPDATE card_picks SET pick_status = $1 WHERE id = $2", [pickStatus, cp.pick_id])
    if (!cardScores[cp.card_id]) cardScores[cp.card_id] = 0
    if (pickStatus === 'WON') cardScores[cp.card_id]++
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

    const homeScore  = homeCard.rows[0]?.final_score || 0
    const awayScore  = awayCard.rows[0]?.final_score || 0
    const homeEnergy = homeCard.rows[0]?.total_energy_used || 0
    const awayEnergy = awayCard.rows[0]?.total_energy_used || 0

    let winnerId = null, homePoints = 0, awayPoints = 0

    if (homeScore > awayScore) {
      winnerId = matchup.home_user_id; homePoints = 3
    } else if (awayScore > homeScore) {
      winnerId = matchup.away_user_id; awayPoints = 3
    } else {
      if (homeEnergy < awayEnergy)      { winnerId = matchup.home_user_id; homePoints = 3 }
      else if (awayEnergy < homeEnergy) { winnerId = matchup.away_user_id; awayPoints = 3 }
      else                              { homePoints = 1; awayPoints = 1 }
    }

    await pool.query(
      "UPDATE matchups SET winner_user_id=$1, home_score=$2, away_score=$3, status='FINISHED' WHERE id=$4",
      [winnerId, homeScore, awayScore, matchup.id]
    )

    const hRes = homePoints === 3 ? 'wins' : homePoints === 1 ? 'draws' : 'losses'
    const aRes = awayPoints === 3 ? 'wins' : awayPoints === 1 ? 'draws' : 'losses'

    await pool.query(
      `UPDATE standings SET ${hRes}=${hRes}+1, points=points+$1, total_energy_used=total_energy_used+$2
       WHERE league_id=(SELECT league_id FROM gameweeks WHERE id=$3) AND user_id=$4`,
      [homePoints, homeEnergy, gameweek_id, matchup.home_user_id]
    )
    await pool.query(
      `UPDATE standings SET ${aRes}=${aRes}+1, points=points+$1, total_energy_used=total_energy_used+$2
       WHERE league_id=(SELECT league_id FROM gameweeks WHERE id=$3) AND user_id=$4`,
      [awayPoints, awayEnergy, gameweek_id, matchup.away_user_id]
    )

    if (winnerId) {
      await pool.query("UPDATE energy_wallets SET balance = balance + 1 WHERE user_id = $1", [winnerId])
      await pool.query(
        "INSERT INTO energy_transactions (id, user_id, amount, type, description, created_at) VALUES ($1,$2,1,'REWARD',$3,NOW())",
        [uuidv4(), winnerId, `Matchup win reward - gameweek ${gameweek_id}`]
      )
    }
  }

  await pool.query("UPDATE gameweeks SET status = 'FINISHED' WHERE id = $1", [gameweek_id])

  return ok({ resolved: true, gameweek_id })
}
