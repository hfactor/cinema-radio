#!/usr/bin/env node

/**
 * Movie Radio — Suggestion Intake
 *
 * Reads new rows from the Google Form's published-CSV response sheet,
 * validates each candidate (real YouTube movie, not a duplicate, long
 * enough to be an actual movie), and opens a GitHub Issue for anything
 * that passes — that issue is the approval queue. Submissions are
 * anonymous (no sign-in), so spam control is entirely content-based plus
 * a per-run cap; there's no per-contributor identity to key a quota on.
 * Nothing here touches library/ directly; see approve-suggestion.js for
 * what happens after you label an issue "approved".
 *
 * Run in CI only (needs GITHUB_TOKEN + GITHUB_REPOSITORY). Safe to run
 * locally for the CSV-parsing/validation logic — issue creation and the
 * GitHub-side quota check are skipped without a token.
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { execSync } = require('child_process');

const ROOT         = path.resolve(__dirname, '..');
const LIBRARY_DIR  = path.join(ROOT, 'library');
const CACHE_FILE   = path.join(ROOT, 'cache', 'suggestions.json');
const CONFIG_FILE  = path.join(ROOT, 'config.yaml');

const config          = yaml.load(fs.readFileSync(CONFIG_FILE, 'utf8'));
const CSV_URL         = config.suggestions_csv_url;
const MIN_SECONDS     = config.min_movie_seconds ?? 3600;
const MAX_PER_RUN     = config.suggestions_max_per_run ?? 8;

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO  = process.env.GITHUB_REPOSITORY; // "owner/repo"

// ─── Column lookup (tolerant of the exact Form question wording) ──────────

function findField(row, patterns) {
  const keys = Object.keys(row);
  for (const pattern of patterns) {
    const key = keys.find(k => pattern.test(k));
    if (key) return row[key];
  }
  return '';
}

// ─── CSV parsing (minimal RFC4180) ─────────────────────────────────────────

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  if (rows.length === 0) return [];
  const header = rows[0].map(h => h.trim());
  return rows.slice(1).map(r => Object.fromEntries(header.map((h, i) => [h, (r[i] || '').trim()])));
}

// ─── Helpers shared with generate.js / check-videos.yml ────────────────────

function extractVideoId(url) {
  const m = (url || '').match(/(?:v=|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

function listLibraryFiles() {
  return fs.readdirSync(LIBRARY_DIR).filter(f => f.endsWith('.yaml'));
}

function loadExistingVideoIds() {
  const ids = new Set();
  for (const f of listLibraryFiles()) {
    const raw = yaml.load(fs.readFileSync(path.join(LIBRARY_DIR, f), 'utf8')) || {};
    for (const m of raw.movies || []) {
      const id = extractVideoId(m.url);
      if (id) ids.add(id);
    }
  }
  return ids;
}

async function checkOembed(videoId) {
  try {
    const res = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`);
    if (res.ok) return { ok: true, title: (await res.json()).title || null };
    return { ok: false, reason: res.status === 401 || res.status === 403 ? 'not-embeddable' : 'unavailable' };
  } catch {
    return { ok: false, reason: 'fetch-error' };
  }
}

function fetchDuration(videoId) {
  try {
    const out = execSync(
      `yt-dlp --dump-json --skip-download "https://www.youtube.com/watch?v=${videoId}"`,
      { timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] }
    ).toString();
    const data = JSON.parse(out);
    return typeof data.duration === 'number' ? data.duration : null;
  } catch {
    return null;
  }
}

function fmtDuration(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}:${String(m).padStart(2, '0')}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
}

// ─── GitHub API (skipped in local/no-token runs) ───────────────────────────

async function gh(pathname, opts = {}) {
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}${pathname}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      ...opts.headers,
    },
  });
  if (!res.ok) throw new Error(`GitHub API ${pathname} -> ${res.status}: ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

function bandLabels() {
  return listLibraryFiles().map(f => `band:${path.basename(f, '.yaml')}`);
}

async function createIssue({ videoId, title, contributor, url, duration }) {
  const body = [
    `A new movie was suggested for the library.`,
    ``,
    `**Video ID:** \`${videoId}\``,
    `**Title:** ${title}`,
    `**Contributor:** ${contributor || '_anonymous_'}`,
    `**YouTube:** ${url}`,
    `**Duration:** ${fmtDuration(duration)}`,
    ``,
    `To approve: add **one** of \`${bandLabels().join('`, `')}\` to pick the channel, plus the \`approved\` label. That appends the entry to the matching \`library/*.yaml\`, credits the contributor, and closes this issue.`,
    ``,
    `<!-- video-id: ${videoId} -->`,
    `<!-- title: ${title.replace(/-->/g, '')} -->`,
    `<!-- contributor: ${(contributor || 'Anonymous').replace(/-->/g, '')} -->`,
  ].join('\n');

  return gh('/issues', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: `[suggestion] ${title}`,
      body,
      labels: ['suggestion', 'needs-review'],
    }),
  });
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  if (!CSV_URL) {
    console.log('No suggestions_csv_url configured in config.yaml — skipping intake.');
    return;
  }

  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  const cache = fs.existsSync(CACHE_FILE) ? JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) : { processed: {} };

  console.log('Fetching submissions...');
  const csvText = await fetch(CSV_URL).then(r => r.text());
  const rows = parseCsv(csvText);
  console.log(`  ${rows.length} total responses`);

  const existingIds = loadExistingVideoIds();
  const dryRun = !GITHUB_TOKEN || !GITHUB_REPO;
  if (dryRun) console.log('No GITHUB_TOKEN/GITHUB_REPOSITORY — running in dry-run mode (no issues will be created).');

  let issued = 0, dropped = 0, skippedAlready = 0;

  for (const row of rows) {
    if (issued >= MAX_PER_RUN) break; // rest picked up next run

    const timestamp = row['Timestamp'] || '';
    const url       = findField(row, [/youtube/i, /link/i]);
    const name      = findField(row, [/name/i]).trim();

    const videoId = extractVideoId(url);
    const rowKey  = `${timestamp}|${videoId || url}`;
    if (cache.processed[rowKey]) { skippedAlready++; continue; }

    const record = { url, videoId, timestamp };

    if (!videoId) {
      cache.processed[rowKey] = { ...record, status: 'dropped', reason: 'invalid-url' };
      dropped++; continue;
    }
    if (existingIds.has(videoId)) {
      cache.processed[rowKey] = { ...record, status: 'dropped', reason: 'duplicate' };
      dropped++; continue;
    }

    const oembed = await checkOembed(videoId);
    if (!oembed.ok) {
      cache.processed[rowKey] = { ...record, status: 'dropped', reason: oembed.reason };
      dropped++; continue;
    }

    const duration = fetchDuration(videoId);
    if (!duration || duration < MIN_SECONDS) {
      cache.processed[rowKey] = { ...record, status: 'dropped', reason: `too-short (${duration || 0}s)` };
      dropped++; continue;
    }

    const title = oembed.title || videoId;

    if (dryRun) {
      console.log(`  [dry-run] would open issue: "${title}" (credit: ${name || 'anonymous'})`);
      cache.processed[rowKey] = { ...record, status: 'dry-run-valid', title };
      issued++;
      continue;
    }

    const issue = await createIssue({ videoId, title, contributor: name, url, duration });
    cache.processed[rowKey] = { ...record, status: 'issued', title, issue: issue.number };
    issued++;
  }

  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  console.log(`\nDone. Issued: ${issued} | Dropped: ${dropped} | Already processed: ${skippedAlready}`);
}

main().catch(e => { console.error(e); process.exit(1); });
