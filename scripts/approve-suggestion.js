#!/usr/bin/env node

/**
 * Movie Radio — Suggestion Approval
 *
 * Runs when a suggestion issue is labeled "approved" (see
 * .github/workflows/approve-suggestion.yml). Reads the issue's hidden
 * metadata comments (written by intake-suggestions.js), appends the movie
 * to the library file for whichever `band:*` label is also on the issue,
 * credits the contributor, and reports back what happened.
 *
 * Expects these env vars (set by the workflow):
 *   ISSUE_NUMBER, ISSUE_BODY, ISSUE_LABELS (comma-separated label names)
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const ROOT        = path.resolve(__dirname, '..');
const LIBRARY_DIR = path.join(ROOT, 'library');

const BAND_LABEL_PREFIX = 'band:';

function parseMeta(body) {
  const meta = {};
  const re = /<!-- ([\w-]+): (.*?) -->/g;
  let m;
  while ((m = re.exec(body || ''))) meta[m[1]] = m[2];
  return meta;
}

function fail(msg) {
  console.error(msg);
  fs.writeFileSync(path.join(ROOT, 'cache', 'approval-result.json'), JSON.stringify({ ok: false, message: msg }));
  process.exit(1);
}

function main() {
  const body   = process.env.ISSUE_BODY || '';
  const labels = (process.env.ISSUE_LABELS || '').split(',').map(s => s.trim()).filter(Boolean);
  const meta   = parseMeta(body);

  if (!meta['video-id']) fail('No video-id found in issue body — was this issue created by the intake script?');

  const bandLabel = labels.find(l => l.startsWith(BAND_LABEL_PREFIX));
  if (!bandLabel) {
    fail(`No band label found. Add one of the "band:*" labels (e.g. band:malayalam-mass) before approving.`);
    return;
  }
  const band = bandLabel.slice(BAND_LABEL_PREFIX.length);
  const libraryFile = path.join(LIBRARY_DIR, `${band}.yaml`);
  if (!fs.existsSync(libraryFile)) fail(`No library file for band "${band}" (expected ${libraryFile}).`);

  const videoId     = meta['video-id'];
  const title       = meta['title'] || videoId;
  const contributor = meta['contributor'] || 'Anonymous';

  const raw = fs.readFileSync(libraryFile, 'utf8');
  const parsed = yaml.load(raw) || {};
  const already = (parsed.movies || []).some(m => (m.url || '').includes(videoId));
  if (already) fail(`Video ${videoId} is already in ${band}.yaml — nothing to do.`);

  const entry = [
    `  - url: https://www.youtube.com/watch?v=${videoId}`,
    `    title: ${yamlScalar(title)}`,
    `    contributor: ${yamlScalar(contributor)}`,
    ``,
  ].join('\n');

  const updated = raw.replace(/\n?$/, '\n') + '\n' + entry;
  fs.writeFileSync(libraryFile, updated);

  fs.writeFileSync(path.join(ROOT, 'cache', 'approval-result.json'), JSON.stringify({
    ok: true, band, title, contributor, videoId,
  }));
  console.log(`Added "${title}" (credit: ${contributor}) to ${band}.yaml`);
}

function yamlScalar(s) {
  // Quote if it contains characters that would confuse a plain YAML scalar.
  if (/^[\w\s'.,!()&-]*$/.test(s) && !/^[\s-]|:\s|^[-?:,[\]{}#&*!|>'"%@`]/.test(s)) return s;
  return JSON.stringify(s);
}

main();
