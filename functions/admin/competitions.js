const axios = require('axios')
const { v4: uuidv4 } = require('uuid')
const { getPool } = require('../../shared/db')
const { getSecrets } = require('../../shared/ssm')
const { ok, error } = require('../../shared/response')
const { probToEnergyCost, autoEarlySettleLockedGameweeks } = require('./gameweeks')

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

const FINISHED_STATUSES = ['FT', 'AET', 'PEN', 'AWD', 'WO']
const SIX_HOURS_MS = 6 * 60 * 60 * 1000
const ONE_HOUR_MS = 60 * 60 * 1000

function computeStatus(startDate, endDate) {
  const now = new Date()
  const start = new Date(startDate)
  const end = new Date(endDate)
  if (now < start) return "FUTURE"
  if (now > end) return "COMPLETED"
  return "IN_PROGRESS"
}

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
          if (rows.length > 0) {
            await upsertFixtures(pool, rows)
            console.log(`[scores] auto-refreshed ${rows.length}/${apiFixtures.length} fixtures for ${date}`)
            // Scores updated — run early settlement for any locked gameweeks
            await autoEarlySettleLockedGameweeks(pool).catch(() => {})
          }
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

module.exports = {
  getOddsForFixture,
  listCompetitions, createCompetition, updateCompetition, deleteCompetition,
  getCompetitionCalendar, getCompetitionStandings, getFixtureDetails, getCompetitionGameweeks,
  getAvailableFixtures, importFixturesByRange, browseCompetitions, importCompetitionFromApi,
  refreshFixtureResults, getPublicScores, getPublicGameweek,
  apiFixtureToRow, upsertFixtures,
}
