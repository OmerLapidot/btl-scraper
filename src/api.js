// src/api.js
//
// Low-level, pure-Node API access for the Bituach Leumi personal portal.
//
// Every request carries the JWT (Authorization header, raw — no "Bearer "
// prefix), the F5/Shape "TS" cookies captured at login, and the
// X-TS-AJAX-Request header the portal expects. No browser is involved.
//
// These helpers are READ-ONLY: callers only hit inquiry ("Berur") endpoints, GET
// endpoints, or POST endpoints with an empty body.
//
// READ-ONLY is ENFORCED, not just documented: every request path must appear in
// ALLOWED_ENDPOINTS below, or the call throws *before* any network request is
// made. There is no pattern matching and no probing — adding an endpoint is a
// deliberate edit to this frozen list. Each entry has been individually verified
// to be a non-mutating read.
export const ALLOWED_ENDPOINTS = Object.freeze(new Set([
  'api/loginApi/authenticate',        // login (establishes the session)
  'api/MevutachApi/BerurMevutach',    // insurance status
  'api/ChovotApi/ChovotGalash',       // NI/health debt
  'api/ChovotApi/ChovotGimlaot',      // benefits debt
  'api/GalashApi/BerurGalash',        // collection ledger
  'api/MiluimApi/BerurMiluim',        // reserve-duty data
  'api/MismachimApi/Mismachim',       // documents you uploaded
  'api/MichtavimApi/MichtavimList',   // letters list
  'api/PersonalApi/PniyotKodmot',     // previous inquiries (user-approved)
  'Michtavim/GetMichtav',             // letter PDF download
]));

/**
 * Throw unless `rawPath` (minus any leading slash / query string) is on the
 * read-only allowlist. Returns the normalized path on success.
 * @param {string} rawPath
 * @returns {string}
 */
export function assertAllowed(rawPath) {
  const p = String(rawPath == null ? '' : rawPath).replace(/^\/+/, '').split('?')[0];
  if (!ALLOWED_ENDPOINTS.has(p)) {
    throw new Error(
      `Blocked: "${p}" is not on the read-only allowlist (src/api.js ALLOWED_ENDPOINTS). ` +
        'No request was sent. Add it deliberately only if it is a verified, non-mutating read.'
    );
  }
  return p;
}

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** Build the standard request headers for a session, merging any extras. */
function buildHeaders(session, extra) {
  const h = {
    Authorization: session.token,
    'X-TS-AJAX-Request': 'true',
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'he-IL,he;q=0.9,en;q=0.8',
    'User-Agent': UA,
    Referer: session.baseUrl + '/',
    ...extra,
  };
  if (session.cookies) h.Cookie = session.cookies;
  return h;
}

/**
 * Perform a JSON API call.
 *
 * @param {import('./session.js').Session} session  session from createSession()
 * @param {object} opts
 * @param {string} [opts.method='POST']  HTTP method.
 * @param {string} opts.path             Relative path (resolved against baseUrl).
 * @param {object} [opts.body={}]        Request body (ignored for GET).
 * @param {string} [opts.query='']       Query string (without leading '?').
 * @returns {Promise<any>} the parsed JSON response (null for an empty/non-JSON body).
 * @throws if the response status is not 2xx.
 */
export async function callJson(session, { method = 'POST', path, body = {}, query = '' } = {}) {
  assertAllowed(path); // throws before any network call if not on the allowlist
  const url = session.baseUrl + '/' + path + (query ? '?' + query : '');

  const init = {
    method,
    headers: buildHeaders(session),
    signal: AbortSignal.timeout(session.timeout),
  };
  // Only send a JSON body for non-GET requests.
  if (method.toUpperCase() !== 'GET') {
    init.headers['Content-Type'] = 'application/json;charset=UTF-8';
    init.body = JSON.stringify(body || {});
  }

  const res = await fetch(url, init);
  const text = await res.text();

  if (!res.ok) {
    throw new Error(res.status + ': ' + (text || '').slice(0, 200));
  }

  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null; // non-JSON body on a 2xx — surface as null
  }
}

/**
 * Download a binary resource (e.g. a letter PDF).
 *
 * @param {import('./session.js').Session} session
 * @param {string} url  Absolute or baseUrl-relative URL of the binary resource.
 * @returns {Promise<{ status: number, contentType: string, buffer: Buffer }>}
 */
export async function downloadBinary(session, url) {
  assertAllowed(url); // throws before any network call if not on the allowlist
  const abs = /^https?:/i.test(url)
    ? url
    : session.baseUrl + (url.startsWith('/') ? '' : '/') + url;

  const res = await fetch(abs, {
    method: 'GET',
    headers: buildHeaders(session, { Accept: 'application/pdf,*/*' }),
    signal: AbortSignal.timeout(session.timeout),
  });

  const buffer = Buffer.from(await res.arrayBuffer());
  return {
    status: res.status,
    contentType: res.headers.get('content-type') || '',
    buffer,
  };
}
