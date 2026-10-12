/**
 * Per-user email alerts for the Finance Listening Portal.
 *
 * Runs AFTER the existing scraper workflow finishes (see .github/workflows/notify.yml).
 * It does not change the scraper: it just reads data/regulatory_data.json, picks the rows
 * the scraper marked isNew in that run, and emails each portal user ONLY the items for the
 * regulators they have access to. Users and their access come from the portal's directory
 * (portal_auth.json in the private portal-auth repo, kept up to date by the Streamlit app).
 *
 * Env: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, PORTAL_AUTH_TOKEN,
 *      PORTAL_AUTH_REPO, PORTAL_AUTH_PATH, PORTAL_AUTH_BRANCH, TRACKER_URL,
 *      DRY_RUN=true  -> log who would get what, send nothing.
 */
const fs = require('fs');
const path = require('path');

const DATA_PATH = path.join(__dirname, '..', 'data', 'regulatory_data.json');
const DRY_RUN = String(process.env.DRY_RUN || '').toLowerCase() === 'true';

const REGULATOR_DISPLAY_NAMES = {
  NEWSLETTER: 'Newsletter — Bank & NBFC News',
  SEBI: 'Securities & Exchange Board of India (SEBI)',
  RBI: 'Reserve Bank of India (RBI)',
  BSE: 'Bombay Stock Exchange (BSE)',
  NSE: 'National Stock Exchange (NSE)',
  IRDAI: 'Insurance Regulatory & Development Authority (IRDAI)',
  IEPFA: 'Investor Education & Protection Fund Authority (IEPFA)',
  MCA: 'Ministry of Corporate Affairs (MCA)',
  NFRA: 'National Financial Reporting Authority (NFRA)',
  PCAOB: 'Public Company Accounting Oversight Board (PCAOB)',
  TAXATION: 'Taxation — Income Tax, GST & Case Laws',
};

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// Tab labels from the scraper's own sources.js (read-only). Falls back to each row's category.
function tabLabels() {
  const labels = {};
  try {
    const REGULATORS = require('../scraper/sources');
    for (const reg of Object.values(REGULATORS)) for (const t of reg.tabs || []) labels[t.key] = t.label;
  } catch (e) { /* not fatal */ }
  return labels;
}

function newItemsFromData() {
  const doc = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  const labels = tabLabels();
  const out = {};
  for (const [key, tab] of Object.entries(doc.data || {})) {
    const fresh = (tab.rows || []).filter(r => r.isNew);
    if (!fresh.length) continue;
    const regKey = key.replace(/_\d+$/, '');
    if (!out[regKey]) out[regKey] = { name: REGULATOR_DISPLAY_NAMES[regKey] || regKey, tabs: {} };
    const label = labels[key] || fresh[0].cat || key;
    out[regKey].tabs[label] = (out[regKey].tabs[label] || []).concat(fresh);
  }
  return { newByRegulator: out, generatedAt: doc.generatedAt };
}

const PAN_RE = /[A-Z]{5}[0-9]{4}[A-Z]/g; // PAN numbers trip corporate DLP filters; never email them
function maskPan(s) { return String(s == null ? '' : s).replace(PAN_RE, '[PAN hidden]'); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function loadPortalDirectory() {
  const { PORTAL_AUTH_REPO, PORTAL_AUTH_TOKEN, PORTAL_AUTH_PATH, PORTAL_AUTH_BRANCH } = process.env;
  if (!PORTAL_AUTH_TOKEN) {
    console.log('  PORTAL_AUTH_TOKEN is empty: add it under this repo\'s Settings → Secrets and variables → Actions ' +
                '(tab "Secrets", "New repository secret", name exactly PORTAL_AUTH_TOKEN).');
    return null;
  }
  const repo = PORTAL_AUTH_REPO || 'swapnilneharkar1/portal-auth';
  const path = PORTAL_AUTH_PATH || 'portal_auth.json';
  const ref = PORTAL_AUTH_BRANCH || 'main';
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/contents/${path}?ref=${ref}`, {
      headers: { Authorization: `Bearer ${PORTAL_AUTH_TOKEN}`, Accept: 'application/vnd.github+json' }
    });
    if (!res.ok) {
      console.log(`  Couldn't read ${repo}/${path} (HTTP ${res.status}) — per-user emails skipped.`);
      return null;
    }
    const body = await res.json();
    const doc = JSON.parse(Buffer.from(body.content, 'base64').toString('utf8') || '{}');
    const users = Object.entries((doc.directory && doc.directory.users) || {})
      .map(([username, u]) => ({ username, ...u }))
      .filter(u => u.email && Array.isArray(u.regulators) && u.regulators.length && u.notify !== false);
    if (!users.length) {
      console.log('  [notify] Portal directory is empty (log in to the portal once to create it) — per-user emails skipped.');
      return null;
    }
    return users;
  } catch (e) {
    console.log(`  Couldn't load portal directory (${e.message}) — per-user emails skipped.`);
    return null;
  }
}

function countItems(newByRegulator) {
  return Object.values(newByRegulator).reduce(
    (sum, reg) => sum + Object.values(reg.tabs).reduce((s, rows) => s + rows.length, 0), 0);
}

function filterForUser(newByRegulator, regulators) {
  const allowed = new Set(regulators.map(r => String(r).toUpperCase()));
  const out = {};
  for (const [regKey, reg] of Object.entries(newByRegulator)) {
    if (allowed.has('ALL') || allowed.has(regKey.toUpperCase())) out[regKey] = reg;
  }
  return out;
}

function buildEmailHtml(newByRegulator, recipient) {
  const { TRACKER_URL } = process.env;
  const totalCount = countItems(newByRegulator);
  const todayStr = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' });

  // Table-based layout with inline styles throughout — Outlook's rendering engine (Word, not
  // a browser engine) ignores most CSS classes, flexbox, and external/embedded stylesheets.
  const FONT = "font-family:Segoe UI,Arial,Helvetica,sans-serif;";
  const INK = '#1a2030', MUTED = '#5a6474', BORDER = '#e2e6ea', DEEP = '#1a56db', BG = '#f7f8fa';

  let sectionsHtml = '';
  for (const [regKey, reg] of Object.entries(newByRegulator)) {
    let rowsHtml = '';
    for (const [tabLabel, rows] of Object.entries(reg.tabs)) {
      for (const r of rows) {
        rowsHtml += `
          <tr>
            <td style="padding:10px 0;border-bottom:1px solid ${BORDER};vertical-align:top;width:90px;${FONT}font-size:12px;color:${MUTED};white-space:nowrap;">${esc(r.date || '')}</td>
            <td style="padding:10px 0 10px 14px;border-bottom:1px solid ${BORDER};vertical-align:top;">
              <span style="display:inline-block;${FONT}font-size:10.5px;font-weight:600;color:${DEEP};background:#eaf1fd;border-radius:4px;padding:2px 7px;margin-bottom:4px;">${esc(tabLabel)}</span><br/>
              <a href="${esc(r.link || '#')}" style="${FONT}font-size:14px;color:${INK};text-decoration:none;font-weight:500;">${esc(maskPan(r.title))}</a>
            </td>
          </tr>`;
      }
    }
    sectionsHtml += `
      <tr><td style="padding:22px 0 8px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr><td style="${FONT}font-size:15px;font-weight:700;color:${INK};border-left:3px solid ${DEEP};padding-left:10px;">${esc(reg.name)}</td></tr>
        </table>
      </td></tr>
      <tr><td>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rowsHtml}</table>
      </td></tr>`;
  }

  const greeting = recipient ? `
        <tr><td style="padding:20px 28px 0;${FONT}font-size:14px;color:${INK};">
          Hi ${esc(recipient.name || recipient.username)},<br/>
          <span style="font-size:12px;color:${MUTED};">Updates for your portal access: ${esc(recipient.regulators.join(', '))}</span>
        </td></tr>` : '';

  const trackerButton = TRACKER_URL ? `
    <tr><td style="padding:28px 0 4px;">
      <a href="${esc(TRACKER_URL)}" style="${FONT}display:inline-block;background:${DEEP};color:#ffffff;text-decoration:none;font-size:13px;font-weight:600;padding:10px 22px;border-radius:6px;">Open Full Tracker →</a>
    </td></tr>` : '';

  const footerNote = recipient
    ? `You're receiving this because you have access to these regulators on the Finance Listening Portal. Ask the portal admin to change your access or stop these emails.`
    : `This is an automated notification from the Regulatory Updates Tracker.`;

  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BG};padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;border:1px solid ${BORDER};border-radius:8px;overflow:hidden;">
        <tr><td style="background:#0f2d52;padding:22px 28px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
            <td style="${FONT}font-size:11px;font-weight:700;letter-spacing:1.5px;color:#a9c6f0;text-transform:uppercase;">Bajaj Finserv</td>
          </tr><tr>
            <td style="${FONT}font-size:19px;font-weight:700;color:#ffffff;padding-top:4px;">Regulatory Updates Tracker</td>
          </tr></table>
        </td></tr>${greeting}
        <tr><td style="padding:22px 28px 6px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
            <td style="${FONT}font-size:13px;color:${MUTED};">${todayStr}</td>
            <td align="right" style="${FONT}font-size:13px;color:${DEEP};font-weight:700;">${totalCount} new item${totalCount === 1 ? '' : 's'}</td>
          </tr></table>
        </td></tr>
        <tr><td style="padding:0 28px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${sectionsHtml}</table>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${trackerButton}</table>
        </td></tr>
        <tr><td style="padding:24px 28px;border-top:1px solid ${BORDER};margin-top:20px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td>
            <span style="${FONT}font-size:11px;color:${MUTED};">${footerNote} Items are matched against each source's official publication date — historical or backlog items are not included.</span>
          </td></tr></table>
        </td></tr>
      </table>
    </td></tr>
  </table>`;
}

function subjectFor(newByRegulator) {
  const n = countItems(newByRegulator);
  const regs = Object.keys(newByRegulator);
  const which = regs.length <= 3 ? ` · ${regs.join(', ')}` : '';
  return `Regulatory Updates — ${n} new item${n === 1 ? '' : 's'}${which} (${new Date().toLocaleDateString('en-IN')})`;
}


async function main() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  const { newByRegulator, generatedAt } = newItemsFromData();
  const total = countItems(newByRegulator);
  console.log(`Data generated at ${generatedAt}: ${total} new item(s)` +
              (total ? ` in ${Object.keys(newByRegulator).join(', ')}` : '') + '.');
  if (!total) { console.log('Nothing new — no emails to send.'); return; }

  const directory = await loadPortalDirectory();
  if (!directory) {
    console.log('No portal directory available — per-user emails skipped (the scraper\'s own email still goes out as before).');
    return;
  }
  if (!DRY_RUN && (!SMTP_USER || !SMTP_PASS)) {
    console.log('SMTP_USER / SMTP_PASS not set — cannot send.');
    return;
  }

  const transporter = DRY_RUN ? null : require('nodemailer').createTransport({
    host: SMTP_HOST || 'smtp.office365.com',
    port: Number(SMTP_PORT) || 587,
    secure: false, // STARTTLS on port 587
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    // Fail fast instead of hanging for minutes if Office 365 stalls a connection.
    connectionTimeout: 30000, greetingTimeout: 30000, socketTimeout: 60000
  });

  console.log(`Recipients in portal directory: ${directory.length} ` +
              `(${directory.map(u => `${u.email} [${u.regulators.join(', ')}]`).join('; ')})`);

  let sent = 0, skipped = 0, failed = 0;
  for (const user of directory) {
    const mine = filterForUser(newByRegulator, user.regulators);
    const n = countItems(mine);
    if (!n) { skipped++; continue; }
    if (DRY_RUN) {
      console.log(`  [dry run] would send ${n} item(s) to ${user.email} (${Object.keys(mine).join(', ')})`);
      sent++; continue;
    }
    console.log(`  Sending ${n} item(s) to ${user.email}…`);
    try {
      await transporter.sendMail({ from: SMTP_USER, to: user.email, subject: subjectFor(mine), html: buildEmailHtml(mine, user) });
      sent++;
      console.log(`  Sent ${n} item(s) to ${user.email} (${Object.keys(mine).join(', ')}).`);
    } catch (e) {
      failed++;
      console.log(`  FAILED for ${user.email}: ${e.message}`);
    }
    await sleep(2500); // stay well under Office 365's 30-messages-per-minute limit
  }
  console.log(`Done${DRY_RUN ? ' (dry run)' : ''}: ${sent} ${DRY_RUN ? 'would be sent' : 'sent'}, ` +
              `${skipped} user(s) had nothing new for their regulators, ${failed} failed.`);
}

main().catch(e => { console.error(e); process.exit(1); });
