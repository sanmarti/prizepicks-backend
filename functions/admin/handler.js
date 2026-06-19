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

async function getCompetitionCalendar(event) {
  const { id } = event.pathParameters
  const pool = await getPool()

  const comp = await pool.query(
    "SELECT id, name, api_league_id, api_season FROM competitions WHERE id=$1",
    [id]
  )
  if (!comp.rows.length) return error(404, "Competition not found")
  const { api_league_id, api_season } = comp.rows[0]
  if (!api_league_id || !api_season)
    return error(422, "Competition has no API-Football league/season configured")

  const secrets = await getSecrets()
  const res = await axios.get(`${API_FOOTBALL_BASE}/fixtures`, {
    params: { league: api_league_id, season: api_season },
    headers: { "x-apisports-key": secrets.key }
  })

  const apiErrors = res.data?.errors
  if (apiErrors && Object.keys(apiErrors).length > 0) {
    return error(402, Object.values(apiErrors).join(' '))
  }

  // Group fixtures by round
  const roundMap = {}
  for (const f of (res.data?.response || [])) {
    const round = f.league.round
    if (!roundMap[round]) roundMap[round] = []
    roundMap[round].push({
      id:              f.fixture.id,
      date:            f.fixture.date,
      status_short:    f.fixture.status.short,
      status_long:     f.fixture.status.long,
      status_elapsed:  f.fixture.status.elapsed,
      referee:         f.fixture.referee ?? null,
      venue_name:      f.fixture.venue?.name ?? null,
      venue_city:      f.fixture.venue?.city ?? null,
      home:            f.teams.home.name,
      home_logo:       f.teams.home.logo,
      home_winner:     f.teams.home.winner,
      away:            f.teams.away.name,
      away_logo:       f.teams.away.logo,
      away_winner:     f.teams.away.winner,
      home_goals:      f.goals.home,
      away_goals:      f.goals.away,
      ht_home:         f.score.halftime.home,
      ht_away:         f.score.halftime.away,
      et_home:         f.score.extratime?.home ?? null,
      et_away:         f.score.extratime?.away ?? null,
      pen_home:        f.score.penalty?.home ?? null,
      pen_away:        f.score.penalty?.away ?? null,
    })
  }

  const rounds = Object.entries(roundMap)
    .map(([name, fixtures]) => ({ name, fixtures: fixtures.sort((a, b) => new Date(a.date) - new Date(b.date)) }))
    .sort((a, b) => {
      // Sort rounds numerically where possible (e.g. "Regular Season - 1" → 1)
      const numA = parseInt(a.name.match(/\d+/)?.[0] ?? '0')
      const numB = parseInt(b.name.match(/\d+/)?.[0] ?? '0')
      return numA - numB
    })

  return ok({ rounds, total_fixtures: res.data?.response?.length ?? 0 })
}

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

  const groups = (leagueData.standings || []).map(group => ({
    name: group[0]?.group ?? null,
    rows: group.map(entry => ({
      rank:        entry.rank,
      team:        entry.team.name,
      team_logo:   entry.team.logo,
      points:      entry.points,
      played:      entry.all.played,
      win:         entry.all.win,
      draw:        entry.all.draw,
      lose:        entry.all.lose,
      gf:          entry.all.goals.for,
      ga:          entry.all.goals.against,
      gd:          entry.goalsDiff,
      form:        entry.form ?? null,
      description: entry.description ?? null,
    })),
  }))

  return ok({ groups })
}

async function getFixtureDetails(event) {
  const { fixtureId } = event.pathParameters
  const secrets = await getSecrets()
  const headers = { "x-apisports-key": secrets.key }

  const [eventsRes, statsRes, lineupsRes] = await Promise.all([
    axios.get(`${API_FOOTBALL_BASE}/fixtures/events`,     { params: { fixture: fixtureId }, headers }),
    axios.get(`${API_FOOTBALL_BASE}/fixtures/statistics`, { params: { fixture: fixtureId }, headers }),
    axios.get(`${API_FOOTBALL_BASE}/fixtures/lineups`,    { params: { fixture: fixtureId }, headers }),
  ])

  const events = (eventsRes.data?.response || []).map(e => ({
    elapsed:     e.time.elapsed,
    extra:       e.time.extra ?? null,
    team:        e.team.name,
    team_logo:   e.team.logo,
    player:      e.player.name,
    assist:      e.assist?.name ?? null,
    type:        e.type,
    detail:      e.detail,
    comments:    e.comments ?? null,
  }))

  const statistics = (statsRes.data?.response || []).map(t => ({
    team:      t.team.name,
    team_logo: t.team.logo,
    stats:     t.statistics.map(s => ({ type: s.type, value: s.value })),
  }))

  const lineups = (lineupsRes.data?.response || []).map(t => ({
    team:        t.team.name,
    team_logo:   t.team.logo,
    formation:   t.formation ?? null,
    coach:       t.coach?.name ?? null,
    startXI:     (t.startXI || []).map(p => ({
      number: p.player.number, name: p.player.name, pos: p.player.pos, grid: p.player.grid
    })),
    substitutes: (t.substitutes || []).map(p => ({
      number: p.player.number, name: p.player.name, pos: p.player.pos
    })),
  }))

  return ok({ events, statistics, lineups })
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
