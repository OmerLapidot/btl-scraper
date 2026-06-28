// Root orchestrator for the read-only Bituach Leumi (National Insurance) scraper.
//
// Flow: load .env -> resolve config -> verify the three login credentials are
// present -> authenticate via the portal's JSON API (no browser) -> run the
// selected READ-ONLY branches (data sections + letters) and write their output.
//
// READ-ONLY is enforced: api.js only permits the endpoints on its allowlist;
// any other path throws before a request is sent.
//
// Logging convention: all human-readable progress goes to console.error
// (stderr); stdout is reserved for data. Exit codes: 0 = success, 1 = missing
// credentials / bad config, 2 = run failed.

import { mkdir } from 'fs/promises';
import path from 'path';

import { loadEnv, getConfig, isConfigured } from './src/env.js';
import { createSession } from './src/session.js';
import { runBranches, resolveSelection, BRANCH_NAMES } from './src/branches.js';

(async () => {
  // 1. Read credentials/config from the project-root .env.
  loadEnv();
  const cfg = getConfig();

  // 2. Bail out early if any login field is missing.
  if (!isConfigured(cfg.credentials)) {
    console.error('Missing Bituach Leumi credentials. Set these in .env (or the environment):');
    console.error('  BTL_ID         — מספר זהות / ID number (9 digits)');
    console.error('  BTL_USER_CODE  — קוד משתמש / user code (up to 8 chars)');
    console.error('  BTL_PASSWORD   — סיסמה / password (up to 10 chars)');
    console.error('');
    console.error('Optional: BTL_BRANCHES, BTL_TIMEOUT, BTL_DOWNLOAD_LETTERS=0, BTL_LETTERS_LIMIT, BTL_LETTERS_ALL=1.');
    console.error(`Branches: ${BRANCH_NAMES.join(', ')}`);
    process.exit(1);
  }

  // 3. Resolve which branches to run (BTL_BRANCHES; blank = all). Back-compat:
  //    BTL_DOWNLOAD_LETTERS=0 drops the letters branch.
  let selected;
  try {
    selected = resolveSelection(cfg.branches);
    if (!cfg.downloadLetters) selected.delete('letters');
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }

  // 4. Make sure the output directories exist before we start writing.
  await mkdir(cfg.outDir, { recursive: true });
  await mkdir(path.join(cfg.outDir, 'letters'), { recursive: true });

  console.error(`Bituach Leumi scraper — output dir: ${cfg.outDir}`);
  console.error(`Branches: ${[...selected].join(', ') || '(none)'}`);
  console.error(`Authenticating to ${cfg.baseUrl} via API (no browser)…`);

  let exitCode = 0;
  let results = [];

  try {
    const session = await createSession(cfg);
    console.error('Logged in.');
    results = await runBranches(session, cfg, selected);
  } catch (e) {
    console.error('FAILED:', e.message);
    exitCode = 2;
  }

  // 5. Readable summary to stderr.
  console.error('\n=== Summary ===');
  if (results.length) {
    const okCount = results.filter((r) => r.ok).length;
    console.error(`Branches: ${okCount}/${results.length} OK`);
    for (const r of results) {
      if (!r.ok) {
        console.error(`  ✗ ${r.name} — ${r.error}`);
      } else if (r.name === 'letters' && r.result) {
        const L = r.result;
        console.error(
          `  ✓ letters — ${L.downloaded} new, ${L.skipped} already had` +
            (L.failed ? `, ${L.failed} failed` : '') +
            ` (${L.total} on portal)`
        );
      } else {
        console.error(`  ✓ ${r.name} -> ${r.file}`);
      }
    }
  } else {
    console.error('No branches ran.');
  }

  console.error(exitCode === 0 ? '\nDone.' : '\nFinished with errors.');
  process.exit(exitCode);
})();
