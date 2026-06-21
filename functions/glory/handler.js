const { getPool }          = require("../../shared/db")
const { verifyToken, extractFromEvent } = require("../../shared/auth")
const { ok, error, unauthorized } = require("../../shared/response")
const { v4: uuidv4 }       = require("uuid")

exports.handler = async (event) => {
  const routeKey = event.routeKey

  let user
  try {
    user = await verifyToken(extractFromEvent(event))
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
    if (routeKey === "GET /glory/divisions")                  return await listDivisions(event, user)
    if (routeKey === "GET /glory/sprints/my")                 return await myRelevantSprints(event, user)
    if (routeKey === "GET /glory/gameweek/{id}/community")    return await getCommunityPicks(event, user)
    if (routeKey === "GET /glory/users/{id}")                 return await getPublicProfile(event, user)
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
     ON CONFLICT (user_id, sprint_id) DO NOTHING`,
    [userId, sprintId, divisionId, isRookie]
  )
}

// ── GET /glory/status ─────────────────────────────────────────────────────────
async function getGloryStatus(event, user) {
  const pool = await getPool()
  const divStatus = await ensureDivisionStatus(pool, user.id)

  // Current live/scheduled sprint
  const sprintRes = await pool.query(
    "SELECT * FROM sprints WHERE status IN ('live','scheduled') ORDER BY start_date ASC LIMIT 1"
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

    // Current gameweek
    const gwRes = await pool.query(
      `SELECT g.*, COUNT(DISTINCT e.id)::int AS event_count
       FROM gameweeks g
       LEFT JOIN events e ON e.gameweek_id=g.id
       WHERE g.sprint_id=$1 AND g.status IN ('PUBLISHED','LOCKED')
       GROUP BY g.id
       ORDER BY g.sprint_week ASC
       LIMIT 1`,
      [sprint.id]
    )
    currentGameweek = gwRes.rows[0] ?? null

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

  // Events with options
  const evRes = await pool.query(
    "SELECT * FROM events WHERE gameweek_id=$1 ORDER BY match_time ASC", [gwId]
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
      events: evRes.rows.map(e => ({
        ...e,
        options: optsByEvent[e.id] ?? [],
      })),
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
  if (uniqueEventIds.length !== 6) return error(400, "All 6 picks must be for different events")

  const evRes = await pool.query(
    "SELECT id FROM events WHERE gameweek_id=$1 AND id=ANY($2::uuid[])",
    [gwId, uniqueEventIds]
  )
  if (evRes.rows.length !== 6) return error(400, "One or more events do not belong to this gameweek")

  const optionIds = picks.map(p => p.event_option_id)
  const optRes = await pool.query(
    "SELECT id, event_id FROM event_options WHERE id=ANY($1::uuid[])",
    [optionIds]
  )
  if (optRes.rows.length !== 6) return error(400, "One or more event options not found")

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
       COALESCE(SUM(total_correct_picks),0)::int   AS lifetime_correct,
       COALESCE(SUM(total_incorrect_picks),0)::int  AS lifetime_incorrect,
       COALESCE(SUM(total_league_points),0)::int    AS lifetime_lp,
       COALESCE(SUM(perfect_weeks),0)::int          AS total_perfect_weeks,
       COUNT(*)::int                                AS sprints_played
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

  // Badges
  const badgesRes = await pool.query(
    `SELECT ub.earned_at, b.code, b.name, b.icon, b.description
     FROM user_badges ub JOIN badges b ON b.id=ub.badge_id
     WHERE ub.user_id=$1 ORDER BY ub.earned_at DESC`,
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

  const stats = lifetimeRes.rows[0]
  const totalPicks = stats.lifetime_correct + stats.lifetime_incorrect
  const accuracy = totalPicks > 0
    ? Math.round((stats.lifetime_correct / totalPicks) * 1000) / 10
    : 0

  return ok({
    division: divStatus,
    highest_division: highestRes.rows[0] ?? null,
    lifetime_stats: { ...stats, total_picks: totalPicks, accuracy_pct: accuracy },
    sprint_history: sprintHistory.rows,
    movement_history: movHistory.rows,
    badges: badgesRes.rows,
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
    `SELECT
       usp.user_id, u.display_name, u.avatar_url,
       usp.total_league_points, usp.total_correct_picks,
       usp.total_incorrect_picks, usp.perfect_weeks,
       usp.gameweeks_participated, usp.is_rookie,
       d.name AS division_name, d.icon AS division_icon,
       RANK() OVER (ORDER BY usp.total_league_points DESC, usp.total_correct_picks DESC) AS rank
     FROM user_sprint_progress usp
     JOIN users u ON u.id=usp.user_id
     JOIN divisions d ON d.id=usp.division_id
     ${whereClause}
     ORDER BY usp.total_league_points DESC, usp.total_correct_picks DESC
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
       usp.division_id,
       d.name AS division_name, d.icon AS division_icon, d.color_primary,
       (SELECT COUNT(*) FROM gameweeks g WHERE g.sprint_id=s.id)::int AS gameweek_count,
       (SELECT COUNT(*) FROM gameweeks g WHERE g.sprint_id=s.id AND g.status IN ('PUBLISHED','LOCKED','FINISHED'))::int AS active_gameweeks
     FROM sprints s
     LEFT JOIN user_sprint_progress usp ON usp.sprint_id=s.id AND usp.user_id=$1
     LEFT JOIN divisions d ON d.id=usp.division_id
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

  return ok({ past: pastRows, upcoming: futureRows })
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
    `SELECT COALESCE(SUM(total_correct_picks),0)::int AS lifetime_correct,
            COALESCE(SUM(total_league_points),0)::int AS lifetime_lp,
            COALESCE(SUM(perfect_weeks),0)::int AS total_perfect_weeks,
            COUNT(*)::int AS sprints_played
     FROM user_sprint_progress WHERE user_id=$1`, [targetId]
  )

  const historyRes = await pool.query(
    `SELECT usp.total_league_points, usp.sprint_outcome, usp.is_rookie,
            s.name AS sprint_name, s.start_date,
            d.name AS division_name, d.icon AS division_icon
     FROM user_sprint_progress usp
     JOIN sprints s ON s.id=usp.sprint_id
     LEFT JOIN divisions d ON d.id=usp.division_id
     WHERE usp.user_id=$1 ORDER BY s.start_date DESC LIMIT 10`, [targetId]
  )

  const badgesRes = await pool.query(
    `SELECT ub.earned_at, b.name, b.icon, b.description
     FROM user_badges ub JOIN badges b ON b.id=ub.badge_id
     WHERE ub.user_id=$1 ORDER BY ub.earned_at DESC LIMIT 20`, [targetId]
  )

  return ok({
    user: targetUser,
    division: divRes.rows[0] ?? null,
    lifetime_stats: statsRes.rows[0],
    sprint_history: historyRes.rows,
    badges: badgesRes.rows,
  })
}

// ── Badge helper ──────────────────────────────────────────────────────────────
async function awardBadge(pool, userId, code, sprintId, gameweekId) {
  const badge = await pool.query("SELECT id FROM badges WHERE code=$1 AND is_active=TRUE", [code])
  if (!badge.rows.length) return
  await pool.query(
    `INSERT INTO user_badges (user_id, badge_id, sprint_id, gameweek_id)
     VALUES ($1,$2,$3,$4)`,
    [userId, badge.rows[0].id, sprintId, gameweekId]
  ).catch(() => {})  // ignore duplicates
}
