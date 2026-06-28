// src/session.js
//
// Pure-Node, API-based session for the Bituach Leumi personal portal — NO
// browser. Authenticates via POST api/loginApi/authenticate using the three
// credentials from the resolved config, and keeps the returned JWT plus any
// F5/Shape "TS" cookies for the data calls that follow.
//
// The portal's password-login API is reachable with a plain HTTPS client; a
// real browser engine is NOT required (verified against a live account). This
// module performs no state-changing action — it only authenticates.

import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import { randomUUID } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { assertAllowed } from './api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// A realistic desktop-Chrome identity, matching what the portal's own SPA sends.
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * Read the persisted device fingerprint (StationId), or generate + persist one.
 * The portal treats StationId as a per-device GUID created once and reused;
 * keeping it stable across runs mimics a returning device.
 *
 * @returns {Promise<string>} a UUID-v4 StationId
 */
async function getStationId() {
  const file = path.resolve(__dirname, '..', '.station-id');
  try {
    if (existsSync(file)) {
      const v = (await fs.readFile(file, 'utf8')).trim();
      if (v) return v;
    }
  } catch {
    /* fall through to generate a fresh one */
  }
  const id = randomUUID();
  await fs.writeFile(file, id, 'utf8').catch(() => {});
  return id;
}

/** Collapse a response's Set-Cookie headers into a single Cookie request value. */
function cookieHeaderFrom(res) {
  const set = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  return set.map((c) => c.split(';')[0]).join('; ');
}

/**
 * Authenticate against the portal and return a session object for api.js.
 *
 * @param {object} cfg  resolved config (see env.getConfig): baseUrl, timeout,
 *                      credentials {userZehut, userName, password}
 * @returns {Promise<{
 *   baseUrl: string, token: string, cookies: string, timeout: number, loginSummary: any
 * }>}
 * @throws if authentication does not yield a token.
 */
export async function createSession(cfg) {
  const stationId = await getStationId();

  assertAllowed('api/loginApi/authenticate'); // read-only allowlist guard
  const res = await fetch(cfg.baseUrl + '/api/loginApi/authenticate', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      'X-TS-AJAX-Request': 'true',
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'he-IL,he;q=0.9,en;q=0.8',
      'User-Agent': UA,
      Referer: cfg.baseUrl + '/',
    },
    // Classic password-login flow (NOT OTP): Opt=false, no phone fields used.
    body: JSON.stringify({
      CellMsgType: '0',
      Opt: false,
      Kidomet: '',
      userZehut: cfg.credentials.userZehut,
      userName: cfg.credentials.userName,
      password: cfg.credentials.password,
      StationId: stationId,
    }),
    signal: AbortSignal.timeout(cfg.timeout),
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!res.ok || !json || !json.Token) {
    const detail = (json && json.PasswordMessage) || (text || '').slice(0, 200);
    throw new Error(
      `Login failed (status ${res.status}). ` +
        'Check BTL_ID / BTL_USER_CODE / BTL_PASSWORD in .env.' +
        (detail ? ` Portal said: ${detail}` : '')
    );
  }

  return {
    baseUrl: cfg.baseUrl,
    token: json.Token, // raw JWT — sent verbatim as Authorization (no "Bearer ")
    cookies: cookieHeaderFrom(res),
    timeout: cfg.timeout,
    loginSummary: json, // the authenticate response IS the full account summary
  };
}
