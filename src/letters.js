// src/letters.js
// Lists the user's letters (Michtavim) from the Bituach Leumi personal portal and
// downloads each one as a PDF. READ-ONLY: only the inquiry list endpoint and the
// GetMichtav download endpoint are used — nothing is ever written back to the portal.
//
// Incremental by default: letters whose Oid already has a downloaded PDF on disk
// are skipped, so re-runs only fetch NEW letters. The on-disk index.json is the
// record of what we already have; it is merged (never clobbered) across runs.

import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import path from 'path';
import { callJson, downloadBinary } from './api.js';

/**
 * Sanitize a string for use in a filename: keep Hebrew letters, Latin word chars
 * and digits, collapse everything else into single underscores, trim edges.
 * @param {string} s
 * @returns {string}
 */
function sanitize(s) {
  return String(s == null ? '' : s)
    // Replace any run of characters that are NOT Hebrew/word chars with a single '_'.
    .replace(/[^֐-׿\w]+/g, '_')
    // Trim leading/trailing underscores.
    .replace(/^_+|_+$/g, '')
    || 'letter';
}

/**
 * A letter's STABLE identity across sessions.
 *
 * The portal's `Oid` is an encrypted handle that is re-minted on every login, so
 * it cannot identify a letter across runs. These fields are stable: subject area
 * + source system + document subtype + date. An ordinal (assigned in list order)
 * disambiguates multiple letters that share all four on the same day.
 *
 * @param {object} row
 * @returns {string}
 */
function groupKey(row) {
  return [row.BtlSubjectName, row.Kod_Maarechet, row.DocumentSubType, row.LetterDate].join('|');
}

/**
 * Normalize a letter date into YYYY-MM-DD for use in the filename.
 * Falls back to a sanitized form of the raw value if it isn't parseable.
 * @param {string} raw
 * @returns {string}
 */
function formatDate(raw) {
  if (!raw) return 'unknown-date';
  // ISO-ish strings (e.g. "2025-12-31T00:00:00") — take the date portion.
  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(raw));
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  // DD/MM/YYYY (the portal's common format) -> YYYY-MM-DD.
  const dmy = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(String(raw));
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  const d = new Date(raw);
  if (!Number.isNaN(d.getTime())) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  return sanitize(raw);
}

/**
 * Build the GetMichtav query string from a MichtavimList row.
 * Each field value is URL-encoded. The field set is fixed by the portal's own
 * letter-download links; LetterId comes from row.letterId and NotAccessible is the
 * negation of row.isAccessible.
 * @param {object} row
 * @returns {string}
 */
function buildGetMichtavQuery(row) {
  // [api field name, value] — order mirrors the portal's own request.
  const fields = [
    ['BtlSubjectName', row.BtlSubjectName],
    ['DocumentSubType', row.DocumentSubType],
    ['FileName', row.FileName],
    ['LetterId', row.letterId],
    ['LetterDate', row.LetterDate],
    ['Oid', row.Oid],
    ['Kod_Maarechet', row.Kod_Maarechet],
    ['Attachments', row.Attachments],
    ['SugMezahe', row.SugMezahe],
    ['NotAccessible', !row.isAccessible],
  ];
  return fields
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v == null ? '' : v)}`)
    .join('&');
}

/**
 * List the user's letters and download each NEW one as a PDF.
 *
 * @param {import('./session.js').Session} session  authenticated session
 * @param {string} outDir                  output directory (PROJECT_ROOT/out)
 * @param {object} [opts]
 * @param {number|null} [opts.limit]       max number of NEW letters to download (null = all)
 * @param {boolean} [opts.onlyNew=true]    skip letters already downloaded on disk
 * @param {Function} [opts.log]            progress logger (default console.error)
 * @returns {Promise<{ total:number, downloaded:number, skipped:number, failed:number }>}
 */
export async function fetchLetters(session, outDir, { limit = null, onlyNew = true, log = console.error } = {}) {
  const lettersDir = path.join(outDir, 'letters');
  await fs.mkdir(lettersDir, { recursive: true });
  const indexPath = path.join(lettersDir, 'index.json');

  // Load the prior index so we know which letters we already have.
  let prevIndex = [];
  try {
    prevIndex = JSON.parse(await fs.readFile(indexPath, 'utf8'));
    if (!Array.isArray(prevIndex)) prevIndex = [];
  } catch {
    prevIndex = [];
  }
  // Index prior entries by their stable key; a key counts as "have" only if its
  // PDF exists on disk.
  const byKey = new Map();
  const haveKeys = new Set();
  for (const e of prevIndex) {
    if (!e || !e.key) continue;
    byKey.set(e.key, e);
    if (e.file && existsSync(path.join(lettersDir, e.file))) haveKeys.add(e.key);
  }

  // 1) Fetch the letters list. The ?prtcl= query is REQUIRED, and binds to a
  //    BOOLEAN on the server: omitting it 404s, an empty value (?prtcl=) 400s.
  //    The portal's own app sends ?prtcl=false.
  log('Letters: fetching list…');
  const list = await callJson(session, {
    method: 'POST',
    path: 'api/MichtavimApi/MichtavimList',
    query: 'prtcl=false',
  });

  // 2) Persist the raw list exactly as returned.
  await fs.writeFile(path.join(lettersDir, 'list.json'), JSON.stringify(list, null, 2), 'utf8');

  const all = (list && list.Letters) || [];
  const total = all.length;

  // Attach a stable key + ordinal to each letter (ordinal disambiguates letters
  // that share subject/system/subtype/date, assigned in the list's own order).
  const ordinals = new Map();
  const keyed = all.map((row) => {
    const g = groupKey(row);
    const ord = ordinals.get(g) || 0;
    ordinals.set(g, ord + 1);
    return { row, key: `${g}#${ord}`, ord };
  });

  // 3) Decide which letters to download.
  let toFetch = onlyNew ? keyed.filter((k) => !haveKeys.has(k.key)) : keyed.slice();
  const skipped = total - toFetch.length;
  if (typeof limit === 'number' && limit >= 0) toFetch = toFetch.slice(0, limit);

  log(`Letters: ${total} on portal, ${haveKeys.size} already downloaded, ${toFetch.length} to fetch.`);

  let downloaded = 0;
  let failed = 0;

  for (let i = 0; i < toFetch.length; i++) {
    const { row, key, ord } = toFetch[i];
    const date = formatDate(row.LetterDate);
    const subject = sanitize(row.BtlSubjectName);
    // Filename must be 1:1 with the stable key, so it includes every key part
    // (subject, system, subtype, date, ordinal) — otherwise letters differing
    // only by subtype would collide and overwrite each other.
    const file = `${date}_${subject}_${sanitize(row.Kod_Maarechet)}_${row.DocumentSubType}_${ord}.pdf`;
    const filePath = path.join(lettersDir, file);
    const base = { key, date, subject: row.BtlSubjectName, kod: row.Kod_Maarechet, ord };

    try {
      const url = `/Michtavim/GetMichtav?${buildGetMichtavQuery(row)}`;
      const { status, contentType, buffer } = await downloadBinary(session, url);

      if (status >= 200 && status < 300 && contentType && /pdf/i.test(contentType) && buffer.length) {
        await fs.writeFile(filePath, buffer);
        downloaded++;
        byKey.set(key, { ...base, file, bytes: buffer.length });
        log(`Letters: [${i + 1}/${toFetch.length}] ${file} (${buffer.length} bytes)`);
      } else {
        failed++;
        byKey.set(key, { ...base, file: null, bytes: 0, error: `status ${status}, content-type ${contentType || 'unknown'}` });
        log(`Letters: [${i + 1}/${toFetch.length}] skipped — status ${status}, type ${contentType || 'unknown'}`);
      }
    } catch (err) {
      // Per-letter error must not abort the rest.
      failed++;
      byKey.set(key, { ...base, file: null, bytes: 0, error: err.message });
      log(`Letters: [${i + 1}/${toFetch.length}] error — ${err.message}`);
    }
  }

  // 4) Write the merged index: current-list order first, then any older
  //    downloaded letters no longer in the list.
  const listedKeys = new Set(keyed.map((k) => k.key));
  const index = [];
  for (const k of keyed) if (byKey.has(k.key)) index.push(byKey.get(k.key));
  for (const [key, e] of byKey) if (!listedKeys.has(key)) index.push(e);
  await fs.writeFile(indexPath, JSON.stringify(index, null, 2), 'utf8');

  log(
    `Letters: done — ${downloaded} new downloaded, ${skipped} already had` +
      (failed ? `, ${failed} failed` : '') +
      ` (${total} on portal).`
  );
  return { total, downloaded, skipped, failed };
}
