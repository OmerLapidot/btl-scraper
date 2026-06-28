// src/branches.js
//
// The registry of READ-ONLY "branches" of the Bituach Leumi personal portal,
// plus a driver that runs the selected ones and writes their output.
//
// A branch is a named, independently-selectable data area (chosen via the
// BTL_BRANCHES config). Each branch is one of three kinds:
//   - endpoint : fetch JSON from an allowlisted API path and write one file.
//   - from-login: reuse the login response (the account summary) — no extra call.
//   - run      : a custom function (the letters branch, which writes many files).
//
// Every `endpoint.path` here must also be on the ALLOWED_ENDPOINTS allowlist in
// api.js; callJson re-checks at call time, so a stray entry can never reach the
// network. None of these endpoints mutate account state.

import path from 'path';
import fs from 'fs/promises';
import { callJson } from './api.js';
import { fetchLetters } from './letters.js';

// Auth artifacts in the login response that aren't account data — kept out of
// the saved summary.json.
const SUMMARY_OMIT = new Set(['Token', 'TokenExpiration']);
const stripAuth = (obj) =>
  Object.fromEntries(Object.entries(obj || {}).filter(([k]) => !SUMMARY_OMIT.has(k)));

export const BRANCHES = [
  // Whole-account summary — the login response itself (not a separate API call).
  { name: 'summary', file: 'summary.json', from: 'login' },

  // Insurance status / residency / occupations / debts summary.
  { name: 'mevutach', file: 'mevutach.json', endpoint: { method: 'POST', path: 'api/MevutachApi/BerurMevutach' } },

  // National-insurance + health-premium debt (self-employed).
  { name: 'debt-insurance-health', file: 'debt-insurance-health.json', endpoint: { method: 'POST', path: 'api/ChovotApi/ChovotGalash' } },

  // Benefits (gimlaot) debt.
  { name: 'debt-benefits', file: 'debt-benefits.json', endpoint: { method: 'POST', path: 'api/ChovotApi/ChovotGimlaot' } },

  // Collection / gviya ledger.
  { name: 'collection', file: 'collection-gviya.json', endpoint: { method: 'POST', path: 'api/GalashApi/BerurGalash' } },

  // Reserve-duty (miluim) data.
  { name: 'miluim', file: 'miluim.json', endpoint: { method: 'POST', path: 'api/MiluimApi/BerurMiluim' } },

  // Documents the user uploaded.
  { name: 'documents-sent', file: 'documents-sent.json', endpoint: { method: 'GET', path: 'api/MismachimApi/Mismachim' } },

  // Previous inquiries to the portal (פניות קודמות). User-approved.
  { name: 'previous-inquiries', file: 'previous-inquiries.json', endpoint: { method: 'GET', path: 'api/PersonalApi/PniyotKodmot' } },

  // Letters — special: lists, then downloads NEW letter PDFs into out/letters/.
  { name: 'letters', run: (session, cfg, log) => fetchLetters(session, cfg.outDir, { limit: cfg.lettersLimit, onlyNew: cfg.lettersOnlyNew, log }) },
];

/** All known branch names, in run order. */
export const BRANCH_NAMES = BRANCHES.map((b) => b.name);

/**
 * Resolve a requested branch list (e.g. from BTL_BRANCHES) into a Set of names.
 * Null/empty selects ALL branches. Unknown names throw with the valid list.
 *
 * @param {string[]|null|undefined} requested
 * @returns {Set<string>}
 */
export function resolveSelection(requested) {
  if (!requested || requested.length === 0) return new Set(BRANCH_NAMES);
  const valid = new Set(BRANCH_NAMES);
  const unknown = requested.filter((n) => !valid.has(n));
  if (unknown.length) {
    throw new Error(`Unknown branch(es): ${unknown.join(', ')}. Valid branches: ${BRANCH_NAMES.join(', ')}.`);
  }
  // Preserve registry order regardless of how the user listed them.
  return new Set(BRANCH_NAMES.filter((n) => requested.includes(n)));
}

/**
 * Run the selected branches, writing each one's output. A failure in one branch
 * is logged and recorded but does NOT abort the rest.
 *
 * @param {import('./session.js').Session} session  authenticated session
 * @param {object} cfg                               resolved config (outDir, letters opts)
 * @param {Set<string>} selected                     branch names to run
 * @param {(...a:any[])=>void} log                   progress logger
 * @returns {Promise<Array<{name:string, ok:boolean, file?:string, error?:string, result?:any}>>}
 */
export async function runBranches(session, cfg, selected, log = console.error) {
  const results = [];

  for (const b of BRANCHES) {
    if (!selected.has(b.name)) continue;
    try {
      if (b.run) {
        const result = await b.run(session, cfg, log);
        results.push({ name: b.name, ok: true, result });
      } else {
        const data = b.from === 'login' ? stripAuth(session.loginSummary) : await callJson(session, b.endpoint);
        await fs.writeFile(path.join(cfg.outDir, b.file), JSON.stringify(data, null, 2));
        log(`  [branch] ${b.name} -> ${b.file}`);
        results.push({ name: b.name, ok: true, file: b.file });
      }
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      log(`  [branch] ${b.name} FAILED: ${message}`);
      results.push({ name: b.name, ok: false, error: message });
    }
  }

  return results;
}
