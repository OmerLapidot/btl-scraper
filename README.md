# btl-scraper

A **read-only** scraper for the Israeli National Insurance personal portal
(Bituach Leumi / ביטוח לאומי — <https://ps.btl.gov.il>).

It logs into your own account through the portal's JSON login API (no browser),
then reads your personal data through the portal's JSON API and saves it to disk:
insurance/residency status, debts, the collection (גבייה) ledger, reserve-duty
(מילואים) data, the documents you've sent, and your letters as PDFs. It also
generates a Hebrew reserve-duty report from the raw data.

> ## READ-ONLY GUARANTEE
>
> **This tool only reads. It never writes anything to your Bituach Leumi account.**
>
> It calls inquiry-only endpoints — `personal/Summary`, the various `Berur*`
> ("inquiry") APIs, the debt/collection reads, the letters list, and letter-PDF
> downloads. POST calls are sent with an **empty body** because these endpoints
> derive everything from your login. The scraper performs **no payments, no
> standing orders, no claim submissions, no file uploads, and no profile edits**.
> There is no code path that can change the state of your account.

---

## What it does

The scraper reads a set of **branches** — independently selectable data areas
(see [Branches](#branches)). By default it runs all of them, saving each to
`out/`:

| Branch                | File                              | What it is                                                    |
| --------------------- | --------------------------------- | ------------------------------------------------------------- |
| `summary`             | `out/summary.json`                | Whole-account summary (the login response)                    |
| `mevutach`            | `out/mevutach.json`               | Insurance/residency status, occupations, debts summary        |
| `debt-insurance-health` | `out/debt-insurance-health.json` | National-insurance + health-premium debt (self-employed)     |
| `debt-benefits`       | `out/debt-benefits.json`          | Benefits (gimlaot) debt                                       |
| `collection`          | `out/collection-gviya.json`       | Collection ledger (klali / mikdamot / daf-cheshbon tabs…)     |
| `miluim`              | `out/miluim.json`                 | Reserve-duty (miluim) data — payments, claims, 40% top-up…    |
| `documents-sent`      | `out/documents-sent.json`         | Documents you uploaded to the portal                          |
| `previous-inquiries`  | `out/previous-inquiries.json`     | Your past inquiries to the portal (פניות קודמות)              |
| `letters`             | `out/letters/`                    | Your letters as PDFs (see below)                              |

The `letters` branch downloads your **letters**:

- `out/letters/list.json` — the raw letters list returned by the portal.
- `out/letters/<YYYY-MM-DD>_<subject>_<kod>_<subtype>_<ord>.pdf` — one PDF per letter.
- `out/letters/index.json` — a cumulative index of every downloaded letter
  (`{ key, date, subject, kod, ord, file, bytes }`).

The reserve-duty report tool turns `out/miluim.json` into:

- `out/miluim-report.json` — structured report data.
- `out/דוח-מילואים.md` — a human-readable Hebrew report.

The portal's API was reverse-engineered from live traffic. The full endpoint and
auth documentation lives in
[`finance-reviewer/btl-scraper/API.md`](../finance-reviewer/btl-scraper/API.md).

---

## Install

Requires **Node.js 18+** (the project is ESM — `"type": "module"`). The scraper
has **no npm dependencies** — it talks to the portal with Node's built-in `fetch`.

```bash
npm install   # nothing to download; the scraper is dependency-free
```

> The optional `npm run letters:content` step (extracting letter text to JSON)
> shells out to **`pdftotext`** (Poppler). On macOS: `brew install poppler`.

---

## Credentials

The scraper uses your normal password-login for the portal — the same three
fields as the website's login form:

| Env variable    | Hebrew field | Meaning                | Constraints      |
| --------------- | ------------ | ---------------------- | ---------------- |
| `BTL_ID`        | מספר זהות     | ID number              | 9 digits         |
| `BTL_USER_CODE` | קוד משתמש     | User code              | up to 8 chars    |
| `BTL_PASSWORD`  | סיסמה        | Password               | up to 10 chars   |

All three are required. (The portal's separate OTP login form is **not** used.)

---

## Setup

Copy the example env file and fill in your real values:

```bash
cp .env.example .env
# then edit .env
```

`.env` (in the project root) holds your credentials and is **gitignored** — it is
never committed.

Optional settings (also in `.env.example`):

| Env variable           | Default  | What it does                                                                 |
| ---------------------- | -------- | --------------------------------------------------------------------------- |
| `BTL_BRANCHES`         | (blank)  | Comma-separated branches to read; blank = all. See [Branches](#branches).   |
| `BTL_TIMEOUT`          | `120000` | Per-request timeout in milliseconds.                                        |
| `BTL_DOWNLOAD_LETTERS` | `1`      | `0` skips the letters branch (same as omitting `letters` from `BTL_BRANCHES`). |
| `BTL_LETTERS_LIMIT`    | (blank)  | Cap on how many **new** letters to download; blank = all.                  |
| `BTL_LETTERS_ALL`      | `0`      | `1` re-downloads every letter; default only fetches new ones.              |

---

## Branches

Each data area is a named **branch**. `BTL_BRANCHES` selects which to read
(comma-separated); leaving it blank reads them all. Names:

```
summary, mevutach, debt-insurance-health, debt-benefits,
collection, miluim, documents-sent, previous-inquiries, letters
```

```bash
# Only reserve-duty data and letters:
BTL_BRANCHES=miluim,letters npm run scrape
```

An unknown branch name aborts with the list of valid names. Every branch maps to
an endpoint on a **frozen read-only allowlist** in `src/api.js`
(`ALLOWED_ENDPOINTS`): any path not on that list throws *before* a request is
sent. There is no endpoint probing or pattern matching — adding a new branch
requires deliberately adding its (verified, non-mutating) endpoint to the
allowlist. This is what makes the read-only guarantee structural, not just a
convention.

---

## Usage

```bash
# Log in (API), read every section, and download any NEW letters into out/
npm run scrape

# Build the Hebrew reserve-duty report from out/miluim.json
npm run report:miluim

# Extract the text of every downloaded letter PDF into out/letters/contents.json
npm run letters:content

# Build a light, clear visual dashboard (out/dashboard.html) from the scraped data
npm run dashboard
```

`npm run dashboard` writes a self-contained, RTL Hebrew **dashboard** to
`out/dashboard.html` — open it in any browser (no server needed). It highlights
whether you have debts; a miluim summary + per-period table (same-period rows for
you and an employer are merged; reported-but-unpaid periods are flagged at the top
with an **estimated** entitlement; latest 5 with a "show more"); a one-click
**reconciliation report** download (hand it to an AI with your bank statement +
payslips to check every payment arrived); and your mail (with a real "bottom line"
summary per letter) + previous-inquiries tables.

> The mail "bottom line" column reads `out/letters/summaries.json` (AI-generated
> per-letter summaries) when present, and falls back to each letter's `הנדון`
> line otherwise. The unpaid-period figures are estimates based on your recent
> daily rate, not official BTL amounts.

`npm run scrape` only downloads letters it doesn't already have on disk; set
`BTL_LETTERS_ALL=1` to re-download everything.

Progress is logged to **stderr**; **stdout** is reserved for data, so you can pipe
output cleanly. Exit code `0` means success, `1` means missing credentials, and
`2` means a run failure (e.g. login was rejected).

The reserve-duty report can also be pointed at a specific file:

```bash
node src/report-miluim.js path/to/miluim.json
```

---

## How login works (no browser)

The portal is an AngularJS single-page app sitting behind **F5 / Shape ("TS")
bot defense** and **Google reCAPTCHA**. In practice, though, the password-login
JSON API (`POST api/loginApi/authenticate`) is reachable with a plain HTTPS
client: the scraper posts your three credentials and gets back a short-lived JWT
plus session cookies, then reuses them for every read call. **No browser, no
window, no captcha to solve.**

- A device fingerprint (`StationId`, a random UUID) is generated once and saved
  to `.station-id` in the project root (gitignored), then reused across runs so
  the portal sees a returning device.
- If the portal ever tightens its bot defense and starts rejecting the API
  login, you'd see a `Login failed` error — at that point a browser-based login
  would have to be reintroduced. It isn't needed today.

---

## Output layout

```
out/
├── summary.json                 # whole-account summary
├── mevutach.json                # insurance / residency status
├── debt-insurance-health.json   # NI + health-premium debt
├── debt-benefits.json           # benefits debt
├── collection-gviya.json        # collection / גבייה ledger
├── miluim.json                  # reserve-duty data
├── documents-sent.json          # documents you uploaded
├── previous-inquiries.json      # your past inquiries to the portal
├── dashboard.html               # generated by dashboard — light visual dashboard
├── miluim-report.json           # generated by report:miluim
├── דוח-מילואים.md                # generated by report:miluim
└── letters/
    ├── list.json                # raw letters list (current portal response)
    ├── index.json               # cumulative index of downloaded letters (stable keys)
    ├── contents.json            # generated by letters:content — extracted text per letter
    ├── summaries.json           # AI-generated "bottom line" per letter (used by dashboard)
    └── <YYYY-MM-DD>_<subject>_<kod>_<subtype>_<ord>.pdf   # one PDF per letter
```

> Letter PDF filenames (and the `index.json` keys) are built from **stable**
> fields — subject, source system (`kod`), document subtype, date, and an ordinal
> for same-day duplicates. The portal's `Oid` handle is **not** used for identity
> because it is re-minted on every login.

---

## Troubleshooting

- **`Login failed`.** Almost always wrong credentials — double-check your
  `BTL_ID` / `BTL_USER_CODE` / `BTL_PASSWORD` in `.env`. The portal's own message
  (e.g. a locked account) is included in the error when it provides one.

- **`400 The request is invalid` when fetching letters.** The letters-list
  endpoint's `prtcl` query binds to a **boolean**: it must be `?prtcl=false`
  (omitting it 404s; an empty `?prtcl=` 400s). The scraper already sends the
  correct value; if you call the API by hand, don't drop it.

- **"Token expired" / 401 partway through.** The session JWT is short-lived. Just
  re-run `npm run scrape` to log in fresh and obtain a new token.

---

## Privacy

Everything this tool produces — your credentials in `.env`, the per-section JSON,
and the letter PDFs in `out/` — is your private financial and personal data. Both
`.env` and `out/` are gitignored. Do not commit or transmit them.
