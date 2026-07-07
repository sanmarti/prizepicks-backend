const axios = require('axios')
const { getPool } = require('../../shared/db')
const { getSecrets } = require('../../shared/ssm')
const { ok, error } = require('../../shared/response')
const { apiFixtureToRow, upsertFixtures } = require('./competitions')
const { adminEvaluateOption } = require('./gameweeks')

const API_FOOTBALL_BASE = 'https://v3.football.api-sports.io'

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

async function updateEvent(event) {
  const { id } = event.pathParameters
  const body = JSON.parse(event.body || '{}')
  const pool = await getPool()
  const { rows } = await pool.query('SELECT id FROM events WHERE id=$1', [id])
  if (!rows.length) return error(404, 'Event not found')
  const updates = []
  const params = []
  if (typeof body.is_knockout === 'boolean') {
    params.push(body.is_knockout); updates.push(`is_knockout=$${params.length}`)
  }
  if (!updates.length) return error(400, 'No updatable fields provided')
  params.push(id)
  await pool.query(`UPDATE events SET ${updates.join(',')} WHERE id=$${params.length}`, params)
  return ok({ id, updated: body })
}

async function resettleEvent(event) {
  const { id: eventId } = event.pathParameters
  const pool = await getPool()

  const evRes = await pool.query(
    `SELECT e.id, e.event_type, e.fixture_id, e.gameweek_id, FALSE AS is_knockout,
            g.sprint_id,
            f.id AS fid, f.competition_id,
            f.home_goals, f.away_goals, f.home_winner, f.away_winner,
            f.pen_home, f.pen_away, f.et_home, f.et_away
     FROM events e
     JOIN gameweeks g ON g.id = e.gameweek_id
     LEFT JOIN fixtures f ON f.id = e.fixture_id
     WHERE e.id = $1`,
    [eventId]
  )
  if (!evRes.rows.length) return error(404, "Event not found")
  const ev = evRes.rows[0]
  if (!ev.fixture_id) return error(400, "Event has no linked fixture — cannot re-settle")

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
      const fxRes = await pool.query(
        `SELECT home_goals, away_goals, home_winner, away_winner, pen_home, pen_away, et_home, et_away
         FROM fixtures WHERE id = $1`, [ev.fixture_id]
      )
      if (fxRes.rows.length) fixture = { ...ev, ...fxRes.rows[0] }
      console.log(`[resettle] refreshed fixture ${ev.fixture_id}: ${JSON.stringify(fxRes.rows[0])}`)
    }
  } catch (e) {
    console.error(`[resettle] fixture refresh failed, using DB data:`, e.message)
  }

  const optRes = await pool.query(
    `SELECT eo.id, eo.result_key, eo.label, eo.result
     FROM event_options eo WHERE eo.event_id = $1`,
    [eventId]
  )
  if (!optRes.rows.length) return error(400, "No event options found")

  let optionsUpdated = 0
  let wonOptionId = null

  for (const opt of optRes.rows) {
    const newResult = adminEvaluateOption(opt.result_key, opt.label, ev.event_type, fixture, null, [], null, ev.is_knockout ?? false)
    await pool.query(`UPDATE event_options SET result = $1 WHERE id = $2`, [newResult, opt.id])
    if (newResult === 'WON') wonOptionId = opt.id
    optionsUpdated++
    console.log(`[resettle] option ${opt.id} (${opt.result_key}): ${opt.result} → ${newResult}`)
  }

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
    event_id:        eventId,
    fixture_id:      ev.fixture_id,
    fixture_data:    { home_goals: fixture.home_goals, away_goals: fixture.away_goals, home_winner: fixture.home_winner, away_winner: fixture.away_winner, pen_home: fixture.pen_home, pen_away: fixture.pen_away },
    options_updated: optionsUpdated,
    won_option_id:   wonOptionId,
    picks_won:       wonPicks,
    picks_lost:      lostPicks,
    entries_fixed:   entriesFixed,
    progress_fixed:  progressFixed,
    sprint_id:       sprintId,
  })
}

async function fixBrokenWhoQualifies(event) {
  const pool = await getPool()

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

  if (broken.length === 0) {
    return ok({ fixed: 0, message: "No broken WHO_QUALIFIES events found — all look correct" })
  }

  let secrets = null
  const results = []

  for (const ev of broken) {
    try {
      let fixture = null
      try {
        if (!secrets) secrets = await getSecrets()
        const res = await axios.get(`${API_FOOTBALL_BASE}/fixtures`, {
          params: { id: ev.fixture_id },
          headers: { "x-apisports-key": secrets.key },
          timeout: 8000,
        })
        const apiFixtures = res.data?.response || []
        if (apiFixtures.length > 0) {
          const row = apiFixtureToRow(apiFixtures[0], ev.competition_id)
          await upsertFixtures(pool, [row])
          console.log(`[fix-who-qualifies] refreshed fixture ${ev.fixture_id}: ${row.status_short} ${row.home_goals}-${row.away_goals} hw=${row.home_winner} aw=${row.away_winner} ph=${row.pen_home} pa=${row.pen_away}`)
        }
      } catch (e) {
        console.error(`[fix-who-qualifies] fixture refresh failed for ${ev.fixture_id}:`, e.message)
      }

      const fxRes = await pool.query(
        `SELECT home_goals, away_goals, home_winner, away_winner, pen_home, pen_away, et_home, et_away, status_short
         FROM fixtures WHERE id = $1`, [ev.fixture_id]
      )
      fixture = fxRes.rows[0]
      if (!fixture) { results.push({ event_id: ev.event_id, error: 'fixture not found' }); continue }

      const optRes = await pool.query(
        `SELECT id, result_key, label FROM event_options WHERE event_id = $1`, [ev.event_id]
      )
      let wonOptionId = null
      for (const opt of optRes.rows) {
        const newResult = adminEvaluateOption(opt.result_key, opt.label, 'WHO_QUALIFIES', fixture, null, [], null)
        await pool.query(`UPDATE event_options SET result = $1 WHERE id = $2`, [newResult, opt.id])
        if (newResult === 'WON') wonOptionId = opt.id
      }

      const { rowCount: wonPicks } = await pool.query(
        `UPDATE user_picks up SET pick_status = 'won'
         FROM event_options eo
         WHERE eo.id = up.event_option_id AND eo.event_id = $1 AND eo.result = 'WON'`,
        [ev.event_id]
      )
      const { rowCount: lostPicks } = await pool.query(
        `UPDATE user_picks up SET pick_status = 'lost'
         FROM event_options eo
         WHERE eo.id = up.event_option_id AND eo.event_id = $1 AND eo.result = 'LOST'`,
        [ev.event_id]
      )

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
        [ev.gameweek_id]
      )

      await pool.query(
        `UPDATE user_sprint_progress usp SET
           total_correct_picks   = agg.total_correct,
           total_incorrect_picks = agg.total_incorrect,
           total_league_points   = agg.total_lp,
           perfect_weeks         = agg.perfect_weeks
         FROM (
           SELECT uge.user_id,
             COALESCE(SUM(uge.correct_picks), 0)::int                AS total_correct,
             COALESCE(SUM(uge.incorrect_picks), 0)::int              AS total_incorrect,
             COALESCE(SUM(uge.league_points), 0)::int                AS total_lp,
             COUNT(*) FILTER (WHERE uge.is_perfect_week = true)::int AS perfect_weeks
           FROM user_gameweek_entries uge
           WHERE uge.sprint_id = $1
           GROUP BY uge.user_id
         ) agg
         WHERE usp.user_id = agg.user_id AND usp.sprint_id = $1`,
        [ev.sprint_id]
      )

      results.push({
        event_id:   ev.event_id,
        fixture_id: ev.fixture_id,
        fixture:    { status: fixture.status_short, home: fixture.home_goals, away: fixture.away_goals, hw: fixture.home_winner, aw: fixture.away_winner, ph: fixture.pen_home, pa: fixture.pen_away },
        won_option: wonOptionId,
        picks_won:  wonPicks,
        picks_lost: lostPicks,
      })
    } catch (e) {
      console.error(`[fix-who-qualifies] failed for event ${ev.event_id}:`, e.message)
      results.push({ event_id: ev.event_id, error: e.message })
    }
  }

  return ok({ fixed: results.filter(r => !r.error).length, total_broken: broken.length, results })
}

async function fixDivisions(event) {
  const pool = await getPool()

  const { rows: divs } = await pool.query("SELECT id, display_order FROM divisions WHERE is_active=TRUE ORDER BY display_order")
  const academy      = divs.find(d => d.display_order === 1)
  const sundayLeague = divs.find(d => d.display_order === 2)
  if (!academy || !sundayLeague) return error(400, "Divisions not found")

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

  const { rowCount: statusFixed } = await pool.query(
    `UPDATE user_division_status SET division_id = $1, updated_at = NOW()
     WHERE division_id = $2
       AND user_id IN (SELECT id FROM users WHERE role = 'user')`,
    [sundayLeague.id, academy.id]
  )

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

module.exports = { debugDivisions, updateEvent, resettleEvent, fixBrokenWhoQualifies, fixDivisions }
