const axios = require("axios")
const { v4: uuidv4 } = require("uuid")
const { getPool } = require("../../shared/db")
const { getSecrets } = require("../../shared/ssm")
const { verifyToken, extractFromEvent } = require("../../shared/auth")
const { ok, error, unauthorized } = require("../../shared/response")

const API_FOOTBALL_BASE = "https://v3.football.api-sports.io"

const CURATED_COMPETITIONS = [
  { api_league_id: 1,   name: 'FIFA World Cup',         country: 'World',       flag: '🌍', type: 'Cup',        default_season: 2026 },
  { api_league_id: 2,   name: 'UEFA Champions League',  country: 'Europe',      flag: '⭐', type: 'Cup',        default_season: 2024 },
  { api_league_id: 3,   name: 'UEFA Europa League',     country: 'Europe',      flag: '🏅', type: 'Cup',        default_season: 2024 },
  { api_league_id: 848, name: 'UEFA Conference League', country: 'Europe',      flag: '🥉', type: 'Cup',        default_season: 2024 },
  { api_league_id: 5,   name: 'UEFA Nations League',    country: 'Europe',      flag: '🌐', type: 'Tournament', default_season: 2024 },
  { api_league_id: 39,  name: 'Premier League',         country: 'England',     flag: '🏴󠁧󠁢󠁥󠁮󠁧󠁿', type: 'League',     default_season: 2025 },
  { api_league_id: 140, name: 'LaLiga',                 country: 'Spain',       flag: '🇪🇸', type: 'League',     default_season: 2025 },
  { api_league_id: 78,  name: 'Bundesliga',             country: 'Germany',     flag: '🇩🇪', type: 'League',     default_season: 2025 },
  { api_league_id: 135, name: 'Serie A',                country: 'Italy',       flag: '🇮🇹', type: 'League',     default_season: 2025 },
  { api_league_id: 61,  name: 'Ligue 1',                country: 'France',      flag: '🇫🇷', type: 'League',     default_season: 2025 },
  { api_league_id: 88,  name: 'Eredivisie',             country: 'Netherlands', flag: '🇳🇱', type: 'League',     default_season: 2025 },
  { api_league_id: 94,  name: 'Primeira Liga',          country: 'Portugal',    flag: '🇵🇹', type: 'League',     default_season: 2025 },
  { api_league_id: 144, name: 'Belgian Pro League',     country: 'Belgium',     flag: '🇧🇪', type: 'League',     default_season: 2025 },
  { api_league_id: 179, name: 'Scottish Premiership',   country: 'Scotland',    flag: '🏴󠁧󠁢󠁳󠁣󠁴󠁿', type: 'League',     default_season: 2025 },
  { api_league_id: 45,  name: 'FA Cup',                 country: 'England',     flag: '🏴󠁧󠁢󠁥󠁮󠁧󠁿', type: 'Cup',        default_season: 2024 },
  { api_league_id: 143, name: 'Copa del Rey',           country: 'Spain',       flag: '🇪🇸', type: 'Cup',        default_season: 2024 },
  { api_league_id: 137, name: 'Coppa Italia',           country: 'Italy',       flag: '🇮🇹', type: 'Cup',        default_season: 2024 },
  { api_league_id: 15,  name: 'Club World Cup',         country: 'World',       flag: '🌐', type: 'Tournament', default_season: 2025 },
  { api_league_id: 253, name: 'MLS',                    country: 'USA',         flag: '🇺🇸', type: 'League',     default_season: 2025 },
  { api_league_id: 71,  name: 'Série A',                country: 'Brazil',      flag: '🇧🇷', type: 'League',     default_season: 2025 },
]

exports.handler = async (event) => {
  const routeKey = event.routeKey

  // Public routes — no auth required
  if (routeKey === "GET /competitions") {
    try { return await listCompetitions() }
    catch (err) { console.error(err); return error(500, "Internal server error") }
  }
  if (routeKey === "GET /scores") {
    try { return await getPublicScores(event) }
    catch (err) { console.error(err); return error(500, "Internal server error") }
  }
  if (routeKey === "GET /public/gameweek") {
    try { return await getPublicGameweek() }
    catch (err) { console.error(err); return error(500, "Internal server error") }
  }

  let user
  try {
    user = await verifyToken(extractFromEvent(event))
  } catch {
    return unauthorized()
  }

  if (user.role !== "admin") return error(403, "Admin only")

  try {
    if (routeKey === "GET /admin/fixtures")         return await importFixtures(event)
    if (routeKey === "POST /admin/gameweek")        return await createGameweek(event)
    if (routeKey === "GET /admin/gameweek/{id}")    return await getGameweek(event)
    if (routeKey === "PUT /admin/gameweek/{id}")    return await updateGameweek(event)
    if (routeKey === "POST /admin/publish")         return await publishGameweek(event)
    if (routeKey === "POST /admin/gameweeks/{id}/lock")    return await lockGameweek(event)
    if (routeKey === "POST /admin/gameweeks/{id}/unlock")  return await unlockGameweek(event)
    if (routeKey === "POST /admin/gameweeks/{id}/resolve")  return await resolveGameweek(event)
    if (routeKey === "GET /admin/users")            return await listUsers()
    if (routeKey === "GET /admin/users/{id}")       return await getUserDetail(event)
    if (routeKey === "POST /admin/users/{id}/energy") return await adjustUserEnergy(event)
    if (routeKey === "GET /admin/leagues")          return await listLeagues()
    if (routeKey === "GET /admin/stats")            return await getStats()
    if (routeKey === "GET /admin/dashboard")        return await getDashboard(event)
    if (routeKey === "GET /admin/odds")             return await getOddsForFixture(event)
    if (routeKey === "GET /admin/competitions")              return await listCompetitions()
    if (routeKey === "POST /admin/competitions")             return await createCompetition(event)
    if (routeKey === "PUT /admin/competitions/{id}")         return await updateCompetition(event)
    if (routeKey === "DELETE /admin/competitions/{id}")      return await deleteCompetition(event)
    if (routeKey === "GET /admin/competitions/{id}/calendar")   return await getCompetitionCalendar(event)
    if (routeKey === "GET /admin/competitions/{id}/gameweeks")  return await getCompetitionGameweeks(event)
    if (routeKey === "GET /admin/competitions/{id}/standings")  return await getCompetitionStandings(event)
    if (routeKey === "GET /admin/fixtures/{fixtureId}/details") return await getFixtureDetails(event)
    // ── OddsRivals ─────────────────────────────────────────────────────────
    if (routeKey === "GET /admin/divisions")                           return await listDivisions()
    if (routeKey === "POST /admin/divisions")                          return await createDivision(event)
    if (routeKey === "PUT /admin/divisions/{id}")                      return await updateDivision(event)
    if (routeKey === "GET /admin/divisions/{id}/users")                return await getDivisionUsers(event)
    if (routeKey === "GET /admin/sprints")                             return await listSprints()
    if (routeKey === "POST /admin/sprints")                            return await createSprint(event)
    if (routeKey === "GET /admin/sprints/{id}")                        return await getSprint(event)
    if (routeKey === "PUT /admin/sprints/{id}")                        return await updateSprint(event)
    if (routeKey === "POST /admin/sprints/{id}/gameweeks")             return await addSprintGameweek(event)
    if (routeKey === "PATCH /admin/sprints/{id}/gameweeks/{gwId}")     return await updateSprintGameweekDates(event)
    if (routeKey === "DELETE /admin/sprints/{id}/gameweeks/{gwId}")    return await removeSprintGameweek(event)
    if (routeKey === "POST /admin/sprints/{id}/settle")                return await settleSprint(event, user)
    if (routeKey === "POST /admin/sprints/{id}/activate")              return await activateSprint(event)
    if (routeKey === "POST /admin/sprints/{id}/recalculate")           return await recalculateSprintEntries(event)
    if (routeKey === "GET /admin/rankings")                            return await getRankings(event)
    if (routeKey === "GET /admin/fixtures/available")                  return await getAvailableFixtures(event)
    if (routeKey === "POST /admin/fixtures/import-range")              return await importFixturesByRange(event)
    if (routeKey === "POST /admin/fixtures/refresh-results")           return await refreshFixtureResults(event)
    if (routeKey === "GET /admin/competitions/browse")                 return await browseCompetitions()
    if (routeKey === "POST /admin/competitions/import")                return await importCompetitionFromApi(event)
    // ── Energy Packs ────────────────────────────────────────────────────────
    if (routeKey === "GET /admin/energy-packs")          return await listEnergyPacks()
    if (routeKey === "POST /admin/energy-packs")         return await createEnergyPack(event)
    if (routeKey === "PUT /admin/energy-packs/{id}")     return await updateEnergyPack(event)
    if (routeKey === "DELETE /admin/energy-packs/{id}")  return await deleteEnergyPack(event)
    if (routeKey === "GET /admin/debug/divisions")       return await debugDivisions(event)
    if (routeKey === "POST /admin/debug/fix-divisions")  return await fixDivisions(event)
    if (routeKey === "POST /admin/events/{id}/resettle") return await resettleEvent(event)
    return error(404, "Not found")
  } catch (err) {
    console.error(err)
    return error(500, "Internal server error")
  }
}

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

  const [userRes, sprintRes, gameweekRes, divisionRes, historyRes, matchweekRes] = await Promise.all([
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
  ])

  if (!userRes.rows.length) return error(404, 'User not found')

  const user          = userRes.rows[0]
  const sprints       = sprintRes.rows
  const gw            = gameweekRes.rows[0]
  const division      = divisionRes.rows[0] ?? null
  const history       = historyRes.rows
  const matchweeks    = matchweekRes.rows

  const totalCorrect   = gw.total_correct   ?? 0
  const totalIncorrect = gw.total_incorrect ?? 0
  const totalPicks     = totalCorrect + totalIncorrect
  const accuracy       = totalPicks > 0 ? Math.round((totalCorrect / totalPicks) * 100) : null

  return ok({
    ...user,
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

  await pool.query('BEGIN')
  try {
    // Upsert wallet
    await pool.query(
      `INSERT INTO energy_wallets (user_id, balance)
       VALUES ($1, 0)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId]
    )

    // Apply delta, prevent balance going below 0
    const { rows } = await pool.query(
      `UPDATE energy_wallets
       SET balance = GREATEST(0, balance + $1)
       WHERE user_id = $2
       RETURNING balance`,
      [amount, userId]
    )
    if (!rows.length) { await pool.query('ROLLBACK'); return error(404, 'User not found') }

    // Record transaction
    await pool.query(
      `INSERT INTO energy_transactions (user_id, amount, type, description)
       VALUES ($1, $2, 'ADMIN_ADJUSTMENT', $3)`,
      [userId, amount, description]
    )

    await pool.query('COMMIT')
    return ok({ balance: rows[0].balance })
  } catch (e) {
    await pool.query('ROLLBACK')
    throw e
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
    pool.query("SELECT COUNT(*)::int AS count FROM users"),
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
    // Total users
    pool.query(`SELECT COUNT(*)::int AS count FROM users`),

    // New users today
    pool.query(`SELECT COUNT(*)::int AS count FROM users WHERE created_at >= NOW() - INTERVAL '1 day'`),

    // New users this week
    pool.query(`SELECT COUNT(*)::int AS count FROM users WHERE created_at >= NOW() - INTERVAL '7 days'`),

    // New users in selected range
    pool.query(`SELECT COUNT(*)::int AS count FROM users WHERE created_at >= NOW() - INTERVAL '${interval}'`),

    // User growth (by day, range-aware)
    pool.query(`
      SELECT DATE(created_at) AS day, COUNT(*)::int AS new_users
      FROM users
      WHERE created_at >= NOW() - INTERVAL '${interval}'
      GROUP BY day ORDER BY day ASC`),

    // Active users in range (submitted picks)
    pool.query(`
      SELECT COUNT(DISTINCT user_id)::int AS count
      FROM user_picks
      WHERE created_at >= NOW() - INTERVAL '${interval}'`),

    // Total picks in range
    pool.query(`
      SELECT COUNT(*)::int AS count
      FROM user_picks
      WHERE created_at >= NOW() - INTERVAL '${interval}'`),

    // Revenue totals (all time)
    pool.query(`
      SELECT
        COUNT(*)::int                        AS total_purchases,
        COALESCE(SUM(price_euros), 0)::float AS total_revenue,
        COUNT(DISTINCT user_id)::int         AS paying_users
      FROM energy_pack_purchases`),

    // Revenue by day (range-aware)
    pool.query(`
      SELECT
        DATE(created_at)                     AS day,
        COUNT(*)::int                        AS purchases,
        COALESCE(SUM(price_euros), 0)::float AS revenue
      FROM energy_pack_purchases
      WHERE created_at >= NOW() - INTERVAL '${interval}'
      GROUP BY day ORDER BY day ASC`),

    // Revenue by month (last 12 months)
    pool.query(`
      SELECT
        TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM') AS month,
        COUNT(*)::int                                        AS purchases,
        COALESCE(SUM(price_euros), 0)::float                AS revenue
      FROM energy_pack_purchases
      WHERE created_at >= NOW() - INTERVAL '12 months'
      GROUP BY month ORDER BY month ASC`),

    // Top spenders (all time)
    pool.query(`
      SELECT u.id, u.display_name, u.email,
             COUNT(p.id)::int                        AS purchases,
             COALESCE(SUM(p.price_euros), 0)::float  AS total_spent,
             COALESCE(SUM(p.energy_amount), 0)::int  AS energy_bought
      FROM energy_pack_purchases p
      JOIN users u ON u.id = p.user_id
      GROUP BY u.id, u.display_name, u.email
      ORDER BY total_spent DESC
      LIMIT 10`),

    // Division distribution — real table
    pool.query(`
      SELECT d.name, d.icon, d.display_order, d.color_primary,
             COUNT(uds.user_id)::int AS count
      FROM user_division_status uds
      JOIN divisions d ON d.id = uds.division_id
      GROUP BY d.name, d.icon, d.display_order, d.color_primary
      ORDER BY d.display_order ASC`),

    // Picks trend (range-aware)
    pool.query(`
      SELECT DATE(created_at) AS day, COUNT(*)::int AS picks
      FROM user_picks
      WHERE created_at >= NOW() - INTERVAL '${interval}'
      GROUP BY day ORDER BY day ASC`),

    // Pack sales breakdown
    pool.query(`
      SELECT pack_name AS name,
             MIN(price_euros)::float                 AS price_euros,
             MIN(energy_amount)::int                 AS energy_amount,
             COUNT(*)::int                           AS units_sold,
             COALESCE(SUM(price_euros), 0)::float    AS revenue
      FROM energy_pack_purchases
      GROUP BY pack_name
      ORDER BY revenue DESC`),

    // Game stats: all-time picks, accuracy, perfect weeks
    pool.query(`
      SELECT
        COUNT(up.id)::int                                              AS total_picks_ever,
        COUNT(CASE WHEN eo.result = 'WON'  THEN 1 END)::int           AS total_correct_ever,
        COUNT(CASE WHEN eo.result = 'LOST' THEN 1 END)::int           AS total_incorrect_ever,
        COALESCE(SUM(usp.perfect_weeks), 0)::int                      AS total_perfect_weeks,
        COUNT(DISTINCT up.user_id)::int                               AS total_players_ever,
        COUNT(DISTINCT CASE WHEN eo.result IN ('WON','LOST') THEN up.user_id END)::int AS players_with_results
      FROM user_picks up
      JOIN event_options eo ON eo.id = up.event_option_id
      CROSS JOIN (SELECT COALESCE(SUM(perfect_weeks),0) AS perfect_weeks FROM user_sprint_progress) usp`),

    // Current active sprint summary
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
      LEFT JOIN user_sprint_progress usp ON usp.sprint_id = s.id
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

async function importFixtures(event) {
  const { leagueId, season, round, next } = event.queryStringParameters || {}
  if (!leagueId || !season) return error(400, "leagueId and season are required")
  const secrets = await getSecrets()
  const params = { league: leagueId, season, round }
  if (next) params.next = next
  const res = await axios.get(`${API_FOOTBALL_BASE}/fixtures`, {
    params,
    headers: { "x-apisports-key": secrets.key }
  })
  // Surface API-Football plan errors to the client
  const apiErrors = res.data?.errors
  if (apiErrors && Object.keys(apiErrors).length > 0) {
    const msg = Object.values(apiErrors).join(' ')
    return error(402, msg)
  }
  const fixtures = (res.data?.response || []).map(f => ({
    id: f.fixture.id, date: f.fixture.date,
    home: f.teams.home.name, away: f.teams.away.name,
    competition: f.league.name, round: f.league.round
  }))
  return ok(fixtures)
}

function probToEnergyCost(prob) {
  if (prob <= 0.1) return 1; if (prob <= 0.2) return 2
  if (prob <= 0.3) return 3; if (prob <= 0.4) return 4
  if (prob <= 0.5) return 5; if (prob <= 0.6) return 6
  if (prob <= 0.7) return 7; if (prob <= 0.8) return 8
  if (prob <= 0.9) return 9; return null
}

async function createGameweek(event) {
  const body = JSON.parse(event.body || "{}")
  const { competition_id, week_number, lock_time, reveal_time, events: eventDefs } = body
  if (!competition_id || !week_number || !lock_time || !Array.isArray(eventDefs))
    return error(400, "competition_id, week_number, lock_time and events are required")

  const pool = await getPool()

  // Validate competition exists
  const comp = await pool.query("SELECT id, name FROM competitions WHERE id=$1", [competition_id])
  if (!comp.rows.length) return error(404, "Competition not found")

  const gwId = uuidv4()

  await pool.query(
    `INSERT INTO gameweeks (id, competition_id, week_number, lock_time, reveal_time, status)
     VALUES ($1,$2,$3,$4,$5,'DRAFT')`,
    [gwId, competition_id, week_number, lock_time, reveal_time || lock_time]
  )

  for (const evDef of eventDefs) {
    const eventId = uuidv4()
    await pool.query(
      `INSERT INTO events (id, gameweek_id, event_type, fixture_id, fixture_name, player_name, competition, match_time)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [eventId, gwId, evDef.event_type, evDef.fixture_id, evDef.fixture_name,
       evDef.player_name || null, evDef.competition || null, evDef.match_time || null]
    )
    for (const opt of (evDef.options || [])) {
      const energyCost = opt.energy_cost
      if (!energyCost) continue
      await pool.query(
        "INSERT INTO event_options (id, event_id, label, energy_cost, result_key) VALUES ($1,$2,$3,$4,$5)",
        [uuidv4(), eventId, opt.label, energyCost, opt.result_key || null]
      )
    }
  }
  return ok({ gameweekId: gwId }, 201)
}

async function getGameweek(event) {
  const { id } = event.pathParameters
  const pool = await getPool()
  const gw = await pool.query("SELECT * FROM gameweeks WHERE id=$1", [id])
  if (!gw.rows.length) return error(404, "Gameweek not found")

  const events = await pool.query(
    "SELECT * FROM events WHERE gameweek_id=$1 ORDER BY match_time ASC", [id]
  )
  const options = await pool.query(
    `SELECT eo.* FROM event_options eo
     JOIN events e ON e.id = eo.event_id
     WHERE e.gameweek_id=$1`, [id]
  )

  const optsByEvent = {}
  for (const o of options.rows) {
    if (!optsByEvent[o.event_id]) optsByEvent[o.event_id] = []
    optsByEvent[o.event_id].push({ label: o.label, energy_cost: o.energy_cost })
  }

  return ok({
    ...gw.rows[0],
    events: events.rows.map(e => ({
      ...e,
      options: optsByEvent[e.id] ?? [],
    })),
  })
}

async function updateGameweek(event) {
  const { id } = event.pathParameters
  const body = JSON.parse(event.body || "{}")
  const { week_number, lock_time, reveal_time, events: eventDefs } = body
  if (!week_number || !lock_time || !Array.isArray(eventDefs))
    return error(400, "week_number, lock_time and events are required")

  const pool = await getPool()
  const gw = await pool.query("SELECT id FROM gameweeks WHERE id=$1 AND status='DRAFT'", [id])
  if (!gw.rows.length) return error(404, "Gameweek not found or not editable")

  // Update gameweek meta
  await pool.query(
    "UPDATE gameweeks SET week_number=$1, lock_time=$2, reveal_time=$3 WHERE id=$4",
    [week_number, lock_time, reveal_time || lock_time, id]
  )

  // Replace all events and options
  const existingEvents = await pool.query("SELECT id FROM events WHERE gameweek_id=$1", [id])
  for (const ev of existingEvents.rows) {
    await pool.query("DELETE FROM event_options WHERE event_id=$1", [ev.id])
  }
  await pool.query("DELETE FROM events WHERE gameweek_id=$1", [id])

  for (const evDef of eventDefs) {
    const eventId = uuidv4()
    await pool.query(
      `INSERT INTO events (id, gameweek_id, event_type, fixture_id, fixture_name, player_name, competition, match_time)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [eventId, id, evDef.event_type, evDef.fixture_id, evDef.fixture_name,
       evDef.player_name || null, evDef.competition || null, evDef.match_time || null]
    )
    for (const opt of (evDef.options || [])) {
      if (!opt.energy_cost) continue
      await pool.query(
        "INSERT INTO event_options (id, event_id, label, energy_cost, result_key) VALUES ($1,$2,$3,$4,$5)",
        [uuidv4(), eventId, opt.label, opt.energy_cost, opt.result_key || null]
      )
    }
  }
  return ok({ gameweekId: id })
}

async function publishGameweek(event) {
  const { gameweek_id } = JSON.parse(event.body || "{}")
  if (!gameweek_id) return error(400, "gameweek_id is required")
  const pool = await getPool()

  const gwResult = await pool.query(
    "SELECT id, competition_id, week_number, sprint_id FROM gameweeks WHERE id=$1 AND status='DRAFT'",
    [gameweek_id]
  )
  if (!gwResult.rows.length) return error(404, "Gameweek not found or not DRAFT")
  const { competition_id, week_number, sprint_id } = gwResult.rows[0]

  await pool.query("UPDATE gameweeks SET status='PUBLISHED' WHERE id=$1", [gameweek_id])

  // If this gameweek belongs to a sprint that is still in draft, auto-promote it to
  // 'scheduled' so the glory handler (which queries live/scheduled sprints) can find it.
  // The admin can still explicitly activate to 'live' later to initialise sprint progress.
  let sprintAutoScheduled = false
  if (sprint_id) {
    const sprintRes = await pool.query(
      "SELECT id, status FROM sprints WHERE id=$1", [sprint_id]
    )
    if (sprintRes.rows.length && sprintRes.rows[0].status === 'draft') {
      await pool.query("UPDATE sprints SET status='scheduled' WHERE id=$1", [sprint_id])
      sprintAutoScheduled = true
    }
  }

  // Generate matchups for EVERY active league in this competition (competition-based gameweeks only)
  const leaguesResult = competition_id
    ? await pool.query("SELECT id FROM leagues WHERE competition_id=$1 AND status='ACTIVE'", [competition_id])
    : { rows: [] }

  let totalMatchups = 0

  for (const league of leaguesResult.rows) {
    const members = (await pool.query(
      "SELECT user_id FROM league_members WHERE league_id=$1 ORDER BY joined_at ASC",
      [league.id]
    )).rows.map(r => r.user_id)

    const n = members.length
    if (n < 2) continue

    const offset  = (week_number - 1) % Math.max(1, n - 1)
    const rotated = [members[0], ...members.slice(1).map((_, i) => members[1 + (i + offset) % (n - 1)])]

    for (let i = 0; i < Math.floor(n / 2); i++) {
      await pool.query(
        `INSERT INTO matchups (id, gameweek_id, home_user_id, away_user_id, status)
         VALUES ($1,$2,$3,$4,'PENDING')`,
        [uuidv4(), gameweek_id, rotated[i], rotated[n - 1 - i]]
      )
      totalMatchups++
    }
  }

  return ok({
    published: true,
    gameweek_id,
    sprint_id: sprint_id ?? null,
    sprint_auto_scheduled: sprintAutoScheduled,
    leagues_affected: leaguesResult.rows.length,
    matchupsCreated: totalMatchups
  })
}

// ── Lock gameweek (manual override) ──────────────────────────────────────────
async function lockGameweek(event) {
  const { id } = event.pathParameters
  const pool = await getPool()
  const gwRes = await pool.query("SELECT id, status FROM gameweeks WHERE id = $1", [id])
  if (!gwRes.rows.length) return error(404, "Gameweek not found")
  if (gwRes.rows[0].status !== 'PUBLISHED')
    return error(400, `Cannot lock a gameweek in ${gwRes.rows[0].status} status — must be PUBLISHED`)

  await pool.query("UPDATE gameweeks SET status = 'LOCKED' WHERE id = $1", [id])
  await pool.query(
    "UPDATE user_gameweek_entries SET status = 'locked' WHERE gameweek_id = $1 AND status = 'open'",
    [id]
  )
  return ok({ locked: true, gameweek_id: id })
}

// ── Unlock gameweek (reset LOCKED → PUBLISHED so picks can be resubmitted) ───
async function unlockGameweek(event) {
  const { id } = event.pathParameters
  const pool = await getPool()
  const gwRes = await pool.query("SELECT id, status FROM gameweeks WHERE id = $1", [id])
  if (!gwRes.rows.length) return error(404, "Gameweek not found")
  if (gwRes.rows[0].status !== 'LOCKED')
    return error(400, `Cannot unlock a gameweek in ${gwRes.rows[0].status} status — must be LOCKED`)

  // Only allow unlock if no picks have been scored yet
  const scoredPicks = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM user_picks up
     JOIN user_gameweek_entries uge ON uge.id = up.entry_id
     WHERE uge.gameweek_id = $1 AND up.pick_status IN ('WON','LOST')`,
    [id]
  )
  if (scoredPicks.rows[0].cnt > 0)
    return error(400, 'Cannot unlock — picks have already been scored')

  // Recalculate lock_time from events so the lifecycle won't immediately re-lock it
  const { rows: evs } = await pool.query(
    "SELECT match_time FROM events WHERE gameweek_id = $1 AND match_time IS NOT NULL ORDER BY match_time ASC", [id]
  )
  const newLockTime = evs.length > 0
    ? new Date(new Date(evs[0].match_time).getTime() - 15 * 60 * 1000).toISOString()
    : null

  await pool.query(
    `UPDATE gameweeks SET status = 'PUBLISHED'${newLockTime ? ', lock_time = $2, reveal_time = $2' : ''} WHERE id = $1`,
    newLockTime ? [id, newLockTime] : [id]
  )
  await pool.query(
    "UPDATE user_gameweek_entries SET status = 'open' WHERE gameweek_id = $1 AND status = 'locked'", [id]
  )
  return ok({ unlocked: true, gameweek_id: id, lock_time: newLockTime })
}

// ── Resolve gameweek (admin manual trigger, same logic as scoring/handler.js resolve) ──
async function resolveGameweek(event) {
  const { id: gameweek_id } = event.pathParameters
  const pool = await getPool()
  const gwRes = await pool.query("SELECT id FROM gameweeks WHERE id = $1 AND status = 'LOCKED'", [gameweek_id])
  if (!gwRes.rows.length) return error(404, "Gameweek not found or not in LOCKED status")

  const DONE = ['FT', 'AET', 'PEN', 'AWD', 'WO']

  const { rows: events } = await pool.query(
    "SELECT id, event_type, fixture_id, player_name FROM events WHERE gameweek_id = $1",
    [gameweek_id]
  )

  let skipped = 0
  for (const ev of events) {
    const fixture = ev.fixture_id
      ? (await pool.query("SELECT home_goals, away_goals, home_winner, away_winner, pen_home, pen_away, status_short FROM fixtures WHERE id=$1", [ev.fixture_id])).rows[0]
      : null
    if (!fixture) { skipped++; continue }
    if (!DONE.includes(fixture.status_short)) { skipped++; continue }

    let cornerTotal = null
    if (ev.event_type === 'CORNER_OVER') {
      const cs = await pool.query(
        `SELECT COALESCE(SUM(stat_value::int),0) AS total FROM fixture_statistics WHERE fixture_id=$1 AND stat_type='Corner Kicks'`,
        [ev.fixture_id]
      )
      cornerTotal = cs.rows[0]?.total ?? 0
    }

    let scorers = []
    if (ev.event_type === 'PLAYER_SCORE' && ev.player_name) {
      const pe = await pool.query(
        `SELECT player FROM fixture_events WHERE fixture_id=$1 AND type='Goal' AND (detail IS NULL OR detail NOT ILIKE '%own goal%')`,
        [ev.fixture_id]
      )
      scorers = pe.rows.map(r => r.player || '')
    }

    const { rows: options } = await pool.query(
      "SELECT id, label, result_key FROM event_options WHERE event_id = $1", [ev.id]
    )
    for (const opt of options) {
      // Re-use evaluateOption from scoring/handler.js logic (inlined here to avoid cross-require)
      const result = adminEvaluateOption(opt.result_key, opt.label, ev.event_type, fixture, cornerTotal, scorers, ev.player_name)
      await pool.query("UPDATE event_options SET result=$1 WHERE id=$2", [result, opt.id])
    }
  }

  // Score picks
  const { rows: picks } = await pool.query(
    `SELECT up.id AS pick_id, eo.result AS option_result FROM user_picks up
     JOIN event_options eo ON eo.id=up.event_option_id
     JOIN events e ON e.id=up.event_id WHERE e.gameweek_id=$1`, [gameweek_id]
  )
  for (const pick of picks) {
    await pool.query("UPDATE user_picks SET pick_status=$1 WHERE id=$2",
      [pick.option_result === 'WON' ? 'won' : 'lost', pick.pick_id])
  }

  await pool.query("UPDATE gameweeks SET status='FINISHED' WHERE id=$1", [gameweek_id])

  // Immediately settle entries and push LP + perfect week bonus to sprint totals.
  // settleSprint still runs later for division movement, but players see their score now.
  const entriesForGw = await pool.query(
    `SELECT uge.* FROM user_gameweek_entries uge
     WHERE uge.gameweek_id = $1 AND uge.status NOT IN ('completed', 'void')`,
    [gameweek_id]
  )

  let immediatelySettled = 0
  for (const entry of entriesForGw.rows) {
    const picksRes = await pool.query(
      `SELECT up.id, eo.result FROM user_picks up
       JOIN event_options eo ON eo.id = up.event_option_id
       WHERE up.entry_id = $1`,
      [entry.id]
    )
    const hasPending = picksRes.rows.some(p => p.result === 'PENDING')
    if (hasPending) continue

    const correct   = picksRes.rows.filter(p => p.result === 'WON').length
    const incorrect = picksRes.rows.filter(p => p.result === 'LOST').length
    const isPerfect = correct === 6
    const bonus     = isPerfect ? 4 : 0
    const lp        = correct + bonus

    await pool.query(
      `UPDATE user_gameweek_entries SET
         status='completed', correct_picks=$1, incorrect_picks=$2,
         league_points=$3, perfect_week_bonus=$4, is_perfect_week=$5, settled_at=NOW()
       WHERE id=$6`,
      [correct, incorrect, lp, bonus, isPerfect, entry.id]
    )

    if (entry.sprint_id) {
      await pool.query(
        `UPDATE user_sprint_progress SET
           total_correct_picks    = total_correct_picks + $1,
           total_incorrect_picks  = total_incorrect_picks + $2,
           total_league_points    = total_league_points + $3,
           perfect_weeks          = perfect_weeks + $4,
           gameweeks_participated = gameweeks_participated + 1
         WHERE user_id = $5 AND sprint_id = $6`,
        [correct, incorrect, lp, isPerfect ? 1 : 0, entry.user_id, entry.sprint_id]
      )
    }

    if (isPerfect) {
      await awardBadgeAdmin(pool, entry.user_id, 'PERFECT_WEEK', entry.sprint_id, gameweek_id)
    }
    immediatelySettled++
  }

  return ok({ resolved: true, gameweek_id, skipped_events: skipped, immediately_settled: immediatelySettled })
}

function adminEvaluateOption(rk, label, eventType, fixture, cornerTotal, scorers, playerName) {
  const lb = (label || '').toLowerCase()
  const h = fixture.home_goals ?? 0, a = fixture.away_goals ?? 0
  rk = rk || ''

  if (eventType === 'WHO_QUALIFIES') {
    const ph = fixture.pen_home ?? null
    const pa = fixture.pen_away ?? null
    const homeWins = fixture.home_winner === true
      || (fixture.home_winner == null && h > a)
      || (fixture.home_winner == null && h === a && ph != null && ph > pa)
    const awayWins = fixture.away_winner === true
      || (fixture.away_winner == null && a > h)
      || (fixture.away_winner == null && h === a && pa != null && pa > ph)
    if (rk === 'HOME_QUALIFIES') return homeWins ? 'WON' : 'LOST'
    if (rk === 'AWAY_QUALIFIES') return awayWins ? 'WON' : 'LOST'
  }
  if (eventType === 'MATCH_RESULT') {
    if (rk === 'HOME_WIN'  || lb === 'home win')  return h > a ? 'WON' : 'LOST'
    if (rk === 'AWAY_WIN'  || lb === 'away win')  return a > h ? 'WON' : 'LOST'
    if (rk === 'DRAW'      || lb === 'draw')       return h === a ? 'WON' : 'LOST'
  }
  if (eventType === 'GOALS') {
    const total = h + a, m = rk.match(/^(OVER|UNDER)_([\d.]+)$/)
    if (m) { const t = parseFloat(m[2]); return m[1]==='OVER' ? (total>t?'WON':'LOST') : (total<t?'WON':'LOST') }
  }
  if (eventType === 'BTTS') {
    const both = h > 0 && a > 0
    if (rk === 'BTTS_YES') return both ? 'WON' : 'LOST'
    if (rk === 'BTTS_NO')  return both ? 'LOST' : 'WON'
  }
  if (eventType === 'CLEAN_SHEET') {
    if (rk === 'HOME_CLEAN_SHEET') return a === 0 ? 'WON' : 'LOST'
    if (rk === 'AWAY_CLEAN_SHEET') return h === 0 ? 'WON' : 'LOST'
  }
  if (eventType === 'CORNER_OVER') {
    const total = cornerTotal ?? 0, m = rk.match(/^CORNER_(OVER|UNDER)_([\d.]+)$/)
    if (m) { const t = parseFloat(m[2]); return m[1]==='OVER' ? (total>t?'WON':'LOST') : (total<t?'WON':'LOST') }
  }
  if (eventType === 'PLAYER_SCORE' && playerName) {
    const scored = (scorers||[]).some(s => {
      const na = adminNorm(playerName), nb = adminNorm(s)
      return na && nb && (na===nb || nb.includes(na) || na.includes(nb) || adminLastName(na)===adminLastName(nb))
    })
    if (rk === 'PLAYER_SCORES')   return scored ? 'WON' : 'LOST'
    if (rk === 'PLAYER_NO_SCORE') return scored ? 'LOST' : 'WON'
  }
  return 'LOST'
}
function adminNorm(s) {
  return (s||'').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase().replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim()
}
function adminLastName(s) { const p=s.split(' ').filter(w=>w.length>1); return p[p.length-1]||'' }

// ── Odds ─────────────────────────────────────────────────────────────────────

async function getOddsForFixture(event) {
  const { fixture } = event.queryStringParameters || {}
  if (!fixture) return error(400, "fixture query param required")

  const secrets = await getSecrets()

  try {
    const res = await axios.get(`${API_FOOTBALL_BASE}/odds`, {
      params: { fixture, bookmaker: 1 },
      headers: { "x-apisports-key": secrets.key }
    })

    const bets = res.data?.response?.[0]?.bookmakers?.[0]?.bets ?? []
    const mwBet    = bets.find(b => b.name === "Match Winner")
    const goalsBet = bets.find(b => b.name === "Goals Over/Under")

    const process = (values) => (values || []).map(v => {
      const odd  = parseFloat(v.odd)
      const prob = 1 / odd
      return {
        label:       v.value,
        odd:         Math.round(odd * 100) / 100,
        prob:        Math.round(prob * 1000) / 1000,
        energy_cost: probToEnergyCost(prob),
      }
    })

    return ok({
      match_winner: process(mwBet?.values),
      goals_ou:     process(goalsBet?.values),
    })
  } catch (err) {
    console.error("Odds fetch failed:", err.message)
    return ok({ match_winner: [], goals_ou: [] })
  }
}

// ── Competitions ──────────────────────────────────────────────────────────────

function computeStatus(startDate, endDate) {
  const now = new Date()
  const start = new Date(startDate)
  const end = new Date(endDate)
  if (now < start) return "FUTURE"
  if (now > end) return "COMPLETED"
  return "IN_PROGRESS"
}

async function listCompetitions() {
  const pool = await getPool()
  const { rows } = await pool.query(`
    SELECT id, name, description, logo_url, cover_url,
           start_date, end_date, num_weeks, api_league_id, api_season, created_at
    FROM competitions ORDER BY start_date ASC
  `)
  return ok(rows.map(r => ({ ...r, status: computeStatus(r.start_date, r.end_date) })))
}

async function createCompetition(event) {
  const body = JSON.parse(event.body || "{}")
  const { name, description, logo_url, cover_url, start_date, end_date, num_weeks, api_league_id, api_season } = body
  if (!name || !start_date || !end_date || !num_weeks)
    return error(400, "name, start_date, end_date and num_weeks are required")
  if (new Date(end_date) <= new Date(start_date))
    return error(400, "end_date must be after start_date")

  const pool = await getPool()
  const id = uuidv4()
  await pool.query(
    `INSERT INTO competitions (id, name, description, logo_url, cover_url, start_date, end_date, num_weeks, api_league_id, api_season)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [id, name, description || null, logo_url || null, cover_url || null, start_date, end_date, num_weeks,
     api_league_id || null, api_season || null]
  )
  const { rows } = await pool.query("SELECT * FROM competitions WHERE id=$1", [id])
  return ok({ ...rows[0], status: computeStatus(rows[0].start_date, rows[0].end_date) }, 201)
}

async function updateCompetition(event) {
  const { id } = event.pathParameters
  const body = JSON.parse(event.body || "{}")
  const { name, description, logo_url, cover_url, start_date, end_date, num_weeks, api_league_id, api_season } = body

  const pool = await getPool()
  const existing = await pool.query("SELECT id FROM competitions WHERE id=$1", [id])
  if (!existing.rows.length) return error(404, "Competition not found")

  await pool.query(
    `UPDATE competitions SET
       name          = COALESCE($1, name),
       description   = COALESCE($2, description),
       logo_url      = COALESCE($3, logo_url),
       cover_url     = COALESCE($4, cover_url),
       start_date    = COALESCE($5, start_date),
       end_date      = COALESCE($6, end_date),
       num_weeks     = COALESCE($7, num_weeks),
       api_league_id = COALESCE($8, api_league_id),
       api_season    = COALESCE($9, api_season)
     WHERE id = $10`,
    [name || null, description || null, logo_url || null, cover_url || null,
     start_date || null, end_date || null, num_weeks || null,
     api_league_id || null, api_season || null, id]
  )
  const { rows } = await pool.query("SELECT * FROM competitions WHERE id=$1", [id])
  return ok({ ...rows[0], status: computeStatus(rows[0].start_date, rows[0].end_date) })
}

async function deleteCompetition(event) {
  const { id } = event.pathParameters
  const pool = await getPool()
  const existing = await pool.query("SELECT id FROM competitions WHERE id=$1", [id])
  if (!existing.rows.length) return error(404, "Competition not found")
  await pool.query("DELETE FROM competitions WHERE id=$1", [id])
  return ok({ deleted: true })
}

const FINISHED_STATUSES = ['FT', 'AET', 'PEN', 'AWD', 'WO']
const SIX_HOURS_MS = 6 * 60 * 60 * 1000

function fixtureRowToShape(row) {
  return {
    id:             row.id,
    date:           row.date,
    status_short:   row.status_short,
    status_long:    row.status_long,
    status_elapsed: row.status_elapsed,
    referee:        row.referee,
    venue_name:     row.venue_name,
    venue_city:     row.venue_city,
    home:           row.home_team,
    home_logo:      row.home_logo,
    home_winner:    row.home_winner,
    away:           row.away_team,
    away_logo:      row.away_logo,
    away_winner:    row.away_winner,
    home_goals:     row.home_goals,
    away_goals:     row.away_goals,
    ht_home:        row.ht_home,
    ht_away:        row.ht_away,
    et_home:        row.et_home,
    et_away:        row.et_away,
    pen_home:       row.pen_home,
    pen_away:       row.pen_away,
    round:          row.round,
    league_name:    row.league_name,
    api_league_id:  row.api_league_id,
  }
}

function apiFixtureToRow(f, competitionId) {
  return {
    id:             f.fixture.id,
    competition_id: competitionId,
    round:          f.league.round,
    date:           f.fixture.date,
    status_short:   f.fixture.status.short,
    status_long:    f.fixture.status.long,
    status_elapsed: f.fixture.status.elapsed ?? null,
    referee:        f.fixture.referee ?? null,
    venue_name:     f.fixture.venue?.name ?? null,
    venue_city:     f.fixture.venue?.city ?? null,
    home_team:      f.teams.home.name,
    home_logo:      f.teams.home.logo,
    home_winner:    f.teams.home.winner ?? null,
    away_team:      f.teams.away.name,
    away_logo:      f.teams.away.logo,
    away_winner:    f.teams.away.winner ?? null,
    home_goals:     f.goals.home ?? null,
    away_goals:     f.goals.away ?? null,
    ht_home:        f.score.halftime.home ?? null,
    ht_away:        f.score.halftime.away ?? null,
    et_home:        f.score.extratime?.home ?? null,
    et_away:        f.score.extratime?.away ?? null,
    pen_home:       f.score.penalty?.home ?? null,
    pen_away:       f.score.penalty?.away ?? null,
    league_name:    f.league.name ?? null,
    api_league_id:  f.league.id ?? null,
  }
}

async function upsertFixtures(pool, rows) {
  for (const r of rows) {
    await pool.query(`
      INSERT INTO fixtures (
        id, competition_id, round, date, status_short, status_long, status_elapsed,
        referee, venue_name, venue_city,
        home_team, home_logo, home_winner, away_team, away_logo, away_winner,
        home_goals, away_goals, ht_home, ht_away, et_home, et_away, pen_home, pen_away,
        league_name, api_league_id, updated_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
        $17,$18,$19,$20,$21,$22,$23,$24,$25,$26, NOW()
      )
      ON CONFLICT (id) DO UPDATE SET
        status_short=EXCLUDED.status_short, status_long=EXCLUDED.status_long,
        status_elapsed=EXCLUDED.status_elapsed, home_winner=EXCLUDED.home_winner,
        away_winner=EXCLUDED.away_winner, home_goals=EXCLUDED.home_goals,
        away_goals=EXCLUDED.away_goals, ht_home=EXCLUDED.ht_home, ht_away=EXCLUDED.ht_away,
        et_home=EXCLUDED.et_home, et_away=EXCLUDED.et_away,
        pen_home=EXCLUDED.pen_home, pen_away=EXCLUDED.pen_away,
        referee=EXCLUDED.referee,
        league_name=COALESCE(EXCLUDED.league_name, fixtures.league_name),
        api_league_id=COALESCE(EXCLUDED.api_league_id, fixtures.api_league_id),
        updated_at=NOW()
      `, [
        r.id, r.competition_id, r.round, r.date, r.status_short, r.status_long, r.status_elapsed,
        r.referee, r.venue_name, r.venue_city,
        r.home_team, r.home_logo, r.home_winner, r.away_team, r.away_logo, r.away_winner,
        r.home_goals, r.away_goals, r.ht_home, r.ht_away, r.et_home, r.et_away, r.pen_home, r.pen_away,
        r.league_name ?? null, r.api_league_id ?? null,
      ])
  }
}

function groupIntoRounds(fixtures) {
  const roundMap = {}
  for (const f of fixtures) {
    if (!roundMap[f.round]) roundMap[f.round] = []
    roundMap[f.round].push(f)
  }
  return Object.entries(roundMap)
    .map(([name, fxs]) => ({ name, fixtures: fxs.sort((a, b) => new Date(a.date) - new Date(b.date)) }))
    .sort((a, b) => {
      const numA = parseInt(a.name.match(/\d+/)?.[0] ?? '0')
      const numB = parseInt(b.name.match(/\d+/)?.[0] ?? '0')
      return numA - numB
    })
}

async function getCompetitionCalendar(event) {
  const { id } = event.pathParameters
  const pool = await getPool()

  const comp = await pool.query(
    "SELECT id, name, api_league_id, api_season FROM competitions WHERE id=$1", [id]
  )
  if (!comp.rows.length) return error(404, "Competition not found")
  const { api_league_id, api_season } = comp.rows[0]
  if (!api_league_id || !api_season)
    return error(422, "Competition has no API-Football league/season configured")

  // Load what we have cached
  const cached = await pool.query(
    "SELECT * FROM fixtures WHERE competition_id=$1 ORDER BY date ASC", [id]
  )
  const cachedRows = cached.rows

  // Decide which fixtures need a fresh API call:
  // - finished fixtures are never re-fetched
  // - non-finished fixtures are re-fetched if updated_at is older than 6h
  const staleOrMissing = cachedRows.length === 0 ||
    cachedRows.some(r =>
      !FINISHED_STATUSES.includes(r.status_short) &&
      (Date.now() - new Date(r.updated_at).getTime()) > SIX_HOURS_MS
    )

  if (staleOrMissing) {
    const secrets = await getSecrets()
    const res = await axios.get(`${API_FOOTBALL_BASE}/fixtures`, {
      params: { league: api_league_id, season: api_season },
      headers: { "x-apisports-key": secrets.key }
    })
    const apiErrors = res.data?.errors
    if (apiErrors && Object.keys(apiErrors).length > 0)
      return error(402, Object.values(apiErrors).join(' '))

    const apiFixtures = res.data?.response || []
    const rows = apiFixtures.map(f => apiFixtureToRow(f, id))
    await upsertFixtures(pool, rows)

    const shapes = rows.map(r => ({ ...fixtureRowToShape(r) }))
    return ok({ rounds: groupIntoRounds(shapes), total_fixtures: shapes.length, source: 'api' })
  }

  // All data fresh from cache
  const shapes = cachedRows.map(fixtureRowToShape)
  return ok({ rounds: groupIntoRounds(shapes), total_fixtures: shapes.length, source: 'cache' })
}

const ONE_HOUR_MS = 60 * 60 * 1000

async function getCompetitionStandings(event) {
  const { id } = event.pathParameters
  const pool = await getPool()
  const comp = await pool.query(
    "SELECT api_league_id, api_season FROM competitions WHERE id=$1", [id]
  )
  if (!comp.rows.length) return error(404, "Competition not found")
  const { api_league_id, api_season } = comp.rows[0]
  if (!api_league_id || !api_season)
    return error(422, "Competition has no API-Football league/season configured")

  // Check cache freshness
  const cached = await pool.query(
    "SELECT * FROM competition_standings WHERE competition_id=$1 ORDER BY group_name, rank", [id]
  )
  if (cached.rows.length > 0) {
    const age = Date.now() - new Date(cached.rows[0].updated_at).getTime()
    if (age < ONE_HOUR_MS) {
      const groups = buildStandingGroups(cached.rows)
      return ok({ groups, source: 'cache' })
    }
  }

  // Fetch fresh from API
  const secrets = await getSecrets()
  const res = await axios.get(`${API_FOOTBALL_BASE}/standings`, {
    params: { league: api_league_id, season: api_season },
    headers: { "x-apisports-key": secrets.key }
  })

  const apiErrors = res.data?.errors
  if (apiErrors && Object.keys(apiErrors).length > 0)
    return error(402, Object.values(apiErrors).join(' '))

  const leagueData = res.data?.response?.[0]?.league
  if (!leagueData) return ok({ groups: [] })

  // Persist: delete old, insert fresh
  await pool.query("DELETE FROM competition_standings WHERE competition_id=$1", [id])
  for (const group of (leagueData.standings || [])) {
    for (const entry of group) {
      await pool.query(`
        INSERT INTO competition_standings
          (competition_id,group_name,rank,team,team_logo,points,played,win,draw,lose,gf,ga,gd,form,description,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW())`,
        [id, entry.group ?? null, entry.rank, entry.team.name, entry.team.logo,
         entry.points, entry.all.played, entry.all.win, entry.all.draw, entry.all.lose,
         entry.all.goals.for, entry.all.goals.against, entry.goalsDiff,
         entry.form ?? null, entry.description ?? null]
      )
    }
  }

  const fresh = await pool.query(
    "SELECT * FROM competition_standings WHERE competition_id=$1 ORDER BY group_name, rank", [id]
  )
  return ok({ groups: buildStandingGroups(fresh.rows), source: 'api' })
}

function buildStandingGroups(rows) {
  const map = {}
  for (const r of rows) {
    const key = r.group_name ?? ''
    if (!map[key]) map[key] = []
    map[key].push({
      rank: r.rank, team: r.team, team_logo: r.team_logo,
      points: r.points, played: r.played, win: r.win, draw: r.draw, lose: r.lose,
      gf: r.gf, ga: r.ga, gd: r.gd, form: r.form, description: r.description,
    })
  }
  return Object.entries(map).map(([name, rows]) => ({ name: name || null, rows }))
}

async function getFixtureDetails(event) {
  const { fixtureId } = event.pathParameters
  const pool = await getPool()

  // Check if we have cached details
  const cached = await pool.query(
    "SELECT details_cached, status_short FROM fixtures WHERE id=$1", [fixtureId]
  )
  const isFinished = cached.rows.length > 0 && FINISHED_STATUSES.includes(cached.rows[0].status_short)

  if (cached.rows.length > 0 && cached.rows[0].details_cached) {
    const [evRows, stRows, liRows] = await Promise.all([
      pool.query("SELECT * FROM fixture_events WHERE fixture_id=$1 ORDER BY elapsed ASC, extra ASC NULLS LAST", [fixtureId]),
      pool.query("SELECT * FROM fixture_statistics WHERE fixture_id=$1", [fixtureId]),
      pool.query("SELECT * FROM fixture_lineups WHERE fixture_id=$1 ORDER BY is_substitute ASC, player_number ASC", [fixtureId]),
    ])

    const teamsEv = [...new Set(evRows.rows.map(r => r.team))]
    const events = evRows.rows.map(r => ({
      elapsed: r.elapsed, extra: r.extra, team: r.team, team_logo: r.team_logo,
      player: r.player, assist: r.assist, type: r.type, detail: r.detail, comments: r.comments,
    }))

    const statsTeams = [...new Set(stRows.rows.map(r => r.team))]
    const statistics = statsTeams.map(team => {
      const teamRows = stRows.rows.filter(r => r.team === team)
      return {
        team, team_logo: teamRows[0]?.team_logo,
        stats: teamRows.map(r => ({ type: r.stat_type, value: r.stat_value })),
      }
    })

    const lineupTeams = [...new Set(liRows.rows.map(r => r.team))]
    const lineups = lineupTeams.map(team => {
      const tRows = liRows.rows.filter(r => r.team === team)
      return {
        team, team_logo: tRows[0]?.team_logo, formation: tRows[0]?.formation, coach: tRows[0]?.coach,
        startXI:     tRows.filter(r => !r.is_substitute).map(p => ({ number: p.player_number, name: p.player_name, pos: p.player_pos, grid: p.player_grid })),
        substitutes: tRows.filter(r =>  r.is_substitute).map(p => ({ number: p.player_number, name: p.player_name, pos: p.player_pos })),
      }
    })

    return ok({ events, statistics, lineups, source: 'cache' })
  }

  // Fetch from API
  const secrets = await getSecrets()
  const headers = { "x-apisports-key": secrets.key }

  const [eventsRes, statsRes, lineupsRes] = await Promise.all([
    axios.get(`${API_FOOTBALL_BASE}/fixtures/events`,     { params: { fixture: fixtureId }, headers }),
    axios.get(`${API_FOOTBALL_BASE}/fixtures/statistics`, { params: { fixture: fixtureId }, headers }),
    axios.get(`${API_FOOTBALL_BASE}/fixtures/lineups`,    { params: { fixture: fixtureId }, headers }),
  ])

  const events = (eventsRes.data?.response || []).map(e => ({
    elapsed: e.time.elapsed, extra: e.time.extra ?? null,
    team: e.team.name, team_logo: e.team.logo,
    player: e.player.name, assist: e.assist?.name ?? null,
    type: e.type, detail: e.detail, comments: e.comments ?? null,
  }))

  const statistics = (statsRes.data?.response || []).map(t => ({
    team: t.team.name, team_logo: t.team.logo,
    stats: t.statistics.map(s => ({ type: s.type, value: s.value })),
  }))

  const lineups = (lineupsRes.data?.response || []).map(t => ({
    team: t.team.name, team_logo: t.team.logo,
    formation: t.formation ?? null, coach: t.coach?.name ?? null,
    startXI:     (t.startXI || []).map(p => ({ number: p.player.number, name: p.player.name, pos: p.player.pos, grid: p.player.grid })),
    substitutes: (t.substitutes || []).map(p => ({ number: p.player.number, name: p.player.name, pos: p.player.pos })),
  }))

  // Persist to cache if the match is finished
  if (isFinished) {
    for (const ev of events) {
      await pool.query(
        `INSERT INTO fixture_events (fixture_id,elapsed,extra,team,team_logo,player,assist,type,detail,comments)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [fixtureId, ev.elapsed, ev.extra, ev.team, ev.team_logo, ev.player, ev.assist, ev.type, ev.detail, ev.comments]
      )
    }
    for (const t of statistics) {
      for (const s of t.stats) {
        await pool.query(
          `INSERT INTO fixture_statistics (fixture_id,team,team_logo,stat_type,stat_value) VALUES ($1,$2,$3,$4,$5)`,
          [fixtureId, t.team, t.team_logo, s.type, s.value]
        )
      }
    }
    for (const t of lineups) {
      for (const p of t.startXI) {
        await pool.query(
          `INSERT INTO fixture_lineups (fixture_id,team,team_logo,formation,coach,is_substitute,player_number,player_name,player_pos,player_grid)
           VALUES ($1,$2,$3,$4,$5,false,$6,$7,$8,$9)`,
          [fixtureId, t.team, t.team_logo, t.formation, t.coach, p.number, p.name, p.pos, p.grid]
        )
      }
      for (const p of t.substitutes) {
        await pool.query(
          `INSERT INTO fixture_lineups (fixture_id,team,team_logo,formation,coach,is_substitute,player_number,player_name,player_pos,player_grid)
           VALUES ($1,$2,$3,$4,$5,true,$6,$7,$8,null)`,
          [fixtureId, t.team, t.team_logo, t.formation, t.coach, p.number, p.name, p.pos]
        )
      }
    }
    await pool.query("UPDATE fixtures SET details_cached=true, updated_at=NOW() WHERE id=$1", [fixtureId])
  }

  return ok({ events, statistics, lineups, source: 'api' })
}

async function getCompetitionGameweeks(event) {
  const { id } = event.pathParameters
  const pool = await getPool()
  const { rows } = await pool.query(`
    SELECT
      g.id, g.week_number, g.lock_time, g.reveal_time, g.status, g.created_at,
      COUNT(DISTINCT e.id)::int   AS event_count,
      COUNT(DISTINCT m.id)::int   AS matchup_count
    FROM gameweeks g
    LEFT JOIN events e  ON e.gameweek_id = g.id
    LEFT JOIN matchups m ON m.gameweek_id = g.id
    WHERE g.competition_id = $1
    GROUP BY g.id
    ORDER BY g.week_number ASC
  `, [id])
  return ok(rows)
}

// ══════════════════════════════════════════════════════════════════════════════
// OddsRivals – Divisions
// ══════════════════════════════════════════════════════════════════════════════

async function listDivisions() {
  const pool = await getPool()
  const { rows } = await pool.query(
    `SELECT d.*,
       (SELECT COUNT(*) FROM user_sprint_progress usp
        WHERE usp.division_id = d.id
        AND usp.sprint_id = (
          SELECT id FROM sprints
          WHERE status IN ('live','scheduled')
             OR (status = 'draft' AND EXISTS (
                   SELECT 1 FROM gameweeks g
                   WHERE g.sprint_id = sprints.id AND g.status IN ('PUBLISHED','LOCKED')
                 ))
          ORDER BY
            CASE WHEN status='live' THEN 0 WHEN status='scheduled' THEN 1 ELSE 2 END,
            start_date ASC
          LIMIT 1
        ))::int AS player_count
     FROM divisions d
     ORDER BY d.display_order ASC`
  )
  return ok(rows)
}

async function createDivision(event) {
  const b = JSON.parse(event.body || "{}")
  const {
    name, display_order, icon, badge_url,
    color_primary, color_secondary,
    is_initial, is_highest, allows_relegation,
    relegation_max_points, retention_min_points, retention_max_points, promotion_min_points,
  } = b
  if (!name || display_order == null || retention_max_points == null || promotion_min_points == null)
    return error(400, "name, display_order, retention_max_points, promotion_min_points are required")

  const pool = await getPool()
  const id = uuidv4()
  await pool.query(
    `INSERT INTO divisions
       (id,name,display_order,icon,badge_url,color_primary,color_secondary,
        is_initial,is_highest,allows_relegation,
        relegation_max_points,retention_min_points,retention_max_points,promotion_min_points)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [id, name, display_order, icon||null, badge_url||null,
     color_primary||'#6366f1', color_secondary||'#4f46e5',
     is_initial??false, is_highest??false, allows_relegation??true,
     relegation_max_points??null, retention_min_points??0, retention_max_points, promotion_min_points]
  )
  const { rows } = await pool.query("SELECT * FROM divisions WHERE id=$1", [id])
  return ok(rows[0], 201)
}

async function updateDivision(event) {
  const { id } = event.pathParameters
  const b = JSON.parse(event.body || "{}")
  const pool = await getPool()
  const existing = await pool.query("SELECT id FROM divisions WHERE id=$1", [id])
  if (!existing.rows.length) return error(404, "Division not found")

  await pool.query(
    `UPDATE divisions SET
       name                  = $1,
       display_order         = $2,
       icon                  = $3,
       badge_url             = $4,
       color_primary         = $5,
       color_secondary       = $6,
       is_initial            = $7,
       is_highest            = $8,
       allows_relegation     = $9,
       relegation_max_points = $10,
       retention_min_points  = $11,
       retention_max_points  = $12,
       promotion_min_points  = $13,
       is_active             = $14
     WHERE id=$15`,
    [
      b.name,
      b.display_order != null ? parseInt(b.display_order) : null,
      b.icon ?? null,
      b.badge_url || null,
      b.color_primary ?? null,
      b.color_secondary ?? null,
      b.is_initial ?? null,
      b.is_highest ?? null,
      b.allows_relegation ?? null,
      b.relegation_max_points != null ? parseInt(b.relegation_max_points) : null,
      b.retention_min_points != null ? parseInt(b.retention_min_points) : 0,
      b.retention_max_points != null ? parseInt(b.retention_max_points) : null,
      b.is_highest ? null : (b.promotion_min_points != null ? parseInt(b.promotion_min_points) : null),
      b.is_active ?? null,
      id,
    ]
  )
  const { rows } = await pool.query("SELECT * FROM divisions WHERE id=$1", [id])
  return ok(rows[0])
}

async function getDivisionUsers(event) {
  const { id } = event.pathParameters
  const pool = await getPool()
  const div = await pool.query("SELECT id FROM divisions WHERE id=$1", [id])
  if (!div.rows.length) return error(404, "Division not found")

  const { rows } = await pool.query(
    `SELECT u.id, u.email, u.display_name, u.avatar_url, u.created_at,
            uds.is_rookie, uds.assigned_at,
            (SELECT total_league_points FROM user_sprint_progress usp
             JOIN sprints s ON s.id=usp.sprint_id AND s.status='live'
             WHERE usp.user_id=u.id LIMIT 1) AS current_sprint_lp
     FROM user_division_status uds
     JOIN users u ON u.id=uds.user_id
     WHERE uds.division_id=$1
     ORDER BY u.display_name ASC`,
    [id]
  )
  return ok(rows)
}

// ══════════════════════════════════════════════════════════════════════════════
// OddsRivals – Sprints
// ══════════════════════════════════════════════════════════════════════════════

async function listSprints() {
  const pool = await getPool()
  const { rows } = await pool.query(
    `SELECT s.*,
       (SELECT COUNT(*) FROM gameweeks g WHERE g.sprint_id=s.id)::int AS linked_gameweeks,
       (SELECT COUNT(DISTINCT user_id) FROM user_sprint_progress WHERE sprint_id=s.id)::int AS participants
     FROM sprints s ORDER BY s.start_date DESC`
  )
  return ok(rows)
}

async function createSprint(event) {
  const b = JSON.parse(event.body || "{}")
  const { name, start_date, end_date, gameweek_count } = b
  if (!name || !start_date || !end_date)
    return error(400, "name, start_date, end_date are required")
  if (new Date(end_date) <= new Date(start_date))
    return error(400, "end_date must be after start_date")

  const pool = await getPool()
  const id = uuidv4()
  await pool.query(
    `INSERT INTO sprints (id, name, start_date, end_date, gameweek_count, status)
     VALUES ($1,$2,$3,$4,$5,'draft')`,
    [id, name, start_date, end_date, gameweek_count || 4]
  )
  const { rows } = await pool.query("SELECT * FROM sprints WHERE id=$1", [id])
  return ok(rows[0], 201)
}

async function getSprint(event) {
  const { id } = event.pathParameters
  const pool = await getPool()
  const sprintRes = await pool.query("SELECT * FROM sprints WHERE id=$1", [id])
  if (!sprintRes.rows.length) return error(404, "Sprint not found")
  const sprint = sprintRes.rows[0]

  const gwRes = await pool.query(
    `SELECT g.*,
       COUNT(DISTINCT e.id)::int AS event_count,
       COUNT(DISTINCT uge.id)::int AS entry_count
     FROM gameweeks g
     LEFT JOIN events e ON e.gameweek_id=g.id
     LEFT JOIN user_gameweek_entries uge ON uge.gameweek_id=g.id
     WHERE g.sprint_id=$1
     GROUP BY g.id
     ORDER BY g.sprint_week ASC`,
    [id]
  )

  // Attach events + options to each gameweek (needed for draft editing in admin)
  for (const gw of gwRes.rows) {
    const evRes = await pool.query(
      `SELECT e.id, e.event_type, e.fixture_id, e.fixture_name, e.player_name,
              e.competition, e.match_time,
              COALESCE(
                json_agg(json_build_object('id',o.id,'label',o.label,'energy_cost',o.energy_cost,'result_key',o.result_key)
                  ORDER BY o.id) FILTER (WHERE o.id IS NOT NULL),
                '[]'::json
              ) AS options
       FROM events e
       LEFT JOIN event_options o ON o.event_id=e.id
       WHERE e.gameweek_id=$1
       GROUP BY e.id
       ORDER BY e.match_time ASC`,
      [gw.id]
    )
    gw.events = evRes.rows
  }

  const statsRes = await pool.query(
    `SELECT
       COUNT(DISTINCT user_id)::int                     AS participants,
       COALESCE(SUM(total_correct_picks),0)::int        AS total_correct_picks,
       COALESCE(SUM(total_league_points),0)::int        AS total_league_points,
       COALESCE(SUM(perfect_weeks),0)::int              AS total_perfect_weeks,
       SUM(CASE WHEN sprint_outcome='promoted'  THEN 1 ELSE 0 END)::int AS promotions,
       SUM(CASE WHEN sprint_outcome='retained'  THEN 1 ELSE 0 END)::int AS retentions,
       SUM(CASE WHEN sprint_outcome='relegated' THEN 1 ELSE 0 END)::int AS relegations,
       SUM(CASE WHEN sprint_outcome='rookie'    THEN 1 ELSE 0 END)::int AS rookies
     FROM user_sprint_progress WHERE sprint_id=$1`,
    [id]
  )

  const maxSprintWeek = gwRes.rows.reduce((max, g) => Math.max(max, g.sprint_week || 0), 0)
  const effectiveGwCount = Math.max(sprint.gameweek_count || 4, maxSprintWeek)
  return ok({ ...sprint, gameweek_count: effectiveGwCount, gameweeks: gwRes.rows, stats: statsRes.rows[0] })
}

async function updateSprint(event) {
  const { id } = event.pathParameters
  const b = JSON.parse(event.body || "{}")
  const pool = await getPool()
  const existing = await pool.query("SELECT id FROM sprints WHERE id=$1", [id])
  if (!existing.rows.length) return error(404, "Sprint not found")

  // If setting end_date, enforce it cannot be before the last gameweek's end_date
  if (b.end_date) {
    const lastGw = await pool.query(
      `SELECT MAX(end_date) AS max_end FROM gameweeks WHERE sprint_id=$1 AND end_date IS NOT NULL`,
      [id]
    )
    const lastGwEnd = lastGw.rows[0]?.max_end
    if (lastGwEnd && new Date(b.end_date) < new Date(lastGwEnd)) {
      return error(400, `Sprint end_date cannot be before its last gameweek end_date (${new Date(lastGwEnd).toISOString()})`)
    }
  }

  await pool.query(
    `UPDATE sprints SET
       name           = COALESCE($1, name),
       start_date     = COALESCE($2, start_date),
       end_date       = COALESCE($3, end_date),
       status         = COALESCE($4, status),
       gameweek_count = COALESCE($5, gameweek_count)
     WHERE id=$6`,
    [b.name||null, b.start_date||null, b.end_date||null, b.status||null, b.gameweek_count??null, id]
  )
  const { rows } = await pool.query("SELECT * FROM sprints WHERE id=$1", [id])
  return ok(rows[0])
}

async function activateSprint(event) {
  const { id } = event.pathParameters
  const pool = await getPool()
  const sprint = await pool.query("SELECT * FROM sprints WHERE id=$1", [id])
  if (!sprint.rows.length) return error(404, "Sprint not found")
  if (!['draft','scheduled'].includes(sprint.rows[0].status))
    return error(400, "Sprint must be draft or scheduled to activate")

  // Validate has 4 published gameweeks
  const gws = await pool.query(
    "SELECT id FROM gameweeks WHERE sprint_id=$1 AND status='PUBLISHED'", [id]
  )
  if (gws.rows.length < 1)
    return error(400, "Sprint needs at least one published gameweek before activating")

  await pool.query("UPDATE sprints SET status='live' WHERE id=$1", [id])

  // Create sprint progress for all existing users who don't already have one
  const users = await pool.query("SELECT id FROM users WHERE role='user'")
  const divStatus = await pool.query(
    "SELECT user_id, division_id, is_rookie FROM user_division_status"
  )
  const divMap = {}
  for (const d of divStatus.rows) divMap[d.user_id] = d

  for (const u of users.rows) {
    const ds = divMap[u.id]
    if (!ds) continue
    await pool.query(
      `INSERT INTO user_sprint_progress (user_id, sprint_id, division_id, is_rookie, sprint_outcome)
       VALUES ($1,$2,$3,$4,'pending') ON CONFLICT (user_id,sprint_id) DO NOTHING`,
      [u.id, id, ds.division_id, ds.is_rookie]
    )
  }

  return ok({ activated: true, sprint_id: id })
}

async function addSprintGameweek(event) {
  const { id: sprintId } = event.pathParameters
  const b = JSON.parse(event.body || "{}")
  const { sprint_week, events: eventDefs, base_energy } = b

  if (!sprint_week || !Array.isArray(eventDefs))
    return error(400, "sprint_week and events are required")
  if (sprint_week < 1 || sprint_week > 10)
    return error(400, "sprint_week must be between 1 and 10")
  if (eventDefs.length > 15)
    return error(400, "Maximum 15 events allowed")

  // Auto-calculate lock_time: 15 minutes before earliest match_time
  const matchTimes = eventDefs
    .map(e => e.match_time ? new Date(e.match_time).getTime() : null)
    .filter(t => t !== null && !isNaN(t))
  const lock_time = matchTimes.length > 0
    ? new Date(Math.min(...matchTimes) - 15 * 60 * 1000).toISOString()
    : null

  // end_date for the gameweek = latest match_time + 2h (estimated full-time)
  const gwEndFromFixtures = matchTimes.length > 0
    ? new Date(Math.max(...matchTimes) + 2 * 60 * 60 * 1000)
    : null

  const pool = await getPool()
  const sprint = await pool.query("SELECT id, start_date, end_date FROM sprints WHERE id=$1", [sprintId])
  if (!sprint.rows.length) return error(404, "Sprint not found")

  // Default Mon-Sun dates: sprint.start_date is always a Monday, so offset by week index
  const sprintStart = new Date(sprint.rows[0].start_date)
  const defStart = new Date(sprintStart.getTime() + (sprint_week - 1) * 7 * 86400000)
  defStart.setUTCHours(0, 0, 0, 0)
  const defEnd = new Date(defStart.getTime() + 7 * 86400000 - 1000) // Sunday 23:59:59

  // If a DRAFT or PUBLISHED already exists for this week, update it in place
  // (DELETE would fail if user_badges/user_cards reference the gameweek without CASCADE)
  const existing = await pool.query(
    "SELECT id, status, start_date, end_date FROM gameweeks WHERE sprint_id=$1 AND sprint_week=$2",
    [sprintId, sprint_week]
  )

  // Resolve end_date: use stored date if manually set, otherwise last fixture + 2h, else Mon-Sun default
  const resolveGwEnd = (storedEnd) => {
    if (storedEnd) return storedEnd  // respect manual override
    if (gwEndFromFixtures) return gwEndFromFixtures.toISOString()
    return defEnd.toISOString()
  }

  let gwId
  if (existing.rows.length) {
    if (!['DRAFT', 'PUBLISHED'].includes(existing.rows[0].status))
      return error(409, `Sprint week ${sprint_week} already has a ${existing.rows[0].status} gameweek`)
    gwId = existing.rows[0].id
    const keepStart = existing.rows[0].start_date || defStart.toISOString()
    const keepEnd   = resolveGwEnd(existing.rows[0].end_date)
    const baseEnergyVal = (typeof base_energy === 'number' && base_energy >= 10 && base_energy <= 60) ? base_energy : 30
    if (lock_time) {
      await pool.query(
        `UPDATE gameweeks SET lock_time=$1, reveal_time=$1, status='DRAFT', base_energy=$3,
         start_date=COALESCE(start_date,$4), end_date=$5 WHERE id=$2`,
        [lock_time, gwId, baseEnergyVal, keepStart, keepEnd]
      )
    } else {
      await pool.query(
        `UPDATE gameweeks SET status='DRAFT', base_energy=$2,
         start_date=COALESCE(start_date,$3), end_date=$4 WHERE id=$1`,
        [gwId, baseEnergyVal, keepStart, keepEnd]
      )
    }
    // Clear user picks first (no CASCADE on user_picks.event_id → events)
    await pool.query("DELETE FROM user_picks WHERE gameweek_id=$1", [gwId])
    // Reset entries so users re-submit when re-published
    await pool.query(
      `UPDATE user_gameweek_entries SET status='open', picks_submitted=0 WHERE gameweek_id=$1`,
      [gwId]
    )
    // Remove old events (CASCADE deletes event_options)
    await pool.query("DELETE FROM events WHERE gameweek_id=$1", [gwId])
  } else {
    gwId = uuidv4()
    const baseEnergyVal = (typeof base_energy === 'number' && base_energy >= 10 && base_energy <= 60) ? base_energy : 30
    const gwEnd = resolveGwEnd(null)
    await pool.query(
      `INSERT INTO gameweeks (id, sprint_id, sprint_week, week_number, lock_time, reveal_time, status, base_energy, start_date, end_date)
       VALUES ($1,$2,$3,$3,$4,$4,'DRAFT',$5,$6,$7)`,
      [gwId, sprintId, sprint_week, lock_time, baseEnergyVal, defStart.toISOString(), gwEnd]
    )
  }

  // Ensure sprint end_date >= this gameweek's end_date
  const gwEndVal = resolveGwEnd(existing.rows[0]?.end_date || null)
  const sprintEnd = sprint.rows[0].end_date ? new Date(sprint.rows[0].end_date) : null
  if (gwEndVal && (!sprintEnd || new Date(gwEndVal) > sprintEnd)) {
    await pool.query(
      "UPDATE sprints SET end_date=$1 WHERE id=$2",
      [gwEndVal, sprintId]
    )
  }

  for (const evDef of eventDefs) {
    const eventId = uuidv4()
    await pool.query(
      `INSERT INTO events (id, gameweek_id, event_type, fixture_id, fixture_name, player_name, competition, match_time)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [eventId, gwId, evDef.event_type, evDef.fixture_id||null, evDef.fixture_name,
       evDef.player_name||null, evDef.competition||null, evDef.match_time||null]
    )
    for (const opt of (evDef.options || [])) {
      if (!opt.label) continue
      await pool.query(
        "INSERT INTO event_options (id, event_id, label, energy_cost, result_key) VALUES ($1,$2,$3,$4,$5)",
        [uuidv4(), eventId, opt.label, opt.energy_cost || 5, opt.result_key || null]
      )
    }
  }

  return ok({ gameweek_id: gwId, sprint_id: sprintId, sprint_week })
}

async function removeSprintGameweek(event) {
  const { id: sprintId, gwId } = event.pathParameters
  const pool = await getPool()
  const gw = await pool.query(
    "SELECT id FROM gameweeks WHERE id=$1 AND sprint_id=$2 AND status='DRAFT'", [gwId, sprintId]
  )
  if (!gw.rows.length) return error(404, "Gameweek not found or not editable")
  await pool.query("UPDATE gameweeks SET sprint_id=NULL, sprint_week=NULL WHERE id=$1", [gwId])
  return ok({ removed: true })
}

async function updateSprintGameweekDates(event) {
  const { id: sprintId, gwId } = event.pathParameters
  const { start_date, end_date } = JSON.parse(event.body || '{}')
  if (!start_date && !end_date) return error(400, "start_date or end_date required")
  const pool = await getPool()
  const gw = await pool.query(
    "SELECT id FROM gameweeks WHERE id=$1 AND sprint_id=$2", [gwId, sprintId]
  )
  if (!gw.rows.length) return error(404, "Gameweek not found")
  await pool.query(
    `UPDATE gameweeks SET
       start_date = COALESCE($1, start_date),
       end_date   = COALESCE($2, end_date)
     WHERE id=$3`,
    [start_date || null, end_date || null, gwId]
  )
  // Ensure sprint end_date >= this gameweek end_date
  if (end_date) {
    await pool.query(
      `UPDATE sprints SET end_date=$1 WHERE id=$2 AND (end_date IS NULL OR end_date < $1)`,
      [end_date, sprintId]
    )
  }
  const { rows } = await pool.query("SELECT * FROM gameweeks WHERE id=$1", [gwId])
  return ok(rows[0])
}

// ── Sprint Settlement ─────────────────────────────────────────────────────────
async function settleSprint(event, adminUser) {
  const { id } = event.pathParameters
  const pool = await getPool()

  const sprintRes = await pool.query("SELECT * FROM sprints WHERE id=$1", [id])
  if (!sprintRes.rows.length) return error(404, "Sprint not found")
  const sprint = sprintRes.rows[0]
  if (!['live','scheduled'].includes(sprint.status))
    return error(400, "Sprint must be live to settle")

  // Load all divisions ordered
  const divsRes = await pool.query(
    "SELECT * FROM divisions WHERE is_active=TRUE ORDER BY display_order ASC"
  )
  const divisions = divsRes.rows
  const divById   = {}
  const divByOrder = {}
  for (const d of divisions) { divById[d.id] = d; divByOrder[d.display_order] = d }

  // ── Step 1: Settle all user_picks per entry ──────────────────────────────
  const entriesRes = await pool.query(
    "SELECT * FROM user_gameweek_entries WHERE sprint_id=$1 AND status NOT IN ('completed','void')",
    [id]
  )

  let settledEntries = 0
  for (const entry of entriesRes.rows) {
    const picksRes = await pool.query(
      `SELECT up.id, eo.result FROM user_picks up
       JOIN event_options eo ON eo.id=up.event_option_id
       WHERE up.entry_id=$1`,
      [entry.id]
    )
    // Only settle if all options have a definitive result
    const hasPending = picksRes.rows.some(p => p.result === 'PENDING')
    if (hasPending) continue

    const correct   = picksRes.rows.filter(p => p.result === 'WON').length
    const incorrect = picksRes.rows.filter(p => p.result === 'LOST').length
    const isPerfect = correct === 6
    const bonus     = isPerfect ? 4 : 0
    const lp        = correct + bonus

    // Update individual pick statuses
    for (const p of picksRes.rows) {
      const status = p.result === 'WON' ? 'won' : p.result === 'LOST' ? 'lost' : 'void'
      await pool.query(
        "UPDATE user_picks SET pick_status=$1, settled_at=NOW() WHERE id=$2",
        [status, p.id]
      )
    }

    // Update entry
    await pool.query(
      `UPDATE user_gameweek_entries SET
         status='completed', correct_picks=$1, incorrect_picks=$2,
         league_points=$3, perfect_week_bonus=$4, is_perfect_week=$5, settled_at=NOW()
       WHERE id=$6`,
      [correct, incorrect, lp, bonus, isPerfect, entry.id]
    )

    if (isPerfect) {
      await awardBadgeAdmin(pool, entry.user_id, 'PERFECT_WEEK', id, entry.gameweek_id)
    }
    settledEntries++
  }

  // ── Step 2: Aggregate sprint-level totals per user ────────────────────────
  const aggregateRes = await pool.query(
    `SELECT
       uge.user_id,
       COALESCE(SUM(uge.correct_picks),0)::int         AS total_correct,
       COALESCE(SUM(uge.incorrect_picks),0)::int       AS total_incorrect,
       COALESCE(SUM(uge.league_points),0)::int         AS total_lp,
       COALESCE(SUM(CASE WHEN uge.is_perfect_week THEN 1 ELSE 0 END),0)::int AS perfect_weeks,
       COUNT(uge.id)::int                              AS gw_count
     FROM user_gameweek_entries uge
     WHERE uge.sprint_id=$1 AND uge.status='completed'
     GROUP BY uge.user_id`,
    [id]
  )

  // ── Step 3: Apply division rules ──────────────────────────────────────────
  let promotions = 0, retentions = 0, relegations = 0, rookies = 0
  for (const agg of aggregateRes.rows) {
    // Get sprint progress
    const progRes = await pool.query(
      "SELECT * FROM user_sprint_progress WHERE user_id=$1 AND sprint_id=$2",
      [agg.user_id, id]
    )
    if (!progRes.rows.length) continue
    const prog = progRes.rows[0]

    // Update aggregate totals
    await pool.query(
      `UPDATE user_sprint_progress SET
         total_correct_picks=$1, total_incorrect_picks=$2, total_league_points=$3,
         perfect_weeks=$4, gameweeks_participated=$5
       WHERE user_id=$6 AND sprint_id=$7`,
      [agg.total_correct, agg.total_incorrect, agg.total_lp, agg.perfect_weeks, agg.gw_count, agg.user_id, id]
    )

    // Rookies are not promoted/relegated
    if (prog.is_rookie) {
      await pool.query(
        "UPDATE user_sprint_progress SET sprint_outcome='rookie', final_division_id=$1, settled_at=NOW() WHERE user_id=$2 AND sprint_id=$3",
        [prog.division_id, agg.user_id, id]
      )
      // Next sprint they are no longer rookies
      await pool.query(
        "UPDATE user_division_status SET is_rookie=FALSE, updated_at=NOW() WHERE user_id=$1",
        [agg.user_id]
      )
      rookies++
      continue
    }

    const currentDiv = divById[prog.division_id]
    if (!currentDiv) continue

    const lp = agg.total_lp
    let outcome = 'retained'
    let newDivId = currentDiv.id

    if (!currentDiv.is_highest && lp >= currentDiv.promotion_min_points) {
      const nextDiv = divByOrder[currentDiv.display_order + 1]
      if (nextDiv) { outcome = 'promoted'; newDivId = nextDiv.id; promotions++ }
    } else if (currentDiv.allows_relegation &&
               currentDiv.relegation_max_points !== null &&
               lp <= currentDiv.relegation_max_points) {
      const prevDiv = divByOrder[currentDiv.display_order - 1]
      if (prevDiv) { outcome = 'relegated'; newDivId = prevDiv.id; relegations++ }
      else { retentions++ }
    } else {
      retentions++
    }

    // Update sprint progress
    await pool.query(
      "UPDATE user_sprint_progress SET sprint_outcome=$1, final_division_id=$2, settled_at=NOW() WHERE user_id=$3 AND sprint_id=$4",
      [outcome, newDivId, agg.user_id, id]
    )

    // Update user's active division
    await pool.query(
      "UPDATE user_division_status SET division_id=$1, updated_at=NOW() WHERE user_id=$2",
      [newDivId, agg.user_id]
    )

    // Record movement
    await pool.query(
      `INSERT INTO promotion_relegation_history (user_id,sprint_id,from_division_id,to_division_id,movement,league_points)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [agg.user_id, id, currentDiv.id, newDivId, outcome, lp]
    )

    // Award badges
    await settleBadges(pool, agg.user_id, outcome, newDivId, divById, id, agg.perfect_weeks)
  }

  // ── Step 4: Consistent Player badge ─────────────────────────────────────
  for (const agg of aggregateRes.rows) {
    if (agg.gw_count >= 4) {
      await awardBadgeAdmin(pool, agg.user_id, 'CONSISTENT_PLAYER', id, null)
    }
    if (agg.perfect_weeks >= 4) {
      await awardBadgeAdmin(pool, agg.user_id, 'PERFECT_MONTH', id, null)
    }
  }

  // ── Step 5: Division champion badges ─────────────────────────────────────
  const DIV_CHAMP_CODE = { 1: 'DIV_CHAMP_ACADEMY', 2: 'DIV_CHAMP_SUNDAY', 3: 'DIV_CHAMP_DIV3', 4: 'DIV_CHAMP_DIV2', 5: 'DIV_CHAMP_DIV1', 6: 'DIV_CHAMP_CHAMPIONS' }
  const divRankRes = await pool.query(
    `SELECT user_id, division_id
     FROM (
       SELECT usp.user_id, usp.division_id,
         RANK() OVER (PARTITION BY usp.division_id ORDER BY usp.total_league_points DESC, usp.total_correct_picks DESC) AS div_rank
       FROM user_sprint_progress usp
       WHERE usp.sprint_id = $1
     ) ranked
     WHERE div_rank = 1`,
    [id]
  )
  for (const row of divRankRes.rows) {
    const div = divById[row.division_id]
    if (!div) continue
    const code = DIV_CHAMP_CODE[div.display_order]
    if (code) await awardBadgeAdmin(pool, row.user_id, code, id, null)
  }

  // ── Step 5.5: Sprint Winner badge (global #1 across all divisions) ────────
  const globalWinnerRes = await pool.query(
    `SELECT user_id FROM (
       SELECT usp.user_id,
         RANK() OVER (ORDER BY usp.total_league_points DESC, usp.total_correct_picks DESC) AS overall_rank
       FROM user_sprint_progress usp
       WHERE usp.sprint_id = $1
     ) ranked
     WHERE overall_rank = 1`,
    [id]
  )
  for (const row of globalWinnerRes.rows) {
    await awardBadgeAdmin(pool, row.user_id, 'SPRINT_WINNER', id, null)
  }

  // ── Step 6: Finalize sprint ───────────────────────────────────────────────
  const ruleSnapshot = JSON.stringify(divisions)
  await pool.query(
    "UPDATE sprints SET status='completed', settled_at=NOW(), rule_snapshot=$1 WHERE id=$2",
    [ruleSnapshot, id]
  )

  // Audit log
  await pool.query(
    `INSERT INTO admin_audit_log (admin_user_id, action, entity_type, entity_id, details)
     VALUES ($1,'settle_sprint','sprint',$2,$3)`,
    [adminUser.id, id, JSON.stringify({ promotions, retentions, relegations, rookies, settledEntries })]
  )

  return ok({
    settled: true,
    sprint_id: id,
    settled_entries: settledEntries,
    users_processed: aggregateRes.rows.length,
    promotions, retentions, relegations, rookies,
  })
}

async function settleBadges(pool, userId, outcome, newDivId, divById, sprintId, perfectWeeks) {
  if (outcome === 'promoted') {
    // First promotion (only if they don't have it yet)
    const existing = await pool.query(
      "SELECT id FROM user_badges ub JOIN badges b ON b.id=ub.badge_id WHERE ub.user_id=$1 AND b.code='FIRST_PROMOTION'",
      [userId]
    )
    if (!existing.rows.length) {
      await awardBadgeAdmin(pool, userId, 'FIRST_PROMOTION', sprintId, null)
    } else {
      // Check for comeback (promoted after being relegated)
      const lastMove = await pool.query(
        "SELECT movement FROM promotion_relegation_history WHERE user_id=$1 ORDER BY created_at DESC LIMIT 2",
        [userId]
      )
      const moves = lastMove.rows.map(r => r.movement)
      if (moves[1] === 'relegated') {
        await awardBadgeAdmin(pool, userId, 'COMEBACK', sprintId, null)
      }
    }

    // Three promotions
    const promoCount = await pool.query(
      "SELECT COUNT(*) FROM promotion_relegation_history WHERE user_id=$1 AND movement='promoted'",
      [userId]
    )
    if (parseInt(promoCount.rows[0].count) >= 3) {
      const ex = await pool.query(
        "SELECT id FROM user_badges ub JOIN badges b ON b.id=ub.badge_id WHERE ub.user_id=$1 AND b.code='THREE_PROMOTIONS'",
        [userId]
      )
      if (!ex.rows.length) await awardBadgeAdmin(pool, userId, 'THREE_PROMOTIONS', sprintId, null)
    }

    // Reached elite divisions
    const newDiv = divById[newDivId]
    if (newDiv) {
      if (newDiv.display_order >= 5) await awardBadgeAdmin(pool, userId, 'REACHED_DIV1', sprintId, null)
      if (newDiv.is_highest)         await awardBadgeAdmin(pool, userId, 'REACHED_CHAMPIONS', sprintId, null)
    }
  }
}

async function awardBadgeAdmin(pool, userId, code, sprintId, gameweekId) {
  const badge = await pool.query(
    "SELECT id FROM badges WHERE code=$1 AND is_active=TRUE", [code]
  )
  if (!badge.rows.length) return
  await pool.query(
    "INSERT INTO user_badges (user_id,badge_id,sprint_id,gameweek_id) VALUES ($1,$2,$3,$4)",
    [userId, badge.rows[0].id, sprintId, gameweekId]
  ).catch(() => {})
}

// ── Rankings ──────────────────────────────────────────────────────────────────
async function getRankings(event) {
  const qs = event.queryStringParameters || {}
  const divisionId = qs.division_id
  const sprintId   = qs.sprint_id
  const week       = qs.week ? parseInt(qs.week, 10) : null

  const pool = await getPool()

  let sid = sprintId
  if (!sid) {
    const sp = await pool.query(
      `SELECT id FROM sprints
       WHERE status IN ('live','scheduled')
          OR (status = 'draft' AND EXISTS (
                SELECT 1 FROM gameweeks g WHERE g.sprint_id = sprints.id AND g.status IN ('PUBLISHED','LOCKED')
             ))
       ORDER BY
         CASE WHEN status='live' THEN 0 WHEN status='scheduled' THEN 1 ELSE 2 END,
         start_date ASC
       LIMIT 1`
    )
    sid = sp.rows[0]?.id
  }

  if (!sid) return ok({ rows: [], sprint: null })

  const sprint = await pool.query("SELECT * FROM sprints WHERE id=$1", [sid])

  if (week) {
    const { rows } = await pool.query(
      `SELECT
         uge.user_id, u.email, u.display_name,
         uge.league_points      AS total_league_points,
         uge.correct_picks      AS total_correct_picks,
         uge.incorrect_picks    AS total_incorrect_picks,
         uge.is_perfect_week,
         RANK() OVER (ORDER BY uge.league_points DESC, uge.correct_picks DESC) AS rank
       FROM user_gameweek_entries uge
       JOIN users u ON u.id=uge.user_id
       JOIN gameweeks g ON g.id=uge.gameweek_id
       WHERE uge.sprint_id=$1 AND g.sprint_week=$2
       ORDER BY uge.league_points DESC, uge.correct_picks DESC`,
      [sid, week]
    )
    return ok({ rows, sprint: sprint.rows[0] ?? null, division: null, week })
  }

  let where = "WHERE usp.sprint_id=$1"
  const params = [sid]
  if (divisionId) { where += " AND usp.division_id=$2"; params.push(divisionId) }

  const { rows } = await pool.query(
    `SELECT
       usp.user_id, u.email, u.display_name,
       usp.total_league_points, usp.total_correct_picks, usp.total_incorrect_picks,
       usp.perfect_weeks, usp.gameweeks_participated, usp.sprint_outcome, usp.is_rookie,
       d.name AS division_name, d.icon AS division_icon, d.color_primary,
       RANK() OVER (ORDER BY usp.total_league_points DESC, usp.total_correct_picks DESC) AS rank
     FROM user_sprint_progress usp
     JOIN users u ON u.id=usp.user_id AND u.role='user'
     JOIN divisions d ON d.id=usp.division_id
     ${where}
     ORDER BY usp.total_league_points DESC, usp.total_correct_picks DESC`,
    params
  )

  const divRes = divisionId
    ? await pool.query("SELECT * FROM divisions WHERE id=$1", [divisionId])
    : { rows: [null] }

  return ok({ rows, sprint: sprint.rows[0] ?? null, division: divRes.rows[0] ?? null })
}

// ── Available fixtures across all competitions (for sprint gameweek building) ─
async function getAvailableFixtures(event) {
  const qs = event.queryStringParameters || {}
  const { date_from, date_to } = qs
  if (!date_from || !date_to) return error(400, "date_from and date_to are required")

  const pool = await getPool()
  const { rows } = await pool.query(
    `SELECT f.id, f.home_team, f.away_team, f.date, f.status_short,
            f.home_goals, f.away_goals, f.round, f.competition_id,
            f.home_logo, f.away_logo,
            COALESCE(c.name, f.league_name) AS competition_name,
            COALESCE(c.api_league_id::integer, f.api_league_id) AS api_league_id
     FROM fixtures f
     LEFT JOIN competitions c ON c.id=f.competition_id
     WHERE f.date::date BETWEEN $1 AND $2
     ORDER BY f.date ASC`,
    [date_from.slice(0, 10), date_to.slice(0, 10)]
  )
  return ok(rows)
}

async function importFixturesByRange(event) {
  const b = JSON.parse(event.body || "{}")
  const { date_from, date_to } = b
  if (!date_from || !date_to) return error(400, "date_from and date_to are required")

  const dbFrom = date_from.slice(0, 10)
  const dbTo   = date_to.slice(0, 10)

  const pool = await getPool()
  const { rows: comps } = await pool.query(
    "SELECT id, api_league_id, api_season FROM competitions WHERE api_league_id IS NOT NULL AND api_season IS NOT NULL"
  )
  if (comps.length === 0)
    return ok({ imported: 0, message: "No competitions imported yet. Import competitions first from the Competitions page." })

  const secrets = await getSecrets()
  let totalImported = 0

  for (const comp of comps) {
    try {
      const res = await axios.get(`${API_FOOTBALL_BASE}/fixtures`, {
        params: { league: comp.api_league_id, season: comp.api_season, from: dbFrom, to: dbTo },
        headers: { "x-apisports-key": secrets.key },
        timeout: 10000,
      })
      const apiErrors = res.data?.errors
      if (apiErrors && Object.keys(apiErrors).length > 0) continue
      const apiFixtures = res.data?.response || []
      if (apiFixtures.length > 0) {
        const rows = apiFixtures.map(f => apiFixtureToRow(f, comp.id))
        await upsertFixtures(pool, rows)
        totalImported += rows.length
      }
    } catch (e) {
      console.error(`Sync failed for league ${comp.api_league_id}:`, e.message)
    }
  }

  return ok({ imported: totalImported, message: `Synced ${totalImported} fixtures from ${comps.length} competitions` })
}

async function browseCompetitions() {
  const pool = await getPool()
  const { rows: imported } = await pool.query(`
    SELECT c.id, c.api_league_id, c.api_season, c.name, c.logo_url, c.start_date, c.end_date,
      (SELECT COUNT(*)::int FROM fixtures f WHERE f.competition_id=c.id) AS fixture_count,
      (SELECT MAX(f.updated_at) FROM fixtures f WHERE f.competition_id=c.id) AS last_synced
    FROM competitions c
    WHERE c.api_league_id IS NOT NULL
  `)
  const importedByLeague = {}
  for (const c of imported) {
    const key = String(c.api_league_id)
    if (!importedByLeague[key]) importedByLeague[key] = []
    importedByLeague[key].push(c)
  }
  const result = CURATED_COMPETITIONS.map(c => ({
    ...c,
    logo_url: `https://media.api-sports.io/football/leagues/${c.api_league_id}.png`,
    imported: importedByLeague[String(c.api_league_id)] || [],
  }))
  return ok(result)
}

async function importCompetitionFromApi(event) {
  const b = JSON.parse(event.body || "{}")
  const { api_league_id, season } = b
  if (!api_league_id || !season) return error(400, "api_league_id and season are required")

  const secrets = await getSecrets()

  // 1. League metadata
  const leagueRes = await axios.get(`${API_FOOTBALL_BASE}/leagues`, {
    params: { id: api_league_id, season },
    headers: { "x-apisports-key": secrets.key },
    timeout: 10000,
  })
  const leagueErrors = leagueRes.data?.errors
  if (leagueErrors && Object.keys(leagueErrors).length > 0)
    return error(402, Object.values(leagueErrors).join(" "))

  const leagueData = leagueRes.data?.response?.[0]
  if (!leagueData) return error(404, `League ${api_league_id} not found for season ${season}`)

  const { league, country } = leagueData
  const seasonData = (leagueData.seasons || []).find(s => String(s.year) === String(season))
  const startDate  = seasonData?.start ? new Date(seasonData.start) : null
  const endDate    = seasonData?.end   ? new Date(seasonData.end)   : null
  const numWeeks   = startDate && endDate
    ? Math.round((endDate - startDate) / (7 * 86400000))
    : 38

  // 2. Upsert competition row
  const pool = await getPool()
  const existing = await pool.query(
    "SELECT id FROM competitions WHERE api_league_id=$1 AND api_season=$2",
    [String(api_league_id), String(season)]
  )
  let competitionId
  if (existing.rows.length > 0) {
    competitionId = existing.rows[0].id
    await pool.query(
      `UPDATE competitions SET name=$1, logo_url=$2, start_date=$3, end_date=$4, num_weeks=$5 WHERE id=$6`,
      [league.name, league.logo, startDate, endDate, numWeeks, competitionId]
    )
  } else {
    competitionId = uuidv4()
    await pool.query(
      `INSERT INTO competitions (id,name,logo_url,start_date,end_date,num_weeks,api_league_id,api_season)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [competitionId, league.name, league.logo, startDate, endDate, numWeeks,
       String(api_league_id), String(season)]
    )
  }

  // 3. Fetch all fixtures for this league+season
  const fixturesRes = await axios.get(`${API_FOOTBALL_BASE}/fixtures`, {
    params: { league: api_league_id, season },
    headers: { "x-apisports-key": secrets.key },
    timeout: 30000,
  })
  const fixtureErrors = fixturesRes.data?.errors
  if (fixtureErrors && Object.keys(fixtureErrors).length > 0)
    return error(402, Object.values(fixtureErrors).join(" "))

  const apiFixtures = fixturesRes.data?.response || []
  if (apiFixtures.length > 0) {
    const rows = apiFixtures.map(f => apiFixtureToRow(f, competitionId))
    await upsertFixtures(pool, rows)
  }

  // 4. Standings (optional — cups may not have them)
  let standingsCount = 0
  try {
    const standingsRes = await axios.get(`${API_FOOTBALL_BASE}/standings`, {
      params: { league: api_league_id, season },
      headers: { "x-apisports-key": secrets.key },
      timeout: 10000,
    })
    const leagueStandings = standingsRes.data?.response?.[0]?.league
    if (leagueStandings?.standings) {
      await pool.query("DELETE FROM competition_standings WHERE competition_id=$1", [competitionId])
      for (const group of leagueStandings.standings) {
        for (const entry of group) {
          await pool.query(`
            INSERT INTO competition_standings
              (competition_id,group_name,rank,team,team_logo,points,played,win,draw,lose,gf,ga,gd,form,description,updated_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW())`,
            [competitionId, entry.group ?? null, entry.rank, entry.team.name, entry.team.logo,
             entry.points, entry.all.played, entry.all.win, entry.all.draw, entry.all.lose,
             entry.all.goals.for, entry.all.goals.against, entry.goalsDiff,
             entry.form ?? null, entry.description ?? null]
          )
          standingsCount++
        }
      }
    }
  } catch (e) {
    console.log("Standings not available for this competition:", e.message)
  }

  return ok({
    competition_id: competitionId,
    name: league.name,
    logo_url: league.logo,
    fixtures_imported: apiFixtures.length,
    standings_imported: standingsCount,
    is_new: existing.rows.length === 0,
    message: `Imported ${apiFixtures.length} fixtures${standingsCount > 0 ? ` and ${standingsCount} standings entries` : ''}`,
  }, existing.rows.length > 0 ? 200 : 201)
}

// Re-fetches live results for all non-finished fixtures in a date range.
// Used to keep scores up to date without a full re-import.
async function refreshFixtureResults(event) {
  const b = JSON.parse(event.body || "{}")
  const { date_from, date_to } = b
  if (!date_from || !date_to) return error(400, "date_from and date_to are required")

  const pool = await getPool()

  // Find non-finished fixture IDs in the range
  const { rows: pending } = await pool.query(
    `SELECT DISTINCT f.id, f.api_league_id, c.api_season
     FROM fixtures f
     LEFT JOIN competitions c ON c.id = f.competition_id
     WHERE f.date::date BETWEEN $1 AND $2
       AND f.status_short NOT IN ('FT','AET','PEN','AWD','WO')
     LIMIT 100`,
    [date_from.slice(0, 10), date_to.slice(0, 10)]
  )

  if (pending.length === 0)
    return ok({ updated: 0, message: "All fixtures in this range are already finished" })

  const secrets = await getSecrets()
  let updated = 0

  // Fetch each fixture individually for live status
  for (const fx of pending) {
    try {
      const res = await axios.get(`${API_FOOTBALL_BASE}/fixtures`, {
        params: { id: fx.id },
        headers: { "x-apisports-key": secrets.key },
        timeout: 8000,
      })
      const apiErrors = res.data?.errors
      if (apiErrors && Object.keys(apiErrors).length > 0) continue
      const apiFixtures = res.data?.response || []
      if (apiFixtures.length > 0) {
        // Find the competition_id from our DB
        const comp = await pool.query(
          "SELECT id FROM competitions WHERE api_league_id=$1 AND api_season=$2",
          [String(apiFixtures[0].league.id), String(apiFixtures[0].league.season)]
        )
        const competitionId = comp.rows[0]?.id || null
        const rows = apiFixtures.map(f => apiFixtureToRow(f, competitionId))
        await upsertFixtures(pool, rows)
        updated += rows.length
      }
    } catch (e) {
      console.error(`Refresh failed for fixture ${fx.id}:`, e.message)
    }
  }

  return ok({ updated, pending: pending.length, message: `Refreshed ${updated}/${pending.length} fixtures` })
}

// Public — returns all fixtures for a given date grouped by competition.
// Auto-refreshes from API-Football when non-finished fixtures are stale (>5 min).
async function getPublicScores(event) {
  const qs    = event.queryStringParameters || {}
  const date  = (qs.date || "").slice(0, 10) || new Date().toISOString().slice(0, 10)
  const today = new Date().toISOString().slice(0, 10)
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10)

  const pool = await getPool()

  // Auto-refresh today's and yesterday's non-finished fixtures when stale
  if (date === today || date === yesterday) {
    try {
      const staleRes = await pool.query(
        `SELECT COUNT(*) AS cnt FROM fixtures f
         JOIN competitions c ON c.id = f.competition_id
         WHERE f.date::date = $1
           AND f.status_short NOT IN ('FT','AET','PEN','AWD','WO','PST','CANC','ABD')
           AND (f.updated_at IS NULL OR f.updated_at < NOW() - INTERVAL '5 minutes')`,
        [date]
      )
      if (parseInt(staleRes.rows[0].cnt) > 0) {
        const secrets = await getSecrets()
        const res = await axios.get(`${API_FOOTBALL_BASE}/fixtures`, {
          params: { date },
          headers: { "x-apisports-key": secrets.key },
          timeout: 12000,
        })
        const apiFixtures = res.data?.response || []
        if (apiFixtures.length > 0) {
          // Build competition_id map from existing DB records
          const leagueIds = [...new Set(apiFixtures.map(f => String(f.league.id)))]
          const compsRes  = await pool.query(
            `SELECT api_league_id, id FROM competitions WHERE api_league_id = ANY($1)`,
            [leagueIds]
          )
          const compMap = {}
          for (const c of compsRes.rows) compMap[c.api_league_id] = c.id

          // Only update fixtures belonging to imported competitions
          const rows = apiFixtures
            .filter(f => compMap[String(f.league.id)])
            .map(f => apiFixtureToRow(f, compMap[String(f.league.id)]))
          if (rows.length > 0) await upsertFixtures(pool, rows)
          console.log(`[scores] auto-refreshed ${rows.length}/${apiFixtures.length} fixtures for ${date}`)
        }
      }
    } catch (e) {
      // Fall through silently — return whatever is in the DB
      console.error('[scores] auto-refresh failed:', e.message)
    }
  }

  const { rows } = await pool.query(
    `SELECT f.id, f.home_team, f.away_team, f.date,
            f.status_short, f.status_long, f.status_elapsed,
            f.home_goals, f.away_goals, f.pen_home, f.pen_away, f.round,
            f.home_logo, f.away_logo,
            f.venue_name, f.venue_city,
            c.name AS competition_name,
            c.logo_url AS competition_logo,
            c.api_league_id::integer AS api_league_id
     FROM fixtures f
     JOIN competitions c ON c.id = f.competition_id
     WHERE f.date::date = $1
     ORDER BY
       CASE
         WHEN f.status_short IN ('1H','HT','2H','ET','BT','P','LIVE') THEN 0
         WHEN f.status_short = 'NS' THEN 1
         ELSE 2
       END,
       f.date ASC`,
    [date]
  )
  return ok(rows)
}

// ── Energy Pack CRUD ──────────────────────────────────────────────────────────
async function listEnergyPacks() {
  const pool = await getPool()
  const [packsRes, statsRes] = await Promise.all([
    pool.query(`SELECT * FROM energy_packs ORDER BY display_order ASC, price_euros ASC`),
    pool.query(`
      SELECT
        COALESCE(SUM(price_euros), 0)::float AS total_revenue,
        COUNT(DISTINCT user_id)::int         AS paying_users
      FROM energy_pack_purchases
    `),
  ])
  return ok({ packs: packsRes.rows, stats: statsRes.rows[0] })
}

function validatePackImage(image_url) {
  if (!image_url || image_url === '') return null          // allow clearing
  if (image_url.startsWith('http://') || image_url.startsWith('https://')) return image_url
  if (!image_url.startsWith('data:image/')) return 'INVALID_FORMAT'
  if (image_url.length > 400 * 1024) return 'TOO_LARGE'  // 400 KB cap for pack images
  return image_url
}

async function createEnergyPack(event) {
  const pool = await getPool()
  const { name, description, image_url, energy_amount, price_euros, discount_pct, is_active, display_order } = JSON.parse(event.body || '{}')
  if (!name || !energy_amount) return error(400, "name and energy_amount are required")
  const img = validatePackImage(image_url)
  if (img === 'INVALID_FORMAT') return error(400, "Invalid image format")
  if (img === 'TOO_LARGE')      return error(400, "Image too large (max 400 KB)")
  const { rows } = await pool.query(
    `INSERT INTO energy_packs (name, description, image_url, energy_amount, price_euros, discount_pct, is_active, display_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [name, description || null, img, energy_amount, price_euros ?? 0.99, discount_pct ?? 0, is_active !== false, display_order ?? 0]
  )
  return ok(rows[0])
}

async function updateEnergyPack(event) {
  const pool = await getPool()
  const { id } = event.pathParameters
  const { name, description, image_url, energy_amount, price_euros, discount_pct, is_active, display_order } = JSON.parse(event.body || '{}')
  const img = validatePackImage(image_url)
  if (img === 'INVALID_FORMAT') return error(400, "Invalid image format")
  if (img === 'TOO_LARGE')      return error(400, "Image too large (max 400 KB)")
  const { rows } = await pool.query(
    `UPDATE energy_packs SET
       name=$1, description=$2, image_url=$3, energy_amount=$4,
       price_euros=$5, discount_pct=$6, is_active=$7, display_order=$8
     WHERE id=$9 RETURNING *`,
    [name, description || null, img, energy_amount, price_euros, discount_pct, is_active, display_order, id]
  )
  if (!rows.length) return error(404, "Pack not found")
  return ok(rows[0])
}

async function deleteEnergyPack(event) {
  const pool = await getPool()
  const { id } = event.pathParameters
  await pool.query(`DELETE FROM energy_packs WHERE id=$1`, [id])
  return ok({ deleted: true })
}

// ── GET /public/gameweek — no auth, used by the landing page demo ─────────────
async function getPublicGameweek() {
  const pool = await getPool()

  // Find the current active gameweek (live sprint, published or locked)
  const gwRes = await pool.query(`
    SELECT g.*, s.name AS sprint_name, s.id AS sprint_id,
           s.start_date, s.end_date, s.status AS sprint_status
    FROM gameweeks g
    JOIN sprints s ON s.id = g.sprint_id
    WHERE s.status = 'live'
      AND g.status IN ('PUBLISHED', 'LOCKED')
    ORDER BY g.sprint_week DESC
    LIMIT 1
  `)

  if (!gwRes.rows.length) {
    // Fall back to the most recent published gameweek from any sprint
    const fallback = await pool.query(`
      SELECT g.*, s.name AS sprint_name, s.id AS sprint_id,
             s.start_date, s.end_date, s.status AS sprint_status
      FROM gameweeks g
      JOIN sprints s ON s.id = g.sprint_id
      WHERE g.status IN ('PUBLISHED', 'LOCKED')
      ORDER BY g.sprint_week DESC, g.created_at DESC
      LIMIT 1
    `)
    if (!fallback.rows.length) return ok(null)
    gwRes.rows = fallback.rows
  }

  const gw = gwRes.rows[0]

  // Events + options for this gameweek (result omitted so demo can't be spoiled)
  const evRes = await pool.query(`
    SELECT e.*,
           f.venue_name, f.venue_city,
           f.home_logo AS fixture_home_logo, f.away_logo AS fixture_away_logo
    FROM events e
    LEFT JOIN fixtures f ON e.fixture_id IS NOT NULL AND f.id = e.fixture_id::BIGINT
    WHERE e.gameweek_id = $1
    ORDER BY e.match_time ASC
  `, [gw.id])

  const optRes = await pool.query(`
    SELECT eo.id, eo.event_id, eo.label, eo.energy_cost
    FROM event_options eo
    JOIN events e ON e.id = eo.event_id
    WHERE e.gameweek_id = $1
  `, [gw.id])

  const optsByEvent = {}
  for (const o of optRes.rows) {
    if (!optsByEvent[o.event_id]) optsByEvent[o.event_id] = []
    optsByEvent[o.event_id].push({ id: o.id, label: o.label, energy_cost: o.energy_cost })
  }

  // Days left until lock
  const lockTime = gw.lock_time ? new Date(gw.lock_time) : null
  const daysLeft = lockTime
    ? Math.max(0, Math.ceil((lockTime - Date.now()) / 86400000))
    : null

  return ok({
    sprint: {
      id: gw.sprint_id,
      name: gw.sprint_name,
      status: gw.sprint_status,
      start_date: gw.start_date,
      end_date: gw.end_date,
    },
    gameweek: {
      id: gw.id,
      sprint_week: gw.sprint_week,
      status: gw.status,
      lock_time: gw.lock_time,
      reveal_time: gw.reveal_time,
      days_left: daysLeft,
    },
    events: evRes.rows.map(e => ({
      ...e,
      home_logo: e.fixture_home_logo || e.home_logo,
      away_logo: e.fixture_away_logo || e.away_logo,
      options: optsByEvent[e.id] ?? [],
    })),
  })
}

// ── POST /admin/sprints/{id}/recalculate ──────────────────────────────────────
// Recomputes league_points on all completed entries for a sprint and refreshes
// user_sprint_progress totals. Useful to fix sprints resolved by the lifecycle
// before entry totals were computed.
async function recalculateSprintEntries(event) {
  const { id: sprintId } = event.pathParameters
  const pool = await getPool()

  const sprintRes = await pool.query("SELECT id FROM sprints WHERE id=$1", [sprintId])
  if (!sprintRes.rows.length) return error(404, "Sprint not found")

  // Recompute league_points for every completed entry in this sprint
  const { rowCount: entriesFixed } = await pool.query(
    `UPDATE user_gameweek_entries uge SET
       correct_picks      = agg.correct,
       incorrect_picks    = agg.incorrect,
       is_perfect_week    = (agg.correct = 6 AND agg.correct + agg.incorrect = 6),
       perfect_week_bonus = CASE WHEN agg.correct = 6 AND agg.correct + agg.incorrect = 6 THEN 4 ELSE 0 END,
       league_points      = agg.correct + CASE WHEN agg.correct = 6 AND agg.correct + agg.incorrect = 6 THEN 4 ELSE 0 END
     FROM (
       SELECT up.entry_id,
         COUNT(*) FILTER (WHERE up.pick_status = 'won')::int  AS correct,
         COUNT(*) FILTER (WHERE up.pick_status = 'lost')::int AS incorrect
       FROM user_picks up
       JOIN user_gameweek_entries uge2 ON uge2.id = up.entry_id
       WHERE uge2.sprint_id = $1 AND uge2.status = 'completed'
       GROUP BY up.entry_id
     ) agg
     WHERE uge.id = agg.entry_id AND uge.sprint_id = $1`,
    [sprintId]
  )

  // Recompute user_sprint_progress totals from settled entries
  const { rowCount: progressFixed } = await pool.query(
    `UPDATE user_sprint_progress usp SET
       total_correct_picks    = agg.total_correct,
       total_incorrect_picks  = agg.total_incorrect,
       total_league_points    = agg.total_lp,
       perfect_weeks          = agg.perfect_weeks,
       gameweeks_participated = agg.gw_count
     FROM (
       SELECT uge.user_id,
         COALESCE(SUM(uge.correct_picks), 0)::int                AS total_correct,
         COALESCE(SUM(uge.incorrect_picks), 0)::int              AS total_incorrect,
         COALESCE(SUM(uge.league_points), 0)::int                AS total_lp,
         COUNT(*) FILTER (WHERE uge.is_perfect_week = true)::int AS perfect_weeks,
         COUNT(*)::int                                            AS gw_count
       FROM user_gameweek_entries uge
       WHERE uge.sprint_id = $1 AND uge.status = 'completed'
       GROUP BY uge.user_id
     ) agg
     WHERE usp.user_id = agg.user_id AND usp.sprint_id = $1`,
    [sprintId]
  )

  return ok({ sprint_id: sprintId, entries_fixed: entriesFixed, progress_rows_fixed: progressFixed })
}

// ── GET /admin/debug/divisions ────────────────────────────────────────────────
async function debugDivisions(event) {
  const pool = await getPool()

  const { rows: divs } = await pool.query(
    "SELECT id, name, display_order, promotion_min_points, relegation_max_points, allows_relegation, is_highest FROM divisions WHERE is_active=TRUE ORDER BY display_order"
  )
  const { rows: uds } = await pool.query(
    `SELECT uds.user_id, u.email, d.name AS division, d.display_order
     FROM user_division_status uds
     JOIN users u ON u.id = uds.user_id AND u.role = 'user'
     JOIN divisions d ON d.id = uds.division_id
     ORDER BY d.display_order, u.email`
  )
  const { rows: sprints } = await pool.query(
    "SELECT id, name, status FROM sprints WHERE status NOT IN ('archived') ORDER BY start_date DESC LIMIT 5"
  )
  const { rows: pending } = await pool.query(
    `SELECT usp.user_id, u.email, s.name AS sprint, d.name AS division, usp.sprint_outcome, usp.settled_at
     FROM user_sprint_progress usp
     JOIN sprints s ON s.id = usp.sprint_id
     JOIN users u ON u.id = usp.user_id AND u.role = 'user'
     JOIN divisions d ON d.id = usp.division_id
     WHERE s.status = 'completed' AND usp.sprint_outcome = 'pending'
     ORDER BY s.start_date DESC, u.email`
  )
  const { rows: currentProgress } = await pool.query(
    `SELECT usp.user_id, u.email, s.name AS sprint, s.status AS sprint_status, d.name AS division, usp.sprint_outcome
     FROM user_sprint_progress usp
     JOIN sprints s ON s.id = usp.sprint_id
     JOIN users u ON u.id = usp.user_id AND u.role = 'user'
     JOIN divisions d ON d.id = usp.division_id
     WHERE s.status NOT IN ('completed', 'archived')
     ORDER BY s.start_date DESC, u.email`
  )

  return ok({ divisions: divs, user_division_status: uds, recent_sprints: sprints, pending_settlement: pending, current_sprint_progress: currentProgress })
}

// ── POST /admin/debug/fix-divisions ──────────────────────────────────────────
// Directly promote all users from Academy (display_order=1) to Sunday League (display_order=2)
// in user_division_status and all non-completed sprint progress rows.
async function resettleEvent(event) {
  const { id: eventId } = event.pathParameters
  const pool = await getPool()

  // 1. Fetch the event with its fixture and sprint context
  const evRes = await pool.query(
    `SELECT e.id, e.event_type, e.fixture_id, e.gameweek_id,
            g.sprint_id,
            f.id AS fid, f.competition_id,
            f.home_goals, f.away_goals, f.home_winner, f.away_winner,
            f.pen_home, f.pen_away
     FROM events e
     JOIN gameweeks g ON g.id = e.gameweek_id
     LEFT JOIN fixtures f ON f.id = e.fixture_id
     WHERE e.id = $1`,
    [eventId]
  )
  if (!evRes.rows.length) return error(404, "Event not found")
  const ev = evRes.rows[0]
  if (!ev.fixture_id) return error(400, "Event has no linked fixture — cannot re-settle")

  // 2. Force-refresh fixture from API-Football (regardless of status)
  let fixture = ev
  try {
    const secrets = await getSecrets()
    const res = await axios.get(`${API_FOOTBALL_BASE}/fixtures`, {
      params: { id: ev.fixture_id },
      headers: { "x-apisports-key": secrets.key },
      timeout: 8000,
    })
    const apiFixtures = res.data?.response || []
    if (apiFixtures.length > 0) {
      const row = apiFixtureToRow(apiFixtures[0], ev.competition_id)
      await upsertFixtures(pool, [row])
      // Re-fetch updated fixture from DB
      const fxRes = await pool.query(
        `SELECT home_goals, away_goals, home_winner, away_winner, pen_home, pen_away
         FROM fixtures WHERE id = $1`, [ev.fixture_id]
      )
      if (fxRes.rows.length) fixture = { ...ev, ...fxRes.rows[0] }
      console.log(`[resettle] refreshed fixture ${ev.fixture_id}: ${JSON.stringify(fxRes.rows[0])}`)
    }
  } catch (e) {
    console.error(`[resettle] fixture refresh failed, using DB data:`, e.message)
  }

  // 3. Fetch all event_options for this event
  const optRes = await pool.query(
    `SELECT eo.id, eo.result_key, eo.label, eo.result
     FROM event_options eo WHERE eo.event_id = $1`,
    [eventId]
  )
  if (!optRes.rows.length) return error(400, "No event options found")

  // 4. Re-evaluate each option
  let optionsUpdated = 0
  let wonOptionId = null

  for (const opt of optRes.rows) {
    const newResult = adminEvaluateOption(opt.result_key, opt.label, ev.event_type, fixture, null, [], null)
    await pool.query(
      `UPDATE event_options SET result = $1 WHERE id = $2`,
      [newResult, opt.id]
    )
    if (newResult === 'WON') wonOptionId = opt.id
    optionsUpdated++
    console.log(`[resettle] option ${opt.id} (${opt.result_key}): ${opt.result} → ${newResult}`)
  }

  // 5. Re-update user_picks for all picks on this event
  const { rowCount: wonPicks } = await pool.query(
    `UPDATE user_picks up SET pick_status = 'won'
     FROM event_options eo
     WHERE eo.id = up.event_option_id AND eo.event_id = $1 AND eo.result = 'WON'`,
    [eventId]
  )
  const { rowCount: lostPicks } = await pool.query(
    `UPDATE user_picks up SET pick_status = 'lost'
     FROM event_options eo
     WHERE eo.id = up.event_option_id AND eo.event_id = $1 AND eo.result = 'LOST'`,
    [eventId]
  )

  // 6. Recalculate gameweek entries and sprint progress for the affected sprint
  const sprintId = ev.sprint_id
  const { rowCount: entriesFixed } = await pool.query(
    `UPDATE user_gameweek_entries uge SET
       correct_picks      = agg.correct,
       incorrect_picks    = agg.incorrect,
       is_perfect_week    = (agg.correct = 6 AND agg.correct + agg.incorrect = 6),
       perfect_week_bonus = CASE WHEN agg.correct = 6 AND agg.correct + agg.incorrect = 6 THEN 4 ELSE 0 END,
       league_points      = agg.correct + CASE WHEN agg.correct = 6 AND agg.correct + agg.incorrect = 6 THEN 4 ELSE 0 END
     FROM (
       SELECT up.entry_id,
         COUNT(*) FILTER (WHERE up.pick_status = 'won')::int  AS correct,
         COUNT(*) FILTER (WHERE up.pick_status = 'lost')::int AS incorrect
       FROM user_picks up
       JOIN user_gameweek_entries uge2 ON uge2.id = up.entry_id
       WHERE uge2.sprint_id = $1 AND uge2.status = 'completed'
       GROUP BY up.entry_id
     ) agg
     WHERE uge.id = agg.entry_id AND uge.sprint_id = $1`,
    [sprintId]
  )

  const { rowCount: progressFixed } = await pool.query(
    `UPDATE user_sprint_progress usp SET
       total_correct_picks    = agg.total_correct,
       total_incorrect_picks  = agg.total_incorrect,
       total_league_points    = agg.total_lp,
       perfect_weeks          = agg.perfect_weeks,
       gameweeks_participated = agg.gw_count
     FROM (
       SELECT uge.user_id,
         COALESCE(SUM(uge.correct_picks), 0)::int                AS total_correct,
         COALESCE(SUM(uge.incorrect_picks), 0)::int              AS total_incorrect,
         COALESCE(SUM(uge.league_points), 0)::int                AS total_lp,
         COUNT(*) FILTER (WHERE uge.is_perfect_week = true)::int AS perfect_weeks,
         COUNT(*)::int                                            AS gw_count
       FROM user_gameweek_entries uge
       WHERE uge.sprint_id = $1 AND uge.status = 'completed'
       GROUP BY uge.user_id
     ) agg
     WHERE usp.user_id = agg.user_id AND usp.sprint_id = $1`,
    [sprintId]
  )

  return ok({
    event_id:       eventId,
    fixture_id:     ev.fixture_id,
    fixture_data:   { home_goals: fixture.home_goals, away_goals: fixture.away_goals, home_winner: fixture.home_winner, away_winner: fixture.away_winner, pen_home: fixture.pen_home, pen_away: fixture.pen_away },
    options_updated: optionsUpdated,
    won_option_id:  wonOptionId,
    picks_won:      wonPicks,
    picks_lost:     lostPicks,
    entries_fixed:  entriesFixed,
    progress_fixed: progressFixed,
    sprint_id:      sprintId,
  })
}

async function fixDivisions(event) {
  const pool = await getPool()

  const { rows: divs } = await pool.query("SELECT id, display_order FROM divisions WHERE is_active=TRUE ORDER BY display_order")
  const academy    = divs.find(d => d.display_order === 1)
  const sundayLeague = divs.find(d => d.display_order === 2)
  if (!academy || !sundayLeague) return error(400, "Divisions not found")

  // 1. Mark all pending June sprint records as promoted
  const { rowCount: settled } = await pool.query(
    `UPDATE user_sprint_progress usp
     SET sprint_outcome = 'promoted', final_division_id = $2, settled_at = NOW(),
         total_league_points = COALESCE(usp.total_league_points, 0),
         total_correct_picks = COALESCE(usp.total_correct_picks, 0),
         total_incorrect_picks = COALESCE(usp.total_incorrect_picks, 0)
     FROM sprints s
     JOIN users u ON u.id = usp.user_id AND u.role = 'user'
     WHERE usp.sprint_id = s.id AND s.status = 'completed'
       AND usp.division_id = $1
       AND (usp.sprint_outcome = 'pending' OR usp.sprint_outcome = 'retained')
       AND usp.settled_at IS NULL`,
    [academy.id, sundayLeague.id]
  )

  // 2. Update user_division_status to Sunday League for all users still in Academy
  const { rowCount: statusFixed } = await pool.query(
    `UPDATE user_division_status SET division_id = $1, updated_at = NOW()
     WHERE division_id = $2
       AND user_id IN (SELECT id FROM users WHERE role = 'user')`,
    [sundayLeague.id, academy.id]
  )

  // 3. Update all non-completed sprint progress rows from Academy to Sunday League
  const { rowCount: progressFixed } = await pool.query(
    `UPDATE user_sprint_progress usp
     SET division_id = $1
     FROM sprints s
     JOIN users u ON u.id = usp.user_id AND u.role = 'user'
     WHERE usp.sprint_id = s.id
       AND s.status NOT IN ('completed', 'archived')
       AND usp.division_id = $2`,
    [sundayLeague.id, academy.id]
  )

  return ok({ settled, statusFixed, progressFixed })
}
