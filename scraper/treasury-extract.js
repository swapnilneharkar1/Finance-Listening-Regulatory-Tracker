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

/* ── 1. PDF -> pages of text lines (columns kept apart with wide gaps) ── */
async function pdfToPages(buffer) {
  const pages = [];
  const quiet = console.warn; // pdf.js font warnings are noise
  console.warn = (...a) => { const m = a.join(' '); if (/font|TT:|glyf|Warning/i.test(m)) return; quiet(...a); };
  try {
    await pdfParse(buffer, {
      pagerender: async page => {
        const tc = await page.getTextContent({ normalizeWhitespace: true, disableCombineTextItems: false });
        const rows = [];
        for (const it of tc.items) {
          const s = it.str; if (!s || !s.trim()) continue;
          const x = it.transform[4], y = it.transform[5], w = it.width || s.length * 4;
          let row = rows.find(r => Math.abs(r.y - y) <= 2.5);
          if (!row) { row = { y, items: [] }; rows.push(row); }
          row.items.push({ x, w, s });
        }
        rows.sort((a, b) => b.y - a.y);
        const lines = rows.map(r => {
          r.items.sort((a, b) => a.x - b.x);
          let out = '', end = null;
          for (const it of r.items) {
            if (end != null) { const gap = it.x - end; out += gap > 12 ? '   ' : gap > 1.5 ? ' ' : ''; }
            out += it.s; end = it.x + it.w;
          }
          return out.replace(/\s+$/, '');
        });
        pages.push(lines);
        return lines.join('\n');
      },
    });
  } finally { console.warn = quiet; }
  return pages; // pages[i] = array of lines, page number = i + 1
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

function findStandaloneRange(pages) {
  const isBS = p => pages[p].slice(0, 15).some(l => /balance\s*sheet\s*as\s*(at|on)/i.test(l));
  const isConsol = p => pages[p].slice(0, 15).some(l => /consolidated/i.test(l) && /(balance\s*sheet|financial\s*statements|profit)/i.test(l));
  const hasLiabs = p => pages[p].some(l => /debt\s*securities/i.test(l)) && pages[p].some(l => /total\s*(equity\s*and\s*)?liabilities|total\s*liabilities\s*and\s*equity/i.test(l));
  let start = -1;
  for (let p = 0; p < pages.length; p++) if (isBS(p) && hasLiabs(p) && !isConsol(p)) { start = p; break; }
  if (start < 0) for (let p = 0; p < pages.length; p++) if (hasLiabs(p) && !isConsol(p)) { start = p; break; }
  if (start < 0) return null;
  let end = pages.length;
  for (let p = start + 1; p < pages.length; p++) if (isConsol(p) && (isBS(p) || hasLiabs(p))) { end = p; break; }
  return { start, end };
}

/** Year-end of the current-year column, e.g. "As at 31 March 2025" -> 2025. */
function detectYear(lines) {
  for (const l of lines.slice(0, 25)) {
    const m = l.match(/(?:31(?:st)?\s*march,?\s*|march\s*31,?\s*)(20\d{2})/i) || l.match(/31[.\-/]0?3[.\-/](20\d{2})/);
    if (m) return +m[1];
  }
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
  const refRe = noteRef ? new RegExp(`^(note\\s*(no\\.?)?\\s*)?${noteRef.replace('.', '\\.')}\\s*[.:)-]?\\s+`, 'i') : null;
  let best = null;
  for (let p = Math.max(range.start, afterPage || 0); p < range.end; p++) {
    for (let i = 0; i < pages[p].length; i++) {
      const raw = pages[p][i].trim();
      if (splitLine(raw).amounts.length) continue;         // headings carry no figures
      const stripped = raw.replace(/^(note\s*(no\.?)?\s*)?\d{1,2}(\.\d{1,2})?\s*[.:)-]?\s*/i, '');
      if (!title.test(norm(stripped)) || norm(stripped).length > 60) continue;
      if (/movement|maturity|repayment|terms|reconciliation|disclosure/i.test(stripped)) continue;
      const score = (refRe && refRe.test(raw) ? 2 : 0) + (/^(note\s*)?\d/i.test(raw) ? 1 : 0);
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
      if (/^total\b/i.test(label) || /^(sub[- ]?total)$/i.test(label)) {
        if (/sub/i.test(label)) continue;
        total = { cy: sp.amounts[sp.amounts.length - (key === 'investments' ? 1 : 2)], py: key === 'investments' ? null : sp.amounts[sp.amounts.length - 1], page: p + 1 };
        return { rows, total };
      }
      if (/^less\b|impairment|allowance|provision/i.test(label)) continue;
      if (/\b(as at|as on|year ended|particulars|amortised|fvoci|fvtpl|fair value)\b/i.test(label) || /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(label)) continue;
      if (/in india|outside india|^\(?[ab]\)?$/i.test(low)) continue;
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
function borrowingCategory(label, secured, section) {
  const s = label.toLowerCase();
  if (section === 'subordinated' || /subordinat|perpetual|tier\s*ii/.test(s)) return 'Subordinated debt';
  if (section === 'deposits' || /deposit/.test(s) && !/certificate/.test(s)) return 'Deposits';
  if (/external commercial bond|senior secured note|offshore|masala|foreign currency bond|u\.?s\.? dollar/.test(s)) return 'ECB bonds';
  if (/external commercial borrowing|\becb\b/.test(s)) return 'ECB loans';
  if (/commercial paper/.test(s)) return 'Commercial paper';
  if (/securiti[sz](ation|ed)|pass through|\bptcs?\b/.test(s)) return 'Securitisation';
  if (/debenture|ncd|bond/.test(s)) return (secured === false || /unsecured/.test(s)) ? 'Unsecured NCDs' : 'Secured NCDs';
  if (/national housing bank|\bnhb\b|refinance|financial institution|sidbi|nabard|mudra/.test(s)) return 'FI & NHB loans';
  if (/cash credit|working capital|wcdl|overdraft|demand loan/.test(s)) return 'Cash credit & WCDL';
  if (/\brepo\b|repurchase|treps|cblo|csgl|tri-?party|collateralised/.test(s)) return 'Repo, TREPS & CBLO';
  if (/term loan|from banks?|bank loan/.test(s)) return 'Bank term loans';
  if (section === 'debt_securities') return secured === false ? 'Unsecured NCDs' : 'Secured NCDs';
  return 'Other borrowings';
}
function investmentCategory(label) {
  const s = label.toLowerCase();
  if (/interest accrued|electoral/.test(s)) return 'Other investments';
  if (/treasury bill|\bt-?bills?\b/.test(s)) return 'Treasury bills';
  if (/strips/.test(s)) return 'STRIPS';
  if (/government sec|\bg-?secs?\b|state development loan|\bsdl\b/.test(s)) return 'Government securities';
  if (/mutual fund/.test(s)) return 'Mutual funds';
  if (/certificates? of deposit/.test(s)) return 'Certificates of deposit';
  if (/commercial paper/.test(s)) return 'Commercial paper';
  if (/pass through|\bptcs?\b|securitised/.test(s)) return 'PTCs';
  if (/subsidiar|associate|joint venture/.test(s)) return 'Subsidiaries, associates & JVs';
  if (/treps|tri-?party|\brepo\b/.test(s)) return 'TREPS & repo';
  if (/fixed deposit|term deposit/.test(s)) return 'Fixed deposits';
  if (/equity|preference|ccps|shares/.test(s)) return 'Equity';
  if (/bond|ncd|debenture|debt securit/.test(s)) return 'Bonds & NCDs';
  return 'Other investments';
}

const close = (a, b, tol = 0.015) => a != null && b != null && Math.abs(a - b) <= Math.max(1, Math.abs(b) * tol);

/* ── 8. Whole report ── */
async function extractReport(buffer, { fyHint } = {}) {
  const pages = await pdfToPages(buffer);
  const log = [];
  const range = findStandaloneRange(pages);
  if (!range) return { ok: false, error: 'Standalone balance sheet not found', pages: pages.length };
  const bsLines = pages[range.start];
  const unit = detectUnit(pages.slice(range.start, range.start + 2).flat());
  const year = detectYear(bsLines) || (fyHint ? 2000 + +String(fyHint).slice(2) : null);
  if (!year) return { ok: false, error: 'Could not read the balance-sheet date', pages: pages.length };
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
      log.push(`investments: breakdown not readable (sum ${sum.toFixed(2)} vs balance sheet ${inv.cy}) -> book size only`);
    }
    result.investment_total = { [fy]: inv.cy * k, [pfy]: inv.py * k };
  }
  return result;
}
const labelOf = k => ({ debt_securities: 'Debt securities', borrowings: 'Borrowings (other than debt securities)', deposits: 'Deposits', subordinated: 'Subordinated liabilities' }[k]);

module.exports = { pdfToPages, splitLine, parseAmount, detectUnit, findStandaloneRange, detectYear,
  readStatementItems, findNote, readNoteRows, borrowingCategory, investmentCategory, extractReport };
