/**
 * Cinema Radio — Playback Engine
 */

// ─── Config ───────────────────────────────────────────────────────────────────
const CONFIG = {
  defaultBand:  'comedy-malayalam',
  timezone:     'Asia/Kolkata',
  indexPath:    'schedules/index.json',
  schedulePath: band => `schedules/${band}.json`,
};

// ─── State ────────────────────────────────────────────────────────────────────
let ytPlayer          = null;
let ytReady           = false;
let schedule          = null;
let bands             = [];
let activeBandIdx     = 0;
let activeSlot        = null;
let activeSegIdx      = 0;
let isPowered         = false;
let tickInterval      = null;
let peekOffset        = 0;
let offAirUntil       = 0;     // epoch sec — don't retry a failed slot until this time passes
let audioCtx          = null;  // Web Audio context for static noise (created on power-on gesture)
let staticNode        = null;  // currently playing static source node
const scheduleCache   = {};   // pre-fetched schedules keyed by band id

// ─── Time utilities ────────────────────────────────────────────────────────────
function nowSec()    { return Date.now() / 1000; }
function isoSec(iso) { return new Date(iso).getTime() / 1000; }

function fmtTime(date) {
  if (!(date instanceof Date) || isNaN(date)) return '--:--';
  try {
    return date.toLocaleTimeString('en-IN', {
      hour: 'numeric', minute: '2-digit', hour12: true,
      timeZone: CONFIG.timezone,
    });
  } catch (e) {
    // Fallback for iOS Safari when en-IN locale or timezone option fails
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true });
  }
}

// ─── Schedule helpers ──────────────────────────────────────────────────────────
function findActiveSlot(slots) {
  const now = nowSec();
  return slots.find(s => isoSec(s.start) <= now && now < isoSec(s.end)) || null;
}

function slotAfter(slots, slot) {
  const i = slots.indexOf(slot);
  return i >= 0 ? slots[i + 1] || null : null;
}

function upcomingSlots(slots) {
  const now = nowSec();
  return slots.filter(s => isoSec(s.start) > now);
}

function computeSeek(slot) {
  const now     = nowSec();
  const elapsed = now - isoSec(slot.start);
  let   acc     = 0;
  for (let i = 0; i < slot.segments.length; i++) {
    const len = slot.segments[i].to - slot.segments[i].from;
    if (elapsed < acc + len) {
      return { segIdx: i, seekTo: slot.segments[i].from + (elapsed - acc) };
    }
    acc += len;
  }
  const last = slot.segments[slot.segments.length - 1];
  return { segIdx: slot.segments.length - 1, seekTo: last.to - 1 };
}

// ─── Display ──────────────────────────────────────────────────────────────────
let progressTransitionEnabled = false;

function updateDisplay(slot) {
  if (!slot) { showOffAir(); return; }
  const now   = nowSec();
  const total = isoSec(slot.end) - isoSec(slot.start);
  const pct   = Math.min(100, (Math.max(0, now - isoSec(slot.start)) / total) * 100);

  el('display-title').textContent = slot.title;
  el('display-title').className   = 'lcd-title';
  el('progress-fill').style.width = pct + '%';
  el('time-start').textContent    = fmtTime(new Date(slot.start));
  el('time-end').textContent      = fmtTime(new Date(slot.end));

  // Enable smooth transition only after the first real render,
  // so the bar doesn't sweep in from 0 on page load
  if (!progressTransitionEnabled) {
    progressTransitionEnabled = true;
    requestAnimationFrame(() => {
      el('progress-fill').style.transition = 'width 1s linear';
    });
  }
}

function updateNext(peekSlot) {
  if (!peekSlot) {
    el('next-title').textContent = '—';
    el('next-time').textContent  = '';
    return;
  }
  el('next-title').textContent = peekSlot.title;
  el('next-time').textContent  = fmtTime(new Date(peekSlot.start));
}

function showOffAir() {
  const next = schedule ? upcomingSlots(schedule.slots)[0] : null;
  el('display-title').textContent = 'OFF AIR';
  el('display-title').className   = 'lcd-title off-air';
  el('progress-fill').style.width = '0%';
  el('time-start').textContent    = '—';
  el('time-end').textContent      = next ? fmtTime(new Date(next.start)) : '—';
  el('next-title').textContent    = next ? next.title : '—';
  el('next-time').textContent     = next ? fmtTime(new Date(next.start)) : '';
  if (isPowered) startStatic();
}

// ─── YouTube ──────────────────────────────────────────────────────────────────
window.onYouTubeIframeAPIReady = function () {
  ytPlayer = new YT.Player('yt-player', {
    height: '1', width: '1',
    playerVars: {
      autoplay: 0, controls: 0, disablekb: 1,
      fs: 0, iv_load_policy: 3, modestbranding: 1, rel: 0,
    },
    events: {
      onReady:       onPlayerReady,
      onStateChange: onPlayerStateChange,
      onError:       onPlayerError,
    },
  });
};

function onPlayerReady() {
  ytReady = true;

  // Block Picture-in-Picture
  const iframe = ytPlayer.getIframe();
  iframe.setAttribute('disablepictureinpicture', '');
  const allow = (iframe.getAttribute('allow') || '')
    .split(';').map(s => s.trim())
    .filter(s => s && s !== 'picture-in-picture')
    .join('; ');
  iframe.setAttribute('allow', allow);

  // If user pressed power before the player was ready, kick off playback now
  if (isPowered && activeSlot) loadSlot(activeSlot);
}

function onPlayerStateChange(e) {
  if (e.data === YT.PlayerState.ENDED) advanceSegment();
}

function onPlayerError(e) {
  console.warn('YouTube error:', e.data);
  // Skip the failed slot — wait until the next one is scheduled to start.
  // tick() will pick it up automatically.
  const next = slotAfter(schedule.slots, activeSlot);
  offAirUntil = next ? isoSec(next.start) : nowSec() + 300;
  activeSlot  = null;
  showOffAir();
}

// ─── Static noise ─────────────────────────────────────────────────────────────
function ensureAudioCtx() {
  // Must be called from a user gesture (power-on) to satisfy autoplay policy
  if (audioCtx) {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return;
  }
  try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {}
}

function startStatic() {
  if (staticNode || !audioCtx) return;
  try {
    const rate    = audioCtx.sampleRate;
    const buf     = audioCtx.createBuffer(1, rate * 2, rate); // 2s loop
    const data    = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * 0.06;
    const src     = audioCtx.createBufferSource();
    src.buffer    = buf;
    src.loop      = true;
    const gain    = audioCtx.createGain();
    gain.gain.value = 0.18;
    src.connect(gain);
    gain.connect(audioCtx.destination);
    src.start(0);
    staticNode = src;
  } catch (e) {}
}

function stopStatic() {
  if (!staticNode) return;
  try { staticNode.stop(); } catch (e) {}
  staticNode = null;
}

// ─── Playback ─────────────────────────────────────────────────────────────────
function loadSlot(slot) {
  if (!slot) { showOffAir(); return; }
  const { segIdx, seekTo } = computeSeek(slot);
  activeSegIdx = segIdx;
  updateDisplay(slot);
  peekOffset = 0;
  updateNext(slotAfter(schedule.slots, slot));

  if (!ytReady || !isPowered) return;
  stopStatic();
  const safeSeek = isFinite(seekTo) && seekTo >= 0 ? Math.floor(seekTo) : 0;
  ytPlayer.loadVideoById({ videoId: slot.youtube, startSeconds: safeSeek });
  ytPlayer.setVolume(parseInt(el('volume-slider').value, 10));
}

function powerOn() {
  isPowered = true;
  el('btn-power').classList.add('on');
  el('brand-live').classList.add('on');
  document.body.classList.add('powered');
  ensureAudioCtx(); // create AudioContext from user gesture so static noise can play later
  if (!schedule) return;
  const slot = findActiveSlot(schedule.slots);
  activeSlot = slot;
  // loadSlot handles the ytReady guard — if the player isn't ready yet,
  // onPlayerReady will call loadSlot again once it fires.
  loadSlot(slot);
}

function powerOff() {
  isPowered = false;
  el('btn-power').classList.remove('on');
  el('brand-live').classList.remove('on');
  document.body.classList.remove('powered');
  stopStatic();
  if (ytReady) ytPlayer.stopVideo();
  // Display stays live — shows what's on even when not listening
}

function advanceSegment() {
  if (!activeSlot) return;
  activeSegIdx++;
  if (activeSegIdx < activeSlot.segments.length) {
    ytPlayer.seekTo(activeSlot.segments[activeSegIdx].from, true);
  } else {
    const next = slotAfter(schedule.slots, activeSlot);
    if (next) { activeSlot = next; loadSlot(next); }
    else { activeSlot = null; showOffAir(); }
  }
}

// ─── Tick ─────────────────────────────────────────────────────────────────────
function tick() {
  if (!schedule) return;
  const now = nowSec();

  // Off-air: keep scanning until a slot becomes active (respects offAirUntil to avoid
  // infinite retries on non-embeddable or deleted videos)
  if (!activeSlot) {
    if (now >= offAirUntil) {
      const slot = findActiveSlot(schedule.slots);
      if (slot) { offAirUntil = 0; activeSlot = slot; loadSlot(slot); }
    }
    return;
  }

  // Slot ended?
  if (now >= isoSec(activeSlot.end)) {
    activeSlot = null;
    const slot = findActiveSlot(schedule.slots);
    if (slot) { activeSlot = slot; loadSlot(slot); }
    else showOffAir();
    return;
  }

  // Segment boundary check (only while powered)
  if (isPowered && activeSlot.segments[activeSegIdx]) {
    const seg     = activeSlot.segments[activeSegIdx];
    const elapsed = now - isoSec(activeSlot.start);
    let   acc     = 0;
    for (let i = 0; i < activeSegIdx; i++)
      acc += activeSlot.segments[i].to - activeSlot.segments[i].from;
    if (elapsed >= acc + (seg.to - seg.from)) { advanceSegment(); return; }
  }

  if (peekOffset === 0) updateDisplay(activeSlot);
}

// ─── Band dial ────────────────────────────────────────────────────────────────
function renderBandDots() {
  const area = el('tuner-dial-area');
  area.querySelectorAll('.tuner-dot').forEach(d => d.remove());

  const n    = bands.length;
  const cx   = 36;
  const cy   = 36;
  const r    = 29;
  const dotR = 3;   // half of 6px dot

  bands.forEach((band, idx) => {
    const angleDeg = (360 / n) * idx;
    const angleRad = (angleDeg - 90) * (Math.PI / 180);
    const x = cx + r * Math.cos(angleRad) - dotR;
    const y = cy + r * Math.sin(angleRad) - dotR;

    const dot = document.createElement('div');
    dot.className  = 'tuner-dot' + (idx === activeBandIdx ? ' active' : '');
    dot.title      = band.name;
    dot.style.left = x.toFixed(1) + 'px';
    dot.style.top  = y.toFixed(1) + 'px';
    dot.addEventListener('click', e => { e.stopPropagation(); loadBand(idx); });
    area.appendChild(dot);
  });

  const dialAngle = (360 / n) * activeBandIdx;
  el('dial-face').style.transform = `rotate(${dialAngle}deg)`;
}

function applySchedule(data) {
  schedule   = data;
  peekOffset = 0;
  const slot = findActiveSlot(schedule.slots);
  activeSlot = slot;
  loadSlot(slot);
}

function loadBand(bandIdx) {
  activeBandIdx = bandIdx;
  const band = bands[bandIdx];
  el('band-label').textContent = band.name;
  renderBandDots();

  // Use cache if available — keeps loadVideoById in the synchronous
  // gesture call stack, which iOS requires for media playback
  if (scheduleCache[band.band]) {
    applySchedule(scheduleCache[band.band]);
    return;
  }

  fetch(CONFIG.schedulePath(band.band))
    .then(r => { if (!r.ok) throw new Error(); return r.json(); })
    .then(data => {
      scheduleCache[band.band] = data;
      applySchedule(data);
    })
    .catch(() => showOffAir());
}

function prefetchBands() {
  // Fetch all non-default band schedules silently in the background
  // so they're ready in cache before the user taps the dial
  bands.forEach(band => {
    if (scheduleCache[band.band]) return;
    fetch(CONFIG.schedulePath(band.band))
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data) scheduleCache[band.band] = data; })
      .catch(() => {});
  });
}

// ─── Schedule modal ───────────────────────────────────────────────────────────
function openSchedule() {
  if (!schedule) return;
  const now  = nowSec();
  const list = el('schedule-list');

  el('modal-band').textContent = bands[activeBandIdx]?.name || '';
  list.innerHTML = '';

  const cutoff = now + 24 * 3600; // 24 hours ahead
  const visibleSlots = schedule.slots.filter(s => isoSec(s.end) > now && isoSec(s.start) < cutoff);

  visibleSlots.forEach(slot => {
    const isNow  = isoSec(slot.start) <= now && now < isoSec(slot.end);
    const row = document.createElement('div');
    row.className = 'sched-row' + (isNow ? ' now' : '');
    row.innerHTML = `
      <span class="sched-time">${fmtTime(new Date(slot.start))}</span>
      <span class="sched-movie">${slot.title}</span>
    `;
    list.appendChild(row);
  });

  openModal('schedule-wrap');
}

// ─── Modal helpers ────────────────────────────────────────────────────────────
function openModal(id)  { el(id).classList.add('open'); }
function closeModal(id) { el(id).classList.remove('open'); }

// ─── Tab visibility ───────────────────────────────────────────────────────────
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && isPowered && ytReady && activeSlot) {
    const slot = findActiveSlot(schedule?.slots || []);
    if (slot) {
      activeSlot   = slot;
      const { seekTo, segIdx } = computeSeek(slot);
      activeSegIdx = segIdx;
      ytPlayer.seekTo(seekTo, true);
    }
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function el(id) { return document.getElementById(id); }

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  // Kick off both fetches in parallel — don't wait for index before loading schedule
  const [indexRes, scheduleRes] = await Promise.allSettled([
    fetch(CONFIG.indexPath).then(r => r.ok ? r.json() : Promise.reject()),
    fetch(CONFIG.schedulePath(CONFIG.defaultBand)).then(r => r.ok ? r.json() : Promise.reject()),
  ]);

  // Band index
  bands = indexRes.status === 'fulfilled'
    ? indexRes.value
    : [{ band: CONFIG.defaultBand, name: 'Malayalam' }];

  activeBandIdx = Math.max(0, bands.findIndex(b => b.band === CONFIG.defaultBand));
  renderBandDots();
  el('band-label').textContent = bands[activeBandIdx].name;

  // Default band schedule — already in hand, no second round trip
  if (scheduleRes.status === 'fulfilled') {
    scheduleCache[bands[activeBandIdx].band] = scheduleRes.value;
    applySchedule(scheduleRes.value);
  } else {
    loadBand(activeBandIdx);   // fallback: try again normally
  }

  // Pre-fetch all other bands in the background so dial switches
  // are synchronous (required for iOS media playback gesture policy)
  prefetchBands();

  tickInterval = setInterval(tick, 1000);

  // Dial — click rotates one step clockwise
  el('dial').addEventListener('click', () => {
    if (bands.length < 2) return;
    loadBand((activeBandIdx + 1) % bands.length);
  });

  // Power button — first click starts audio (satisfies browser autoplay policy)
  el('btn-power').addEventListener('click', () => {
    if (!isPowered) powerOn();
    else powerOff();
  });

  // Volume
  el('volume-slider').addEventListener('input', e => {
    if (ytReady && isPowered) ytPlayer.setVolume(parseInt(e.target.value, 10));
  });

  // Next peek
  el('btn-next-peek').addEventListener('click', () => {
    if (!schedule) return;
    const upcoming = upcomingSlots(schedule.slots);
    if (upcoming.length === 0) return;
    peekOffset = (peekOffset + 1) % upcoming.length;
    const peek = upcoming[peekOffset];
    el('display-title').textContent = peek.title;
    el('display-title').className   = 'lcd-title';
    el('time-start').textContent    = fmtTime(new Date(peek.start));
    el('time-end').textContent      = fmtTime(new Date(peek.end));
    el('progress-fill').style.width = '0%';
    updateNext(upcoming[peekOffset + 1] || null);
  });

  // Schedule modal
  el('btn-schedule').addEventListener('click', openSchedule);
  el('schedule-close').addEventListener('click', () => closeModal('schedule-wrap'));
  el('schedule-wrap').addEventListener('click', e => {
    if (e.target === el('schedule-wrap')) closeModal('schedule-wrap');
  });

  // About modal
  el('btn-about').addEventListener('click', () => openModal('about-wrap'));
  el('about-close').addEventListener('click', () => closeModal('about-wrap'));
  el('about-wrap').addEventListener('click', e => {
    if (e.target === el('about-wrap')) closeModal('about-wrap');
  });
}

init();
