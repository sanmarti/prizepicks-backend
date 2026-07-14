const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses')

const ses = new SESClient({ region: 'eu-west-3' })
const FROM = 'OddsRivals <noreply@oddsrivals.com>'

async function sendEmail(to, subject, html) {
  try {
    await ses.send(new SendEmailCommand({
      Source: FROM,
      Destination: { ToAddresses: [to] },
      Message: {
        Subject: { Data: subject, Charset: 'UTF-8' },
        Body: { Html: { Data: html, Charset: 'UTF-8' } },
      },
    }))
  } catch (err) {
    console.error('[email] failed to send to', to, err.message)
  }
}

// ── Templates ─────────────────────────────────────────────────────────────────

function wrap(preheader, body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>OddsRivals</title>
</head>
<body style="margin:0;padding:0;background:#060a10;font-family:'Helvetica Neue',Arial,sans-serif;">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${preheader}</div>
<table width="100%" cellpadding="0" cellspacing="0" style="background:#060a10;padding:32px 16px;">
  <tr><td align="center">
    <table width="100%" style="max-width:520px;" cellpadding="0" cellspacing="0">

      <!-- Header -->
      <tr><td style="padding-bottom:24px;text-align:center;">
        <span style="font-size:22px;font-weight:900;letter-spacing:0.06em;color:#ffffff;">ODDS<span style="color:#22c55e;">RIVALS</span></span>
      </td></tr>

      <!-- Card -->
      <tr><td style="background:#0d1117;border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:32px 28px;">
        ${body}
      </td></tr>

      <!-- Footer -->
      <tr><td style="padding-top:24px;text-align:center;">
        <p style="margin:0;font-size:11px;color:rgba(255,255,255,0.2);line-height:1.7;">
          You're receiving this because you have an OddsRivals account.<br/>
          <a href="https://oddsrivals.com/profile" style="color:rgba(255,255,255,0.3);text-decoration:underline;">Manage email preferences</a>
        </p>
      </td></tr>

    </table>
  </td></tr>
</table>
</body>
</html>`
}

function btn(label, url) {
  return `<a href="${url}" style="display:inline-block;margin-top:20px;padding:13px 28px;background:linear-gradient(90deg,#22c55e,#16a34a);color:#fff;font-size:14px;font-weight:700;text-decoration:none;border-radius:10px;letter-spacing:0.06em;">${label}</a>`
}

function divider() {
  return `<div style="border-top:1px solid rgba(255,255,255,0.06);margin:20px 0;"></div>`
}

// ── 1. Picks are open ─────────────────────────────────────────────────────────
function picksOpenEmail({ displayName, sprintName, weekNumber, lockTime }) {
  const lock = new Date(lockTime).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  const body = `
    <p style="margin:0 0 4px;font-size:11px;color:#22c55e;font-weight:700;letter-spacing:0.14em;">NEW MATCHWEEK</p>
    <h1 style="margin:0 0 8px;font-size:24px;font-weight:900;color:#ffffff;line-height:1.2;">Your picks are open ⚽</h1>
    <p style="margin:0 0 20px;font-size:14px;color:rgba(255,255,255,0.5);line-height:1.6;">Hey ${displayName}, <strong style="color:rgba(255,255,255,0.8);">${sprintName} · Week ${weekNumber}</strong> is live. Make your 6 picks before the deadline.</p>
    <div style="background:rgba(34,197,94,0.06);border:1px solid rgba(34,197,94,0.2);border-radius:10px;padding:14px 18px;">
      <p style="margin:0;font-size:12px;color:rgba(255,255,255,0.4);">Locks</p>
      <p style="margin:4px 0 0;font-size:16px;font-weight:700;color:#22c55e;">${lock}</p>
    </div>
    ${btn('MAKE MY PICKS →', 'https://oddsrivals.com/login')}
  `
  return {
    subject: `⚽ Week ${weekNumber} picks are open — make yours before the deadline`,
    html: wrap(`Week ${weekNumber} is live. Lock in your 6 picks before ${lock}.`, body),
  }
}

// ── 2. Lock reminder (sent a few hours before) ────────────────────────────────
function lockReminderEmail({ displayName, sprintName, weekNumber, lockTime, hasPicks }) {
  const lock = new Date(lockTime).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  const body = hasPicks
    ? `
      <p style="margin:0 0 4px;font-size:11px;color:#f59e0b;font-weight:700;letter-spacing:0.14em;">LOCKING SOON</p>
      <h1 style="margin:0 0 8px;font-size:24px;font-weight:900;color:#ffffff;">You're locked in ✓</h1>
      <p style="margin:0 0 20px;font-size:14px;color:rgba(255,255,255,0.5);line-height:1.6;">Hey ${displayName}, you've already submitted your picks for <strong style="color:rgba(255,255,255,0.8);">${sprintName} · Week ${weekNumber}</strong>. Good luck!</p>
      <div style="background:rgba(34,197,94,0.06);border:1px solid rgba(34,197,94,0.2);border-radius:10px;padding:14px 18px;">
        <p style="margin:0;font-size:13px;color:rgba(255,255,255,0.5);">Gameweek locks at <strong style="color:#22c55e;">${lock}</strong></p>
      </div>
    `
    : `
      <p style="margin:0 0 4px;font-size:11px;color:#f59e0b;font-weight:700;letter-spacing:0.14em;">REMINDER</p>
      <h1 style="margin:0 0 8px;font-size:24px;font-weight:900;color:#ffffff;">Picks locking soon ⏰</h1>
      <p style="margin:0 0 20px;font-size:14px;color:rgba(255,255,255,0.5);line-height:1.6;">Hey ${displayName}, <strong style="color:rgba(255,255,255,0.8);">${sprintName} · Week ${weekNumber}</strong> locks at <strong style="color:#f59e0b;">${lock}</strong> and you haven't submitted yet.</p>
      ${btn('SUBMIT MY PICKS →', 'https://oddsrivals.com/login')}
    `
  return {
    subject: hasPicks
      ? `✓ You're set for Week ${weekNumber} — gameweek locks soon`
      : `⏰ Reminder: Week ${weekNumber} locks soon — don't miss it`,
    html: wrap(`Week ${weekNumber} locks at ${lock}.`, body),
  }
}

// ── 3. Results settled ────────────────────────────────────────────────────────
function resultsEmail({ displayName, sprintName, weekNumber, correct, total, leaguePoints, isPerfect }) {
  const accuracy = total > 0 ? Math.round((correct / total) * 100) : 0
  const scoreColor = accuracy >= 80 ? '#22c55e' : accuracy >= 50 ? '#f59e0b' : '#f87171'
  const body = `
    <p style="margin:0 0 4px;font-size:11px;color:#a78bfa;font-weight:700;letter-spacing:0.14em;">RESULTS IN</p>
    <h1 style="margin:0 0 8px;font-size:24px;font-weight:900;color:#ffffff;">${isPerfect ? 'Perfect week! ⭐' : 'Week ' + weekNumber + ' results'}</h1>
    <p style="margin:0 0 20px;font-size:14px;color:rgba(255,255,255,0.5);">Hey ${displayName}, here's how you did in <strong style="color:rgba(255,255,255,0.8);">${sprintName} · Week ${weekNumber}</strong>.</p>
    <div style="display:flex;gap:12px;margin-bottom:20px;">
      <div style="flex:1;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:16px;text-align:center;">
        <p style="margin:0;font-size:28px;font-weight:900;color:${scoreColor};">${correct}/${total}</p>
        <p style="margin:4px 0 0;font-size:11px;color:rgba(255,255,255,0.3);">CORRECT</p>
      </div>
      <div style="flex:1;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:16px;text-align:center;">
        <p style="margin:0;font-size:28px;font-weight:900;color:#a78bfa;">+${leaguePoints}</p>
        <p style="margin:4px 0 0;font-size:11px;color:rgba(255,255,255,0.3);">LEAGUE PTS</p>
      </div>
    </div>
    ${isPerfect ? `<div style="background:rgba(250,204,21,0.08);border:1px solid rgba(250,204,21,0.25);border-radius:10px;padding:14px 18px;margin-bottom:20px;text-align:center;"><p style="margin:0;font-size:14px;font-weight:700;color:#fbbf24;">⭐ Perfect Week bonus earned!</p></div>` : ''}
    ${btn('SEE FULL RESULTS →', 'https://oddsrivals.com/matchweek')}
  `
  return {
    subject: isPerfect
      ? `⭐ Perfect week! You got ${correct}/${total} in Week ${weekNumber}`
      : `📊 Week ${weekNumber} results: ${correct}/${total} correct`,
    html: wrap(`You got ${correct}/${total} correct in Week ${weekNumber}.`, body),
  }
}

// ── 4. Sprint end (promoted / relegated / retained) ───────────────────────────
function sprintEndEmail({ displayName, sprintName, outcome, divisionName, nextDivisionName, totalLp, rank, divTotal }) {
  const outcomeMap = {
    promoted:  { emoji: '⬆', color: '#22c55e', label: 'Promoted!',   sub: `You're moving up to <strong style="color:#22c55e;">${nextDivisionName}</strong> next sprint.` },
    relegated: { emoji: '⬇', color: '#f87171', label: 'Relegated',   sub: `You'll be in <strong style="color:#f87171;">${nextDivisionName}</strong> next sprint. Come back stronger.` },
    retained:  { emoji: '=', color: '#a78bfa', label: 'Staying put',  sub: `You'll remain in <strong style="color:#a78bfa;">${divisionName}</strong> for the next sprint.` },
  }
  const { emoji, color, label, sub } = outcomeMap[outcome] ?? outcomeMap.retained
  const body = `
    <p style="margin:0 0 4px;font-size:11px;color:${color};font-weight:700;letter-spacing:0.14em;">SPRINT OVER</p>
    <h1 style="margin:0 0 8px;font-size:24px;font-weight:900;color:#ffffff;">${emoji} ${label}</h1>
    <p style="margin:0 0 20px;font-size:14px;color:rgba(255,255,255,0.5);line-height:1.6;">Hey ${displayName}, <strong style="color:rgba(255,255,255,0.8);">${sprintName}</strong> is over. ${sub}</p>
    <div style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:16px;margin-bottom:20px;">
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td style="text-align:center;padding:8px;">
            <p style="margin:0;font-size:22px;font-weight:900;color:#a78bfa;">${totalLp}</p>
            <p style="margin:4px 0 0;font-size:10px;color:rgba(255,255,255,0.3);">LEAGUE POINTS</p>
          </td>
          <td style="text-align:center;padding:8px;">
            <p style="margin:0;font-size:22px;font-weight:900;color:#ffffff;">#${rank}</p>
            <p style="margin:4px 0 0;font-size:10px;color:rgba(255,255,255,0.3);">OF ${divTotal}</p>
          </td>
          <td style="text-align:center;padding:8px;">
            <p style="margin:0;font-size:16px;font-weight:900;color:${color};">${emoji}</p>
            <p style="margin:4px 0 0;font-size:10px;color:rgba(255,255,255,0.3);">${label.toUpperCase()}</p>
          </td>
        </tr>
      </table>
    </div>
    ${btn('VIEW MY PROFILE →', 'https://oddsrivals.com/profile')}
  `
  return {
    subject: outcome === 'promoted'
      ? `⬆ You've been promoted from ${divisionName}!`
      : outcome === 'relegated'
      ? `⬇ Sprint over — ${sprintName} results`
      : `= Sprint over — you stay in ${divisionName}`,
    html: wrap(`${sprintName} is over. Final rank: #${rank} of ${divTotal}.`, body),
  }
}

module.exports = {
  sendEmail,
  picksOpenEmail,
  lockReminderEmail,
  resultsEmail,
  sprintEndEmail,
}
