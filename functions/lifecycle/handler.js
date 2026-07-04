const axios = require("axios")
const { getPool } = require("../../shared/db")
const { getSecrets } = require("../../shared/ssm")

const FINISHED_STATUSES = ['FT', 'AET', 'PEN', 'AWD', 'WO']
const API_FOOTBALL_BASE = "https://v3.football.api-sports.io"

// Award a badge only if the user doesn't already hold it
async function lifecycleAwardBadge(pool, userId, code, sprintId, gameweekId) {
  try {
    const { rows: b } = await pool.query("SELECT id FROM badges WHERE code=$1 AND is_active=TRUE", [code])
    if (!b.length) return
    const { rows: held } = await pool.query(
      "SELECT 1 FROM user_badges WHERE user_id=$1 AND badge_id=$2 LIMIT 1", [userId, b[0].id]
    )
    if (held.length) return
    await pool.query(
      "INSERT INTO user_badges (user_id,badge_id,sprint_id,gameweek_id) VALUES ($1,$2,$3,$4)",
      [userId, b[0].id, sprintId, gameweekId]
    )
  } catch (_) {}
}

// Triggered by EventBridge schedule every 2 minutes
exports.handler = async () => {
  const pool = await getPool()
  const log = { ts: new Date().toISOString() }

  try {
    log.pubRefreshed    = await autoRefreshPublishedFixtures(pool)
    log.unlocked        = await autoUnlockPrematureLocks(pool)
    log.locked          = await autoLockGameweeks(pool)
    log.refreshed       = await autoRefreshFixtures(pool)
    log.settled         = await autoSettleFinishedEvents(pool)
    log.whoQualFix      = await autoFixBrokenWhoQualifies(pool)
    log.resolved        = await autoResolveGameweeks(pool)
    log.gwClosed        = await autoCloseExpiredGameweeks(pool)
    log.sprintSettled   = await autoSettleClosedSprints(pool)
    log.activated       = await autoActivateSprints(pool)
    log.divisionSync    = await syncProgressDivisions(pool)
  } catch (err) {
    console.error("Lifecycle error:", err)
    log.error = err.message
  }

  console.log("Lifecycle run:", JSON.stringify(log))
  return { statusCode: 200, body: JSON.stringify(log) }
}

// 0. Refresh fixture dates for PUBLISHED gameweeks; recalculate lock_time if rescheduled
async function autoRefreshPublishedFixtures(pool) {
  const { rows: pending } = await pool.query(
    `SELECT DISTINCT f.id AS fixture_id, f.date AS stored_date
     FROM fixtures f
     JOIN events e ON e.fixture_id IS NOT NULL AND e.fixture_id::BIGINT = f.id
     JOIN gameweeks g ON g.id = e.gameweek_id
     WHERE g.status = 'PUBLISHED'
       AND (f.updated_at IS NULL OR f.updated_at < NOW() - INTERVAL '12 hours')`
  )
  if (pending.length === 0) return 0

  let secrets
  try { secrets = await getSecrets() } catch { return 0 }

  let updated = 0
  const affectedGameweeks = new Set()

  for (const { fixture_id, stored_date } of pending) {
    try {
      const res = await axios.get(`${API_FOOTBALL_BASE}/fixtures`, {
        params: { id: fixture_id },
        headers: { "x-apisports-key": secrets.key },
        timeout: 8000,
      })
      const apiErrors = res.data?.errors
      if (apiErrors && Object.keys(apiErrors).length > 0) continue
      const apiFixtures = res.data?.response || []
      for (const f of apiFixtures) {
        const newDate = f.fixture.date
        const dateChanged = stored_date && Math.abs(new Date(newDate).getTime() - new Date(stored_date).getTime()) > 60000

        await pool.query(
          `UPDATE fixtures SET date = $1, status_short = $2, updated_at = NOW() WHERE id = $3`,
          [newDate, f.fixture.status.short, f.fixture.id]
        )

        if (dateChanged) {
          // Sync events.match_time for PUBLISHED gameweeks referencing this fixture
          const { rows: evRows } = await pool.query(
            `UPDATE events e SET match_time = $1
             FROM gameweeks g
             WHERE e.fixture_id = $2::text AND e.gameweek_id = g.id AND g.status = 'PUBLISHED'
             RETURNING e.gameweek_id`,
            [newDate, fixture_id]
          )
          for (const { gameweek_id } of evRows) affectedGameweeks.add(gameweek_id)
          console.log(`Fixture ${fixture_id} rescheduled: ${stored_date} → ${newDate}`)
        }
        updated++
      }
    } catch (e) {
      console.error(`Published fixture refresh failed for ${fixture_id}:`, e.message)
    }
  }

  // Recalculate lock_time for all PUBLISHED gameweeks (not just rescheduled ones, for consistency)
  const { rows: pubGws } = await pool.query("SELECT id FROM gameweeks WHERE status = 'PUBLISHED'")
  for (const { id: gwId } of pubGws) {
    try {
      const { rows: evs } = await pool.query(
        "SELECT match_time FROM events WHERE gameweek_id = $1 AND match_time IS NOT NULL", [gwId]
      )
      if (!evs.length) continue
      const earliest = evs.reduce((m, e) => new Date(e.match_time) < new Date(m) ? e.match_time : m, evs[0].match_time)
      const newLock = new Date(new Date(earliest).getTime() - 60 * 60 * 1000)
      await pool.query(
        "UPDATE gameweeks SET lock_time = $1, reveal_time = $1 WHERE id = $2 AND (lock_time IS NULL OR lock_time <> $1)",
        [newLock, gwId]
      )
    } catch (e) {
      console.error(`Failed to recalculate lock_time for gameweek ${gwId}:`, e.message)
    }
  }

  return updated
}

// 1a. Unlock LOCKED gameweeks where no fixture has actually started yet
// (handles premature locks caused by stale lock_time before our auto-calculation fix)
async function autoUnlockPrematureLocks(pool) {
  const { rows } = await pool.query(
    `SELECT g.id
     FROM gameweeks g
     WHERE g.status = 'LOCKED'
       AND NOT EXISTS (
         SELECT 1 FROM events e
         JOIN fixtures f ON e.fixture_id IS NOT NULL AND f.id = e.fixture_id::BIGINT
         WHERE e.gameweek_id = g.id
           AND f.status_short NOT IN ('NS', 'TBD', 'PST', 'CANC', 'ABD')
       )
       AND EXISTS (
         SELECT 1 FROM events e WHERE e.gameweek_id = g.id AND e.fixture_id IS NOT NULL
       )`
  )
  let count = 0
  for (const { id: gwId } of rows) {
    try {
      const { rows: evs } = await pool.query(
        `SELECT match_time FROM events WHERE gameweek_id = $1 AND match_time IS NOT NULL ORDER BY match_time ASC LIMIT 1`,
        [gwId]
      )
      const newLockTime = evs.length > 0
        ? new Date(new Date(evs[0].match_time).getTime() - 60 * 60 * 1000)
        : null

      if (newLockTime && newLockTime <= new Date()) continue

      await pool.query(
        `UPDATE gameweeks SET status = 'PUBLISHED'${newLockTime ? ', lock_time = $2, reveal_time = $2' : ''} WHERE id = $1`,
        newLockTime ? [gwId, newLockTime] : [gwId]
      )
      await pool.query(
        `UPDATE user_gameweek_entries SET status = 'open' WHERE gameweek_id = $1 AND status = 'locked'`,
        [gwId]
      )
      console.log(`Auto-unlocked prematurely locked gameweek ${gwId}, new lock_time: ${newLockTime}`)
      count++
    } catch (e) {
      console.error(`Failed to auto-unlock gameweek ${gwId}:`, e.message)
    }
  }
  return count
}

// 1b. Lock PUBLISHED gameweeks whose lock_time has passed
async function autoLockGameweeks(pool) {
  const { rows } = await pool.query(
    `SELECT id FROM gameweeks WHERE status = 'PUBLISHED' AND lock_time <= NOW()`
  )
  let count = 0
  for (const { id } of rows) {
    try {
      await pool.query("UPDATE gameweeks SET status = 'LOCKED' WHERE id = $1", [id])
      await pool.query(
        "UPDATE user_gameweek_entries SET status = 'locked' WHERE gameweek_id = $1 AND status = 'open'",
        [id]
      )
      console.log(`Auto-locked gameweek ${id}`)
      count++
    } catch (e) {
      console.error(`Failed to lock gameweek ${id}:`, e.message)
    }
  }
  return count
}

// 2. Refresh fixture results for non-finished fixtures in LOCKED gameweeks
async function autoRefreshFixtures(pool) {
  const { rows: pending } = await pool.query(
    `SELECT DISTINCT f.id AS fixture_id
     FROM fixtures f
     JOIN events e ON e.fixture_id IS NOT NULL AND e.fixture_id::BIGINT = f.id
     JOIN gameweeks g ON g.id = e.gameweek_id
     WHERE g.status = 'LOCKED'
       AND (
         -- Normal: not yet finished
         (f.status_short NOT IN ('FT','AET','PEN','AWD','WO','CANC','ABD')
          AND (f.updated_at IS NULL
               OR (f.date <= NOW() AND f.updated_at < NOW() - INTERVAL '1 minute')
               OR (f.date >  NOW() AND f.updated_at < NOW() - INTERVAL '3 minutes')))
         OR
         -- FT with a draw and no winner set: knockout match likely heading to extra time/penalties
         -- Keep refreshing until we get AET/PEN and a determined winner
         (f.status_short = 'FT'
          AND f.home_winner IS NULL
          AND COALESCE(f.home_goals, 0) = COALESCE(f.away_goals, 0)
          AND (f.updated_at IS NULL OR f.updated_at < NOW() - INTERVAL '1 minute')
          AND EXISTS (
            SELECT 1 FROM events e2
            JOIN event_options eo2 ON eo2.event_id = e2.id
            WHERE e2.fixture_id::BIGINT = f.id
              AND e2.event_type = 'WHO_QUALIFIES'
              AND (eo2.result IS NULL OR eo2.result = 'PENDING')
          ))
       )`
  )
  if (pending.length === 0) return 0

  let secrets
  try { secrets = await getSecrets() } catch { return 0 }

  let updated = 0
  for (const { fixture_id } of pending) {
    try {
      const res = await axios.get(`${API_FOOTBALL_BASE}/fixtures`, {
        params: { id: fixture_id },
        headers: { "x-apisports-key": secrets.key },
        timeout: 8000,
      })
      const apiErrors = res.data?.errors
      if (apiErrors && Object.keys(apiErrors).length > 0) continue
      const apiFixtures = res.data?.response || []
      for (const f of apiFixtures) {
        await pool.query(
          `UPDATE fixtures SET
             status_short = $1, status_long = $2, status_elapsed = $3,
             home_goals = $4, away_goals = $5,
             home_winner = $6, away_winner = $7,
             pen_home = $8, pen_away = $9,
             updated_at = NOW()
           WHERE id = $10`,
          [
            f.fixture.status.short,
            f.fixture.status.long,
            f.fixture.status.elapsed ?? null,
            f.goals.home ?? null,
            f.goals.away ?? null,
            f.teams.home.winner ?? null,
            f.teams.away.winner ?? null,
            f.score.penalty?.home ?? null,
            f.score.penalty?.away ?? null,
            f.fixture.id,
          ]
        )
        updated++
      }
    } catch (e) {
      console.error(`Refresh failed for fixture ${fixture_id}:`, e.message)
    }
  }
  return updated
}

// 3. Resolve LOCKED gameweeks where all fixtures are finished
async function autoResolveGameweeks(pool) {
  const { rows: locked } = await pool.query(
    "SELECT id FROM gameweeks WHERE status = 'LOCKED'"
  )
  let count = 0
  for (const { id: gwId } of locked) {
    try {
      // Check for any non-finished fixtures linked to this gameweek
      const { rows: pending } = await pool.query(
        `SELECT COUNT(*)::int AS cnt
         FROM events e
         JOIN fixtures f ON e.fixture_id IS NOT NULL AND f.id = e.fixture_id::BIGINT
         WHERE e.gameweek_id = $1
           AND f.status_short NOT IN ('FT','AET','PEN','AWD','WO','PST','CANC','ABD')`,
        [gwId]
      )
      if (pending[0].cnt > 0) continue

      // Verify there is at least one fixture-linked event (skip config-only gameweeks)
      const { rows: hasEvents } = await pool.query(
        "SELECT COUNT(*)::int AS cnt FROM events WHERE gameweek_id = $1 AND fixture_id IS NOT NULL",
        [gwId]
      )
      if (hasEvents[0].cnt === 0) continue

      await resolveGameweek(pool, gwId)
      count++
    } catch (e) {
      console.error(`Failed to resolve gameweek ${gwId}:`, e.message)
    }
  }
  return count
}

// 4. Auto-activate sprints where start_date <= today and status is scheduled
async function autoActivateSprints(pool) {
  const { rows } = await pool.query(
    `UPDATE sprints SET status = 'live'
     WHERE status = 'scheduled' AND start_date <= CURRENT_DATE
     RETURNING id`
  )
  for (const { id } of rows) {
    try {
      // Seed sprint_progress rows for all users who have a division assigned
      const users = await pool.query("SELECT id FROM users WHERE role = 'user'")
      const divs  = await pool.query("SELECT user_id, division_id, is_rookie FROM user_division_status")
      const divMap = {}
      for (const d of divs.rows) divMap[d.user_id] = d
      for (const u of users.rows) {
        const ds = divMap[u.id]
        if (!ds) continue
        await pool.query(
          `INSERT INTO user_sprint_progress (user_id, sprint_id, division_id, is_rookie, sprint_outcome)
           VALUES ($1,$2,$3,$4,'pending') ON CONFLICT (user_id, sprint_id) DO NOTHING`,
          [u.id, id, ds.division_id, ds.is_rookie]
        )
      }
      console.log(`Auto-activated sprint ${id}`)
    } catch (e) {
      console.error(`Failed to seed progress for sprint ${id}:`, e.message)
    }
  }
  return rows.length
}

// 2b. Per-event settlement: settle individual events as their fixtures finish
async function autoSettleFinishedEvents(pool) {
  // Find events in LOCKED gameweeks whose fixture is done but options not yet settled
  const { rows: events } = await pool.query(
    `SELECT e.id, e.event_type, e.fixture_id, e.player_name, e.gameweek_id
     FROM events e
     JOIN gameweeks g ON g.id = e.gameweek_id
     JOIN fixtures f ON f.id = e.fixture_id::BIGINT
     WHERE g.status = 'LOCKED'
       AND e.fixture_id IS NOT NULL
       AND f.status_short IN ('FT','AET','PEN','AWD','WO')
       AND EXISTS (
         SELECT 1 FROM event_options eo
         WHERE eo.event_id = e.id AND (eo.result IS NULL OR eo.result = 'PENDING')
       )`
  )
  if (events.length === 0) return 0

  let secrets = null
  let settled = 0

  for (const ev of events) {
    try {
      const { rows: fRows } = await pool.query(
        "SELECT home_goals, away_goals, home_winner, away_winner, pen_home, pen_away, status_short FROM fixtures WHERE id = $1",
        [ev.fixture_id]
      )
      const fixture = fRows[0]
      if (!fixture || !FINISHED_STATUSES.includes(fixture.status_short)) continue

      // For WHO_QUALIFIES: a draw at FT with no winner means extra time/penalties are coming.
      // Don't settle yet — autoRefreshFixtures will keep polling until AET or PEN.
      if (ev.event_type === 'WHO_QUALIFIES'
          && fixture.status_short === 'FT'
          && fixture.home_winner == null
          && fixture.away_winner == null
          && (fixture.home_goals ?? 0) === (fixture.away_goals ?? 0)) {
        console.log(`[lifecycle] Deferring WHO_QUALIFIES event ${ev.id}: FT but tied ${fixture.home_goals}-${fixture.away_goals}, waiting for AET/PEN`)
        continue
      }

      let cornerTotal = null
      if (ev.event_type === 'CORNER_OVER') {
        const { rows: cs } = await pool.query(
          `SELECT COALESCE(SUM(stat_value::int), 0) AS total
           FROM fixture_statistics WHERE fixture_id = $1 AND stat_type = 'Corner Kicks'`,
          [ev.fixture_id]
        )
        if (cs[0]?.total > 0) {
          cornerTotal = cs[0].total
        } else {
          // Try to fetch from API
          try {
            if (!secrets) secrets = await getSecrets()
            const stRes = await axios.get(`${API_FOOTBALL_BASE}/fixtures/statistics`, {
              params: { fixture: ev.fixture_id },
              headers: { "x-apisports-key": secrets.key },
              timeout: 8000,
            })
            const apiStats = (stRes.data?.response || []).flatMap(t =>
              (t.statistics || []).map(s => ({ team: t.team.name, team_logo: t.team.logo, stat_type: s.type, stat_value: s.value }))
            )
            for (const s of apiStats) {
              await pool.query(
                `INSERT INTO fixture_statistics (fixture_id,team,team_logo,stat_type,stat_value)
                 VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
                [ev.fixture_id, s.team, s.team_logo, s.stat_type, s.stat_value]
              )
            }
            const corner = apiStats.find(s => s.stat_type === 'Corner Kicks')
            cornerTotal = parseInt(corner?.stat_value ?? 0, 10) || 0
          } catch { cornerTotal = 0 }
        }
      }

      let scorers = []
      if (ev.event_type === 'PLAYER_SCORE' && ev.player_name) {
        const { rows: pe } = await pool.query(
          `SELECT player FROM fixture_events
           WHERE fixture_id = $1 AND type = 'Goal'
             AND (detail IS NULL OR detail NOT ILIKE '%own goal%')`,
          [ev.fixture_id]
        )
        if (pe.length > 0) {
          scorers = pe.map(r => r.player || '')
        } else {
          // Try to fetch from API
          try {
            if (!secrets) secrets = await getSecrets()
            const evRes = await axios.get(`${API_FOOTBALL_BASE}/fixtures/events`, {
              params: { fixture: ev.fixture_id },
              headers: { "x-apisports-key": secrets.key },
              timeout: 8000,
            })
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
            for (const fe of apiEvents) {
              await pool.query(
                `INSERT INTO fixture_events (fixture_id,elapsed,extra,team,team_logo,player,assist,type,detail)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
                [ev.fixture_id, fe.elapsed, fe.extra, fe.team, fe.team_logo, fe.player, fe.assist, fe.type, fe.detail]
              )
            }
            scorers = apiEvents.filter(e => e.type === 'Goal' && !e.detail?.toLowerCase().includes('own goal')).map(e => e.player || '')
          } catch { scorers = [] }
        }
      }

      const { rows: options } = await pool.query(
        "SELECT id, label, result_key FROM event_options WHERE event_id = $1 AND (result IS NULL OR result = 'PENDING')",
        [ev.id]
      )
      for (const opt of options) {
        const result = evaluateOption(opt.result_key, opt.label, ev.event_type, fixture, cornerTotal, scorers, ev.player_name)
        await pool.query("UPDATE event_options SET result = $1 WHERE id = $2", [result, opt.id])
      }

      // Settle user picks for this event
      const { rows: picks } = await pool.query(
        `SELECT up.id AS pick_id, eo.result AS option_result
         FROM user_picks up
         JOIN event_options eo ON eo.id = up.event_option_id
         WHERE up.event_id = $1 AND up.pick_status = 'pending'`,
        [ev.id]
      )
      for (const pick of picks) {
        const status = pick.option_result === 'WON' ? 'won' : 'lost'
        await pool.query("UPDATE user_picks SET pick_status = $1 WHERE id = $2", [status, pick.pick_id])
      }

      settled++
    } catch (e) {
      console.error(`Failed to settle event ${ev.id}:`, e.message)
    }
  }

  // Refresh user_gameweek_entries running totals for all affected gameweeks
  const affectedGwIds = [...new Set(events.map(e => e.gameweek_id))]
  for (const gwId of affectedGwIds) {
    try {
      await pool.query(
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
           WHERE up.gameweek_id = $1
           GROUP BY up.entry_id
         ) agg
         WHERE uge.id = agg.entry_id`,
        [gwId]
      )

      const { rows: gwRow } = await pool.query(
        "SELECT sprint_id FROM gameweeks WHERE id = $1", [gwId]
      )
      const sprintId = gwRow[0]?.sprint_id ?? null
      if (sprintId) {
        await pool.query(
          `UPDATE user_sprint_progress usp SET
             total_correct_picks   = agg.total_correct,
             total_incorrect_picks = agg.total_incorrect,
             total_league_points   = agg.total_lp,
             perfect_weeks         = agg.perfect_weeks
           FROM (
             SELECT uge.user_id,
               COALESCE(SUM(uge.correct_picks),0)::int                        AS total_correct,
               COALESCE(SUM(uge.incorrect_picks),0)::int                      AS total_incorrect,
               COALESCE(SUM(uge.league_points),0)::int                        AS total_lp,
               COUNT(*) FILTER (WHERE uge.is_perfect_week = true)::int        AS perfect_weeks
             FROM user_gameweek_entries uge
             WHERE uge.sprint_id = $1
             GROUP BY uge.user_id
           ) agg
           WHERE usp.user_id = agg.user_id AND usp.sprint_id = $1`,
          [sprintId]
        )
      }

      // Award PERFECT_WEEK badge to users who just completed a perfect week
      const { rows: perfectRows } = await pool.query(
        `SELECT uge.user_id FROM user_gameweek_entries uge
         WHERE uge.gameweek_id = $1
           AND uge.is_perfect_week = true
           AND uge.correct_picks + uge.incorrect_picks = 6`,
        [gwId]
      )
      for (const r of perfectRows) {
        await lifecycleAwardBadge(pool, r.user_id, 'PERFECT_WEEK', sprintId, gwId)
      }

      // Award FIRST_CORRECT badge to users who now have at least 1 correct pick and don't have it yet
      const { rows: correctRows } = await pool.query(
        `SELECT DISTINCT uge.user_id FROM user_gameweek_entries uge
         WHERE uge.gameweek_id = $1 AND uge.correct_picks > 0`,
        [gwId]
      )
      for (const r of correctRows) {
        await lifecycleAwardBadge(pool, r.user_id, 'FIRST_CORRECT', sprintId, gwId)
      }
    } catch (e) {
      console.error(`Failed to refresh entry totals for gameweek ${gwId}:`, e.message)
    }
  }

  return settled
}

// 5. Force-close gameweeks whose end_date has passed but are still open/locked
async function autoCloseExpiredGameweeks(pool) {
  const { rows } = await pool.query(
    `SELECT id FROM gameweeks
     WHERE end_date IS NOT NULL AND end_date <= NOW()
       AND status NOT IN ('FINISHED', 'DRAFT', 'CANCELLED')`
  )
  let count = 0
  for (const { id: gwId } of rows) {
    try {
      // Mark any still-pending event options as LOST so resolveGameweek can score them
      await pool.query(
        `UPDATE event_options eo SET result = 'LOST'
         FROM events e WHERE e.id = eo.event_id AND e.gameweek_id = $1
           AND (eo.result IS NULL OR eo.result = 'PENDING')`,
        [gwId]
      )
      // Ensure gameweek is LOCKED before resolving
      await pool.query(
        `UPDATE gameweeks SET status = 'LOCKED' WHERE id = $1 AND status IN ('PUBLISHED')`,
        [gwId]
      )
      await resolveGameweek(pool, gwId)
      console.log(`Force-closed expired gameweek ${gwId}`)
      count++
    } catch (e) {
      console.error(`Failed to force-close gameweek ${gwId}:`, e.message)
    }
  }
  return count
}

// 6. Auto-settle sprints once all their gameweeks are FINISHED (or end_date passed as fallback)
async function autoSettleClosedSprints(pool) {
  // Primary trigger: all non-DRAFT gameweeks in the sprint are FINISHED
  // Fallback: sprint end_date has passed (catches sprints with no/stuck gameweeks)
  const { rows } = await pool.query(
    `SELECT DISTINCT s.id
     FROM sprints s
     WHERE s.status = 'live'
       AND (
         -- All gameweeks are finished (and there's at least one)
         (
           (SELECT COUNT(*) FROM gameweeks g WHERE g.sprint_id = s.id AND g.status != 'DRAFT') > 0
           AND NOT EXISTS (
             SELECT 1 FROM gameweeks g WHERE g.sprint_id = s.id AND g.status NOT IN ('FINISHED', 'DRAFT', 'CANCELLED')
           )
         )
         -- Fallback: end_date has passed
         OR (s.end_date IS NOT NULL AND s.end_date <= NOW())
       )`
  )
  let count = 0
  for (const { id: sprintId } of rows) {
    try {
      const settled = await settleSprintInternal(pool, sprintId)
      if (settled) { console.log(`Auto-settled sprint ${sprintId}`); count++ }
    } catch (e) {
      console.error(`Failed to auto-settle sprint ${sprintId}:`, e.message)
    }
  }
  return count
}

async function awardBadgeLifecycle(pool, userId, code, sprintId, gameweekId) {
  try {
    const { rows: b } = await pool.query("SELECT id FROM badges WHERE code=$1 AND is_active=TRUE", [code])
    if (!b.length) return
    await pool.query(
      "INSERT INTO user_badges (user_id,badge_id,sprint_id,gameweek_id) VALUES ($1,$2,$3,$4)",
      [userId, b[0].id, sprintId, gameweekId]
    ).catch(() => {})
  } catch (_) {}
}

async function settleBadgesLifecycle(pool, userId, outcome, newDivId, divById, sprintId, perfectWeeks) {
  if (outcome === 'promoted') {
    const existing = await pool.query(
      "SELECT id FROM user_badges ub JOIN badges b ON b.id=ub.badge_id WHERE ub.user_id=$1 AND b.code='FIRST_PROMOTION'",
      [userId]
    )
    if (!existing.rows.length) {
      await awardBadgeLifecycle(pool, userId, 'FIRST_PROMOTION', sprintId, null)
    } else {
      const lastMove = await pool.query(
        "SELECT movement FROM promotion_relegation_history WHERE user_id=$1 ORDER BY created_at DESC LIMIT 2",
        [userId]
      )
      if (lastMove.rows[1]?.movement === 'relegated') {
        await awardBadgeLifecycle(pool, userId, 'COMEBACK', sprintId, null)
      }
    }
    const promoCount = await pool.query(
      "SELECT COUNT(*) FROM promotion_relegation_history WHERE user_id=$1 AND movement='promoted'", [userId]
    )
    if (parseInt(promoCount.rows[0].count) >= 3) {
      const ex = await pool.query(
        "SELECT id FROM user_badges ub JOIN badges b ON b.id=ub.badge_id WHERE ub.user_id=$1 AND b.code='THREE_PROMOTIONS'",
        [userId]
      )
      if (!ex.rows.length) await awardBadgeLifecycle(pool, userId, 'THREE_PROMOTIONS', sprintId, null)
    }
    const newDiv = divById[newDivId]
    if (newDiv) {
      if (newDiv.display_order >= 5) await awardBadgeLifecycle(pool, userId, 'REACHED_DIV1', sprintId, null)
      if (newDiv.is_highest)         await awardBadgeLifecycle(pool, userId, 'REACHED_CHAMPIONS', sprintId, null)
    }
  }
}

async function syncProgressDivisions(pool) {
  // Step 0 — settle users in completed sprints who were skipped (no entries, 0 LP)
  const { rows: unsettled } = await pool.query(
    `SELECT usp.user_id, usp.sprint_id, usp.division_id, usp.is_rookie,
            s.rule_snapshot
     FROM user_sprint_progress usp
     JOIN sprints s ON s.id = usp.sprint_id
     JOIN users u ON u.id = usp.user_id AND u.role = 'user'
     WHERE s.status = 'completed'
       AND usp.sprint_outcome = 'pending'
       AND usp.settled_at IS NULL`
  )

  if (unsettled.length > 0) {
    const { rows: currentDivs } = await pool.query("SELECT * FROM divisions WHERE is_active=TRUE ORDER BY display_order ASC")
    const currentDivById = {}, currentDivByOrder = {}
    for (const d of currentDivs) { currentDivById[d.id] = d; currentDivByOrder[d.display_order] = d }

    for (const rec of unsettled) {
      // Use rule_snapshot from the sprint, fall back to current division rules
      const snapshot = Array.isArray(rec.rule_snapshot) ? rec.rule_snapshot : currentDivs
      const snapById = {}, snapByOrder = {}
      for (const d of snapshot) { snapById[d.id] = d; snapByOrder[d.display_order] = d }

      const currentDiv = snapById[rec.division_id] || currentDivById[rec.division_id]
      if (!currentDiv) continue

      const lp = 0 // no entries = 0 LP
      let outcome = 'retained', newDivId = currentDiv.id

      if (rec.is_rookie) {
        outcome = 'rookie'; newDivId = currentDiv.id
        await pool.query("UPDATE user_division_status SET is_rookie=FALSE, updated_at=NOW() WHERE user_id=$1", [rec.user_id])
      } else if (!currentDiv.is_highest && lp >= currentDiv.promotion_min_points) {
        const next = snapByOrder[currentDiv.display_order + 1] || currentDivByOrder[currentDiv.display_order + 1]
        if (next) { outcome = 'promoted'; newDivId = next.id }
      } else if (currentDiv.allows_relegation && currentDiv.relegation_max_points !== null && lp <= currentDiv.relegation_max_points) {
        const prev = snapByOrder[currentDiv.display_order - 1] || currentDivByOrder[currentDiv.display_order - 1]
        if (prev) { outcome = 'relegated'; newDivId = prev.id }
      }

      await pool.query(
        `UPDATE user_sprint_progress SET sprint_outcome=$1, final_division_id=$2, settled_at=NOW(),
           total_league_points=0, total_correct_picks=0, total_incorrect_picks=0
         WHERE user_id=$3 AND sprint_id=$4`,
        [outcome, newDivId, rec.user_id, rec.sprint_id]
      )
      await pool.query("UPDATE user_division_status SET division_id=$1, updated_at=NOW() WHERE user_id=$2", [newDivId, rec.user_id])
      await pool.query(
        `UPDATE user_sprint_progress usp SET division_id=$1
         FROM sprints s WHERE usp.sprint_id=s.id AND usp.user_id=$2
           AND s.status NOT IN ('completed','archived') AND s.id != $3`,
        [newDivId, rec.user_id, rec.sprint_id]
      )
    }
  }

  // Step 1 — heal user_division_status from last settled outcome
  await pool.query(
    `UPDATE user_division_status uds
     SET division_id = latest.final_division_id, updated_at = NOW()
     FROM (
       SELECT DISTINCT ON (usp.user_id)
         usp.user_id, usp.final_division_id
       FROM user_sprint_progress usp
       JOIN sprints s ON s.id = usp.sprint_id
       WHERE s.status = 'completed'
         AND usp.final_division_id IS NOT NULL
         AND usp.settled_at IS NOT NULL
       ORDER BY usp.user_id, usp.settled_at DESC
     ) latest
     WHERE uds.user_id = latest.user_id
       AND uds.division_id != latest.final_division_id`
  )

  // Step 2 — seed missing progress rows for live/scheduled sprints only (not all drafts)
  await pool.query(
    `INSERT INTO user_sprint_progress (user_id, sprint_id, division_id, is_rookie, sprint_outcome)
     SELECT uds.user_id, s.id, uds.division_id, uds.is_rookie, 'pending'
     FROM user_division_status uds
     CROSS JOIN sprints s
     WHERE uds.user_id IS NOT NULL
       AND s.status IN ('live', 'scheduled')
       AND NOT EXISTS (
         SELECT 1 FROM user_sprint_progress usp
         WHERE usp.user_id = uds.user_id AND usp.sprint_id = s.id
       )`
  )

  // Step 3 — update existing rows where division_id is stale, across all future sprints
  const { rowCount } = await pool.query(
    `UPDATE user_sprint_progress usp
     SET division_id = uds.division_id
     FROM user_division_status uds
     JOIN sprints s ON usp.sprint_id = s.id
     WHERE usp.user_id = uds.user_id
       AND s.status NOT IN ('completed', 'archived')
       AND usp.division_id != uds.division_id`
  )
  return rowCount
}

async function settleSprintInternal(pool, sprintId) {
  const { rows: sRows } = await pool.query("SELECT * FROM sprints WHERE id=$1", [sprintId])
  if (!sRows.length || sRows[0].status !== 'live') return false

  const divsRes = await pool.query("SELECT * FROM divisions WHERE is_active=TRUE ORDER BY display_order ASC")
  const divisions = divsRes.rows
  const divById = {}; const divByOrder = {}
  for (const d of divisions) { divById[d.id] = d; divByOrder[d.display_order] = d }

  // Settle unsettled entries
  const { rows: entries } = await pool.query(
    "SELECT * FROM user_gameweek_entries WHERE sprint_id=$1 AND status NOT IN ('completed','void')",
    [sprintId]
  )
  for (const entry of entries) {
    const { rows: picks } = await pool.query(
      `SELECT up.id, eo.result FROM user_picks up
       JOIN event_options eo ON eo.id=up.event_option_id WHERE up.entry_id=$1`,
      [entry.id]
    )
    if (picks.some(p => !p.result || p.result === 'PENDING')) continue
    const correct = picks.filter(p => p.result === 'WON').length
    const incorrect = picks.filter(p => p.result === 'LOST').length
    const isPerfect = correct === 6
    const bonus = isPerfect ? 4 : 0
    for (const p of picks) {
      await pool.query(
        "UPDATE user_picks SET pick_status=$1, settled_at=NOW() WHERE id=$2",
        [p.result === 'WON' ? 'won' : 'lost', p.id]
      )
    }
    await pool.query(
      `UPDATE user_gameweek_entries SET
         status='completed', correct_picks=$1, incorrect_picks=$2,
         league_points=$3, perfect_week_bonus=$4, is_perfect_week=$5, settled_at=NOW()
       WHERE id=$6`,
      [correct, incorrect, correct + bonus, bonus, isPerfect, entry.id]
    )
    if (isPerfect) await lifecycleAwardBadge(pool, entry.user_id, 'PERFECT_WEEK', sprintId, entry.gameweek_id)
  }

  // Aggregate sprint totals — include users with no entries (0 LP) so they get promoted/relegated too
  const { rows: aggs } = await pool.query(
    `SELECT usp.user_id,
       COALESCE(SUM(uge.correct_picks),0)::int   AS total_correct,
       COALESCE(SUM(uge.incorrect_picks),0)::int AS total_incorrect,
       COALESCE(SUM(uge.league_points),0)::int   AS total_lp,
       COALESCE(SUM(CASE WHEN uge.is_perfect_week THEN 1 ELSE 0 END),0)::int AS perfect_weeks,
       COUNT(uge.id)::int AS gw_count
     FROM user_sprint_progress usp
     LEFT JOIN user_gameweek_entries uge
       ON uge.user_id = usp.user_id AND uge.sprint_id = usp.sprint_id AND uge.status = 'completed'
     JOIN users u ON u.id = usp.user_id AND u.role = 'user'
     WHERE usp.sprint_id=$1
     GROUP BY usp.user_id`,
    [sprintId]
  )

  for (const agg of aggs) {
    const { rows: progRows } = await pool.query(
      "SELECT * FROM user_sprint_progress WHERE user_id=$1 AND sprint_id=$2", [agg.user_id, sprintId]
    )
    if (!progRows.length) continue
    const prog = progRows[0]

    await pool.query(
      `UPDATE user_sprint_progress SET
         total_correct_picks=$1, total_incorrect_picks=$2, total_league_points=$3,
         perfect_weeks=$4, gameweeks_participated=$5
       WHERE user_id=$6 AND sprint_id=$7`,
      [agg.total_correct, agg.total_incorrect, agg.total_lp, agg.perfect_weeks, agg.gw_count, agg.user_id, sprintId]
    )

    if (prog.is_rookie) {
      await pool.query(
        "UPDATE user_sprint_progress SET sprint_outcome='rookie', final_division_id=$1, settled_at=NOW() WHERE user_id=$2 AND sprint_id=$3",
        [prog.division_id, agg.user_id, sprintId]
      )
      await pool.query("UPDATE user_division_status SET is_rookie=FALSE, updated_at=NOW() WHERE user_id=$1", [agg.user_id])
      continue
    }

    const currentDiv = divById[prog.division_id]
    if (!currentDiv) continue
    const lp = agg.total_lp
    let outcome = 'retained', newDivId = currentDiv.id

    if (!currentDiv.is_highest && lp >= currentDiv.promotion_min_points) {
      const nextDiv = divByOrder[currentDiv.display_order + 1]
      if (nextDiv) { outcome = 'promoted'; newDivId = nextDiv.id }
    } else if (currentDiv.allows_relegation && currentDiv.relegation_max_points !== null && lp <= currentDiv.relegation_max_points) {
      const prevDiv = divByOrder[currentDiv.display_order - 1]
      if (prevDiv) { outcome = 'relegated'; newDivId = prevDiv.id }
    }

    await pool.query(
      "UPDATE user_sprint_progress SET sprint_outcome=$1, final_division_id=$2, settled_at=NOW() WHERE user_id=$3 AND sprint_id=$4",
      [outcome, newDivId, agg.user_id, sprintId]
    )
    await pool.query("UPDATE user_division_status SET division_id=$1, updated_at=NOW() WHERE user_id=$2", [newDivId, agg.user_id])
    // Update already-seeded progress rows in any future sprint so rankings reflect the new division immediately
    await pool.query(
      `UPDATE user_sprint_progress usp
       SET division_id = $1
       FROM sprints s
       WHERE usp.sprint_id = s.id AND usp.user_id = $2
         AND s.status NOT IN ('completed', 'archived')
         AND s.id != $3`,
      [newDivId, agg.user_id, sprintId]
    )
    await pool.query(
      `INSERT INTO promotion_relegation_history (user_id,sprint_id,from_division_id,to_division_id,movement,league_points)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [agg.user_id, sprintId, currentDiv.id, newDivId, outcome, lp]
    )
    await settleBadgesLifecycle(pool, agg.user_id, outcome, newDivId, divById, sprintId, agg.perfect_weeks)
  }

  // Consistent Player / Perfect Month badges
  for (const agg of aggs) {
    if (agg.gw_count >= 4) await lifecycleAwardBadge(pool, agg.user_id, 'CONSISTENT_PLAYER', sprintId, null)
    if (agg.perfect_weeks >= 4) await lifecycleAwardBadge(pool, agg.user_id, 'PERFECT_MONTH', sprintId, null)
  }

  // Division champion badges
  const DIV_CHAMP_CODE = { 1:'DIV_CHAMP_ACADEMY',2:'DIV_CHAMP_SUNDAY',3:'DIV_CHAMP_DIV3',4:'DIV_CHAMP_DIV2',5:'DIV_CHAMP_DIV1',6:'DIV_CHAMP_CHAMPIONS' }
  const { rows: divRanks } = await pool.query(
    `SELECT user_id, division_id FROM (
       SELECT usp.user_id, usp.division_id,
         RANK() OVER (PARTITION BY usp.division_id ORDER BY usp.total_league_points DESC, usp.total_correct_picks DESC) AS div_rank
       FROM user_sprint_progress usp WHERE usp.sprint_id=$1
     ) r WHERE div_rank=1`, [sprintId]
  )
  for (const row of divRanks) {
    const div = divById[row.division_id]
    const code = div && DIV_CHAMP_CODE[div.display_order]
    if (code) await lifecycleAwardBadge(pool, row.user_id, code, sprintId, null)
  }

  // Sprint winner badge
  const { rows: winners } = await pool.query(
    `SELECT user_id FROM (
       SELECT usp.user_id,
         RANK() OVER (ORDER BY usp.total_league_points DESC, usp.total_correct_picks DESC) AS overall_rank
       FROM user_sprint_progress usp WHERE usp.sprint_id=$1
     ) r WHERE overall_rank=1`, [sprintId]
  )
  for (const row of winners) await lifecycleAwardBadge(pool, row.user_id, 'SPRINT_WINNER', sprintId, null)

  await pool.query(
    "UPDATE sprints SET status='completed', settled_at=NOW(), rule_snapshot=$1 WHERE id=$2",
    [JSON.stringify(divisions), sprintId]
  )
  return true
}

// Inline resolve logic — mirrors scoring/handler.js resolve()
async function resolveGameweek(pool, gameweek_id) {
  console.log(`Auto-resolving gameweek ${gameweek_id}`)

  const { rows: events } = await pool.query(
    "SELECT id, event_type, fixture_id, player_name FROM events WHERE gameweek_id = $1",
    [gameweek_id]
  )

  for (const ev of events) {
    if (!ev.fixture_id) continue
    const { rows: fRows } = await pool.query(
      "SELECT home_goals, away_goals, home_winner, away_winner, pen_home, pen_away, status_short FROM fixtures WHERE id = $1",
      [ev.fixture_id]
    )
    const fixture = fRows[0]
    if (!fixture || !FINISHED_STATUSES.includes(fixture.status_short)) continue

    let cornerTotal = null
    if (ev.event_type === 'CORNER_OVER') {
      const { rows: cs } = await pool.query(
        `SELECT COALESCE(SUM(stat_value::int), 0) AS total
         FROM fixture_statistics WHERE fixture_id = $1 AND stat_type = 'Corner Kicks'`,
        [ev.fixture_id]
      )
      cornerTotal = cs[0]?.total ?? 0
    }

    let scorers = []
    if (ev.event_type === 'PLAYER_SCORE' && ev.player_name) {
      const { rows: pe } = await pool.query(
        `SELECT player FROM fixture_events
         WHERE fixture_id = $1 AND type = 'Goal'
           AND (detail IS NULL OR detail NOT ILIKE '%own goal%')`,
        [ev.fixture_id]
      )
      scorers = pe.map(r => r.player || '')
    }

    const { rows: options } = await pool.query(
      "SELECT id, label, result_key FROM event_options WHERE event_id = $1",
      [ev.id]
    )
    for (const opt of options) {
      const result = evaluateOption(
        opt.result_key, opt.label, ev.event_type, fixture, cornerTotal, scorers, ev.player_name
      )
      await pool.query("UPDATE event_options SET result = $1 WHERE id = $2", [result, opt.id])
    }
  }

  // Score user picks
  const { rows: picks } = await pool.query(
    `SELECT up.id AS pick_id, eo.result AS option_result
     FROM user_picks up
     JOIN event_options eo ON eo.id = up.event_option_id
     JOIN events e ON e.id = up.event_id
     WHERE e.gameweek_id = $1`,
    [gameweek_id]
  )
  for (const pick of picks) {
    const status = pick.option_result === 'WON' ? 'won' : 'lost'
    await pool.query("UPDATE user_picks SET pick_status = $1 WHERE id = $2", [status, pick.pick_id])
  }

  await pool.query("UPDATE gameweeks SET status = 'FINISHED' WHERE id = $1", [gameweek_id])

  // Compute league_points / correct_picks / perfect week on each entry from settled picks
  await pool.query(
    `UPDATE user_gameweek_entries uge SET
       correct_picks      = agg.correct,
       incorrect_picks    = agg.incorrect,
       is_perfect_week    = (agg.correct = 6 AND agg.correct + agg.incorrect = 6),
       perfect_week_bonus = CASE WHEN agg.correct = 6 AND agg.correct + agg.incorrect = 6 THEN 4 ELSE 0 END,
       league_points      = agg.correct + CASE WHEN agg.correct = 6 AND agg.correct + agg.incorrect = 6 THEN 4 ELSE 0 END,
       status             = 'completed',
       settled_at         = NOW()
     FROM (
       SELECT up.entry_id,
         COUNT(*) FILTER (WHERE up.pick_status = 'won')::int  AS correct,
         COUNT(*) FILTER (WHERE up.pick_status = 'lost')::int AS incorrect
       FROM user_picks up
       WHERE up.gameweek_id = $1
       GROUP BY up.entry_id
     ) agg
     WHERE uge.id = agg.entry_id AND uge.status != 'void'`,
    [gameweek_id]
  )

  const { rows: gwRow } = await pool.query("SELECT sprint_id FROM gameweeks WHERE id=$1", [gameweek_id])
  const sprintId = gwRow[0]?.sprint_id ?? null
  if (sprintId) {
    // Recompute sprint totals from all settled entries for this sprint
    await pool.query(
      `UPDATE user_sprint_progress usp SET
         total_correct_picks   = agg.total_correct,
         total_incorrect_picks = agg.total_incorrect,
         total_league_points   = agg.total_lp,
         perfect_weeks         = agg.perfect_weeks,
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
  }
  console.log(`Gameweek ${gameweek_id} auto-resolved → FINISHED`)
}

function evaluateOption(resultKey, label, eventType, fixture, cornerTotal, scorers, playerName) {
  const rk = resultKey || ''
  const lb = (label || '').toLowerCase()
  const h = fixture.home_goals ?? 0
  const a = fixture.away_goals ?? 0

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
    const total = h + a
    const m = rk.match(/^(OVER|UNDER)_([\d.]+)$/)
    if (m) { const t = parseFloat(m[2]); return m[1] === 'OVER' ? (total > t ? 'WON' : 'LOST') : (total < t ? 'WON' : 'LOST') }
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
    const total = cornerTotal ?? 0
    const m = rk.match(/^CORNER_(OVER|UNDER)_([\d.]+)$/)
    if (m) { const t = parseFloat(m[2]); return m[1] === 'OVER' ? (total > t ? 'WON' : 'LOST') : (total < t ? 'WON' : 'LOST') }
  }
  if (eventType === 'PLAYER_SCORE' && playerName) {
    const scored = (scorers || []).some(s => playerNameMatches(playerName, s))
    if (rk === 'PLAYER_SCORES')   return scored ? 'WON' : 'LOST'
    if (rk === 'PLAYER_NO_SCORE') return scored ? 'LOST' : 'WON'
  }
  return 'LOST'
}

function playerNameMatches(adminName, apiName) {
  const na = norm(adminName), nb = norm(apiName)
  if (!na || !nb) return false
  if (na === nb || nb.includes(na) || na.includes(nb)) return true
  const la = lastName(na), lb = lastName(nb)
  if (la.length >= 3 && la === lb) return true
  return false
}

function norm(s) {
  return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
}
function lastName(s) {
  const parts = s.split(' ').filter(p => p.length > 1)
  return parts[parts.length - 1] || ''
}

// Self-healing: detect WHO_QUALIFIES events where ALL options are LOST — impossible in real football.
// This is the signature of the FT-draw early-settlement bug. Re-fetches fixture and resettles.
async function autoFixBrokenWhoQualifies(pool) {
  const { rows: broken } = await pool.query(
    `SELECT e.id AS event_id, e.fixture_id, e.gameweek_id, g.sprint_id, f.competition_id
     FROM events e
     JOIN event_options eo ON eo.event_id = e.id
     JOIN gameweeks g ON g.id = e.gameweek_id
     LEFT JOIN fixtures f ON f.id = e.fixture_id::BIGINT
     WHERE e.event_type = 'WHO_QUALIFIES'
       AND e.fixture_id IS NOT NULL
     GROUP BY e.id, e.fixture_id, e.gameweek_id, g.sprint_id, f.competition_id
     HAVING COUNT(*) FILTER (WHERE eo.result = 'WON') = 0
        AND COUNT(*) FILTER (WHERE eo.result = 'LOST') > 0`
  )
  if (broken.length === 0) return 0

  let secrets = null
  let fixed = 0

  for (const ev of broken) {
    try {
      if (!secrets) {
        try { secrets = await getSecrets() } catch { continue }
      }

      // Force-refresh fixture from API
      const res = await axios.get(`${API_FOOTBALL_BASE}/fixtures`, {
        params: { id: ev.fixture_id },
        headers: { "x-apisports-key": secrets.key },
        timeout: 8000,
      })
      const apiFixtures = res.data?.response || []
      if (!apiFixtures.length) continue

      const f = apiFixtures[0]
      await pool.query(
        `UPDATE fixtures SET
           status_short = $1, status_long = $2, status_elapsed = $3,
           home_goals = $4, away_goals = $5,
           home_winner = $6, away_winner = $7,
           pen_home = $8, pen_away = $9,
           updated_at = NOW()
         WHERE id = $10`,
        [
          f.fixture.status.short, f.fixture.status.long, f.fixture.status.elapsed ?? null,
          f.goals.home ?? null, f.goals.away ?? null,
          f.teams.home.winner ?? null, f.teams.away.winner ?? null,
          f.score.penalty?.home ?? null, f.score.penalty?.away ?? null,
          ev.fixture_id,
        ]
      )

      // Re-read updated fixture
      const fxRes = await pool.query(
        `SELECT home_goals, away_goals, home_winner, away_winner, pen_home, pen_away, status_short
         FROM fixtures WHERE id = $1`, [ev.fixture_id]
      )
      const fixture = fxRes.rows[0]
      if (!fixture || !FINISHED_STATUSES.includes(fixture.status_short)) continue

      // If still a draw at FT with no winner, skip — game may not be fully done
      if (fixture.status_short === 'FT'
          && fixture.home_winner == null
          && (fixture.home_goals ?? 0) === (fixture.away_goals ?? 0)) continue

      // Re-evaluate options
      const optRes = await pool.query(
        `SELECT id, result_key, label FROM event_options WHERE event_id = $1`, [ev.event_id]
      )
      for (const opt of optRes.rows) {
        const newResult = evaluateOption(opt.result_key, opt.label, 'WHO_QUALIFIES', fixture, null, [], null)
        await pool.query(`UPDATE event_options SET result = $1 WHERE id = $2`, [newResult, opt.id])
      }

      // Re-settle user picks
      await pool.query(
        `UPDATE user_picks up SET pick_status = 'won'
         FROM event_options eo
         WHERE eo.id = up.event_option_id AND eo.event_id = $1 AND eo.result = 'WON'`,
        [ev.event_id]
      )
      await pool.query(
        `UPDATE user_picks up SET pick_status = 'lost'
         FROM event_options eo
         WHERE eo.id = up.event_option_id AND eo.event_id = $1 AND eo.result = 'LOST'`,
        [ev.event_id]
      )

      // Recalculate gameweek entries
      await pool.query(
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
        [ev.sprint_id]
      )

      // Recalculate sprint progress
      await pool.query(
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
        [ev.sprint_id]
      )

      console.log(`[autoFixBrokenWhoQualifies] fixed event ${ev.event_id} fixture ${ev.fixture_id}: ${fixture.status_short} ${fixture.home_goals}-${fixture.away_goals} hw=${fixture.home_winner} aw=${fixture.away_winner}`)
      fixed++
    } catch (e) {
      console.error(`[autoFixBrokenWhoQualifies] failed for event ${ev.event_id}:`, e.message)
    }
  }
  return fixed
}
