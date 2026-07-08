const axios                = require("axios")
const { getPool }          = require("../../shared/db")
const { getSecrets }       = require("../../shared/ssm")
const { verifyToken, extractFromEvent } = require("../../shared/auth")
const { ok, error, unauthorized } = require("../../shared/response")
const { v4: uuidv4 }       = require("uuid")

const API_FOOTBALL_BASE    = "https://v3.football.api-sports.io"
const FINISHED_STATUSES    = ['FT', 'AET', 'PEN', 'AWD', 'WO']
const LIVE_STATUSES        = ['1H', 'HT', '2H', 'ET', 'BT', 'P', 'SUSP', 'INT', 'LIVE']

exports.handler = async (event) => {
  const routeKey = event.routeKey

  let user
  try {
    const payload = await verifyToken(extractFromEvent(event))
    user = { ...payload, id: payload.id || payload.userId }
  } catch {
    return unauthorized()
  }

  try {
    if (routeKey === "GET /glory/status")                    return await getGloryStatus(event, user)
    if (routeKey === "GET /glory/gameweek")                  return await getCurrentGameweek(event, user)
    if (routeKey === "GET /glory/gameweek/{id}")             return await getGameweek(event, user)
    if (routeKey === "POST /glory/gameweek/{id}/picks")      return await submitPicks(event, user)
    if (routeKey === "GET /glory/gameweek/{id}/picks")       return await getMyPicks(event, user)
    if (routeKey === "GET /glory/profile")                   return await getProfile(event, user)
    if (routeKey === "GET /glory/leaderboard")               return await getLeaderboard(event, user)
    if (routeKey === "GET /glory/sprints")                   return await listActiveSprints(event, user)
    if (routeKey === "GET /glory/sprints/my")                 return await myRelevantSprints(event, user)
    if (routeKey === "GET /glory/sprints/{id}")               return await getSprintDetail(event, user)
    if (routeKey === "GET /glory/divisions")                  return await listDivisions(event, user)
    if (routeKey === "GET /glory/gameweek/{id}/community")    return await getCommunityPicks(event, user)
    if (routeKey === "GET /glory/users/{id}")                 return await getPublicProfile(event, user)
    if (routeKey === "GET /glory/fixtures/{id}/stats")        return await getFixtureStats(event, user)
    if (routeKey === "GET /glory/fixtures/{id}/form")         return await getFixtureForm(event, user)
    if (routeKey === "GET /glory/gameweek/{id}/live")              return await getGameweekLive(event, user)
    if (routeKey === "GET /glory/energy-packs")                   return await listEnergyPacks(event, user)
    if (routeKey === "POST /glory/energy-packs/{id}/purchase")    return await purchaseEnergyPack(event, user)
    if (routeKey === "GET /glory/purchase-history")               return await getPurchaseHistory(event, user)
    if (routeKey === "POST /glory/sprints/{id}/mark-popup-seen") return await markSprintPopupSeen(event, user)
    if (routeKey === "GET /glory/sprints/{id}/picks")            return await getMySprintPicks(event, user)
    if (routeKey === "GET /glory/users/{id}/sprints/{sprintId}/picks") return await getUserSprintPicks(event, user)
    return error(404, "Not found")
  } catch (err) {
    console.error(err)
    return error(500, "Internal server error")
  }
}

// ── Ensure user has a division status (auto-assign Academy for new users) ─────
async function ensureDivisionStatus(pool, userId) {
  const existing = await pool.query(
    "SELECT uds.*, d.name as division_name, d.icon, d.color_primary, d.display_order FROM user_division_status uds JOIN divisions d ON d.id=uds.division_id WHERE uds.user_id=$1",
    [userId]
  )
  if (existing.rows.length) return existing.rows[0]

  const academy = await pool.query("SELECT id FROM divisions WHERE is_initial=TRUE LIMIT 1")
  if (!academy.rows.length) return null
  const divId = academy.rows[0].id

  const activeSprint = await pool.query(
    "SELECT id FROM sprints WHERE status IN ('live','scheduled') ORDER BY start_date ASC LIMIT 1"
  )
  const rookieUntilId = activeSprint.rows[0]?.id ?? null

  await pool.query(
    `INSERT INTO user_division_status (user_id, division_id, is_rookie, rookie_until_sprint_id)
     VALUES ($1,$2,TRUE,$3) ON CONFLICT (user_id) DO NOTHING`,
    [userId, divId, rookieUntilId]
  )

  const fresh = await pool.query(
    "SELECT uds.*, d.name as division_name, d.icon, d.color_primary, d.display_order FROM user_division_status uds JOIN divisions d ON d.id=uds.division_id WHERE uds.user_id=$1",
    [userId]
  )
  return fresh.rows[0] ?? null
}

// ── Ensure sprint progress record exists for user+sprint ─────────────────────
async function ensureSprintProgress(pool, userId, sprintId, divisionId, isRookie) {
  await pool.query(
    `INSERT INTO user_sprint_progress (user_id, sprint_id, division_id, is_rookie, sprint_outcome)
     VALUES ($1,$2,$3,$4,'pending')
     ON CONFLICT (user_id, sprint_id) DO UPDATE SET division_id = EXCLUDED.division_id
     WHERE user_sprint_progress.division_id != EXCLUDED.division_id`,
    [userId, sprintId, divisionId, isRookie]
  )
}

// ── GET /glory/status ─────────────────────────────────────────────────────────
async function getGloryStatus(event, user) {
  const pool = await getPool()

  // Track app opens — only count if last_seen_at is null or older than 30 minutes
  pool.query(
    `UPDATE users SET
       last_seen_at = NOW(),
       app_opens    = app_opens + CASE WHEN last_seen_at IS NULL OR last_seen_at < NOW() - INTERVAL '30 minutes' THEN 1 ELSE 0 END
     WHERE id = $1`,
    [user.id]
  ).catch(() => {})

  const divStatus = await ensureDivisionStatus(pool, user.id)

  // Find the most relevant sprint: prefer sprints that have PUBLISHED or LOCKED gameweeks
  // (so an old 'live' sprint with all GWs finished doesn't shadow a new sprint where picks are open).
  // Also include draft sprints that have at least one PUBLISHED gameweek (admin published but hasn't activated yet).
  const sprintRes = await pool.query(
    `SELECT s.* FROM sprints s
     WHERE s.status IN ('live','scheduled')
        OR (s.status = 'draft' AND EXISTS (
              SELECT 1 FROM gameweeks g WHERE g.sprint_id=s.id AND g.status IN ('PUBLISHED','LOCKED')
           ))
     ORDER BY
       -- Sprints with an open (PUBLISHED/LOCKED) gameweek come first
       CASE WHEN EXISTS (
         SELECT 1 FROM gameweeks g WHERE g.sprint_id=s.id AND g.status IN ('PUBLISHED','LOCKED')
       ) THEN 0 ELSE 1 END,
       -- Among ties: live > scheduled > draft
       CASE WHEN s.status='live' THEN 0 WHEN s.status='scheduled' THEN 1 ELSE 2 END,
       s.start_date ASC
     LIMIT 1`
  )
  const sprint = sprintRes.rows[0] ?? null

  let sprintProgress = null
  let currentGameweek = null
  let nextDiv = null

  if (sprint) {
    // Get or initialise sprint progress
    await ensureSprintProgress(pool, user.id, sprint.id, divStatus?.division_id, divStatus?.is_rookie ?? true)

    const prog = await pool.query(
      "SELECT * FROM user_sprint_progress WHERE user_id=$1 AND sprint_id=$2",
      [user.id, sprint.id]
    )
    sprintProgress = prog.rows[0] ?? null

    // All gameweeks for this sprint (for client-side navigation)
    const allGwRes = await pool.query(
      `SELECT g.id, g.sprint_week, g.status, g.lock_time,
              COUNT(DISTINCT e.id)::int AS event_count,
              uge.league_points, uge.correct_picks, uge.incorrect_picks, uge.is_perfect_week
       FROM gameweeks g
       LEFT JOIN events e ON e.gameweek_id=g.id
       LEFT JOIN user_gameweek_entries uge ON uge.gameweek_id=g.id AND uge.user_id=$2
       WHERE g.sprint_id=$1
       GROUP BY g.id, uge.league_points, uge.correct_picks, uge.incorrect_picks, uge.is_perfect_week
       ORDER BY g.sprint_week ASC`,
      [sprint.id, user.id]
    )
    sprint.gameweeks = allGwRes.rows
    sprint.gameweek_count = allGwRes.rows.reduce((max, g) => Math.max(max, g.sprint_week || 0), 0)

    // Current gameweek: prefer the PUBLISHED week whose lock_time is still in the future
    // (= the active picking window for this week). Only fall back to LOCKED (last week
    // awaiting results) when there is no open PUBLISHED week.
    const now = new Date()
    const publishedRows = allGwRes.rows.filter(g => g.status === 'PUBLISHED')
    const activePub = publishedRows.find(g => new Date(g.lock_time) > now) ?? null
    const locked    = [...allGwRes.rows].reverse().find(g => g.status === 'LOCKED') ?? null
    const finished  = [...allGwRes.rows].reverse().find(g => g.status === 'FINISHED') ?? null
    currentGameweek = activePub ?? locked ?? finished ?? allGwRes.rows[0] ?? null

    // Next division
    const div = await pool.query(
      "SELECT * FROM divisions WHERE id=$1", [divStatus?.division_id]
    )
    if (div.rows.length && !div.rows[0].is_highest) {
      const nextRes = await pool.query(
        "SELECT * FROM divisions WHERE display_order=$1 AND is_active=TRUE",
        [div.rows[0].display_order + 1]
      )
      nextDiv = nextRes.rows[0] ?? null
    }
  }

  // Division rank for current sprint
  let division_rank = null
  let division_total = null
  if (sprint && sprintProgress?.division_id) {
    const rankRes = await pool.query(
      `SELECT ranked.division_rank, ranked.division_total
       FROM (
         SELECT usp.user_id,
           RANK() OVER (ORDER BY usp.total_league_points DESC, usp.total_correct_picks DESC, usp.total_incorrect_picks ASC, u.display_name ASC)::int AS division_rank,
           COUNT(*) OVER()::int AS division_total
         FROM user_sprint_progress usp
         JOIN users u ON u.id = usp.user_id
         WHERE usp.sprint_id = $1 AND usp.division_id = $2
       ) ranked
       WHERE ranked.user_id = $3`,
      [sprint.id, sprintProgress.division_id, user.id]
    )
    if (rankRes.rows.length) {
      division_rank = rankRes.rows[0].division_rank
      division_total = rankRes.rows[0].division_total
    }
  }

  // Recent badges
  const badgesRes = await pool.query(
    `SELECT ub.earned_at, b.code, b.name, b.icon, b.description
     FROM user_badges ub JOIN badges b ON b.id=ub.badge_id
     WHERE ub.user_id=$1 ORDER BY ub.earned_at DESC LIMIT 5`,
    [user.id]
  )

  return ok({
    user: { id: user.id, email: user.email, display_name: user.display_name },
    division: divStatus,
    next_division: nextDiv,
    sprint,
    sprint_progress: sprintProgress,
    current_gameweek: currentGameweek,
    recent_badges: badgesRes.rows,
    division_rank,
    division_total,
  })
}

// ── GET /glory/gameweek (current active) ──────────────────────────────────────
async function getCurrentGameweek(event, user) {
  const pool = await getPool()

  const gwRes = await pool.query(
    `SELECT g.* FROM gameweeks g
     JOIN sprints s ON s.id=g.sprint_id
     WHERE s.status='live' AND g.status IN ('PUBLISHED','LOCKED')
     ORDER BY g.sprint_week ASC LIMIT 1`
  )
  if (!gwRes.rows.length) return ok(null)

  return getGameweekById(pool, gwRes.rows[0].id, user)
}

// ── GET /glory/gameweek/{id} ──────────────────────────────────────────────────
async function getGameweek(event, user) {
  const { id } = event.pathParameters
  const pool = await getPool()
  return getGameweekById(pool, id, user)
}

async function getGameweekById(pool, gwId, user) {
  const gwRes = await pool.query("SELECT * FROM gameweeks WHERE id=$1", [gwId])
  if (!gwRes.rows.length) return error(404, "Gameweek not found")
  const gw = gwRes.rows[0]

  // Events with options, joined with fixture for venue info
  const evRes = await pool.query(
    `SELECT e.*, f.venue_name, f.venue_city, f.home_logo AS fixture_home_logo, f.away_logo AS fixture_away_logo
     FROM events e
     LEFT JOIN fixtures f ON e.fixture_id IS NOT NULL AND f.id = e.fixture_id::BIGINT
     WHERE e.gameweek_id=$1 ORDER BY e.match_time ASC`, [gwId]
  )
  const optRes = await pool.query(
    `SELECT eo.* FROM event_options eo
     JOIN events e ON e.id=eo.event_id WHERE e.gameweek_id=$1`, [gwId]
  )
  const optsByEvent = {}
  for (const o of optRes.rows) {
    if (!optsByEvent[o.event_id]) optsByEvent[o.event_id] = []
    optsByEvent[o.event_id].push({
      id: o.id, label: o.label, energy_cost: o.energy_cost, result: o.result
    })
  }

  // For PLAYER_SCORE events, look up player team from fixture lineups
  const playerEvents = evRes.rows.filter(e => e.event_type === 'PLAYER_SCORE' && e.fixture_id && e.player_name)
  const lineupByFixture = {}
  if (playerEvents.length > 0) {
    const fixtureIds = [...new Set(playerEvents.map(e => e.fixture_id))]
    const linRes = await pool.query(
      `SELECT fixture_id, player_name, team, team_logo FROM fixture_lineups WHERE fixture_id::text=ANY($1)`,
      [fixtureIds]
    )
    for (const row of linRes.rows) {
      if (!lineupByFixture[row.fixture_id]) lineupByFixture[row.fixture_id] = []
      lineupByFixture[row.fixture_id].push(row)
    }
  }

  function normStr(s) {
    return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, ' ').trim()
  }
  function findPlayerTeam(fixId, adminName) {
    const lineups = lineupByFixture[fixId] || []
    const na = normStr(adminName)
    // Last name of admin entry (skip single-letter initials)
    const naWords = na.split(' ').filter(w => w.length > 1)
    const naLast = naWords[naWords.length - 1] || na
    for (const row of lineups) {
      const nb = normStr(row.player_name)
      if (nb.includes(na) || na.includes(nb)) return { team: row.team, team_logo: row.team_logo }
      const nbWords = nb.split(' ').filter(w => w.length > 1)
      const nbLast = nbWords[nbWords.length - 1] || nb
      if (naLast.length >= 3 && naLast === nbLast) return { team: row.team, team_logo: row.team_logo }
    }
    return null
  }

  // User's entry for this gameweek
  const entryRes = await pool.query(
    "SELECT * FROM user_gameweek_entries WHERE user_id=$1 AND gameweek_id=$2",
    [user.id, gwId]
  )
  const entry = entryRes.rows[0] ?? null

  let myPicks = []
  if (entry) {
    const picksRes = await pool.query(
      "SELECT * FROM user_picks WHERE entry_id=$1", [entry.id]
    )
    myPicks = picksRes.rows
  }

  const pickedOptionIds = new Set(myPicks.map(p => p.event_option_id))

  return ok({
    gameweek: {
      ...gw,
      events: evRes.rows.map(e => {
        const extra = {}
        if (e.event_type === 'PLAYER_SCORE' && e.player_name) {
          const teamInfo = findPlayerTeam(e.fixture_id, e.player_name)
          if (teamInfo) { extra.player_team = teamInfo.team; extra.player_team_logo = teamInfo.team_logo }
        }
        return { ...e, ...extra, options: optsByEvent[e.id] ?? [] }
      }),
    },
    my_entry: entry,
    my_picks: myPicks,
    picks_count: myPicks.length,
    is_locked: gw.status === 'LOCKED' || gw.status === 'FINISHED',
  })
}

// ── POST /glory/gameweek/{id}/picks ──────────────────────────────────────────
async function submitPicks(event, user) {
  const { id: gwId } = event.pathParameters
  const body = JSON.parse(event.body || "{}")
  const { picks } = body  // [{ event_id, event_option_id }, ...]

  if (!Array.isArray(picks) || picks.length !== 6)
    return error(400, "Exactly 6 picks are required")

  const pool = await getPool()

  // Validate gameweek
  const gwRes = await pool.query("SELECT * FROM gameweeks WHERE id=$1", [gwId])
  if (!gwRes.rows.length) return error(404, "Gameweek not found")
  const gw = gwRes.rows[0]

  if (!gw.sprint_id) return error(422, "This gameweek is not part of a Sprint")
  if (!['PUBLISHED', 'DRAFT'].includes(gw.status)) // allow DRAFT for testing, require PUBLISHED in prod
    return error(422, "Picks cannot be submitted for this gameweek (status: " + gw.status + ")")

  // Check lock time
  if (gw.lock_time && new Date() > new Date(gw.lock_time))
    return error(422, "Picks are locked for this gameweek")

  // Validate all events belong to gameweek and options belong to events
  const uniqueEventIds = [...new Set(picks.map(p => p.event_id))]
  if (uniqueEventIds.length !== picks.length) return error(400, "All picks must be for different events")

  const evRes = await pool.query(
    "SELECT id FROM events WHERE gameweek_id=$1 AND id=ANY($2::uuid[])",
    [gwId, uniqueEventIds]
  )
  if (evRes.rows.length !== uniqueEventIds.length) return error(400, "One or more events do not belong to this gameweek")

  const optionIds = picks.map(p => p.event_option_id)
  const optRes = await pool.query(
    "SELECT id, event_id FROM event_options WHERE id=ANY($1::uuid[])",
    [optionIds]
  )
  if (optRes.rows.length !== picks.length) return error(400, "One or more event options not found")

  // Validate each option belongs to its event
  const optMap = {}
  for (const o of optRes.rows) optMap[o.id] = o.event_id
  for (const p of picks) {
    if (optMap[p.event_option_id] !== p.event_id)
      return error(400, "Option " + p.event_option_id + " does not belong to event " + p.event_id)
  }

  // Ensure user has division status
  const divStatus = await ensureDivisionStatus(pool, user.id)

  // Ensure sprint progress
  await ensureSprintProgress(pool, user.id, gw.sprint_id, divStatus?.division_id, divStatus?.is_rookie ?? true)

  // Upsert entry
  let entryId
  const existingEntry = await pool.query(
    "SELECT id FROM user_gameweek_entries WHERE user_id=$1 AND gameweek_id=$2",
    [user.id, gwId]
  )
  if (existingEntry.rows.length) {
    entryId = existingEntry.rows[0].id
    // Delete existing picks to allow re-submission
    await pool.query("DELETE FROM user_picks WHERE entry_id=$1", [entryId])
  } else {
    entryId = uuidv4()
    await pool.query(
      `INSERT INTO user_gameweek_entries (id, user_id, gameweek_id, sprint_id, status, picks_submitted)
       VALUES ($1,$2,$3,$4,'open',6)`,
      [entryId, user.id, gwId, gw.sprint_id]
    )
  }

  // Insert picks
  for (const p of picks) {
    await pool.query(
      `INSERT INTO user_picks (id, entry_id, user_id, gameweek_id, event_id, event_option_id)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [uuidv4(), entryId, user.id, gwId, p.event_id, p.event_option_id]
    )
  }

  // Update entry picks_submitted count
  await pool.query(
    "UPDATE user_gameweek_entries SET picks_submitted=6 WHERE id=$1", [entryId]
  )

  // Award first gameweek badge if first ever entry
  const entryCount = await pool.query(
    "SELECT COUNT(*) FROM user_gameweek_entries WHERE user_id=$1", [user.id]
  )
  if (parseInt(entryCount.rows[0].count) === 1) {
    await awardBadge(pool, user.id, 'FIRST_GAMEWEEK', null, gwId)
  }

  return ok({ entry_id: entryId, picks_submitted: 6 }, 201)
}

// ── GET /glory/gameweek/{id}/picks ────────────────────────────────────────────
async function getMyPicks(event, user) {
  const { id: gwId } = event.pathParameters
  const pool = await getPool()

  const entryRes = await pool.query(
    "SELECT * FROM user_gameweek_entries WHERE user_id=$1 AND gameweek_id=$2",
    [user.id, gwId]
  )
  if (!entryRes.rows.length) return ok({ entry: null, picks: [] })

  const entry = entryRes.rows[0]
  const picksRes = await pool.query(
    `SELECT up.*, e.event_type, e.fixture_name, e.match_time,
            eo.label AS option_label, eo.result AS option_result
     FROM user_picks up
     JOIN events e ON e.id=up.event_id
     JOIN event_options eo ON eo.id=up.event_option_id
     WHERE up.entry_id=$1 ORDER BY e.match_time ASC`,
    [entry.id]
  )

  return ok({ entry, picks: picksRes.rows })
}

// ── GET /glory/profile ────────────────────────────────────────────────────────
async function getProfile(event, user) {
  const pool = await getPool()

  const divStatus = await ensureDivisionStatus(pool, user.id)

  // Sprint history
  const sprintHistory = await pool.query(
    `SELECT usp.*,
            s.name AS sprint_name, s.start_date, s.end_date,
            fd.name AS from_division_name, fd.icon AS from_icon,
            td.name AS final_division_name, td.icon AS final_icon
     FROM user_sprint_progress usp
     JOIN sprints s ON s.id=usp.sprint_id
     LEFT JOIN divisions fd ON fd.id=usp.division_id
     LEFT JOIN divisions td ON td.id=usp.final_division_id
     WHERE usp.user_id=$1 ORDER BY s.start_date DESC`,
    [user.id]
  )

  // Lifetime stats
  const lifetimeRes = await pool.query(
    `SELECT
       COALESCE(SUM(total_correct_picks),0)::int      AS lifetime_correct,
       COALESCE(SUM(total_incorrect_picks),0)::int    AS lifetime_incorrect,
       COALESCE(SUM(total_league_points),0)::int      AS lifetime_lp,
       COALESCE(SUM(perfect_weeks),0)::int            AS total_perfect_weeks,
       COALESCE(SUM(gameweeks_participated),0)::int   AS matchweeks_played,
       COUNT(*)::int                                  AS sprints_played
     FROM user_sprint_progress WHERE user_id=$1`,
    [user.id]
  )

  // Promotion/relegation history
  const movHistory = await pool.query(
    `SELECT prh.*, s.name AS sprint_name,
            fd.name AS from_div, td.name AS to_div,
            fd.icon AS from_icon, td.icon AS to_icon
     FROM promotion_relegation_history prh
     JOIN sprints s ON s.id=prh.sprint_id
     LEFT JOIN divisions fd ON fd.id=prh.from_division_id
     LEFT JOIN divisions td ON td.id=prh.to_division_id
     WHERE prh.user_id=$1 ORDER BY prh.created_at DESC LIMIT 20`,
    [user.id]
  )

  // Badges — all active badges with earned count so UI can show locked/unlocked
  const badgesRes = await pool.query(
    `SELECT b.code, b.name, b.icon, b.description,
            COUNT(ub.id)::int      AS earned_count,
            MAX(ub.earned_at)      AS last_earned_at
     FROM badges b
     LEFT JOIN user_badges ub ON ub.badge_id = b.id AND ub.user_id = $1
     WHERE b.is_active = TRUE
     GROUP BY b.code, b.name, b.icon, b.description
     ORDER BY CASE WHEN COUNT(ub.id) > 0 THEN 0 ELSE 1 END, MAX(ub.earned_at) DESC NULLS LAST`,
    [user.id]
  )

  // Highest division reached
  const highestRes = await pool.query(
    `SELECT d.name, d.icon, d.display_order
     FROM promotion_relegation_history prh
     JOIN divisions d ON d.id=prh.to_division_id
     WHERE prh.user_id=$1 ORDER BY d.display_order DESC LIMIT 1`,
    [user.id]
  )

  // Per-competition stats (only competitions with ≥1 correct pick)
  const compStatsRes = await pool.query(
    `SELECT
       COALESCE(c.name, f.league_name)   AS competition_name,
       c.logo_url                         AS competition_logo,
       f.api_league_id,
       COUNT(CASE WHEN eo.result = 'WON' THEN 1 END)::int  AS correct,
       COUNT(up.id)::int                                    AS total
     FROM user_picks up
     JOIN events e ON e.id = up.event_id
     JOIN event_options eo ON eo.id = up.event_option_id
     JOIN fixtures f ON e.fixture_id IS NOT NULL AND f.id = e.fixture_id::BIGINT
     LEFT JOIN competitions c ON c.id = f.competition_id
     WHERE up.user_id = $1 AND eo.result IN ('WON', 'LOST')
     GROUP BY COALESCE(c.name, f.league_name), c.logo_url, f.api_league_id
     HAVING COUNT(CASE WHEN eo.result = 'WON' THEN 1 END) > 0
     ORDER BY correct DESC`,
    [user.id]
  )

  // Division championships: sprints where user ranked #1 in their division
  const divChampRes = await pool.query(
    `SELECT
       d.id AS division_id,
       d.name AS division_name,
       d.icon AS division_icon,
       d.display_order,
       COUNT(*)::int                                               AS sprints_in_division,
       COUNT(*) FILTER (WHERE ranked.division_rank = 1)::int      AS championships
     FROM (
       SELECT
         usp.user_id,
         usp.sprint_id,
         usp.division_id,
         RANK() OVER (
           PARTITION BY usp.sprint_id, usp.division_id
           ORDER BY usp.total_league_points DESC, usp.total_correct_picks DESC, usp.total_incorrect_picks ASC, u.display_name ASC
         ) AS division_rank
       FROM user_sprint_progress usp
       JOIN users u ON u.id = usp.user_id
       WHERE usp.settled_at IS NOT NULL
     ) ranked
     JOIN divisions d ON d.id = ranked.division_id
     WHERE ranked.user_id = $1
     GROUP BY d.id, d.name, d.icon, d.display_order
     HAVING COUNT(*) FILTER (WHERE ranked.division_rank = 1) > 0
     ORDER BY championships DESC, d.display_order DESC`,
    [user.id]
  )

  // Longest consecutive correct picks streak, ordered by fixture date
  const streakRes = await pool.query(
    `WITH ordered_picks AS (
       SELECT
         CASE WHEN eo.result = 'WON' THEN 1 ELSE 0 END AS is_correct,
         ROW_NUMBER() OVER (ORDER BY f.date ASC, f.id ASC, up.id ASC) AS rn
       FROM user_picks up
       JOIN event_options eo ON eo.id = up.event_option_id
       JOIN events e ON e.id = up.event_id AND e.fixture_id IS NOT NULL
       JOIN fixtures f ON f.id = e.fixture_id::BIGINT
       WHERE up.user_id = $1 AND eo.result IN ('WON', 'LOST')
     ),
     streak_groups AS (
       SELECT
         is_correct,
         rn - ROW_NUMBER() OVER (PARTITION BY is_correct ORDER BY rn) AS grp
       FROM ordered_picks
     ),
     streaks AS (
       SELECT COUNT(*)::int AS streak_len
       FROM streak_groups
       WHERE is_correct = 1
       GROUP BY grp
     )
     SELECT COALESCE(MAX(streak_len), 0)::int AS longest_streak FROM streaks`,
    [user.id]
  )

  // Sprint overall championships (global #1 finishes across all divisions)
  const sprintChampRes = await pool.query(
    `SELECT s.id AS sprint_id, s.name AS sprint_name, s.start_date, s.end_date,
            usp.total_league_points, usp.total_correct_picks,
            usp.division_id, d.name AS division_name, d.icon AS division_icon
     FROM (
       SELECT usp.user_id, usp.sprint_id, usp.total_league_points, usp.total_correct_picks,
              usp.division_id,
              RANK() OVER (PARTITION BY usp.sprint_id ORDER BY usp.total_league_points DESC, usp.total_correct_picks DESC, usp.total_incorrect_picks ASC, usp.user_id ASC) AS overall_rank
       FROM user_sprint_progress usp
       WHERE usp.settled_at IS NOT NULL
     ) usp
     JOIN sprints s ON s.id = usp.sprint_id
     LEFT JOIN divisions d ON d.id = usp.division_id
     WHERE usp.user_id = $1 AND usp.overall_rank = 1
     ORDER BY s.start_date DESC`,
    [user.id]
  )

  const stats = lifetimeRes.rows[0]
  const totalPicks = stats.lifetime_correct + stats.lifetime_incorrect
  const accuracy = totalPicks > 0
    ? Math.ceil((stats.lifetime_correct / totalPicks) * 100)
    : 0

  return ok({
    division: divStatus,
    highest_division: highestRes.rows[0] ?? null,
    lifetime_stats: { ...stats, total_picks: totalPicks, accuracy_pct: accuracy },
    sprint_history: sprintHistory.rows,
    movement_history: movHistory.rows,
    badges: badgesRes.rows,
    competition_stats: compStatsRes.rows,
    division_championships: divChampRes.rows,
    sprint_championships_overall: sprintChampRes.rows,
    longest_correct_streak: streakRes.rows[0]?.longest_streak ?? 0,
  })
}

// ── GET /glory/leaderboard ────────────────────────────────────────────────────
async function getLeaderboard(event, user) {
  const qs = event.queryStringParameters || {}
  const divisionId = qs.division_id
  const sprintId   = qs.sprint_id

  const pool = await getPool()

  // Active sprint if not specified
  let sid = sprintId
  if (!sid) {
    const sp = await pool.query(
      "SELECT id FROM sprints WHERE status='live' ORDER BY start_date ASC LIMIT 1"
    )
    sid = sp.rows[0]?.id
  }
  if (!sid) return ok({ rows: [], division: null, sprint: null })

  let whereClause = "WHERE usp.sprint_id=$1"
  const params = [sid]

  if (divisionId) {
    whereClause += " AND usp.division_id=$2"
    params.push(divisionId)
  }

  const rows = await pool.query(
    `WITH eu AS (
       SELECT uge.user_id, COALESCE(SUM(eo.energy_cost), 0)::int AS energy_used
       FROM user_picks up
       JOIN event_options eo ON eo.id = up.event_option_id
       JOIN user_gameweek_entries uge ON uge.id = up.entry_id
       JOIN gameweeks g ON g.id = uge.gameweek_id
       WHERE g.sprint_id = $1
       GROUP BY uge.user_id
     ), ps AS (
       SELECT user_id, COALESCE(SUM(picks_submitted), 0)::int AS total_submitted
       FROM user_gameweek_entries
       WHERE sprint_id = $1
       GROUP BY user_id
     ), live AS (
       SELECT uge.user_id, COUNT(up.id)::int AS live_picks
       FROM user_picks up
       JOIN events e ON e.id = up.event_id
       JOIN user_gameweek_entries uge ON uge.id = up.entry_id
       JOIN gameweeks g ON g.id = uge.gameweek_id
       WHERE g.sprint_id = $1
         AND g.status = 'LOCKED'
         AND up.pick_status = 'pending'
         AND NOW() >= e.match_time
       GROUP BY uge.user_id
     )
     SELECT
       usp.user_id, u.display_name, u.avatar_url,
       usp.total_league_points, usp.total_correct_picks,
       usp.total_incorrect_picks, usp.perfect_weeks,
       usp.gameweeks_participated, usp.is_rookie,
       d.name AS division_name, d.icon AS division_icon,
       COALESCE(eu.energy_used, 0) AS energy_used,
       GREATEST(0, COALESCE(ps.total_submitted, 0) - usp.total_correct_picks - usp.total_incorrect_picks) AS pending_picks,
       COALESCE(live.live_picks, 0) AS live_picks,
       RANK() OVER (ORDER BY usp.total_league_points DESC, usp.total_correct_picks DESC, COALESCE(eu.energy_used, 0) ASC, usp.total_incorrect_picks ASC, u.display_name ASC) AS rank,
       COALESCE(lt.lifetime_correct, 0)::int   AS lifetime_correct,
       COALESCE(lt.lifetime_incorrect, 0)::int AS lifetime_incorrect
     FROM user_sprint_progress usp
     JOIN users u ON u.id=usp.user_id AND u.role='user'
     JOIN divisions d ON d.id=usp.division_id
     LEFT JOIN eu ON eu.user_id = usp.user_id
     LEFT JOIN ps ON ps.user_id = usp.user_id
     LEFT JOIN live ON live.user_id = usp.user_id
     LEFT JOIN (
       SELECT user_id,
              SUM(total_correct_picks)::int   AS lifetime_correct,
              SUM(total_incorrect_picks)::int AS lifetime_incorrect
       FROM user_sprint_progress
       GROUP BY user_id
     ) lt ON lt.user_id = usp.user_id
     ${whereClause}
     ORDER BY usp.total_league_points DESC, usp.total_correct_picks DESC, COALESCE(eu.energy_used, 0) ASC, usp.total_incorrect_picks ASC, u.display_name ASC
     LIMIT 100`,
    params
  )

  const divRes = divisionId
    ? await pool.query("SELECT * FROM divisions WHERE id=$1", [divisionId])
    : { rows: [] }
  const sprintRes = await pool.query("SELECT * FROM sprints WHERE id=$1", [sid])

  return ok({
    rows: rows.rows,
    division: divRes.rows[0] ?? null,
    sprint: sprintRes.rows[0] ?? null,
  })
}

// ── GET /glory/sprints/{id} ───────────────────────────────────────────────────
async function getSprintDetail(event, user) {
  const { id: sprintId } = event.pathParameters
  const pool = await getPool()

  const sprintRes = await pool.query("SELECT * FROM sprints WHERE id=$1", [sprintId])
  if (!sprintRes.rows.length) return error(404, "Sprint not found")
  const sprint = sprintRes.rows[0]

  const progRes = await pool.query(
    "SELECT * FROM user_sprint_progress WHERE user_id=$1 AND sprint_id=$2",
    [user.id, sprintId]
  )
  const progress = progRes.rows[0] ?? null

  let division = null
  let rankings = []
  if (progress?.division_id) {
    const divRes = await pool.query("SELECT * FROM divisions WHERE id=$1", [progress.division_id])
    division = divRes.rows[0] ?? null
    const rankRes = await pool.query(
      `WITH eu AS (
         SELECT uge.user_id, COALESCE(SUM(eo.energy_cost), 0)::int AS energy_used
         FROM user_picks up
         JOIN event_options eo ON eo.id = up.event_option_id
         JOIN user_gameweek_entries uge ON uge.id = up.entry_id
         JOIN gameweeks g ON g.id = uge.gameweek_id
         WHERE g.sprint_id = $1
         GROUP BY uge.user_id
       ), ps AS (
         SELECT user_id, COALESCE(SUM(picks_submitted), 0)::int AS total_submitted
         FROM user_gameweek_entries WHERE sprint_id = $1 GROUP BY user_id
       ), live AS (
         SELECT uge.user_id, COUNT(up.id)::int AS live_picks
         FROM user_picks up
         JOIN events e ON e.id = up.event_id
         JOIN user_gameweek_entries uge ON uge.id = up.entry_id
         JOIN gameweeks g ON g.id = uge.gameweek_id
         WHERE g.sprint_id = $1
           AND g.status = 'LOCKED'
           AND up.pick_status = 'pending'
           AND NOW() >= e.match_time
         GROUP BY uge.user_id
       )
       SELECT usp.user_id, u.display_name, u.avatar_url,
              usp.total_league_points, usp.total_correct_picks, usp.total_incorrect_picks,
              usp.perfect_weeks, usp.sprint_outcome,
              COALESCE(eu.energy_used, 0) AS energy_used,
              GREATEST(0, COALESCE(ps.total_submitted, 0) - usp.total_correct_picks - usp.total_incorrect_picks) AS pending_picks,
              COALESCE(live.live_picks, 0) AS live_picks,
              RANK() OVER (ORDER BY usp.total_league_points DESC, usp.total_correct_picks DESC, COALESCE(eu.energy_used, 0) ASC, usp.total_incorrect_picks ASC, u.display_name ASC) AS rank
       FROM user_sprint_progress usp
       JOIN users u ON u.id=usp.user_id AND u.role='user'
       LEFT JOIN eu ON eu.user_id = usp.user_id
       LEFT JOIN ps ON ps.user_id = usp.user_id
       LEFT JOIN live ON live.user_id = usp.user_id
       WHERE usp.sprint_id=$1 AND usp.division_id=$2
       ORDER BY usp.total_league_points DESC, usp.total_correct_picks DESC, COALESCE(eu.energy_used, 0) ASC, usp.total_incorrect_picks ASC, u.display_name ASC`,
      [sprintId, progress.division_id]
    )
    rankings = rankRes.rows
  }

  // Overall ranking across all divisions (always returned for any sprint status)
  let overall_ranking = []
  const { rows: overallRows } = await pool.query(
    `WITH eu AS (
       SELECT uge.user_id, COALESCE(SUM(eo.energy_cost), 0)::int AS energy_used
       FROM user_picks up
       JOIN event_options eo ON eo.id = up.event_option_id
       JOIN user_gameweek_entries uge ON uge.id = up.entry_id
       JOIN gameweeks g ON g.id = uge.gameweek_id
       WHERE g.sprint_id = $1
       GROUP BY uge.user_id
     ), ps AS (
       SELECT user_id, COALESCE(SUM(picks_submitted), 0)::int AS total_submitted
       FROM user_gameweek_entries WHERE sprint_id = $1 GROUP BY user_id
     ), live AS (
       SELECT uge.user_id, COUNT(up.id)::int AS live_picks
       FROM user_picks up
       JOIN events e ON e.id = up.event_id
       JOIN user_gameweek_entries uge ON uge.id = up.entry_id
       JOIN gameweeks g ON g.id = uge.gameweek_id
       WHERE g.sprint_id = $1
         AND g.status = 'LOCKED'
         AND up.pick_status = 'pending'
         AND NOW() >= e.match_time
       GROUP BY uge.user_id
     )
     SELECT usp.user_id, u.display_name, u.avatar_url,
            usp.total_league_points, usp.total_correct_picks, usp.total_incorrect_picks,
            usp.perfect_weeks, usp.sprint_outcome, usp.division_id,
            d.name AS division_name, d.icon AS division_icon,
            COALESCE(eu.energy_used, 0) AS energy_used,
            GREATEST(0, COALESCE(ps.total_submitted, 0) - usp.total_correct_picks - usp.total_incorrect_picks) AS pending_picks,
            COALESCE(live.live_picks, 0) AS live_picks,
            RANK() OVER (PARTITION BY usp.division_id ORDER BY usp.total_league_points DESC, usp.total_correct_picks DESC, COALESCE(eu.energy_used, 0) ASC, usp.total_incorrect_picks ASC, u.display_name ASC)::int AS division_rank,
            RANK() OVER (ORDER BY usp.total_league_points DESC, usp.total_correct_picks DESC, COALESCE(eu.energy_used, 0) ASC, usp.total_incorrect_picks ASC, u.display_name ASC)::int AS overall_rank
     FROM user_sprint_progress usp
     JOIN users u ON u.id = usp.user_id AND u.role = 'user'
     LEFT JOIN divisions d ON d.id = usp.division_id
     LEFT JOIN eu ON eu.user_id = usp.user_id
     LEFT JOIN ps ON ps.user_id = usp.user_id
     LEFT JOIN live ON live.user_id = usp.user_id
     WHERE usp.sprint_id = $1
     ORDER BY usp.total_league_points DESC, usp.total_correct_picks DESC, COALESCE(eu.energy_used, 0) ASC, usp.total_incorrect_picks ASC, u.display_name ASC`,
    [sprintId]
  )
  overall_ranking = overallRows

  // If user has no progress record but we have overall rankings, try to give them division rankings
  // from the most-populated division so the UI has something to show
  if (!progress?.division_id && overall_ranking.length > 0 && rankings.length === 0) {
    const divCounts = {}
    for (const r of overall_ranking) {
      if (r.division_id) divCounts[r.division_id] = (divCounts[r.division_id] || 0) + 1
    }
    const topDivId = Object.entries(divCounts).sort((a, b) => b[1] - a[1])[0]?.[0]
    if (topDivId) {
      const divRes = await pool.query("SELECT * FROM divisions WHERE id=$1", [topDivId])
      division = divRes.rows[0] ?? null
      const rankRes = await pool.query(
        `WITH eu AS (
           SELECT uge.user_id, COALESCE(SUM(eo.energy_cost), 0)::int AS energy_used
           FROM user_picks up
           JOIN event_options eo ON eo.id = up.event_option_id
           JOIN user_gameweek_entries uge ON uge.id = up.entry_id
           JOIN gameweeks g ON g.id = uge.gameweek_id
           WHERE g.sprint_id = $1
           GROUP BY uge.user_id
         ), ps AS (
           SELECT user_id, COALESCE(SUM(picks_submitted), 0)::int AS total_submitted
           FROM user_gameweek_entries WHERE sprint_id = $1 GROUP BY user_id
         ), live AS (
           SELECT uge.user_id, COUNT(up.id)::int AS live_picks
           FROM user_picks up
           JOIN events e ON e.id = up.event_id
           JOIN user_gameweek_entries uge ON uge.id = up.entry_id
           JOIN gameweeks g ON g.id = uge.gameweek_id
           WHERE g.sprint_id = $1
             AND g.status = 'LOCKED'
             AND up.pick_status = 'pending'
             AND NOW() >= e.match_time
           GROUP BY uge.user_id
         )
         SELECT usp.user_id, u.display_name, u.avatar_url,
                usp.total_league_points, usp.total_correct_picks, usp.total_incorrect_picks,
                usp.perfect_weeks, usp.sprint_outcome,
                COALESCE(eu.energy_used, 0) AS energy_used,
                GREATEST(0, COALESCE(ps.total_submitted, 0) - usp.total_correct_picks - usp.total_incorrect_picks) AS pending_picks,
                COALESCE(live.live_picks, 0) AS live_picks,
                RANK() OVER (ORDER BY usp.total_league_points DESC, usp.total_correct_picks DESC, COALESCE(eu.energy_used, 0) ASC, usp.total_incorrect_picks ASC, u.display_name ASC)::int AS rank
         FROM user_sprint_progress usp
         JOIN users u ON u.id = usp.user_id AND u.role = 'user'
         LEFT JOIN eu ON eu.user_id = usp.user_id
         LEFT JOIN ps ON ps.user_id = usp.user_id
         LEFT JOIN live ON live.user_id = usp.user_id
         WHERE usp.sprint_id=$1 AND usp.division_id=$2
         ORDER BY usp.total_league_points DESC, usp.total_correct_picks DESC, COALESCE(eu.energy_used, 0) ASC, usp.total_incorrect_picks ASC, u.display_name ASC`,
        [sprintId, topDivId]
      )
      rankings = rankRes.rows
    }
  }

  const gwRes = await pool.query(
    `SELECT g.*,
       uge.id AS entry_id, uge.correct_picks, uge.incorrect_picks,
       uge.league_points, uge.is_perfect_week, uge.status AS entry_status
     FROM gameweeks g
     LEFT JOIN user_gameweek_entries uge ON uge.gameweek_id=g.id AND uge.user_id=$2
     WHERE g.sprint_id=$1
     ORDER BY g.sprint_week ASC`,
    [sprintId, user.id]
  )

  const gameweeks = []
  for (const gw of gwRes.rows) {
    let picks = []
    if (gw.entry_id) {
      const pRes = await pool.query(
        `SELECT up.event_id, up.event_option_id,
                e.event_type, e.fixture_name, e.match_time,
                eo.label AS option_label, eo.result AS option_result,
                eo.energy_cost
         FROM user_picks up
         JOIN events e ON e.id=up.event_id
         JOIN event_options eo ON eo.id=up.event_option_id
         WHERE up.entry_id=$1 ORDER BY e.match_time ASC`,
        [gw.entry_id]
      )
      picks = pRes.rows
    }
    gameweeks.push({
      id: gw.id, sprint_week: gw.sprint_week, status: gw.status, lock_time: gw.lock_time,
      entry: gw.entry_id ? {
        correct_picks: gw.correct_picks, incorrect_picks: gw.incorrect_picks,
        league_points: gw.league_points, is_perfect_week: gw.is_perfect_week,
        status: gw.entry_status,
      } : null,
      picks,
    })
  }

  return ok({ sprint, progress, division, rankings, overall_ranking, gameweeks })
}

// ── GET /glory/sprints ────────────────────────────────────────────────────────
async function listActiveSprints(event, user) {
  const pool = await getPool()
  const { rows } = await pool.query(
    `SELECT s.*,
       (SELECT COUNT(*) FROM gameweeks g WHERE g.sprint_id=s.id)::int AS gameweek_count
     FROM sprints s
     WHERE s.status IN ('live','scheduled','completed')
     ORDER BY s.start_date DESC LIMIT 10`
  )
  return ok(rows)
}

// ── GET /glory/divisions ──────────────────────────────────────────────────────
async function listDivisions(event, user) {
  const pool = await getPool()
  const { rows } = await pool.query(
    `SELECT * FROM divisions WHERE is_active=TRUE ORDER BY display_order ASC`
  )
  return ok(rows)
}

// ── GET /glory/sprints/my ────────────────────────────────────────────────────
async function myRelevantSprints(event, user) {
  const pool = await getPool()
  const now = new Date()
  const currentMonthStart = new Date(Date.UTC(now.getFullYear(), now.getMonth(), 1))
  const nextMonthStart    = new Date(Date.UTC(now.getFullYear(), now.getMonth() + 1, 1))
  const twoMonthsEnd      = new Date(Date.UTC(now.getFullYear(), now.getMonth() + 2, 28, 23, 59, 59))

  // Past + active sprints with user progress
  const { rows: pastRows } = await pool.query(
    `SELECT s.*,
       usp.total_league_points, usp.total_correct_picks, usp.perfect_weeks,
       usp.gameweeks_participated, usp.is_rookie, usp.sprint_outcome,
       usp.division_id, usp.final_division_id, usp.closing_popup_seen_at,
       d.name AS division_name, d.icon AS division_icon, d.color_primary,
       d.badge_url AS division_badge_url, d.display_order AS division_display_order,
       d.promotion_min_points, d.relegation_max_points,
       fd.name AS final_division_name, fd.icon AS final_division_icon, fd.color_primary AS final_division_color,
       (SELECT name FROM divisions WHERE display_order = d.display_order + 1 AND is_active = TRUE LIMIT 1) AS next_division_name,
       (SELECT icon FROM divisions WHERE display_order = d.display_order + 1 AND is_active = TRUE LIMIT 1) AS next_division_icon,
       (SELECT COUNT(*) FROM gameweeks g WHERE g.sprint_id=s.id)::int AS gameweek_count,
       (SELECT COUNT(*) FROM gameweeks g WHERE g.sprint_id=s.id AND g.status IN ('PUBLISHED','LOCKED','FINISHED'))::int AS active_gameweeks,
       -- Placeholder ranks (overwritten by accurate batch rank query below)
       NULL::int AS my_rank,
       CASE WHEN usp.division_id IS NOT NULL THEN (
         SELECT COUNT(*)::int FROM user_sprint_progress usp2
         WHERE usp2.sprint_id = s.id AND usp2.division_id = usp.division_id
       ) END AS total_players,
       NULL::int AS my_global_rank,
       (SELECT COUNT(*)::int FROM user_sprint_progress usp4 WHERE usp4.sprint_id = s.id) AS total_global_players
     FROM sprints s
     LEFT JOIN user_sprint_progress usp ON usp.sprint_id=s.id AND usp.user_id=$1
     LEFT JOIN divisions d ON d.id=usp.division_id
     LEFT JOIN divisions fd ON fd.id=usp.final_division_id
     WHERE s.status IN ('live','scheduled','completed','archived')
        OR (s.status='draft' AND s.start_date <= $2)
     ORDER BY s.start_date DESC`,
    [user.id, twoMonthsEnd.toISOString()]
  )

  // Upcoming draft sprints for current month + next month only
  const { rows: futureRows } = await pool.query(
    `SELECT s.*,
       (SELECT COUNT(*) FROM gameweeks g WHERE g.sprint_id=s.id)::int AS gameweek_count,
       (SELECT COUNT(*) FROM gameweeks g WHERE g.sprint_id=s.id AND g.status IN ('PUBLISHED','LOCKED','FINISHED'))::int AS active_gameweeks
     FROM sprints s
     WHERE s.status='draft'
       AND s.start_date >= $1
       AND s.start_date <= $2
     ORDER BY s.start_date ASC
     LIMIT 2`,
    [currentMonthStart.toISOString(), twoMonthsEnd.toISOString()]
  )

  // Include gameweeks (with user entry) for live/scheduled sprints so the week schedule shows real status
  const liveIds = pastRows.filter(s => s.status === 'live' || s.status === 'scheduled').map(s => s.id)
  let gwBySprintId = {}
  if (liveIds.length > 0) {
    const { rows: gwRows } = await pool.query(
      `SELECT g.id, g.sprint_id, g.sprint_week, g.status, g.lock_time,
              uge.league_points, uge.correct_picks, uge.incorrect_picks, uge.is_perfect_week
       FROM gameweeks g
       LEFT JOIN user_gameweek_entries uge ON uge.gameweek_id=g.id AND uge.user_id=$1
       WHERE g.sprint_id = ANY($2) AND g.status != 'DRAFT'
       ORDER BY g.sprint_week ASC`,
      [user.id, liveIds]
    )
    for (const gw of gwRows) {
      if (!gwBySprintId[gw.sprint_id]) gwBySprintId[gw.sprint_id] = []
      gwBySprintId[gw.sprint_id].push({
        id: gw.id, sprint_week: gw.sprint_week, status: gw.status, lock_time: gw.lock_time,
        entry: gw.league_points != null ? {
          league_points: gw.league_points, correct_picks: gw.correct_picks,
          incorrect_picks: gw.incorrect_picks, is_perfect_week: gw.is_perfect_week,
        } : null,
      })
    }
  }

  const sprints = pastRows.map(s => ({ ...s, gameweeks: gwBySprintId[s.id] || [] }))

  // Compute accurate ranks for all sprints the user has participated in.
  // Uses the exact same full tiebreaker chain as the leaderboard (LP → correct → energy ASC → incorrect ASC → name ASC).
  // One batch query covering all sprint IDs avoids N separate per-sprint queries.
  const participatedIds = pastRows.filter(s => s.division_id).map(s => s.id)
  if (participatedIds.length > 0) {
    const batchRankRes = await pool.query(
      `SELECT ranked.sprint_id, ranked.rank_in_div, ranked.overall_rank
       FROM (
         SELECT usp.user_id, usp.sprint_id,
                RANK() OVER (PARTITION BY usp.sprint_id, usp.division_id
                             ORDER BY usp.total_league_points DESC,
                                      usp.total_correct_picks DESC,
                                      COALESCE(eu.energy_used, 0) ASC,
                                      usp.total_incorrect_picks ASC,
                                      u.display_name ASC)::int AS rank_in_div,
                RANK() OVER (PARTITION BY usp.sprint_id
                             ORDER BY usp.total_league_points DESC,
                                      usp.total_correct_picks DESC,
                                      COALESCE(eu.energy_used, 0) ASC,
                                      usp.total_incorrect_picks ASC,
                                      u.display_name ASC)::int AS overall_rank
         FROM user_sprint_progress usp
         JOIN users u ON u.id = usp.user_id AND u.role = 'user'
         LEFT JOIN (
           SELECT uge.user_id, g.sprint_id, COALESCE(SUM(eo.energy_cost), 0)::int AS energy_used
           FROM user_picks up
           JOIN event_options eo ON eo.id = up.event_option_id
           JOIN user_gameweek_entries uge ON uge.id = up.entry_id
           JOIN gameweeks g ON g.id = uge.gameweek_id
           WHERE g.sprint_id = ANY($2)
           GROUP BY uge.user_id, g.sprint_id
         ) eu ON eu.user_id = usp.user_id AND eu.sprint_id = usp.sprint_id
         WHERE usp.sprint_id = ANY($2)
       ) ranked
       WHERE ranked.user_id = $1`,
      [user.id, participatedIds]
    )
    const rankMap = {}
    for (const r of batchRankRes.rows) rankMap[r.sprint_id] = r
    for (const s of sprints) {
      if (rankMap[s.id]) {
        s.my_rank        = rankMap[s.id].rank_in_div
        s.my_global_rank = rankMap[s.id].overall_rank
      }
    }
  }

  return ok({ past: sprints, upcoming: futureRows })
}

// ── POST /glory/sprints/{id}/mark-popup-seen ─────────────────────────────────
async function markSprintPopupSeen(event, user) {
  const { id: sprintId } = event.pathParameters
  const pool = await getPool()
  await pool.query(
    `UPDATE user_sprint_progress
     SET closing_popup_seen_at = NOW()
     WHERE user_id=$1 AND sprint_id=$2 AND closing_popup_seen_at IS NULL`,
    [user.id, sprintId]
  )
  return ok({ ok: true })
}

// ── GET /glory/sprints/{id}/picks ────────────────────────────────────────────
async function getMySprintPicks(event, user) {
  const { id: sprintId } = event.pathParameters
  const pool = await getPool()

  console.log('[getMySprintPicks]', { userId: user.id, sprintId })

  const rawCount = await pool.query(
    `SELECT COUNT(*) AS total,
            COUNT(*) FILTER (WHERE g.sprint_id = $2) AS by_gw_sprint,
            COUNT(*) FILTER (WHERE uge.sprint_id = $2) AS by_uge_sprint
     FROM user_picks up
     JOIN gameweeks g ON g.id = up.gameweek_id
     LEFT JOIN user_gameweek_entries uge ON uge.id = up.entry_id
     WHERE up.user_id = $1`,
    [user.id, sprintId]
  )
  console.log('[getMySprintPicks] rawCount:', rawCount.rows[0])

  const { rows } = await pool.query(
    `SELECT
       g.sprint_week,
       e.fixture_name, e.event_type, e.competition,
       eo.label AS picked_label, eo.result, eo.energy_cost,
       f.home_logo, f.away_logo,
       uge.correct_picks AS week_correct, uge.incorrect_picks AS week_incorrect,
       uge.league_points AS week_lp
     FROM user_picks up
     LEFT JOIN event_options eo     ON eo.id = up.event_option_id
     LEFT JOIN events e             ON e.id  = up.event_id
     JOIN gameweeks g               ON g.id  = up.gameweek_id
     LEFT JOIN fixtures f           ON e.fixture_id IS NOT NULL AND f.id = e.fixture_id::BIGINT
     LEFT JOIN user_gameweek_entries uge ON uge.id = up.entry_id
     WHERE up.user_id = $1 AND (g.sprint_id = $2 OR uge.sprint_id = $2)
     ORDER BY g.sprint_week ASC, e.match_time ASC, e.fixture_name ASC`,
    [user.id, sprintId]
  )

  // Group by sprint week, taking weekly stats from first row of each week
  const byWeek = {}
  for (const row of rows) {
    const w = row.sprint_week
    if (!byWeek[w]) {
      byWeek[w] = {
        sprint_week:    w,
        week_correct:   row.week_correct ?? 0,
        week_incorrect: row.week_incorrect ?? 0,
        week_lp:        row.week_lp ?? 0,
        picks: [],
      }
    }
    byWeek[w].picks.push({
      fixture_name: row.fixture_name,
      event_type:   row.event_type,
      competition:  row.competition,
      picked_label: row.picked_label,
      result:       row.result,
      energy_cost:  row.energy_cost,
      home_logo:    row.home_logo,
      away_logo:    row.away_logo,
    })
  }

  const weeks = Object.keys(byWeek)
    .sort((a, b) => Number(a) - Number(b))
    .map(w => byWeek[w])

  console.log('[getMySprintPicks] rows:', rows.length, 'weeks:', weeks.length)
  return ok({ weeks })
}

// ── GET /glory/users/{id}/sprints/{sprintId}/picks ───────────────────────────
async function getUserSprintPicks(event, user) {
  const { id: targetUserId, sprintId } = event.pathParameters
  const pool = await getPool()

  console.log('[getUserSprintPicks]', { targetUserId, sprintId })

  const { rows } = await pool.query(
    `SELECT
       g.sprint_week,
       e.fixture_name, e.event_type, e.competition,
       eo.label AS picked_label, eo.result, eo.energy_cost,
       f.home_logo, f.away_logo,
       uge.correct_picks AS week_correct, uge.incorrect_picks AS week_incorrect,
       uge.league_points AS week_lp
     FROM user_picks up
     LEFT JOIN event_options eo     ON eo.id = up.event_option_id
     LEFT JOIN events e             ON e.id  = up.event_id
     JOIN gameweeks g               ON g.id  = up.gameweek_id
     LEFT JOIN fixtures f           ON e.fixture_id IS NOT NULL AND f.id = e.fixture_id::BIGINT
     LEFT JOIN user_gameweek_entries uge ON uge.id = up.entry_id
     WHERE up.user_id = $1 AND (g.sprint_id = $2 OR uge.sprint_id = $2)
       AND (g.status IN ('LOCKED', 'FINISHED') OR g.lock_time <= NOW())
     ORDER BY g.sprint_week ASC, e.match_time ASC, e.fixture_name ASC`,
    [targetUserId, sprintId]
  )

  const byWeek = {}
  for (const row of rows) {
    const w = row.sprint_week
    if (!byWeek[w]) {
      byWeek[w] = {
        sprint_week:    w,
        week_correct:   row.week_correct ?? 0,
        week_incorrect: row.week_incorrect ?? 0,
        week_lp:        row.week_lp ?? 0,
        picks: [],
      }
    }
    byWeek[w].picks.push({
      fixture_name: row.fixture_name,
      event_type:   row.event_type,
      competition:  row.competition,
      picked_label: row.picked_label,
      result:       row.result,
      energy_cost:  row.energy_cost,
      home_logo:    row.home_logo,
      away_logo:    row.away_logo,
    })
  }

  const weeks = Object.keys(byWeek)
    .sort((a, b) => Number(a) - Number(b))
    .map(w => byWeek[w])

  console.log('[getUserSprintPicks] rows:', rows.length, 'weeks:', weeks.length)

  return ok({ weeks, locked_until: null })
}

// ── GET /glory/gameweek/{id}/community ───────────────────────────────────────
// Returns all events with pick counts per option — only available after lock time
async function getCommunityPicks(event, user) {
  const { id: gwId } = event.pathParameters
  const pool = await getPool()

  const gwRes = await pool.query("SELECT * FROM gameweeks WHERE id=$1", [gwId])
  if (!gwRes.rows.length) return error(404, "Gameweek not found")
  const gw = gwRes.rows[0]

  const isLocked = gw.status === 'LOCKED' || gw.status === 'FINISHED' ||
    new Date() > new Date(gw.lock_time)
  if (!isLocked) return error(403, "Community picks are only visible after picks lock")

  // Events + options
  const evRes = await pool.query(
    "SELECT * FROM events WHERE gameweek_id=$1 ORDER BY match_time ASC", [gwId]
  )
  const optRes = await pool.query(
    `SELECT eo.*, COUNT(up.id)::int AS pick_count
     FROM event_options eo
     JOIN events e ON e.id=eo.event_id
     LEFT JOIN user_picks up ON up.event_option_id=eo.id
     WHERE e.gameweek_id=$1
     GROUP BY eo.id`, [gwId]
  )

  // User's own picks
  const entryRes = await pool.query(
    "SELECT id FROM user_gameweek_entries WHERE user_id=$1 AND gameweek_id=$2",
    [user.id, gwId]
  )
  let myPickedOptionIds = new Set()
  if (entryRes.rows.length) {
    const picksRes = await pool.query(
      "SELECT event_option_id FROM user_picks WHERE entry_id=$1", [entryRes.rows[0].id]
    )
    myPickedOptionIds = new Set(picksRes.rows.map(r => r.event_option_id))
  }

  const optsByEvent = {}
  for (const o of optRes.rows) {
    if (!optsByEvent[o.event_id]) optsByEvent[o.event_id] = []
    optsByEvent[o.event_id].push({
      id: o.id, label: o.label, result: o.result,
      pick_count: o.pick_count, is_my_pick: myPickedOptionIds.has(o.id),
    })
  }

  // Total entries in this gameweek
  const countRes = await pool.query(
    "SELECT COUNT(*)::int AS total FROM user_gameweek_entries WHERE gameweek_id=$1", [gwId]
  )
  const totalEntries = countRes.rows[0].total

  return ok({
    gameweek: gw,
    total_entries: totalEntries,
    events: evRes.rows.map(e => ({
      id: e.id, fixture_name: e.fixture_name, event_type: e.event_type,
      match_time: e.match_time, competition: e.competition,
      options: optsByEvent[e.id] ?? [],
    })),
  })
}

// ── GET /glory/users/{id} ────────────────────────────────────────────────────
async function getPublicProfile(event, user) {
  const { id: targetId } = event.pathParameters
  const pool = await getPool()

  const userRes = await pool.query(
    "SELECT id, display_name, avatar_url, created_at FROM users WHERE id=$1", [targetId]
  )
  if (!userRes.rows.length) return error(404, "User not found")
  const targetUser = userRes.rows[0]

  const divRes = await pool.query(
    `SELECT uds.*, d.name AS division_name, d.icon, d.color_primary
     FROM user_division_status uds JOIN divisions d ON d.id=uds.division_id
     WHERE uds.user_id=$1`, [targetId]
  )

  const statsRes = await pool.query(
    `SELECT COALESCE(SUM(total_correct_picks),0)::int    AS lifetime_correct,
            COALESCE(SUM(total_incorrect_picks),0)::int  AS lifetime_incorrect,
            COALESCE(SUM(total_league_points),0)::int    AS lifetime_lp,
            COALESCE(SUM(perfect_weeks),0)::int          AS total_perfect_weeks,
            COALESCE(SUM(gameweeks_participated),0)::int AS matchweeks_played,
            COUNT(*)::int                                AS sprints_played
     FROM user_sprint_progress WHERE user_id=$1`, [targetId]
  )

  const historyRes = await pool.query(
    `SELECT usp.total_league_points, usp.sprint_outcome, usp.is_rookie,
            s.id AS sprint_id, s.name AS sprint_name, s.start_date,
            d.name AS division_name, d.icon AS division_icon
     FROM user_sprint_progress usp
     JOIN sprints s ON s.id=usp.sprint_id
     LEFT JOIN divisions d ON d.id=usp.division_id
     WHERE usp.user_id=$1 ORDER BY s.start_date DESC LIMIT 10`, [targetId]
  )

  const badgesRes = await pool.query(
    `SELECT b.code, b.name, b.icon, b.description,
            COUNT(ub.id)::int      AS earned_count,
            MAX(ub.earned_at)      AS last_earned_at
     FROM badges b
     LEFT JOIN user_badges ub ON ub.badge_id = b.id AND ub.user_id = $1
     WHERE b.is_active = TRUE
     GROUP BY b.code, b.name, b.icon, b.description
     ORDER BY CASE WHEN COUNT(ub.id) > 0 THEN 0 ELSE 1 END, MAX(ub.earned_at) DESC NULLS LAST`,
    [targetId]
  )

  const compStatsRes = await pool.query(
    `SELECT
       COALESCE(c.name, f.league_name)   AS competition_name,
       c.logo_url                         AS competition_logo,
       f.api_league_id,
       COUNT(CASE WHEN eo.result = 'WON' THEN 1 END)::int  AS correct,
       COUNT(up.id)::int                                    AS total
     FROM user_picks up
     JOIN events e ON e.id = up.event_id
     JOIN event_options eo ON eo.id = up.event_option_id
     JOIN fixtures f ON e.fixture_id IS NOT NULL AND f.id = e.fixture_id::BIGINT
     LEFT JOIN competitions c ON c.id = f.competition_id
     WHERE up.user_id = $1 AND eo.result IN ('WON', 'LOST')
     GROUP BY COALESCE(c.name, f.league_name), c.logo_url, f.api_league_id
     HAVING COUNT(CASE WHEN eo.result = 'WON' THEN 1 END) > 0
     ORDER BY correct DESC`,
    [targetId]
  )

  const divChampRes = await pool.query(
    `SELECT
       d.id AS division_id,
       d.name AS division_name,
       d.icon AS division_icon,
       d.display_order,
       COUNT(*)::int                                               AS sprints_in_division,
       COUNT(*) FILTER (WHERE ranked.division_rank = 1)::int      AS championships
     FROM (
       SELECT
         usp.user_id,
         usp.sprint_id,
         usp.division_id,
         RANK() OVER (
           PARTITION BY usp.sprint_id, usp.division_id
           ORDER BY usp.total_league_points DESC, usp.total_correct_picks DESC, usp.total_incorrect_picks ASC, u.display_name ASC
         ) AS division_rank
       FROM user_sprint_progress usp
       JOIN users u ON u.id = usp.user_id
       WHERE usp.settled_at IS NOT NULL
     ) ranked
     JOIN divisions d ON d.id = ranked.division_id
     WHERE ranked.user_id = $1
     GROUP BY d.id, d.name, d.icon, d.display_order
     HAVING COUNT(*) FILTER (WHERE ranked.division_rank = 1) > 0
     ORDER BY championships DESC, d.display_order DESC`,
    [targetId]
  )

  // Longest consecutive correct picks streak, ordered by fixture date
  const streakRes = await pool.query(
    `WITH ordered_picks AS (
       SELECT
         CASE WHEN eo.result = 'WON' THEN 1 ELSE 0 END AS is_correct,
         ROW_NUMBER() OVER (ORDER BY f.date ASC, f.id ASC, up.id ASC) AS rn
       FROM user_picks up
       JOIN event_options eo ON eo.id = up.event_option_id
       JOIN events e ON e.id = up.event_id AND e.fixture_id IS NOT NULL
       JOIN fixtures f ON f.id = e.fixture_id::BIGINT
       WHERE up.user_id = $1 AND eo.result IN ('WON', 'LOST')
     ),
     streak_groups AS (
       SELECT
         is_correct,
         rn - ROW_NUMBER() OVER (PARTITION BY is_correct ORDER BY rn) AS grp
       FROM ordered_picks
     ),
     streaks AS (
       SELECT COUNT(*)::int AS streak_len
       FROM streak_groups
       WHERE is_correct = 1
       GROUP BY grp
     )
     SELECT COALESCE(MAX(streak_len), 0)::int AS longest_streak FROM streaks`,
    [targetId]
  )

  // Current sprint locked/finished picks (visible to others only after lock)
  const activeSprintRes = await pool.query(
    `SELECT s.* FROM sprints s
     WHERE s.status IN ('live','scheduled')
        OR (s.status = 'draft' AND EXISTS (
              SELECT 1 FROM gameweeks g WHERE g.sprint_id=s.id AND g.status IN ('PUBLISHED','LOCKED')
           ))
     ORDER BY
       CASE WHEN EXISTS (
         SELECT 1 FROM gameweeks g WHERE g.sprint_id=s.id AND g.status IN ('PUBLISHED','LOCKED')
       ) THEN 0 ELSE 1 END,
       CASE WHEN s.status='live' THEN 0 WHEN s.status='scheduled' THEN 1 ELSE 2 END,
       s.start_date ASC
     LIMIT 1`
  )
  const activeSprint = activeSprintRes.rows[0] ?? null

  let current_sprint = null
  if (activeSprint) {
    const [progRes, gwRes, publishedGwRes] = await Promise.all([
      pool.query(
        "SELECT * FROM user_sprint_progress WHERE user_id=$1 AND sprint_id=$2",
        [targetId, activeSprint.id]
      ),
      pool.query(
        `SELECT g.id, g.sprint_week, g.status, g.lock_time,
                uge.id AS entry_id, uge.correct_picks, uge.incorrect_picks,
                uge.league_points, uge.is_perfect_week, uge.picks_submitted
         FROM gameweeks g
         LEFT JOIN user_gameweek_entries uge ON uge.gameweek_id=g.id AND uge.user_id=$2
         WHERE g.sprint_id=$1 AND g.status IN ('LOCKED','FINISHED')
         ORDER BY g.sprint_week ASC`,
        [activeSprint.id, targetId]
      ),
      pool.query(
        `SELECT g.sprint_week, g.lock_time, uge.picks_submitted
         FROM gameweeks g
         LEFT JOIN user_gameweek_entries uge ON uge.gameweek_id=g.id AND uge.user_id=$2
         WHERE g.sprint_id=$1 AND g.status='PUBLISHED'
         ORDER BY g.sprint_week ASC LIMIT 1`,
        [activeSprint.id, targetId]
      ),
    ])

    const sprintProgress = progRes.rows[0] ?? null

    // Division rank for this sprint
    let division_rank = null, division_total = null
    if (sprintProgress?.division_id) {
      const rankRes = await pool.query(
        `SELECT ranked.division_rank, ranked.division_total
         FROM (
           SELECT usp.user_id,
             RANK() OVER (ORDER BY usp.total_league_points DESC, usp.total_correct_picks DESC, usp.total_incorrect_picks ASC, usp.user_id ASC)::int AS division_rank,
             COUNT(*) OVER()::int AS division_total
           FROM user_sprint_progress usp
           WHERE usp.sprint_id=$1 AND usp.division_id=$2
         ) ranked WHERE ranked.user_id=$3`,
        [activeSprint.id, sprintProgress.division_id, targetId]
      )
      if (rankRes.rows.length) {
        division_rank = rankRes.rows[0].division_rank
        division_total = rankRes.rows[0].division_total
      }
    }

    const gameweeks = []
    for (const gw of gwRes.rows) {
      let picks = []
      if (gw.entry_id) {
        const pRes = await pool.query(
          `SELECT e.event_type, e.fixture_name, e.match_time, e.competition,
                  f.home_team, f.away_team, f.home_logo, f.away_logo,
                  f.home_goals, f.away_goals, f.status_short, f.status_elapsed,
                  eo.label AS option_label, eo.result AS option_result, eo.energy_cost
           FROM user_picks up
           JOIN events e ON e.id=up.event_id
           JOIN event_options eo ON eo.id=up.event_option_id
           LEFT JOIN fixtures f ON e.fixture_id IS NOT NULL AND f.id = e.fixture_id::BIGINT
           WHERE up.entry_id=$1 ORDER BY e.match_time ASC, e.id ASC`,
          [gw.entry_id]
        )
        picks = pRes.rows
      }
      gameweeks.push({
        sprint_week: gw.sprint_week,
        status: gw.status,
        lock_time: gw.lock_time,
        entry: gw.entry_id ? {
          correct_picks: gw.correct_picks,
          incorrect_picks: gw.incorrect_picks,
          league_points: gw.league_points,
          is_perfect_week: gw.is_perfect_week,
          picks_submitted: gw.picks_submitted,
        } : null,
        picks,
      })
    }

    const publishedGw = publishedGwRes.rows[0] ?? null
    current_sprint = {
      sprint: activeSprint,
      progress: sprintProgress,
      division_rank,
      division_total,
      gameweeks,
      open_week_submitted: (publishedGw?.picks_submitted ?? 0) > 0,
      open_week_lock_time: publishedGw?.lock_time ?? null,
    }
  }

  return ok({
    user: targetUser,
    division: divRes.rows[0] ?? null,
    lifetime_stats: statsRes.rows[0],
    sprint_history: historyRes.rows,
    badges: badgesRes.rows,
    competition_stats: compStatsRes.rows,
    division_championships: divChampRes.rows,
    longest_correct_streak: streakRes.rows[0]?.longest_streak ?? 0,
    current_sprint,
  })
}

// ── Badge helper ──────────────────────────────────────────────────────────────
// ── GET /glory/fixtures/{id}/stats ───────────────────────────────────────────
async function getFixtureStats(event, user) {
  const { id: fixtureId } = event.pathParameters
  const pool = await getPool()

  const fixRow = await pool.query(
    `SELECT id, home_team, away_team, home_goals, away_goals, status_short, status_long,
            status_elapsed, date, home_logo, away_logo, round, details_cached
     FROM fixtures WHERE id=$1`, [fixtureId]
  )
  if (!fixRow.rows.length) return error(404, "Fixture not found")
  const fx = fixRow.rows[0]

  const isFinished = FINISHED_STATUSES.includes(fx.status_short)
  const isLive     = LIVE_STATUSES.includes(fx.status_short)

  // For live fixtures always fetch fresh from API-Football (no caching)
  // For finished fixtures fetch once and cache
  if (isLive || (isFinished && !fx.details_cached)) {
    try {
      const secrets = await getSecrets()
      const headers = { "x-apisports-key": secrets.key }

      const [evRes, stRes] = await Promise.all([
        axios.get(`${API_FOOTBALL_BASE}/fixtures/events`,     { params: { fixture: fixtureId }, headers }),
        axios.get(`${API_FOOTBALL_BASE}/fixtures/statistics`, { params: { fixture: fixtureId }, headers }),
      ])

      const apiEvents = (evRes.data?.response || []).map(e => ({
        elapsed:   e.time.elapsed,
        extra:     e.time.extra ?? null,
        team:      e.team.name,
        team_logo: e.team.logo,
        player:    e.player.name,
        assist:    e.assist?.name ?? null,
        type:      e.type,
        detail:    e.detail,
      }))

      const apiStats = (stRes.data?.response || []).flatMap(t =>
        (t.statistics || []).map(s => ({
          team: t.team.name, team_logo: t.team.logo,
          stat_type: s.type, stat_value: s.value,
        }))
      )

      // Only persist to DB for finished fixtures
      if (isFinished) {
        for (const ev of apiEvents) {
          await pool.query(
            `INSERT INTO fixture_events (fixture_id,elapsed,extra,team,team_logo,player,assist,type,detail)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [fixtureId, ev.elapsed, ev.extra, ev.team, ev.team_logo, ev.player, ev.assist, ev.type, ev.detail]
          )
        }
        for (const s of apiStats) {
          await pool.query(
            `INSERT INTO fixture_statistics (fixture_id,team,team_logo,stat_type,stat_value)
             VALUES ($1,$2,$3,$4,$5)`,
            [fixtureId, s.team, s.team_logo, s.stat_type, s.stat_value]
          )
        }
        await pool.query("UPDATE fixtures SET details_cached=true WHERE id=$1", [fixtureId])
      }

      const statsTeams = [...new Set(apiStats.map(r => r.team))]
      const statistics = statsTeams.map(team => {
        const rows = apiStats.filter(r => r.team === team)
        return { team, team_logo: rows[0]?.team_logo, stats: rows.map(r => ({ type: r.stat_type, value: r.stat_value })) }
      })
      return ok({ fixture: fx, events: apiEvents, statistics, cached: false, source: isLive ? 'live' : 'api' })
    } catch {
      // Fall through to return cached DB data or empty
    }
  }

  const [evRows, stRows] = await Promise.all([
    pool.query(
      `SELECT elapsed, extra, team, team_logo, player, assist, type, detail
       FROM fixture_events WHERE fixture_id=$1
       ORDER BY elapsed ASC, extra ASC NULLS LAST`, [fixtureId]
    ),
    pool.query(
      `SELECT team, team_logo, stat_type, stat_value
       FROM fixture_statistics WHERE fixture_id=$1`, [fixtureId]
    ),
  ])

  const statsTeams = [...new Set(stRows.rows.map(r => r.team))]
  const statistics = statsTeams.map(team => {
    const rows = stRows.rows.filter(r => r.team === team)
    return { team, team_logo: rows[0]?.team_logo, stats: rows.map(r => ({ type: r.stat_type, value: r.stat_value })) }
  })

  return ok({
    fixture: fx,
    events:     evRows.rows,
    statistics,
    cached: evRows.rows.length > 0 || stRows.rows.length > 0,
  })
}

// ── GET /glory/fixtures/{id}/form ────────────────────────────────────────────
async function getFixtureForm(event, user) {
  const { id: fixtureId } = event.pathParameters
  const pool = await getPool()

  const fixRow = await pool.query(
    `SELECT id, home_team, away_team, home_logo, away_logo, date FROM fixtures WHERE id=$1`,
    [fixtureId]
  )
  if (!fixRow.rows.length) return error(404, "Fixture not found")
  const fx = fixRow.rows[0]

  try {
    const secrets = await getSecrets()
    const headers = { "x-apisports-key": secrets.key }

    // Fetch fixture from API to get team IDs
    const fixRes = await axios.get(`${API_FOOTBALL_BASE}/fixtures`, {
      params: { fixture: fixtureId },
      headers, timeout: 8000,
    })
    const fixData = fixRes.data?.response?.[0]
    if (!fixData) throw new Error('Fixture not in API')

    const homeId = fixData.teams.home.id
    const awayId = fixData.teams.away.id

    // Fetch last 5 finished matches for each team in parallel
    const [homeRes, awayRes] = await Promise.all([
      axios.get(`${API_FOOTBALL_BASE}/fixtures`, { params: { team: homeId, last: 5 }, headers, timeout: 8000 }),
      axios.get(`${API_FOOTBALL_BASE}/fixtures`, { params: { team: awayId, last: 5 }, headers, timeout: 8000 }),
    ])

    const DONE = new Set(['FT', 'AET', 'PEN', 'AWD', 'WO'])
    function parseForm(fixtures, teamId) {
      return (fixtures || [])
        .filter(f => DONE.has(f.fixture.status.short))
        .map(f => {
          const isHome = f.teams.home.id === teamId
          const gf = isHome ? f.goals.home : f.goals.away
          const ga = isHome ? f.goals.away : f.goals.home
          const result = gf > ga ? 'W' : gf < ga ? 'L' : 'D'
          return {
            date:          f.fixture.date,
            opponent:      isHome ? f.teams.away.name : f.teams.home.name,
            opponent_logo: isHome ? f.teams.away.logo : f.teams.home.logo,
            gf, ga, result, home: isHome,
          }
        })
        .reverse() // oldest → newest left-to-right
    }

    return ok({
      home_team:  fixData.teams.home.name,
      away_team:  fixData.teams.away.name,
      home_logo:  fixData.teams.home.logo,
      away_logo:  fixData.teams.away.logo,
      home_form:  parseForm(homeRes.data?.response, homeId),
      away_form:  parseForm(awayRes.data?.response, awayId),
    })
  } catch (e) {
    console.error('[form] API-Football failed:', e.message)
    return ok({
      home_team: fx.home_team, away_team: fx.away_team,
      home_logo: fx.home_logo, away_logo: fx.away_logo,
      home_form: [], away_form: [],
    })
  }
}

// ── GET /glory/gameweek/{id}/live ─────────────────────────────────────────────
async function getGameweekLive(event, user) {
  const { id } = event.pathParameters
  const pool = await getPool()

  // Get all events for this gameweek with their fixture live data
  const evRes = await pool.query(
    `SELECT e.id AS event_id, e.event_type, e.fixture_id, e.status AS event_status,
            e.match_time, e.player_name,
            f.status_short, f.status_long, f.status_elapsed,
            f.home_goals, f.away_goals, f.home_team, f.away_team,
            f.pen_home, f.pen_away,
            f.updated_at AS fixture_updated_at
     FROM events e
     LEFT JOIN fixtures f ON f.id::text = e.fixture_id
     WHERE e.gameweek_id=$1
     ORDER BY e.match_time ASC`,
    [id]
  )

  // Get option results for all events in this gameweek
  const optRes = await pool.query(
    `SELECT eo.id, eo.event_id, eo.label, eo.result, eo.result_key, eo.energy_cost
     FROM event_options eo
     JOIN events e ON e.id = eo.event_id
     WHERE e.gameweek_id=$1`,
    [id]
  )
  const optsByEvent = {}
  for (const o of optRes.rows) {
    if (!optsByEvent[o.event_id]) optsByEvent[o.event_id] = []
    optsByEvent[o.event_id].push({ id: o.id, label: o.label, result: o.result, result_key: o.result_key, energy_cost: o.energy_cost })
  }

  const events = evRes.rows.map(e => ({
    event_id: e.event_id,
    event_type: e.event_type,
    event_status: e.event_status,
    match_time: e.match_time,
    player_name: e.player_name,
    fixture_id: e.fixture_id,
    fixture_status_short: e.status_short,
    fixture_status_long: e.status_long,
    fixture_elapsed: e.status_elapsed,
    home_goals: e.home_goals,
    away_goals: e.away_goals,
    pen_home: e.pen_home,
    pen_away: e.pen_away,
    home_team: e.home_team,
    away_team: e.away_team,
    fixture_updated_at: e.fixture_updated_at,
    options: optsByEvent[e.event_id] || [],
  }))

  return ok({ events, fetched_at: new Date().toISOString() })
}

async function awardBadge(pool, userId, code, sprintId, gameweekId) {
  const badge = await pool.query("SELECT id FROM badges WHERE code=$1 AND is_active=TRUE", [code])
  if (!badge.rows.length) return
  await pool.query(
    `INSERT INTO user_badges (user_id, badge_id, sprint_id, gameweek_id)
     VALUES ($1,$2,$3,$4)`,
    [userId, badge.rows[0].id, sprintId, gameweekId]
  ).catch(() => {})  // ignore duplicates
}

// ── GET /glory/energy-packs ───────────────────────────────────────────────────
async function listEnergyPacks(event, user) {
  const pool = await getPool()
  const { rows } = await pool.query(
    `SELECT * FROM energy_packs WHERE is_active=TRUE ORDER BY display_order ASC, price_euros ASC`
  )
  // Also return user's current wallet balance
  const walletRes = await pool.query(
    `SELECT COALESCE(balance, 0) AS balance FROM energy_wallets WHERE user_id=$1`, [user.id]
  )
  return ok({ packs: rows, wallet_balance: walletRes.rows[0]?.balance ?? 0 })
}

// ── POST /glory/energy-packs/{id}/purchase ────────────────────────────────────
async function purchaseEnergyPack(event, user) {
  const { id } = event.pathParameters
  const pool = await getPool()

  const packRes = await pool.query(`SELECT * FROM energy_packs WHERE id=$1 AND is_active=TRUE`, [id])
  if (!packRes.rows.length) return error(404, "Pack not found or unavailable")
  const pack = packRes.rows[0]

  // Upsert wallet and add energy
  await pool.query(
    `INSERT INTO energy_wallets (user_id, balance) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET balance = energy_wallets.balance + $2`,
    [user.id, pack.energy_amount]
  )

  // Log transaction (legacy)
  await pool.query(
    `INSERT INTO energy_transactions (user_id, amount, type, description)
     VALUES ($1, $2, 'PURCHASE', $3)`,
    [user.id, pack.energy_amount, `Purchased: ${pack.name}`]
  )

  // Log purchase for revenue reporting
  await pool.query(
    `INSERT INTO energy_pack_purchases (user_id, pack_id, pack_name, energy_amount, price_euros)
     VALUES ($1, $2, $3, $4, $5)`,
    [user.id, pack.id, pack.name, pack.energy_amount, pack.price_euros ?? 0]
  )

  const newBalance = await pool.query(
    `SELECT balance FROM energy_wallets WHERE user_id=$1`, [user.id]
  )

  return ok({ success: true, energy_added: pack.energy_amount, new_balance: newBalance.rows[0].balance })
}

// ── GET /glory/purchase-history ───────────────────────────────────────────────
async function getPurchaseHistory(event, user) {
  const pool = await getPool()

  const [walletRes, txRes] = await Promise.all([
    pool.query(
      `SELECT COALESCE(balance, 0) AS balance FROM energy_wallets WHERE user_id=$1`,
      [user.id]
    ),
    pool.query(
      `SELECT id, amount, type, description, created_at
       FROM energy_transactions
       WHERE user_id=$1
       ORDER BY created_at DESC
       LIMIT 50`,
      [user.id]
    ),
  ])

  return ok({
    wallet_balance: walletRes.rows[0]?.balance ?? 0,
    transactions: txRes.rows,
  })
}
