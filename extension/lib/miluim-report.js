// lib/miluim-report.js
//
// VERBATIM port of src/report-miluim.js `generateMiluimReport` (+ its helpers)
// from the Node scraper, so the extension's miluim section is computed by the
// exact same VALIDATED algorithm. Pure JS — no Node APIs, no network, no mutation.
// Takes the raw BerurMiluim response (or its `.Info`) and returns the structured
// report consumed by the dashboard.

// Number parsing: BTL serves amounts as strings with thousands separators and a
// TRAILING minus (e.g. "1,234.50-"). Strip commas, handle trailing minus.
const n = (s) => {
  if (s == null) return 0;
  s = ('' + s).replace(/,/g, '').trim();
  if (s === '') return 0;
  let neg = false;
  if (s.endsWith('-')) { neg = true; s = s.slice(0, -1); }
  let v = parseFloat(s);
  if (isNaN(v)) return 0;
  return neg ? -v : v;
};

const r = (x) => Math.round(x || 0);
const arr = (x) => (Array.isArray(x) ? x : []);

function parseDMY(s) {
  if (!s) return null;
  const m = ('' + s).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const day = Number(m[1]), mon = Number(m[2]), year = Number(m[3]);
  if (!year || !mon || !day) return null;
  const d = new Date(Date.UTC(year, mon - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== mon - 1 || d.getUTCDate() !== day) {
    return null;
  }
  return d;
}

function dayKey(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function keyToDisplay(key) {
  if (!key) return '';
  const [y, m, d] = key.split('-');
  return `${d}/${m}/${y}`;
}

function addRange(set, start, end, perYear) {
  if (!start) return;
  const last = end && end >= start ? end : start;
  const cur = new Date(start.getTime());
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

/**
 * Build the structured miluim report from the `.Info` object.
 * Accepts either the whole miluim.json object (reads `.Info`) or `.Info` itself.
 */
export function generateMiluimReport(info) {
  if (!info || typeof info !== 'object') {
    throw new Error('generateMiluimReport: expected an object (miluim.json or its .Info)');
  }
  if (info.Info && typeof info.Info === 'object') info = info.Info;

  // -- recipients.you --
  let youBase = 0;
  let youSelfEmp = 0;
  for (const tvia of arr(info?.TabTviotIshiyot?.TviotTbl)) {
    for (const tk of arr(tvia?.TkufotIshiyot)) {
      youBase += n(tk?.TagmulKolel);
      youSelfEmp += n(tk?.TosefetAtzmai);
    }
  }

  // -- employers --
  const employersMap = new Map();
  for (const tvia of arr(info?.TabTviotMaasik?.TviotMaasikTbl)) {
    for (const tk of arr(tvia?.TkufotMaasik)) {
      const name = (tk?.ShemMaasik || tvia?.ShemMaasik || 'מעסיק').trim();
      employersMap.set(name, (employersMap.get(name) || 0) + n(tk?.Tagmul));
    }
  }

  // -- tosefet40 --
  let you40 = 0;
  const employer40Map = new Map();
  const dailyRatesByPeriod = [];

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

    const dailyBase = n(row?.TagmulLeYom);
    const days = n(row?.MisYamim);
    dailyRatesByPeriod.push({
      start: row?.SherutStart || '',
      end: row?.SherutEnds || '',
      days: r(days),
      dailyBaseRate: r(dailyBase),
      fullDailyRate: r(dailyBase * 1.4),
      tosefet40: r(amount40),
      paidTo,
    });
  }

  // -- recipients (assembled) --
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
  recipients.employers.sort((a, b) => b.total - a.total);

  const total40 = you40 + [...employer40Map.values()].reduce((s, v) => s + v, 0);

  // -- actualPayments --
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
  payments.sort((a, b) => {
    const da = parseDMY(a.date), db = parseDMY(b.date);
    if (da && db) return da - db;
    return 0;
  });

  const actualPayments = {
    gross: r(payGross),
    deductions: r(payDeductions),
    net: r(payNet),
    payments,
  };

  // -- daysSummary --
  const daySet = new Set();
  const byYear = {};

  for (const row of arr(info?.TabTosefet40Ahuz?.Tkufot40AhuzTbl)) {
    addRange(daySet, parseDMY(row?.SherutStart), parseDMY(row?.SherutEnds), byYear);
  }
  for (const row of arr(info?.TabTkufotIdf?.TkufotIdfTbl)) {
    addRange(daySet, parseDMY(row?.TarStartMil), parseDMY(row?.TarEndMil), byYear);
  }

  const tkufaRanges = [];
  for (const tvia of arr(info?.TabTviotIshiyot?.TviotTbl)) {
    for (const tk of arr(tvia?.TkufotIshiyot)) tkufaRanges.push(tk?.Tkufa);
  }
  for (const tvia of arr(info?.TabTviotMaasik?.TviotMaasikTbl)) {
    for (const tk of arr(tvia?.TkufotMaasik)) tkufaRanges.push(tk?.Tkufa);
  }
  for (const tkufa of tkufaRanges) {
    if (!tkufa) continue;
    const parts = ('' + tkufa).split('-').map((s) => s.trim());
    const s = parseDMY(parts[0]);
    const e = parts.length > 1 ? parseDMY(parts[1]) : s;
    addRange(daySet, s, e || s, byYear);
  }

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

  // -- pendingPeriods --
  const pendingMap = new Map();
  for (const row of arr(info?.TabTkufotIdf?.TkufotIdfTbl)) {
    if (Number(row?.IsTkufatMilPaid) === 1) continue;
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
      const parts = ('' + (tk?.Tkufa || '')).split('-').map((s) => s.trim());
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
