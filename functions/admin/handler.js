const axios = require("axios")
const { v4: uuidv4 } = require("uuid")
const { getPool } = require("../../shared/db")
const { getSecrets } = require("../../shared/ssm")
const { verifyToken, extractFromEvent } = require("../../shared/auth")
const { ok, error, unauthorized } = require("../../shared/response")

const API_FOOTBALL_BASE = "https://v3.football.api-sports.io"

exports.handler = async (event) => {
  const routeKey = event.routeKey

  let user
  try {
    user = await verifyToken(extractFromEvent(event))
  } catch {
    return unauthorized()
  }

  if (user.role !== "admin") return error(403, "Admin only")

  try {
    if (routeKey === "GET /admin/fixtures") return await importFixtures(event)
    if (routeKey === "POST /admin/gameweek") return await createGameweek(event)
    if (routeKey === "POST /admin/publish") return await publishGameweek(event)
    return error(404, "Not found")
  } catch (err) {
    console.error(err)
    return error(500, "Internal server error")
  }
}

async function importFixtures(event) {
  const { leagueId, season, round } = event.queryStringParameters || {}
  if (!leagueId || !season) return error(400, "leagueId and season are required")

  const secrets = await getSecrets()

  const res = await axios.get(`${API_FOOTBALL_BASE}/fixtures`, {
    params: { league: leagueId, season, round },
    headers: { "x-apisports-key": secrets.key }
  })

  const fixtures = (res.data?.response || []).map(f => ({
    id: f.fixture.id,
    date: f.fixture.date,
    home: f.teams.home.name,
    away: f.teams.away.name,
    competition: f.league.name,
    round: f.league.round
  }))

  return ok(fixtures)
}

function probToEnergyCost(prob) {
  if (prob <= 0.1) return 1
  if (prob <= 0.2) return 2
  if (prob <= 0.3) return 3
  if (prob <= 0.4) return 4
  if (prob <= 0.5) return 5
  if (prob <= 0.6) return 6
  if (prob <= 0.7) return 7
  if (prob <= 0.8) return 8
  if (prob <= 0.9) return 9
  return null
}

async function createGameweek(event) {
  const body = JSON.parse(event.body || "{}")
  const { league_id, week_number, lock_time, events: eventDefs } = body

  if (!league_id || !week_number || !lock_time || !Array.isArray(eventDefs)) {
    return error(400, "league_id, week_number, lock_time and events are required")
  }

  const secrets = await getSecrets()
  const pool = await getPool()

  const gwId = uuidv4()
  await pool.query(
    `INSERT INTO gameweeks (id, league_id, week_number, lock_time, status)
     VALUES ($1, $2, $3, $4, 'DRAFT')`,
    [gwId, league_id, week_number, lock_time]
  )

  for (const evDef of eventDefs) {
    const eventId = uuidv4()
    await pool.query(
      `INSERT INTO events (id, gameweek_id, event_type, fixture_id, fixture_name, player_name, competition, match_time)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [eventId, gwId, evDef.event_type, evDef.fixture_id, evDef.fixture_name,
       evDef.player_name || null, evDef.competition || null, evDef.match_time || null]
    )

    let odds = null
    try {
      const oddsRes = await axios.get(`${API_FOOTBALL_BASE}/odds`, {
        params: { fixture: evDef.fixture_id, bookmaker: 1 },
        headers: { "x-apisports-key": secrets.key }
      })
      odds = oddsRes.data?.response?.[0]?.bookmakers?.[0]?.bets || []
    } catch (e) {
      console.error(`Failed to fetch odds for fixture ${evDef.fixture_id}:`, e.message)
    }

    if (evDef.options && Array.isArray(evDef.options)) {
      for (const opt of evDef.options) {
        let energyCost = opt.energy_cost

        if (!energyCost && odds) {
          const matchResultBet = odds.find(b => b.name === "Match Winner")
          if (matchResultBet) {
            const outcome = matchResultBet.values.find(v =>
              v.value.toLowerCase() === opt.label.toLowerCase()
            )
            if (outcome) {
              const decimal = parseFloat(outcome.odd)
              const prob = decimal > 0 ? 1 / decimal : 0
              energyCost = probToEnergyCost(prob)
            }
          }
        }

        if (!energyCost) continue

        await pool.query(
          "INSERT INTO event_options (id, event_id, label, energy_cost) VALUES ($1, $2, $3, $4)",
          [uuidv4(), eventId, opt.label, energyCost]
        )
      }
    }
  }

  return ok({ gameweekId: gwId }, 201)
}

async function publishGameweek(event) {
  const { gameweek_id } = JSON.parse(event.body || "{}")
  if (!gameweek_id) return error(400, "gameweek_id is required")

  const pool = await getPool()

  const gwResult = await pool.query(
    "SELECT id, league_id, week_number FROM gameweeks WHERE id = $1 AND status = 'DRAFT'",
    [gameweek_id]
  )
  if (gwResult.rows.length === 0) return error(404, "Gameweek not found or not in DRAFT status")

  const { league_id, week_number } = gwResult.rows[0]

  await pool.query("UPDATE gameweeks SET status = 'PUBLISHED' WHERE id = $1", [gameweek_id])

  const membersResult = await pool.query(
    "SELECT user_id FROM league_members WHERE league_id = $1 ORDER BY joined_at ASC",
    [league_id]
  )
  const members = membersResult.rows.map(r => r.user_id)
  const n = members.length

  const matchups = []
  if (n >= 2) {
    const offset = (week_number - 1) % Math.max(1, n - 1)
    const rotated = [members[0], ...members.slice(1).map((_, i) => members[1 + (i + offset) % (n - 1)])]

    for (let i = 0; i < Math.floor(n / 2); i++) {
      matchups.push({ home: rotated[i], away: rotated[n - 1 - i] })
    }

    for (const m of matchups) {
      await pool.query(
        `INSERT INTO matchups (id, gameweek_id, home_user_id, away_user_id, status)
         VALUES ($1, $2, $3, $4, 'PENDING')`,
        [uuidv4(), gameweek_id, m.home, m.away]
      )
    }
  }

  return ok({ published: true, gameweek_id, matchupsCreated: matchups.length })
}
