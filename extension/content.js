// content.js — injected on https://ps.btl.gov.il/*
//
// What it does:
//   1. Watches for a logged-in session (the portal stores its JWT in
//      sessionStorage.token after you log in — see API.md §3).
//   2. When logged in, drops a floating "show dashboard" button onto the page.
//   3. On click, reuses your LIVE session (the token + the cookies the browser
//      already holds) to call the portal's READ-ONLY JSON endpoints, exactly like
//      the portal's own app does — no password, no login, nothing stored.
//   4. Hands the fetched data to the service worker, which opens the dashboard.
//
// READ-ONLY: every endpoint below is one of the inquiry ("Berur"/list/GET) calls
// from the scraper's allowlist (src/api.js). No payments, edits, or submissions.

(() => {
  'use strict';

  // --- DIAGNOSTIC (temporary): prove which boundary fails. Remove once fixed. ---
  const DEBUG = true;
  const log = (...a) => { if (DEBUG) console.log('[BTL-ext]', ...a); };
  log('content script injected on', location.href);
  // -----------------------------------------------------------------------------

  const BTN_ID = 'btl-ext-dashboard-btn';
  const ORIGIN = 'https://ps.btl.gov.il';

  // Mirror of src/api.js ALLOWED_ENDPOINTS + src/branches.js (read-only).
  // `summary` is not here — it's already in sessionStorage.user (the login response).
  const ENDPOINTS = [
    { key: 'mevutach',      method: 'POST', path: 'api/MevutachApi/BerurMevutach' },
    { key: 'chovotGalash',  method: 'POST', path: 'api/ChovotApi/ChovotGalash' },
    { key: 'chovotGimlaot', method: 'POST', path: 'api/ChovotApi/ChovotGimlaot' },
    { key: 'galash',        method: 'POST', path: 'api/GalashApi/BerurGalash' },
    { key: 'miluim',        method: 'POST', path: 'api/MiluimApi/BerurMiluim' },
    { key: 'mismachim',     method: 'GET',  path: 'api/MismachimApi/Mismachim' },
    { key: 'pniyot',        method: 'GET',  path: 'api/PersonalApi/PniyotKodmot' },
    { key: 'letters',       method: 'POST', path: 'api/MichtavimApi/MichtavimList', query: 'prtcl=false' },
  ];

  // A JWT is three base64url segments separated by dots. The portal's tokens are
  // ~640 chars, so require a generous minimum length to avoid false positives.
  const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
  const looksLikeJwt = (v) => typeof v === 'string' && v.length > 150 && JWT_RE.test(v);

  // True for a string under a token-ish key that isn't a refresh token — used as a
  // fallback if the access token ever stops being a standard 3-segment JWT.
  const isTokenKey = (k) => /token|jwt|bearer/i.test(k) && !/refresh/i.test(k);

  // Recursively search a parsed value for a JWT (preferred) or, failing that, a
  // long string under a token-ish key. Returns { token, where } or null.
  function deepFind(obj, path, depth, allowKeyMatch) {
    if (obj == null || depth > 6) return null;
    if (typeof obj !== 'object') return null;
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      const here = path + '.' + k;
      if (looksLikeJwt(v)) return { token: v, where: here };
      if (allowKeyMatch && typeof v === 'string' && v.length > 40 && isTokenKey(k)) {
        return { token: v, where: here };
      }
      if (v && typeof v === 'object') {
        const r = deepFind(v, here, depth + 1, allowKeyMatch);
        if (r) return r;
      }
    }
    return null;
  }

  // Returns { token, where } or null. The portal moved the JWT out of the old
  // `sessionStorage.token` key — it now lives deep inside the `user` object
  // (user.UserToken.Token) — so we search the whole storage tree instead of
  // hardcoding a path. Robust to further renames/nesting.
  function findToken() {
    // 1. Legacy explicit key (kept so a portal revert still works).
    for (const [label, store] of [['session', sessionStorage], ['local', localStorage]]) {
      try { const t = store.getItem('token'); if (looksLikeJwt(t)) return { token: t, where: label + '.token' }; } catch (_) {}
    }
    // 2. & 3. Deep-scan every storage value: first a strict JWT pass, then a
    // looser token-key pass (so a strict JWT anywhere wins over a key-name guess).
    for (const allowKeyMatch of [false, true]) {
      for (const [label, store] of [['session', sessionStorage], ['local', localStorage]]) {
        for (const k of Object.keys(store)) {
          try {
            const raw = store.getItem(k);
            if (looksLikeJwt(raw)) return { token: raw, where: label + '.' + k };
            if (allowKeyMatch && typeof raw === 'string' && raw.length > 40 && isTokenKey(k)) {
              return { token: raw, where: label + '.' + k };
            }
            if (raw && (raw[0] === '{' || raw[0] === '[')) {
              const r = deepFind(JSON.parse(raw), label + '.' + k, 0, allowKeyMatch);
              if (r) return r;
            }
          } catch (_) {}
        }
      }
    }
    return null;
  }

  function getToken() {
    const info = findToken();
    return info ? info.token : null;
  }

  function getSummary() {
    for (const store of [sessionStorage, localStorage]) {
      try {
        const raw = store.getItem('user');
        if (raw) return JSON.parse(raw);
      } catch (_) {}
    }
    return null;
  }

  async function callOne(token, ep) {
    const url = ORIGIN + '/' + ep.path + (ep.query ? '?' + ep.query : '');
    const headers = {
      'Authorization': token,            // raw JWT, no "Bearer " prefix (see API.md §3)
      'X-TS-AJAX-Request': 'true',
      'Accept': 'application/json, text/plain, */*',
    };
    const init = { method: ep.method, headers, credentials: 'include' };
    if (ep.method !== 'GET') {
      headers['Content-Type'] = 'application/json;charset=UTF-8';
      init.body = '{}';
    }
    const res = await fetch(url, init);
    const text = await res.text();
    if (!res.ok) throw new Error(res.status + ': ' + (text || '').slice(0, 120));
    try { return text ? JSON.parse(text) : null; } catch (_) { return null; }
  }

  function setBtn(btn, text, busy) {
    btn.textContent = text;
    btn.disabled = !!busy;
    btn.style.opacity = busy ? '0.75' : '1';
    btn.style.cursor = busy ? 'default' : 'pointer';
  }

  // True only while this content script is still connected to a live extension.
  // After the extension is reloaded/updated, content scripts already injected in
  // open tabs are orphaned and chrome.runtime (and .id) go away.
  function extensionAlive() {
    try { return !!(chrome && chrome.runtime && chrome.runtime.id); } catch (_) { return false; }
  }

  const REFRESH_MSG = 'התוסף נטען מחדש. רעננו את הדף (⌘R / Ctrl+R) ונסו שוב.';

  async function run(btn) {
    if (!extensionAlive()) { alert(REFRESH_MSG); return; }

    const token = getToken();
    if (!token) {
      alert('לא נמצאה התחברות פעילה לאזור האישי. התחברו לאתר ביטוח לאומי ונסו שוב.');
      return;
    }

    setBtn(btn, '⏳ טוען נתונים…', true);

    const data = { summary: getSummary() };
    const status = [{ name: 'summary', ok: !!data.summary, error: data.summary ? '' : 'לא נמצא ב-session' }];

    for (const ep of ENDPOINTS) {
      try {
        data[ep.key] = await callOne(token, ep);
        status.push({ name: ep.key, ok: true });
      } catch (e) {
        data[ep.key] = null;
        status.push({ name: ep.key, ok: false, error: String((e && e.message) || e) });
      }
    }

    const meta = { at: Date.now(), status };

    try {
      const resp = await chrome.runtime.sendMessage({ type: 'BTL_DATA', data, meta });
      if (resp && resp.ok === false) throw new Error(resp.error || 'unknown');
      setBtn(btn, '✓ הדשבורד נפתח', false);
      setTimeout(() => setBtn(btn, '📊 הצג את לוח המצב שלי', false), 2500);
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (!extensionAlive() || /context invalidated|message port|receiving end/i.test(msg)) {
        alert(REFRESH_MSG);
      } else {
        alert('שגיאה בפתיחת הדשבורד: ' + msg.slice(0, 200));
      }
      setBtn(btn, '📊 הצג את לוח המצב שלי', false);
    }
  }

  function injectButton() {
    if (document.getElementById(BTN_ID)) return;
    if (!document.body) { log('injectButton: no document.body yet'); return; }
    log('injectButton: adding floating button');

    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';
    btn.textContent = '📊 הצג את לוח המצב שלי';
    Object.assign(btn.style, {
      position: 'fixed',
      insetInlineEnd: '20px',
      bottom: '20px',
      zIndex: '2147483647',
      fontFamily: "'Assistant', Arial, sans-serif",
      fontSize: '15px',
      fontWeight: '600',
      color: '#fff',
      background: 'linear-gradient(135deg,#16b89a,#0f8f78)',
      border: 'none',
      borderRadius: '999px',
      padding: '13px 22px',
      boxShadow: '0 10px 26px -10px rgba(15,143,120,.85)',
      cursor: 'pointer',
      direction: 'rtl',
    });
    btn.addEventListener('click', () => run(btn));
    document.body.appendChild(btn);
  }

  function removeButton() {
    const b = document.getElementById(BTN_ID);
    if (b) b.remove();
  }

  // The portal is a single-page app, so login happens after the initial page load
  // (no full navigation). Poll for the session token and show/hide accordingly.
  let lastTokenState = null;
  setInterval(() => {
    const info = findToken();
    const hasToken = !!info;
    if (hasToken !== lastTokenState) {
      if (hasToken) log('poll: token FOUND at', info.where, '(len ' + info.token.length + ') — value not logged');
      else log('poll: token not found | sessionStorage keys:', Object.keys(sessionStorage),
               '| localStorage keys:', Object.keys(localStorage));
      lastTokenState = hasToken;
    }
    if (hasToken) injectButton();
    else removeButton();
  }, 2500);
})();
