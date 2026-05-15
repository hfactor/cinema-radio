#!/usr/bin/env node

/**
 * Movie Radio — Schedule Generator
 * Run locally:  node scripts/generate.js
 * Run in CI:    node scripts/generate.js --fetch-durations
 */

const fs   = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { execSync } = require('child_process');

// ─── Config ──────────────────────────────────────────────────────────────────

const ROOT          = path.resolve(__dirname, '..');
const LIBRARY_DIR   = path.join(ROOT, 'library');
const SCHEDULES_DIR = path.join(ROOT, 'schedules');
const CACHE_FILE    = path.join(ROOT, 'cache', 'durations.json');
const CONFIG_FILE   = path.join(ROOT, 'config.yaml');

const config           = yaml.load(fs.readFileSync(CONFIG_FILE, 'utf8'));
const TIMEZONE         = config.timezone         || 'Asia/Kolkata';
const MOVIES_PER_BATCH = config.movies_per_batch || 15;
const LOOKAHEAD_HOURS  = config.lookahead_hours  || 36;
const DEDUP_HOURS      = config.dedup_hours      || 48;
const BAND_ORDER       = config.band_order       || [];
const FETCH_DURATIONS  = process.argv.includes('--fetch-durations');

// --start=<ISO>  e.g. --start=2026-05-15T17:00:00+05:30
// Overrides the initial cursor when a band has no future slots scheduled yet.
const startArg = process.argv.find(a => a.startsWith('--start='));
const START_OVERRIDE = startArg ? new Date(startArg.replace('--start=', '')) : null;

// ─── Time helpers ─────────────────────────────────────────────────────────────

function parseTime(t) {
  // Accepts: "1:35", "01:35", "1:22:30", "0:00" → seconds
  const parts = t.trim().split(':').map(Number);
  if (parts.some(isNaN)) throw new Error(`Cannot parse time: "${t}"`);
  if (parts.length === 2) return parts[0] * 60  + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  throw new Error(`Cannot parse time: "${t}"`);
}

function parseRange(range) {
  // "0:00 - 0:01:35" → { start: 0, end: 95 }
  const idx = range.lastIndexOf('-');
  if (idx === -1) throw new Error(`Invalid range: "${range}"`);
  // Handle "0:00 - 1:35" — the `-` we want is surrounded by spaces
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
  let   cursor   = 0;

  for (const skip of skips) {
    if (skip.start > cursor) segments.push({ from: cursor, to: skip.start });
    cursor = Math.max(cursor, skip.end);
  }
  if (cursor < durationSec) segments.push({ from: cursor, to: durationSec });

  return segments.filter(s => s.to - s.from > 10); // discard tiny fragments < 10s
}

function segmentsDuration(segments) {
  return segments.reduce((sum, s) => sum + (s.to - s.from), 0);
}

function toIST(date) {
  // Reliable IST string using Intl — works regardless of server timezone
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone:  TIMEZONE,
    year:      'numeric', month:  '2-digit', day:    '2-digit',
    hour:      '2-digit', minute: '2-digit', second: '2-digit',
    hour12:    false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}+05:30`;
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

async function checkEmbeddable(videoId) {
  // Returns true if the video can be embedded in an iframe.
  // 401/403 = embedding disabled by owner; 404 = deleted.
  try {
    const res = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`);
    return res.ok;
  } catch {
    return true; // network error — don't exclude, let it fail at play time
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

  // Respect explicit band_order from config; append any unlisted bands at end
  const ordered = [
    ...BAND_ORDER.filter(id => discovered.includes(id)),
    ...discovered.filter(id => !BAND_ORDER.includes(id)).sort(),
  ];

  const files = ordered.map(id => `${id}.yaml`);

  return files.map(file => {
    const bandId = path.basename(file, '.yaml');
    const raw    = yaml.load(fs.readFileSync(path.join(LIBRARY_DIR, file), 'utf8'));

    const autoName = bandId
      .split('-')
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');

    const seen   = new Set();
    const movies = (raw.movies || [])
      .map(m => {
        let videoId;
        try { videoId = extractVideoId(m.url); } catch (e) {
          console.warn(`  ⚠ [${bandId}] Skipping bad URL: ${m.url}`);
          return null;
        }
        if (seen.has(videoId) && !raw.allow_repeats) {
          console.warn(`  ⚠ [${bandId}] Duplicate video skipped: ${videoId}`);
          return null;
        }
        seen.add(videoId);
        return {
          videoId,
          title:    m.title  || null,
          duration: m.duration ? parseTime(m.duration) : null,
          skip:     m.skip ? (Array.isArray(m.skip) ? m.skip : [m.skip]) : [],
        };
      })
      .filter(Boolean);

    return { id: bandId, name: raw.name || autoName, movies };
  });
}

// ─── Duration resolution ──────────────────────────────────────────────────────

async function resolveDurations(bands) {
  const cache        = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  const issues       = [];
  let   cacheChanged = false;

  for (const band of bands) {
    const resolved = [];
    for (const movie of band.movies) {
      let duration = movie.duration ?? cache[movie.videoId] ?? null;

      if (!duration) {
        if (FETCH_DURATIONS) {
          process.stdout.write(`  Fetching: ${movie.videoId} (${movie.title || 'untitled'})...`);
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
          console.warn(`  ⚠ [${band.id}] No duration for "${movie.title || movie.videoId}" — skipping. Use --fetch-durations to auto-fetch.`);
          continue;
        }
      }

      if (!movie.title) {
        if (FETCH_DURATIONS) {
          movie.title = await fetchTitleOembed(movie.videoId) || movie.videoId;
          console.warn(`  ⚠ [${band.id}] No title for ${movie.videoId} — oEmbed: "${movie.title}"`);
        } else {
          movie.title = movie.videoId;
          console.warn(`  ⚠ [${band.id}] No title for ${movie.videoId} — add one to your YAML`);
        }
      }

      // Skip videos that can't be embedded — they'll never play in the iframe
      if (FETCH_DURATIONS) {
        const embeddable = await checkEmbeddable(movie.videoId);
        if (!embeddable) {
          console.warn(`  ✗ [${band.id}] "${movie.title}" is not embeddable — skipping`);
          issues.push({ band: band.id, videoId: movie.videoId, title: movie.title, reason: 'not-embeddable' });
          continue;
        }
      }

      resolved.push({ ...movie, duration });
    }
    band.movies = resolved;
  }

  if (cacheChanged) fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  return { bands, issues };
}

// ─── Deduplication ────────────────────────────────────────────────────────────

function recentlyPlayedIds(slots) {
  // Only exclude movies that aired within the dedup window
  const cutoff = Date.now() - DEDUP_HOURS * 3600 * 1000;
  return new Set(
    slots
      .filter(s => new Date(s.end).getTime() > cutoff)
      .map(s => s.youtube)
  );
}

// ─── Movie selection ──────────────────────────────────────────────────────────

function shuffle(arr) {
  // Fisher-Yates
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pickMovies(movies, exclude, count) {
  let eligible = movies.filter(m => !exclude.has(m.videoId));

  if (eligible.length === 0) {
    console.warn('  ⚠ All movies within dedup window — using full library');
    eligible = movies;
  }

  // Shuffle eligible pool; wrap around if count > pool size
  const picks = [];
  let   pool  = shuffle(eligible);

  while (picks.length < count) {
    if (pool.length === 0) pool = shuffle(eligible); // wrap
    picks.push(pool.shift());
  }

  return picks;
}

// ─── Schedule generation ──────────────────────────────────────────────────────

function generateBand(band, schedule) {
  const now      = new Date();
  const existing = schedule.slots;

  // Find where the schedule currently ends
  let cursor;
  if (existing.length > 0) {
    const last = existing[existing.length - 1];
    cursor = new Date(last.end);
    if (cursor < now) cursor = START_OVERRIDE || now;
  } else {
    cursor = START_OVERRIDE || now;
  }

  // Check lookahead — skip generation if already well-stocked
  const lookaheadMs  = LOOKAHEAD_HOURS * 3600 * 1000;
  const scheduledMs  = cursor.getTime() - now.getTime();
  if (scheduledMs >= lookaheadMs) {
    console.log(`  Already has ${Math.round(scheduledMs/3600000)}h of lookahead — skipping generation`);
    return existing;
  }

  const exclude  = recentlyPlayedIds(existing);
  const picks    = pickMovies(band.movies, exclude, MOVIES_PER_BATCH);
  const newSlots = [];

  for (const movie of picks) {
    const segments    = computeSegments(movie.duration, movie.skip);
    const playableSec = segmentsDuration(segments);

    if (playableSec < 300) {
      console.warn(`  ⚠ Skipping "${movie.title}" — playable duration too short (${playableSec}s)`);
      continue;
    }

    const start = new Date(cursor);
    const end   = new Date(cursor.getTime() + playableSec * 1000);

    newSlots.push({
      youtube:  movie.videoId,
      title:    movie.title,
      start:    toIST(start),
      end:      toIST(end),
      segments,
    });

    cursor = end;
  }

  console.log(`  Added ${newSlots.length} new slot(s) — schedule now runs to ${toIST(cursor)}`);
  return [...existing, ...newSlots];
}

function pruneSlots(slots) {
  const now = new Date();
  // Keep active slot (started but not ended) + all future slots
  return slots.filter(s => new Date(s.end) > now);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Movie Radio — Schedule Generator');
  console.log(`Timezone:   ${TIMEZONE}`);
  console.log(`Batch:      ${MOVIES_PER_BATCH} movies`);
  console.log(`Lookahead:  ${LOOKAHEAD_HOURS}h`);
  console.log(`Dedup:      last ${DEDUP_HOURS}h`);
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

    console.log(`Band: ${band.id} (${band.movies.length} movie(s))`);
    const schedule    = loadSchedule(band.id);
    const allSlots    = generateBand(band, schedule);
    const prunedSlots = pruneSlots(allSlots);

    fs.writeFileSync(
      path.join(SCHEDULES_DIR, `${band.id}.json`),
      JSON.stringify({ band: band.id, generated: toIST(new Date()), slots: prunedSlots }, null, 2)
    );
    console.log(`  → ${prunedSlots.length} slot(s) written`);
    console.log('');

    index.push({ band: band.id, name: band.name });
  }

  fs.writeFileSync(path.join(SCHEDULES_DIR, 'index.json'), JSON.stringify(index, null, 2));
  console.log(`Index: ${index.length} band(s)`);

  if (issues.length > 0) {
    console.log('');
    console.log('Issues:');
    issues.forEach(i => console.log(`  [${i.reason}] ${i.band} — ${i.title || i.videoId}`));
    if (process.env.CI) {
      fs.writeFileSync(path.join(ROOT, 'cache', 'issues.json'), JSON.stringify(issues, null, 2));
    }
  }

  console.log('');
  console.log('Done.');
}

function loadSchedule(bandId) {
  const file = path.join(SCHEDULES_DIR, `${bandId}.json`);
  if (!fs.existsSync(file)) return { band: bandId, slots: [] };
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    console.warn(`  ⚠ Could not parse ${bandId}.json — starting fresh`);
    return { band: bandId, slots: [] };
  }
}

main().catch(e => { console.error(e); process.exit(1); });
