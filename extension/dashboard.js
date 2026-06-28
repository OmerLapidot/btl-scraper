// dashboard.js — renders the dashboard from the data the content script fetched.
//
// Reads chrome.storage.session (in-memory only) and builds a read-only view of
// debts, miluim (full — same model + render as the Node tool), letters, and
// previous inquiries. The miluim report is computed in-browser by the verbatim
// port of src/report-miluim.js (lib/miluim-report.js). Defensive throughout.

import { generateMiluimReport } from './lib/miluim-report.js';

// ---------- formatting helpers ----------
const nf = new Intl.NumberFormat('en-US');
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (n) => `<span class="num" dir="ltr">${nf.format(Math.round(Number(n) || 0))}</span>`;
const dmy = (s) => {
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || '');
  if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;
  return String(s || '');
};
const toTime = (s) => {
  const m = /(\d{2})\/(\d{2})\/(\d{4})/.exec(s || '');
  if (m) return Date.UTC(+m[3], +m[2] - 1, +m[1]);
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || '');
  if (iso) return Date.UTC(+iso[1], +iso[2] - 1, +iso[3]);
  return 0;
};

// ---------- model ----------
export function buildModel(data) {
  const summary = data.summary || {};

  // Debts (logic mirrors src/dashboard.js).
  const niHealth = data.chovotGalash || {};
  const benefits = data.chovotGimlaot || {};
  const collection = (data.galash || {}).Info || {};
  const gimlaotRows = (((benefits.Info || {}).ChovotGimlaotNew || {}).ChovotGimlaotNewTbl) || [];
  const gimlaotTotal = gimlaotRows.reduce((s, r) => s + (Number(r.YtratChovDec) || 0), 0);
  const klali = collection.klaliTab || {};
  const daf = collection.dafCheshbonTab || {};
  const debts = {
    niHealthClear: niHealth.InitialMessageType === 'Success',
    niHealthMsg: niHealth.InitialMessage || '',
    gimlaotTotal,
    inArrears: !!((klali.mufar || {}).isMufar),
    balanceDue: !!daf.YtrtChovExst,
    credit: (klali.zchut && klali.zchut.Tpl && klali.zchut.Tpl.schum) || null,
    status: (klali.maamadot || []).map((m) => m.Text).join(' ').replace(/\.$/, ''),
  };
  debts.hasMaterialDebt = !debts.niHealthClear || debts.inArrears || debts.balanceDue || gimlaotTotal > 50;

  // Miluim — full model, computed by the validated report engine (in-browser).
  const miluim = buildMiluimModel((data.miluim || {}).Info || {});

  // Letters list (date + subject; PDFs/AI summaries are an offline-only step).
  const letters = ((data.letters || {}).Letters || []).map((l) => ({
    date: l.LetterDate,
    subject: l.BtlSubjectName,
    isNew: !!l.isNew,
  })).sort((a, b) => toTime(b.date) - toTime(a.date));

  // Previous inquiries / site activity.
  const inq = (data.pniyot || {}).Info || {};
  const actTab = inq.TabSherutIshiCalls || {};
  const actTbl = actTab.PniyotTbl || actTab.CallsTbl || Object.values(actTab).find((v) => v && v.Headers) || {};
  const activity = (actTbl.TplRows || actTbl.Rows || []).map((r) => ({ date: r[0], time: r[1], source: r[2], activity: r[3] }));

  const name = summary.name || '';
  return {
    name,
    first: name.split(' ')[0] || '',
    avatar: name.replace(/\s/g, '').slice(0, 2) || '👤',
    zehutLast4: String((summary.currentZehut || {}).P_teudat_zehut || '').slice(-4),
    debts, miluim, letters, activity,
  };
}

// ---------- render: shared bits ----------
function moreBar(id, total, shown) {
  if (total <= shown) return '';
  return `<div class="more-bar"><button class="more-btn" id="${id}" aria-expanded="false"><span class="txt">הצג עוד (${total - shown})</span><span class="arr">▾</span></button></div>`;
}

// ---------- render: debts ----------
function debtsSection(d) {
  const ok = !d.hasMaterialDebt;
  const chips = [
    `<div class="chip ${d.niHealthClear ? 'chip-ok' : 'chip-bad'}"><div class="chip-ico">${d.niHealthClear ? '✓' : '!'}</div><div><div class="lbl">דמי ביטוח ובריאות</div><div class="val">${d.niHealthClear ? 'אין חוב' : 'קיים חוב'}</div></div></div>`,
    `<div class="chip ${d.inArrears ? 'chip-bad' : 'chip-ok'}"><div class="chip-ico">${d.inArrears ? '!' : '🕊️'}</div><div><div class="lbl">סטטוס תשלומים</div><div class="val">${d.inArrears ? 'בפיגור' : 'לא בפיגור'}</div></div></div>`,
    d.credit ? `<div class="chip chip-credit"><div class="chip-ico">★</div><div><div class="lbl">יתרת גבייה</div><div class="val">${esc(d.credit)}</div></div></div>` : '',
    d.gimlaotTotal > 0 ? `<div class="chip chip-pending"><div class="chip-ico">⏳</div><div><div class="lbl">גמלאות (מילואים)</div><div class="val">${num(d.gimlaotTotal)} ₪ — בבדיקה</div></div></div>` : '',
  ].join('');

  return `<section class="sec">
    <div class="sec-head"><div class="sec-ico">💳</div><h2>חובות</h2></div>
    <div class="verdict${ok ? '' : ' warn'}">
      <div class="verdict-top">
        <div class="check-badge${ok ? '' : ' warn'}">${ok ? '✓' : '!'}</div>
        <div class="verdict-txt">
          <h3 class="${ok ? '' : 'warn'}">${ok ? 'אין חובות 🎉' : 'יש לבדוק חובות'}</h3>
          <p>${d.niHealthClear ? 'הכול מסודר — אין חוב פעיל בדמי ביטוח או בבריאות.' : esc(d.niHealthMsg || 'נמצא חוב פעיל — מומלץ לבדוק.')}</p>
          <span class="status-tag"><span>●</span> מעמד: ${esc(d.status) || '—'} · ${d.inArrears ? 'בפיגור' : 'לא בפיגור'}</span>
        </div>
      </div>
      <div class="chips">${chips}</div>
    </div>
  </section>`;
}

// ---------- render: miluim (ported from src/dashboard.js) ----------
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

function splitCells(e, internal) {
  const you = e.paidTo === 'לך';
  const b = internal ? ' split-int' : '';
  return `<td class="${b.trim()}"><span class="pay-pill${you ? '' : ' firm'}">${esc(e.paidTo)}</span></td>`
    + `<td class="n${b}">${e.fullDailyRate ? nf.format(e.fullDailyRate) : '<span class="z">—</span>'}</td>`
    + `<td class="n add40${b}">${Number(e.tosefet40) ? nf.format(e.tosefet40) : '<span class="z">0</span>'}</td>`;
}

function periodGroup(g, hidden) {
  const nn = g.entries.length;
  const span = g.end && g.end !== g.start ? `${esc(g.start)}–${esc(g.end)}` : esc(g.start);
  const hc = hidden ? 'hidden-row miluim-extra' : '';
  let html = `<tr class="${hc}">`
    + `<td class="period" rowspan="${nn}"><span class="num" dir="ltr">${span}</span></td>`
    + `<td class="n" rowspan="${nn}">${g.days}</td>`
    + splitCells(g.entries[0], nn > 1) + `</tr>`;
  for (let i = 1; i < nn; i++) html += `<tr class="${hc}">${splitCells(g.entries[i], i < nn - 1)}</tr>`;
  return html;
}

// ---- period filtering ----
function inPeriod(dateStr, from, to) {
  const t = toTime(dateStr);
  if (!t) return false;
  if (from != null && t < from) return false;
  if (to != null && t > to) return false;
  return true;
}

function availableYears(mil) {
  const ys = new Set();
  const add = (d) => { const t = toTime(d); if (t) ys.add(new Date(t).getUTCFullYear()); };
  (mil.paidPeriods || []).forEach((p) => add(p.start));
  (mil.empPayments || []).forEach((e) => add(e.processDate || e.start));
  (mil.pendingPeriods || []).forEach((p) => add(p.start));
  (mil.payments || []).forEach((p) => add(p.date));
  return [...ys].sort((a, b) => b - a);
}

// Build the miluim view-model from a raw BerurMiluim `.Info`, via the validated
// report engine. Works for the whole account or a period-filtered slice — so a
// period view is computed the SAME way as the lifetime figures (not summed rows).
function buildMiluimModel(miluimRaw) {
  miluimRaw = miluimRaw || {};
  let report;
  try { report = generateMiluimReport(miluimRaw); }
  catch (_) { report = { daysSummary: {}, recipients: { you: {}, employers: [] }, total40: 0, actualPayments: {}, dailyRatesByPeriod: [], pendingPeriods: [] }; }

  const t40 = miluimRaw.TabTosefet40Ahuz || {};
  const rec = report.recipients || { you: {}, employers: [] };
  const employers = (rec.employers || []).filter((e) => (e.total || 0) > 0);
  const employerTotal = employers.reduce((s, e) => s + (e.total || 0), 0);
  const ap = report.actualPayments || {};
  const dr = (report.dailyRatesByPeriod || []).slice();

  const youRates = dr.filter((p) => p.paidTo === 'לך' && p.fullDailyRate > 0)
    .sort((a, b) => toTime(b.start) - toTime(a.start)).slice(0, 12);
  let sd = 0, sr = 0;
  for (const p of youRates) { const dd = Number(p.days) || 0; sd += dd; sr += (p.fullDailyRate || 0) * dd; }
  const estDailyRate = sd ? Math.round(sr / sd) : 0;

  const pendingPeriods = (report.pendingPeriods || []).slice()
    .sort((a, b) => toTime(b.start) - toTime(a.start))
    .map((p) => ({ ...p, estimate: Math.round((Number(p.days) || 0) * estDailyRate) }));

  const empPayments = [];
  for (const tv of (miluimRaw.TabTviotMaasik && miluimRaw.TabTviotMaasik.TviotMaasikTbl) || []) {
    for (const tk of (tv.TkufotMaasik || [])) {
      const amount = Number(String(tk.Tagmul || '').replace(/,/g, '')) || 0;
      if (amount <= 0) continue;
      const parts = String(tk.Tkufa || '').split('-').map((x) => x.trim());
      empPayments.push({
        employer: tk.ShemMaasikTkufa || tv.ShemMaasik || 'מעסיק',
        start: parts[0] || '', end: parts[1] || parts[0] || '',
        days: Number(tk.MisYamim) || 0, amount,
        processDate: tv.TarTvia || '', status: tk.StatusTvia || '',
      });
    }
  }
  empPayments.sort((a, b) => toTime(b.start) - toTime(a.start));

  const miluim = {
    hasAny: !!Object.keys(miluimRaw).length,
    raw: miluimRaw,
    days: (report.daysSummary || {}).totalUniqueDays || 0,
    totalEntitlement: ((rec.you || {}).total || 0) + employerTotal,
    youTotal: (rec.you || {}).total || 0,
    employerTotal,
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
  return miluim;
}

// Filter a raw BerurMiluim `.Info` to one window. Service tabs filter by the
// service-period start; the payments tab filters by payment date.
function filterRawInfo(info, from, to) {
  if (!info) return {};
  const tkStart = (t) => String(t || '').split('-')[0].trim();
  const out = { ...info };
  if (info.TabTosefet40Ahuz) out.TabTosefet40Ahuz = { ...info.TabTosefet40Ahuz, Tkufot40AhuzTbl: (info.TabTosefet40Ahuz.Tkufot40AhuzTbl || []).filter((r) => inPeriod(r.SherutStart, from, to)) };
  if (info.TabTkufotIdf) out.TabTkufotIdf = { ...info.TabTkufotIdf, TkufotIdfTbl: (info.TabTkufotIdf.TkufotIdfTbl || []).filter((r) => inPeriod(r.TarStartMil, from, to)) };
  if (info.TabTviotIshiyot) out.TabTviotIshiyot = { ...info.TabTviotIshiyot, TviotTbl: (info.TabTviotIshiyot.TviotTbl || []).map((tv) => ({ ...tv, TkufotIshiyot: (tv.TkufotIshiyot || []).filter((tk) => inPeriod(tkStart(tk.Tkufa), from, to)) })).filter((tv) => (tv.TkufotIshiyot || []).length) };
  if (info.TabTviotMaasik) out.TabTviotMaasik = { ...info.TabTviotMaasik, TviotMaasikTbl: (info.TabTviotMaasik.TviotMaasikTbl || []).map((tv) => ({ ...tv, TkufotMaasik: (tv.TkufotMaasik || []).filter((tk) => inPeriod(tkStart(tk.Tkufa), from, to)) })).filter((tv) => (tv.TkufotMaasik || []).length) };
  if (info.TabTashlumim) out.TabTashlumim = { ...info.TabTashlumim, KaspitTbl: (info.TabTashlumim.KaspitTbl || []).filter((k) => inPeriod(k.TarTashlum, from, to)) };
  return out;
}

// Period-scope the miluim model by re-running the report on filtered raw data.
export function filterMiluim(mil, from, to) {
  return buildMiluimModel(filterRawInfo(mil.raw, from, to));
}

// The period-scoped part of the section (notes + per-period table) — re-rendered
// on every period change. `periodLabel` empty/'כל התקופה' => no period chip.
function miluimViewHTML(mil, periodLabel) {
  const PV = 5;
  const periodGroups = groupPeriods(mil.paidPeriods);
  const empty = !mil.paidPeriods.length && !mil.pendingPeriods.length;
  const showCap = periodLabel && periodLabel !== 'כל התקופה';
  const cap = showCap ? `<span class="c">תקופה: ${esc(periodLabel)}</span>` : '';
  return `
    ${mil.paid40 && mil.paid40Note ? `<div class="note40">✓ <span>${esc(mil.paid40Note)}</span></div>` : ''}
    ${mil.pendingPeriods.length ? `<div class="note40 pend">⏳ <span><b>${mil.pendingPeriods.length} תקופות (${mil.pendingDays} ימים)</b> רשומות אך טרם שולמו — הערכת זכאות: <b>~${nf.format(mil.pendingEstTotal)} ₪</b> (לפי תעריף יומי אחרון ~${nf.format(mil.estDailyRate)} ₪ ליום). מסומנות בראש הטבלה.</span></div>` : ''}
    ${showCap ? `<div class="period-note">ℹ️ בתצוגה לפי תקופה, רכיבי תגמול של אותו שירות עשויים להופיע בשנים שונות (לפי מועד הרישום בביטוח הלאומי). הנתון המדויק לכל הזמן הוא תחת «כל התקופה».</div>` : ''}
    <div class="panel">
      <div class="panel-cap"><span>תקופות מילואים</span>${cap}</div>
      ${empty ? '<div class="panel-empty">אין תנועות בתקופה שנבחרה.</div>' : `<table>
        <thead><tr><th>תקופה</th><th>ימים</th><th>שולם ל־</th><th>תעריף יומי</th><th>תוספת 40%</th></tr></thead>
        <tbody>${mil.pendingPeriods.map((p) => pendingRow(p)).join('')}${periodGroups.map((g, i) => periodGroup(g, i >= PV)).join('')}</tbody>
      </table>
      ${moreBar('miluimBtn', periodGroups.length, PV)}`}
    </div>`;
}

function miluimStatsHTML(mil) {
  // Just the two figures that are sound per-period: days served and total value.
  // The you/employer and 40% breakdowns are unreliable per-year (BTL dates the
  // components separately) — they live in the per-period table and the report.
  return `<div class="stats">
      <div class="stat"><div class="cap">📅 ימי מילואים</div><div class="big">${num(mil.days)} <span class="unit">ימים</span></div></div>
      <div class="stat accent"><div class="cap">💰 שווי תגמולים כולל</div><div class="big">${num(mil.totalEntitlement)} <span class="unit">₪</span></div></div>
    </div>`;
}

function miluimSection(mil) {
  if (!mil.hasAny) return '';
  const yearOpts = availableYears(mil).map((y) => `<option value="y${y}">${y}</option>`).join('');
  return `<section class="sec">
    <div class="sec-head">
      <div class="sec-ico">🎖️</div>
      <h2>מילואים</h2>
      <div class="period-ctl">
        <label for="periodPreset">תקופה:</label>
        <select id="periodPreset">
          <option value="all">כל התקופה</option>
          ${yearOpts}
          <option value="last12">12 החודשים האחרונים</option>
          <option value="custom">טווח מותאם…</option>
        </select>
        <span id="periodCustom" class="period-custom" hidden>
          <input type="date" id="periodFrom" aria-label="מתאריך">
          <span>–</span>
          <input type="date" id="periodTo" aria-label="עד תאריך">
        </span>
      </div>
    </div>
    <div id="miluimStats">${miluimStatsHTML(mil)}</div>

    <div class="reconcile">
      <div class="recon-head">
        <span class="recon-ico">🔍</span>
        <div class="recon-text">
          <h3 class="recon-title">בדיקה: האם כל כספי המילואים הגיעו אליכם?</h3>
          <p class="recon-lead">כספי מילואים מגיעים בשני מסלולים נפרדים: חלק <b>ישירות לחשבון הבנק</b> מהביטוח הלאומי, וחלק מוחזר <b>דרך המעסיק — ומשולם בתלוש השכר</b>. קל לפספס תשלום שלא הגיע.</p>
        </div>
      </div>
      <button class="recon-btn" id="reconBtn">📥 הורדת דוח הבדיקה</button>
      <p class="recon-steps">הסכומים והטבלה למעלה — והדוח שתורידו — משתנים לפי <b>התקופה שתבחרו</b> (בורר התקופה ליד הכותרת). אחרי ההורדה, תנו ל<b>כל צ׳אט AI שתבחרו</b> (<bdi dir="ltr">ChatGPT, Claude, Gemini</bdi>) שלושה קבצים: <b>הדוח הזה</b>, <b>תלושי השכר</b>, ו<b>דוח ״תנועות בחשבון״ מהבנק</b> — לאותה תקופה. בקשו לבדוק שכל תשלום הגיע: גם מה שמשולם <b>דרך המעסיק בתלוש</b>, וגם <b>ההעברות הישירות</b> לבנק.</p>
    </div>

    <div id="miluimView">${miluimViewHTML(mil, '')}</div>
  </section>`;
}

// Reconciliation report (Markdown). `m.miluim` may be period-filtered; `period`
// supplies the header label. All sums come from m.miluim, which filterMiluim
// recomputes to match the filtered line items.
export function buildReconciliationReport(m, dateStr, period) {
  const mil = m.miluim, L = [], P = (s = '') => L.push(s);
  const periodLabel = period && period.active ? period.label : 'כל התקופה';
  P('# בדיקת התאמה — תגמולי מילואים (ביטוח לאומי)');
  P(`נוצר: ${dateStr} · עבור: ${m.name} (ת״ז ●●●●●${m.zehutLast4})`);
  P(`תקופת הדוח: ${periodLabel}`);
  P('');
  P('## איך לבדוק (חשוב!)');
  P('כספי מילואים מגיעים בשני מסלולים נפרדים — אל תחפשו את שניהם באותו מקום:');
  P('1. **כסף ששולם ישירות אליך** — אמור להופיע כ**העברה נכנסת לחשבון הבנק** מ"המוסד לביטוח לאומי", סביב תאריך התשלום.');
  P('2. **כסף ששולם דרך המעסיק** — **לא** יופיע בבנק כהעברה מביטוח לאומי. הוא הוחזר למעסיק, והמעסיק משלם אותך דרך **המשכורת** — לכן יש לחפשו **בתלוש השכר בלבד**, בתלוש הקרוב ביותר לתקופת המילואים / לתאריך העיבוד.');
  P('');
  P('תנו קובץ זה ל-AI יחד עם (1) דוח ״תנועות בחשבון״/עו״ש מהבנק ו-(2) תלושי השכר, ובקשו ממנו:');
  P('- לאמת שכל שורה בטבלת "ישירות אליך" מופיעה כהעברה נכנסת לבנק (תאריך + סכום נטו).');
  P('- לאמת שכל שורה בטבלת "דרך המעסיק" מופיעה כתגמול מילואים **בתלוש השכר הקרוב ביותר** לתאריכים שצוינו (תקופת המילואים / תאריך העיבוד).');
  P('- לסמן כל תשלום חסר / מאוחר / לא תואם, ולעקוב אחרי התקופות שטרם שולמו.');
  P('');
  P('## סיכום');
  P(`- ימי מילואים: ${nf.format(mil.days)} · שווי תגמולים כולל: ${nf.format(mil.totalEntitlement)} ₪`);
  P(`- תוספת 40%: ${nf.format(mil.total40)} ₪ (שולמה: ${mil.paid40 ? 'כן' : 'לא'})${mil.paid40Note ? ` — ${mil.paid40Note}` : ''}`);
  P(`- שולם לך נטו ישירות (סה״כ): ${nf.format(mil.net)} ₪ (ברוטו ${nf.format(mil.gross)}, ניכויים ${nf.format(mil.deductions)})`);
  P('');
  P('## 1) כסף ששולם ישירות אליך — לחפש בעו״ש / דוח ״תנועות בחשבון״ מהבנק');
  P('כל שורה אמורה להופיע כ**העברה נכנסת** מ"המוסד לביטוח לאומי" סביב תאריך התשלום.');
  P('| תאריך תשלום | זכאות (ברוטו) | ניכויים | נטו לבנק |');
  P('| --- | ---: | ---: | ---: |');
  for (const p of mil.payments) P(`| ${p.date || '—'} | ${nf.format(p.entitlement)} | ${nf.format(p.deductions)} | ${nf.format(p.net)} |`);
  P('');
  if (!mil.payments.length) {
    P('> לא נמצאו תשלומים ישירים בתקופה זו — ייתכן שהשירות שולם במועד מאוחר יותר. בדקו תקופה רחבה יותר או "כל התקופה".');
    P('');
  }
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

// ---------- render: mail + inquiries (one section, two panels — as in Node) ----------
// Letters list is date + subject only; the "bottom line" summary column from the
// Node dashboard needs the offline AI/pdftotext step and isn't available client-side.
function mailSection(letters, activity) {
  const LV = 6, AV = 6;
  const subjClass = (s) => s === 'גבייה' ? ' coll' : (s === 'מילואים' ? '' : ' neutral');
  const letterRows = letters.map((l, i) => `<tr class="${i >= LV ? 'hidden-row letters-extra' : ''}">
      <td class="n"><span class="num" dir="ltr">${esc(dmy(l.date))}</span></td>
      <td><span class="subj-pill${subjClass(l.subject)}">${esc(l.subject) || '—'}</span>${l.isNew ? '<span class="new-dot" title="חדש"></span>' : ''}</td>
    </tr>`).join('');
  const actRows = activity.map((a, i) => `<tr class="${i >= AV ? 'hidden-row activity-extra' : ''}">
      <td class="n"><span class="num" dir="ltr">${esc(a.date)}</span></td>
      <td class="n"><span class="num" dir="ltr">${esc(a.time)}</span></td>
      <td class="subj-cell">${esc(a.source)}</td>
      <td>${esc(a.activity)}</td>
    </tr>`).join('');
  return `<section class="sec">
    <div class="sec-head"><div class="sec-ico sky">✉️</div><h2>דואר ופניות</h2></div>
    <div class="panel">
      <div class="panel-cap"><span>מכתבים מהביטוח הלאומי</span><span class="c">${letters.length} מכתבים</span></div>
      <table><thead><tr><th>תאריך</th><th>נושא</th></tr></thead><tbody>${letterRows}</tbody></table>
      ${moreBar('lettersBtn', letters.length, LV)}
    </div>
    <div class="panel">
      <div class="panel-cap"><span>פניות ופעילות קודמת באתר</span><span class="c">${activity.length} רשומות</span></div>
      <table><thead><tr><th>תאריך</th><th>שעה</th><th>מקור</th><th>פעילות</th></tr></thead><tbody>${actRows}</tbody></table>
      ${moreBar('activityBtn', activity.length, AV)}
    </div>
  </section>`;
}

function fetchLog(meta) {
  const st = (meta && meta.status) || [];
  if (!st.length) return '';
  const items = st.map((s) => `<li><span class="${s.ok ? 'ok' : 'bad'}">${s.ok ? '✓' : '✗'}</span> <code>${esc(s.name)}</code>${s.ok ? '' : ` — <span class="bad">${esc(s.error || 'נכשל')}</span>`}</li>`).join('');
  const okCount = st.filter((s) => s.ok).length;
  return `<details class="fetchlog"><summary>סטטוס משיכת נתונים (${okCount}/${st.length})</summary><ul>${items}</ul></details>`;
}

// ---------- top-level render ----------
export function renderHTML(model, meta, now = new Date()) {
  const dateStr = `${String(now.getDate()).padStart(2, '0')}/${String(now.getMonth() + 1).padStart(2, '0')}/${now.getFullYear()}`;
  const h = now.getHours();
  const greet = h < 12 ? 'בוקר טוב' : h < 18 ? 'צהריים טובים' : 'ערב טוב';

  const html = `
  <h2 class="sr-only">לוח מצב אישי בביטוח לאומי ל${esc(model.name)}, נכון ל-${esc(dateStr)}.</h2>
  <header class="hdr">
    <div class="avatar">${esc(model.avatar)}</div>
    <div class="greet">
      <h1>${esc(greet)}${model.first ? ', ' : ''}<span class="nm">${esc(model.first)}</span> <span class="wave">👋</span></h1>
      <div class="sub"><span class="dot"></span>מצב נכון ל־<span class="num" dir="ltr">${esc(dateStr)}</span></div>
    </div>
  </header>
  ${debtsSection(model.debts)}
  ${miluimSection(model.miluim)}
  ${mailSection(model.letters, model.activity)}
  <footer>
    <div class="fline">🔒 תצוגה בלבד · הנתונים נמשכו ישירות מהאזור האישי ונשארים בדפדפן שלך</div>
    ${model.zehutLast4 ? `<div>ת״ז ●●●●●${esc(model.zehutLast4)} · נכון ל־<span class="num" dir="ltr">${esc(dateStr)}</span></div>` : ''}
    ${fetchLog(meta)}
  </footer>`;

  return { html, dateStr };
}

function render(model, meta) {
  const { html, dateStr } = renderHTML(model, meta);
  document.getElementById('app').innerHTML = html;
  wireUp(model, dateStr);
}

function wireToggleById(btnId, rowClass) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  const rows = document.querySelectorAll('.' + rowClass);
  const txt = btn.querySelector('.txt');
  const more = txt ? txt.textContent : '';
  let open = false;
  btn.addEventListener('click', () => {
    open = !open;
    rows.forEach((r) => r.classList.toggle('show', open));
    if (txt) txt.textContent = open ? 'הצג פחות' : more;
    btn.classList.toggle('open', open);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
}

function downloadMd(md, period) {
  const blob = new Blob(['﻿' + md], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const tag = period && period.active ? '-' + String(period.label).replace(/[^0-9A-Za-z]+/g, '_').replace(/^_+|_+$/g, '') : '';
  a.href = url; a.download = `btl-miluim-reconciliation${tag}.md`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function wireUp(model, dateStr) {
  const mil = model.miluim;
  const presetEl = document.getElementById('periodPreset');
  const customEl = document.getElementById('periodCustom');
  const fromEl = document.getElementById('periodFrom');
  const toEl = document.getElementById('periodTo');

  function currentPeriod() {
    const v = presetEl ? presetEl.value : 'all';
    if (v === 'last12') { const now = Date.now(); return { from: now - 365 * 864e5, to: now, label: '12 החודשים האחרונים', active: true }; }
    if (v && v[0] === 'y' && /^\d+$/.test(v.slice(1))) { const y = +v.slice(1); return { from: Date.UTC(y, 0, 1), to: Date.UTC(y, 11, 31, 23, 59, 59), label: String(y), active: true }; }
    if (v === 'custom') {
      const f = fromEl && fromEl.value ? Date.parse(fromEl.value) : null;
      const t = toEl && toEl.value ? Date.parse(toEl.value) + 864e5 - 1 : null;
      const label = `${fromEl && fromEl.value ? dmy(fromEl.value) : '…'}–${toEl && toEl.value ? dmy(toEl.value) : '…'}`;
      return { from: f, to: t, label, active: !!(f || t) };
    }
    return { from: null, to: null, label: 'כל התקופה', active: false };
  }

  function applyPeriod() {
    if (customEl && presetEl) customEl.hidden = presetEl.value !== 'custom';
    const p = currentPeriod();
    const fmil = p.active ? filterMiluim(mil, p.from, p.to) : mil;
    const statsEl = document.getElementById('miluimStats');
    if (statsEl) statsEl.innerHTML = miluimStatsHTML(fmil);
    const view = document.getElementById('miluimView');
    if (view) {
      view.innerHTML = miluimViewHTML(fmil, p.active ? p.label : '');
      wireToggleById('miluimBtn', 'miluim-extra');
    }
  }

  if (presetEl) presetEl.addEventListener('change', applyPeriod);
  if (fromEl) fromEl.addEventListener('change', applyPeriod);
  if (toEl) toEl.addEventListener('change', applyPeriod);

  wireToggleById('miluimBtn', 'miluim-extra');
  wireToggleById('lettersBtn', 'letters-extra');
  wireToggleById('activityBtn', 'activity-extra');

  const rb = document.getElementById('reconBtn');
  if (rb) {
    rb.addEventListener('click', () => {
      const p = currentPeriod();
      const fmil = p.active ? filterMiluim(mil, p.from, p.to) : mil;
      const md = buildReconciliationReport({ ...model, miluim: fmil }, dateStr, p);
      downloadMd(md, p);
    });
  }
}

function renderEmpty() {
  document.getElementById('app').innerHTML = `<div class="empty">
    <h2>אין נתונים להצגה 🤔</h2>
    <p>כדי לראות את לוח המצב:</p>
    <ol>
      <li>פתחו את <b>ps.btl.gov.il</b> והתחברו לאזור האישי.</li>
      <li>לחצו על הכפתור הירוק שמופיע בפינת המסך.</li>
    </ol>
  </div>`;
}

// ---------- boot (browser only) ----------
// Read with a short retry: the dashboard tab can load fractionally before the
// service worker's storage write settles. chrome.storage.session is in-memory.
async function readStored(tries = 10) {
  for (let i = 0; i < tries; i++) {
    const got = await chrome.storage.session.get(['btlData', 'btlMeta']);
    if (got && got.btlData) return got;
    await new Promise((r) => setTimeout(r, 120));
  }
  return {};
}

if (typeof document !== 'undefined' && typeof chrome !== 'undefined' && chrome.storage) {
  (async () => {
    try {
      const { btlData, btlMeta } = await readStored();
      if (!btlData) { renderEmpty(); return; }
      render(buildModel(btlData), btlMeta);
    } catch (e) {
      document.getElementById('app').innerHTML = `<div class="empty"><h2>שגיאה</h2><p>${esc(String((e && e.message) || e).slice(0, 200))}</p></div>`;
    }
  })();
}
