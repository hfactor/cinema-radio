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
let ytPlayer        = null;
let ytReady         = false;
let schedule        = null;
let bands           = [];
let activeBandIdx   = 0;
let activeSlot      = null;
let activeSegIdx    = 0;
let isPowered       = false;
let tickInterval    = null;
let peekOffset      = 0;
let currentVideoId  = null;
let offAirUntil     = 0;
let audioCtx        = null;
let staticNode      = null;
const scheduleCache = {};

// ─── Time utilities ───────────────────────────────────────────────────────────
function nowSec()    { return Date.now() / 1000; }
function isoSec(iso) { return new Date(iso).getTime() / 1000; }

function fmtTime(date) {
  if (!(date instanceof Date) || isNaN(date)) return '--:--';
  try {
    return date.toLocaleTimeString('en-IN', {
      hour: 'numeric', minute: '2-digit', hour12: true,
      timeZone: CONFIG.timezone,
    });
  } catch {
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true });
  }
}

// ─── Schedule helpers ─────────────────────────────────────────────────────────
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
  const elapsed = slot.loop
    ? (now - isoSec(slot.start)) % slot.loop
    : now - isoSec(slot.start);
  let acc = 0;
  for (let i = 0; i < slot.segments.length; i++) {
    const len = slot.segments[i].to - slot.segments[i].from;
    if (elapsed < acc + len) return { segIdx: i, seekTo: slot.segments[i].from + (elapsed - acc) };
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

  const titleEl = el('display-title');
  if (titleEl.textContent !== slot.title) titleEl.textContent = slot.title;
  if (titleEl.className   !== 'lcd-title') titleEl.className  = 'lcd-title';
  el('progress-fill').style.width = pct + '%';
  const t0 = fmtTime(new Date(slot.start));
  const t1 = fmtTime(new Date(slot.end));
  if (el('time-start').textContent !== t0) el('time-start').textContent = t0;
  if (el('time-end').textContent   !== t1) el('time-end').textContent   = t1;

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
  const iframe = ytPlayer.getIframe();
  iframe.setAttribute('disablepictureinpicture', '');
  const allow = (iframe.getAttribute('allow') || '')
    .split(';').map(s => s.trim())
    .filter(s => s && s !== 'picture-in-picture')
    .join('; ');
  iframe.setAttribute('allow', allow);
  if (isPowered && activeSlot) loadSlot(activeSlot);
}

function onPlayerStateChange(e) {
  if (e.data === YT.PlayerState.ENDED) advanceSegment();
}

function onPlayerError(e) {
  console.warn('YouTube error:', e.data);
  const next = slotAfter(schedule.slots, activeSlot);
  offAirUntil = next ? isoSec(next.start) : nowSec() + 300;
  activeSlot  = null;
  showOffAir();
}

// ─── Static noise ─────────────────────────────────────────────────────────────
function ensureAudioCtx() {
  if (audioCtx) {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return;
  }
  try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch {}
}

function startStatic() {
  if (staticNode || !audioCtx) return;
  try {
    const rate = audioCtx.sampleRate;
    const buf  = audioCtx.createBuffer(1, rate * 2, rate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * 0.06;
    const src  = audioCtx.createBufferSource();
    src.buffer = buf;
    src.loop   = true;
    const gain = audioCtx.createGain();
    gain.gain.value = 0.18;
    src.connect(gain);
    gain.connect(audioCtx.destination);
    src.start(0);
    staticNode = src;
  } catch {}
}

function stopStatic() {
  if (!staticNode) return;
  try { staticNode.stop(); } catch {}
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
  if (slot.youtube === currentVideoId) {
    ytPlayer.seekTo(safeSeek, true);
  } else {
    ytPlayer.loadVideoById({ videoId: slot.youtube, startSeconds: safeSeek });
    currentVideoId = slot.youtube;
  }
  ytPlayer.setVolume(parseInt(el('volume-slider').value, 10));
}

function powerOn() {
  isPowered = true;
  el('btn-power').classList.add('on');
  el('brand-live').classList.add('on');
  document.body.classList.add('powered');
  ensureAudioCtx();
  if (!schedule) return;
  activeSlot = findActiveSlot(schedule.slots);
  loadSlot(activeSlot);
}

function powerOff() {
  isPowered = false;
  el('btn-power').classList.remove('on');
  el('brand-live').classList.remove('on');
  document.body.classList.remove('powered');
  stopStatic();
  if (ytReady) ytPlayer.stopVideo();
}

function advanceSegment() {
  if (!activeSlot) return;
  activeSegIdx++;
  if (activeSegIdx < activeSlot.segments.length) {
    ytPlayer.seekTo(activeSlot.segments[activeSegIdx].from, true);
  } else if (nowSec() < isoSec(activeSlot.end)) {
    activeSegIdx = 0;
    ytPlayer.seekTo(activeSlot.segments[0].from, true);
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

  if (!activeSlot) {
    if (now >= offAirUntil) {
      const slot = findActiveSlot(schedule.slots);
      if (slot) { offAirUntil = 0; activeSlot = slot; loadSlot(slot); }
    }
    return;
  }

  if (now >= isoSec(activeSlot.end)) {
    activeSlot = null;
    const slot = findActiveSlot(schedule.slots);
    if (slot) { activeSlot = slot; loadSlot(slot); }
    else showOffAir();
    return;
  }

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

// ─── Tuner strip ──────────────────────────────────────────────────────────────
function buildTunerStrip() {
  const strip = el('tuner-strip');
  if (!strip || !bands.length) return;

  const n = bands.length;
  let html = '';

  const TICK_COUNT = 40;
  for (let i = 0; i <= TICK_COUNT; i++) {
    const pct = (i / TICK_COUNT) * 100;
    const isMajor = i % 5 === 0;
    html += `<div class="s-tick${isMajor ? ' major' : ''}" style="left:${pct}%"></div>`;
  }

  bands.forEach((band, idx) => {
    const pct    = ((idx + 0.5) / n) * 100;
    const letter = band.name.charAt(0).toUpperCase();
    html += `<div class="s-tick band-tick" style="left:${pct}%"></div>`;
    html += `<div class="s-label" data-idx="${idx}" style="left:${pct}%">${letter}</div>`;
  });

  strip.innerHTML = html;
  updateTunerStrip(false);
}

function updateTunerStrip(animate) {
  const strip  = el('tuner-strip');
  const needle = document.querySelector('.tuner-needle');
  if (!strip || !needle || !bands.length) return;

  const pct = ((activeBandIdx + 0.5) / bands.length) * 100;

  if (animate === false) { needle.style.transition = 'none'; needle.offsetHeight; }
  needle.style.left = pct + '%';
  if (animate === false) { needle.offsetHeight; needle.style.transition = ''; }

  strip.querySelectorAll('.s-label').forEach((node, i) => {
    node.classList.toggle('active', i === activeBandIdx);
  });
}

function spinWheel(forward) {
  const face = el('dial-face');
  if (!face) return;
  face.style.animation = 'none';
  void face.offsetWidth;
  face.style.animation = '';
  face.classList.remove('spin-fwd', 'spin-back');
  face.classList.add(forward ? 'spin-fwd' : 'spin-back');
}

// ─── Band loading ─────────────────────────────────────────────────────────────
function applySchedule(data) {
  schedule   = data;
  peekOffset = 0;
  activeSlot = findActiveSlot(schedule.slots);
  loadSlot(activeSlot);
}

function loadBand(bandIdx) {
  activeBandIdx = bandIdx;
  const band = bands[bandIdx];
  el('band-label').textContent = band.name;
  updateTunerStrip();

  if (scheduleCache[band.band]) {
    applySchedule(scheduleCache[band.band]);
    return;
  }

  fetch(CONFIG.schedulePath(band.band))
    .then(r => { if (!r.ok) throw new Error(); return r.json(); })
    .then(data => { scheduleCache[band.band] = data; applySchedule(data); })
    .catch(() => showOffAir());
}

function prefetchBands() {
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
  const bandName = bands[activeBandIdx]?.name || '';
  el('schedule-title').textContent = bandName ? `${bandName}: Today's Programme` : "Today's Programme";
  list.innerHTML = '';

  schedule.slots.forEach(slot => {
    const startSec = isoSec(slot.start);
    const endSec   = isoSec(slot.end);
    const isNow    = startSec <= now && now < endSec;
    const isPast   = endSec <= now;
    const row = document.createElement('div');
    row.className = 'sched-row' + (isNow ? ' now' : isPast ? ' past' : '');
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
  const [indexRes, scheduleRes] = await Promise.allSettled([
    fetch(CONFIG.indexPath).then(r => r.ok ? r.json() : Promise.reject()),
    fetch(CONFIG.schedulePath(CONFIG.defaultBand)).then(r => r.ok ? r.json() : Promise.reject()),
  ]);

  bands = indexRes.status === 'fulfilled'
    ? indexRes.value
    : [{ band: CONFIG.defaultBand, name: 'Malayalam' }];

  activeBandIdx = Math.max(0, bands.findIndex(b => b.band === CONFIG.defaultBand));
  buildTunerStrip();
  el('band-label').textContent = bands[activeBandIdx].name;

  if (scheduleRes.status === 'fulfilled') {
    scheduleCache[bands[activeBandIdx].band] = scheduleRes.value;
    applySchedule(scheduleRes.value);
  } else {
    loadBand(activeBandIdx);
  }

  prefetchBands();
  tickInterval = setInterval(tick, 1000);

  // Thumbwheel
  {
    const dial = el('dial');
    let startX = 0, startY = 0, dragging = false;
    const THRESHOLD = 18;

    function switchStatic() {
      if (isPowered && audioCtx) { stopStatic(); startStatic(); }
    }
    function dialNext() {
      if (bands.length > 1) {
        spinWheel(true); switchStatic();
        loadBand((activeBandIdx + 1) % bands.length);
        el('dial').classList.add('used');
      }
    }
    function dialPrev() {
      if (bands.length > 1) {
        spinWheel(false); switchStatic();
        loadBand((activeBandIdx - 1 + bands.length) % bands.length);
        el('dial').classList.add('used');
      }
    }

    dial.addEventListener('pointerdown', e => {
      startX = e.clientX; startY = e.clientY; dragging = false;
      dial.setPointerCapture(e.pointerId);
    });
    dial.addEventListener('pointermove', e => {
      if (Math.abs(e.clientX - startX) > 4 || Math.abs(e.clientY - startY) > 4) dragging = true;
    });
    dial.addEventListener('pointerup', e => {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      Math.sqrt(dx * dx + dy * dy) < THRESHOLD ? dialNext() : (dx + dy > 0 ? dialNext() : dialPrev());
    });
    dial.addEventListener('wheel', e => {
      e.preventDefault();
      e.deltaY > 0 ? dialNext() : dialPrev();
    }, { passive: false });
  }

  // Power
  el('btn-power').addEventListener('click', () => isPowered ? powerOff() : powerOn());

  // Volume
  function syncVolFill(slider) { slider.style.setProperty('--fill', slider.value + '%'); }
  const volSlider = el('volume-slider');
  syncVolFill(volSlider);
  volSlider.addEventListener('input', e => {
    syncVolFill(e.target);
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
