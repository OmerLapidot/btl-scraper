# BTL Dashboard — Chrome extension (v0.2.1, test build)

A **read-only** browser extension that shows a clean Hebrew dashboard of your
Bituach Leumi (ביטוח לאומי) personal area — debts, miluim, letters, and past
inquiries.

## How it works (and why it's safe)

- It does **not** ask for, store, or transmit your password. You log into
  `ps.btl.gov.il` yourself, as usual.
- Once you're logged in, the extension reuses the session your browser already
  holds (the JWT the portal keeps in `sessionStorage`) to call the same
  **read-only** inquiry endpoints the portal's own app uses.
- The fetched data is kept **in memory only** (`chrome.storage.session`, wiped when
  you close the browser) and rendered into a local dashboard tab. **Nothing is sent
  to any server** — the only network calls are same-origin reads to `ps.btl.gov.il`.
- The endpoint list mirrors the scraper's read-only allowlist: no payments, edits,
  claim submissions, or uploads.

## Install (load unpacked — for testing)

1. Open Chrome and go to `chrome://extensions`.
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and select this `extension/` folder.
4. Go to <https://ps.btl.gov.il> and log in.
5. A green **"📊 הצג את לוח המצב שלי"** button appears at the bottom corner —
   click it. The dashboard opens in a new tab.

## התקנה (מצב בדיקה)

1. פתחו ב‑Chrome את הכתובת `chrome://extensions`.
2. הדליקו **מצב מפתח** (Developer mode) למעלה מימין.
3. לחצו **טען תוסף לא ארוז** (Load unpacked) ובחרו את תיקיית `extension/`.
4. היכנסו ל‑<https://ps.btl.gov.il> והתחברו לאזור האישי.
5. כפתור **"📊 הצג את לוח המצב שלי"** יופיע בפינה התחתונה — לחצו עליו, והדשבורד ייפתח בלשונית חדשה.

> אחרי כל ריענון של התוסף ב‑`chrome://extensions`, רעננו גם את לשונית ביטוח לאומי (⌘R) — אחרת הכפתור לא יופיע.

## What's in this build

- ✅ Live-session fetch of: insurance status, NI/health debt, benefits debt,
  collection ledger, miluim, sent documents, previous inquiries, letters list.
- ✅ **Full** dashboard — same model + render as the Node tool: debts verdict,
  the complete miluim section (days, total entitlement, 40%, net-paid, the
  per-period table with pending estimates), the **reconciliation-report download**,
  letters, and previous inquiries.
- ✅ Miluim numbers are computed in-browser by a verbatim port of
  `src/report-miluim.js` (verified byte-identical against the Node output).
- ✅ **Fully local:** fonts are bundled into the stylesheet (no Google Fonts /
  external request) and a strict Content-Security-Policy is applied — the only
  network call the extension makes is the same-origin read to `ps.btl.gov.il`.
- ✅ A "fetch status" expander at the bottom shows per-endpoint success/failure.

## Known limits (next iterations)

- The letters table shows date + subject only. The "bottom line" (שורה תחתונה)
  summary column from the Node dashboard needs the offline AI-summaries +
  `pdftotext` step, which can't run inside a pure-local extension.
- Letter **PDFs** aren't downloaded — only the list is shown.
- No email and no scheduling — this is the on-demand, click-to-view version.

## Troubleshooting

- **`Cannot read properties of undefined (reading 'sendMessage')` / button does
  nothing after a reload:** you reloaded the extension while the BTL tab was open,
  which orphaned the old content script. **Refresh the ps.btl.gov.il tab (⌘R)**,
  then click the button. Rule: after reloading the extension, always refresh the
  BTL tab.
- **No button appears:** make sure you're actually logged in (the personal area is
  visible), then wait a couple of seconds — the button polls for your session.
- **The dashboard says "no data" or an endpoint failed:** open the "fetch status"
  expander at the bottom of the dashboard, and check the service-worker console at
  `chrome://extensions` → this extension → *Inspect views: service worker*.
