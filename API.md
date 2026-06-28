# Bituach Leumi (ביטוח לאומי) — Personal Portal API

Reverse-engineered map of the **אזור אישי** (personal service) SPA at
`https://ps.btl.gov.il`, captured live from an authenticated session on 2026-06-17.
Goal: a **read-only** scraper that, given a user's credentials, returns their
**debts, self-employed collection/payments, miluim data, and letters (PDFs)**.

> All endpoints below were observed returning `200` against a real account.
> The portal is an AngularJS (1.x) hash-route SPA; **all data comes from same-origin
> JSON APIs** under `https://ps.btl.gov.il/`. `window._BASE_URL` is `""` (same-origin).

---

## 1. Anti-bot / protection stack (read this first)

The portal sits behind **F5 BIG-IP / Shape "TS" bot defense** plus **Google reCAPTCHA**.
This is the single biggest constraint on the scraper design.

| Mechanism | Evidence | Implication for scraper |
|---|---|---|
| **F5/Shape "TS" cookies** | Bootstrap script `GET /TSbd/<hash>?type=2`; cookie `TS01b51315` set before any login | Every API call also sends header `X-TS-AJAX-Request`. The `TS*` cookie must be present & valid. A raw HTTP client cannot mint it; a **real browser engine runs the TS JS and sets it for you**. |
| **reCAPTCHA** | `_grecaptcha` key in `localStorage` on the login page | Login is gated by reCAPTCHA (token not visible in the `authenticate` body → most likely **reCAPTCHA v3 invisible**, score-based, or triggered after failures). A real browser passes it transparently; a headless client is likely to be challenged. |
| **JWT bearer** | `authenticate` returns `Token`; sent as `Authorization` header on all calls | Short-lived; see §3. |

**Conclusion:** drive login with a **real/stealth browser (Playwright/Puppeteer)** — exactly
the model `israeli-bank-scrapers` uses. Once logged in, issue the JSON calls **from inside the
page context** (`page.evaluate(() => fetch(...))`) so the `TS*` cookie and `X-TS-AJAX-Request`
header are applied automatically. Do **not** attempt a pure-axios login.

---

## 2. Login methods (observed on `#/login`)

The login form offers two flows:

1. **Classic** — `מספר זהות` (ID) + `קוד משתמש` (user code) + `סיסמה` (password).
2. **OTP** — `מספר זהות` (ID) + verification code via **SMS / voice call / email**
   (radio choice + phone prefix `קידומת` + number).

The captured session used the **classic** flow. Endpoint:

### `POST api/loginApi/authenticate`
Request body (JSON):
```jsonc
{
  "userZehut":   "<ID number / תעודת זהות>",
  "userName":    "<קוד משתמש / user code>",
  "password":    "<password>",
  "StationId":   "<client GUID>",   // see §4
  "Opt":         <login-option flag>,
  "Kidomet":     <phone prefix, OTP flow>,
  "CellMsgType": <SMS/voice/email selector, OTP flow>
}
```
Response (JSON) — this is also the **full account summary** (same shape as `GET personal/Summary`):
```jsonc
{
  "Token": "<~640-char JWT>",        // -> Authorization header for all later calls
  "TokenExpiration": "<timestamp>",
  "SessionDuration": <minutes>,
  "PassValidityNumDays": <n>,
  "NameNatzig": "", "IsInternet": true, "PasswordMessage": null,
  "name": "...", "firstName": "...", "lastName": "...",
  "currentZehut": { ... },           // see §5 — the dashboard payload
  "ochlusin": { ... },               // population-registry record (address/phone/email/DOB)
  "ishurim":  [ /* 20 */ ],          // available certificates
  "tviot":    [ /* 24 */ ],          // claims
  "states":   [ /* 21 */ ],          // services/states
  "sideNav":  [ /* 9  */ ], "topNav": [ /* 8 */ ],
  "LogoutUrl": "...", "Status": "...", "userRole": "user"
}
```

> The OTP flow almost certainly uses separate "send code" / "verify" endpoints not captured
> here (classic login was used). If the target account has a user-code+password, **prefer the
> classic flow** to avoid interactive OTP.

---

## 3. Session / auth transport (every data call)

After login the client stores, in **`sessionStorage`**:
`token` (JWT, ~640 chars), `tokenExpiration`, `userRole`, `hasPersonal`, and `user`
(the full ~50 KB summary object).

Every API request carries **three** things:
- Cookie `TS01b51315=…` (the F5 token, set automatically by the browser)
- Header `Authorization: <token>`  *(raw token value, no `Bearer ` prefix)*
- Header `X-TS-AJAX-Request: true`
- (POSTs) `Content-Type: application/json;charset=UTF-8`, `Accept: application/json, text/plain, */*`

---

## 4. StationId

`StationId` sent to `authenticate` is a **client-generated GUID** stored in
`localStorage.BLSIStationId` (format `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`). It is a
device fingerprint the client makes up once and reuses. The scraper can **generate a random
UUID v4 once and persist it** per credential set.

---

## 5. Read endpoints (all confirmed `200`)

Unless noted, these are `POST` with body `{}` and **need no query params** — they derive the
user from the JWT. (Verified: the encrypted tokens in SPA routes like
`#/Galash/D2snU6…` / `#/Miluim/4nLe_…` are **client-only navigation context**; the APIs ignore
them — bare-path calls return full data.)

| # | Endpoint | Method/body | What it returns |
|---|---|---|---|
| Dashboard | `GET personal/Summary` | GET | Whole account summary (= login response). Richest single call. |
| Contact | `api/MevutachApi/ConfirmDetails` | POST `{StationId}` | Address / email / mobile on file (the "confirm your details" step). |
| **Insurance status** | `api/MevutachApi/BerurMevutach` | POST `{}` | Residency (`toshav*`), **employment/occupation status** (`maamadot`, `Isukim`, `Idkun_isuk`), balance (`Yitra`/`YitraChiuvi`), **debts** (`chovotTashlum`), settlements (`amanot`), discharged-soldier flag (`IsChayalMeshuchrar`). |
| **Debt — NI/health** | `api/ChovotApi/ChovotGalash` | POST `{}` | Self-employed **דמי ביטוח + בריאות** debt. On a clean account: `{Info:null, InitialMessage:"לא קיימים חובות בדמי ביטוח ובריאות", InitialMessageType:"Success"}`. When debt exists, `Info` holds the breakdown. |
| **Debt — benefits** | `api/ChovotApi/ChovotGimlaot` | POST `{}` | **גמלאות** debt + repayment options (`MaxTashlumimAllowedAshrai`/`Credit`, `MinSchumLeTashlum…`, `ChovotGimlaotNew`, `HesderGimlaotTab`). |
| **Collection (gviya)** | `api/GalashApi/BerurGalash` | POST `{}` | The self-employed account ledger — see §6. |
| **Miluim** | `api/MiluimApi/BerurMiluim` | POST `{}` | Reserve-duty data — see §7. |
| **Letters list** | `api/MichtavimApi/MichtavimList?prtcl=` | POST `{}` | List of incoming letters — see §8. **The `?prtcl=` query is required** (bare path → 404). |
| **Letter PDF** | `/Michtavim/GetMichtav?…` | GET | Single letter as `application/pdf` — see §8. |
| Sent docs | `api/MismachimApi/Mismachim` | GET | Documents **you uploaded** to BTL (not letters from them). Empty → "לא נמצאו מסמכים ששלחת…". |

> **ASP.NET Web API gotcha:** routing is query-string sensitive. `MichtavimList` 404s without
> `?prtcl=`. Replay the **exact** URL+query the app uses.

---

## 6. `api/GalashApi/BerurGalash` — collection / self-employed ledger

Top-level `Info` has these tabs:

| Field | Meaning |
|---|---|
| `klaliTab` | General: `maamadot` (status, e.g. `[{Text:"עצמאי."}]` = self-employed), `ktovetSnif` (branch address), `chnBankNoHchzr` (refund bank acct), `peulotAtidiotCount` (# upcoming actions), `zchutTbl`/`zchut` (credit), `ashrai` (credit card on file: `shemChevra`,`suffix`,`tarTokef`), `mufar` (`isMufar`/`tarMufar` = in arrears), `hodaot` (messages). |
| `chiyuvAtidiTab` | Future charges: `cAtidiyim` (upcoming charges), `hesderim` (`Headers`/`Rows` — standing arrangements). |
| `dafCheshbonTab` | Account statement: `peulot` (`Headers`/`TplRows` = transactions), `knas` (penalties), `zchutChn` (credit), `YtrtChovExst` (balance-due flag). |
| **`mikdamotTab`** | **Advances / payment book (עצמאי):** `dmeiBituach` (premium advances), `pinkasHesberim` (payment-book explanations), `mikdamotOfYear`, `pinkasTitle`. |
| `isukimTab` | Occupations table (`Isukim.Headers`/`TplRows`). |
| `dafKesherTab` | Handling branch / contact (`goremMetapel`: `shemSnif`,`faxSnif`,`kodChulia`). |
| `ikulimTab` | Liens (`ikulim` — empty on clean account). |

---

## 7. `api/MiluimApi/BerurMiluim` — reserve duty

Top-level `Info` tabs:

| Field | Meaning |
|---|---|
| `TabTosefet40Ahuz` | **40% supplement:** `TashlumKolel` (total paid, e.g. `"52,686"`), `Tkufot40AhuzTbl` (periods), `ButzaTashlumLaMaasik` (paid-to-employer flag), `HodaatChn` (where funds were transferred). |
| `TabTashlumim` | Payments: `KaspitTbl` (payment rows), `HodaatChn`, `ZakautTashlumKot`, `Nose`. |
| `TabTkufotIdf` | IDF service periods used for the calc (`TkufotIdfTbl`, `SugSherutInTable`). |
| `TabTviotIshiyot` | Personal reserve-duty claims (`TviotTbl`). |
| `TabTviotMaasik` | Employer-filed claims (`TviotMaasikTbl`, `HodaatTashlumLaMaasik`). |
| `TabMitzuyZchuyot` | Rights-utilization (`MitzuyTbl`, `HagashatTviaHodaa`). |
| `TkufatCharvotBarzelExists` | Boolean — **"חרבות ברזל" (Iron Swords war) period** present. |

Claim submission lives at SPA route `#/Tviot/Miluim/` (out of scope — read-only).

---

## 8. Letters (מכתבים) — list + PDF download

### List: `POST api/MichtavimApi/MichtavimList?prtcl=`  (body `{}`)
```jsonc
{
  "Letters": [            // 75 on this account
    {
      "BtlSubjectName": "גבייה",     // subject area
      "LetterDate": "07/06/2026",
      "Oid": "hrNqlA7ZBgmxzHA60uubGQ--",  // encrypted doc id
      "letterId": 0,
      "Kod_Maarechet": "VN",         // source system (VN=gviya, NK=miluim, …)
      "DocumentSubType": 0,
      "FileName": null,
      "Attachments": null, "hasAttachments": false,
      "isNew": <bool>, "isMevutal": <bool>,   // unread / cancelled
      "isAccessible": <bool>, "SugMezahe": null, "VaadaDate": "..."
    }
    // …
  ],
  "Protocols": [], "Tviot": [],
  "hideEnvelopeCol": true, "showAttachmentsMsg": false
}
```

### Download one letter: `GET /Michtavim/GetMichtav?…`
Build the query string from the letter row fields (all of them, URL-encoded):
```
/Michtavim/GetMichtav
  ?BtlSubjectName=<BtlSubjectName>
  &DocumentSubType=<DocumentSubType>
  &FileName=<FileName>
  &LetterId=<letterId>
  &LetterDate=<LetterDate>
  &Oid=<Oid>
  &Kod_Maarechet=<Kod_Maarechet>
  &Attachments=<Attachments>
  &SugMezahe=<SugMezahe>
  &NotAccessible=<!isAccessible>
```
**Verified:** returns `200`, `Content-Type: application/pdf`, real PDF bytes (`%PDF-…`,
~97 KB for the sample). The SPA's `showLetter()` / `downloadLetter()` build exactly this URL.

Per-domain letter lists also exist (same `MichtavimList` shape, different filter), surfaced at
`#/Galash/Michtavim/VN/…`, `#/Miluim/Michtavim/NK/…`, `#/Avtala/Michtavim/HV/…`,
`#/Yeladim/Michtavim/GL/…`. The unified `#/My/Michtavim/all/` returns everything.

---

## 9. Recommended scraper architecture

```
btl-scraper/
  scrape.js        # Playwright: open login, USER enters creds (+OTP), wait for #/Personal/Summary
  api.js           # page.evaluate wrappers around the §5 endpoints (run inside page ctx)
  sections/        # one module per area: debts, gviya, miluim, letters
  out/             # raw JSON per section + downloaded letter PDFs + index.json
```
Flow:
1. **Login in a real browser** (headful first run so the user can solve reCAPTCHA/OTP). Persist
   the browser profile / `TS*` cookies + `BLSIStationId` to reduce re-challenges.
2. After `sessionStorage.token` exists, call each endpoint via `page.evaluate(fetch)` → write
   `out/<section>.json` (raw, machine-readable — matches the chosen "raw JSON" output).
3. Letters: list → loop `GetMichtav` → save `out/letters/<date>_<subject>_<Oid>.pdf` + `index.json`.
4. **Read-only guarantee:** only `GET`/`POST {}` inquiry endpoints; never touch payment
   (`#/Galash/VnPayment2`), standing-order, bank-update, claim-submission, or upload routes.

### Auth-strategy recommendation
Given F5 + reCAPTCHA, **"reuse a logged-in browser session" is the robust choice**:
the user logs in once (headful), the tool reuses the persisted profile and re-runs the
read calls. Full unattended headless login would have to defeat F5 + reCAPTCHA v3 and will be
brittle. Revisit only if the account reliably skips reCAPTCHA on password login.

---

## Appendix — Hebrew/transliteration glossary
`Berur` בירור = inquiry · `Mevutach` מבוטח = insured · `Galash`/`gviya` גבייה = collection ·
`Chovot` חובות = debts · `Gimlaot` גמלאות = benefits · `Mikdamot` מקדמות = advances ·
`Maamad` מעמד = (employment) status · `Isuk` עיסוק = occupation · `Toshav` תושב = resident ·
`Yitra` יתרה = balance · `Zchut`/`leZchut` לזכות = credit/in-credit · `Amanot` אמנות = settlements ·
`Ikulim` עיקולים = liens · `Knas` קנס = penalty · `Michtav(im)` מכתבים = letters ·
`Mismachim` מסמכים = documents · `Tviot` תביעות = claims · `Ishurim` אישורים = certificates ·
`Miluim` מילואים = reserve duty · `Tosefet 40 Ahuz` תוספת 40% = 40% supplement ·
`Charvot Barzel` חרבות ברזל = "Iron Swords" war.
