// Extracts the text content of every downloaded letter PDF into a single JSON
// (out/letters/contents.json), pairing each letter's metadata with its text.
//
// Read-only: it only reads the PDFs already in out/letters and the index.json
// produced by the scraper. Requires `pdftotext` (poppler) on PATH.

import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Unicode bidi / formatting control marks that pdftotext sprinkles into RTL
// (Hebrew) output. Stripping them yields clean, readable text in the JSON.
const BIDI_MARKS = /[‎‏‪-‮⁦-⁩﻿]/g;

function clean(text) {
  return text
    .replace(BIDI_MARKS, '')
    // Collapse runs of blank lines and trailing spaces.
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function pdfText(file) {
  // `-enc UTF-8 - ` => write UTF-8 to stdout. No -layout: reading order is
  // better for RTL prose than visual layout.
  const { stdout } = await execFileP('pdftotext', ['-enc', 'UTF-8', file, '-'], {
    maxBuffer: 32 * 1024 * 1024,
  });
  return clean(stdout);
}

async function main() {
  const outDir = path.resolve(__dirname, '..', 'out');
  const lettersDir = path.join(outDir, 'letters');
  const indexPath = path.join(lettersDir, 'index.json');

  if (!existsSync(indexPath)) {
    console.error(`No ${indexPath} — run "npm run scrape" first.`);
    process.exit(1);
  }

  const index = JSON.parse(await fs.readFile(indexPath, 'utf8'));
  const letters = [];
  let ok = 0;

  for (let i = 0; i < index.length; i++) {
    const entry = index[i];
    const base = { date: entry.date, subject: entry.subject, kod: entry.kod, file: entry.file };
    if (!entry.file) {
      letters.push({ ...base, text: null, error: entry.error || 'not downloaded' });
      continue;
    }
    const filePath = path.join(lettersDir, entry.file);
    try {
      const text = await pdfText(filePath);
      letters.push({ ...base, chars: text.length, text });
      ok++;
      console.error(`  [${i + 1}/${index.length}] ${entry.file} — ${text.length} chars`);
    } catch (err) {
      letters.push({ ...base, text: null, error: err.message });
      console.error(`  [${i + 1}/${index.length}] ${entry.file} — FAILED: ${err.message}`);
    }
  }

  const dest = path.join(lettersDir, 'contents.json');
  await fs.writeFile(dest, JSON.stringify({ count: letters.length, extracted: ok, letters }, null, 2), 'utf8');
  console.error(`\nWrote ${dest} — ${ok}/${letters.length} letters with text.`);
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(2);
});
