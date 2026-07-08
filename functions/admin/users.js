const { getPool } = require('../../shared/db')
const { ok, error } = require('../../shared/response')

async function listUsers() {
  const pool = await getPool()
  const { rows } = await pool.query(`
    SELECT
      u.id, u.email, u.display_name, u.role, u.created_at,
      u.last_login_at, u.login_count, u.last_seen_at, u.app_opens,
      COALESCE(ew.balance, 0)                                                           AS energy_balance,
      COALESCE((SELECT SUM(et.amount) FROM energy_transactions et
                WHERE et.user_id = u.id AND et.type = 'PURCHASE'), 0)::int             AS extra_energy,
      COALESCE((SELECT COUNT(*) FROM user_sprint_progress usp
                WHERE usp.user_id = u.id), 0)::int                                     AS sprints_played,
      COALESCE((SELECT SUM(gameweeks_participated) FROM user_sprint_progress usp
                WHERE usp.user_id = u.id), 0)::int                                     AS matchweeks_played,
      COALESCE((SELECT SUM(total_correct_picks) FROM user_sprint_progress usp
                WHERE usp.user_id = u.id), 0)::int                                     AS total_correct,
      COALESCE((SELECT SUM(total_incorrect_picks) FROM user_sprint_progress usp
                WHERE usp.user_id = u.id), 0)::int                                     AS total_incorrect,
      (SELECT json_build_object('name', d.name, 'icon', d.icon, 'is_rookie', uds.is_rookie)
       FROM user_division_status uds JOIN divisions d ON d.id = uds.division_id
       WHERE uds.user_id = u.id LIMIT 1)                                               AS current_division
    FROM users u
    LEFT JOIN energy_wallets ew ON ew.user_id = u.id
    ORDER BY u.created_at DESC
  `)
  return ok(rows.map(u => ({
    ...u,
    accuracy_pct: (u.total_correct + u.total_incorrect) > 0
      ? Math.round((u.total_correct / (u.total_correct + u.total_incorrect)) * 100)
      : null,
  })))
}

async function getUserDetail(event) {
  const pool = await getPool()
  const userId = event.pathParameters?.id
  if (!userId) return error(400, 'Missing user id')

  const [userRes, sprintRes, gameweekRes, divisionRes, historyRes, matchweekRes, energyTxRes, extraEnergyRes] = await Promise.all([
    // Base user + energy
    pool.query(`
      SELECT u.id, u.email, u.display_name, u.role, u.created_at,
             COALESCE(ew.balance, 0) AS energy_balance
      FROM users u
      LEFT JOIN energy_wallets ew ON ew.user_id = u.id
      WHERE u.id = $1
    `, [userId]),

    // Sprint stats: per-sprint breakdown
    pool.query(`
      SELECT
        usp.sprint_id, s.name AS sprint_name, s.start_date, s.end_date, s.status AS sprint_status,
        d.name AS division_name, d.icon AS division_icon,
        usp.total_correct_picks, usp.total_incorrect_picks,
        usp.total_league_points, usp.perfect_weeks,
        usp.gameweeks_participated, usp.sprint_outcome, usp.settled_at
      FROM user_sprint_progress usp
      JOIN sprints s ON s.id = usp.sprint_id
      LEFT JOIN divisions d ON d.id = usp.division_id
      WHERE usp.user_id = $1
      ORDER BY s.start_date DESC
    `, [userId]),

    // Lifetime stats from sprint progress (same source as listUsers)
    pool.query(`
      SELECT
        COALESCE(SUM(gameweeks_participated), 0)::int        AS total_matchweeks,
        COALESCE(SUM(total_correct_picks), 0)::int           AS total_correct,
        COALESCE(SUM(total_incorrect_picks), 0)::int         AS total_incorrect
      FROM user_sprint_progress
      WHERE user_id = $1
    `, [userId]),

    // Current division
    pool.query(`
      SELECT d.id, d.name, d.icon, uds.is_rookie, uds.assigned_at
      FROM user_division_status uds
      JOIN divisions d ON d.id = uds.division_id
      WHERE uds.user_id = $1
    `, [userId]),

    // Division history (promotion/relegation log)
    pool.query(`
      SELECT
        prh.movement, prh.league_points, prh.created_at,
        s.name AS sprint_name, s.start_date,
        fd.name AS from_division, fd.icon AS from_icon,
        td.name AS to_division, td.icon AS to_icon
      FROM promotion_relegation_history prh
      JOIN sprints s ON s.id = prh.sprint_id
      LEFT JOIN divisions fd ON fd.id = prh.from_division_id
      LEFT JOIN divisions td ON td.id = prh.to_division_id
      WHERE prh.user_id = $1
      ORDER BY prh.created_at DESC
    `, [userId]),

    // Per-matchweek entries — all statuses, no filter
    pool.query(`
      SELECT
        uge.id, uge.status, uge.picks_submitted, uge.correct_picks, uge.incorrect_picks,
        uge.league_points, uge.is_perfect_week, uge.settled_at, uge.created_at,
        g.sprint_week, g.lock_time,
        s.name AS sprint_name
      FROM user_gameweek_entries uge
      JOIN gameweeks g ON g.id = uge.gameweek_id
      LEFT JOIN sprints s ON s.id = COALESCE(uge.sprint_id, g.sprint_id)
      WHERE uge.user_id = $1
      ORDER BY COALESCE(g.lock_time, uge.created_at) DESC
    `, [userId]),

    // Energy transaction history
    pool.query(`
      SELECT amount, type, description, created_at
      FROM energy_transactions
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 30
    `, [userId]),

    // Extra energy purchased (from pack purchases)
    pool.query(`
      SELECT COALESCE(SUM(energy_amount), 0)::int AS extra_energy
      FROM energy_pack_purchases
      WHERE user_id = $1
    `, [userId]),
  ])

  if (!userRes.rows.length) return error(404, 'User not found')

  const user          = userRes.rows[0]
  const sprints       = sprintRes.rows
  const gw            = gameweekRes.rows[0]
  const division      = divisionRes.rows[0] ?? null
  const history       = historyRes.rows
  const matchweeks    = matchweekRes.rows
  const energyHistory = energyTxRes.rows
  const extraEnergy   = extraEnergyRes.rows[0]?.extra_energy ?? 0

  const totalCorrect   = gw.total_correct   ?? 0
  const totalIncorrect = gw.total_incorrect ?? 0
  const totalPicks     = totalCorrect + totalIncorrect
  const accuracy       = totalPicks > 0 ? Math.round((totalCorrect / totalPicks) * 100) : null

  return ok({
    ...user,
    extra_energy: extraEnergy,
    stats: {
      sprints_played:   sprints.length,
      matchweeks_played: gw.total_matchweeks ?? 0,
      total_correct:    totalCorrect,
      total_incorrect:  totalIncorrect,
      accuracy_pct:     accuracy,
    },
    current_division: division,
    sprint_history:    sprints,
    division_history:  history,
    matchweek_history: matchweeks,
    energy_history:    energyHistory,
  })
}

async function adjustUserEnergy(event) {
  const pool   = await getPool()
  const userId = event.pathParameters?.id
  if (!userId) return error(400, 'Missing user id')

  const body   = JSON.parse(event.body || '{}')
  const amount = parseInt(body.amount)
  if (isNaN(amount) || amount === 0) return error(400, 'amount must be a non-zero integer')

  const description = body.description || 'Admin adjustment'

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    await client.query(
      `INSERT INTO energy_wallets (user_id, balance) VALUES ($1, 0) ON CONFLICT (user_id) DO NOTHING`,
      [userId]
    )

    const { rows } = await client.query(
      `UPDATE energy_wallets SET balance = GREATEST(0, balance + $1) WHERE user_id = $2 RETURNING balance`,
      [amount, userId]
    )
    if (!rows.length) {
      await client.query('ROLLBACK')
      return error(404, 'User not found')
    }

    await client.query(
      `INSERT INTO energy_transactions (user_id, amount, type, description) VALUES ($1, $2, 'REWARD', $3)`,
      [userId, amount, description]
    )

    await client.query('COMMIT')
    return ok({ balance: rows[0].balance })
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
}

async function listLeagues() {
  const pool = await getPool()
  const { rows } = await pool.query(`
    SELECT
      l.id, l.name, l.competition, l.season, l.status,
      l.entry_fee, l.prize_pool, l.max_teams, l.created_at,
      u.email AS creator_email, u.display_name AS creator_name,
      COUNT(lm.id)::int AS member_count
    FROM leagues l
    LEFT JOIN users u ON u.id = l.creator_id
    LEFT JOIN league_members lm ON lm.league_id = l.id
    GROUP BY l.id, u.email, u.display_name
    ORDER BY l.created_at DESC
  `)
  return ok(rows)
}

async function getStats() {
  const pool = await getPool()
  const [users, leagues, gameweeks] = await Promise.all([
    pool.query("SELECT COUNT(*)::int AS count FROM users WHERE role = 'user'"),
    pool.query("SELECT COUNT(*)::int AS count FROM leagues"),
    pool.query("SELECT COUNT(*)::int AS count FROM gameweeks"),
  ])
  return ok({
    users: users.rows[0].count,
    leagues: leagues.rows[0].count,
    gameweeks: gameweeks.rows[0].count,
  })
}

async function getDashboard(event) {
  const pool = await getPool()
  const { range = '30d' } = event.queryStringParameters || {}

  const intervalMap = { '7d': '7 days', '30d': '30 days', '90d': '90 days' }
  const interval = intervalMap[range] || '30 days'
  const days     = range === '7d' ? 7 : range === '90d' ? 90 : 30

  const [
    usersTotal,
    usersToday,
    usersWeek,
    usersMonth,
    userGrowth,
    activeInRange,
    totalPicksRange,
    revenueTotal,
    revenueByDay,
    revenueByMonth,
    topSpenders,
    divisionDist,
    picksTrend,
    packSales,
    gameStats,
    currentSprint,
  ] = await Promise.all([
    // Total real users
    pool.query(`SELECT COUNT(*)::int AS count FROM users WHERE role = 'user'`),

    // New real users today
    pool.query(`SELECT COUNT(*)::int AS count FROM users WHERE role = 'user' AND created_at >= NOW() - INTERVAL '1 day'`),

    // New real users this week
    pool.query(`SELECT COUNT(*)::int AS count FROM users WHERE role = 'user' AND created_at >= NOW() - INTERVAL '7 days'`),

    // New real users in selected range
    pool.query(`SELECT COUNT(*)::int AS count FROM users WHERE role = 'user' AND created_at >= NOW() - INTERVAL '${interval}'`),

    // User growth by day (real users only)
    pool.query(`
      SELECT DATE(created_at) AS day, COUNT(*)::int AS new_users
      FROM users
      WHERE role = 'user' AND created_at >= NOW() - INTERVAL '${interval}'
      GROUP BY day ORDER BY day ASC`),

    // Active real users in range (submitted picks)
    pool.query(`
      SELECT COUNT(DISTINCT up.user_id)::int AS count
      FROM user_picks up
      JOIN users u ON u.id = up.user_id AND u.role = 'user'
      WHERE up.created_at >= NOW() - INTERVAL '${interval}'`),

    // Total picks by real users in range
    pool.query(`
      SELECT COUNT(*)::int AS count
      FROM user_picks up
      JOIN users u ON u.id = up.user_id AND u.role = 'user'
      WHERE up.created_at >= NOW() - INTERVAL '${interval}'`),

    // Revenue totals (all time, real users only)
    pool.query(`
      SELECT
        COUNT(*)::int                        AS total_purchases,
        COALESCE(SUM(p.price_euros), 0)::float AS total_revenue,
        COUNT(DISTINCT p.user_id)::int         AS paying_users
      FROM energy_pack_purchases p
      JOIN users u ON u.id = p.user_id AND u.role = 'user'`),

    // Revenue by day (real users, range-aware)
    pool.query(`
      SELECT
        DATE(p.created_at)                     AS day,
        COUNT(*)::int                          AS purchases,
        COALESCE(SUM(p.price_euros), 0)::float AS revenue
      FROM energy_pack_purchases p
      JOIN users u ON u.id = p.user_id AND u.role = 'user'
      WHERE p.created_at >= NOW() - INTERVAL '${interval}'
      GROUP BY day ORDER BY day ASC`),

    // Revenue by month (real users, last 12 months)
    pool.query(`
      SELECT
        TO_CHAR(DATE_TRUNC('month', p.created_at), 'YYYY-MM') AS month,
        COUNT(*)::int                                          AS purchases,
        COALESCE(SUM(p.price_euros), 0)::float                AS revenue
      FROM energy_pack_purchases p
      JOIN users u ON u.id = p.user_id AND u.role = 'user'
      WHERE p.created_at >= NOW() - INTERVAL '12 months'
      GROUP BY month ORDER BY month ASC`),

    // Top spenders (real users only)
    pool.query(`
      SELECT u.id, u.display_name, u.email,
             COUNT(p.id)::int                        AS purchases,
             COALESCE(SUM(p.price_euros), 0)::float  AS total_spent,
             COALESCE(SUM(p.energy_amount), 0)::int  AS energy_bought
      FROM energy_pack_purchases p
      JOIN users u ON u.id = p.user_id AND u.role = 'user'
      GROUP BY u.id, u.display_name, u.email
      ORDER BY total_spent DESC
      LIMIT 10`),

    // Division distribution (real users only)
    pool.query(`
      SELECT d.name, d.icon, d.display_order, d.color_primary,
             COUNT(uds.user_id)::int AS count
      FROM user_division_status uds
      JOIN divisions d ON d.id = uds.division_id
      JOIN users u ON u.id = uds.user_id AND u.role = 'user'
      GROUP BY d.name, d.icon, d.display_order, d.color_primary
      ORDER BY d.display_order ASC`),

    // Picks trend by day (real users only)
    pool.query(`
      SELECT DATE(up.created_at) AS day, COUNT(*)::int AS picks
      FROM user_picks up
      JOIN users u ON u.id = up.user_id AND u.role = 'user'
      WHERE up.created_at >= NOW() - INTERVAL '${interval}'
      GROUP BY day ORDER BY day ASC`),

    // Pack sales breakdown (real users only)
    pool.query(`
      SELECT p.pack_name AS name,
             MIN(p.price_euros)::float                 AS price_euros,
             MIN(p.energy_amount)::int                 AS energy_amount,
             COUNT(*)::int                             AS units_sold,
             COALESCE(SUM(p.price_euros), 0)::float    AS revenue
      FROM energy_pack_purchases p
      JOIN users u ON u.id = p.user_id AND u.role = 'user'
      GROUP BY p.pack_name
      ORDER BY revenue DESC`),

    // Game stats: all-time picks, accuracy, perfect weeks (real users only)
    pool.query(`
      SELECT
        COUNT(up.id)::int                                              AS total_picks_ever,
        COUNT(CASE WHEN eo.result = 'WON'  THEN 1 END)::int           AS total_correct_ever,
        COUNT(CASE WHEN eo.result = 'LOST' THEN 1 END)::int           AS total_incorrect_ever,
        COALESCE(SUM(usp.perfect_weeks), 0)::int                      AS total_perfect_weeks,
        COUNT(DISTINCT up.user_id)::int                               AS total_players_ever,
        COUNT(DISTINCT CASE WHEN eo.result IN ('WON','LOST') THEN up.user_id END)::int AS players_with_results
      FROM user_picks up
      JOIN users u ON u.id = up.user_id AND u.role = 'user'
      JOIN event_options eo ON eo.id = up.event_option_id
      CROSS JOIN (
        SELECT COALESCE(SUM(usp2.perfect_weeks), 0) AS perfect_weeks
        FROM user_sprint_progress usp2
        JOIN users u2 ON u2.id = usp2.user_id AND u2.role = 'user'
      ) usp`),

    // Current active sprint summary (real users only)
    pool.query(`
      SELECT s.id, s.name, s.status, s.start_date, s.end_date,
             COUNT(DISTINCT usp.user_id)::int                  AS active_players,
             COALESCE(SUM(usp.total_correct_picks), 0)::int    AS sprint_correct,
             COALESCE(SUM(usp.total_incorrect_picks), 0)::int  AS sprint_incorrect,
             COALESCE(MAX(usp.total_league_points), 0)::int    AS top_lp,
             COALESCE(SUM(usp.perfect_weeks), 0)::int          AS sprint_perfect_weeks,
             (SELECT COUNT(*)::int FROM gameweeks g WHERE g.sprint_id = s.id AND g.status = 'PUBLISHED') AS gw_open,
             (SELECT COUNT(*)::int FROM gameweeks g WHERE g.sprint_id = s.id AND g.status = 'LOCKED')    AS gw_locked,
             (SELECT COUNT(*)::int FROM gameweeks g WHERE g.sprint_id = s.id AND g.status = 'FINISHED')  AS gw_finished,
             (SELECT COUNT(*)::int FROM gameweeks g WHERE g.sprint_id = s.id)                            AS gw_total
      FROM sprints s
      LEFT JOIN (
        SELECT usp2.* FROM user_sprint_progress usp2
        JOIN users u ON u.id = usp2.user_id AND u.role = 'user'
      ) usp ON usp.sprint_id = s.id
      WHERE s.status IN ('live', 'scheduled')
      GROUP BY s.id, s.name, s.status, s.start_date, s.end_date
      ORDER BY s.start_date ASC
      LIMIT 1`),
  ])

  const total       = usersTotal.rows[0].count
  const activeCount = activeInRange.rows[0].count
  const gs          = gameStats.rows[0] ?? {}
  const settled     = (gs.total_correct_ever ?? 0) + (gs.total_incorrect_ever ?? 0)
  const accuracyPct = settled > 0 ? Math.round((gs.total_correct_ever / settled) * 1000) / 10 : null

  return ok({
    range,
    days,
    users: {
      total,
      new_today:     usersToday.rows[0].count,
      new_week:      usersWeek.rows[0].count,
      new_month:     usersMonth.rows[0].count,
      growth_by_day: userGrowth.rows,
    },
    engagement: {
      active_in_range:    activeCount,
      participation_rate: total > 0 ? Math.round((activeCount / total) * 1000) / 10 : 0,
      total_picks_range:  totalPicksRange.rows[0].count,
      picks_trend_by_day: picksTrend.rows,
    },
    revenue: {
      total_purchases: revenueTotal.rows[0].total_purchases,
      total_revenue:   revenueTotal.rows[0].total_revenue,
      paying_users:    revenueTotal.rows[0].paying_users,
      by_day:          revenueByDay.rows,
      by_month:        revenueByMonth.rows,
      pack_breakdown:  packSales.rows,
    },
    game: {
      total_picks_ever:    gs.total_picks_ever    ?? 0,
      total_correct_ever:  gs.total_correct_ever  ?? 0,
      total_incorrect_ever:gs.total_incorrect_ever ?? 0,
      total_perfect_weeks: gs.total_perfect_weeks  ?? 0,
      total_players_ever:  gs.total_players_ever   ?? 0,
      accuracy_pct:        accuracyPct,
    },
    current_sprint: currentSprint.rows[0] ?? null,
    top_spenders:   topSpenders.rows,
    divisions:      divisionDist.rows,
  })
}

module.exports = { listUsers, getUserDetail, adjustUserEnergy, listLeagues, getStats, getDashboard }
