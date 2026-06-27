const axios = require("axios")
const { getPool } = require("../../shared/db")
const { getSecrets } = require("../../shared/ssm")

const FINISHED_STATUSES = ['FT', 'AET', 'PEN', 'AWD', 'WO']
const API_FOOTBALL_BASE = "https://v3.football.api-sports.io"

// Triggered by EventBridge schedule every 5 minutes
exports.handler = async () => {
  const pool = await getPool()
  const log = { ts: new Date().toISOString() }

  try {
    log.pubRefreshed = await autoRefreshPublishedFixtures(pool)
    log.unlocked     = await autoUnlockPrematureLocks(pool)
    log.locked       = await autoLockGameweeks(pool)
    log.refreshed    = await autoRefreshFixtures(pool)
    log.settled      = await autoSettleFinishedEvents(pool)
    log.resolved     = await autoResolveGameweeks(pool)
    log.activated    = await autoActivateSprints(pool)
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
       AND f.status_short NOT IN ('FT','AET','PEN','AWD','WO','PST','CANC','ABD')
       AND (f.updated_at IS NULL OR f.updated_at < NOW() - INTERVAL '3 minutes')`
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
             home_goals = $4, away_goals = $5, updated_at = NOW()
           WHERE id = $6`,
          [
            f.fixture.status.short,
            f.fixture.status.long,
            f.fixture.status.elapsed ?? null,
            f.goals.home ?? null,
            f.goals.away ?? null,
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
        "SELECT home_goals, away_goals, status_short FROM fixtures WHERE id = $1",
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
           correct_picks   = agg.correct,
           incorrect_picks = agg.incorrect,
           league_points   = agg.correct
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
      if (gwRow[0]?.sprint_id) {
        const sprintId = gwRow[0].sprint_id
        await pool.query(
          `UPDATE user_sprint_progress usp SET
             total_correct_picks   = agg.total_correct,
             total_incorrect_picks = agg.total_incorrect,
             total_league_points   = agg.total_lp
           FROM (
             SELECT uge.user_id,
               COALESCE(SUM(uge.correct_picks),0)::int   AS total_correct,
               COALESCE(SUM(uge.incorrect_picks),0)::int AS total_incorrect,
               COALESCE(SUM(uge.league_points),0)::int   AS total_lp
             FROM user_gameweek_entries uge
             WHERE uge.sprint_id = $1
             GROUP BY uge.user_id
           ) agg
           WHERE usp.user_id = agg.user_id AND usp.sprint_id = $1`,
          [sprintId]
        )
      }
    } catch (e) {
      console.error(`Failed to refresh entry totals for gameweek ${gwId}:`, e.message)
    }
  }

  return settled
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
      "SELECT home_goals, away_goals, status_short FROM fixtures WHERE id = $1",
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
    const status = pick.option_result === 'WON' ? 'WON' : 'LOST'
    await pool.query("UPDATE user_picks SET pick_status = $1 WHERE id = $2", [status, pick.pick_id])
  }

  await pool.query("UPDATE gameweeks SET status = 'FINISHED' WHERE id = $1", [gameweek_id])
  console.log(`Gameweek ${gameweek_id} auto-resolved → FINISHED`)
}

function evaluateOption(resultKey, label, eventType, fixture, cornerTotal, scorers, playerName) {
  const rk = resultKey || ''
  const lb = (label || '').toLowerCase()
  const h = fixture.home_goals ?? 0
  const a = fixture.away_goals ?? 0

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
