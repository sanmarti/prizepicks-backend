const { getPool } = require('../../shared/db')
const { ok, error } = require('../../shared/response')
const { v4: uuidv4 } = require('uuid')

async function listPrivateLeagues() {
  const pool = await getPool()
  const { rows } = await pool.query(`
    SELECT
      l.id, l.name, l.invite_code, l.image_url, l.entry_fee_euros, l.created_at, l.updated_at,
      l.status, l.current_week, l.total_weeks, l.season_name,
      u.display_name AS created_by_name,
      (SELECT COUNT(*) FROM private_league_members WHERE league_id = l.id) AS member_count,
      (SELECT COUNT(*) FROM private_league_members WHERE league_id = l.id AND has_paid = TRUE) AS paid_count
    FROM private_leagues l
    LEFT JOIN users u ON u.id = l.created_by
    ORDER BY l.created_at DESC
  `)
  return ok(rows)
}

async function getPrivateLeague(event) {
  const { id } = event.pathParameters
  const pool = await getPool()

  const { rows: [league] } = await pool.query(`
    SELECT l.*, u.display_name AS created_by_name
    FROM private_leagues l
    LEFT JOIN users u ON u.id = l.created_by
    WHERE l.id = $1
  `, [id])
  if (!league) return error(404, 'League not found')

  const { rows: members } = await pool.query(`
    SELECT m.user_id, m.role, m.has_paid, m.joined_at,
           m.league_points, m.wins, m.draws, m.losses, m.goals_for, m.goals_against, m.played,
           u.display_name, u.avatar_url, u.email
    FROM private_league_members m
    JOIN users u ON u.id = m.user_id
    WHERE m.league_id = $1
    ORDER BY m.league_points DESC, m.role DESC, m.joined_at ASC
  `, [id])

  const { rows: standings } = await pool.query(`
    SELECT
      u.id AS user_id, u.display_name, u.avatar_url, m.has_paid,
      m.league_points, m.wins, m.draws, m.losses, m.goals_for, m.goals_against, m.played,
      (m.goals_for - m.goals_against) AS goal_diff,
      ROW_NUMBER() OVER (
        ORDER BY m.league_points DESC,
                 (m.goals_for - m.goals_against) DESC,
                 m.goals_for DESC,
                 u.display_name ASC
      ) AS position
    FROM private_league_members m
    JOIN users u ON u.id = m.user_id
    WHERE m.league_id = $1
    ORDER BY position
  `, [id])

  // Calendar summary
  const { rows: calendar } = await pool.query(`
    SELECT m.league_week, m.status, m.gameweek_id,
           m.home_user_id, hu.display_name AS home_name,
           m.away_user_id, au.display_name AS away_name,
           m.home_score, m.away_score, m.home_league_points, m.away_league_points
    FROM matchups m
    JOIN users hu ON hu.id = m.home_user_id
    JOIN users au ON au.id = m.away_user_id
    WHERE m.league_id = $1
    ORDER BY m.league_week ASC
  `, [id])

  return ok({ ...league, members, standings, calendar })
}

async function updatePrivateLeague(event) {
  const { id } = event.pathParameters
  const body = JSON.parse(event.body || '{}')
  const pool = await getPool()

  const { name, image_url, entry_fee_euros, invite_code, season_name } = body
  await pool.query(`
    UPDATE private_leagues
    SET name         = COALESCE($1, name),
        image_url    = COALESCE($2, image_url),
        entry_fee_euros = COALESCE($3, entry_fee_euros),
        invite_code  = COALESCE($4, invite_code),
        season_name  = COALESCE($5, season_name),
        updated_at   = NOW()
    WHERE id = $6
  `, [name || null, image_url || null, entry_fee_euros ?? null, invite_code || null, season_name || null, id])

  return ok({ updated: true })
}

async function adminCreatePeriod(event) {
  const { id } = event.pathParameters
  const body = JSON.parse(event.body || '{}')
  const { name, start_matchweek_id, end_matchweek_id, prize_config } = body
  if (!name?.trim()) return error(400, 'name is required')

  const pool = await getPool()
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

async function adminUpdatePeriodPrizes(event) {
  const { id, periodId } = event.pathParameters
  const body = JSON.parse(event.body || '{}')
  const prizes = Array.isArray(body.prizes) ? body.prizes : []
  const pool = await getPool()

  const { rowCount } = await pool.query(`
    UPDATE private_league_periods SET prize_config = $1 WHERE id = $2 AND league_id = $3
  `, [JSON.stringify(prizes), periodId, id])

  if (rowCount === 0) return error(404, 'Period not found')
  return ok({ updated: true })
}

async function adminTogglePayment(event) {
  const { id, userId } = event.pathParameters
  const body = JSON.parse(event.body || '{}')
  const pool = await getPool()

  await pool.query(`
    UPDATE private_league_members SET has_paid = $1 WHERE league_id = $2 AND user_id = $3
  `, [!!body.has_paid, id, userId])

  return ok({ updated: true })
}

// ── Generate H2H double round-robin calendar ──────────────────────────────────
async function generateLeagueCalendar(event) {
  const { id } = event.pathParameters
  const pool = await getPool()

  const { rows: memberRows } = await pool.query(`
    SELECT user_id FROM private_league_members WHERE league_id = $1 ORDER BY joined_at ASC
  `, [id])

  if (memberRows.length < 4) return error(400, 'At least 4 members required to generate a calendar')

  // Delete any existing SCHEDULED matchups for this league (allow regeneration)
  await pool.query(`DELETE FROM matchups WHERE league_id = $1 AND status = 'SCHEDULED'`, [id])

  const players = memberRows.map(r => r.user_id)
  const rounds  = generateRoundRobin(players)
  const totalWeeks = rounds.length
  let matchupCount = 0

  for (let weekIdx = 0; weekIdx < rounds.length; weekIdx++) {
    const weekNumber = weekIdx + 1
    for (const { home, away } of rounds[weekIdx]) {
      await pool.query(`
        INSERT INTO matchups (id, league_id, league_week, home_user_id, away_user_id, status)
        VALUES ($1, $2, $3, $4, $5, 'SCHEDULED')
      `, [uuidv4(), id, weekNumber, home, away])
      matchupCount++
    }
  }

  await pool.query(`
    UPDATE private_leagues SET total_weeks = $1, status = 'open', current_week = 0 WHERE id = $2
  `, [totalWeeks, id])

  return ok({ generated: true, total_weeks: totalWeeks, matchup_count: matchupCount })
}

function generateRoundRobin(players) {
  const hasBye = players.length % 2 !== 0
  const list   = hasBye ? [...players, 'BYE'] : [...players]
  const half   = list.length / 2
  const firstLeg = []

  for (let r = 0; r < list.length - 1; r++) {
    const round = []
    for (let i = 0; i < half; i++) {
      const home = list[i]
      const away = list[list.length - 1 - i]
      if (home !== 'BYE' && away !== 'BYE') {
        round.push({ home, away })
      }
    }
    firstLeg.push(round)
    // Rotate: keep list[0] fixed, rotate the rest
    list.splice(1, 0, list.pop())
  }

  const secondLeg = firstLeg.map(round => round.map(m => ({ home: m.away, away: m.home })))
  return [...firstLeg, ...secondLeg]
}

// ── Publish league (allow joining) ────────────────────────────────────────────
async function publishLeague(event) {
  const { id } = event.pathParameters
  const pool = await getPool()

  const { rowCount } = await pool.query(`
    UPDATE private_leagues SET status = 'open' WHERE id = $1 AND status = 'draft'
  `, [id])

  if (rowCount === 0) return error(400, 'League is not in draft status')
  return ok({ published: true })
}

// ── Start a league week (link gameweek to this week's matchups) ───────────────
async function startLeagueWeek(event) {
  const { id } = event.pathParameters
  const { gameweek_id, week_number } = JSON.parse(event.body || '{}')
  if (!gameweek_id || !week_number) return error(400, 'gameweek_id and week_number required')

  const pool = await getPool()

  const { rows: [gw] } = await pool.query(`
    SELECT id, status FROM gameweeks WHERE id = $1
  `, [gameweek_id])
  if (!gw) return error(404, 'Gameweek not found')
  if (gw.status !== 'PUBLISHED') return error(400, 'Gameweek must be PUBLISHED first')

  await pool.query(`
    UPDATE matchups
    SET gameweek_id = $1, status = 'PENDING'
    WHERE league_id = $2 AND league_week = $3 AND status = 'SCHEDULED'
  `, [gameweek_id, id, week_number])

  await pool.query(`
    UPDATE private_leagues SET current_week = $1, status = 'active' WHERE id = $2
  `, [week_number, id])

  return ok({ started: true, week_number, gameweek_id })
}

// ── Settle current week: compare picks, award 3/1/0 points ───────────────────
async function settleLeagueWeek(event) {
  const { id } = event.pathParameters
  const pool = await getPool()

  const { rows: [league] } = await pool.query(`
    SELECT current_week, total_weeks FROM private_leagues WHERE id = $1
  `, [id])
  if (!league) return error(404, 'League not found')

  const { rows: matchups } = await pool.query(`
    SELECT * FROM matchups
    WHERE league_id = $1 AND league_week = $2 AND status = 'PENDING'
  `, [id, league.current_week])

  if (matchups.length === 0) return error(400, 'No pending matchups for current week')

  const results = []

  for (const m of matchups) {
    if (!m.gameweek_id) continue

    const countPicks = async (userId) => {
      const { rows } = await pool.query(`
        SELECT COUNT(*) AS cnt
        FROM user_picks
        WHERE user_id = $1 AND gameweek_id = $2 AND pick_status = 'won'
      `, [userId, m.gameweek_id])
      return parseInt(rows[0].cnt)
    }

    const homeScore = await countPicks(m.home_user_id)
    const awayScore = await countPicks(m.away_user_id)

    let homePoints, awayPoints, winnerId
    if (homeScore > awayScore) {
      homePoints = 3; awayPoints = 0; winnerId = m.home_user_id
    } else if (awayScore > homeScore) {
      homePoints = 0; awayPoints = 3; winnerId = m.away_user_id
    } else {
      homePoints = 1; awayPoints = 1; winnerId = null
    }

    await pool.query(`
      UPDATE matchups
      SET home_score = $1, away_score = $2,
          home_league_points = $3, away_league_points = $4,
          winner_user_id = $5, status = 'SETTLED'
      WHERE id = $6
    `, [homeScore, awayScore, homePoints, awayPoints, winnerId, m.id])

    const updateMember = async (userId, pts, scored, conceded) => {
      const isWin  = pts === 3 ? 1 : 0
      const isDraw = pts === 1 ? 1 : 0
      const isLoss = pts === 0 ? 1 : 0
      await pool.query(`
        UPDATE private_league_members
        SET league_points  = league_points  + $1,
            wins           = wins           + $2,
            draws          = draws          + $3,
            losses         = losses         + $4,
            goals_for      = goals_for      + $5,
            goals_against  = goals_against  + $6,
            played         = played         + 1
        WHERE league_id = $7 AND user_id = $8
      `, [pts, isWin, isDraw, isLoss, scored, conceded, id, userId])
    }

    await updateMember(m.home_user_id, homePoints, homeScore, awayScore)
    await updateMember(m.away_user_id, awayPoints, awayScore, homeScore)

    results.push({
      matchup_id:   m.id,
      home_user_id: m.home_user_id,
      away_user_id: m.away_user_id,
      home_score:   homeScore,
      away_score:   awayScore,
      home_points:  homePoints,
      away_points:  awayPoints,
    })
  }

  // If all weeks played, complete the league
  if (league.current_week >= league.total_weeks) {
    await pool.query(`UPDATE private_leagues SET status = 'completed' WHERE id = $1`, [id])
  }

  return ok({ settled: true, week: league.current_week, results })
}

module.exports = {
  listPrivateLeagues,
  getPrivateLeague,
  updatePrivateLeague,
  adminCreatePeriod,
  adminTogglePayment,
  adminUpdatePeriodPrizes,
  generateLeagueCalendar,
  publishLeague,
  startLeagueWeek,
  settleLeagueWeek,
}
