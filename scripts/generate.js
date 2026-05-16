#!/usr/bin/env node

/**
 * Movie Radio — Schedule Generator
 * Run locally:  node scripts/generate.js
 * With fetching: node scripts/generate.js --fetch-durations
 *
 * Generates a fresh 24h+ schedule for each band starting from 3 AM IST today.
 * Movies are shuffled; no duplicates unless library is too small to fill 24h.
 */

const fs   = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { execSync } = require('child_process');

// ─── Paths & config ───────────────────────────────────────────────────────────

const ROOT          = path.resolve(__dirname, '..');
const LIBRARY_DIR   = path.join(ROOT, 'library');
const SCHEDULES_DIR = path.join(ROOT, 'schedules');
const CACHE_FILE    = path.join(ROOT, 'cache', 'durations.json');
const CONFIG_FILE   = path.join(ROOT, 'config.yaml');

const config         = yaml.load(fs.readFileSync(CONFIG_FILE, 'utf8'));
const TIMEZONE       = config.timezone   || 'Asia/Kolkata';
const RESET_HOUR     = config.reset_hour ?? 3;   // 3 AM IST
const BAND_ORDER     = config.band_order || [];
const FETCH_DURATIONS = process.argv.includes('--fetch-durations');
const MIN_HOURS      = 24;

// ─── Time helpers ─────────────────────────────────────────────────────────────

function parseTime(t) {
  const parts = t.trim().split(':').map(Number);
  if (parts.some(isNaN)) throw new Error(`Cannot parse time: "${t}"`);
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  throw new Error(`Cannot parse time: "${t}"`);
}

function parseRange(range) {
  const parts = range.split(/\s+-\s+/);
  if (parts.length !== 2) throw new Error(`Invalid range: "${range}"`);
  return { start: parseTime(parts[0]), end: parseTime(parts[1]) };
}

function computeSegments(durationSec, skipRanges) {
  if (!skipRanges || skipRanges.length === 0) {
    return [{ from: 0, to: durationSec }];
  }
  const skips    = skipRanges.map(r => parseRange(r)).sort((a, b) => a.start - b.start);
  const segments = [];
  let cursor     = 0;
  for (const skip of skips) {
    if (skip.start > cursor) segments.push({ from: cursor, to: skip.start });
    cursor = Math.max(cursor, skip.end);
  }
  if (cursor < durationSec) segments.push({ from: cursor, to: durationSec });
  return segments.filter(s => s.to - s.from > 10);
}

function segmentsDuration(segments) {
  return segments.reduce((sum, s) => sum + (s.to - s.from), 0);
}

function toIST(date) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone:  TIMEZONE,
    year:      'numeric', month:  '2-digit', day:    '2-digit',
    hour:      '2-digit', minute: '2-digit', second: '2-digit',
    hour12:    false,
    hourCycle: 'h23',   // prevents "24" for midnight
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}+05:30`;
}

function getTodayResetTime() {
  // Build today's RESET_HOUR:00:00 IST as a Date object
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const p    = Object.fromEntries(fmt.formatToParts(now).map(x => [x.type, x.value]));
  const hour = String(RESET_HOUR).padStart(2, '0');
  return new Date(`${p.year}-${p.month}-${p.day}T${hour}:00:00+05:30`);
}

// ─── Duration fetching ────────────────────────────────────────────────────────

function fetchDurationYtdlp(videoId) {
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

async function fetchTitleOembed(videoId) {
  try {
    const res  = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`);
    const data = await res.json();
    return data.title || null;
  } catch {
    return null;
  }
}

// ─── Library loading ──────────────────────────────────────────────────────────

function extractVideoId(url) {
  const m = url.match(/(?:v=|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  if (!m) throw new Error(`Cannot extract video ID from: ${url}`);
  return m[1];
}

function loadLibrary() {
  const discovered = fs.readdirSync(LIBRARY_DIR)
    .filter(f => f.endsWith('.yaml'))
    .map(f => path.basename(f, '.yaml'));

  const ordered = [
    ...BAND_ORDER.filter(id => discovered.includes(id)),
    ...discovered.filter(id => !BAND_ORDER.includes(id)).sort(),
  ];

  return ordered.map(bandId => {
    const raw     = yaml.load(fs.readFileSync(path.join(LIBRARY_DIR, `${bandId}.yaml`), 'utf8'));
    const autoName = bandId.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    const seen    = new Set();

    const movies = (raw.movies || [])
      .map(m => {
        let videoId;
        try { videoId = extractVideoId(m.url); } catch {
          console.warn(`  ⚠ [${bandId}] Skipping bad URL: ${m.url}`);
          return null;
        }
        if (seen.has(videoId)) {
          console.warn(`  ⚠ [${bandId}] Duplicate in YAML, skipping: ${videoId}`);
          return null;
        }
        seen.add(videoId);
        return {
          videoId,
          title:         m.title        || null,
          duration:      m.duration      ? parseTime(m.duration)      : null,
          real_duration: m.real_duration ? parseTime(m.real_duration) : null,
          skip:          m.skip ? (Array.isArray(m.skip) ? m.skip : [m.skip]) : [],
        };
      })
      .filter(Boolean);

    return { id: bandId, name: raw.name || autoName, movies };
  });
}

// ─── Duration resolution ──────────────────────────────────────────────────────

async function resolveDurations(bands) {
  const cache        = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  let   cacheChanged = false;
  const issues       = [];

  for (const band of bands) {
    const resolved = [];
    for (const movie of band.movies) {
      let duration = movie.duration ?? cache[movie.videoId] ?? null;

      if (!duration) {
        if (FETCH_DURATIONS) {
          process.stdout.write(`  Fetching duration: ${movie.videoId} (${movie.title || 'untitled'})...`);
          duration = fetchDurationYtdlp(movie.videoId);
          if (duration) {
            cache[movie.videoId] = duration;
            cacheChanged = true;
            console.log(` ${duration}s`);
          } else {
            console.log(' failed');
            issues.push({ band: band.id, videoId: movie.videoId, title: movie.title, reason: 'duration-unavailable' });
            continue;
          }
        } else {
          console.warn(`  ⚠ [${band.id}] No duration for "${movie.title || movie.videoId}" — skipping`);
          continue;
        }
      }

      if (!movie.title) {
        if (FETCH_DURATIONS) {
          movie.title = await fetchTitleOembed(movie.videoId) || movie.videoId;
          console.warn(`  ⚠ [${band.id}] No title for ${movie.videoId} — using: "${movie.title}"`);
        } else {
          movie.title = movie.videoId;
        }
      }

      resolved.push({ ...movie, duration });
    }
    band.movies = resolved;
  }

  if (cacheChanged) fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  return { bands, issues };
}

// ─── Shuffle ──────────────────────────────────────────────────────────────────

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ─── Schedule generation ──────────────────────────────────────────────────────

function generateBand(band) {
  const startTime  = getTodayResetTime();
  const targetSec  = MIN_HOURS * 3600;
  const slots      = [];
  let   cursor     = startTime;
  let   totalSec   = 0;
  let   passCount  = 0;

  // Keep picking movies until we have >= 24h.
  // First pass: shuffle and go through the full library (no duplicates).
  // If library is too small, reshuffle and continue (duplicates only as fallback).
  let pool = shuffle(band.movies);

  while (totalSec < targetSec) {
    if (pool.length === 0) {
      passCount++;
      console.warn(`  ⚠ [${band.id}] Library exhausted after ${Math.round(totalSec / 3600)}h — reshuffling (pass ${passCount + 1})`);
      pool = shuffle(band.movies);
    }

    const movie      = pool.shift();
    const segments   = computeSegments(movie.duration, movie.skip);
    const playableSec = segmentsDuration(segments);

    if (playableSec < 300) {
      console.warn(`  ⚠ [${band.id}] Skipping "${movie.title}" — too short (${playableSec}s)`);
      continue;
    }

    const start = new Date(cursor);
    const end   = new Date(cursor.getTime() + playableSec * 1000);

    const slot = {
      youtube:  movie.videoId,
      title:    movie.title,
      start:    toIST(start),
      end:      toIST(end),
      segments,
    };
    if (movie.real_duration) slot.loop = movie.real_duration;

    slots.push(slot);
    cursor   = end;
    totalSec += playableSec;
  }

  return slots;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Movie Radio — Schedule Generator');
  console.log(`Reset time: ${RESET_HOUR}:00 ${TIMEZONE}`);
  console.log(`Target:     ${MIN_HOURS}h+`);
  console.log(`Fetch:      ${FETCH_DURATIONS}`);
  console.log('');

  fs.mkdirSync(SCHEDULES_DIR, { recursive: true });

  console.log('Loading library...');
  let bands = loadLibrary();
  console.log(`  ${bands.length} band(s): ${bands.map(b => b.id).join(', ')}`);
  console.log('');

  console.log('Resolving durations...');
  const { bands: resolvedBands, issues } = await resolveDurations(bands);
  bands = resolvedBands;
  console.log('');

  const index = [];

  for (const band of bands) {
    if (band.movies.length === 0) {
      console.warn(`  ✗ Band "${band.id}" has no valid movies — skipping`);
      continue;
    }

    const totalHours = band.movies.reduce((s, m) => s + m.duration / 3600, 0);
    console.log(`Band: ${band.id} (${band.movies.length} movies, ~${Math.round(totalHours)}h total)`);

    const slots = generateBand(band);
    const scheduleHours = Math.round(
      (new Date(slots[slots.length - 1].end) - new Date(slots[0].start)) / 3600000
    );

    fs.writeFileSync(
      path.join(SCHEDULES_DIR, `${band.id}.json`),
      JSON.stringify({ band: band.id, generated: toIST(new Date()), slots }, null, 2)
    );
    console.log(`  → ${slots.length} slots, ${scheduleHours}h written`);
    console.log('');

    index.push({ band: band.id, name: band.name });
  }

  fs.writeFileSync(path.join(SCHEDULES_DIR, 'index.json'), JSON.stringify(index, null, 2));
  console.log(`Index: ${index.length} band(s)`);

  if (issues.length > 0) {
    console.log('\nIssues:');
    issues.forEach(i => console.log(`  [${i.reason}] ${i.band} — ${i.title || i.videoId}`));
    if (process.env.CI) {
      fs.writeFileSync(path.join(ROOT, 'cache', 'issues.json'), JSON.stringify(issues, null, 2));
    }
  }

  console.log('\nDone.');
}

main().catch(e => { console.error(e); process.exit(1); });
