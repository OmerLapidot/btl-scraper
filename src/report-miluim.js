// src/report-miluim.js
//
// Standalone post-processor for the reserve-duty (מילואים) section.
//
// Reads a miluim.json file (the raw output of the `miluim` section, i.e. the
// response of POST api/MiluimApi/BerurMiluim), runs a VALIDATED computation over
// its `.Info` object, and writes two artifacts next to the source file:
//   - miluim-report.json   (the structured, machine-readable summary)
//   - דוח-מילואים.md        (a clean, human-readable Hebrew/RTL report)
//
// This module is purely a post-processor: it performs NO network access and
// never mutates the source data. It can run after `scrape.js`, or on its own
// against any previously-saved miluim.json.
//
// Public API:
//   generateMiluimReport(info)  -> structured report object.
//       `info` may be either the raw miluim.json object (in which case `.Info`
//       is read off it) or the `.Info` object directly.
//
// CLI:
//   node src/report-miluim.js [path-to-miluim.json]
//       Default path: <project-root>/out/miluim.json
//       Writes <outDir>/miluim-report.json and <outDir>/דוח-מילואים.md
//       where <outDir> is the directory of the source file.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ---------------------------------------------------------------------------
// Number parsing (VALIDATED — confirmed correct against real data).
//
// BTL serves money/amount fields as strings that may contain thousands
// separators and a TRAILING minus sign (e.g. "1,234.50-"). This normaliser
// strips commas, handles the trailing-minus convention, and returns 0 for
// anything empty/unparseable.
// ---------------------------------------------------------------------------
const n = s => {
  if (s == null) return 0;
  s = ('' + s).replace(/,/g, '').trim();
  if (s === '') return 0;
  let neg = false;
  if (s.endsWith('-')) { neg = true; s = s.slice(0, -1); }
  let v = parseFloat(s);
  if (isNaN(v)) return 0;
  return neg ? -v : v;
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

// Round to an integer for display/storage (all money is rounded to integers).
const r = x => Math.round(x || 0);

// Safe array accessor: returns [] for null/undefined/non-array values.
const arr = x => (Array.isArray(x) ? x : []);

// Format an integer with thousands separators (for the markdown report).
const fmt = x => r(x).toLocaleString('en-US');

/**
 * Parse a "DD/MM/YYYY" date string into a UTC Date (midnight), or null.
 * Used both for day-range expansion and for sorting/labelling.
 */
function parseDMY(s) {
  if (!s) return null;
  const m = ('' + s).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const day = Number(m[1]), mon = Number(m[2]), year = Number(m[3]);
  if (!year || !mon || !day) return null;
  const d = new Date(Date.UTC(year, mon - 1, day));
  // Guard against overflow (e.g. 31/02) producing a shifted date.
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== mon - 1 || d.getUTCDate() !== day) {
    return null;
  }
  return d;
}

// Canonical "YYYY-MM-DD" key for a UTC Date (used as the Set element per day).
function dayKey(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

// Convert a "YYYY-MM-DD" key to the Israeli display form "DD/MM/YYYY".
function keyToDisplay(key) {
  if (!key) return '';
  const [y, m, d] = key.split('-');
  return `${d}/${m}/${y}`;
}

/**
 * Add every unique calendar day in [startKey..endKey] (inclusive) into `set`.
 * Inputs are UTC Dates; if either is missing nothing is added. If end precedes
 * start the single start day is still recorded (defensive).
 */
function addRange(set, start, end, perYear) {
  if (!start) return;
  const last = end && end >= start ? end : start;
  const cur = new Date(start.getTime());
  // Hard cap to avoid runaway loops on bad data (10 years of days).
  let guard = 0;
  while (cur <= last && guard < 3660) {
    const key = dayKey(cur);
    if (!set.has(key)) {
      set.add(key);
      const yr = cur.getUTCFullYear();
      perYear[yr] = (perYear[yr] || 0) + 1;
    }
    cur.setUTCDate(cur.getUTCDate() + 1);
    guard++;
  }
}

// ---------------------------------------------------------------------------
// Core report computation (VALIDATED algorithm).
// ---------------------------------------------------------------------------

/**
 * Build the structured miluim report from the `.Info` object.
 *
 * Accepts either the whole miluim.json object (reads `.Info`) or the `.Info`
 * object itself.
 *
 * @param {object} info  miluim.json or its `.Info` sub-object.
 * @returns {object} structured report (see fields below).
 */
export function generateMiluimReport(info) {
  if (!info || typeof info !== 'object') {
    throw new Error('generateMiluimReport: expected an object (miluim.json or its .Info)');
  }
  // Accept either the whole file or the .Info object directly.
  if (info.Info && typeof info.Info === 'object') info = info.Info;

  // -- recipients.you -------------------------------------------------------
  // Sum TagmulKolel (base) and TosefetAtzmai (self-employed supplement) over
  // every personal claim period.
  let youBase = 0;        // TagmulKolel
  let youSelfEmp = 0;     // TosefetAtzmai
  for (const tvia of arr(info?.TabTviotIshiyot?.TviotTbl)) {
    for (const tk of arr(tvia?.TkufotIshiyot)) {
      youBase += n(tk?.TagmulKolel);
      youSelfEmp += n(tk?.TosefetAtzmai);
    }
  }

  // -- employers ------------------------------------------------------------
  // Sum Tagmul per employer (keyed by ShemMaasik) across all employer periods.
  const employersMap = new Map(); // name -> base tagmul
  for (const tvia of arr(info?.TabTviotMaasik?.TviotMaasikTbl)) {
    for (const tk of arr(tvia?.TkufotMaasik)) {
      const name = (tk?.ShemMaasik || tvia?.ShemMaasik || 'מעסיק').trim();
      employersMap.set(name, (employersMap.get(name) || 0) + n(tk?.Tagmul));
    }
  }

  // -- tosefet40 (the 40% addition) ----------------------------------------
  // Over every 40%-addition row: sum Schum40Ahuz; split by ShulamLe — rows paid
  // "לך" (to you) go to `you`, otherwise to the named employer (after stripping
  // the "למעסיק: " prefix).
  //
  // CONFIRMED: Schum40Ahuz == 0.40 * TagmulLeYom * MisYamim, i.e. TagmulLeYom is
  // the BASE daily tagmul and the 40% is ON TOP of it.
  let you40 = 0;
  const employer40Map = new Map(); // name -> 40% amount
  const dailyRatesByPeriod = [];   // { start, end, days, dailyBaseRate, fullDailyRate, paidTo, tosefet40 }

  for (const row of arr(info?.TabTosefet40Ahuz?.Tkufot40AhuzTbl)) {
    const amount40 = n(row?.Schum40Ahuz);
    const shulamLe = (row?.ShulamLe || '').trim();

    let paidTo;
    if (/לך/.test(shulamLe)) {
      you40 += amount40;
      paidTo = 'לך';
    } else {
      const empName = shulamLe.replace(/^למעסיק:\s*/, '').trim() || 'מעסיק';
      employer40Map.set(empName, (employer40Map.get(empName) || 0) + amount40);
      paidTo = empName;
    }

    // Daily-rate detail. TagmulLeYom is the BASE daily tagmul; the full daily
    // value is rate * 1.4 (base + 40%), before any self-employed supplement.
    const dailyBase = n(row?.TagmulLeYom);
    const days = n(row?.MisYamim);
    dailyRatesByPeriod.push({
      start: row?.SherutStart || '',
      end: row?.SherutEnds || '',
      days: r(days),
      dailyBaseRate: r(dailyBase),
      fullDailyRate: r(dailyBase * 1.4), // base + 40% (excludes self-employed supplement)
      tosefet40: r(amount40),
      paidTo,
    });
  }

  // -- recipients (assembled) ----------------------------------------------
  // `you`: base = TagmulKolel; the 40% comes from tosefet40 rows paid "לך";
  //        total = base + 40% + self-employed supplement (TosefetAtzmai).
  const youTotal = youBase + you40 + youSelfEmp;
  const recipients = {
    you: {
      name: 'מבוטח (לך)',
      base: r(youBase),
      selfEmployedSupplement: r(youSelfEmp),
      tosefet40: r(you40),
      total: r(youTotal),
    },
    employers: [],
  };

  // Each employer: base = Tagmul; tosefet40 = its share of the 40% rows.
  const employerNames = new Set([...employersMap.keys(), ...employer40Map.keys()]);
  for (const name of employerNames) {
    const base = employersMap.get(name) || 0;
    const t40 = employer40Map.get(name) || 0;
    recipients.employers.push({
      name,
      base: r(base),
      tosefet40: r(t40),
      total: r(base + t40),
    });
  }
  // Stable, descending-by-total ordering for readability.
  recipients.employers.sort((a, b) => b.total - a.total);

  // Headline 40% total (across you + all employers).
  const total40 = you40 + [...employer40Map.values()].reduce((s, v) => s + v, 0);

  // -- actualPayments -------------------------------------------------------
  // The actual cash that reached YOU: net (ScmTashlum), gross/entitlement
  // (ScmZakaut) and deductions (ScmNikuyim), plus the per-payment list.
  let payNet = 0, payGross = 0, payDeductions = 0;
  const payments = [];
  for (const k of arr(info?.TabTashlumim?.KaspitTbl)) {
    const net = n(k?.ScmTashlum);
    const gross = n(k?.ScmZakaut);
    const deductions = n(k?.ScmNikuyim);
    payNet += net;
    payGross += gross;
    payDeductions += deductions;
    payments.push({
      date: k?.TarTashlum || '',
      net: r(net),
      entitlement: r(gross),
      deductions: r(deductions),
    });
  }
  // Sort payments chronologically (oldest first) when dates are parseable.
  payments.sort((a, b) => {
    const da = parseDMY(a.date), db = parseDMY(b.date);
    if (da && db) return da - db;
    return 0;
  });

  const actualPayments = {
    gross: r(payGross),       // total entitlement (זכאות)
    deductions: r(payDeductions),
    net: r(payNet),           // cash actually paid to you (תשלום)
    payments,
  };

  // -- daysSummary ----------------------------------------------------------
  // Expand every period date-range from ALL period-bearing tabs into a Set of
  // unique calendar days, then derive totals/extents/per-year counts.
  const daySet = new Set();
  const byYear = {};

  // TabTosefet40Ahuz: SherutStart / SherutEnds (DD/MM/YYYY).
  for (const row of arr(info?.TabTosefet40Ahuz?.Tkufot40AhuzTbl)) {
    addRange(daySet, parseDMY(row?.SherutStart), parseDMY(row?.SherutEnds), byYear);
  }

  // TabTkufotIdf: TarStartMil / TarEndMil (DD/MM/YYYY).
  for (const row of arr(info?.TabTkufotIdf?.TkufotIdfTbl)) {
    addRange(daySet, parseDMY(row?.TarStartMil), parseDMY(row?.TarEndMil), byYear);
  }

  // TabTviotIshiyot / TabTviotMaasik: each period carries a "Tkufa" string of
  // the form "DD/MM/YYYY - DD/MM/YYYY".
  const tkufaRanges = [];
  for (const tvia of arr(info?.TabTviotIshiyot?.TviotTbl)) {
    for (const tk of arr(tvia?.TkufotIshiyot)) tkufaRanges.push(tk?.Tkufa);
  }
  for (const tvia of arr(info?.TabTviotMaasik?.TviotMaasikTbl)) {
    for (const tk of arr(tvia?.TkufotMaasik)) tkufaRanges.push(tk?.Tkufa);
  }
  for (const tkufa of tkufaRanges) {
    if (!tkufa) continue;
    const parts = ('' + tkufa).split('-').map(s => s.trim());
    const s = parseDMY(parts[0]);
    const e = parts.length > 1 ? parseDMY(parts[1]) : s;
    addRange(daySet, s, e || s, byYear);
  }

  // Derive ordered keys -> first/last day and a sorted by-year map.
  const sortedKeys = [...daySet].sort();
  const firstDay = sortedKeys.length ? keyToDisplay(sortedKeys[0]) : null;
  const lastDay = sortedKeys.length ? keyToDisplay(sortedKeys[sortedKeys.length - 1]) : null;
  const byYearSorted = {};
  for (const y of Object.keys(byYear).sort()) byYearSorted[y] = byYear[y];

  const daysSummary = {
    totalUniqueDays: daySet.size,
    firstDay,
    lastDay,
    byYear: byYearSorted,
  };

  // -- pendingPeriods -------------------------------------------------------
  // Reserve-duty periods that are RECORDED but NOT yet paid. Two signals:
  //   (a) TabTkufotIdf rows with IsTkufatMilPaid !== 1 — an IDF service period
  //       awaiting payment (authoritative paid/unpaid flag), and
  //   (b) TabTviotIshiyot claim periods whose StatusTvia is "בטיפול" — a claim
  //       still in processing.
  // Deduped by date range; sorted newest-first.
  const pendingMap = new Map();
  for (const row of arr(info?.TabTkufotIdf?.TkufotIdfTbl)) {
    if (Number(row?.IsTkufatMilPaid) === 1) continue; // already paid
    const start = (row?.TarStartMil || '').trim();
    if (!start) continue;
    const end = (row?.TarEndMil || '').trim() || start;
    pendingMap.set(`${start}|${end}`, {
      start, end,
      days: r(n(row?.SachYamimMil)),
      sugSherut: (row?.SugSherut || '').trim(),
      reportedOn: (row?.TarDivuach || '').trim(),
      status: 'טרם שולם',
    });
  }
  for (const tvia of arr(info?.TabTviotIshiyot?.TviotTbl)) {
    for (const tk of arr(tvia?.TkufotIshiyot)) {
      if (!/בטיפול/.test(tk?.StatusTvia || '')) continue;
      const parts = ('' + (tk?.Tkufa || '')).split('-').map(s => s.trim());
      const start = parts[0] || '';
      if (!start) continue;
      const end = parts[1] || start;
      const key = `${start}|${end}`;
      if (!pendingMap.has(key)) {
        pendingMap.set(key, {
          start, end,
          days: r(n(tk?.MisYamim)),
          sugSherut: '',
          reportedOn: '',
          status: (tk?.StatusTvia || 'בטיפול').trim(),
        });
      }
    }
  }
  const pendingPeriods = [...pendingMap.values()].sort((a, b) => {
    const da = parseDMY(a.start), db = parseDMY(b.start);
    return (db ? db.getTime() : 0) - (da ? da.getTime() : 0);
  });

  // -- assembled report -----------------------------------------------------
  return {
    generatedAt: new Date().toISOString(),
    daysSummary,
    recipients,
    total40: r(total40),
    actualPayments,
    dailyRatesByPeriod,
    pendingPeriods,
  };
}

// ---------------------------------------------------------------------------
// Markdown rendering (Hebrew / RTL).
// ---------------------------------------------------------------------------

/**
 * Render the structured report as a clean Hebrew markdown document.
 * All money values are rounded to integers (already done in the report).
 *
 * @param {object} report  output of generateMiluimReport().
 * @returns {string} markdown text.
 */
function renderMarkdown(report) {
  const L = []; // lines
  const push = (s = '') => L.push(s);

  const { daysSummary, recipients, total40, actualPayments, dailyRatesByPeriod, pendingPeriods } = report;

  push('# דוח מילואים — ביטוח לאומי');
  push('');
  push('> דוח מסכם המופק אוטומטית מנתוני הפורטל האישי של הביטוח הלאומי.');
  push('> כל הסכומים מעוגלים לשקלים שלמים (₪).');
  push('');

  // --- 1. סך ימי המילואים -------------------------------------------------
  push('## סך ימי המילואים');
  push('');
  push(`**סך הכל ימים (ייחודיים):** ${fmt(daysSummary.totalUniqueDays)}`);
  if (daysSummary.firstDay && daysSummary.lastDay) {
    push('');
    push(`טווח התאריכים: ${daysSummary.firstDay} – ${daysSummary.lastDay}`);
  }
  push('');
  const years = Object.keys(daysSummary.byYear);
  if (years.length) {
    push('| שנה | מספר ימים |');
    push('| --- | --- |');
    for (const y of years) push(`| ${y} | ${fmt(daysSummary.byYear[y])} |`);
  } else {
    push('_לא נמצאו תקופות שירות._');
  }
  push('');

  // --- 2. תגמולים לפי מקבל --------------------------------------------------
  push('## תגמולים לפי מקבל');
  push('');
  push('פירוט הזכאות לפי מקבל התשלום — בסיס (תגמול בסיסי), תוספת 40%, וסך הכל.');
  push('');
  push('| מקבל | בסיס | תוספת 40% | סך הכל |');
  push('| --- | ---: | ---: | ---: |');

  // The insured (you). Show the self-employed supplement inline when present.
  const you = recipients.you;
  const youBaseCell = you.selfEmployedSupplement
    ? `${fmt(you.base)} (+${fmt(you.selfEmployedSupplement)} תוספת עצמאי)`
    : `${fmt(you.base)}`;
  push(`| ${you.name} | ${youBaseCell} | ${fmt(you.tosefet40)} | ${fmt(you.total)} |`);

  for (const emp of recipients.employers) {
    push(`| ${emp.name} | ${fmt(emp.base)} | ${fmt(emp.tosefet40)} | ${fmt(emp.total)} |`);
  }
  push('');
  if (you.selfEmployedSupplement) {
    push(`> מתוך הסכום שלך, ${fmt(you.selfEmployedSupplement)} ₪ הם תוספת לעצמאי (TosefetAtzmai), `);
    push('> מעבר לתגמול הבסיסי ולתוספת ה‑40%.');
    push('');
  }

  // --- 3. כותרת תוספת 40% --------------------------------------------------
  push('## תוספת ה‑40% (כותרת)');
  push('');
  push(`**סך תוספת ה‑40% (לכל המקבלים):** ${fmt(total40)} ₪`);
  push('');
  push('תוספת ה‑40% משולמת **מעל** התגמול הבסיסי (40% נוספים על הבסיס).');
  push('');

  // --- 4. מזומן בפועל אליך -------------------------------------------------
  push('## תשלום בפועל אליך (מזומן)');
  push('');
  push('הסכומים שהועברו אליך בפועל מהביטוח הלאומי:');
  push('');
  push('| רכיב | סכום (₪) |');
  push('| --- | ---: |');
  push(`| זכאות (ברוטו) | ${fmt(actualPayments.gross)} |`);
  push(`| ניכויים | ${fmt(actualPayments.deductions)} |`);
  push(`| **תשלום נטו (לתשלום בפועל)** | **${fmt(actualPayments.net)}** |`);
  push('');

  if (actualPayments.payments.length) {
    push('### פירוט התשלומים');
    push('');
    push('| תאריך | זכאות (ברוטו) | ניכויים | נטו |');
    push('| --- | ---: | ---: | ---: |');
    for (const p of actualPayments.payments) {
      push(`| ${p.date || '—'} | ${fmt(p.entitlement)} | ${fmt(p.deductions)} | ${fmt(p.net)} |`);
    }
    push('');
  } else {
    push('_לא נמצאו תשלומים._');
    push('');
  }

  // --- 5. תעריף יומי לפי תקופה ----------------------------------------------
  push('## תעריף יומי לפי תקופה');
  push('');
  push('> **שימו לב:** התעריף היומי המוצג בעמודת "תעריף בסיס ליום" הוא **הבסיס בלבד**.');
  push('> התגמול היומי המלא = תעריף הבסיס × 1.4 (כלומר בסיס + 40%),');
  push('> ובנוסף לכך מתווספת תוספת לעצמאי (אם רלוונטי). לכן הסכום שמתקבל בפועל ליום');
  push('> גבוה מתעריף הבסיס המוצג כאן.');
  push('');
  if (dailyRatesByPeriod.length) {
    push('| תקופת שירות | ימים | תעריף בסיס ליום | תגמול יומי מלא (×1.4) | תוספת 40% | שולם ל־ |');
    push('| --- | ---: | ---: | ---: | ---: | --- |');
    for (const d of dailyRatesByPeriod) {
      const range = d.start && d.end ? `${d.start} – ${d.end}` : (d.start || d.end || '—');
      push(`| ${range} | ${fmt(d.days)} | ${fmt(d.dailyBaseRate)} | ${fmt(d.fullDailyRate)} | ${fmt(d.tosefet40)} | ${d.paidTo} |`);
    }
    push('');
  } else {
    push('_לא נמצאו תקופות עם תעריף יומי._');
    push('');
  }

  // --- 6. תקופות שטרם שולמו / בטיפול ---------------------------------------
  push('## תקופות שטרם שולמו / בטיפול');
  push('');
  if (arr(pendingPeriods).length) {
    const pendDays = pendingPeriods.reduce((s, p) => s + (p.days || 0), 0);
    push(`**${pendingPeriods.length} תקופות (${fmt(pendDays)} ימים)** רשומות אך טרם שולמו / נמצאות בטיפול.`);
    push('');
    push('| תקופה | ימים | סוג שירות | סטטוס | דווח |');
    push('| --- | ---: | --- | --- | --- |');
    for (const p of pendingPeriods) {
      const range = p.end && p.end !== p.start ? `${p.start} – ${p.end}` : (p.start || '—');
      push(`| ${range} | ${fmt(p.days)} | ${p.sugSherut || '—'} | ${p.status} | ${p.reportedOn || '—'} |`);
    }
    push('');
  } else {
    push('_כל התקופות שולמו._');
    push('');
  }

  push('---');
  push('');
  push(`_הופק אוטומטית בתאריך ${new Date(report.generatedAt).toLocaleString('he-IL')}._`);
  push('');

  return L.join('\n');
}

// ---------------------------------------------------------------------------
// CLI entry point.
// ---------------------------------------------------------------------------

/**
 * Resolve the default miluim.json path: <project-root>/out/miluim.json.
 * env.js lives in src/, so the project root is one level up from this file.
 */
function defaultMiluimPath() {
  const here = path.dirname(fileURLToPath(import.meta.url)); // .../src
  const projectRoot = path.resolve(here, '..');
  return path.join(projectRoot, 'out', 'miluim.json');
}

function main() {
  const log = console.error; // stdout is reserved for data / explicit output.

  const inputPath = process.argv[2]
    ? path.resolve(process.argv[2])
    : defaultMiluimPath();

  if (!fs.existsSync(inputPath)) {
    log(`ERROR: miluim.json not found at: ${inputPath}`);
    log('Run the scraper first (npm run scrape) or pass a path: node src/report-miluim.js <path-to-miluim.json>');
    process.exit(1);
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  } catch (e) {
    log(`ERROR: failed to parse JSON at ${inputPath}: ${e.message}`);
    process.exit(1);
  }

  // The raw file is the BerurMiluim response; the data lives under `.Info`.
  // generateMiluimReport accepts either the whole object or `.Info`.
  let report;
  try {
    report = generateMiluimReport(raw);
  } catch (e) {
    log(`ERROR: failed to build the miluim report: ${e.message}`);
    process.exit(1);
  }

  const outDir = path.dirname(inputPath);
  const jsonOut = path.join(outDir, 'miluim-report.json');
  const mdOut = path.join(outDir, 'דוח-מילואים.md');

  try {
    fs.writeFileSync(jsonOut, JSON.stringify(report, null, 2), 'utf8');
    fs.writeFileSync(mdOut, renderMarkdown(report), 'utf8');
  } catch (e) {
    log(`ERROR: failed to write report files: ${e.message}`);
    process.exit(1);
  }

  // Brief human-readable summary to stderr.
  log('Miluim report generated:');
  log(`  source : ${inputPath}`);
  log(`  json   : ${jsonOut}`);
  log(`  md     : ${mdOut}`);
  log(`  days   : ${report.daysSummary.totalUniqueDays} unique`
    + (report.daysSummary.firstDay ? ` (${report.daysSummary.firstDay} – ${report.daysSummary.lastDay})` : ''));
  log(`  40%    : ${report.total40}`);
  log(`  net→you: ${report.actualPayments.net}`);
}

// Run the CLI only when invoked directly (not when imported).
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main();
}
