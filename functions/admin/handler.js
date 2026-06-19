const axios = require("axios")
const { v4: uuidv4 } = require("uuid")
const { getPool } = require("../../shared/db")
const { getSecrets } = require("../../shared/ssm")
const { verifyToken, extractFromEvent } = require("../../shared/auth")
const { ok, error, unauthorized } = require("../../shared/response")

const API_FOOTBALL_BASE = "https://v3.football.api-sports.io"

exports.handler = async (event) => {
  const routeKey = event.routeKey

  // Public route — no auth required
  if (routeKey === "GET /competitions") {
    try { return await listCompetitions() }
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
    if (routeKey === "POST /admin/publish")         return await publishGameweek(event)
    if (routeKey === "GET /admin/users")            return await listUsers()
    if (routeKey === "GET /admin/leagues")          return await listLeagues()
    if (routeKey === "GET /admin/stats")            return await getStats()
    if (routeKey === "GET /admin/odds")             return await getOddsForFixture(event)
    if (routeKey === "GET /admin/competitions")              return await listCompetitions()
    if (routeKey === "POST /admin/competitions")             return await createCompetition(event)
    if (routeKey === "PUT /admin/competitions/{id}")         return await updateCompetition(event)
    if (routeKey === "DELETE /admin/competitions/{id}")      return await deleteCompetition(event)
    if (routeKey === "GET /admin/competitions/{id}/calendar")   return await getCompetitionCalendar(event)
    if (routeKey === "GET /admin/competitions/{id}/gameweeks")  return await getCompetitionGameweeks(event)
    if (routeKey === "GET /admin/competitions/{id}/standings")  return await getCompetitionStandings(event)
    if (routeKey === "GET /admin/fixtures/{fixtureId}/details") return await getFixtureDetails(event)
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
      COALESCE(ew.balance, 0) AS energy_balance
    FROM users u
    LEFT JOIN energy_wallets ew ON ew.user_id = u.id
    ORDER BY u.created_at DESC
  `)
  return ok(rows)
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
        "INSERT INTO event_options (id, event_id, label, energy_cost) VALUES ($1,$2,$3,$4)",
        [uuidv4(), eventId, opt.label, energyCost]
      )
    }
  }
  return ok({ gameweekId: gwId }, 201)
}

async function publishGameweek(event) {
  const { gameweek_id } = JSON.parse(event.body || "{}")
  if (!gameweek_id) return error(400, "gameweek_id is required")
  const pool = await getPool()

  const gwResult = await pool.query(
    "SELECT id, competition_id, week_number FROM gameweeks WHERE id=$1 AND status='DRAFT'",
    [gameweek_id]
  )
  if (!gwResult.rows.length) return error(404, "Gameweek not found or not DRAFT")
  const { competition_id, week_number } = gwResult.rows[0]

  await pool.query("UPDATE gameweeks SET status='PUBLISHED' WHERE id=$1", [gameweek_id])

  // Generate matchups for EVERY active league in this competition
  const leaguesResult = await pool.query(
    "SELECT id FROM leagues WHERE competition_id=$1 AND status='ACTIVE'",
    [competition_id]
  )

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
    leagues_affected: leaguesResult.rows.length,
    matchupsCreated: totalMatchups
  })
}

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
        updated_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
        $17,$18,$19,$20,$21,$22,$23,$24, NOW()
      )
      ON CONFLICT (id) DO UPDATE SET
        status_short=EXCLUDED.status_short, status_long=EXCLUDED.status_long,
        status_elapsed=EXCLUDED.status_elapsed, home_winner=EXCLUDED.home_winner,
        away_winner=EXCLUDED.away_winner, home_goals=EXCLUDED.home_goals,
        away_goals=EXCLUDED.away_goals, ht_home=EXCLUDED.ht_home, ht_away=EXCLUDED.ht_away,
        et_home=EXCLUDED.et_home, et_away=EXCLUDED.et_away,
        pen_home=EXCLUDED.pen_home, pen_away=EXCLUDED.pen_away,
        referee=EXCLUDED.referee, updated_at=NOW()
      `, [
        r.id, r.competition_id, r.round, r.date, r.status_short, r.status_long, r.status_elapsed,
        r.referee, r.venue_name, r.venue_city,
        r.home_team, r.home_logo, r.home_winner, r.away_team, r.away_logo, r.away_winner,
        r.home_goals, r.away_goals, r.ht_home, r.ht_away, r.et_home, r.et_away, r.pen_home, r.pen_away,
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
