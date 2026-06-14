const { v4: uuidv4 } = require("uuid")
const { getPool } = require("../../shared/db")
const { verifyToken, extractFromEvent } = require("../../shared/auth")
const { ok, error, unauthorized } = require("../../shared/response")

exports.handler = async (event) => {
  const routeKey = event.routeKey

  let user
  try {
    user = await verifyToken(extractFromEvent(event))
  } catch {
    return unauthorized()
  }

  try {
    if (routeKey === "POST /picks") return await submitPicks(event, user)
    if (routeKey === "GET /picks/{gameweekId}") return await getPicks(event, user)
    return error(404, "Not found")
  } catch (err) {
    console.error(err)
    return error(500, "Internal server error")
  }
}

async function submitPicks(event, user) {
  const body = JSON.parse(event.body || "{}")
  const { gameweek_id, picks } = body

  if (!gameweek_id || !Array.isArray(picks)) return error(400, "gameweek_id and picks array are required")
  if (picks.length !== 6) return error(400, "You must submit exactly 6 picks")

  const pool = await getPool()

  const gw = await pool.query("SELECT id, status FROM gameweeks WHERE id = $1", [gameweek_id])
  if (gw.rows.length === 0) return error(404, "Gameweek not found")
  if (gw.rows[0].status !== "PUBLISHED") return error(400, "Gameweek is not open for picks")

  const existingCard = await pool.query(
    "SELECT id FROM user_cards WHERE gameweek_id = $1 AND user_id = $2 AND status = 'LOCKED'",
    [gameweek_id, user.userId]
  )
  if (existingCard.rows.length > 0) return error(409, "You already have a locked card for this gameweek")

  const optionIds = picks.map(p => p.event_option_id)
  const optionsResult = await pool.query(
    `SELECT eo.id, eo.energy_cost, e.gameweek_id
     FROM event_options eo JOIN events e ON e.id = eo.event_id
     WHERE eo.id = ANY($1::uuid[])`,
    [optionIds]
  )

  if (optionsResult.rows.length !== 6) return error(400, "One or more event options are invalid")

  const wrongGw = optionsResult.rows.find(o => o.gameweek_id !== gameweek_id)
  if (wrongGw) return error(400, "All picks must belong to the specified gameweek")

  const optionMap = {}
  optionsResult.rows.forEach(o => { optionMap[o.id] = o })

  let totalEnergyCost = 0
  const picksWithCost = picks.map(p => {
    const option = optionMap[p.event_option_id]
    const discount = p.discount_applied || 0
    const finalCost = Math.max(1, option.energy_cost - discount)
    totalEnergyCost += finalCost
    return { ...p, energy_cost_final: finalCost, discount_applied: discount }
  })

  if (totalEnergyCost > 30) return error(400, "Total energy cost exceeds the 30-unit limit")

  const walletResult = await pool.query(
    "SELECT balance FROM energy_wallets WHERE user_id = $1",
    [user.userId]
  )
  const balance = walletResult.rows[0]?.balance || 0
  const totalDiscount = picksWithCost.reduce((sum, p) => sum + p.discount_applied, 0)

  if (balance < totalDiscount) return error(400, "Insufficient energy balance for discounts")

  const cardId = uuidv4()
  await pool.query(
    `INSERT INTO user_cards (id, gameweek_id, user_id, total_energy_used, locked_at, status)
     VALUES ($1, $2, $3, $4, NOW(), 'LOCKED')`,
    [cardId, gameweek_id, user.userId, totalEnergyCost]
  )

  for (const pick of picksWithCost) {
    await pool.query(
      `INSERT INTO card_picks (id, card_id, event_option_id, energy_cost_final, discount_applied, pick_status)
       VALUES ($1, $2, $3, $4, $5, 'SLEEPING')`,
      [uuidv4(), cardId, pick.event_option_id, pick.energy_cost_final, pick.discount_applied]
    )
  }

  if (totalDiscount > 0) {
    await pool.query(
      "UPDATE energy_wallets SET balance = balance - $1 WHERE user_id = $2",
      [totalDiscount, user.userId]
    )
    await pool.query(
      `INSERT INTO energy_transactions (id, user_id, amount, type, description, created_at)
       VALUES ($1, $2, $3, 'USAGE', $4, NOW())`,
      [uuidv4(), user.userId, -totalDiscount, `Energy discount applied for gameweek ${gameweek_id}`]
    )
  }

  return ok({ cardId, totalEnergyCost, picksCount: picks.length }, 201)
}

async function getPicks(event, user) {
  const { gameweekId } = event.pathParameters
  const pool = await getPool()

  const result = await pool.query(
    `SELECT uc.id AS card_id, uc.status AS card_status, uc.total_energy_used, uc.locked_at, uc.final_score,
            cp.id AS pick_id, cp.event_option_id, cp.energy_cost_final, cp.discount_applied,
            cp.pick_status, cp.projected_value,
            eo.label, eo.energy_cost AS original_energy_cost, eo.result,
            e.fixture_name, e.event_type, e.match_time
     FROM user_cards uc
     JOIN card_picks cp ON cp.card_id = uc.id
     JOIN event_options eo ON eo.id = cp.event_option_id
     JOIN events e ON e.id = eo.event_id
     WHERE uc.gameweek_id = $1 AND uc.user_id = $2
     ORDER BY e.match_time ASC`,
    [gameweekId, user.userId]
  )

  return ok(result.rows)
}
