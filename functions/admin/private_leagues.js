const { getPool } = require('../../shared/db')
const { ok, error } = require('../../shared/response')

async function listPrivateLeagues() {
  const pool = await getPool()
  const { rows } = await pool.query(`
    SELECT
      l.id, l.name, l.invite_code, l.image_url, l.entry_fee_euros, l.created_at, l.updated_at,
      u.display_name AS created_by_name,
      (SELECT COUNT(*) FROM private_league_members WHERE league_id = l.id) AS member_count,
      (SELECT COUNT(*) FROM private_league_members WHERE league_id = l.id AND has_paid = TRUE) AS paid_count,
      (SELECT row_to_json(p) FROM (
        SELECT id, name, status, created_at
        FROM private_league_periods WHERE league_id = l.id ORDER BY created_at DESC LIMIT 1
      ) p) AS current_period
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

  const { rows: periods } = await pool.query(`
    SELECT * FROM private_league_periods WHERE league_id = $1 ORDER BY created_at DESC
  `, [id])

  const { rows: members } = await pool.query(`
    SELECT m.user_id, m.role, m.has_paid, m.joined_at, u.display_name, u.avatar_url, u.email
    FROM private_league_members m
    JOIN users u ON u.id = m.user_id
    WHERE m.league_id = $1
    ORDER BY m.role DESC, m.joined_at ASC
  `, [id])

  // Standings from current period
  const currentPeriod = periods[0] || null
  let standings = []
  if (currentPeriod) {
    const { rows } = await pool.query(`
      SELECT
        u.id AS user_id, u.display_name, u.avatar_url, m.has_paid,
        COALESCE(SUM(uge.league_points + COALESCE(uge.perfect_week_bonus, 0)), 0) AS total_points,
        COALESCE(SUM(uge.correct_picks), 0) AS correct_picks,
        COUNT(DISTINCT uge.gameweek_id) AS gameweeks_played,
        ROW_NUMBER() OVER (ORDER BY COALESCE(SUM(uge.league_points + COALESCE(uge.perfect_week_bonus, 0)), 0) DESC, u.display_name ASC) AS position
      FROM private_league_members m
      JOIN users u ON u.id = m.user_id
      LEFT JOIN user_gameweek_entries uge ON uge.user_id = m.user_id
      WHERE m.league_id = $1
      GROUP BY u.id, u.display_name, u.avatar_url, m.has_paid
      ORDER BY total_points DESC, u.display_name ASC
    `, [id])
    standings = rows
  }

  return ok({ ...league, periods, members, standings, current_period: currentPeriod })
}

async function updatePrivateLeague(event) {
  const { id } = event.pathParameters
  const body = JSON.parse(event.body || '{}')
  const pool = await getPool()

  const { name, image_url, entry_fee_euros, invite_code } = body
  await pool.query(`
    UPDATE private_leagues
    SET name = COALESCE($1, name),
        image_url = COALESCE($2, image_url),
        entry_fee_euros = COALESCE($3, entry_fee_euros),
        invite_code = COALESCE($4, invite_code),
        updated_at = NOW()
    WHERE id = $5
  `, [name || null, image_url || null, entry_fee_euros ?? null, invite_code || null, id])

  return ok({ updated: true })
}

async function adminCreatePeriod(event) {
  const { id } = event.pathParameters
  const body = JSON.parse(event.body || '{}')
  const { name, start_matchweek_id, end_matchweek_id, prize_config } = body
  if (!name?.trim()) return error(400, 'name is required')

  const pool = await getPool()

  // Close any live periods
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

module.exports = { listPrivateLeagues, getPrivateLeague, updatePrivateLeague, adminCreatePeriod, adminTogglePayment, adminUpdatePeriodPrizes }
