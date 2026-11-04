const layerTimingOpen = {drawing: false, text: false};
let rangeGesture = null, scrubGesture = null,
    lastPlaybackTimingUpdate = 0;
// The shortest range a trim or layer can have: 0.2 s is at least two frames of output
// even at 2× speed, so an export never comes out empty.
function timeGap() {
  return Math.min(.2, Math.max(0, duration));
}
function normalizeTimings() {
  if (mediaType !== 'video' || !Number.isFinite(duration) || duration <= 0)
    return;
  const gap = timeGap();
  state.start = clamp(Number(state.start) || 0, 0, Math.max(0, duration - gap));
  state.end = clamp(Number(state.end) || duration, state.start + gap, duration);
  for (const layer of [...(state.drawingLayers || []), ...(state.texts || [])]) {
    layer.start = clamp(Number(layer.start) || 0, 0, Math.max(0, duration - gap));
    if (layer.end != null)
      layer.end = clamp(Number(layer.end) || duration, layer.start + gap, duration);
  }
  const length = (state.end - state.start) / state.speed;
  state.fadeIn = clamp(state.fadeIn || 0, 0, Math.min(3, length));
  state.fadeOut = clamp(state.fadeOut || 0, 0, Math.min(3, length - state.fadeIn));
}
// The layer a timing control edits: the selected drawing or text layer.
function timedLayer(scope) {
  return scope === 'drawing' ? selectedDrawing() : scope === 'text' ? selectedText() : null;
}
function timeRange(scope) {
  if (scope !== 'trim')
    return {start: timedLayer(scope)?.start || 0, end: timedLayer(scope)?.end ?? duration};
  return {start: state.start, end: state.end};
}
function drawingVisible(s, t = video.currentTime) {
  if (mediaType !== 'video') return true;
  const start = s.start || 0, end = s.end ?? duration;
  return t >= start && (t < end || (end >= duration && t <= duration));
}
function formatPreciseTime(t) {
  const ticks = Math.max(0, Math.round((Number(t) || 0) * 100)),
        mins = Math.floor(ticks / 6000),
        secs = ((ticks % 6000) / 100).toFixed(2).padStart(5, '0');
  return mins + ':' + secs;
}

function timeRangeControls(scope) {
  const range = timeRange(scope), name = {trim: 'Trim', drawing: 'Drawing', text: 'Text'}[scope];
  return `<div class="time-range" data-time-range="${scope}" aria-label="${
      name} time range"><div class="time-range-rail"><div class="time-range-background"></div><div class="time-range-shade before"></div><div class="time-range-shade after"></div><div class="time-range-selection"></div><i class="time-range-playhead"></i><button class="time-range-handle start" data-range-handle="start" role="slider" aria-label="${
      name} start time" aria-valuemin="0" aria-valuemax="${
      duration}" aria-valuenow="${
      range.start.toFixed(2)}" aria-valuetext="${formatPreciseTime(range.start)}" tabindex="0"><span></span></button><button class="time-range-handle end" data-range-handle="end" role="slider" aria-label="${
      name} end time" aria-valuemin="0" aria-valuemax="${
      duration}" aria-valuenow="${
      range.end.toFixed(2)}" aria-valuetext="${formatPreciseTime(range.end)}" tabindex="0"><span></span></button></div></div><div class="time-fields"><label>Start (seconds)<input class="field" data-time-field="start" data-time-scope="${
      scope}" aria-label="${
      name} start in seconds" type="number" min="0" max="${
      duration}" step=".01" value="${
      range.start.toFixed(
          2)}" onchange="timeFieldChange(this)"></label><label>End (seconds)<input class="field" data-time-field="end" data-time-scope="${
      scope}" aria-label="${name} end in seconds" type="number" min="0" max="${
      duration}" step=".01" value="${
      range.end.toFixed(2)}" onchange="timeFieldChange(this)"></label></div>`;
}
function trimControls() {
  const length = (state.end - state.start) / state.speed;
  return timeRangeControls('trim') +
      `<div class="fade-row">${fadeSlider('fadeIn', 'Fade in', length)}${fadeSlider('fadeOut', 'Fade out', length)}</div>`;
}
// Fades from and to black, picture and sound, in seconds of the exported clip.
function fadeSlider(key, label, length) {
  const max = Math.max(0, Math.min(3, length - (key === 'fadeIn' ? state.fadeOut : state.fadeIn)));
  return `<div class="slider-row"><label for="range-${key}">${label}</label><input id="range-${key}" type="range" aria-label="${
      label}" min="0" max="${max.toFixed(1)}" step=".1" value="${state[key] || 0}" onpointerdown="commit()" onkeydown="if(!event.repeat)commit()" oninput="setFade('${
      key}',+this.value)"><output id="out-${key}">${sliderText(key, state[key] || 0)}</output></div>`;
}
function setFade(key, value) {
  state[key] = value;
  $('out-' + key).value = sliderText(key, value);
  const other = key === 'fadeIn' ? 'fadeOut' : 'fadeIn', length = (state.end - state.start) / state.speed;
  if ($('range-' + other)) $('range-' + other).max = Math.max(0, Math.min(3, length - value)).toFixed(1);
  persist();
  draw();
}
// Speed and volume share the Playback tab: both change how the clip plays.
function playbackControls() {
  return '<div class="slider-row playback-speed" role="group" aria-labelledby="speedLabel"><span class="row-label" id="speedLabel">Speed</span><div class="chips speed-options">' +
      [.5, .75, 1, 1.5, 2]
          .map(v => chip(v + '×', state.speed === v, `setPlaybackSpeed(${v})`))
          .join('') +
      '</div></div>' + audioControls();
}
function setPlaybackSpeed(value) {
  commit();
  state.speed = clamp(Number(value), .5, 2);
  video.playbackRate = state.speed;
  persist();
  renderTool();
}
function audioControls() {
  if (!sourceHasAudio)
    return '<p class="layer-hint playback-note">This video has no sound track the phone can play.</p>';
  const level = state.mute ? 0 : Math.round(state.volume * 100);
  return `<div class="slider-row audio-level"><label for="volumeLevel">Volume</label><input id="volumeLevel" aria-label="Volume" type="range" min="0" max="100" step="1" value="${
      level}" onpointerdown="commit()" onkeydown="if(!event.repeat)commit()" oninput="setVolumeLevel(+this.value)"><output id="volumeValue">${
      level}%</output></div>`;
}
function setVolumeLevel(value) {
  value = clamp(value, 0, 100);
  state.volume = value / 100;
  state.mute = value === 0;
  video.volume = state.volume;
  video.muted = state.mute;
  $('volumeValue').value = value + '%';
  persist();
}

// When a drawing or text layer is on screen in a video.
function layerTimingControls(scope) {
  if (mediaType !== 'video' || !timedLayer(scope)) return '';
  const r = timeRange(scope), open = layerTimingOpen[scope];
  return `<button class="drawing-timing-toggle secondary ${open ? 'selected' : ''}" aria-label="Timing for selected ${
             scope} layer" aria-expanded="${open}" onclick="toggleLayerTiming('${scope}')">${
             icon('clock')}<span>Layer timing</span><span class="drawing-time-summary" data-timing-summary="${scope}">${
             formatPreciseTime(r.start)}–${formatPreciseTime(r.end)}</span></button>` +
      (open ?
           '<div class="drawing-timing-panel">' + timeRangeControls(scope) +
               `<div class="drawing-timing-footer"><button class="reset" onclick="resetLayerTiming('${scope}')">Reset timing</button></div></div>` :
           '');
}
function toggleLayerTiming(scope) {
  layerTimingOpen[scope] = !layerTimingOpen[scope];
  renderTool();
  document.querySelector('.drawing-timing-panel')?.classList.add('reveal');
  if (layerTimingOpen[scope])
    requestAnimationFrame(() => {
      const area = document.querySelector('.tool-area'),
            toggle = document.querySelector('.drawing-timing-toggle');
      area.scrollTop += toggle.getBoundingClientRect().top -
          area.getBoundingClientRect().top -
          (document.querySelector('.drawing-layer-row')?.offsetHeight || 0) -
          parseFloat(getComputedStyle(area).paddingTop) - 12;
    });
}
function setTimeEndpoint(
    scope, side, value, {record = false, seek = true} = {}) {
  if (!Number.isFinite(value) || duration <= 0 ||
      (scope !== 'trim' && !timedLayer(scope))) return false;
  if (record) commit();
  video.pause();
  const r = timeRange(scope), gap = timeGap();
  value = side === 'start' ?
      clamp(value, 0, Math.max(0, r.end - gap)) :
      clamp(value, Math.min(duration, r.start + gap), duration);
  if (scope === 'trim')
    state[side] = value;
  else
    timedLayer(scope)[side] = value;
  const updated = timeRange(scope);
  if (seek)
    video.currentTime = side === 'end' ?
        Math.max(
            updated.start,
            updated.end - Math.min(.01, (updated.end - updated.start) / 2)) :
        updated.start;
  syncTimeUI();
  draw();
  return true;
}
function timeFieldChange(input) {
  const value = Math.round(Number(input.value) * 100) / 100;
  if (!input.value.trim() || !Number.isFinite(value)) {
    syncTimeUI(true);
    return;
  }
  setTimeEndpoint(
      input.dataset.timeScope, input.dataset.timeField, value, {record: true});
  persist();
  syncTimeUI(true);
}
function resetLayerTiming(scope) {
  const layer = timedLayer(scope);
  if (!layer) return;
  commit();
  layer.start = 0;
  layer.end = null;
  persist();
  syncTimeUI();
  draw();
}
// Shows the selected layer: if the playhead is outside its time, it moves to its start.
function ensureLayerPreviewTime(scope) {
  if (mediaType !== 'video' || !timedLayer(scope)) return;
  const r = timeRange(scope);
  if (video.currentTime < r.start || video.currentTime >= r.end)
    video.currentTime = r.start;
}
function scrubTo(value) {
  if (mediaType !== 'video' || !state || duration <= 0) return;
  const time = clamp(value, 0, duration);
  if (scrubGesture) scrubGesture.value = time;
  video.currentTime = time;
  syncPlaybackTiming(time);
}
function syncPlaybackTiming(requestedTime = null) {
  if (mediaType !== 'video' || !state) return;
  const now = performance.now();
  if (requestedTime === null && !video.paused &&
      now - lastPlaybackTimingUpdate < 32) return;
  lastPlaybackTimingUpdate = now;
  const time = scrubGesture ? scrubGesture.value : requestedTime ?? video.currentTime;
  $('playTime').textContent = formatPreciseTime(time);
  $('scrub').value = time;
  // The playhead is its own layer moved by transform, so playback doesn't restyle or
  // repaint the rail around it.
  for (const range of document.querySelectorAll('[data-time-range]')) {
    const view = timingViewport(range), head = range.querySelector('.time-range-playhead');
    head.style.transform = `translateX(${timingPercent(time, range)}%)`;
    head.classList.toggle('hidden', time < view.start || time > view.end);
  }
}
function syncTimeUI(forceFields = false) {
  if (mediaType !== 'video' || !state || duration <= 0) return;
  const trim = timeRange('trim'),
        s = timingPercent(trim.start, $('playheadTrack')),
        e = timingPercent(trim.end, $('playheadTrack')),
        scrubView = timingViewport($('playheadTrack'));
  $('playheadTrack').style.setProperty('--from', s + '%');
  $('playheadTrack').style.setProperty('--to', e + '%');
  $('playheadTrack')
      .querySelector('.before')
      .classList.toggle('hidden', trim.start <= scrubView.start + .000001);
  $('playheadTrack')
      .querySelector('.after')
      .classList.toggle('hidden', scrubView.end - trim.end <= .000001);
  for (const range of document.querySelectorAll('[data-time-range]')) {
    const r = timeRange(range.dataset.timeRange), view = timingViewport(range);
    range.querySelector('.time-range-shade.before')
        .classList.toggle('hidden', r.start <= view.start + .000001);
    range.querySelector('.time-range-shade.after')
        .classList.toggle('hidden', view.end - r.end <= .000001);
    range.style.setProperty(
        '--from', timingPercent(r.start, range) + '%');
    range.style.setProperty(
        '--to', timingPercent(r.end, range) + '%');
    for (const side of ['start', 'end']) {
      const handle = range.querySelector('[data-range-handle="' + side + '"]');
      handle.style.left = timingPercent(r[side], range) + '%';
      handle.classList.toggle('outside-view',
          r[side] < view.start - .000001 || r[side] > view.end + .000001);
      handle.setAttribute('aria-valuenow', r[side].toFixed(2));
      handle.setAttribute('aria-valuetext', formatPreciseTime(r[side]));
      handle.setAttribute(
          'aria-valuemin',
          side === 'start' ? '0' : (r.start + timeGap()).toFixed(2));
      handle.setAttribute(
          'aria-valuemax',
          side === 'end' ? String(duration) : (r.end - timeGap()).toFixed(2));
    }
  }
  for (const field of document.querySelectorAll('[data-time-field]'))
    if (forceFields || field !== document.activeElement)
      field.value =
          timeRange(field.dataset.timeScope)[field.dataset.timeField].toFixed(
              2);
  $('playTotal').textContent = '/ ' + formatPreciseTime(duration);
  for (const summary of document.querySelectorAll('[data-timing-summary]')) {
    const r = timeRange(summary.dataset.timingSummary);
    summary.textContent =
        formatPreciseTime(r.start) + '–' + formatPreciseTime(r.end);
  }
  syncPlaybackTiming();
}
// A precision hold is armed only at pointerdown. Movement cancels that
// eligibility permanently for this touch; stopping later never rearms it.
const precisionHoldDelay = 700, precisionMoveTolerance = 5;
function activeTimingGesture() { return rangeGesture || scrubGesture; }
function timingViewport(target) {
  const g = activeTimingGesture();
  return g?.target === target && g.zoom ? g.zoom : {start: 0, end: duration};
}
function timingPercent(value, target) {
  const view = timingViewport(target), span = view.end - view.start;
  return span > 0 ? clamp((value - view.start) / span * 100, 0, 100) : 0;
}
function cancelPrecisionHold(g) {
  clearTimeout(g.holdTimer);
  g.holdTimer = null;
  g.holdCancelled = true;
}
function armPrecisionHold(g, event, eligible) {
  g.downX = event.clientX;
  g.downY = event.clientY;
  g.holdCancelled = !eligible;
  if (!eligible) return;
  g.holdTimer = setTimeout(() => {
    g.holdTimer = null;
    if (activeTimingGesture() !== g || g.holdCancelled || !g.target.isConnected ||
        document.hidden || exporting) return;
    const span = Math.max(duration / 4, Math.min(duration, .1));
    if (span >= duration) return;
    const value = g.kind === 'scrub' ? g.value : timeRange(g.scope)[g.side];
    const start = clamp(Math.round((value - value / duration * span) * 100) / 100, 0, duration - span);
    g.zoom = {start, end: start + span};
    g.target.classList.add('precision-active');
    if (g.kind === 'scrub') {
      $('scrub').min = start;
      $('scrub').max = start + span;
    }
    syncTimeUI();
    const badge = $('timingPrecision');
    badge.textContent = formatPreciseTime(start) + '–' +
        formatPreciseTime(start + span) + ' · ' + Math.round(duration / span) + '×';
    badge.classList.remove('hidden');
    const b = g.kind === 'scrub' ? document.querySelector('.preview-wrap').getBoundingClientRect() :
        g.target.getBoundingClientRect();
    badge.style.left = clamp(b.left + b.width / 2 - badge.offsetWidth / 2,
        12, innerWidth - badge.offsetWidth - 12) + 'px';
    badge.style.top = (g.kind === 'scrub' ?
        Math.max(b.top + 12, b.bottom - badge.offsetHeight - 12) :
        Math.max(12, b.top - badge.offsetHeight - 6)) + 'px';
  }, precisionHoldDelay);
}
function checkPrecisionMovement(g, event) {
  if (g.zoom || g.holdCancelled) return;
  const points = [...(event.getCoalescedEvents?.() || []), event];
  if (points.some(p => Math.hypot(p.clientX - g.downX, p.clientY - g.downY) > precisionMoveTolerance))
    cancelPrecisionHold(g);
}
function timeDragValue(g, clientX) {
  const box = g.kind === 'scrub' ? $('scrub').getBoundingClientRect() :
      g.target.querySelector('.time-range-rail').getBoundingClientRect();
  const inset = g.kind === 'scrub' ? 10 : 0,
      width = Math.max(1, box.width - inset * 2), view = timingViewport(g.target);
  return Math.round((view.start + clamp((clientX - g.grabOffset - box.left - inset) / width, 0, 1) *
      (view.end - view.start)) * 100) / 100;
}
function applyTimeDrag(g, value) {
  if (g.kind === 'scrub') { scrubTo(value); return; }
  const r = timeRange(g.scope), gap = timeGap();
  value = g.side === 'start' ? clamp(value, 0, r.end - gap) :
      clamp(value, r.start + gap, duration);
  if (!g.recorded && Math.abs(value - r[g.side]) > .000001) {
    commit();
    g.recorded = true;
  }
  setTimeEndpoint(g.scope, g.side, value);
}
function finishTimingGesture(event, resume = true) {
  const g = activeTimingGesture();
  if (!g || (event && event.pointerId !== g.pointer)) return;
  cancelPrecisionHold(g);
  rangeGesture = scrubGesture = null;
  g.target.classList.remove('precision-active');
  $('timingPrecision').classList.add('hidden');
  $('scrub').min = 0;
  $('scrub').max = duration;
  if (g.captureTarget.hasPointerCapture(g.pointer)) g.captureTarget.releasePointerCapture(g.pointer);
  if (g.recorded) persist();
  syncTimeUI();
  if (resume && g.wasPlaying && event?.type === 'pointerup') togglePlay();
}
function cancelTimingInteraction() { finishTimingGesture(null, false); }
document.addEventListener('pointerdown', e => {
  const active = activeTimingGesture();
  if (active) {
    if (e.pointerId !== active.pointer) cancelTimingInteraction();
    return;
  }
  const range = e.target.closest('[data-time-range]'), scrub = e.target.closest('#scrub');
  if ((!range && !scrub) || duration <= 0 || exporting ||
      (e.pointerType === 'mouse' && e.button !== 0)) return;
  e.preventDefault();
  if (document.activeElement?.matches('input')) document.activeElement.blur();
  const wasPlaying = !video.paused;
  video.pause();
  if (scrub) {
    const b = scrub.getBoundingClientRect(), value = video.currentTime,
        center = b.left + 10 + value / duration * Math.max(1, b.width - 20),
        onThumb = Math.abs(e.clientX - center) <= 14 && Math.abs(e.clientY - b.top - b.height / 2) <= 22;
    scrub.focus({preventScroll: true});
    scrub.setPointerCapture(e.pointerId);
    const g = scrubGesture = {kind: 'scrub', target: $('playheadTrack'), captureTarget: scrub,
      pointer: e.pointerId, value, wasPlaying, grabOffset: onThumb ? e.clientX - center : 0};
    armPrecisionHold(g, e, onThumb);
    if (!onThumb) applyTimeDrag(g, timeDragValue(g, e.clientX));
    syncPlaybackTiming();
    return;
  }
  const b = range.querySelector('.time-range-rail').getBoundingClientRect(),
      scope = range.dataset.timeRange, r = timeRange(scope),
      v = clamp((e.clientX - b.left) / b.width, 0, 1) * duration,
      handle = e.target.closest('[data-range-handle]'),
      side = handle?.dataset.rangeHandle || (Math.abs(v - r.start) <= Math.abs(v - r.end) ? 'start' : 'end');
  handle?.focus({preventScroll: true});
  range.setPointerCapture(e.pointerId);
  const g = rangeGesture = {kind: 'range', scope, side, pointer: e.pointerId,
    target: range, captureTarget: range, recorded: false,
    grabOffset: handle ? e.clientX - (b.left + r[side] / duration * b.width) : 0};
  armPrecisionHold(g, e, !!handle);
  applyTimeDrag(g, handle ? r[side] : v);
});
document.addEventListener('pointermove', e => {
  const g = activeTimingGesture();
  if (!g || e.pointerId !== g.pointer) return;
  e.preventDefault();
  checkPrecisionMovement(g, e);
  applyTimeDrag(g, timeDragValue(g, e.clientX));
});
for (const event of ['pointerup', 'pointercancel', 'lostpointercapture'])
  document.addEventListener(event, finishTimingGesture);
document.addEventListener('contextmenu', e => {
  if (e.target.closest('[data-time-range],#scrub')) e.preventDefault();
});
document.addEventListener('visibilitychange', () => { if (document.hidden) cancelTimingInteraction(); });
window.addEventListener('blur', cancelTimingInteraction);
window.addEventListener('resize', cancelTimingInteraction);
document.addEventListener('keydown', e => {
  const handle = e.target.closest('[data-range-handle]');
  if (!handle) return;
  const side = handle.dataset.rangeHandle,
        scope = handle.closest('[data-time-range]').dataset.timeRange,
        r = timeRange(scope);
  let value = r[side];
  const step = e.shiftKey ? 1 : .1;
  if (e.key === 'ArrowLeft' || e.key === 'ArrowDown')
    value -= step;
  else if (e.key === 'ArrowRight' || e.key === 'ArrowUp')
    value += step;
  else if (e.key === 'Home')
    value = 0;
  else if (e.key === 'End')
    value = duration;
  else
    return;
  e.preventDefault();
  setTimeEndpoint(scope, side, value, {record: !e.repeat});
  persist();
});
