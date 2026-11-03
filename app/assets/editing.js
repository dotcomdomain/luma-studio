const gestureHintsSeen = (() => {
  try { return JSON.parse(localStorage.getItem('gesture-hints') || '{}') || {}; }
  catch (_) { return {}; }
})();
const toolDropdowns = new Map();
let focusNewText = false;
let frameMode = 'crop', textStyleOpen = false, gesture = null;
let strokeRevision = 0, textBounds = [], nextLayer = 0;
const activePointers = new Map();
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
function fitRect(aspect) {
  let w = nativeW || 1, h = nativeH || 1;
  if (state.rotation % 180) [w, h] = [h, w];
  if (!aspect) return {x: 0, y: 0, w: 1, h: 1};
  let rw = 1, rh = 1;
  if (w / h > aspect)
    rw = h * aspect / w;
  else
    rh = w / aspect / h;
  return {x: (1 - rw) / 2, y: (1 - rh) / 2, w: rw, h: rh};
}
function boundedRect(r) {
  let w = clamp(+r.w || 1, .02, 1), h = clamp(+r.h || 1, .02, 1);
  return {x: clamp(+r.x || 0, 0, 1 - w), y: clamp(+r.y || 0, 0, 1 - h), w, h};
}
function cropRect(s = state) {
  if (s.crop) return boundedRect(s.crop);
  let w = nativeW || 1, h = nativeH || 1;
  if (s.rotation % 180) [w, h] = [h, w];
  let rw = 1, rh = 1;
  if (s.ratio) {
    if (w / h > s.ratio)
      rw = h * s.ratio / w;
    else
      rh = w / s.ratio / h;
  }
  return {x: (1 - rw) / 2, y: (1 - rh) / 2, w: rw, h: rh};
}
function allTexts(s = state) {
  if (s.texts?.length) return s.texts;
  return s.text ? [{
    id: 'legacy',
    text: s.text,
    x: .5,
    y: (s.textY || 50) / 100,
    size: s.textSize || 7,
    color: s.textColor || '#ffffff',
    bold: true,
    font: 'sans-serif',
    rotation: 0,
    opacity: 1
  }] :
                  [];
}
function normalizeEdits() {
  rememberBrushConfig();
  state.strokes ||= [];
  state.drawingLayers ||= [];
  if (!state.drawingLayers.length && state.strokes.length)
    state.drawingLayers.push({id: 'drawing-' + Date.now() + '-' + (++nextLayer),
      start: state.drawingStart || 0, end: state.drawingEnd ?? null});
  for (const stroke of state.strokes)
    if (!state.drawingLayers.some(l => l.id === stroke.layerId))
      stroke.layerId = state.drawingLayers[0]?.id;
  state.activeDrawingId = state.drawingLayers.some(l => l.id === state.activeDrawingId) ?
      state.activeDrawingId : state.drawingLayers[0]?.id || null;
  delete state.drawingStart;
  delete state.drawingEnd;
  previewInkCaches.clear();
  directInkCaches.clear();
  state.texts = allTexts(state).map(t => ({
                                      x: .5,
                                      y: .5,
                                      size: 7,
                                      color: '#ffffff',
                                      bold: true,
                                      font: 'sans-serif',
                                      rotation: 0,
                                      opacity: 1,
                                      ...t
                                    }));
  if (state.annotationSpace !== 2) {
    let r = cropRect();
    for (const t of state.texts) {
      t.x = r.x + t.x * r.w;
      t.y = r.y + t.y * r.h;
      t.size *= r.w;
    }
    for (const stroke of state.strokes) {
      stroke.width *= r.w;
      for (const p of stroke.points) {
        p.x = r.x + p.x * r.w;
        p.y = r.y + p.y * r.h;
      }
    }
  }
  state.annotationSpace = 2;
  state.text = '';
  state.activeTextId = state.texts.some(t => t.id === state.activeTextId) ?
      state.activeTextId :
      state.texts[0]?.id || null;
  strokeRevision++;
}
function selectedText() {
  return state?.texts.find(t => t.id === state.activeTextId);
}
function prepareTool(t) {
  if (['crop', 'text', 'draw'].includes(t)) video.pause();
  if (t === 'crop' && tool !== 'crop')
    frameMode = state.crop || state.ratio ? 'position' : 'crop';
  if (t === 'draw') ensureDrawingPreviewTime();
}
function selectFrameMode(mode) {
  frameMode = mode;
  renderTool();
  draw();
}
function framePreset(aspect) {
  commit();
  let previous = cropRect();
  if (aspect === 'free') {
    state.ratio = 0;
    state.crop = previous;
    frameMode = 'crop';
  } else {
    state.ratio = aspect;
    state.crop = aspect ? fitRect(aspect) : null;
    frameMode = aspect ? 'position' : 'crop';
  }
  persist();
  renderTool();
  draw();
}
function resetFrame() {
  commit();
  while (state.rotation) turnContent();
  if (state.flip) flipContent('h');
  if (state.flipY) flipContent('v');
  state.crop = null;
  state.ratio = 0;
  frameMode = 'crop';
  persist();
  renderTool();
  draw();
}
function turnContent() {
  const r = cropRect(), g = geometry(state), factor = g.w / g.h;
  for (const text of state.texts) {
    let x = text.x;
    text.x = 1 - text.y;
    text.y = x;
    text.size *= factor;
    text.rotation = ((text.rotation || 0) + 90 + 540) % 360 - 180;
  }
  for (const stroke of state.strokes) {
    stroke.width *= factor;
    for (const p of stroke.points) {
      let x = p.x;
      p.x = 1 - p.y;
      p.y = x;
    }
  }
  state.rotation = (state.rotation + 90) % 360;
  state.crop = {x: 1 - r.y - r.h, y: r.x, w: r.h, h: r.w};
  if (state.ratio) state.ratio = 1 / state.ratio;
  strokeRevision++;
}
function rotateFrame() {
  commit();
  turnContent();
  persist();
  renderTool();
  draw();
}
// Flips along the screen's axis: "h" mirrors left-right as shown, even after a rotate.
// Text, ink and the crop live in the rotated frame, so they flip on that axis directly.
// The image flags are applied before rotation, so a quarter turn swaps which one does it.
function flipContent(direction) {
  const axis = direction === 'h' ? 'x' : 'y';
  if (state.crop) {
    const r = boundedRect(state.crop);
    state.crop = axis === 'x' ? {...r, x: 1 - r.x - r.w} : {...r, y: 1 - r.y - r.h};
  }
  for (const text of state.texts) {
    text[axis] = 1 - text[axis];
    text.rotation = -(text.rotation || 0);
    const mirror = axis === 'x' ? 'mirrorX' : 'mirrorY';
    text[mirror] = !text[mirror];
  }
  for (const stroke of state.strokes)
    for (const point of stroke.points) point[axis] = 1 - point[axis];
  const key = (direction === 'h') !== !!(state.rotation % 180) ? 'flip' : 'flipY';
  state[key] = !state[key];
  strokeRevision++;
}
function flipFrame(direction) {
  commit();
  flipContent(direction);
  persist();
  renderTool();
  draw();
}
function zoomAmount() {
  let r = cropRect();
  return Math.max(1, Math.min(1 / r.w, 1 / r.h));
}
function zoomFrame(value) {
  let r = cropRect(), cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  let base = Math.min(1 / r.w, 1 / r.h), w = r.w * base / value,
      h = r.h * base / value;
  state.crop = boundedRect({x: cx - w / 2, y: cy - h / 2, w, h});
  $('frameZoomValue').value = Number(value).toFixed(1) + '×';
  persist();
  draw();
}
function frameControls() {
  let r = cropRect();
  return '<div class="chips">' +
      chip('Free', !state.ratio && !!state.crop, 'framePreset(\'free\')') +
      [
        [0, 'Original'], [1, '1:1'], [4 / 5, '4:5'], [9 / 16, '9:16'],
        [16 / 9, '16:9'], [3 / 2, '3:2']
      ]
          .map(
              ([v, n]) => chip(
                  n, state.ratio === v && (!state.crop || v !== 0),
                  `framePreset(${v})`))
          .join('') +
      '</div>' +
      '<div class="frame-mode-row">' +
      chip('Crop', frameMode === 'crop', 'selectFrameMode(\'crop\')') +
      chip('Position', frameMode === 'position',
           'selectFrameMode(\'position\')') +
      '<button class="reset" onclick="resetFrame()">Reset frame</button></div>' +
      `<div class="slider-row"><label for="frameZoom">Zoom</label><input id="frameZoom" aria-label="Frame zoom" type="range" min="1" max="8" step=".05" value="${
             zoomAmount()}" onpointerdown="commit()" onkeydown="if(!event.repeat)commit()" oninput="zoomFrame(+this.value)"><output id="frameZoomValue">${
             zoomAmount().toFixed(1)}×</output></div>` +
      '<div class="frame-actions"><button class="secondary" onclick="rotateFrame()">' +
      icon('rotate') +
      'Rotate</button><button class="secondary" aria-label="Flip horizontally" onclick="flipFrame(\'h\')">' +
      icon('flip') +
      'Flip H</button><button class="secondary" aria-label="Flip vertically" onclick="flipFrame(\'v\')">' +
      icon('flip-v') + 'Flip V</button></div>';
}
function addText(record = true) {
  if (record) commit();
  let r = cropRect();
  const t = {
    id: 'text-' + Date.now() + '-' + (++nextLayer),
    text: '',
    x: r.x + r.w / 2,
    y: r.y + r.h / 2,
    size: 7 * r.w,
    color: '#ffffff',
    bold: true,
    italic: false,
    font: 'sans-serif',
    rotation: 0,
    opacity: 1,
    outline: false,
    background: false
  };
  state.texts.push(t);
  state.activeTextId = t.id;
  if (record) {
    persist();
    focusNewText = true;
    renderTool();
    draw();
  }
}
function textLabel(t) {
  const line = (t?.text || '').trim().split('\n')[0].trim();
  if (!line) return 'Empty text';
  return line.length > 14 ? line.slice(0, 13).trimEnd() + '…' : line;
}
function centerText() {
  const t = selectedText();
  if (!t) return;
  commit();
  let r = cropRect();
  t.x = r.x + r.w / 2;
  t.y = r.y + r.h / 2;
  persist();
  draw();
}
function selectText(id) {
  state.activeTextId = id;
  renderTool();
  draw();
}
function deleteText() {
  if (!selectedText()) return;
  commit();
  state.texts = state.texts.filter(t => t.id !== state.activeTextId);
  state.activeTextId = state.texts.at(-1)?.id || null;
  persist();
  renderTool();
  draw();
}
function textChange(key, value, record = true, refresh = true) {
  const t = selectedText();
  if (!t) return;
  if (record) commit();
  t[key] = key === 'size' ? value * cropRect().w : value;
  persist();
  draw();
  if (refresh) renderTool();
}
function toggleTextStyle() {
  textStyleOpen = !textStyleOpen;
  renderTool();
  if (textStyleOpen)
    document.querySelectorAll('.text-styles, .text-styles ~ *')
        .forEach(el => el.classList.add('reveal'));
}
function textToggle(key) {
  textChange(key, !selectedText()?.[key]);
}
function textControls() {
  let t = selectedText();
  if (!t && !state.texts.length)
    return '<button class="secondary add-text-button" onclick="addText()">' + icon('plus') + 'Add text</button>';
  let layers = '<div class="layer-row"><div class="chips">' +
      state.texts
          .map(l => chip(exportEscape(textLabel(l)), l.id === state.activeTextId,
                         `selectText('${l.id}')`))
          .join('') +
      '</div><button class="secondary" onclick="addText()" aria-label="Add text layer">' +
      icon('plus') +
      '</button><button class="icon-btn" onclick="deleteText()" aria-label="Delete selected text" ' +
      (!t ? 'disabled' : '') + '>' + icon('trash') + '</button></div>';
  if (!t) return layers;
  const size = t.size / cropRect().w, rotation = t.rotation || 0;
  let basic =
      '<textarea class="field text-entry" id="textInput" aria-label="Text overlay" placeholder="Type your text" maxlength="500" rows="1"></textarea>' +
      `<div class="text-options">${colorButton('text', t.color, 'Text color')}<label for="textSize">Size</label><input id="textSize" type="range" aria-label="Text size" min="2" max="30" step=".5" value="${
          size}" onpointerdown="commit()" onkeydown="if(!event.repeat)commit()" oninput="textChange('size',+this.value,false,false);this.nextElementSibling.value=framePx(this.value)"><output>${
          framePx(size)}</output><button class="chip ${
          textStyleOpen ? 'selected' : ''}" aria-expanded="${
          textStyleOpen}" onclick="toggleTextStyle()">Style</button></div>`;
  const fonts = [['sans-serif', 'Sans'], ['serif', 'Serif'], ['monospace', 'Mono']];
  toolDropdowns.set('textFont', {id: 'textFont', label: 'Font', value: t.font,
    options: fonts, onChoose: value => textChange('font', value)});
  let style = textStyleOpen ?
      '<div class="chips text-styles">' +
          chip('Bold', t.bold, 'textToggle(\'bold\')') +
          chip('Italic', t.italic, 'textToggle(\'italic\')') +
          chip('Outline', t.outline, 'textToggle(\'outline\')') +
          chip('Background', t.background, 'textToggle(\'background\')') +
          '<button class="secondary" onclick="centerText()">' + icon('center') +
          'Center</button></div>' +
          `<div class="text-options"><span id="textFontLabel" hidden>Font</span><button id="textFont" type="button" class="field export-dropdown font-select" aria-haspopup="listbox" aria-expanded="false" aria-controls="exportDropdownMenu" aria-labelledby="textFontLabel textFontValue" onclick="toggleExportDropdown('textFont')"><span id="textFontValue">${
              (fonts.find(([v]) => v === t.font) || fonts[0])[1]}</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button><label for="textRotation">Angle</label><input id="textRotation" type="range" aria-label="Text rotation" min="-180" max="180" step="1" value="${
              rotation}" onpointerdown="commit()" onkeydown="if(!event.repeat)commit()" oninput="textChange('rotation',+this.value,false,false);this.nextElementSibling.value=this.value+'°'"><output>${
              rotation}°</output></div><div class="slider-row"><label for="textOpacity">Opacity</label><input id="textOpacity" aria-label="Text opacity" type="range" min=".1" max="1" step=".05" value="${
              t.opacity}" onpointerdown="commit()" onkeydown="if(!event.repeat)commit()" oninput="textChange('opacity',+this.value,false,false);this.nextElementSibling.value=Math.round(this.value*100)+'%'"><output>${
              Math.round(t.opacity * 100)}%</output></div>` :
      '';
  return layers + basic + style;
}
function bindEditingControls() {
  if (tool === 'text' && $('textInput')) {
    $('textInput').value = selectedText()?.text || '';
    $('textInput').oninput = e => {
      textChange('text', e.target.value, false, false);
      const chipEl = document.querySelector('.layer-row .chip.selected');
      if (chipEl) chipEl.textContent = textLabel(selectedText());
    };
    // addText already recorded the undo step, so its auto-focus skips commit.
    if (focusNewText) $('textInput').focus({preventScroll: true});
    $('textInput').onfocus = () => commit();
  }
  focusNewText = false;
}
function brushDefaults(mode) {
  return {color: mode === 'marker' ? '#ffca58' : '#ff5964',
    size: mode === 'marker' ? 4 : .8,
    opacity: mode === 'marker' ? .4 : 1};
}
function rememberBrushConfig() {
  state.brushConfigs ||= {};
  state.brushConfigs[state.brushMode] = {
    color: state.brushColor, size: state.brushSize, opacity: state.brushOpacity
  };
}
function applyBrushConfig(config) {
  state.brushColor = config.color;
  state.brushSize = config.size;
  state.brushOpacity = config.opacity;
}
function brushMode(mode) {
  if (!['pen', 'marker', 'eraser'].includes(mode)) return;
  rememberBrushConfig();
  state.brushMode = mode;
  applyBrushConfig(state.brushConfigs[mode] || brushDefaults(mode));
  persist();
  renderTool();
}
function resetBrushConfig() {
  commit();
  applyBrushConfig(brushDefaults(state.brushMode));
  rememberBrushConfig();
  persist();
  renderTool();
}
function selectedDrawing() {
  return state?.drawingLayers?.find(l => l.id === state.activeDrawingId);
}
function addDrawingLayer(record = true) {
  if (record) commit();
  const layer = {id: 'drawing-' + Date.now() + '-' + (++nextLayer), start: 0, end: null};
  state.drawingLayers.push(layer);
  state.activeDrawingId = layer.id;
  if (record) {
    ensureDrawingPreviewTime();
    persist();
    renderTool();
    draw();
  }
  return layer;
}
function selectDrawing(id) {
  state.activeDrawingId = id;
  video.pause();
  ensureDrawingPreviewTime();
  persist();
  renderTool();
  draw();
}
function deleteDrawingLayer() {
  const layer = selectedDrawing();
  if (!layer) return;
  commit();
  state.drawingLayers = state.drawingLayers.filter(l => l.id !== layer.id);
  previewInkCaches.delete(layer.id);
  directInkCaches.delete(layer.id);
  state.strokes = state.strokes.filter(s => s.layerId !== layer.id);
  state.activeDrawingId = state.drawingLayers.at(-1)?.id || null;
  strokeRevision++;
  ensureDrawingPreviewTime();
  persist();
  renderTool();
  draw();
}
function clearDrawing() {
  const layer = selectedDrawing();
  if (!layer || !state.strokes.some(s => s.layerId === layer.id)) return;
  commit();
  state.strokes = state.strokes.filter(s => s.layerId !== layer.id);
  strokeRevision++;
  persist();
  draw();
}
function drawingLayerControls() {
  return '<div class="layer-row drawing-layer-row"><div class="chips">' +
      state.drawingLayers.map((l, i) => chip('Drawing ' + (i + 1),
          l.id === state.activeDrawingId, `selectDrawing('${l.id}')`)).join('') +
      '</div><button class="reset layer-clear" aria-label="Clear selected drawing" onclick="clearDrawing()" ' +
      (!selectedDrawing() ? 'disabled' : '') + '>Clear</button>' +
      '<button class="secondary" onclick="addDrawingLayer()" aria-label="Add drawing layer">' +
      icon('plus') + '</button><button class="icon-btn" onclick="deleteDrawingLayer()" aria-label="Delete selected drawing" ' +
      (!selectedDrawing() ? 'disabled' : '') + '>' + icon('trash') + '</button></div>';
}
function penControls() {
  if (!state.drawingLayers.length)
    return '<button class="secondary add-layer-button" onclick="addDrawingLayer()" aria-label="Add drawing layer">' + icon('plus') + 'Add layer</button>';
  return drawingLayerControls() + '<div class="brush-row">' +
      colorButton('brush', state.brushColor, 'Drawing color',
                  state.brushMode === 'eraser') + '<div class="chips">' +
      [['pen', 'Pen'], ['marker', 'Marker'], ['eraser', 'Eraser']]
          .map(([v, n]) => chip(n, state.brushMode === v, `brushMode('${v}')`))
          .join('') +
      '</div><button class="icon-btn brush-reset" onclick="resetBrushConfig()" aria-label="Reset ' +
      state.brushMode + ' settings" title="Reset ' + state.brushMode + ' settings">' + icon('reset') + '</button></div>' +
      slider('brushSize', 'Width', .2, 8, .1) +
      (state.brushMode === 'eraser' ? '' : slider('brushOpacity', 'Opacity', .1, 1, .05)) +
      drawingTimingControls();
}
const previewInkCaches = new Map(), directInkCaches = new Map();
// strokeRevision changes whenever strokes are added, removed or transformed. A stroke that
// is still being drawn only bumps its own layer, so the other layers' caches stay valid.
const layerRevisions = new Map();
function inkRevision(id) { return strokeRevision + ':' + (layerRevisions.get(id) || 0); }
const drawingGroupCache = new WeakMap();
function drawingGroups(s) {
  if (!s.strokes?.length) return [];
  let cached = drawingGroupCache.get(s.strokes);
  if (!cached || cached.revision !== strokeRevision || cached.layers !== s.drawingLayers) {
    const groups = new Map((s.drawingLayers || []).map(l => [l.id, {layer: l, strokes: []}]));
    for (const stroke of s.strokes) groups.get(stroke.layerId)?.strokes.push(stroke);
    cached = {revision: strokeRevision, layers: s.drawingLayers,
      groups: [...groups.values()].filter(g => g.strokes.length)};
    drawingGroupCache.set(s.strokes, cached);
  }
  return cached.groups;
}
function paintInkPaths(c, strokes, px, py, widthScale) {
  c.lineCap = 'round';
  c.lineJoin = 'round';
  for (const stroke of strokes) {
    let pts = stroke.points;
    if (!pts?.length) continue;
    c.globalCompositeOperation =
        stroke.mode === 'eraser' ? 'destination-out' : 'source-over';
    c.globalAlpha = stroke.mode === 'eraser' ? 1 : stroke.opacity;
    c.strokeStyle = stroke.color;
    c.fillStyle = stroke.color;
    c.lineWidth = widthScale * stroke.width;
    if (pts.length === 1) {
      c.beginPath();
      c.arc(px(pts[0]), py(pts[0]), c.lineWidth / 2, 0, Math.PI * 2);
      c.fill();
      continue;
    }
    c.beginPath();
    c.moveTo(px(pts[0]), py(pts[0]));
    for (let i = 1; i < pts.length - 1; i++)
      c.quadraticCurveTo(
          px(pts[i]), py(pts[i]), (px(pts[i]) + px(pts[i + 1])) / 2,
          (py(pts[i]) + py(pts[i + 1])) / 2);
    c.lineTo(px(pts.at(-1)), py(pts.at(-1)));
    c.stroke();
  }
}
function renderStrokes(c, s) {
  for (const group of drawingGroups(s)) {
    if (!drawingVisible(group.layer)) continue;
    renderStrokeLayer(c, {...s, strokes: group.strokes}, group.layer.id);
  }
}
function renderStrokeLayer(c, s, id) {
  let previewInkCache = previewInkCaches.get(id);
  if (c.canvas !== canvas) {
    renderStrokeLayerDirect(c, s, id);
    return;
  }
  if (!s.strokes?.length) {
    previewInkCache = null;
    return;
  }
  const r = cropRect(s), g = geometry(s), longest = Math.max(g.w, g.h),
        wanted = Math.min(
            2048, longest,
            Math.max(c.canvas.width / r.w, c.canvas.height / r.h)),
        bucket = 2 ** Math.ceil(Math.log2(Math.max(256, wanted))),
        width = Math.max(1, Math.round(bucket * g.w / longest)),
        height = Math.max(1, Math.round(bucket * g.h / longest));
  if (!previewInkCache || previewInkCache.width < width ||
      previewInkCache.height < height ||
      Math.abs(previewInkCache.width / previewInkCache.height - g.w / g.h) >
          .002) {
    let ink = document.createElement('canvas');
    ink.width = width;
    ink.height = height;
    previewInkCache = {canvas: ink, width, height};
    previewInkCaches.set(id, previewInkCache);
  }
  const cached = previewInkCache, iw = cached.width, ih = cached.height;
  if (cached.list !== s.strokes || cached.revision !== inkRevision(id)) {
    const p = cached.canvas.getContext('2d');
    p.clearRect(0, 0, iw, ih);
    paintInkPaths(p, s.strokes, v => v.x * iw, v => v.y * ih, iw / 100);
    cached.list = s.strokes;
    cached.revision = inkRevision(id);
  }
  c.drawImage(
      cached.canvas, r.x * iw, r.y * ih, r.w * iw, r.h * ih, 0, 0,
      c.canvas.width, c.canvas.height);
}

function renderStrokesDirect(c, s, includeHidden = false) {
  for (const group of drawingGroups(s)) {
    if (!includeHidden && !drawingVisible(group.layer)) continue;
    renderStrokeLayerDirect(c, {...s, strokes: group.strokes}, group.layer.id);
  }
}
function renderStrokeLayerDirect(c, s, id) {
  let strokeCache = directInkCaches.get(id);
  if (!s.strokes?.length) return;
  const w = c.canvas.width, h = c.canvas.height, r = cropRect(s),
        g = geometry(s), sx = w / g.cw, sy = h / g.ch,
        space = [r.x, r.y, r.w, r.h, g.w, g.h].join(':');
  if (!strokeCache || strokeCache.list !== s.strokes ||
      strokeCache.revision !== inkRevision(id) || strokeCache.w !== w ||
      strokeCache.h !== h || strokeCache.space !== space) {
    const layer = document.createElement('canvas');
    layer.width = w;
    layer.height = h;
    const p = layer.getContext('2d');
    p.lineCap = 'round';
    p.lineJoin = 'round';
    const px = v => (v.x * g.w - g.x) * sx, py = v => (v.y * g.h - g.y) * sy;
    for (const stroke of s.strokes) {
      let pts = stroke.points;
      if (!pts?.length) continue;
      p.globalCompositeOperation =
          stroke.mode === 'eraser' ? 'destination-out' : 'source-over';
      p.globalAlpha = stroke.mode === 'eraser' ? 1 : stroke.opacity;
      p.strokeStyle = stroke.color;
      p.fillStyle = stroke.color;
      p.lineWidth = g.w * sx * stroke.width / 100;
      if (pts.length === 1) {
        p.beginPath();
        p.arc(px(pts[0]), py(pts[0]), p.lineWidth / 2, 0, Math.PI * 2);
        p.fill();
        continue;
      }
      p.beginPath();
      p.moveTo(px(pts[0]), py(pts[0]));
      for (let i = 1; i < pts.length - 1; i++)
        p.quadraticCurveTo(
            px(pts[i]), py(pts[i]), (px(pts[i]) + px(pts[i + 1])) / 2,
            (py(pts[i]) + py(pts[i + 1])) / 2);
      p.lineTo(px(pts.at(-1)), py(pts.at(-1)));
      p.stroke();
    }
    strokeCache =
        {canvas: layer, list: s.strokes, revision: inkRevision(id), w, h, space};
  }
  directInkCaches.set(id, strokeCache);
  c.drawImage(strokeCache.canvas, 0, 0);
}
function textMetrics(c, t, s = state) {
  const fullWidth = c.canvas.width / cropRect(s).w,
        size = fullWidth * t.size / 100;
  c.font = `${t.italic ? 'italic ' : ''}${t.bold ? '700' : '400'} ${size}px ${
      t.font || 'sans-serif'}`;
  const lines = t.text.split('\n'), maxWidth = fullWidth * .94,
        width = Math.min(
            maxWidth,
            Math.max(1, ...lines.map(line => c.measureText(line).width)));
  return {size, lines, width, height: lines.length * size * 1.2, maxWidth};
}
function paintAnnotations(c, s) {
  const w = c.canvas.width, h = c.canvas.height;
  c.save();
  if (s.vignette) {
    let grad = c.createRadialGradient(
        w / 2, h / 2, Math.min(w, h) * .18, w / 2, h / 2, Math.max(w, h) * .65);
    grad.addColorStop(0, 'transparent');
    grad.addColorStop(1, `rgba(0,0,0,${s.vignette / 100 * .85})`);
    c.fillStyle = grad;
    c.fillRect(0, 0, w, h);
  }
  renderStrokes(c, s);
  let bounds = [];
  for (const t of allTexts(s)) {
    if (!t.text) continue;
    c.save();
    let m = textMetrics(c, t, s), frame = cropRect(s),
        x = (t.x - frame.x) / frame.w * w, y = (t.y - frame.y) / frame.h * h,
        pad = m.size * .2;
    bounds.push({
      id: t.id,
      x,
      y,
      width: m.width + pad * 2,
      height: m.height + pad * 2,
      rotation: t.rotation || 0
    });
    c.translate(x, y);
    c.rotate((t.rotation || 0) * Math.PI / 180);
    c.scale(t.mirrorX ? -1 : 1, t.mirrorY ? -1 : 1);
    c.globalAlpha = t.opacity ?? 1;
    if (t.background) {
      c.fillStyle = '#000a';
      c.beginPath();
      if (c.roundRect)
        c.roundRect(
            -m.width / 2 - pad, -m.height / 2 - pad, m.width + pad * 2,
            m.height + pad * 2, m.size * .18);
      else
        c.rect(
            -m.width / 2 - pad, -m.height / 2 - pad, m.width + pad * 2,
            m.height + pad * 2);
      c.fill();
    }
    c.fillStyle = t.color;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.shadowColor = '#0007';
    c.shadowBlur = m.size * .1;
    c.shadowOffsetY = m.size * .03;
    m.lines.forEach((line, i) => {
      let y = (i - (m.lines.length - 1) / 2) * m.size * 1.2;
      if (t.outline) {
        c.strokeStyle = '#111';
        c.lineWidth = m.size * .09;
        c.lineJoin = 'round';
        c.strokeText(line, 0, y, m.maxWidth);
      }
      c.fillText(line, 0, y, m.maxWidth)
    });
    c.restore();
  }
  if (c.canvas === canvas) textBounds = bounds;
  c.restore();
}
// Positions the touch layer, crop handles and text selection over the canvas. Reading the
// canvas position forces a layout, so it happens only when something is shown over the
// preview, and only again after the canvas size or the preview's layout changed.
let previewLayoutVersion = 0, layerRectKey = '', layerRect = null;
function syncInteraction() {
  const layer = $('gestureLayer');
  const hint = $('gestureHint');
  const key = tool + (tool === 'crop' ? frameMode : '');
  const help = tool === 'crop' ?
      (frameMode === 'crop' ? 'Drag handles to crop' :
                              'Drag or pinch to position') :
      tool === 'text' ? 'Drag text to move' :
                        '';
  hint.textContent = gestureHintsSeen[key] ? '' : help;
  hint.classList.toggle('hidden', !hint.textContent || comparing);
  if (!layer || !state) return;
  const interactive = ['crop', 'text', 'draw'].includes(tool) && !comparing &&
      (tool !== 'draw' || !!selectedDrawing());
  layer.classList.toggle('interactive', interactive);
  layer.dataset.tool = tool;
  const cropUI = $('cropOverlay'), selection = $('textSelection');
  const showCrop = tool === 'crop' && frameMode === 'crop' && !comparing;
  const bound = tool === 'text' && !comparing && textBounds.find(t => t.id === state.activeTextId);
  cropUI.classList.toggle('hidden', !showCrop);
  selection.classList.toggle('hidden', !bound);
  if (!interactive && !showCrop && !bound) return;
  const rectKey = canvas.width + 'x' + canvas.height + '@' + previewLayoutVersion;
  if (rectKey !== layerRectKey) {
    const b = canvas.getBoundingClientRect(), p = $('preview').getBoundingClientRect();
    layerRect = {left: b.left - p.left, top: b.top - p.top, width: b.width, height: b.height};
    layerRectKey = rectKey;
    layer.style.left = layerRect.left + 'px';
    layer.style.top = layerRect.top + 'px';
    layer.style.width = layerRect.width + 'px';
    layer.style.height = layerRect.height + 'px';
  }
  if (showCrop) {
    let r = cropRect();
    Object.assign(cropUI.style, {
      left: r.x * 100 + '%',
      top: r.y * 100 + '%',
      width: r.w * 100 + '%',
      height: r.h * 100 + '%'
    });
  }
  if (bound) {
    let sx = layerRect.width / canvas.width, sy = layerRect.height / canvas.height;
    Object.assign(selection.style, {
      left: bound.x * sx + 'px',
      top: bound.y * sy + 'px',
      width: bound.width * sx + 12 + 'px',
      height: bound.height * sy + 12 + 'px',
      transform: `translate(-50%,-50%) rotate(${bound.rotation}deg)`
    });
  }
  if ($('frameZoom') && gesture) {
    $('frameZoom').value = zoomAmount();
    $('frameZoomValue').value = zoomAmount().toFixed(1) + '×';
  }
}
function framePointToSource(p) {
  const r = cropRect();
  return {x: r.x + p.x * r.w, y: r.y + p.y * r.h};
}
function localPoint(e, b) {
  return {
    x: clamp((e.clientX - b.left) / b.width, 0, 1),
    y: clamp((e.clientY - b.top) / b.height, 0, 1)
  };
}
function hitText(point) {
  for (const b of [...textBounds].reverse()) {
    let x = point.x * canvas.width - b.x, y = point.y * canvas.height - b.y,
        angle = -b.rotation * Math.PI / 180;
    let rx = x * Math.cos(angle) - y * Math.sin(angle),
        ry = x * Math.sin(angle) + y * Math.cos(angle),
        pad = canvas.width * .025;
    if (Math.abs(rx) < b.width / 2 + pad && Math.abs(ry) < b.height / 2 + pad)
      return b.id;
  }
  return null;
}
const surface = $('gestureLayer');
surface.addEventListener('pointerdown', e => {
  if (exporting || !['crop', 'text', 'draw'].includes(tool) ||
      (tool === 'draw' && !selectedDrawing())) return;
  e.preventDefault();
  surface.setPointerCapture(e.pointerId);
  activePointers.set(e.pointerId, {x: e.clientX, y: e.clientY});
  if (activePointers.size === 2 && tool === 'crop') {
    let pts = [...activePointers.values()];
    gesture = {
      kind: 'pinch',
      r: cropRect(),
      distance: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y),
      mid: {x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2},
      bounds: surface.getBoundingClientRect()
    };
    return;
  }
  if (activePointers.size > 1) return;
  const bounds = surface.getBoundingClientRect();
  let point = localPoint(e, bounds);
  if (tool === 'crop') {
    commit();
    gesture = {
      kind: frameMode === 'crop' ? 'crop' : 'pan',
      r: cropRect(),
      handle: e.target.dataset.handle || 'move',
      start: {x: e.clientX, y: e.clientY},
      bounds,
      pointer: e.pointerId
    };
  }
  if (tool === 'text') {
    let id = hitText(point);
    if (!id) return;
    commit();
    state.activeTextId = id;
    const text = selectedText();
    gesture = {
      kind: 'text',
      crop: cropRect(),
      id,
      x: text.x,
      y: text.y,
      start: {x: e.clientX, y: e.clientY},
      bounds,
      pointer: e.pointerId
    };
    if (document.activeElement?.tagName === 'TEXTAREA')
      document.activeElement.blur();
    renderTool();
    draw();
  }
  if (tool === 'draw') {
    ensureDrawingPreviewTime();
    commit();
    const layer = selectedDrawing();
    point = framePointToSource(point);
    let stroke = {
      layerId: layer.id,
      mode: state.brushMode,
      color: state.brushColor,
      width: state.brushSize * cropRect().w,
      opacity: state.brushOpacity,
      points: [point]
    };
    state.strokes.push(stroke);
    gesture = {kind: 'draw', stroke, bounds, pointer: e.pointerId};
    strokeRevision++;
    draw();
  }
});
surface.addEventListener('pointermove', e => {
  if (!activePointers.has(e.pointerId) || !gesture) return;
  e.preventDefault();
  activePointers.set(e.pointerId, {x: e.clientX, y: e.clientY});
  const g = gesture;
  if (g.kind === 'pinch' && activePointers.size === 2) {
    const p = [...activePointers.values()],
          distance = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y),
          scale = clamp(distance / Math.max(1, g.distance), .1, 10),
          maxBase = Math.min(1 / g.r.w, 1 / g.r.h);
    const factor =
              clamp(1 / scale, Math.max(.02 / g.r.w, .02 / g.r.h), maxBase),
          w = g.r.w * factor, h = g.r.h * factor;
    const dx = ((p[0].x + p[1].x) / 2 - g.mid.x) / g.bounds.width *
        (frameMode === 'crop' ? 1 : g.r.w),
          dy = ((p[0].y + p[1].y) / 2 - g.mid.y) / g.bounds.height *
        (frameMode === 'crop' ? 1 : g.r.h);
    state.crop = boundedRect({
      x: g.r.x + (g.r.w - w) / 2 - dx,
      y: g.r.y + (g.r.h - h) / 2 - dy,
      w,
      h
    });
    draw();
    return;
  }
  // One-finger gestures follow only the finger that started them.
  if (g.pointer !== undefined && g.pointer !== e.pointerId) return;
  const dx = (e.clientX - (g.start?.x || 0)) / g.bounds.width,
        dy = (e.clientY - (g.start?.y || 0)) / g.bounds.height;
  if (g.kind === 'pan')
    state.crop =
        boundedRect({...g.r, x: g.r.x - dx * g.r.w, y: g.r.y - dy * g.r.h});
  if (g.kind === 'crop') {
    let r = {...g.r}, h = g.handle;
    if (h === 'move') {
      r.x += dx;
      r.y += dy;
    } else {
      let left = g.r.x, top = g.r.y, right = left + g.r.w, bottom = top + g.r.h;
      if (h.includes('w')) left = clamp(left + dx, 0, right - .02);
      if (h.includes('e')) right = clamp(right + dx, left + .02, 1);
      if (h.includes('n')) top = clamp(top + dy, 0, bottom - .02);
      if (h.includes('s')) bottom = clamp(bottom + dy, top + .02, 1);
      r = {x: left, y: top, w: right - left, h: bottom - top};
      if (state.ratio) {
        let aspect = g.r.w / g.r.h, fw = r.w, fh = r.h;
        if (h === 'n' || h === 's')
          fw = fh * aspect;
        else
          fh = fw / aspect;
        fw = Math.max(fw, .02, .02 * aspect);
        fh = fw / aspect;
        if (h.includes('w')) r.x = g.r.x + g.r.w - fw;
        if (h.includes('n')) r.y = g.r.y + g.r.h - fh;
        let limit = Math.min(
            1, (h.includes('w') ? g.r.x + g.r.w : 1 - r.x) / fw,
            (h.includes('n') ? g.r.y + g.r.h : 1 - r.y) / fh);
        fw *= limit;
        fh *= limit;
        if (h.includes('w')) r.x = g.r.x + g.r.w - fw;
        if (h.includes('n')) r.y = g.r.y + g.r.h - fh;
        r.w = fw;
        r.h = fh;
      }
    }
    state.crop = boundedRect(r);
  }
  if (g.kind === 'text') {
    let text = state.texts.find(t => t.id === g.id);
    if (text) {
      text.x = clamp(g.x + dx * g.crop.w, 0, 1);
      text.y = clamp(g.y + dy * g.crop.h, 0, 1);
    }
  }
  if (g.kind === 'draw' && g.pointer === e.pointerId) {
    const events = e.getCoalescedEvents?.();
    for (const pointEvent of events?.length ? events : [e]) {
      let p = framePointToSource(localPoint(pointEvent, g.bounds)),
          last = g.stroke.points.at(-1);
      if (Math.hypot(
              (p.x - last.x) / cropRect().w * g.bounds.width,
              (p.y - last.y) / cropRect().h * g.bounds.height) > .8)
        g.stroke.points.push(p);
      if (g.stroke.points.length > 3000)
        g.stroke.points = g.stroke.points.filter(
            (_, i) => i % 2 === 0 || i === g.stroke.points.length - 1);
    }
    layerRevisions.set(g.stroke.layerId, (layerRevisions.get(g.stroke.layerId) || 0) + 1);
  }
  draw();
});
function endGesture(e) {
  if (gesture) {
    gestureHintsSeen[tool + (tool === 'crop' ? frameMode : '')] = true;
    try { localStorage.setItem('gesture-hints', JSON.stringify(gestureHintsSeen)); }
    catch (_) {}
  }
  activePointers.delete(e.pointerId);
  if (gesture?.kind === 'pinch') {
    persist();
    gesture = null;
  }
  // Lifting the finger that drives a one-finger gesture ends it, even if another finger
  // is still resting on the screen.
  const ownerLifted = gesture && gesture.pointer === e.pointerId;
  if (ownerLifted) activePointers.clear();
  if (!activePointers.size) {
    if (gesture) persist();
    gesture = null;
    if (tool === 'crop' || tool === 'draw') renderTool();
    syncInteraction();
    draw();
  }
}
surface.addEventListener('pointerup', endGesture);
surface.addEventListener('pointercancel', endGesture);
new ResizeObserver(() => { previewLayoutVersion++; syncInteraction(); }).observe($('preview'));
$('toolContent').addEventListener('keydown', event => {
  const trigger = event.target.closest('.export-dropdown');
  if (!trigger || !['ArrowDown', 'ArrowUp'].includes(event.key)) return;
  event.preventDefault();
  openExportDropdown(trigger.id, event.key === 'ArrowUp');
});
document.querySelector('.tool-area').addEventListener('scroll', () => {
  if (exportDropdown?.onChoose) closeExportDropdown(false);
});
