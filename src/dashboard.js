// src/dashboard.js
//
// Builds a self-contained, RTL Hebrew dashboard (out/dashboard.html) from the
// scraped JSON in out/. Read-only: it only reads local files. The output embeds
// everything inline so it opens straight from disk (file://) with no server.
//
// Design: light & happy. Focus on what matters — a clear "do I have debts"
// verdict, the miluim per-period table (latest 5 + "show more"), and mail +
// previous-inquiries tables.

import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, '..', 'out');

const readJson = async (rel) => {
  try { return JSON.parse(await fs.readFile(path.join(OUT, rel), 'utf8')); } catch { return null; }
};

// ---------- formatting ----------
const nf = new Intl.NumberFormat('en-US');
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (n) => `<span class="num" dir="ltr">${nf.format(Math.round(Number(n) || 0))}</span>`;
const dmy = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || ''); return m ? `${m[3]}/${m[2]}/${m[1]}` : String(s || ''); };
const toTime = (s) => { const m = /(\d{2})\/(\d{2})\/(\d{4})/.exec(s || ''); return m ? Date.UTC(+m[3], +m[2] - 1, +m[1]) : 0; };

// ---------- model ----------
async function buildModel() {
  const summary = (await readJson('summary.json')) || {};
  const niHealth = (await readJson('debt-insurance-health.json')) || {};
  const benefits = (await readJson('debt-benefits.json')) || {};
  const collection = ((await readJson('collection-gviya.json')) || {}).Info || {};
  const miluimRaw = ((await readJson('miluim.json')) || {}).Info || {};
  const report = (await readJson('miluim-report.json')) || {};
  const lettersIdx = (await readJson('letters/index.json')) || [];
  const lettersContent = (await readJson('letters/contents.json')) || { letters: [] };
  const inquiries = ((await readJson('previous-inquiries.json')) || {}).Info || {};

  const gimlaotRows = (((benefits.Info || {}).ChovotGimlaotNew || {}).ChovotGimlaotNewTbl) || [];
  const gimlaotTotal = gimlaotRows.reduce((s, r) => s + (Number(r.YtratChovDec) || 0), 0);
  const klali = collection.klaliTab || {};
  const daf = collection.dafCheshbonTab || {};
  const debts = {
    niHealthClear: niHealth.InitialMessageType === 'Success',
    gimlaotTotal, gimlaotStatus: (gimlaotRows[0] || {}).MazavChov || '',
    inArrears: !!((klali.mufar || {}).isMufar),
    balanceDue: !!daf.YtrtChovExst,
    credit: (klali.zchut && klali.zchut.Tpl && klali.zchut.Tpl.schum) || null,
    status: (klali.maamadot || []).map((m) => m.Text).join(' ').replace(/\.$/, ''),
    card: klali.ashrai ? { name: klali.ashrai.shemChevra, suffix: klali.ashrai.suffix, exp: klali.ashrai.tarTokef } : null,
  };
  debts.hasMaterialDebt = !debts.niHealthClear || debts.inArrears || debts.balanceDue || gimlaotTotal > 50;

  const t40 = miluimRaw.TabTosefet40Ahuz || {};
  const rec = report.recipients || { you: {}, employers: [] };
  const employers = (rec.employers || []).filter((e) => (e.total || 0) > 0);
  const ap = report.actualPayments || {};
  const dr = (report.dailyRatesByPeriod || []).slice();

  // Estimate basis for unpaid periods: weighted-average full daily rate over the
  // most recent periods that were paid to YOU.
  const youRates = dr.filter((p) => p.paidTo === 'לך' && p.fullDailyRate > 0)
    .sort((a, b) => toTime(b.start) - toTime(a.start)).slice(0, 12);
  let sd = 0, sr = 0;
  for (const p of youRates) { const dd = Number(p.days) || 0; sd += dd; sr += (p.fullDailyRate || 0) * dd; }
  const estDailyRate = sd ? Math.round(sr / sd) : 0;

  // Pending (reported-but-unpaid) periods, each with an estimated entitlement.
  const pendingPeriods = (report.pendingPeriods || []).slice()
    .sort((a, b) => toTime(b.start) - toTime(a.start))
    .map((p) => ({ ...p, estimate: Math.round((Number(p.days) || 0) * estDailyRate) }));

  // Per-period payments routed through an EMPLOYER (reimbursed to the employer,
  // who pays you via salary) — each carries the service period, amount, and the
  // processing/approval date, so the right payslip can be located.
  const empPayments = [];
  for (const tv of (miluimRaw.TabTviotMaasik && miluimRaw.TabTviotMaasik.TviotMaasikTbl) || []) {
    for (const tk of (tv.TkufotMaasik || [])) {
      const amount = Number(String(tk.Tagmul || '').replace(/,/g, '')) || 0;
      if (amount <= 0) continue; // skip ₪0 / rejected claims — no money to find in a payslip
      const parts = String(tk.Tkufa || '').split('-').map((x) => x.trim());
      empPayments.push({
        employer: tk.ShemMaasikTkufa || tv.ShemMaasik || 'מעסיק',
        start: parts[0] || '', end: parts[1] || parts[0] || '',
        days: Number(tk.MisYamim) || 0,
        amount,
        processDate: tv.TarTvia || '',
        status: tk.StatusTvia || '',
      });
    }
  }
  empPayments.sort((a, b) => toTime(b.start) - toTime(a.start));

  const miluim = {
    days: (report.daysSummary || {}).totalUniqueDays || 0,
    range: report.daysSummary ? { first: report.daysSummary.firstDay, last: report.daysSummary.lastDay } : null,
    totalEntitlement: (rec.you.total || 0) + employers.reduce((s, e) => s + (e.total || 0), 0),
    total40: report.total40 || 0,
    paid40: !!t40.ButzaTashlumLaMaasik,
    paid40Note: t40.HodaatChn || '',
    net: ap.net || 0, gross: ap.gross || 0, deductions: ap.deductions || 0,
    payments: (ap.payments || []).slice(),
    you: rec.you || {}, employers,
    paidPeriods: dr.sort((a, b) => toTime(b.start) - toTime(a.start)),
    pendingPeriods, estDailyRate, empPayments,
  };
  miluim.pendingDays = pendingPeriods.reduce((s, p) => s + (Number(p.days) || 0), 0);
  miluim.pendingEstTotal = pendingPeriods.reduce((s, p) => s + (p.estimate || 0), 0);

  // Real "bottom line" summaries (generated offline into letters/summaries.json).
  // Fall back to the letter's הנדון line if a summary is missing.
  const summaries = (await readJson('letters/summaries.json')) || {};
  const byFile = new Map((lettersContent.letters || []).map((l) => [l.file, l]));
  const mail = (lettersIdx || []).map((e) => {
    let bottom = summaries[e.file] || '';
    if (!bottom) { const c = byFile.get(e.file); const m = c && c.text && /הנדון[:\s]*([^\n]+)/.exec(c.text); bottom = m ? m[1].trim() : ''; }
    return { date: e.date, subject: e.subject, summary: bottom };
  }).sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  const actTab = inquiries.TabSherutIshiCalls || {};
  const actTbl = actTab.PniyotTbl || actTab.CallsTbl || Object.values(actTab).find((v) => v && v.Headers) || {};
  const activity = (actTbl.TplRows || actTbl.Rows || []).map((r) => ({ date: r[0], time: r[1], source: r[2], activity: r[3] }));

  const first = (summary.name || '').split(' ')[0] || '';
  return { name: summary.name || '', first, avatar: (summary.name || '').replace(/\s/g, '').slice(0, 2),
    zehutLast4: String((summary.currentZehut || {}).P_teudat_zehut || '').slice(-4), debts, miluim, mail, activity };
}

// ---------- render ----------
const FONTS = 'https://fonts.googleapis.com/css2?family=Rubik:wght@400;500;600;700&family=Assistant:wght@400;500;600;700&display=swap';

const STYLE = `
:root{
  --bg:#f0f7f4; --ink:#143a33; --ink-soft:#5a7770; --faint:#9bb3ad;
  --teal:#16b89a; --teal-deep:#0f8f78; --teal-tint:#e3f6f1;
  --sky:#38b6e0; --sky-tint:#e4f5fb; --warm-tint:#fdf1e3; --warm-deep:#b9742a;
  --card:#fff; --line:#e6efeb;
  --shadow:0 10px 30px -16px rgba(20,90,80,.28); --shadow-soft:0 6px 18px -12px rgba(20,90,80,.30);
  --r-lg:24px; --r-md:16px; --r-sm:12px; --pill:999px;
}
*{box-sizing:border-box;margin:0;padding:0}
html{-webkit-text-size-adjust:100%}
body{background:var(--bg);color:var(--ink);font-family:'Assistant',sans-serif;line-height:1.55;padding:30px 18px 56px;min-height:100vh;
  background-image:radial-gradient(760px 380px at 92% -6%,rgba(56,182,224,.10),transparent 60%),radial-gradient(680px 420px at 4% 2%,rgba(22,184,154,.10),transparent 58%)}
.wrap{max-width:920px;margin:0 auto}
.num{font-family:'Rubik',sans-serif;font-variant-numeric:tabular-nums;font-feature-settings:"tnum" 1;letter-spacing:.2px}
h1,h2,h3{font-family:'Rubik',sans-serif;font-weight:600;line-height:1.2}
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}

.hdr{display:flex;align-items:center;gap:18px;margin-bottom:26px;flex-wrap:wrap}
.avatar{width:60px;height:60px;border-radius:var(--pill);background:linear-gradient(135deg,var(--teal),var(--sky));color:#fff;
  display:flex;align-items:center;justify-content:center;font-family:'Rubik';font-weight:700;font-size:23px;
  box-shadow:0 8px 18px -8px rgba(22,184,154,.6);flex-shrink:0}
.hdr .greet{flex:1;min-width:220px}
.hdr h1{font-size:30px;font-weight:700}
.hdr h1 span.nm{color:var(--teal-deep)}
.hdr .sub{color:var(--ink-soft);font-size:16px;margin-top:3px;display:flex;align-items:center;gap:7px}
.dot{width:8px;height:8px;border-radius:var(--pill);background:var(--teal);display:inline-block;box-shadow:0 0 0 4px var(--teal-tint)}
.wave{font-size:28px}

.sec{margin-top:34px}
.sec-head{display:flex;align-items:center;gap:10px;margin:0 4px 14px}
.sec-head h2{font-size:21px;font-weight:600}
.sec-ico{width:34px;height:34px;border-radius:var(--r-sm);display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;background:var(--teal-tint);color:var(--teal-deep)}
.sec-ico.sky{background:var(--sky-tint);color:#1577a0}

.verdict{background:var(--card);border-radius:var(--r-lg);box-shadow:var(--shadow);padding:30px 30px 26px;position:relative;overflow:hidden;border:1px solid var(--line)}
.verdict::before{content:"";position:absolute;inset:0;pointer-events:none;background:radial-gradient(380px 200px at 92% -30%,rgba(56,182,224,.10),transparent),radial-gradient(420px 240px at 6% 130%,rgba(22,184,154,.12),transparent)}
.verdict.warn{border-color:#f4dcc3}
.verdict-top{display:flex;align-items:center;gap:22px;position:relative;flex-wrap:wrap}
.check-badge{width:78px;height:78px;border-radius:var(--pill);flex-shrink:0;display:flex;align-items:center;justify-content:center;color:#fff;font-size:40px;
  background:linear-gradient(135deg,var(--teal),#23cfa8);box-shadow:0 14px 28px -12px rgba(22,184,154,.7);animation:pop .6s cubic-bezier(.18,1.3,.5,1) both}
.check-badge.warn{background:linear-gradient(135deg,#e9a23b,#f0b85f);box-shadow:0 14px 28px -12px rgba(224,163,61,.7)}
@keyframes pop{from{transform:scale(.4);opacity:0}to{transform:scale(1);opacity:1}}
.verdict-txt{flex:1;min-width:200px}
.verdict-txt h3{font-size:28px;font-weight:700;color:var(--teal-deep)}
.verdict-txt h3.warn{color:var(--warm-deep)}
.verdict-txt p{color:var(--ink-soft);font-size:16px;margin-top:4px}
.status-tag{display:inline-flex;align-items:center;gap:6px;background:var(--teal-tint);color:var(--teal-deep);font-weight:600;font-size:13px;padding:6px 13px;border-radius:var(--pill);margin-top:10px}
.chips{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-top:24px;position:relative}
.chip{background:#fbfdfc;border:1px solid var(--line);border-radius:var(--r-md);padding:14px 16px;display:flex;align-items:center;gap:12px}
.chip-ico{width:36px;height:36px;border-radius:var(--pill);flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:18px}
.chip-ok .chip-ico{background:var(--teal-tint);color:var(--teal-deep)}
.chip-credit .chip-ico{background:var(--sky-tint);color:#1577a0}
.chip-pending .chip-ico{background:var(--warm-tint);color:var(--warm-deep)}
.chip .lbl{font-size:13px;color:var(--ink-soft);font-weight:500}
.chip .val{font-size:15px;font-weight:600;margin-top:1px}
.chip-credit .val{color:#1577a0}
.chip-pending .val{color:var(--warm-deep)}

.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}
.stat{background:var(--card);border-radius:var(--r-md);border:1px solid var(--line);box-shadow:var(--shadow-soft);padding:18px;position:relative;overflow:hidden}
.stat .cap{font-size:13px;color:var(--ink-soft);font-weight:600;display:flex;align-items:center;gap:6px}
.stat .big{font-family:'Rubik';font-weight:700;font-size:25px;margin-top:7px;line-height:1.1}
.stat .unit{font-size:14px;font-weight:500;color:var(--ink-soft)}
.stat.accent{background:linear-gradient(150deg,var(--teal-tint),#f3fbf9)}
.stat.accent .big{color:var(--teal-deep)}
.paid-ok{display:inline-flex;align-items:center;gap:5px;color:var(--teal-deep);font-size:13px;font-weight:600;margin-top:6px}
.paid-no{display:inline-flex;align-items:center;gap:5px;color:var(--warm-deep);font-size:13px;font-weight:600;margin-top:6px}
.note40{margin:13px 4px 0;color:var(--ink-soft);font-size:13.5px;display:flex;align-items:center;gap:7px}
.note40.pend{color:var(--warm-deep)}

.panel{background:var(--card);border-radius:var(--r-lg);border:1px solid var(--line);box-shadow:var(--shadow-soft);overflow:hidden;margin-top:16px}
.panel-cap{padding:14px 20px;font-family:'Rubik';font-weight:600;font-size:15px;border-bottom:1px solid var(--line);background:#fbfdfc;display:flex;justify-content:space-between;align-items:center}
.panel-cap .c{font-size:13px;color:var(--faint);font-weight:500}
table{width:100%;border-collapse:collapse}
thead th{font-family:'Rubik';font-weight:500;font-size:13px;color:var(--ink-soft);text-align:right;padding:14px 20px;background:#f6faf8;border-bottom:1px solid var(--line);white-space:nowrap}
tbody td{padding:14px 20px;font-size:15px;border-bottom:1px solid var(--line);vertical-align:middle}
tbody tr:last-child td{border-bottom:none}
tbody tr{transition:background .15s}
tbody tr:hover{background:#f6faf8}
td.n{font-family:'Rubik';font-variant-numeric:tabular-nums;font-feature-settings:"tnum" 1;white-space:nowrap}
td.n .z{color:var(--faint)}
td.split-int{border-bottom:1px dashed #d7e8e2}
td[rowspan]{vertical-align:middle}
.period{font-weight:600}
.pay-pill{font-size:12px;font-weight:600;padding:3px 11px;border-radius:var(--pill);background:var(--teal-tint);color:var(--teal-deep);white-space:nowrap;display:inline-block}
.pay-pill.firm{background:var(--sky-tint);color:#1577a0}
.pay-pill.pend{background:var(--warm-tint);color:var(--warm-deep)}
tr.pending-row td{background:#fffaf2}
tr.pending-row:hover td{background:#fff4e3}
.add40{color:var(--teal-deep);font-weight:600}
td.est{color:var(--warm-deep);white-space:nowrap}
.est-val{font-family:'Rubik';font-weight:700}
.est-tag{font-size:11px;color:var(--warm-deep);background:var(--warm-tint);padding:2px 8px;border-radius:var(--pill);margin-inline-start:6px;font-weight:600}
.subj-pill{font-size:12px;font-weight:600;padding:3px 12px;border-radius:var(--pill);background:var(--teal-tint);color:var(--teal-deep);white-space:nowrap;display:inline-block}
.subj-pill.coll{background:var(--sky-tint);color:#1577a0}
.subj-pill.neutral{background:#eef1f0;color:var(--ink-soft)}
.subj-cell{color:var(--ink-soft)}
td.bottomline{color:var(--ink);font-size:14px;line-height:1.5;min-width:280px}

.reconcile{margin-top:18px;background:linear-gradient(150deg,var(--sky-tint),#f4fbff);border:1px solid #cfeaf5;border-radius:var(--r-lg);padding:22px;text-align:center}
.recon-btn{font-family:'Rubik';font-weight:600;font-size:16px;color:#fff;background:linear-gradient(135deg,var(--sky),#1f9fd0);border:none;cursor:pointer;padding:14px 26px;border-radius:var(--pill);box-shadow:0 12px 24px -10px rgba(56,182,224,.75);transition:transform .12s,box-shadow .15s}
.recon-btn:hover{transform:translateY(-1px);box-shadow:0 16px 28px -10px rgba(56,182,224,.85)}
.recon-btn:active{transform:scale(.98)}
.recon-sub{color:var(--ink-soft);font-size:13.5px;margin-top:11px;max-width:58ch;margin-inline:auto;line-height:1.55}
.hidden-row{display:none}
.hidden-row.show{display:table-row}

.more-bar{display:flex;justify-content:center;padding:14px;border-top:1px solid var(--line);background:#fbfdfc}
.more-btn{font-family:'Rubik';font-weight:500;font-size:14px;color:var(--teal-deep);background:var(--teal-tint);border:none;cursor:pointer;
  padding:10px 22px;border-radius:var(--pill);display:inline-flex;align-items:center;gap:8px;transition:transform .12s,background .15s}
.more-btn:hover{background:#d2f0e8}
.more-btn:active{transform:scale(.97)}
.more-btn .arr{transition:transform .25s}
.more-btn.open .arr{transform:rotate(180deg)}

footer{margin-top:40px;text-align:center;color:var(--ink-soft);font-size:13px;line-height:1.8}
footer .fline{display:inline-flex;align-items:center;gap:7px}

@media (max-width:680px){.stats{grid-template-columns:repeat(2,1fr)}.hdr h1{font-size:24px}.verdict{padding:24px 20px}thead th,tbody td{padding:12px 14px;font-size:14px}.sec-head h2{font-size:19px}}
`;

function pendingRow(p) {
  const span = p.end && p.end !== p.start ? `${esc(p.start)}–${esc(p.end)}` : esc(p.start);
  const est = p.estimate > 0
    ? `<span class="est-val">≈ ${num(p.estimate)} ₪</span> <span class="est-tag">הערכה</span>`
    : '<span class="z">—</span>';
  return `<tr class="pending-row">
    <td class="period"><span class="num" dir="ltr">${span}</span></td>
    <td class="n">${p.days}</td>
    <td><span class="pay-pill pend">${esc(p.status || 'טרם שולם')}</span></td>
    <td class="n est" colspan="2">${est}</td>
  </tr>`;
}

// Group paid periods that share the same תקופה (start|end|days) so a period paid
// to both you and an employer becomes ONE row, with the recipient / daily-rate /
// 40% columns split into stacked sub-rows. Order preserved (input is date-desc);
// within a group, "לך" is listed first.
function groupPeriods(list) {
  const map = new Map(); const order = [];
  for (const p of list) {
    const k = `${p.start}|${p.end}|${p.days}`;
    if (!map.has(k)) { map.set(k, { start: p.start, end: p.end, days: p.days, entries: [] }); order.push(k); }
    map.get(k).entries.push({ paidTo: p.paidTo, fullDailyRate: p.fullDailyRate, tosefet40: p.tosefet40 });
  }
  const rank = (e) => (e.paidTo === 'לך' ? 0 : 1);
  for (const k of order) map.get(k).entries.sort((a, b) => rank(a) - rank(b));
  return order.map((k) => map.get(k));
}

// Render the three split cells (recipient / daily rate / 40%) for one entry.
// `internal` => a lighter dashed divider (sub-rows within the same תקופה).
function splitCells(e, internal) {
  const you = e.paidTo === 'לך';
  const b = internal ? ' split-int' : '';
  return `<td class="${b.trim()}"><span class="pay-pill${you ? '' : ' firm'}">${esc(e.paidTo)}</span></td>`
    + `<td class="n${b}">${e.fullDailyRate ? nf.format(e.fullDailyRate) : '<span class="z">—</span>'}</td>`
    + `<td class="n add40${b}">${Number(e.tosefet40) ? nf.format(e.tosefet40) : '<span class="z">0</span>'}</td>`;
}

function periodGroup(g, hidden) {
  const n = g.entries.length;
  const span = g.end && g.end !== g.start ? `${esc(g.start)}–${esc(g.end)}` : esc(g.start);
  const hc = hidden ? 'hidden-row miluim-extra' : '';
  let html = `<tr class="${hc}">`
    + `<td class="period" rowspan="${n}"><span class="num" dir="ltr">${span}</span></td>`
    + `<td class="n" rowspan="${n}">${g.days}</td>`
    + splitCells(g.entries[0], n > 1) + `</tr>`;
  for (let i = 1; i < n; i++) html += `<tr class="${hc}">${splitCells(g.entries[i], i < n - 1)}</tr>`;
  return html;
}

function letterRow(l, hidden) {
  const cls = l.subject === 'גבייה' ? ' coll' : (l.subject === 'מילואים' ? '' : ' neutral');
  return `<tr class="${hidden ? 'hidden-row letters-extra' : ''}">
    <td class="n"><span class="num" dir="ltr">${esc(dmy(l.date))}</span></td>
    <td><span class="subj-pill${cls}">${esc(l.subject)}</span></td>
    <td class="bottomline">${esc(l.summary) || '—'}</td>
  </tr>`;
}

function activityRow(a, hidden) {
  return `<tr class="${hidden ? 'hidden-row activity-extra' : ''}">
    <td class="n"><span class="num" dir="ltr">${esc(a.date)}</span></td>
    <td class="n"><span class="num" dir="ltr">${esc(a.time)}</span></td>
    <td class="subj-cell">${esc(a.source)}</td>
    <td>${esc(a.activity)}</td>
  </tr>`;
}

function moreBar(id, total, shown) {
  if (total <= shown) return '';
  return `<div class="more-bar"><button class="more-btn" id="${id}" aria-expanded="false"><span class="txt">הצג עוד (${total - shown})</span><span class="arr">▾</span></button></div>`;
}

// Build the downloadable reconciliation report (Markdown) the user hands to an AI
// alongside their bank income report + salary slips to verify every miluim
// payment actually arrived.
function buildReconciliationReport(m, dateStr) {
  const mil = m.miluim, L = [], P = (s = '') => L.push(s);
  P('# בדיקת התאמה — תגמולי מילואים (ביטוח לאומי)');
  P(`נוצר: ${dateStr} · עבור: ${m.name} (ת״ז ●●●●●${m.zehutLast4})`);
  P('');
  P('## איך לבדוק (חשוב!)');
  P('כספי מילואים מגיעים בשני מסלולים נפרדים — אל תחפשו את שניהם באותו מקום:');
  P('1. **כסף ששולם ישירות אליך** — אמור להופיע כ**העברה נכנסת לחשבון הבנק** מ"המוסד לביטוח לאומי", סביב תאריך התשלום.');
  P('2. **כסף ששולם דרך המעסיק** — **לא** יופיע בבנק כהעברה מביטוח לאומי. הוא הוחזר למעסיק, והמעסיק משלם אותך דרך **המשכורת** — לכן יש לחפשו **בתלוש השכר בלבד**, בתלוש הקרוב ביותר לתקופת המילואים / לתאריך העיבוד.');
  P('');
  P('תנו קובץ זה ל-AI יחד עם (1) דוח תקבולים/עו״ש מהבנק ו-(2) תלושי השכר, ובקשו ממנו:');
  P('- לאמת שכל שורה בטבלת "ישירות אליך" מופיעה כהעברה נכנסת לבנק (תאריך + סכום נטו).');
  P('- לאמת שכל שורה בטבלת "דרך המעסיק" מופיעה כתגמול מילואים **בתלוש השכר הקרוב ביותר** לתאריכים שצוינו (תקופת המילואים / תאריך העיבוד).');
  P('- לסמן כל תשלום חסר / מאוחר / לא תואם, ולעקוב אחרי התקופות שטרם שולמו.');
  P('');
  P('## סיכום');
  P(`- ימי מילואים: ${nf.format(mil.days)} · שווי תגמולים כולל: ${nf.format(mil.totalEntitlement)} ₪`);
  P(`- תוספת 40%: ${nf.format(mil.total40)} ₪ (שולמה: ${mil.paid40 ? 'כן' : 'לא'})${mil.paid40Note ? ` — ${mil.paid40Note}` : ''}`);
  P(`- שולם לך נטו ישירות (סה״כ): ${nf.format(mil.net)} ₪ (ברוטו ${nf.format(mil.gross)}, ניכויים ${nf.format(mil.deductions)})`);
  P('');
  P('## 1) כסף ששולם ישירות אליך — לחפש בעו״ש / דוח תקבולים מהבנק');
  P('כל שורה אמורה להופיע כ**העברה נכנסת** מ"המוסד לביטוח לאומי" סביב תאריך התשלום.');
  P('| תאריך תשלום | זכאות (ברוטו) | ניכויים | נטו לבנק |');
  P('| --- | ---: | ---: | ---: |');
  for (const p of mil.payments) P(`| ${p.date || '—'} | ${nf.format(p.entitlement)} | ${nf.format(p.deductions)} | ${nf.format(p.net)} |`);
  P('');
  if (mil.empPayments && mil.empPayments.length) {
    P('## 2) כסף ששולם דרך המעסיק — לחפש בתלוש השכר בלבד');
    P('סכומים אלה **אינם** מגיעים לבנק כהעברה מביטוח לאומי. חפשו כל שורה כתגמול מילואים **בתלוש השכר הקרוב ביותר** לתקופת המילואים או לתאריך העיבוד (בדרך כלל תלוש חודש השירות, או 1–2 חודשים אחריו).');
    P('| תקופת מילואים | ימים | מעסיק | תגמול בסיס (₪) | תאריך עיבוד/אישור | סטטוס |');
    P('| --- | ---: | --- | ---: | --- | --- |');
    for (const e of mil.empPayments) {
      const span = e.end && e.end !== e.start ? `${e.start}–${e.end}` : e.start;
      P(`| ${span} | ${e.days} | ${e.employer} | ${nf.format(e.amount)} | ${e.processDate || '—'} | ${e.status || ''} |`);
    }
    P('');
    P('> "תגמול בסיס" הוא הסכום שהוחזר למעסיק. בתלוש עשויה להופיע גם תוספת ה-40% והתאמות שכר של המעסיק, כך שהסכום בתלוש עשוי להיות מעט שונה — ההתאמה היא לפי החודש וסדר הגודל. (סה״כ ששולם דרך מעסיקים, כולל 40%: ' + mil.employers.map((e) => `${e.name} ${nf.format(e.total)} ₪`).join(' · ') + ')');
    P('');
  }
  if (mil.pendingPeriods.length) {
    P('## תקופות שטרם שולמו — אמורות להגיע (הערכה)');
    P('| תקופה | ימים | סטטוס | הערכת זכאות (₪) |');
    P('| --- | ---: | --- | ---: |');
    for (const p of mil.pendingPeriods) {
      const span = p.end && p.end !== p.start ? `${p.start}–${p.end}` : p.start;
      P(`| ${span} | ${p.days} | ${p.status || 'טרם שולם'} | ~${nf.format(p.estimate)} |`);
    }
    P('');
    P(`סה״כ הערכה לתקופות שטרם שולמו: ~${nf.format(mil.pendingEstTotal)} ₪`);
    P('');
  }
  P('---');
  P(`> ההערכות מבוססות על התעריף היומי הממוצע האחרון ששולם לך (~${nf.format(mil.estDailyRate)} ₪ ליום) ואינן סכום רשמי של הביטוח הלאומי.`);
  return L.join('\n');
}

function renderBody(m, dateStr, greet) {
  const d = m.debts, mil = m.miluim, ok = !d.hasMaterialDebt;
  const PV = 5, LV = 6, AV = 6; // visible-by-default counts
  const periodGroups = groupPeriods(mil.paidPeriods);

  const chips = [
    `<div class="chip chip-ok"><div class="chip-ico">✓</div><div><div class="lbl">דמי ביטוח ובריאות</div><div class="val">${d.niHealthClear ? 'אין חוב' : 'קיים חוב'}</div></div></div>`,
    `<div class="chip chip-ok"><div class="chip-ico">🕊️</div><div><div class="lbl">סטטוס תשלומים</div><div class="val">${d.inArrears ? 'בפיגור' : 'לא בפיגור'}</div></div></div>`,
    d.credit ? `<div class="chip chip-credit"><div class="chip-ico">★</div><div><div class="lbl">יתרת גבייה</div><div class="val">${esc(d.credit)}</div></div></div>` : '',
    d.gimlaotTotal > 0 ? `<div class="chip chip-pending"><div class="chip-ico">⏳</div><div><div class="lbl">גמלאות (מילואים)</div><div class="val">${num(d.gimlaotTotal)} ₪ — בבדיקה</div></div></div>` : '',
  ].join('');

  return `<main class="wrap">
  <h2 class="sr-only">לוח מצב אישי בביטוח לאומי ל${esc(m.name)}, נכון ל-${esc(dateStr)}.</h2>

  <header class="hdr">
    <div class="avatar">${esc(m.avatar)}</div>
    <div class="greet">
      <h1>${esc(greet)}, <span class="nm">${esc(m.first)}</span> <span class="wave">👋</span></h1>
      <div class="sub"><span class="dot"></span>מצב נכון ל־<span class="num" dir="ltr">${esc(dateStr)}</span></div>
    </div>
  </header>

  <section class="sec">
    <div class="sec-head"><div class="sec-ico">💳</div><h2>חובות</h2></div>
    <div class="verdict${ok ? '' : ' warn'}">
      <div class="verdict-top">
        <div class="check-badge${ok ? '' : ' warn'}">${ok ? '✓' : '!'}</div>
        <div class="verdict-txt">
          <h3 class="${ok ? '' : 'warn'}">${ok ? 'אין חובות 🎉' : 'יש לבדוק חובות'}</h3>
          <p>${d.niHealthClear ? 'הכול מסודר — אין חוב פעיל בדמי ביטוח או בבריאות.' : 'נמצא חוב פעיל — מומלץ לבדוק.'}</p>
          <span class="status-tag"><span>●</span> מעמד: ${esc(d.status) || '—'} · ${d.inArrears ? 'בפיגור' : 'לא בפיגור'}</span>
        </div>
      </div>
      <div class="chips">${chips}</div>
    </div>
  </section>

  <section class="sec">
    <div class="sec-head"><div class="sec-ico">🎖️</div><h2>מילואים</h2></div>
    <div class="stats">
      <div class="stat"><div class="cap">📅 ימי מילואים</div><div class="big">${num(mil.days)} <span class="unit">ימים</span></div></div>
      <div class="stat accent"><div class="cap">💰 שווי תגמולים כולל</div><div class="big">${num(mil.totalEntitlement)} <span class="unit">₪</span></div></div>
      <div class="stat"><div class="cap">➕ תוספת 40%</div><div class="big">${num(mil.total40)} <span class="unit">₪</span></div>${mil.paid40 ? '<span class="paid-ok">✓ שולמה במלואה</span>' : '<span class="paid-no">⏳ טרם שולמה</span>'}</div>
      <div class="stat"><div class="cap">🏦 שולם לך נטו</div><div class="big">${num(mil.net)} <span class="unit">₪</span></div></div>
    </div>
    ${mil.paid40 && mil.paid40Note ? `<div class="note40">✓ <span>${esc(mil.paid40Note)}</span></div>` : ''}
    ${mil.pendingPeriods.length ? `<div class="note40 pend">⏳ <span><b>${mil.pendingPeriods.length} תקופות (${mil.pendingDays} ימים)</b> רשומות אך טרם שולמו — הערכת זכאות: <b>~${nf.format(mil.pendingEstTotal)} ₪</b> (לפי תעריף יומי אחרון ~${nf.format(mil.estDailyRate)} ₪ ליום). מסומנות בראש הטבלה.</span></div>` : ''}

    <div class="panel">
      <table>
        <thead><tr><th>תקופה</th><th>ימים</th><th>שולם ל־</th><th>תעריף יומי</th><th>תוספת 40%</th></tr></thead>
        <tbody>${mil.pendingPeriods.map((p) => pendingRow(p)).join('')}${periodGroups.map((g, i) => periodGroup(g, i >= PV)).join('')}</tbody>
      </table>
      ${moreBar('miluimBtn', periodGroups.length, PV)}
    </div>

    <div class="reconcile">
      <button class="recon-btn" id="reconBtn">📥 רוצים לוודא שכל הכסף הגיע לבנק?</button>
      <p class="recon-sub">להורדת דוח שאפשר לתת ל-AI יחד עם דוח התקבולים מהבנק ותלושי השכר — והוא יבדוק אוטומטית אם חסר תשלום או שמשהו לא תואם.</p>
    </div>
  </section>

  <section class="sec">
    <div class="sec-head"><div class="sec-ico sky">✉️</div><h2>דואר ופניות</h2></div>
    <div class="panel">
      <div class="panel-cap"><span>מכתבים מהביטוח הלאומי</span><span class="c">${m.mail.length} מכתבים</span></div>
      <table>
        <thead><tr><th>תאריך</th><th>נושא</th><th>שורה תחתונה</th></tr></thead>
        <tbody>${m.mail.map((l, i) => letterRow(l, i >= LV)).join('')}</tbody>
      </table>
      ${moreBar('lettersBtn', m.mail.length, LV)}
    </div>
    <div class="panel">
      <div class="panel-cap"><span>פניות ופעילות קודמת באתר</span><span class="c">${m.activity.length} רשומות</span></div>
      <table>
        <thead><tr><th>תאריך</th><th>שעה</th><th>מקור</th><th>פעילות</th></tr></thead>
        <tbody>${m.activity.map((a, i) => activityRow(a, i >= AV)).join('')}</tbody>
      </table>
      ${moreBar('activityBtn', m.activity.length, AV)}
    </div>
  </section>

  <footer>
    <div class="fline">🔒 תצוגה בלבד · הנתונים נמשכו ממערכת המוסד לביטוח לאומי</div>
    <div>ת״ז ●●●●●${esc(m.zehutLast4)} · נכון ל־<span class="num" dir="ltr">${esc(dateStr)}</span></div>
  </footer>
</main>`;
}

function page(m, now) {
  const dateStr = `${String(now.getDate()).padStart(2, '0')}/${String(now.getMonth() + 1).padStart(2, '0')}/${now.getFullYear()}`;
  const h = now.getHours();
  const greet = h < 12 ? 'בוקר טוב' : h < 18 ? 'צהריים טובים' : 'ערב טוב';
  const reconMd = buildReconciliationReport(m, dateStr);
  return `<!DOCTYPE html>
<html dir="rtl" lang="he">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(m.name)} · ביטוח לאומי — לוח מצב</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="${FONTS}" rel="stylesheet">
<style>${STYLE}</style>
</head>
<body>
${renderBody(m, dateStr, greet)}
<script>
function wireToggle(btnId, rowClass){
  var btn=document.getElementById(btnId); if(!btn) return;
  var rows=document.querySelectorAll('.'+rowClass), txt=btn.querySelector('.txt'), open=false;
  var more=txt.textContent;
  btn.addEventListener('click',function(){
    open=!open;
    rows.forEach(function(r){ r.classList.toggle('show',open); });
    txt.textContent=open?'הצג פחות':more;
    btn.classList.toggle('open',open);
    btn.setAttribute('aria-expanded',open?'true':'false');
  });
}
wireToggle('miluimBtn','miluim-extra');
wireToggle('lettersBtn','letters-extra');
wireToggle('activityBtn','activity-extra');

var RECON=${JSON.stringify(reconMd)};
(function(){
  var b=document.getElementById('reconBtn'); if(!b) return;
  b.addEventListener('click',function(){
    var blob=new Blob(['\\ufeff'+RECON],{type:'text/markdown;charset=utf-8'});
    var url=URL.createObjectURL(blob);
    var a=document.createElement('a');
    a.href=url; a.download='btl-miluim-reconciliation.md';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function(){URL.revokeObjectURL(url);},1500);
  });
})();
</script>
</body></html>`;
}

async function main() {
  const m = await buildModel();
  const html = page(m, new Date());
  const dest = path.join(OUT, 'dashboard.html');
  await fs.writeFile(dest, html, 'utf8');
  console.error(`Dashboard written: ${dest}`);
  console.error(`  debts: ${m.debts.hasMaterialDebt ? 'check needed' : 'none'} | miluim periods: ${m.miluim.paidPeriods.length} paid + ${m.miluim.pendingPeriods.length} pending | letters: ${m.mail.length} | activity: ${m.activity.length}`);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(2); });
