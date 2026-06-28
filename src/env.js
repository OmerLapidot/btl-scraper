// src/env.js — environment / configuration loader for the BTL scraper.
//
// Mirrors the loadEnv() helper from the sibling finance-reviewer/scrape.js:
// reads a project-root .env (KEY=VALUE per line) WITHOUT overriding values that
// are already present in process.env. All progress is logged to console.error;
// stdout is reserved for data.
//
// NOTE on paths: this file lives in src/, so the project root is one level up.
// We resolve outDir relative to the project root using import.meta.url, and
// return it as a plain filesystem path string.

import fs from 'fs';
import { fileURLToPath } from 'url';

/**
 * Load the project-root .env file into process.env.
 * - .env lives one level up from this file (project root), i.e. '../.env'.
 * - Existing process.env values are NOT overridden.
 * - A missing .env file is silently ignored (we just use process.env).
 *
 * KEY=VALUE lines are parsed; surrounding quotes are stripped. Mirrors the
 * loadEnv() helper in the sibling finance-reviewer/scrape.js.
 */
export function loadEnv() {
  try {
    const envUrl = new URL('../.env', import.meta.url); // project-root/.env
    const txt = fs.readFileSync(fileURLToPath(envUrl), 'utf8');
    for (const line of txt.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (m && !(m[1] in process.env)) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch {
    /* no .env file (or unreadable) — fall back to process.env as-is */
  }
}

/**
 * Build the runtime configuration from process.env.
 * Call loadEnv() before getConfig() so .env values are present.
 *
 * @returns {{
 *   credentials: { userZehut: string|undefined, userName: string|undefined, password: string|undefined },
 *   timeout: number,
 *   downloadLetters: boolean,
 *   lettersLimit: number|null,
 *   lettersOnlyNew: boolean,
 *   branches: string[]|null,
 *   baseUrl: string,
 *   outDir: string,
 * }}
 */
export function getConfig() {
  // Resolve project-root-relative directories to absolute filesystem paths.
  // env.js is in src/, so '../out/' points at the project root, not at src/.
  const outDir = fileURLToPath(new URL('../out/', import.meta.url));

  return {
    // The three login fields, mapped to the API field names used by the portal.
    credentials: {
      userZehut: process.env.BTL_ID, // מספר זהות / ID number (9 digits)
      userName: process.env.BTL_USER_CODE, // קוד משתמש / user code (<=8 chars)
      password: process.env.BTL_PASSWORD, // סיסמה / password (<=10 chars)
    },
    // Per-request timeout in ms (default 2 minutes).
    timeout: Number(process.env.BTL_TIMEOUT || 120000),
    // Download letter PDFs by default; set BTL_DOWNLOAD_LETTERS=0 to skip.
    downloadLetters: process.env.BTL_DOWNLOAD_LETTERS !== '0',
    // Optional cap on how many NEW letters to download (null = all).
    lettersLimit: process.env.BTL_LETTERS_LIMIT ? Number(process.env.BTL_LETTERS_LIMIT) : null,
    // Only download letters not already on disk; BTL_LETTERS_ALL=1 forces all.
    lettersOnlyNew: process.env.BTL_LETTERS_ALL !== '1',
    // Which branches to read (comma-separated names). Null/blank = all branches.
    branches: process.env.BTL_BRANCHES
      ? process.env.BTL_BRANCHES.split(',').map((s) => s.trim()).filter(Boolean)
      : null,
    // Portal origin; relative API paths resolve against this.
    baseUrl: 'https://ps.btl.gov.il',
    // Where section JSON + letter PDFs are written (project-root/out).
    outDir,
  };
}

/**
 * A credentials object is "configured" only when all three values are
 * present and non-empty.
 *
 * @param {{ userZehut?: string, userName?: string, password?: string }} credentials
 * @returns {boolean}
 */
export function isConfigured(credentials) {
  const values = [credentials.userZehut, credentials.userName, credentials.password];
  return values.every((v) => v != null && v !== '');
}
