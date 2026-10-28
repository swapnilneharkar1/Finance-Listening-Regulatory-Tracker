/**
 * treasury-extract.js — rule-based extraction of borrowing / investment figures from an
 * NBFC annual report PDF (Ind AS, Schedule III Division III format).
 *
 * No AI: GitHub Actions can't reach Azure OpenAI (see scraper.js notes), so this reads the
 * standard statements directly:
 *   - Standalone Balance Sheet  -> Debt securities, Borrowings (other than debt securities),
 *                                  Deposits, Subordinated liabilities, Investments (+ note refs)
 *   - Standalone P&L            -> Finance costs
 *   - The matching notes        -> instrument-wise breakdown
 * Every figure keeps the PDF page it came from. Breakdowns that don't add up to the note
 * total / balance-sheet line are NOT used (the statement-level total is used instead), so a
 * parsing miss can never publish a wrong mix.
 */
const pdfParse = require('pdf-parse');
let pdfjs = null; // newer pdf.js reads PDFs that pdf-parse's bundled 2018 copy can't ("Invalid PDF structure")
try {
  const w = console.warn, l = console.log; console.warn = () => {}; console.log = () => {};
  try { pdfjs = require('pdfjs-dist/legacy/build/pdf.js'); } finally { console.warn = w; console.log = l; }
} catch (e) { pdfjs = null; }

/* ── 1. PDF -> pages of text lines (columns kept apart with wide gaps) ── */
function itemsToLines(items, width, height) {
  // A landscape PDF page that holds two printed pages side by side (Shriram, Mahindra):
  // read the left half, then the right half, so lines from the two pages don't merge.
  if (width && height && width > height * 1.15) {
    const mid = width / 2;
    const left = items.filter(it => it.transform[4] < mid - 2), right = items.filter(it => it.transform[4] >= mid - 2);
    if (left.length > 5 && right.length > 5) return itemsToLines(left).concat(itemsToLines(right));
  }
  const rows = [];
  for (const it of items) {
    const s = it.str; if (!s || !s.trim()) continue;
    const x = it.transform[4], y = it.transform[5], w = it.width || s.length * 4;
    let row = rows.find(r => Math.abs(r.y - y) <= 2.5);
    if (!row) { row = { y, items: [] }; rows.push(row); }
    row.items.push({ x, w, s });
  }
  rows.sort((a, b) => b.y - a.y);
  return rows.map(r => {
    r.items.sort((a, b) => a.x - b.x);
    let out = '', end = null;
    for (const it of r.items) {
      if (end != null) { const gap = it.x - end; out += gap > 12 ? '   ' : gap > 1.5 ? ' ' : ''; }
      out += it.s; end = it.x + it.w;
    }
    return out.replace(/\s+$/, '');
  });
}

async function pagesWithPdfjs(buffer) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, disableFontFace: true,
    useSystemFonts: false, verbosity: 0 }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    const vp = page.getViewport({ scale: 1 });
    pages.push(itemsToLines(tc.items, vp.width, vp.height));
    page.cleanup();
  }
  await doc.destroy();
  return pages;
}

async function pagesWithPdfParse(buffer) {
  const pages = [];
  await pdfParse(buffer, {
    pagerender: async page => {
      const tc = await page.getTextContent({ normalizeWhitespace: true, disableCombineTextItems: false });
      const v = page.view || [];
      const lines = itemsToLines(tc.items, v[2] - v[0], v[3] - v[1]);
      pages.push(lines);
      return lines.join('\n');
    },
  });
  return pages;
}

async function pdfToPages(buffer) {
  const quiet = console.warn, ql = console.log; // pdf.js font warnings are noise
  const mute = (...a) => { const m = a.join(' '); if (/font|TT:|glyf|Warning|DOMMatrix|Path2D|canvas/i.test(m)) return; quiet(...a); };
  console.warn = mute; console.log = (...a) => { if (/Warning|font/i.test(a.join(' '))) return; ql(...a); };
  try {
    let first = null;
    if (pdfjs) {
      try { return await pagesWithPdfjs(buffer); } catch (e) { first = e; }
    }
    try { return await pagesWithPdfParse(buffer); } // pages[i] = array of lines, page number = i + 1
    catch (e) {
      const head = buffer.slice(0, 16).toString('latin1').replace(/[^\x20-\x7e]/g, '.');
      const tail = buffer.slice(-32).toString('latin1').replace(/[^\x20-\x7e]/g, '.');
      e.message = `${e.message} (pdf.js: ${pdfjs ? (first && first.message) : 'not installed'}; ${buffer.length} bytes; starts "${head}"; ends "${tail}")`;
      throw e;
    }
  } finally { console.warn = quiet; console.log = ql; }
}

/* ── 2. Numbers ── */
const NUM_RE = /^\(?[-–—]?\s?\d[\d,]*(\.\d+)?\)?$|^[-–—]$/;
function parseAmount(tok) {
  if (/^[-–—]$/.test(tok)) return 0;
  const neg = /^\(.*\)$/.test(tok) || /^[-–—]\s?\d/.test(tok);
  const v = parseFloat(tok.replace(/[(),\s–—-]/g, ''));
  return isNaN(v) ? null : (neg ? -v : v);
}
const looksLikeAmount = t => NUM_RE.test(t) && (/[,.]/.test(t) || /^[-–—]$/.test(t) || t.replace(/\D/g, '').length >= 3);
const looksLikeNoteRef = t => /^\d{1,2}(\.\d{1,2})?[a-z]?$/i.test(t) && !/,/.test(t);

/** Split a line into { label, amounts[], noteRef } using its trailing numeric tokens.
 *  "Debt securities   19   1,54,639.73   1,18,014.59" -> label "Debt securities", note "19",
 *  amounts [154639.73, 118014.59]. Amounts are taken from the right; the first short
 *  integer before them (no comma/decimal) is the note reference. */
function splitLine(line) {
  const toks = line.trim().split(/\s+/);
  let i = toks.length - 1;
  const nums = [];
  while (i >= 0 && looksLikeAmount(toks[i])) { nums.unshift(toks[i]); i--; }
  let noteRef = null;
  if (nums.length && i >= 1 && looksLikeNoteRef(toks[i])) { noteRef = toks[i]; i--; }
  const label = toks.slice(0, i + 1).join(' ')
    .replace(/^\(?[ivx]+\)\s*|^\(?[a-z]\)\s*|^\d+(\.\d+)*[.)]\s+|^[-–•]\s*/i, '')
    .replace(/\s*[:–-]\s*$/, '').trim();
  return { label, amounts: nums.map(parseAmount).filter(v => v != null), noteRef };
}

/* ── 3. Units ── */
function detectUnit(lines) {
  const t = lines.join(' ').toLowerCase();
  if (/(₹|rs\.?|inr|rupees)\s*(in\s*)?lakhs?\b|in\s*lakhs?/.test(t)) return { unit: 'lakh', toCrore: 0.01 };
  if (/(₹|rs\.?|inr|rupees)\s*(in\s*)?millions?\b|in\s*millions?/.test(t)) return { unit: 'million', toCrore: 0.1 };
  if (/(₹|rs\.?|inr|rupees)\s*(in\s*)?billions?\b|in\s*billions?/.test(t)) return { unit: 'billion', toCrore: 100 };
  if (/crores?/.test(t)) return { unit: 'crore', toCrore: 1 };
  return { unit: 'crore (assumed)', toCrore: 1 };
}

/* ── 4. Find the standalone statements ── */
const norm = s => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Lines that repeat on many pages: running headers, footers and side tabs such as
 *  "Standalone Financial Statements | Consolidated Financial Statements". They must not
 *  decide whether a page is standalone or consolidated. */
function boilerplate(pages) {
  const count = new Map();
  for (const lines of pages) for (const l of new Set(lines.map(norm))) if (l) count.set(l, (count.get(l) || 0) + 1);
  const limit = Math.max(6, pages.length * 0.15);
  return new Set([...count].filter(([, n]) => n >= limit).map(([l]) => l));
}

// Balance-sheet lines (squashed words such as "Debtsecurities" match too)
const BS_KEYS = {
  debt_securities: /^debt\s*securities$/, borrowings: /^borrowings\s*\(?\s*other\s*than\s*debt\s*securities\s*\)?$/,
  deposits: /^deposits$/, subordinated: /^subordinated\s*(liabilities|debts?)$/, investments: /^investments$/,
  loans: /^loans$/, cash: /^cash\s*and\s*cash\s*equivalents$/,
};
function bsKeysOn(lines) {
  const keys = new Set();
  for (const l of lines) {
    const sp = splitLine(l); if (sp.amounts.length < 2) continue;
    const lab = norm(sp.label);
    for (const [k, rx] of Object.entries(BS_KEYS)) if (rx.test(lab)) keys.add(k);
  }
  return keys;
}

function findStandaloneRange(pages) {
  const skip = boilerplate(pages);
  const head = p => pages[p].filter(l => !skip.has(norm(l))).slice(0, 18);
  const raw = p => pages[p].slice(0, 14);
  const BS_TITLE = /balance\s*sheet|statement\s*of\s*(assets\s*and\s*liabilities|financial\s*position)/i;
  const isConsol = p => head(p).some(l => /consolidated/i.test(l) && !/standalone/i.test(l) &&
    /(balance\s*sheet|statement\s*of\s*profit|financial\s*position|cash\s*flow)/i.test(l) && l.length < 90) ||
    head(p).some((l, i, a) => /^consolidated$/i.test(l.trim()) && BS_TITLE.test(a[i + 1] || ''));
  const notesPage = p => raw(p).slice(0, 6).some(l => /^notes?\s*(forming|to\s*(the\s*)?(standalone|financial))/i.test(l.trim()));
  let best = null;
  for (let p = 0; p < pages.length; p++) {
    if (isConsol(p)) continue;
    const keys = bsKeysOn(pages[p]);
    if (!keys.size) continue;
    const next = p + 1 < pages.length && !isConsol(p + 1) ? bsKeysOn(pages[p + 1]) : new Set();
    const all = new Set([...keys, ...next]);   // assets on this page, liabilities on the next
    if (!all.has('debt_securities') && !all.has('borrowings')) continue;
    let score = all.size;
    if (raw(p).some(l => /standalone\s*balance\s*sheet/i.test(l))) score += 4;
    else if (raw(p).some(l => l.length < 70 && /^(the\s*)?balance\s*sheet/i.test(l.trim()))) score += 2;
    if (notesPage(p)) score -= 4;
    if (all.has('debt_securities') || all.has('borrowings')) score += 1;
    if (!best || score > best.score) best = { p, score };
  }
  if (!best || best.score < 4) return null;
  const start = best.p;
  let end = pages.length;
  for (let p = start + 1; p < pages.length; p++) if (isConsol(p) && (bsKeysOn(pages[p]).size >= 2 || head(p).some(l => BS_TITLE.test(l)))) { end = p; break; }
  return { start, end };
}

/** Year-end of the current-year column, e.g. "As at 31 March 2025" -> 2025. */
function detectYear(lines) {
  const top = lines.slice(0, 25);
  for (const l of top) {
    const m = l.match(/(?:31(?:st)?\s*march,?\s*|march\s*31,?\s*)(20\d{2})/i) || l.match(/31[.\-/]0?3[.\-/](20\d{2})/);
    if (m) return +m[1];
  }
  // "As at 31 March" with the years as column headings below: "Particulars  Note  2025  2024"
  const i = top.findIndex(l => /31(?:st)?\s*march|march\s*31/i.test(l));
  if (i >= 0) for (const l of top.slice(i, i + 3)) { const m = l.match(/\b(20\d{2})\b\s+\b(20\d{2})\b/); if (m && +m[1] === +m[2] + 1) return +m[1]; }
  return null;
}

/* ── 5. Statement lines ── */
const BS_ITEMS = {
  debt_securities: /^debt\s*securities$/,
  borrowings: /^borrowings\s*\(?\s*other\s*than\s*debt\s*securities\s*\)?$/,
  deposits: /^deposits$/,
  subordinated: /^subordinated\s*(liabilities|debts?)$/,
  investments: /^investments$/,
};
function readStatementItems(pages, range) {
  const out = {};
  for (let p = range.start; p < Math.min(range.end, range.start + 4); p++) {
    for (const line of pages[p]) {
      const sp = splitLine(line);
      if (sp.amounts.length < 2) continue;
      const lab = norm(sp.label);
      for (const [k, rx] of Object.entries(BS_ITEMS)) {
        if (!out[k] && rx.test(lab)) out[k] = { cy: sp.amounts[sp.amounts.length - 2], py: sp.amounts[sp.amounts.length - 1], note: sp.noteRef, page: p + 1 };
      }
    }
    if (Object.keys(out).length === Object.keys(BS_ITEMS).length) break;
  }
  // Finance costs: the P&L is usually the page right after the balance sheet
  for (let p = range.start; p < Math.min(range.end, range.start + 8); p++) {
    for (const line of pages[p]) {
      const sp = splitLine(line);
      if (sp.amounts.length >= 2 && /^finance\s*costs?$/.test(norm(sp.label))) {
        out.finance_cost = { cy: sp.amounts[sp.amounts.length - 2], py: sp.amounts[sp.amounts.length - 1], note: sp.noteRef, page: p + 1 };
        return out;
      }
    }
  }
  return out;
}

/* ── 6. Notes ── */
const NOTE_TITLES = {
  debt_securities: /debt\s*securities/,
  borrowings: /borrowings\s*\(?\s*other\s*than\s*debt\s*securities/,
  deposits: /^deposits\b/,
  subordinated: /subordinated\s*(liabilities|debts?)/,
  investments: /^investments\b/,
};
function findNote(pages, range, key, noteRef, afterPage) {
  const title = NOTE_TITLES[key];
  const refRe = noteRef ? new RegExp(`^(note\\s*(no\\.?)?\\s*[:.]?\\s*)?${noteRef.replace('.', '\\.')}\\s*[.:)-]?\\s*[a-z]`, 'i') : null;
  const figuresFollow = (p, i) => pages[p].slice(i + 1, i + 30).filter(l => splitLine(l).amounts.length >= 2).length >= 2;
  let best = null;
  for (let p = Math.max(range.start, afterPage || 0); p < range.end; p++) {
    for (let i = 0; i < pages[p].length; i++) {
      const raw = pages[p][i].trim();
      if (splitLine(raw).amounts.length) continue;         // headings carry no figures
      const stripped = raw.replace(/^(note\s*(no\.?)?\s*[:.]?\s*)?\d{1,2}(\.\d{1,2})*\s*[.:)-]?\s*/i, '');
      if (!title.test(norm(stripped)) || norm(stripped).length > 60) continue;
      if (/movement|maturity|repayment|terms|reconciliation|disclosure/i.test(stripped)) continue;
      if (!figuresFollow(p, i)) continue;                   // accounting-policy text, not the note table
      const score = (refRe && refRe.test(raw) ? 2 : 0) + (/^(note\b|\d)/i.test(raw) ? 1 : 0);
      if (!best || score > best.score) best = { page: p, line: i, score };
      if (score >= 3) return best;
    }
  }
  return best;
}

/** Read "label  CY  PY" rows of a note until its Total line. */
function readNoteRows(pages, at, key) {
  const rows = [];
  let total = null, ctx = { secured: null }, pending = '';
  const stopRe = /^(note\s*)?\d{1,2}(\.\d{1,2})?\s*[.:)-]?\s+[A-Z][a-z]/;
  let p = at.page, i = at.line + 1, seen = 0;
  while (p < pages.length && p <= at.page + 2) {
    const lines = pages[p];
    for (; i < lines.length; i++) {
      const raw = lines[i].trim(); if (!raw) continue;
      const sp = splitLine(raw);
      const lab = sp.label, low = lab.toLowerCase();
      if (!sp.amounts.length) {
        if (rows.length && stopRe.test(raw) && !NOTE_TITLES[key].test(norm(raw))) return { rows, total };
        if (/^secured\b/i.test(lab) || /\(secured\)/i.test(lab)) ctx.secured = true;
        else if (/^unsecured\b/i.test(lab) || /\(unsecured\)/i.test(lab)) ctx.secured = false;
        pending = lab.length < 80 && !/^(particulars|as at|at amortised|at fair|year ended|₹|rs)/i.test(lab) ? lab : '';
        continue;
      }
      if (sp.amounts.length < 2 && key !== 'investments') continue;
      let label = lab || pending;
      if (pending && lab && /^[a-z(]/.test(lab)) label = pending + ' ' + lab;
      pending = '';
      if ((/^total/i.test(label) && !/^total\s*outstanding/i.test(label)) || /^(sub[- ]?total)$/i.test(label)) {
        if (/sub/i.test(label)) continue;
        total = { cy: sp.amounts[sp.amounts.length - (key === 'investments' ? 1 : 2)], py: key === 'investments' ? null : sp.amounts[sp.amounts.length - 1], page: p + 1 };
        return { rows, total };
      }
      if (/^less\b|^less:|impairment|allowance|provision/i.test(label)) continue;
      if (/(as\s*at|as\s*on|year\s*ended|particulars|amortised|fvoci|fvtpl|fair\s*value)/i.test(label) || /(january|february|march|april|may|june|july|august|september|october|november|december)\s*\d/i.test(label)) continue;
      if (/in\s*india|outside\s*india|^\(?[ab]\)?$/i.test(low)) continue;
      const secured = /\bunsecured\b/i.test(label) ? false : /\bsecured\b/i.test(label) ? true : ctx.secured;
      rows.push(key === 'investments'
        ? { label, cy: sp.amounts[sp.amounts.length - 1], page: p + 1, secured }
        : { label, cy: sp.amounts[sp.amounts.length - 2], py: sp.amounts[sp.amounts.length - 1], page: p + 1, secured });
      if (++seen > 60) return { rows, total };
    }
    p++; i = 0;
  }
  return { rows, total };
}

/* ── 7. Categories (same groups as the portal dashboards) ── */
const loose = s => s.toLowerCase().replace(/\s+/g, '');
function borrowingCategory(label, secured, section) {
  const s = label.toLowerCase() + ' | ' + loose(label);
  const t = re => new RegExp(re.source.replace(/ /g, '\\s*').replace(/\\b/g, ''), 'i').test(s);
  if (section === 'subordinated' || t(/subordinat|perpetual|tier\s*ii/)) return 'Subordinated debt';
  if (section === 'deposits' || t(/deposit/) && !t(/certificate/)) return 'Deposits';
  if (t(/external commercial bond|senior secured note|offshore|masala|foreign currency bond|u\.?s\.? dollar/)) return 'ECB bonds';
  if (t(/external commercial borrowing|\becb\b/)) return 'ECB loans';
  if (t(/commercial paper/)) return 'Commercial paper';
  if (t(/securiti[sz](ation|ed)|pass through|\bptcs?\b/)) return 'Securitisation';
  if (t(/debenture|ncd|bond/)) return (secured === false || t(/unsecured/)) ? 'Unsecured NCDs' : 'Secured NCDs';
  if (t(/national housing bank|\bnhb\b|refinance|financial institution|sidbi|nabard|mudra/)) return 'FI & NHB loans';
  if (t(/cash credit|working capital|wcdl|overdraft|demand loan/)) return 'Cash credit & WCDL';
  if (t(/\brepo\b|repurchase|treps|cblo|csgl|tri-?party|collateralised/)) return 'Repo, TREPS & CBLO';
  if (t(/term loan|from banks?|bank loan/)) return 'Bank term loans';
  if (section === 'debt_securities') return secured === false ? 'Unsecured NCDs' : 'Secured NCDs';
  return 'Other borrowings';
}
function investmentCategory(label) {
  const s = label.toLowerCase() + ' | ' + loose(label);
  const t = re => new RegExp(re.source.replace(/ /g, '\\s*').replace(/\\b/g, ''), 'i').test(s);
  if (t(/interest accrued|electoral/)) return 'Other investments';
  if (t(/treasury bill|\bt-?bills?\b/)) return 'Treasury bills';
  if (t(/strips/)) return 'STRIPS';
  if (t(/government sec|\bg-?secs?\b|state development loan|\bsdl\b/)) return 'Government securities';
  if (t(/mutual fund/)) return 'Mutual funds';
  if (t(/certificates? of deposit/)) return 'Certificates of deposit';
  if (t(/commercial paper/)) return 'Commercial paper';
  if (t(/pass through|\bptcs?\b|securitised/)) return 'PTCs';
  if (t(/subsidiar|associate|joint venture/)) return 'Subsidiaries, associates & JVs';
  if (t(/treps|tri-?party|\brepo\b/)) return 'TREPS & repo';
  if (t(/fixed deposit|term deposit/)) return 'Fixed deposits';
  if (t(/equity|preference|ccps|shares/)) return 'Equity';
  if (t(/bond|ncd|debenture|debt securit/)) return 'Bonds & NCDs';
  return 'Other investments';
}

const close = (a, b, tol = 0.015) => a != null && b != null && Math.abs(a - b) <= Math.max(1, Math.abs(b) * tol);

/* ── Diagnostics: what the reader saw, for reports that could not be read ── */
function diagnose(pages, range, why) {
  const out = [`Reason: ${why}`, `Pages: ${pages.length}`];
  const skip = boilerplate(pages);
  out.push('Repeated header/footer lines (ignored): ' + [...skip].slice(0, 25).join(' | '));
  const show = (p, n) => { out.push(`\n===== page ${p + 1} =====`); pages[p].slice(0, n).forEach(l => out.push(l)); };
  if (range) {
    for (let p = range.start; p < Math.min(pages.length, range.start + 3); p++) show(p, 140);
  } else {
    // pages with the most balance-sheet-like lines (label + two amounts) first
    const ITEM = /debt\s*securities|borrowings|deposits|subordinated|total\s*(equity|liabilities)|investments|financial\s*liabilities/i;
    const scored = pages.map((lines, p) => ({ p, n: lines.filter(l => { const sp = splitLine(l); return sp.amounts.length >= 2 && ITEM.test(sp.label); }).length }))
      .filter(x => x.n >= 2).sort((a, b) => b.n - a.n).slice(0, 6).sort((a, b) => a.p - b.p);
    out.push('Candidate pages: ' + scored.map(x => `${x.p + 1} (${x.n} lines)`).join(', '));
    for (const { p } of scored) show(p, 90);
  }
  return out.join('\n');
}

/* ── 8. Whole report ── */
async function extractReport(buffer, { fyHint } = {}) {
  let pages = [];
  for (const b of Array.isArray(buffer) ? buffer : [buffer]) pages = pages.concat(await pdfToPages(b));
  const log = [];
  const range = findStandaloneRange(pages);
  if (!range) return { ok: false, error: 'Standalone balance sheet not found', pages: pages.length, debug: diagnose(pages, null, 'Standalone balance sheet not found') };
  const bsLines = pages[range.start];
  const unit = detectUnit(pages.slice(range.start, range.start + 2).flat());
  const year = detectYear(bsLines) || (fyHint ? 2000 + +String(fyHint).slice(2) : null);
  if (!year) return { ok: false, error: 'Could not read the balance-sheet date', pages: pages.length, debug: diagnose(pages, range, 'Could not read the balance-sheet date') };
  const fy = 'FY' + String(year).slice(2), pfy = 'FY' + String(year - 1).slice(2);
  const k = unit.toCrore;
  const stmt = readStatementItems(pages, range);
  const result = { ok: true, fy, prevFy: pfy, unit: unit.unit, pages: pages.length,
    standalonePages: [range.start + 1, range.end], statement: {}, borrowing: { [fy]: [], [pfy]: [] },
    investments: { [fy]: [] }, totals: {}, finance_cost: {}, log };

  for (const [key, v] of Object.entries(stmt)) result.statement[key] = { ...v, cy: v.cy * k, py: v.py * k };
  if (stmt.finance_cost) result.finance_cost = { [fy]: stmt.finance_cost.cy * k, [pfy]: stmt.finance_cost.py * k };

  // Borrowing notes
  for (const key of ['debt_securities', 'borrowings', 'deposits', 'subordinated']) {
    const line = stmt[key];
    if (!line) { log.push(`${key}: not on the balance sheet (treated as nil)`); continue; }
    const at = findNote(pages, range, key, line.note, line.page);
    const parsed = at ? readNoteRows(pages, at, key) : { rows: [], total: null };
    const sum = yr => parsed.rows.reduce((a, r) => a + (r[yr] || 0), 0);
    const okBreakdown = parsed.rows.length && close(sum('cy'), line.cy) && close(sum('py'), line.py);
    if (okBreakdown) {
      for (const r of parsed.rows) {
        const cat = borrowingCategory(r.label, r.secured, key);
        result.borrowing[fy].push({ label: r.label, category: cat, value: r.cy * k, page: r.page, section: key });
        result.borrowing[pfy].push({ label: r.label, category: cat, value: r.py * k, page: r.page, section: key });
      }
      log.push(`${key}: ${parsed.rows.length} lines from note p.${at.page + 1}, reconciles to balance sheet`);
    } else {
      const cat = { debt_securities: 'Debt securities (not split)', borrowings: 'Borrowings (not split)', deposits: 'Deposits', subordinated: 'Subordinated debt' }[key];
      result.borrowing[fy].push({ label: `${labelOf(key)} (balance sheet total)`, category: cat, value: line.cy * k, page: line.page, section: key, unsplit: key === 'debt_securities' || key === 'borrowings' });
      result.borrowing[pfy].push({ label: `${labelOf(key)} (balance sheet total)`, category: cat, value: line.py * k, page: line.page, section: key, unsplit: key === 'debt_securities' || key === 'borrowings' });
      log.push(`${key}: note ${at ? 'p.' + (at.page + 1) : 'not found'}; breakdown ${parsed.rows.length ? `sums to ${sum('cy').toFixed(2)} vs balance sheet ${line.cy}` : 'not readable'} -> using balance-sheet total`);
    }
  }
  for (const yr of [fy, pfy]) result.totals[yr] = result.borrowing[yr].reduce((a, r) => a + r.value, 0);

  // Investments (current-year column only: the note shows each year as its own table)
  const inv = stmt.investments;
  if (inv) {
    const at = findNote(pages, range, 'investments', inv.note, inv.page);
    const parsed = at ? readNoteRows(pages, at, 'investments') : { rows: [], total: null };
    const sum = parsed.rows.reduce((a, r) => a + (r.cy || 0), 0);
    const gross = parsed.total ? parsed.total.cy : null;
    if (parsed.rows.length && (close(sum, inv.cy, 0.03) || close(sum, gross, 0.015))) {
      for (const r of parsed.rows) result.investments[fy].push({ label: r.label, category: investmentCategory(r.label), value: r.cy * k, page: r.page });
      log.push(`investments: ${parsed.rows.length} lines from note p.${at.page + 1}`);
    } else {
      log.push(`investments: note ${at ? 'p.' + (at.page + 1) : 'not found'}; breakdown not readable (sum ${sum.toFixed(2)} vs balance sheet ${inv.cy}) -> book size only`);
    }
    result.investment_total = { [fy]: inv.cy * k, [pfy]: inv.py * k };
  }
  if (!['debt_securities', 'borrowings', 'deposits', 'subordinated'].some(k => stmt[k])) {
    result.debug = diagnose(pages, range, 'no borrowing lines found on the standalone balance sheet');
  } else if (log.some(l => /not readable|sums to|not found/.test(l))) {
    // breakdown problems: show the balance sheet and the note pages it used
    const notePages = [...new Set(log.map(l => (l.match(/note p\.(\d+)/) || [])[1]).filter(Boolean).map(Number))];
    result.debug = diagnose(pages, range, 'breakdown problems: ' + log.filter(l => /not readable|sums to|not found/.test(l)).join(' | '))
      + notePages.map(n => `\n===== note page ${n} =====\n` + (pages[n - 1] || []).slice(0, 160).join('\n')).join('');
  }
  return result;
}
const labelOf = k => ({ debt_securities: 'Debt securities', borrowings: 'Borrowings (other than debt securities)', deposits: 'Deposits', subordinated: 'Subordinated liabilities' }[k]);

module.exports = { pdfToPages, splitLine, parseAmount, detectUnit, findStandaloneRange, detectYear,
  readStatementItems, findNote, readNoteRows, borrowingCategory, investmentCategory, extractReport };
