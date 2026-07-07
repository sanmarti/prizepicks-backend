const axios = require('axios')
const { v4: uuidv4 } = require('uuid')
const { getPool } = require('../../shared/db')
const { getSecrets } = require('../../shared/ssm')
const { ok, error } = require('../../shared/response')
const { awardBadgeAdmin } = require('./sprints')

const API_FOOTBALL_BASE = "https://v3.football.api-sports.io"

function probToEnergyCost(prob) {
  if (prob <= 0.1) return 1; if (prob <= 0.2) return 2
  if (prob <= 0.3) return 3; if (prob <= 0.4) return 4
  if (prob <= 0.5) return 5; if (prob <= 0.6) return 6
  if (prob <= 0.7) return 7; if (prob <= 0.8) return 8
  if (prob <= 0.9) return 9; return null
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
    "SELECT id, event_type, fixture_id, player_name, FALSE AS is_knockout FROM events WHERE gameweek_id = $1",
    [gameweek_id]
  )

  let skipped = 0
  for (const ev of events) {
    const fixture = ev.fixture_id
      ? (await pool.query("SELECT home_goals, away_goals, home_winner, away_winner, pen_home, pen_away, et_home, et_away, status_short FROM fixtures WHERE id=$1", [ev.fixture_id])).rows[0]
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
      const result = adminEvaluateOption(opt.result_key, opt.label, ev.event_type, fixture, cornerTotal, scorers, ev.player_name, ev.is_knockout ?? false)
      await pool.query("UPDATE event_options SET result=$1 WHERE id=$2", [result, opt.id])
    }
  }

  // Score only picks whose options are already resolved (not PENDING)
  const { rows: picks } = await pool.query(
    `SELECT up.id AS pick_id, eo.result AS option_result FROM user_picks up
     JOIN event_options eo ON eo.id=up.event_option_id
     JOIN events e ON e.id=up.event_id
     WHERE e.gameweek_id=$1 AND eo.result != 'PENDING'`, [gameweek_id]
  )
  for (const pick of picks) {
    await pool.query("UPDATE user_picks SET pick_status=$1 WHERE id=$2",
      [pick.option_result === 'WON' ? 'won' : 'lost', pick.pick_id])
  }

  // Only mark FINISHED when all events are settled (no skipped events)
  if (skipped === 0) {
    await pool.query("UPDATE gameweeks SET status='FINISHED' WHERE id=$1", [gameweek_id])
  }

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

function adminEvaluateOption(rk, label, eventType, fixture, cornerTotal, scorers, playerName, isKnockout = false) {
  const lb = (label || '').toLowerCase()
  rk = rk || ''

  const hTotal = fixture.home_goals ?? 0
  const aTotal = fixture.away_goals ?? 0
  const hFt = hTotal - (fixture.et_home ?? 0)
  const aFt = aTotal - (fixture.et_away ?? 0)
  const h = isKnockout ? hTotal : hFt
  const a = isKnockout ? aTotal : aFt

  if (eventType === 'WHO_QUALIFIES') {
    // Exactly one team always qualifies — compute a single source of truth
    // and invert for the other pick so both-lost / both-won is impossible.
    let homeQualifies
    if (fixture.home_winner === true)       homeQualifies = true
    else if (fixture.away_winner === true)  homeQualifies = false
    else if (hTotal > aTotal)               homeQualifies = true
    else if (aTotal > hTotal)               homeQualifies = false
    else {
      // Level after 90 + ET — penalties decide
      const ph = fixture.pen_home ?? null
      const pa = fixture.pen_away ?? null
      if (ph != null && pa != null)         homeQualifies = ph > pa
      else                                  homeQualifies = null // data not yet available
    }
    if (homeQualifies === null) return 'PENDING'
    if (rk === 'HOME_QUALIFIES') return homeQualifies ? 'WON' : 'LOST'
    if (rk === 'AWAY_QUALIFIES') return homeQualifies ? 'LOST' : 'WON'
  }
  // MATCH_RESULT is always 90-min only, regardless of knockout
  if (eventType === 'MATCH_RESULT') {
    if (rk === 'HOME_WIN'  || lb === 'home win')  return hFt > aFt ? 'WON' : 'LOST'
    if (rk === 'AWAY_WIN'  || lb === 'away win')  return aFt > hFt ? 'WON' : 'LOST'
    if (rk === 'DRAW'      || lb === 'draw')       return hFt === aFt ? 'WON' : 'LOST'
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

module.exports = {
  importFixtures, createGameweek, getGameweek, updateGameweek, publishGameweek,
  lockGameweek, unlockGameweek, resolveGameweek,
  adminEvaluateOption, probToEnergyCost,
}
