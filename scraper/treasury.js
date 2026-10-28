/**
 * treasury.js — Treasury Peer Benchmarking collector (runs in GitHub Actions, see
 * .github/workflows/treasury.yml). Separate from the hourly regulatory scraper.
 *
 *   1. Finds each NBFC's annual reports (treasury-sources.js: manual links, NSE, BSE)
 *   2. Downloads only reports not processed before, extracts borrowing / investment /
 *      finance-cost figures from the standalone statements (treasury-extract.js)
 *   3. Builds data/treasury/benchmark.json: instrument mix, peer averages, BFL gap,
 *      trends, borrowing cost and drafted commentary, with the PDF page for every figure.
 *
 * Env: TREASURY_FORCE=true   re-extract every report
 *      TREASURY_ONLY=BFL,CHOLA   limit to some companies
 *      TREASURY_LOCAL_DIR=dir    test mode: use <KEY>_<FY>.pdf files from a folder, no network
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const CONFIG = require('./treasury-sources');
const { extractReport } = require('./treasury-extract');

const OUT_DIR = path.join(__dirname, '..', 'data', 'treasury');
const DEBUG_DIR = path.join(OUT_DIR, 'debug');
const EXTRACTED_DIR = path.join(OUT_DIR, 'extracted');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const FORCE = process.env.TREASURY_FORCE === 'true';
const ONLY = (process.env.TREASURY_ONLY || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
// Bump when the extractor changes, so earlier extractions are redone automatically
const EXTRACTOR_VERSION = 2;
const LOCAL_DIR = process.env.TREASURY_LOCAL_DIR || '';

const BORROWING_CATEGORIES = [
  'Secured NCDs', 'Unsecured NCDs', 'Commercial paper', 'Bank term loans', 'FI & NHB loans',
  'Cash credit & WCDL', 'ECB loans', 'ECB bonds', 'Repo, TREPS & CBLO', 'Securitisation', 'Deposits',
  'Subordinated debt', 'Other borrowings', 'Debt securities (not split)', 'Borrowings (not split)',
];
const INVESTMENT_CATEGORIES = [
  'Government securities', 'Treasury bills', 'STRIPS', 'Mutual funds', 'Certificates of deposit',
  'Commercial paper', 'PTCs', 'Bonds & NCDs', 'TREPS & repo', 'Fixed deposits',
  'Subsidiaries, associates & JVs', 'Equity', 'Other investments',
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const fyNum = fy => +String(fy).replace(/\D/g, '').slice(-2);
const fyOf = n => 'FY' + String(n).padStart(2, '0').slice(-2);
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);

/* ── Report discovery ── */
let _browser = null;
async function browser() {
  if (!_browser) {
    const puppeteer = require('puppeteer');
    _browser = await puppeteer.launch({ headless: 'new', executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
  }
  return _browser;
}

function reportsFromJson(json) {
  // NSE's listing format isn't documented: accept any object that carries a PDF link + year.
  const out = [];
  const walk = v => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== 'object') return;
    const url = Object.values(v).find(x => typeof x === 'string' && /^https?:\/\/.+\.(pdf|zip)(\?|$)/i.test(x));
    if (url) {
      const yrs = [v.toYr, v.toYear, v.to_yr, v.fromYr].filter(Boolean).map(String);
      let to = yrs[0] && /^\d{4}$/.test(yrs[0]) ? +yrs[0] : null;
      if (!to) { const m = url.match(/(20\d{2})[_\-](20\d{2})/); if (m) to = +m[2]; }
      if (to) out.push({ fy: fyOf(to % 100), url, via: 'NSE' });
    }
    Object.values(v).forEach(x => { if (x && typeof x === 'object') walk(x); });
  };
  walk(json);
  return out;
}

async function nseReports(symbol) {
  const api = `https://www.nseindia.com/api/annual-reports?index=equities&symbol=${encodeURIComponent(symbol)}`;
  // 1) plain HTTP with cookies from a warm-up page
  try {
    const warm = await fetch(`https://www.nseindia.com/get-quotes/equity?symbol=${encodeURIComponent(symbol)}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
    const cookies = (warm.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).join('; ');
    const r = await fetch(api, { headers: { 'User-Agent': UA, Accept: 'application/json', Referer: 'https://www.nseindia.com/', Cookie: cookies }, signal: AbortSignal.timeout(20000) });
    if (r.ok) { const found = reportsFromJson(await r.json()); if (found.length) return found; }
  } catch (e) { /* fall through to the browser */ }
  // 2) real browser (NSE blocks many datacenter requests that don't look like a browser)
  try {
    const b = await browser(); const page = await b.newPage();
    await page.setUserAgent(UA);
    await page.goto(`https://www.nseindia.com/get-quotes/equity?symbol=${encodeURIComponent(symbol)}`, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
    let json = null;
    for (let attempt = 1; attempt <= 3 && !json; attempt++) {
      try { // the quote page sometimes redirects/reloads while we read ("Execution context was destroyed")
        json = await page.evaluate(async u => { const r = await fetch(u, { credentials: 'include' }); return r.ok ? r.json() : null; }, api);
      } catch (e) {
        if (attempt === 3) throw e;
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
        await sleep(3000);
      }
    }
    await page.close();
    return json ? reportsFromJson(json) : [];
  } catch (e) {
    console.log(`    NSE listing failed for ${symbol}: ${e.message}`);
    return [];
  }
}

/* ── Company investor pages (second source; same pages as the FDG document collector) ── */
// "Annual Report 2024-25", "FY 2024-25", "FY25", "ar-2025-26", "Integrated Annual Report 2023-24" -> FY
function fyFromText(t) {
  const s = String(t).replace(/%20|_/g, ' ');
  let m = s.match(/(?:19|20)?(\d{2})\s*[-–/ ]\s*(?:20)?(\d{2})(?!\d)/);
  if (m && (+m[2] === (+m[1] + 1) % 100)) return 'FY' + m[2].padStart(2, '0');
  m = s.match(/\bfy\s*-?\s*(?:20)?(\d{2})(?!\d)/i);
  if (m) return 'FY' + m[1];
  return null;
}
// Bajaj's CMS links point at an internal host; the public file lives under /bfl/ (verified in the FDG collector)
function publicUrl(u) {
  const m = u.match(/aboutbajajfinserv\.com\/corporate-pdf\/bajaj-finance-limited\/(.+?)(?:\.pdf)?$/i);
  return m ? 'https://www.aboutbajajfinserv.com/bfl/' + m[1] : u;
}
const AR_RE = /annual\s*report|integrated\s*(annual\s*)?report|\biar\b|annual-report|annualreport/i;
const DOC_RE = /\.pdf\b|\.ashx\b|\.zip\b|\/-\/media\/|\/documents\/d\/|\/download|aboutbajajfinserv\.com\/bfl\/|cms-assets\.bajajfinserv\.in/i;

async function siteReports(co) {
  const site = co.site; if (!site || !(site.pages || []).length) return [];
  const links = [];
  for (const pageUrl of site.pages) {
    try {
      const b = await browser(); const page = await b.newPage(); await page.setUserAgent(UA);
      await page.goto(pageUrl, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
      await sleep(2000);
      // open accordions/tabs that hide older years (best effort)
      await page.evaluate(() => {
        for (const el of document.querySelectorAll('button, [role=tab], .accordion-header, summary, li a'))
          if (/20\d\d\s*[-–]\s*\d\d|annual|fy\s*\d/i.test(el.textContent || '') && !/\.pdf/i.test(el.getAttribute('href') || '')) { try { el.click(); } catch (e) {} }
      }).catch(() => {});
      await sleep(1500);
      const found = await page.evaluate(() => {
        const out = [];
        for (const a of document.querySelectorAll('a[href]')) out.push({ href: a.href, text: (a.textContent || a.getAttribute('title') || a.getAttribute('aria-label') || '').trim().slice(0, 200), ctx: (a.closest('li,tr,div,section') || a).textContent.trim().slice(0, 300) });
        const html = document.documentElement.innerHTML;
        for (const m of html.matchAll(/https?:\/\/[^"'\s<>()]+/g)) out.push({ href: m[0].replace(/\\\//g, '/'), text: '', ctx: '' });
        return out;
      }).catch(() => []);
      await page.close();
      links.push(...found.map(f => ({ ...f, page: pageUrl })));
    } catch (e) { console.log(`    company site ${pageUrl}: ${e.message}`); }
  }
  const exclude = site.exclude ? new RegExp(site.exclude, 'i') : null;
  const out = [], seen = new Set();
  for (const l of links) {
    let url; try { url = publicUrl(new URL(l.href, l.page).href); } catch (e) { continue; }
    const host = new URL(url).hostname;
    if (!(site.domains || []).some(d => host === d || host.endsWith('.' + d))) continue;
    if (!DOC_RE.test(url)) continue;
    const words = `${l.text} ${decodeURIComponent(url)}`;
    if (!AR_RE.test(words) && !AR_RE.test(l.ctx)) continue;
    if (exclude && exclude.test(words)) continue;
    if (/notice|agm|brsr|business responsibility|sustainability|esg|annual return|mgt|abridged|summary|subsidiar/i.test(words)) continue;
    const fy = fyFromText(l.text) || fyFromText(decodeURIComponent(url)) || fyFromText(l.ctx);
    if (!fy || seen.has(url)) continue;
    seen.add(url);
    out.push({ fy, url, via: 'company website' });
  }
  return out;
}

function bseGuesses(code, years) {
  return years.map(fy => ({ fy, url: `https://www.bseindia.com/bseplus/AnnualReport/${code}/${code}03${String(fyNum(fy)).padStart(2, '0')}.pdf`, via: 'BSE', guess: true }));
}

/** Older annual reports on NSE are .zip files holding one or more PDFs (often one per
 *  section). Returns the PDFs inside, largest first. Plain zip only (no encryption). */
function unzipPdfs(buf) {
  const zlib = require('zlib');
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return [];
  const n = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let k = 0; k < n && p + 46 <= buf.length; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    if (!/\.pdf$/i.test(name) || /__MACOSX/.test(name)) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.slice(start, start + csize);
    try {
      const pdf = method === 0 ? data : method === 8 ? zlib.inflateRawSync(data) : null;
      if (pdf && pdf.slice(0, 5).toString() === '%PDF-') out.push({ name, pdf });
    } catch (e) { /* skip a damaged entry */ }
  }
  return out.sort((a, b) => b.pdf.length - a.pdf.length);
}

// A downloaded file -> PDF buffer, or an array of PDF buffers for a zipped report
function asPdf(buf) {
  if (!buf || buf.length < 5) return null;
  if (buf.slice(0, 5).toString() === '%PDF-') return buf;
  if (buf.slice(0, 2).toString() === 'PK') {
    const pdfs = unzipPdfs(buf);
    if (!pdfs.length) return null;
    // a single file whose name says standalone financials beats the rest
    const sa = pdfs.filter(x => /standalone/i.test(x.name));
    return (sa.length ? sa : pdfs).map(x => x.pdf);
  }
  return null;
}

async function download(url) {
  const headers = { 'User-Agent': UA, Accept: 'application/pdf,*/*', Referer: new URL(url).origin + '/' };
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(180000) });
    if (r.ok) { const got = asPdf(Buffer.from(await r.arrayBuffer())); if (got) return got; }
  } catch (e) { /* try the browser */ }
  try { // via a real browser session (BSE/NSE archives sometimes refuse plain requests)
    const b = await browser(); const page = await b.newPage(); await page.setUserAgent(UA);
    await page.goto(new URL(url).origin + '/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    const b64 = await page.evaluate(async u => {
      const r = await fetch(u, { credentials: 'include' }); if (!r.ok) return null;
      const a = new Uint8Array(await r.arrayBuffer()); let s = ''; for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode.apply(null, a.subarray(i, i + 0x8000));
      return btoa(s);
    }, url);
    await page.close();
    if (b64) { const got = asPdf(Buffer.from(b64, 'base64')); if (got) return got; }
  } catch (e) { /* give up */ }
  return null;
}

function wantedYears(found, n) {
  const latest = Math.max(...found.map(r => fyNum(r.fy)), 0);
  if (!latest) return [];
  // Each report also carries the previous year, so every second report is enough for
  // figures; we still take each year's own report when available (it's the primary source).
  return Array.from({ length: n }, (_, i) => fyOf(latest - i));
}

async function discover(co) {
  if (LOCAL_DIR) {
    return fs.readdirSync(LOCAL_DIR).map(f => f.match(new RegExp(`^${co.key}_(FY\\d{2})\\.(pdf|zip)$`, 'i')))
      .filter(Boolean).map(m => ({ fy: m[1].toUpperCase(), url: 'file://' + path.join(LOCAL_DIR, m[0]), via: 'local' }));
  }
  const found = Object.entries(co.reports || {}).map(([fy, url]) => ({ fy: fy.toUpperCase(), url, via: 'manual link' }));
  // Every source is kept: if one copy of a year's report can't be read, the next is tried
  if (co.nse) {
    const nse = await nseReports(co.nse);
    console.log(`    NSE listing: ${nse.length} report(s)`);
    for (const r of nse) if (!found.some(f => f.url === r.url)) found.push(r);
  }
  if (co.site) {
    const sr = await siteReports(co);
    console.log(`    company website: ${sr.length} annual report(s)`);
    for (const r of sr) if (!found.some(f => f.url === r.url)) found.push(r);
  }
  if (co.bse) {
    const latestGuess = new Date().getMonth() >= 8 ? new Date().getFullYear() % 100 : new Date().getFullYear() % 100 - 1;
    const years = Array.from({ length: CONFIG.years + 1 }, (_, i) => fyOf(latestGuess - i));
    for (const g of bseGuesses(co.bse, years)) if (!found.some(f => f.fy === g.fy)) found.push(g);
  }
  return found;
}

/* ── Merge extracted reports into per-company series ── */
function mergeCompany(co, extracted) {
  // Primary figure for a year = that year's own report; fallback = next year's comparative column.
  const byFy = {};
  const pick = (fy, getter) => {
    const own = extracted.find(e => e.fy === fy), next = extracted.find(e => e.prevFy === fy);
    const v = own ? getter(own, 'cy') : undefined;
    if (v !== undefined && v !== null) return { v, src: own, col: 'cy' };
    const w = next ? getter(next, 'py') : undefined;
    return w !== undefined && w !== null ? { v: w, src: next, col: 'py' } : null;
  };
  const years = [...new Set(extracted.flatMap(e => [e.fy, e.prevFy]))].sort((a, b) => fyNum(a) - fyNum(b));
  const rows = new Map();
  const total = {}, fc = {}, invTotal = {}, sources = {}, warnings = [];
  const invRows = new Map();
  for (const fy of years) {
    const b = pick(fy, (e, col) => e.borrowing[col === 'cy' ? e.fy : e.prevFy]?.length ? e.borrowing[col === 'cy' ? e.fy : e.prevFy] : null);
    if (b) {
      for (const r of b.v) {
        const k = r.category + '|' + r.label.toLowerCase();
        if (!rows.has(k)) rows.set(k, { label: r.label, category: r.category, values: {}, pages: {} });
        const row = rows.get(k); row.values[fy] = (row.values[fy] || 0) + r.value; row.pages[fy] = r.page;
        if (r.unsplit) warnings.push(`${fy}: ${r.label.replace(/ \(balance sheet total\)/, '')} shown as a balance-sheet total (note breakdown could not be read)`);
      }
      total[fy] = b.v.reduce((a, r) => a + r.value, 0);
      sources[fy] = { report: b.src.reportFy, via: b.src.via, url: b.src.url, column: b.col === 'cy' ? 'current year' : 'previous-year comparative', unit: b.src.unit, pages: Object.fromEntries(Object.entries(b.src.statement || {}).map(([k, v]) => [k, v.page])) };
    }
    const f = pick(fy, (e, col) => e.finance_cost?.[col === 'cy' ? e.fy : e.prevFy]);
    if (f) fc[fy] = f.v;
    const it = pick(fy, (e, col) => e.investment_total?.[col === 'cy' ? e.fy : e.prevFy]);
    if (it) invTotal[fy] = it.v;
    const own = extracted.find(e => e.fy === fy);
    if (own && own.investments?.[fy]?.length) {
      for (const r of own.investments[fy]) {
        const k = r.category + '|' + r.label.toLowerCase();
        if (!invRows.has(k)) invRows.set(k, { label: r.label, category: r.category, values: {}, pages: {} });
        const row = invRows.get(k); row.values[fy] = (row.values[fy] || 0) + r.value; row.pages[fy] = r.page;
      }
    }
  }
  const byears = years.filter(fy => total[fy] != null);
  const avgBorrowing = {}, avgCost = {};
  byears.forEach((fy, i) => {
    const prev = fyOf(fyNum(fy) - 1);
    if (total[prev] != null) avgBorrowing[fy] = (total[fy] + total[prev]) / 2;
    if (fc[fy] != null && avgBorrowing[fy]) avgCost[fy] = fc[fy] / avgBorrowing[fy];
  });
  const brows = [...rows.values()];
  const iyears = years.filter(fy => invTotal[fy] != null);
  const irows = [...invRows.values()];
  return {
    key: co.key, name: co.name, short: co.short, sheet: 'annual reports', base: !!co.base,
    borrowing: { years: byears, rows: brows, subtotals: [], total, mix: mix(brows, byears, total, BORROWING_CATEGORIES),
                 finance_cost: fc, avg_borrowing: avgBorrowing, avg_cost: avgCost },
    investments: iyears.length ? { years: iyears, rows: irows, total: invTotal, mix: mix(irows, iyears, invTotal, INVESTMENT_CATEGORIES) } : null,
    sources, warnings: [...new Set(warnings)],
  };
}

function mix(rows, years, total, cats) {
  const amounts = {}, shares = {};
  for (const c of cats) { amounts[c] = {}; shares[c] = {}; }
  for (const fy of years) {
    for (const c of cats) amounts[c][fy] = 0;
    for (const r of rows) if (r.values[fy] != null) amounts[r.category][fy] += r.values[fy];
    for (const c of cats) shares[c][fy] = total[fy] ? amounts[c][fy] / total[fy] : null;
  }
  const used = cats.filter(c => years.some(fy => amounts[c][fy]));
  return { categories: used, amounts: pickKeys(amounts, used), shares: pickKeys(shares, used) };
}
const pickKeys = (o, keys) => Object.fromEntries(keys.map(k => [k, o[k]]));

/* ── Commentary (drafted from the numbers; editable in the portal) ── */
const pct = v => v == null ? '—' : (v * 100).toFixed(1) + '%';
const pp = v => (v >= 0 ? '+' : '−') + Math.abs(v * 100).toFixed(1) + ' pp';
const bps = v => (v >= 0 ? '+' : '−') + Math.round(Math.abs(v) * 10000) + ' bps';
const cr = v => '₹' + Math.round(v).toLocaleString('en-IN') + ' cr';

function summaryTables(companies, fy) {
  const base = companies.find(c => c.base) || companies[0];
  const peers = companies.filter(c => c !== base);
  const build = (part, cats, title) => {
    const rows = [];
    for (const cat of cats) {
      const share = c => partOf(c, part)?.mix.shares[cat]?.[fy];
      const bv = share(base); const pv = peers.map(c => ({ c, v: share(c) })).filter(x => x.v != null);
      const anyData = (bv || 0) > 0 || pv.some(x => x.v > 0);
      if (bv == null || !pv.length || !anyData || /not split/.test(cat)) continue;
      const peer = pv.reduce((a, x) => a + x.v, 0) / pv.length, gap = bv - peer;
      const top = pv.slice().sort((a, b) => b.v - a.v)[0];
      let remark;
      const book = part === 'borrowing' ? 'borrowings' : 'investments';
      if (Math.abs(gap) < 0.01) remark = `${base.short} is broadly in line with peers on ${cat}: ${pct(bv)} of ${book} vs ${pct(peer)} peer average.`;
      else if (gap > 0) remark = `${base.short} has a larger share in ${cat} than peers: ${pct(bv)} of ${book} vs ${pct(peer)} peer average (${pp(gap)}).`;
      else remark = `${base.short} has a smaller share in ${cat} than peers: ${pct(bv)} of ${book} vs ${pct(peer)} peer average (${pp(gap)}); highest is ${top.c.short} at ${pct(top.v)}.`;
      rows.push({ metric: cat, bfl: bv, peer, gap, remark, key: `remark:${part}:${cat}` });
    }
    rows.sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap));
    if (part === 'borrowing') {
      const cost = c => c.borrowing.avg_cost[fy];
      const pv = peers.map(cost).filter(v => v != null);
      if (cost(base) != null && pv.length) {
        const peer = pv.reduce((a, b) => a + b, 0) / pv.length, gap = cost(base) - peer;
        rows.push({ metric: 'Average borrowing cost', bfl: cost(base), peer, gap, key: 'remark:borrowing:cost',
          remark: `${base.short}'s average borrowing cost of ${(cost(base) * 100).toFixed(2)}% is ${Math.round(Math.abs(gap) * 10000)} bps ${gap < 0 ? 'below' : 'above'} the peer average of ${(peer * 100).toFixed(2)}%.` });
      }
    }
    return { title, kind: part === 'borrowing' ? 'borrowing' : 'investment', fy, columns: ['Metric', base.short, 'Peer Avg', 'Gap vs Peer Avg', 'Remarks'], rows };
  };
  return [build('borrowing', BORROWING_CATEGORIES, `Borrowing instrument mix, ${fy}`),
          build('investments', INVESTMENT_CATEGORIES, `Investment instrument mix, ${fy}`)].filter(t => t.rows.length);
}
const partOf = (c, part) => part === 'borrowing' ? c.borrowing : c.investments;

function readouts(c) {
  const out = [], b = c.borrowing, ys = b.years; if (!ys.length) return out;
  const last = ys[ys.length - 1], first = ys[0], prev = ys[ys.length - 2];
  const add = (area, text) => out.push({ area, text, key: `readout:${c.key}:${area}` });
  if (prev) {
    const g = b.total[last] / b.total[prev] - 1, n = fyNum(last) - fyNum(first);
    const cagr = n > 0 ? Math.pow(b.total[last] / b.total[first], 1 / n) - 1 : null;
    add('Borrowing book', `Total borrowings of ${cr(b.total[last])} in ${last}, ${g >= 0 ? 'up' : 'down'} ${Math.abs(g * 100).toFixed(1)}% on ${prev}` + (cagr != null && n > 1 ? `; ${(cagr * 100).toFixed(1)}% a year (CAGR) since ${first} (${cr(b.total[first])}).` : '.'));
  }
  const sh = b.mix.shares, cats = b.mix.categories.filter(k => !/not split/.test(k));
  const top = cats.slice().sort((x, y) => (sh[y][last] || 0) - (sh[x][last] || 0)).slice(0, 3);
  if (top.length) add('Funding mix', `Largest sources in ${last}: ` + top.map(k => `${k} (${pct(sh[k][last])})`).join(', ') + '.');
  if (first !== last) {
    const moves = cats.map(k => ({ k, d: (sh[k][last] || 0) - (sh[k][first] || 0) })).sort((x, y) => Math.abs(y.d) - Math.abs(x.d)).slice(0, 2).filter(m => Math.abs(m.d) >= 0.01);
    if (moves.length) add('Mix shift', `Biggest changes since ${first}: ` + moves.map(m => `${m.k} ${pp(m.d)}`).join(', ') + '.');
  }
  if (b.avg_cost[last] != null) add('Borrowing cost', `Average borrowing cost ${(b.avg_cost[last] * 100).toFixed(2)}% in ${last}` + (b.avg_cost[prev] != null ? ` (${bps(b.avg_cost[last] - b.avg_cost[prev])} vs ${prev}).` : '.'));
  const inv = c.investments;
  if (inv) {
    const il = inv.years[inv.years.length - 1], ish = inv.mix.shares;
    const itop = inv.mix.categories.slice().sort((x, y) => (ish[y][il] || 0) - (ish[x][il] || 0))[0];
    add('Investment book', `Investment book of ${cr(inv.total[il])} in ${il}` + (itop && ish[itop][il] ? `; largest holding ${itop} (${pct(ish[itop][il])}).` : '.'));
  }
  if (c.warnings.length) add('Data notes', c.warnings.join(' '));
  return out;
}

/* ── Main ── */
async function main() {
  console.log('=== Treasury Peer Benchmarking — ' + new Date().toISOString() + (LOCAL_DIR ? ` (local test: ${LOCAL_DIR})` : '') + ' ===');
  fs.mkdirSync(EXTRACTED_DIR, { recursive: true });
  const runLog = { started: new Date().toISOString(), companies: {} };
  const companies = [];
  for (const co of CONFIG.companies) {
    if (ONLY.length && !ONLY.includes(co.key)) continue;
    console.log(`\n▶ ${co.name}`);
    const log = runLog.companies[co.key] = { reports: [], missing: [] };
    if (fs.existsSync(DEBUG_DIR)) for (const f of fs.readdirSync(DEBUG_DIR)) if (f.startsWith(co.key + '_')) fs.unlinkSync(path.join(DEBUG_DIR, f));
    const found = await discover(co);
    const years = wantedYears(found, CONFIG.years);
    const extracted = [];
    for (const fy of years) {
      const cached = path.join(EXTRACTED_DIR, `${co.key}_${fy}.json`);
      const cand = found.filter(r => r.fy === fy);
      if (!FORCE && fs.existsSync(cached)) {
        const e = JSON.parse(fs.readFileSync(cached, 'utf8'));
        if (e.ok && e.extractor === EXTRACTOR_VERSION) { extracted.push(e); log.reports.push({ fy, status: 'cached', url: e.url }); continue; }
      }
      let done = false;
      for (const r of cand) {
        console.log(`    ${fy}: ${r.via} ${r.url}`);
        const buf = r.url.startsWith('file://') ? asPdf(fs.readFileSync(r.url.slice(7))) : await download(r.url);
        if (!buf) { log.reports.push({ fy, status: r.guess ? 'not on BSE' : 'download failed', url: r.url }); console.log(`      ✗ ${r.guess ? 'not on BSE' : 'download failed'}`); continue; }
        try {
          const e = await extractReport(buf, { fyHint: fy });
          Object.assign(e, { url: r.url, via: r.via, reportFy: fy, extractor: EXTRACTOR_VERSION,
            sha: sha(Array.isArray(buf) ? Buffer.concat(buf) : buf), extractedAt: new Date().toISOString() });
          if (e.ok && !['debt_securities', 'borrowings', 'deposits', 'subordinated'].some(k => e.statement[k])) {
            e.ok = false; e.error = `no borrowing lines found on the standalone balance sheet (p.${e.standalonePages[0]})`;
          }
          if (e.debug) { // what the reader saw, so a failed or partial report can be fixed
            fs.mkdirSync(DEBUG_DIR, { recursive: true });
            fs.writeFileSync(path.join(DEBUG_DIR, `${co.key}_${fy}.txt`), `${r.url}\n${e.debug}\n`);
            delete e.debug;
          }
          if (!e.ok) { log.reports.push({ fy, status: 'extraction failed: ' + e.error, url: r.url }); console.log(`      ✗ ${e.error}`); continue; }
          if (e.fy !== fy) e.log.push(`report labelled ${fy} but balance sheet is dated ${e.fy}`);
          fs.writeFileSync(cached, JSON.stringify(e, null, 1));
          extracted.push(e); done = true;
          log.reports.push({ fy, status: 'extracted', url: r.url, notes: e.log });
          console.log(`      ✓ ${e.log.join(' | ')}`);
          break;
        } catch (err) {
          log.reports.push({ fy, status: 'extraction error: ' + err.message, url: r.url });
          console.log(`      ✗ ${err.message}`);
          fs.mkdirSync(DEBUG_DIR, { recursive: true });
          fs.writeFileSync(path.join(DEBUG_DIR, `${co.key}_${fy}.txt`), `${r.url}\nReason: ${err.message}\n`);
        }
        if (!r.url.startsWith('file://')) await sleep(1500);
      }
    }
    const covered = new Set(extracted.flatMap(e => [e.fy, e.prevFy]));
    log.missing = years.filter(fy => !covered.has(fy));
    if (!found.length) log.missing.push('no annual reports found — add links in treasury-sources.js');
    if (extracted.length) companies.push(mergeCompany(co, extracted));
    else console.log('    ✗ no usable report');
  }
  if (_browser) await _browser.close();

  const ord = Object.fromEntries(CONFIG.companies.map((c, i) => [c.key, i]));
  companies.sort((a, b) => ord[a.key] - ord[b.key]);
  const allYears = [...new Set(companies.flatMap(c => c.borrowing.years))].sort((a, b) => fyNum(a) - fyNum(b));
  const base = companies.find(c => c.base);
  // Default year: the latest year with data for the base company and at least one peer.
  const defYear = allYears.slice().reverse().find(fy => base?.borrowing.total[fy] != null && companies.filter(c => c !== base && c.borrowing.total[fy] != null).length) || allYears[allYears.length - 1];
  for (const c of companies) c.readouts = readouts(c);
  const out = {
    source: 'Annual reports (standalone financial statements)', method: 'auto', generated_at: new Date().toISOString(),
    companies, summary: defYear ? summaryTables(companies, defYear) : [], studies: [],
    years: allYears, default_year: defYear,
    borrowing_categories: BORROWING_CATEGORIES, investment_categories: INVESTMENT_CATEGORIES,
    missing: Object.fromEntries(Object.entries(runLog.companies).map(([k, v]) => [k, v.missing]).filter(([, v]) => v.length)),
  };
  // Keep the previous file's studies (e.g. STRIPS notes) if any were added by hand.
  const outFile = path.join(OUT_DIR, 'benchmark.json');
  if (fs.existsSync(outFile)) { try { out.studies = JSON.parse(fs.readFileSync(outFile, 'utf8')).studies || []; } catch (e) {} }
  if (!companies.length) { console.log('\nNo company produced data — benchmark.json left unchanged.'); }
  else fs.writeFileSync(outFile, JSON.stringify(out, null, 1));
  runLog.finished = new Date().toISOString();
  fs.writeFileSync(path.join(OUT_DIR, 'run-log.json'), JSON.stringify(runLog, null, 1));
  console.log(`\nDone: ${companies.length} companies, years ${allYears.join(', ')}, default ${defYear}.`);
  for (const [k, v] of Object.entries(out.missing)) console.log(`  missing ${k}: ${v.join(', ')}`);
}

if (require.main === module) main().catch(async e => { console.error(e); if (_browser) await _browser.close(); process.exit(1); });
module.exports = { mergeCompany, summaryTables, readouts, reportsFromJson, siteReports, fyFromText, publicUrl, unzipPdfs };
