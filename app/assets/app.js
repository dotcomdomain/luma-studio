const $ = s => document.getElementById(s),
      icon = n => `<svg><use href="#${n}"/></svg>`;
let mediaLoadSequence = 0, sourceVideoFps = 0, photoHasTransparency = false,
    photoTransparencyTask = Promise.resolve(false);
let state, history = [], future = [], mediaType = 'photo', mediaPath = '',
           mediaName = '', image = new Image(), tool = 'looks',
           adjust = 'brightness', comparing = false, exporting = false,
           exportFormat = 'jpg', exportSize = 0, quality = .9, duration = 0,
           nativeW = 0, nativeH = 0, drawPending = false;
// sessionExternal: this project came from another app's Edit or Share, so Back from the
// editor returns there. pendingImport: a file that arrived while an export was running.
let sessionExternal = false, pendingImport = null, sourceHasAudio = true;
const canvas = $('canvas'), ctx = canvas.getContext('2d'), video = $('video');
// Photos larger than this get a downscaled copy for the on-screen preview; exports still
// read the full-resolution image.
const PREVIEW_EDGE = 2048;
let previewImage = null;
const defaults = () => ({
  look: 'Original',
  lookStrength: 100,
  brightness: 0,
  contrast: 0,
  saturation: 0,
  warmth: 0,
  shadows: 0,
  highlights: 0,
  vignette: 0,
  straighten: 0,
  ratio: 0,
  crop: null,
  annotationSpace: 2,
  flipY: false,
  texts: [],
  activeTextId: null,
  strokes: [],
  brushMode: 'pen',
  brushColor: '#ff5964',
  brushSize: .8,
  brushOpacity: 1,
  brushConfigs: {},
  drawingLayers: [],
  activeDrawingId: null,
  rotation: 0,
  flip: false,
  text: '',
  textSize: 7,
  textY: 75,
  textColor: '#ffffff',
  start: 0,
  end: 0,
  speed: 1,
  volume: 1,
  mute: false,
  fadeIn: 0,
  fadeOut: 0
});
const looks = [
  ['Original', 0, 0, 0, 0], ['Golden', 4, 8, 12, 24],
  ['Filmic', -4, 18, -18, 5], ['Fresh', 5, 4, 24, -8], ['Noir', 0, 24, -100, 0],
  ['Faded', 8, -18, -22, 12]
];
const clone = o => JSON.parse(JSON.stringify(o));
function toast(s) {
  $('toast').textContent = s;
  $('toast').classList.add('show');
  clearTimeout(window.toastTimer);
  window.toastTimer =
      setTimeout(() => $('toast').classList.remove('show'), 3200)
}
function demoPhoto() {
  loadMedia('file:///android_asset/alpine.jpg', 'photo', 'Alpine escape.jpg')
}
// Imported copies live in the app's files folder as source-<time>.<ext>; only those are
// saved as projects and listed under Recent.
const isImportedPath = path => /\/source-\d+\.[a-z0-9]+$/.test(path);
function showBusy(text) {
  $('busyText').textContent = text;
  $('busy').classList.remove('hidden');
}
let loadingTimer = 0;
function hideBusy() {
  clearTimeout(loadingTimer);
  $('busy').classList.add('hidden');
}
let importName = '';
// During an export the file is copied quietly; it opens once the export is done, and the
// overlay would cover the export's progress and Cancel button.
function importStarted(name) {
  importName = name;
  if (!exporting) showBusy('Opening ' + name.replace(/\.[^.]+$/, '') + '…');
}
function importProgress(n) {
  if (!exporting) showBusy('Opening ' + importName.replace(/\.[^.]+$/, '') + '… ' + n + '%');
}
function importFailed(message) {
  hideBusy();
  toast(message);
}
// Java calls this once a file has been copied in.
function openImported(path, type, name, external) {
  if (exporting) {
    hideBusy();
    if (pendingImport) Native.forgetFile(pendingImport.path);
    pendingImport = {path, type, name, external};
    toast(name.replace(/\.[^.]+$/, '') + ' will open when the export finishes');
    return;
  }
  const replacing = !$('editor').classList.contains('hidden') && mediaPath !== path &&
      isImportedPath(mediaPath) && history.length;
  if (replacing) toast('Your edits to ' + mediaName.replace(/\.[^.]+$/, '') + ' are saved in Recent');
  loadMedia(path, type, name, false, external);
}
function openPendingImport() {
  const next = pendingImport;
  pendingImport = null;
  if (next) loadMedia(next.path, next.type, next.name, false, next.external);
}
function loadMedia(path, type, name, resume = false, external = false) {
  const afterImport = !$('busy').classList.contains('hidden');
  hideBusy();
  if (exporting) return;
  // An open color sheet previews its color in the state; it's cancelled before that state
  // is saved with the project's history.
  if (colorSession) closeColorPicker(false, false);
  cancelTimingInteraction();
  closeExportDropdown(false);
  rememberHistory();
  flushProject();
  releasePreviewImage();
  sessionExternal = external;
  hideExportModal();
  const sequence = ++mediaLoadSequence;
  cancelPhotoTransparencyProbe();
  sourceVideoFps = 0;
  videoColorCorrection = null;
  referenceRequest = null;
  photoHasTransparency = type === 'photo' ? null : false;
  photoTransparencyTask = Promise.resolve(false);
  nativeW = nativeH = 0;
  video.pause();
  mediaType = type;
  mediaPath = path;
  mediaName = name;
  renderedTool = null;
  state = defaults();
  if (resume) {
    try {
      const saved = JSON.parse(localStorage.getItem('project:' + path) || '{}');
      if (saved && typeof saved === 'object')
        state = {...state, ...saved, annotationSpace: saved.annotationSpace || 1};
    } catch (e) {
    }
  }
  history = [];
  future = [];
  pendingSnapshot = pendingEdits = null;
  // Reopening a project from this session brings its undo history back, as long as the
  // saved project hasn't changed since.
  const kept = resume && sessionHistories.get(path);
  if (kept && kept.saved === localStorage.getItem('project:' + path)) {
    ({history, future} = kept);
    state = JSON.parse(kept.state);
  }
  duration = 0;
  $('projectName').textContent = name.replace(/\.[^.]+$/, '');
  $('home').classList.add('hidden');
  $('editor').classList.remove('hidden');
  configureNavigation(type);
  $('playheadTrack').style.setProperty('--from', '0%');
  $('playheadTrack').style.setProperty('--to', '100%');
  $('playheadTrack')
      .querySelectorAll('.outside-trim')
      .forEach(e => e.classList.add('hidden'));
  $('timeline').classList.toggle('hidden', type !== 'video');
  // A load that finished after another one started belongs to a file that's no longer open.
  const current = () => sequence === mediaLoadSequence;
  // Large files take a moment to decode; say so if it isn't instant. Right after an import
  // the overlay was already up, so it switches to "Loading" without a gap.
  const loadingText = 'Loading ' + name.replace(/\.[^.]+$/, '') + '…';
  if (afterImport) showBusy(loadingText);
  else loadingTimer = setTimeout(() => showBusy(loadingText), 350);
  const failed = message => {
    if (!current()) return;
    hideBusy();
    toast(message);
    if (isImportedPath(path)) Native.forgetFile(path);
    mediaPath = '';
    showHome();
  };
  const opened = () => {
    hideBusy();
    if (isImportedPath(path)) Native.projectOpened(path, name, type);
  };
  if (type === 'photo') {
    video.onloadedmetadata = video.onerror = null;
    if (video.getAttribute('src')) { video.removeAttribute('src'); video.load(); }
    image.onload = () => {
      if (!current()) return;
      nativeW = image.naturalWidth;
      nativeH = image.naturalHeight;
      const previewReady = makePreviewImage(sequence);
      // JPEG can't carry transparency, so only other formats get the (full-size) scan.
      const opaque = /\.jpe?g$/i.test(path);
      photoTransparencyTask = (opaque ? Promise.resolve(false) :
          probePhotoTransparency(image, sequence)).then(hasAlpha => {
        if (sequence !== mediaLoadSequence) return hasAlpha;
        photoHasTransparency = hasAlpha;
        refreshPhotoTransparencyUI();
        return hasAlpha;
      });
      ready();
      opened();
      // Once the preview copy exists, the full-resolution decode isn't needed until an
      // export; releasing it saves width × height × 4 bytes (48 MB for 12 MP).
      Promise.all([previewReady, photoTransparencyTask]).then(() => {
        if (current() && previewImage && !exporting) releaseFullImage();
      });
    };
    image.onerror = () => failed('This photo format could not be opened');
    image.src = path
  } else {
    image.onload = image.onerror = null;
    video.onloadedmetadata = () => {
      if (!current()) return;
      nativeW = video.videoWidth;
      nativeH = video.videoHeight;
      duration = video.duration;
      try {
        const info = JSON.parse(Native.videoInfo(path));
        sourceVideoFps = Number.isFinite(info.fps) && info.fps > 0 ? info.fps : 0;
        sourceHasAudio = !!info.audio;
      } catch (_) { sourceVideoFps = 0; sourceHasAudio = true; }
      if (!state.end || state.end > duration) state.end = duration;
      $('scrub').max = duration;
      video.currentTime = state.start;
      ready();
      opened();
    };
    video.onerror = () => failed('This video format could not be opened');
    video.src = path;
    video.load()
  }
}
let fullImageReleased = false;
function releaseFullImage() {
  image.onload = image.onerror = null;
  image.removeAttribute('src');
  fullImageReleased = true;
}
// Exports larger than the preview copy need the full image back.
function ensureFullImage() {
  if (!fullImageReleased) return Promise.resolve();
  return new Promise((resolve, reject) => {
    image.onload = () => { fullImageReleased = false; image.onload = image.onerror = null; resolve(); };
    image.onerror = () => reject(new Error('The photo could not be read again'));
    image.src = mediaPath;
  });
}
// The preview copy is enough for a render only if it has at least as many pixels across
// the crop as the render needs. A zoomed-in crop needs the full image even for a small
// export.
function previewCopyEnough(max, s = state) {
  if (!previewImage || !nativeW) return false;
  const g = geometry(s), scale = Math.min(1, max / Math.max(g.cw, g.ch));
  return scale <= previewImage.width / nativeW + 1e-6;
}
function releasePreviewImage() {
  previewImage?.close?.();
  previewImage = null;
  previewBase.key = '';
  previewBase.canvas.width = previewBase.canvas.height = 0;
}
async function makePreviewImage(sequence) {
  releasePreviewImage();
  fullImageReleased = false;
  const edge = Math.max(nativeW, nativeH);
  if (edge <= PREVIEW_EDGE || typeof createImageBitmap === 'undefined') return;
  const scale = PREVIEW_EDGE / edge;
  try {
    const bitmap = await createImageBitmap(image, {resizeWidth: Math.round(nativeW * scale),
      resizeHeight: Math.round(nativeH * scale), resizeQuality: 'high'});
    if (sequence !== mediaLoadSequence) { bitmap.close(); return; }
    previewImage = bitmap;
    lookFrame = {key: '', url: ''};
    draw();
  } catch (_) {}
}
function ready() {
  normalizeEdits();
  normalizeTimings();
  setTool(mediaType==='video'?'trim':'looks');
  draw();
  updateHistory();
}
// commit() marks the state before an edit. The mark becomes an undo step only once the
// state really differs, so a tap that changes nothing keeps Redo and the history intact.
// The brush settings and which layer is selected are tool settings, not edits: changing
// them is never an undo step, and undo leaves them as they are.
const toolSettingKeys = ['brushMode', 'brushColor', 'brushSize', 'brushOpacity', 'brushConfigs',
  'activeTextId', 'activeDrawingId'];
const editsJSON = s => JSON.stringify(s, function(key, value) {
  return this === s && toolSettingKeys.includes(key) ? undefined : value;
});
let pendingSnapshot = null, pendingEdits = null;
function settleHistory() {
  if (pendingSnapshot === null || pendingEdits === editsJSON(state)) return;
  history.push(JSON.parse(pendingSnapshot));
  if (history.length > 50) history.shift();
  future = [];
  pendingSnapshot = pendingEdits = null;
  updateHistory();
}
// Undo and redo swap in another version of the edits but keep the current tool settings
// (and the selected layers, while they still exist).
function restoreEdits(next) {
  const current = state;
  state = next;
  for (const key of ['brushMode', 'brushColor', 'brushSize', 'brushOpacity', 'brushConfigs'])
    state[key] = current[key];
  if (state.texts?.some(t => t.id === current.activeTextId)) state.activeTextId = current.activeTextId;
  if (state.drawingLayers?.some(l => l.id === current.activeDrawingId))
    state.activeDrawingId = current.activeDrawingId;
}
// Undo history survives leaving the editor and reopening a project, for this session.
const sessionHistories = new Map();
function rememberHistory() {
  if (!mediaPath || !state || !isImportedPath(mediaPath)) return;
  settleHistory();
  pendingSnapshot = pendingEdits = null;
  flushProject();
  sessionHistories.set(mediaPath, {history, future, state: JSON.stringify(state),
    saved: localStorage.getItem('project:' + mediaPath)});
}
function persist() {
  if (pendingSnapshot !== null) settleHistory();
  // Samples aren't projects; their edits are never resumed.
  if (isImportedPath(mediaPath)) scheduleProjectSave();
}
// Saving is debounced: a slider drag writes once after it settles, not on every step.
let projectSaveTimer = 0, projectSavePath = '', storageWarned = false;
function scheduleProjectSave() {
  projectSavePath = mediaPath;
  clearTimeout(projectSaveTimer);
  projectSaveTimer = setTimeout(flushProject, 400);
}
function flushProject() {
  clearTimeout(projectSaveTimer);
  const path = projectSavePath;
  projectSavePath = '';
  if (!path || path !== mediaPath || !state) return;
  try {
    localStorage.setItem('project:' + path, JSON.stringify(state));
    localStorage.setItem('edited:' + path, String(Date.now()));
    storageWarned = false;
  } catch (_) {
    if (!storageWarned) toast('Storage is full, so recent edits may not be saved');
    storageWarned = true;
  }
}
document.addEventListener('visibilitychange', () => { if (document.hidden) flushProject(); });
// Settings that are only nice to keep (export choices, hints) fail quietly when storage is
// full; the setting still applies for this session.
const settingsThisSession = new Map();
function storeSetting(key, value) {
  settingsThisSession.set(key, value);
  try { localStorage.setItem(key, value); return true; } catch (_) { return false; }
}
function readSetting(key) {
  return settingsThisSession.has(key) ? settingsThisSession.get(key) : localStorage.getItem(key);
}
function timeAgo(t) {
  const minutes = Math.round((Date.now() - t) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return minutes + ' min ago';
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours + ' h ago';
  const days = Math.round(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return days + ' days ago';
  return 'on ' + new Date(t).toLocaleDateString(undefined, {month: 'short', day: 'numeric'});
}
// Recent lists imported projects that still exist, newest first. Thumbnails show the
// saved color edits.
function recentProjects() {
  try { return JSON.parse(Native.recentProjects?.() || '[]') || []; } catch (_) { return []; }
}
// Saved edits for projects that dropped off Recent are deleted with their files.
function pruneSavedProjects(projects) {
  const keep = new Set(projects.map(p => p.path));
  if (mediaPath) keep.add(mediaPath);
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const key = localStorage.key(i), m = /^(project|edited|export-format):(.*)$/.exec(key || '');
    if (m && !keep.has(m[2])) localStorage.removeItem(key);
  }
  for (const path of sessionHistories.keys()) if (!keep.has(path)) sessionHistories.delete(path);
}
function renderHome() {
  const projects = recentProjects();
  pruneSavedProjects(projects);
  $('resumeSection').classList.toggle('hidden', !projects.length);
  $('recentList').innerHTML = projects.map((project, i) => {
    const video = project.type === 'video';
    const edited = +localStorage.getItem('edited:' + project.path);
    return `<button class="resume-row" data-path="${exportEscape(project.path)}" onclick="openRecent(${i})"><span class="resume-thumb"><img class="hidden" alt="">${icon(video ? 'film' : 'photo')}</span><span class="resume-text"><strong>${
        exportEscape(project.name.replace(/\.[^.]+$/, '') || 'Untitled')}</strong><span class="resume-meta">${
        (video ? 'Video' : 'Photo') + (edited ? ' · Edited ' + timeAgo(edited) : '')}</span></span>${
        icon('arrow').replace('<svg>', '<svg class="resume-chevron">')}</button>`;
  }).join('');
  [...$('recentList').children].forEach((row, i) => recentThumbnail(row, projects[i]));
  window.recentList = projects;
}
function openRecent(i) {
  const project = window.recentList?.[i];
  if (project) loadMedia(project.path, project.type, project.name, true);
}
// Thumbnails come from Java as small cached JPEGs, so Home never decodes whole photos or
// loads videos. They show the saved color edits.
function recentThumbnail(row, project) {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('project:' + project.path) || '{}'); } catch (_) {}
  row.querySelector('img').style.filter = cssFilter({...defaults(), ...saved});
  Native.requestThumbnail(project.path);
}
function showRecentThumbnail(path, url) {
  for (const row of $('recentList').children) {
    if (row.dataset.path !== path) continue;
    const img = row.querySelector('img');
    img.onload = () => img.classList.remove('hidden');
    img.src = url;
  }
}
function commit() {
  settleHistory();
  pendingSnapshot = JSON.stringify(state);
  pendingEdits = editsJSON(state);
}
function change(key, value) {
  commit();
  state[key] = value;
  persist();
  draw();
  renderTool()
}
function updateHistory() {
  $('undoButton').disabled = history.length === 0;
  $('redoButton').disabled = future.length === 0
}
function undo() {
  settleHistory();
  pendingSnapshot = pendingEdits = null;
  if (!history.length) return;
  future.push(clone(state));
  restoreEdits(history.pop());
  afterHistory()
}
function redo() {
  settleHistory();
  pendingSnapshot = pendingEdits = null;
  if (!future.length) return;
  history.push(clone(state));
  restoreEdits(future.pop());
  afterHistory()
}
function afterHistory() {
  video.playbackRate = state.speed;
  video.muted = state.mute;
  video.volume = Math.min(1, state.volume);
  persist();
  updateHistory();
  draw();
  renderTool()
}
function resetEdit() {
  const before = editsJSON(state);
  commit();
  const tools = state;
  state = defaults();
  for (const key of ['brushMode', 'brushColor', 'brushSize', 'brushOpacity', 'brushConfigs'])
    state[key] = tools[key];
  state.end = duration;
  normalizeEdits();
  normalizeTimings();
  persist();
  afterHistory();
  if (editsJSON(state) !== before) toast('All edits removed. Undo brings them back');
}
// A look adds its offsets to the sliders, scaled by its strength.
function params(s) {
  const l = looks.find(l => l[0] === s.look) || looks[0],
        k = (s.lookStrength ?? 100) / 100;
  return {
    b: Math.max(-100, Math.min(100, s.brightness + l[1] * k)),
        c: Math.max(-90, Math.min(100, s.contrast + l[2] * k)),
        sat: Math.max(-100, Math.min(100, s.saturation + l[3] * k)),
        warm: Math.max(-100, Math.min(100, s.warmth + l[4] * k))
  }
}
// Shadows and highlights bend the tone curve: shadows move the darker third of the range
// (peak effect at 1/3 brightness), highlights the brighter third (peak at 2/3). The curve
// is a 33-point table, used as an SVG feComponentTransfer in the preview and as a lookup
// texture in the video exporter, so both apply exactly the same curve. Null when flat.
function toneTable(s) {
  const sh = (s.shadows || 0) / 100, hi = (s.highlights || 0) / 100;
  if (!sh && !hi) return null;
  const table = [];
  let last = 0;
  for (let i = 0; i <= 32; i++) {
    const x = i / 32, ws = x * (1 - x) ** 2 * 6.75, wh = x * x * (1 - x) * 6.75;
    last = Math.max(last, clamp(x + .18 * (sh * ws + hi * wh), 0, 1));
    table.push(Math.round(last * 1e4) / 1e4);
  }
  return table;
}
// Warmth shifts white balance: warm raises red and lowers blue, cool does the reverse.
// The same channel gains drive the preview (an SVG color matrix) and the video export.
function warmthGains(warm) {
  const k = warm / 100;
  return [1 + .16 * k, 1 + .03 * k, 1 - .2 * k];
}
// One SVG filter per combination of warmth and tone curve in use. Only the most recent
// ones are kept, so dragging sliders doesn't pile up filter elements.
const svgFilterIds = [];
function svgFilter(warm, tone, correction = null) {
  const w = Math.round(warm), id = 'f' + (correction ? correction.id : '') + w +
      (tone ? 't' + tone.join('_').replace(/\./g, '') : '');
  if (!document.getElementById(id)) {
    const [r, g, b] = warmthGains(w), values = tone?.join(' ');
    $('filterDefs').insertAdjacentHTML('beforeend',
        `<filter id="${id}" color-interpolation-filters="sRGB">${correction ?
            `<feColorMatrix type="matrix" values="${correction.values}"/>` : ''}${w ? `<feColorMatrix type="matrix" values="${
            r} 0 0 0 0 0 ${g} 0 0 0 0 0 ${b} 0 0 0 0 0 1 0"/>` : ''}${tone ?
            `<feComponentTransfer><feFuncR type="table" tableValues="${values}"/><feFuncG type="table" tableValues="${
            values}"/><feFuncB type="table" tableValues="${values}"/></feComponentTransfer>` : ''}</filter>`);
    svgFilterIds.push(id);
    while (svgFilterIds.length > 48) document.getElementById(svgFilterIds.shift())?.remove();
  }
  return `url(#${id})`;
}
// Warmth comes first: Chromium's canvas filter draws nothing when a url() filter follows
// CSS filter functions. The video export applies the same order.
// correction: the preview's fix for the WebView's video color conversion (see
// videoReferenceFrame), applied before everything else.
function cssFilter(s, correction = null) {
  let p = params(s), tone = toneTable(s);
  const f = (Math.round(p.warm) || tone || correction ? svgFilter(p.warm, tone, correction) + ' ' : '') +
      (p.b ? `brightness(${1 + p.b / 100}) ` : '') + (p.c ? `contrast(${1 + p.c / 100}) ` : '') +
      (p.sat ? `saturate(${1 + p.sat / 100})` : '');
  // An unedited picture skips the filter pass entirely.
  return f.trim() || 'none';
}
// The WebView doesn't always convert video colors the way the file is tagged: on this
// phone a BT.709 video sometimes gets the BT.601 matrix, depending on what was played
// before. The export converts exactly, so the preview could look different from it. When
// a video opens, Java decodes the frame on screen into a small reference picture with the
// exporter's conversion; if the WebView's picture of that frame differs, the color matrix
// that maps one to the other corrects the preview (and saved frames) for this video.
let videoColorCorrection = null, referenceRequest = null, colorCorrections = 0;
function requestVideoReference() {
  if (mediaType !== 'video' || !isOwnedVideo(mediaPath) || referenceRequest?.path === mediaPath) return;
  referenceRequest = {path: mediaPath, t: video.currentTime};
  Native.videoReference?.(mediaPath, video.currentTime);
}
const isOwnedVideo = path => /\/files\/[^/]+$/.test(path);
// Solves A x = b (4 × 4) by Gaussian elimination.
function solve4(A, b) {
  const m = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < 4; c++) {
    let p = c;
    for (let r = c + 1; r < 4; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    [m[c], m[p]] = [m[p], m[c]];
    if (Math.abs(m[c][c]) < 1e-12) return null;
    for (let r = 0; r < 4; r++) {
      if (r === c) continue;
      const f = m[r][c] / m[c][c];
      for (let k = c; k < 5; k++) m[r][k] -= f * m[c][k];
    }
  }
  return m.map((row, i) => row[4] / row[i]);
}
function videoReferenceFrame(path, t, ref) {
  if (!ref || path !== mediaPath || mediaType !== 'video') return;
  // The playhead moved while Java decoded: ask again for the frame now on screen.
  if (video.seeking || Math.abs(video.currentTime - t) > .001) {
    referenceRequest = null;
    if (!video.seeking && video.paused) requestVideoReference();
    return;
  }
  // Each cell is the mean of 8 × 8 samples, as Java takes them.
  const c = document.createElement('canvas');
  c.width = ref.w * 8;
  c.height = ref.h * 8;
  const g = c.getContext('2d', {willReadFrequently: true});
  g.drawImage(video, 0, 0, c.width, c.height);
  const px = g.getImageData(0, 0, c.width, c.height).data, X = [], Y = [];
  c.width = c.height = 0;
  for (let i = 0, n = ref.w * ref.h; i < n; i++) {
    const cx = i % ref.w, cy = Math.floor(i / ref.w), m = [0, 0, 0];
    for (let j = 0; j < 8; j++)
      for (let k = 0; k < 8; k++) {
        const o = ((cy * 8 + j) * ref.w * 8 + cx * 8 + k) * 4;
        m[0] += px[o]; m[1] += px[o + 1]; m[2] += px[o + 2];
      }
    for (let k = 0; k < 3; k++) m[k] /= 64;
    const e = ref.rgb.slice(i * 3, i * 3 + 3);
    // Clipped samples don't say how the conversion works.
    if ([...m, ...e].some(v => v < 3 || v > 252)) continue;
    X.push([m[0] / 255, m[1] / 255, m[2] / 255, 1]);
    Y.push(e.map(v => v / 255));
  }
  if (X.length < 40) return;
  // Least squares, pulled gently towards "no correction" so a frame with little color
  // can't produce a wild matrix.
  const lambda = X.length * .002, rows = [0, 1, 2].map(ch => {
    const A = [0, 1, 2, 3].map(r => [0, 1, 2, 3].map(k => X.reduce((s, x) => s + x[r] * x[k], 0) + (r === k ? lambda : 0)));
    const b = [0, 1, 2, 3].map(r => X.reduce((s, x, i) => s + x[r] * Y[i][ch], 0) + (r === ch ? lambda : 0));
    return solve4(A, b);
  });
  if (rows.some(r => !r)) return;
  let before = 0, after = 0;
  X.forEach((x, i) => {
    for (let ch = 0; ch < 3; ch++) {
      before += Math.abs(x[ch] - Y[i][ch]);
      after += Math.abs(rows[ch].reduce((s, w, k) => s + w * x[k], 0) - Y[i][ch]);
    }
  });
  before *= 255 / (X.length * 3);
  after *= 255 / (X.length * 3);
  window.videoColorCheck = {before: +before.toFixed(2), after: +after.toFixed(2), samples: X.length};
  if (before < 2 || after > before * .6) return;
  videoColorCorrection = {id: 'v' + (++colorCorrections), values:
      rows.map(r => [r[0], r[1], r[2], 0, r[3]].map(v => v.toFixed(5)).join(' ')).join(' ') + ' 0 0 0 1 0'};
  window.videoColorCheck.corrected = true;
  lookFrame = {key: '', url: ''};
  draw();
  if (tool === 'looks') renderTool();
}
function geometry(s) {
  let w = nativeW, h = nativeH;
  if (s.rotation % 180) [w, h] = [h, w];
  let r = cropRect(s);
  return {w, h, x: r.x * w, y: r.y * h, cw: r.w * w, ch: r.h * h};
}
// The on-screen preview keeps its last rendered picture (image, frame edits and colors,
// without vignette, text or ink). While only annotations change, as during a stroke or a
// text drag, that picture is reused instead of filtering and resampling the source again.
const previewBase = {canvas: document.createElement('canvas'), key: ''};
function renderTo(target, max, original = false, viewState = state, background = null) {
  if (!nativeW || !nativeH) return;
  // Exports never upscale. The on-screen canvas does, so a zoomed-in crop of a small
  // picture still fills the preview (and doesn't shrink under the fingers while pinching).
  let s = original ? defaults() : viewState, g = geometry(s),
      scale = target === canvas ? max / Math.max(g.cw, g.ch) : Math.min(1, max / Math.max(g.cw, g.ch));
  let tw = Math.max(2, Math.round(g.cw * scale)),
      th = Math.max(2, Math.round(g.ch * scale));
  if (target.width !== tw) target.width = tw;
  if (target.height !== th) target.height = th;
  let c = target.getContext('2d');
  c.clearRect(0, 0, tw, th);
  if (background) {
    c.fillStyle = background;
    c.fillRect(0, 0, tw, th);
  }
  const source = mediaType !== 'photo' ? video :
      previewImage && (fullImageReleased || previewCopyEnough(max, s)) ? previewImage : image;
  const cacheable = target === canvas && !background &&
      (mediaType === 'photo' || (video.paused && !video.seeking));
  const key = cacheable ? [mediaPath, tw, th, s.rotation, s.straighten, s.flip, s.flipY, g.x, g.y, g.cw, g.ch,
    cssFilter(s), source === previewImage, mediaType === 'photo' ? 0 : video.currentTime].join('|') : '';
  if (cacheable && key === previewBase.key) {
    c.drawImage(previewBase.canvas, 0, 0);
  } else {
    const base = cacheable ? previewBase.canvas : target;
    if (cacheable) {
      if (base.width !== tw) base.width = tw;
      if (base.height !== th) base.height = th;
    }
    const b = cacheable ? base.getContext('2d') : c;
    if (cacheable) b.clearRect(0, 0, tw, th);
    b.save();
    b.translate((g.w / 2 - g.x) * scale, (g.h / 2 - g.y) * scale);
    b.scale(scale, scale);
    if (s.straighten) {
      const k = straightenScale(s);
      b.rotate(s.straighten * Math.PI / 180);
      b.scale(k, k);
    }
    b.rotate(s.rotation * Math.PI / 180);
    b.scale(s.flip ? -1 : 1, s.flipY ? -1 : 1);
    b.filter = cssFilter(s, source === video ? videoColorCorrection : null);
    b.imageSmoothingQuality = 'high';
    try {
      b.drawImage(source, -nativeW / 2, -nativeH / 2, nativeW, nativeH)
    } catch (e) {
    }
    b.restore();
    b.filter = 'none';
    if (cacheable) {
      previewBase.key = key;
      c.drawImage(base, 0, 0);
    }
  }
  paintAnnotations(c, s);
  // Fades only show in the preview; a saved frame or photo has none.
  if (target === canvas && mediaType === 'video' && !original && (s.fadeIn || s.fadeOut)) {
    const shown = fadeGain(s, video.currentTime);
    if (shown < 1) {
      c.fillStyle = `rgba(0,0,0,${1 - shown})`;
      c.fillRect(0, 0, tw, th);
    }
  }
}
// The zoom that keeps a straightened picture covering its whole frame.
function straightenScale(s) {
  const a = Math.abs(s.straighten || 0) * Math.PI / 180, g = geometry({...s, crop: null});
  return Math.cos(a) + Math.max(g.w / g.h, g.h / g.w) * Math.sin(a);
}
// How much of the picture and sound shows at a source time, 0 (black) to 1. The video
// exporter's fadeGain uses the same formula in output time.
function fadeGain(s, t) {
  const out = (t - s.start) / s.speed, end = (s.end - s.start) / s.speed;
  let g = 1;
  if (s.fadeIn) g = Math.min(g, out / s.fadeIn);
  if (s.fadeOut) g = Math.min(g, (end - out) / s.fadeOut);
  return clamp(g, 0, 1);
}

function draw() {
  if (drawPending) return;
  drawPending = true;
  requestAnimationFrame(() => {
    drawPending = false;
    const cropView = tool === 'crop' && frameMode === 'crop' && !comparing;
    // The crop stage adds padding, which moves the canvas without resizing it.
    if ($('preview').classList.contains('crop-stage') !== cropView) {
      $('preview').classList.toggle('crop-stage', cropView);
      previewLayoutVersion++;
    }
    const view = cropView ? {
      ...state,
      crop: null,
      annotationSpace: 2,
      ratio: 0,
      vignette: 0,
      text: state.text,
      texts: state.texts,
      strokes: state.strokes
    } :
                            state;
    const previewLimit = gesture || sliderActive ? 720 :
        mediaType === 'video'    ? (video.paused ? 900 : 720) :
                                   1400;
    renderTo(canvas, previewLimit, comparing, view);
    syncInteraction();
  })
}
// While a slider is held the preview renders at 720 px (23 ms a frame here instead of
// 71 ms at 1400 px), then once more at full size when it's released.
let sliderActive = false;
document.addEventListener('pointerdown', e => {
  if (e.target.matches?.('#toolContent input[type=range], #colorModal input[type=range]'))
    sliderActive = true;
}, true);
for (const type of ['pointerup', 'pointercancel'])
  document.addEventListener(type, () => {
    if (!sliderActive) return;
    sliderActive = false;
    draw();
  }, true);
let lastFrame = 0;
function animateVideo(t) {
  if (!video.paused &&
      (video.currentTime >= state.end || video.currentTime < state.start))
    video.currentTime = state.start;
  if (!video.paused && (state.fadeIn || state.fadeOut))
    video.volume = Math.min(1, state.volume) * fadeGain(state, video.currentTime);
  if (!video.requestVideoFrameCallback && mediaType === 'video' &&
      !video.paused && !video.seeking && t - lastFrame > 30) {
    draw();
    lastFrame = t;
  }
  syncPlaybackTiming();
  if (!video.paused) requestAnimationFrame(animateVideo);
}

let frameGeneration = 0;
function startVideoFrames() {
  let generation = ++frameGeneration;
  if (!video.requestVideoFrameCallback) return;
  function frame() {
    if (generation !== frameGeneration || video.paused) return;
    if (video.currentTime >= state.end || video.currentTime < state.start)
      video.currentTime = state.start;
    else if (!video.seeking)
      draw();
    video.requestVideoFrameCallback(frame)
  }
  video.requestVideoFrameCallback(frame)
}
video.addEventListener('seeked', () => {
  draw();
  syncTimeUI();
  requestVideoReference();
});
video.addEventListener('loadeddata', () => {
  draw();
  if (tool === 'looks') renderTool();
});
function syncPlayButton() {
  const playing = !video.paused;
  document.querySelector('#timeline use').setAttribute('href', playing ? '#pause' : '#play');
  $('playButton').setAttribute('aria-label', playing ? 'Pause' : 'Play');
}
video.addEventListener('play', () => {
  startVideoFrames();
  syncPlayButton();
  requestAnimationFrame(animateVideo);
});
video.addEventListener('pause', () => {
  syncPlayButton();
  draw();
});
function togglePlay() {
  if (video.paused) {
    if (video.currentTime < state.start || video.currentTime >= state.end)
      video.currentTime = state.start;
    video.playbackRate = state.speed;
    video.muted = state.mute;
    video.volume = Math.min(1, state.volume);
    video.play().catch(() => toast('Could not play this clip'))
  } else
    video.pause()
}
// Tapping the preview toggles playback in tools that don't use preview gestures.
function flashPlayState(playing) {
  const flash = $('playFlash');
  flash.querySelector('use').setAttribute('href', playing ? '#play' : '#pause');
  flash.classList.remove('show');
  void flash.offsetWidth;
  flash.classList.add('show');
}
$('preview').addEventListener('click', () => {
  if (mediaType !== 'video' || !state || comparing || exporting ||
      ['crop', 'text', 'draw'].includes(tool)) return;
  const willPlay = video.paused;
  togglePlay();
  flashPlayState(willPlay);
  markHintSeen('play');
});
function time(n) {
  return `${Math.floor(n / 60)}:${String(Math.floor(n % 60)).padStart(2, '0')}`
}
function setComparing(on) {
  comparing = on;
  $('compareButton').setAttribute('aria-pressed', String(on));
  draw();
}
let comparePointerUsed = false;
$('compareButton').addEventListener('contextmenu', e => e.preventDefault());
$('compareButton').addEventListener('pointerdown', e => {
  e.preventDefault();
  comparePointerUsed = true;
  $('compareButton').setPointerCapture(e.pointerId);
  setComparing(true);
});
for (let event of ['pointerup', 'pointercancel', 'lostpointercapture'])
  $('compareButton').addEventListener(event, () => {
    if (comparing) setComparing(false);
  });
// A click with no finger on the button comes from a keyboard or an accessibility
// service (TalkBack's double tap), which can't hold; there it switches the original on
// and off instead.
$('compareButton').addEventListener('click', () => {
  if (comparePointerUsed) { comparePointerUsed = false; return; }
  setComparing(!comparing);
});
// Restarts a one-shot CSS animation class on an element.
function replayAnimation(el, cls) {
  if (!el) return;
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}
function setTool(t) {
  cancelTimingInteraction();
  prepareTool(t);
  const switched = tool !== t;
  tool = t;
  document.querySelectorAll('.tool-nav [data-tool]').forEach(b => {
    b.classList.toggle('active', b.dataset.tool === t);
    b.setAttribute('aria-pressed', String(b.dataset.tool === t));
  });
  if (comparing && switched) setComparing(false);
  renderTool();
  if (switched) replayAnimation($('toolContent'), 'tool-enter');
  draw();
  updateNavigation();
}
// Size-like values are stored as a percentage of the image width; show them
// as pixels at the full export resolution.
function framePx(v) {
  return Math.max(1, Math.round(v * geometry(state).cw / 100)) + ' px';
}
const signed = v => (+v > 0 ? '+' : '') + Math.round(v);
const sliderFormats = {
  brightness: signed, contrast: signed, saturation: signed, warmth: signed,
  shadows: signed, highlights: signed, lookStrength: v => Math.round(v) + '%',
  straighten: v => (+v > 0 ? '+' : '') + (+v).toFixed(1) + '°',
  fadeIn: v => (+v).toFixed(1) + ' s', fadeOut: v => (+v).toFixed(1) + ' s',
  brushSize: framePx, brushOpacity: v => Math.round(v * 100) + '%'
};
function sliderText(key, v) {
  return (sliderFormats[key] || String)(v);
}
function slider(key, label, min, max, step = 1, name = label, trailing = '') {
  return `<div class="slider-row">${label ? `<label for="range-${key}">${
      label}</label>` : ''}<input id="range-${key}" type="range" aria-label="${
      name}" min="${min}" max="${max}" step="${step}" value="${
      state[key]}" onpointerdown="commit()" onkeydown="if(!event.repeat)commit()" oninput="slide('${
      key}',this.value)"><output id="out-${key}">${
      sliderText(key, state[key])}</output>${trailing}</div>`
}
const adjustKeys = ['brightness', 'contrast', 'saturation', 'warmth', 'shadows', 'highlights', 'vignette'];
const adjustName = k => k[0].toUpperCase() + k.slice(1);
// Each reset is a single undo step and does nothing when already at zero.
function resetAdjustment(key) {
  if (!adjustKeys.includes(key) || !state[key]) return;
  commit();
  state[key] = 0;
  persist();
  draw();
  renderTool();
}
function resetAllAdjustments() {
  if (!adjustKeys.some(k => state[k])) return;
  commit();
  for (const k of adjustKeys) state[k] = 0;
  persist();
  draw();
  renderTool();
}
function syncAdjustResets() {
  if ($('adjustReset')) $('adjustReset').disabled = !state[adjust];
  if ($('adjustResetAll')) $('adjustResetAll').disabled = !adjustKeys.some(k => state[k]);
}
function slide(k, v) {
  state[k] = +v;
  if ($('out-' + k)) $('out-' + k).value = sliderText(k, v);
  if (tool === 'adjust') {
    document.querySelector('.adjust-tabs .chip.selected')
        ?.classList.toggle('modified', +v !== 0);
    syncAdjustResets();
  }
  persist();
  draw()
}
function chip(label, selected, call, extra = '') {
  return `<button class="chip ${selected ? 'selected' : ''} ${extra}" aria-pressed="${
      !!selected}" onclick="${call}">${label}</button>`
}
// Looks previews use the photo itself, or a still of the current video frame.
let lookFrame = {key: '', url: ''};
function lookThumbnail() {
  const photo = mediaType === 'photo',
        key = photo ? mediaPath : mediaPath + '@' + video.currentTime.toFixed(2);
  if (lookFrame.key === key) return lookFrame.url;
  try {
    if (!nativeW || (!photo && video.readyState < 2)) return lookFrame.url || 'alpine.jpg';
    const c = document.createElement('canvas'),
          scale = 200 / Math.min(nativeW, nativeH);
    c.width = Math.round(nativeW * scale);
    c.height = Math.round(nativeH * scale);
    const t = c.getContext('2d');
    if (!photo && videoColorCorrection) t.filter = svgFilter(0, null, videoColorCorrection);
    t.drawImage(photo ? previewImage || image : video, 0, 0, c.width, c.height);
    lookFrame = {key, url: c.toDataURL('image/jpeg', .8)};
  } catch (_) {
    lookFrame = {key, url: 'alpine.jpg'};
  }
  return lookFrame.url;
}
// Horizontal chip rows keep their scroll position when the same tool re-renders.
let renderedTool = null;
const toolScrollers = '.chips, .adjust-tabs, .looks';
function renderTool() {
  cancelTimingInteraction();
  if (!state) return;
  const scrolled = tool === renderedTool ?
      [...$('toolContent').querySelectorAll(toolScrollers)].map(e => e.scrollLeft) : [];
  let content = '';
  if (tool === 'looks') {
    content = '<div class="looks">' +
        looks
            .map(l => {
              let s = {...defaults(), look: l[0]};
              return `<button class="look ${
                  state.look === l[0] ? 'selected' :
                                        ''}" aria-pressed="${state.look === l[0]}" onclick="change('look','${
                  l[0]}')"><span class="look-image"><img src="${
                  lookThumbnail()}" style="filter:${
                  cssFilter(s)}" alt="${l[0]} look">${
                  state.look === l[0] ?
                      '<i class="look-check">' + icon('check') + '</i>' :
                      ''}</span><span>${l[0]}</span></button>`
            })
            .join('') +
        '</div>' +
        (state.look !== 'Original' ? slider('lookStrength', 'Strength', 0, 100, 1, 'Look strength') : '')
  }
  if (tool === 'adjust') {
    const name = adjustName(adjust);
    content = '<div class="adjust-tabs">' +
        adjustKeys.map(
                k => chip(
                    adjustName(k), adjust === k,
                    `adjust='${k}';renderTool()`, state[k] ? 'modified' : ''))
            .join('') +
        '</div>' +
        slider(adjust, '', adjust === 'vignette' ? 0 : -100, 100, 1, name) +
        `<div class="adjust-footer"><button id="adjustReset" class="reset" onclick="resetAdjustment(adjust)" ${
            state[adjust] ? '' : 'disabled'}>Reset ${name.toLowerCase()}</button><button id="adjustResetAll" class="reset" aria-label="Reset all adjustments" onclick="resetAllAdjustments()" ${
            adjustKeys.some(k => state[k]) ? '' : 'disabled'}>Reset all</button></div>`
  }
  if (tool === 'crop') content = frameControls();
  if (tool === 'text') content = textControls();
  if (tool === 'draw') content = penControls();
  if (tool === 'trim') content = trimControls();
  if (tool === 'playback') content = playbackControls();
  $('toolContent').innerHTML = content;
  $('toolContent').querySelectorAll(toolScrollers).forEach((e, i) => {
    if (i >= scrolled.length) return;
    e.scrollLeft = scrolled[i];
    // Bring a single-choice row's selection fully into view (e.g. a chip
    // tapped while half cut off at the edge).
    const picked = e.querySelectorAll(':scope > .selected');
    if (picked.length !== 1) return;
    const row = e.getBoundingClientRect(), chip = picked[0].getBoundingClientRect();
    if (chip.left < row.left) e.scrollLeft -= row.left - chip.left + 8;
    else if (chip.right > row.right) e.scrollLeft += chip.right - row.right + 8;
  });
  renderedTool = tool;
  bindEditingControls();
  syncTimeUI();
}

// Returns true when Back was handled here. False lets Android close the app: from the
// home screen, or from the editor when another app opened this project.
function goBack() {
  cancelTimingInteraction();
  if (exportDropdown) {
    closeExportDropdown();
    return true;
  }
  if (colorSession) {
    closeColorPicker(false);
    return true;
  }
  if (exporting) {
    toast(mediaType === 'photo' ? 'Saving. Please wait' : 'Finish or cancel the export first');
    return true;
  }
  if (!$('exportModal').classList.contains('hidden')) {
    closeExport();
    return true;
  }
  if ($('editor').classList.contains('hidden')) return false;
  video.pause();
  if (sessionExternal) {
    sessionExternal = false;
    showHome();
    return false;
  }
  showHome();
  return true;
}
function showHome() {
  rememberHistory();
  flushProject();
  video.pause();
  renderHome();
  $('editor').classList.add('hidden');
  $('home').classList.remove('hidden');
}
function openExport() {
  if (!nativeW || !nativeH) { toast('Media is still loading'); return; }
  cancelTimingInteraction();
  video.pause();
  $('exportOptions').style.pointerEvents = '';
  initializeExportSettings();
  exporting = false;
  $('exportModal').classList.remove('hidden');
  // The sheet is modal: the editor behind it can't be reached by touch or TalkBack.
  $('editor').inert = true;
  $('exportTitle').focus({preventScroll: true});
  $('saveButton').classList.remove('hidden', 'save-progress', 'saved');
  $('saveButton').innerHTML = icon('download') + 'Save to gallery';
  $('saveButton').disabled = false;
  $('shareButton').classList.add('hidden');
  $('cancelExport').classList.add('hidden');
  $('exportStatus').textContent = '';
  renderExport()
}
function closeExport() {
  closeExportDropdown(false);
  if (exporting) {
    toast('Cancel the export to close this panel');
    return
  }
  hideExportModal();
  document.querySelector('.export-btn').focus({preventScroll: true});
}
function hideExportModal() {
  $('exportModal').classList.add('hidden');
  $('editor').inert = false;
}
// Tapping outside the sheet closes it, unless an export is running.
$('exportModal').addEventListener('click', e => {
  if (e.target === $('exportModal')) closeExport();
});
// OffscreenCanvas in a worker avoids Chromium's main-thread idle-encoding
// delay.
function photoEncoderWorker() {
  onmessage = async ({data}) => {
    try {
      const canvas = new OffscreenCanvas(data.width, data.height);
      canvas.getContext('2d').drawImage(data.bitmap, 0, 0);
      data.bitmap.close();
      const blob =
          await canvas.convertToBlob({type: data.type, quality: data.quality});
      postMessage({blob});
    } catch (error) {
      postMessage({error: error.message});
    }
  };
}
async function encodePhoto(output, type, quality) {
  if (typeof OffscreenCanvas === 'undefined' ||
      typeof createImageBitmap === 'undefined') {
    return new Promise(resolve => output.toBlob(resolve, type, quality));
  }
  const bitmap = await createImageBitmap(output);
  const url = URL.createObjectURL(new Blob(
      ['(' + photoEncoderWorker.toString() + ')()'],
      {type: 'text/javascript'}));
  const worker = new Worker(url);
  try {
    return await new Promise((resolve, reject) => {
      worker.onmessage = ({data}) =>
          data.error ? reject(new Error(data.error)) : resolve(data.blob);
      worker.onerror = () => reject(new Error('Image encoding failed'));
      worker.postMessage(
          {bitmap, width: output.width, height: output.height, type, quality},
          [bitmap]);
    });
  } finally {
    worker.terminate();
    URL.revokeObjectURL(url);
  }
}
// The encoded photo crosses to Java in 3 MiB pieces (a multiple of 3 bytes, so each
// piece is valid base64 by itself) instead of one string several times its size.
async function sendPhoto(blob) {
  Native.photoBegin();
  const piece = 3 << 20;
  for (let at = 0; at < blob.size; at += piece) {
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.slice(reader.result.indexOf(',') + 1));
      reader.onerror = () => reject(new Error('Could not read the image'));
      reader.readAsDataURL(blob.slice(at, at + piece));
    });
    if (!Native.photoChunk(data)) throw new Error('Not enough memory or storage to save it');
  }
}
async function doExport() {
  if (exporting) return;
  closeExportDropdown(false);
  exporting = true;
  exportFinishing = false;
  exportStartedAt = performance.now();
  exportProgressShown = -1;
  Native.keepScreenOn?.(true);
  $('cancelExport').disabled = false;
  $('saveButton').disabled = true;
  $('saveButton').textContent = 'Preparing…';
  $('exportStatus').textContent = 'Saving…';
  $('exportOptions').style.pointerEvents = 'none';
  if ($('exportFields')) $('exportFields').disabled = true;
  try {
    if (mediaType === 'photo') {
      await photoTransparencyTask;
      const target = exportSize || Math.max(nativeW, nativeH);
      if (!previewCopyEnough(target)) await ensureFullImage();
      await new Promise(r => setTimeout(r, 60));
      let output = document.createElement('canvas');
      // JPEG has no transparency; without a fill, transparent areas would encode as black.
      renderTo(output, exportSize || Math.max(nativeW, nativeH), false, state,
          exportFormat === 'jpg' ? '#ffffff' : null);
      let blob = await encodePhoto(
          output, 'image/' + (exportFormat === 'jpg' ? 'jpeg' : exportFormat),
          quality);
      if (!blob) throw new Error('This image is too large to export');
      if (blob.type !== 'image/' + (exportFormat === 'jpg' ? 'jpeg' : exportFormat))
        throw new Error('This image format is unavailable');
      output.width = output.height = 0;
      directInkCaches.clear();
      if (previewImage) releaseFullImage();
      await sendPhoto(blob);
      Native.photoFinish(exportFormat, exportConfig.name);
    } else {
      $('cancelExport').classList.remove('hidden');
      Native.exportVideo(JSON.stringify({
        ...videoExportOptions(),
        ...videoGeometry(),
        source: mediaPath,
        start: state.start,
        duration: state.end - state.start,
        speed: state.speed,
        mute: state.mute,
        volume: state.volume,
        fadeIn: state.fadeIn || 0,
        fadeOut: state.fadeOut || 0,
        overlay: videoOverlay(),
        drawingLayers: videoDrawingLayers(),
        textLayers: videoTextLayers()
      }));
      // The full-size ink canvases made for the overlays aren't needed again.
      directInkCaches.clear();
    }
  } catch (e) {
    directInkCaches.clear();
    exportError('Could not create this export. ' + e.message)
  }
}
// Saves the video frame under the playhead, with all its edits, as a JPEG photo.
let savingFrame = false;
async function saveFrame() {
  if (exporting || mediaType !== 'video') return;
  closeExportDropdown(false);
  exporting = savingFrame = true;
  Native.keepScreenOn?.(true);
  $('saveFrameButton').disabled = $('saveButton').disabled = true;
  $('exportStatus').textContent = 'Saving the frame…';
  try {
    const output = document.createElement('canvas');
    renderTo(output, Math.max(nativeW, nativeH), false, state);
    const blob = await encodePhoto(output, 'image/jpeg', .95);
    output.width = output.height = 0;
    directInkCaches.clear();
    if (!blob) throw new Error('The frame could not be encoded');
    await sendPhoto(blob);
    const base = exportConfig.name.trim();
    Native.photoFinish('jpg', base ? base + ' frame' : '');
  } catch (e) {
    exportError('Could not save the frame. ' + e.message);
  }
}
function frameSaved(error = '') {
  savingFrame = false;
  $('saveFrameButton').disabled = $('saveButton').disabled = false;
  $('exportStatus').textContent = error || 'Frame saved to Pictures/Luma';
  if (!error) $('shareButton').classList.remove('hidden');
  if (pendingImport) openPendingImport();
}
function exportGeometry(size = exportSize) {
  let g = geometry(state), max = size || Math.max(nativeW, nativeH),
      scale = Math.min(1, max / Math.max(g.cw, g.ch));
  return [
    Math.max(2, Math.floor(g.cw * scale / 2) * 2),
    Math.max(2, Math.floor(g.ch * scale / 2) * 2)
  ]
}
function videoOverlay() {
  if (!state.vignette) return '';
  const c = document.createElement('canvas');
  [c.width, c.height] = exportGeometry();
  paintAnnotations(
      c.getContext('2d'), {...state, strokes: [], texts: [], text: ''});
  return c.toDataURL('image/png').split(',')[1];
}
// Text layers with the same timing share one overlay picture.
function videoTextLayers() {
  const groups = new Map();
  for (const t of allTexts(state)) {
    if (!t.text) continue;
    const start = t.start || 0, end = t.end ?? duration;
    if (start >= state.end || end <= state.start) continue;
    const key = start + ':' + end;
    if (!groups.has(key)) groups.set(key, {start, end, texts: []});
    groups.get(key).texts.push(t);
  }
  return [...groups.values()].map(({start, end, texts}) => {
    const c = document.createElement('canvas');
    [c.width, c.height] = exportGeometry();
    paintAnnotations(c.getContext('2d'), {...state, texts, strokes: [], vignette: 0, allTimes: true});
    const overlay = c.toDataURL('image/png').split(',')[1];
    c.width = c.height = 0;
    return {overlay, start, end};
  });
}

function videoDrawingLayers() {
  return drawingGroups(state).filter(({layer}) =>
      (layer.start || 0) < state.end && (layer.end ?? duration) > state.start)
      .map(({layer, strokes}) => {
        const c = document.createElement('canvas');
        [c.width, c.height] = exportGeometry();
        renderStrokesDirect(c.getContext('2d'),
            {...state, drawingLayers: [layer], strokes}, true);
        const overlay = c.toDataURL('image/png').split(',')[1];
        c.width = c.height = 0;
        return {overlay, start: layer.start || 0, end: layer.end ?? duration};
      });
}

// Frame and color edits for the video exporter. Java's shader applies them in the same
// order as the preview: flips, rotation, crop, scale; then warmth, brightness, contrast and
// saturation.
function videoGeometry() {
  const s = state, p = params(s), r = cropRect(s), [width, height] = exportGeometry(),
        frame = geometry({...s, crop: null}), tone = toneTable(s);
  return {
    straighten: s.straighten || 0, straightenScale: straightenScale(s), frameAspect: frame.w / frame.h,
    ...(tone ? {tone} : {}),
    flipH: !!s.flip, flipV: !!s.flipY, rotation: s.rotation || 0,
    crop: {x: r.x, y: r.y, w: r.w, h: r.h}, width, height,
    warmth: warmthGains(Math.round(p.warm)), brightness: 1 + p.b / 100,
    contrast: 1 + p.c / 100, saturation: 1 + p.sat / 100
  };
}
let exportStartedAt = 0, exportProgressShown = -1;
function exportProgress(n) {
  $('saveButton').textContent = `Saving… ${n}%`;
  $('saveButton').classList.add('save-progress');
  $('saveButton').style.setProperty('--progress', n + '%');
  // Time left, once there's enough of the export to judge by. Screen readers hear it
  // through the status line, in steps of 10%.
  const elapsed = (performance.now() - exportStartedAt) / 1000;
  if (n >= 5 && elapsed > 2) {
    const left = Math.max(1, Math.round(elapsed * (100 - n) / n));
    const text = left < 60 ? `About ${left < 10 ? left : Math.ceil(left / 5) * 5} s left` :
        `About ${Math.ceil(left / 60)} min left`;
    if (Math.floor(n / 10) !== exportProgressShown) {
      exportProgressShown = Math.floor(n / 10);
      $('exportStatus').textContent = text;
    }
  }
}
// Once the file is being copied into the gallery, Cancel no longer applies.
let exportFinishing = false;
function exportFinalizing() {
  exportFinishing = true;
  $('exportStatus').textContent = 'Saving to the gallery…';
  $('saveButton').textContent = 'Finishing…';
  $('cancelExport').classList.add('hidden');
}
function exportDone(note = '') {
  exporting = false;
  Native.keepScreenOn?.(false);
  if (savingFrame) { frameSaved(); return; }
  if (pendingImport) {
    toast('Saved to gallery');
    openPendingImport();
    return;
  }
  $('saveButton').classList.remove('save-progress');
  $('saveButton').innerHTML = icon('check') + 'Saved to gallery';
  $('saveButton').classList.add('saved');
  $('saveButton').disabled = true;
  $('shareButton').classList.remove('hidden');
  $('cancelExport').classList.add('hidden');
  $('exportStatus').textContent = (mediaType === 'photo' ?
      'Saved to Pictures/Luma' :
      'Saved to Movies/Luma') + (note ? '\n' + note : '');
}
function exportError(message) {
  exporting = false;
  Native.keepScreenOn?.(false);
  if (savingFrame) { frameSaved(message); return; }
  $('saveButton').disabled = false;
  $('saveButton').innerHTML = icon('download') + 'Try again';
  $('saveButton').classList.remove('save-progress');
  $('exportOptions').style.pointerEvents = '';
  if ($('exportFields')) $('exportFields').disabled = false;
  $('cancelExport').classList.add('hidden');
  $('exportStatus').textContent = message;
  if (pendingImport) {
    toast(message.split('\n')[0]);
    openPendingImport();
  }
}
function cancelExport() {
  if (!exporting || exportFinishing) return;
  $('cancelExport').disabled = true;
  $('saveButton').textContent = 'Cancelling…';
  Native.cancel()
}
function exportCancelled() {
  exporting = false;
  Native.keepScreenOn?.(false);
  $('cancelExport').disabled = false;
  $('exportOptions').style.pointerEvents = '';
  hideExportModal();
  toast('Export cancelled');
  openPendingImport();
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) video.pause()
});

// After every script has loaded (renderHome uses helpers from export-config.js).
window.addEventListener('DOMContentLoaded', renderHome);
