const { getPool } = require("../../shared/db")
const { ok, error } = require("../../shared/response")

function computeStatus(startDate, endDate) {
  const now = new Date()
  if (now < new Date(startDate)) return "FUTURE"
  if (now > new Date(endDate)) return "COMPLETED"
  return "IN_PROGRESS"
}

exports.handler = async (event) => {
  try {
    const pool = await getPool()
    const { rows } = await pool.query(`
      SELECT id, name, description, logo_url, cover_url,
             start_date, end_date, num_weeks, created_at
      FROM competitions ORDER BY start_date ASC
    `)
    return ok(rows.map(r => ({ ...r, status: computeStatus(r.start_date, r.end_date) })))
  } catch (err) {
    console.error(err)
    return error(500, "Internal server error")
  }
}
