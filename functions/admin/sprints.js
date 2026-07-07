const { getPool } = require('../../shared/db')
const { v4: uuidv4 } = require('uuid')
const { ok, error } = require('../../shared/response')

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
  const { start_date, end_date, lock_time, reveal_time, base_energy } = JSON.parse(event.body || '{}')
  if (!start_date && !end_date && !lock_time && !reveal_time && base_energy == null)
    return error(400, "At least one field is required")
  const pool = await getPool()
  const gw = await pool.query(
    "SELECT id FROM gameweeks WHERE id=$1 AND sprint_id=$2", [gwId, sprintId]
  )
  if (!gw.rows.length) return error(404, "Gameweek not found")
  const baseEnergyVal = (typeof base_energy === 'number' && base_energy >= 10 && base_energy <= 60) ? base_energy : null
  await pool.query(
    `UPDATE gameweeks SET
       start_date  = COALESCE($1, start_date),
       end_date    = COALESCE($2, end_date),
       lock_time   = COALESCE($3, lock_time),
       reveal_time = COALESCE($4, reveal_time),
       base_energy = COALESCE($6, base_energy)
     WHERE id=$5`,
    [start_date || null, end_date || null, lock_time || null, reveal_time || null, gwId, baseEnergyVal]
  )
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

module.exports = {
  listDivisions, createDivision, updateDivision, getDivisionUsers,
  listSprints, createSprint, getSprint, updateSprint, activateSprint,
  addSprintGameweek, removeSprintGameweek, updateSprintGameweekDates,
  settleSprint, getRankings, recalculateSprintEntries,
  awardBadgeAdmin,
}
