const { getPool } = require('../../shared/db')
const { ok, error } = require('../../shared/response')

function validatePackImage(image_url) {
  if (!image_url || image_url === '') return null
  if (image_url.startsWith('http://') || image_url.startsWith('https://')) return image_url
  if (!image_url.startsWith('data:image/')) return 'INVALID_FORMAT'
  if (image_url.length > 400 * 1024) return 'TOO_LARGE'
  return image_url
}

async function listEnergyPacks() {
  const pool = await getPool()
  const [packsRes, statsRes] = await Promise.all([
    pool.query(`SELECT * FROM energy_packs ORDER BY display_order ASC, price_euros ASC`),
    pool.query(`
      SELECT
        COALESCE(SUM(price_euros), 0)::float AS total_revenue,
        COUNT(DISTINCT user_id)::int         AS paying_users
      FROM energy_pack_purchases
    `),
  ])
  return ok({ packs: packsRes.rows, stats: statsRes.rows[0] })
}

async function createEnergyPack(event) {
  const pool = await getPool()
  const { name, description, image_url, energy_amount, price_euros, discount_pct, is_active, display_order } = JSON.parse(event.body || '{}')
  if (!name || !energy_amount) return error(400, "name and energy_amount are required")
  const img = validatePackImage(image_url)
  if (img === 'INVALID_FORMAT') return error(400, "Invalid image format")
  if (img === 'TOO_LARGE')      return error(400, "Image too large (max 400 KB)")
  const { rows } = await pool.query(
    `INSERT INTO energy_packs (name, description, image_url, energy_amount, price_euros, discount_pct, is_active, display_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [name, description || null, img, energy_amount, price_euros ?? 0.99, discount_pct ?? 0, is_active !== false, display_order ?? 0]
  )
  return ok(rows[0])
}

async function updateEnergyPack(event) {
  const pool = await getPool()
  const { id } = event.pathParameters
  const { name, description, image_url, energy_amount, price_euros, discount_pct, is_active, display_order } = JSON.parse(event.body || '{}')
  const img = validatePackImage(image_url)
  if (img === 'INVALID_FORMAT') return error(400, "Invalid image format")
  if (img === 'TOO_LARGE')      return error(400, "Image too large (max 400 KB)")
  const { rows } = await pool.query(
    `UPDATE energy_packs SET
       name=$1, description=$2, image_url=$3, energy_amount=$4,
       price_euros=$5, discount_pct=$6, is_active=$7, display_order=$8
     WHERE id=$9 RETURNING *`,
    [name, description || null, img, energy_amount, price_euros, discount_pct, is_active, display_order, id]
  )
  if (!rows.length) return error(404, "Pack not found")
  return ok(rows[0])
}

async function deleteEnergyPack(event) {
  const pool = await getPool()
  const { id } = event.pathParameters
  await pool.query(`DELETE FROM energy_packs WHERE id=$1`, [id])
  return ok({ deleted: true })
}

module.exports = { listEnergyPacks, createEnergyPack, updateEnergyPack, deleteEnergyPack }
