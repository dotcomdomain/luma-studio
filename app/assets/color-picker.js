let colorSession = null;
const colorPalette = [
  ['#ffffff', 'White'], ['#172019', 'Ink'], ['#ff5964', 'Coral'],
  ['#ffca58', 'Amber'], ['#a6db86', 'Leaf'], ['#62cfff', 'Sky'],
  ['#b4a1ff', 'Lilac']
];
function normalizeHex(value) {
  let hex = String(value).trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(hex)) hex = [...hex].map(c => c + c).join('');
  return /^[0-9a-f]{6}$/i.test(hex) ? '#' + hex.toLowerCase() : null;
}
function hexToHsv(hex) {
  const [r, g, b] = hex.slice(1).match(/../g).map(v => parseInt(v, 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  return {h, s: max ? d / max : 0, v: max};
}
function hsvToHex(h, s, v) {
  const c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c;
  const rgb = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] :
      h < 180 ? [0, c, x] : h < 240 ? [0, x, c] :
      h < 300 ? [x, 0, c] : [c, 0, x];
  return '#' + rgb.map(n => Math.round((n + m) * 255).toString(16).padStart(2, '0')).join('');
}
function colorButton(target, color, label, disabled = false) {
  const hex = normalizeHex(color) || '#ffffff';
  return `<button class="color-trigger" data-color-target="${target}" style="--swatch:${hex}" aria-label="${label}${disabled ? ' (not used by the eraser)' : ''}" ${disabled ? 'disabled' : ''} onclick="openColorPicker('${target}')"><span></span></button>`;
}
function colorTarget(session = colorSession) {
  if (!session || session.path !== mediaPath) return null;
  return session.target === 'brush' ? state :
      state.texts.find(t => t.id === session.textId);
}
function openColorPicker(target) {
  if (colorSession || exporting) return;
  cancelTimingInteraction();
  const text = target === 'text' ? selectedText() : null;
  if (target === 'text' && !text) return;
  video.pause();
  const original = normalizeHex(text ? text.color : state.brushColor) || '#ffffff';
  colorSession = {target, textId: text?.id, path: mediaPath, original,
    value: original, hsv: hexToHsv(original), pointer: null};
  $('colorPresets').innerHTML = colorPalette.map(([hex, label]) =>
      `<button class="color-preset" style="--swatch:${hex};--swatch-ink:${colorInk(hex)}" aria-label="${label}" aria-pressed="false" data-color="${hex}" onclick="chooseColor('${hex}')"><span>${icon('check')}</span></button>`).join('');
  $('colorTitle').textContent = target === 'text' ? 'Text color' : 'Drawing color';
  $('editor').inert = true;
  $('colorModal').classList.remove('hidden');
  syncColorPicker();
  $('colorSurface').focus({preventScroll: true});
}
function colorInk(hex) {
  const [r, g, b] = hex.slice(1).match(/../g).map(v => parseInt(v, 16));
  return .299 * r + .587 * g + .114 * b > 150 ? '#142018' : '#ffffff';
}
function syncColorPicker() {
  if (!colorSession) return;
  const {h, s, v} = colorSession.hsv;
  $('colorSurface').style.setProperty('--hue', `hsl(${h},100%,50%)`);
  $('colorCursor').style.left = (s * 100) + '%';
  $('colorCursor').style.top = ((1 - v) * 100) + '%';
  $('colorCursor').style.background = colorSession.value;
  $('colorSurface').setAttribute('aria-valuenow', String(Math.round(s * 100)));
  $('colorSurface').setAttribute('aria-valuetext',
      `Saturation ${Math.round(s * 100)}%, brightness ${Math.round(v * 100)}%`);
  $('colorHue').value = h;
  $('colorHue').style.setProperty('--hue', `hsl(${h},100%,50%)`);
  $('colorPreview').style.background = colorSession.value;
  $('colorHex').value = colorSession.value.toUpperCase();
  $('colorHex').setAttribute('aria-invalid', 'false');
  $('colorDone').disabled = false;
  $('colorPresets').querySelectorAll('[data-color]').forEach(button =>
    button.setAttribute('aria-pressed', String(button.dataset.color === colorSession.value)));
}
function previewColor() {
  if (!colorSession) return;
  const object = colorTarget();
  if (!object) return;
  object[colorSession.target === 'brush' ? 'brushColor' : 'color'] = colorSession.value;
  draw();
}
function chooseColor(value) {
  const hex = normalizeHex(value);
  if (!hex || !colorSession) return;
  const hsv = hexToHsv(hex);
  if (!hsv.s) hsv.h = colorSession.hsv.h;
  colorSession.hsv = hsv;
  colorSession.value = hex;
  previewColor();
  syncColorPicker();
}
function updateColorHsv() {
  colorSession.value = hsvToHex(colorSession.hsv.h, colorSession.hsv.s, colorSession.hsv.v);
  previewColor();
  syncColorPicker();
}
function colorHueInput(value) {
  if (!colorSession) return;
  colorSession.hsv.h = +value;
  updateColorHsv();
}
function colorHexInput(value) {
  if (!colorSession) return;
  const hex = normalizeHex(value);
  $('colorHex').setAttribute('aria-invalid', String(!hex));
  $('colorDone').disabled = !hex;
  if (hex) {
    const cursor = $('colorHex').selectionStart;
    chooseColor(hex);
    // Preserve the input while typing so shorthand and cursor edits remain usable.
    $('colorHex').value = value;
    $('colorHex').setSelectionRange(cursor, cursor);
  }
}
function closeColorPicker(apply = false, restoreFocus = true) {
  const session = colorSession;
  if (!session || (apply && $('colorDone').disabled)) return;
  const object = colorTarget(session), key = session.target === 'brush' ? 'brushColor' : 'color';
  if (object) {
    object[key] = session.original;
    if (apply && session.value !== session.original) {
      commit();
      object[key] = session.value;
      persist();
    }
  }
  if (session.pointer !== null && $('colorSurface').hasPointerCapture(session.pointer))
    $('colorSurface').releasePointerCapture(session.pointer);
  colorSession = null;
  $('colorModal').classList.add('hidden');
  $('editor').inert = false;
  renderTool();
  draw();
  if (restoreFocus)
    document.querySelector(`[data-color-target="${session.target}"]`)?.focus({preventScroll: true});
}
function colorSurfaceInput(event) {
  if (!colorSession) return;
  const bounds = $('colorSurface').getBoundingClientRect();
  colorSession.hsv.s = clamp((event.clientX - bounds.left) / bounds.width, 0, 1);
  colorSession.hsv.v = 1 - clamp((event.clientY - bounds.top) / bounds.height, 0, 1);
  updateColorHsv();
}
$('colorSurface').addEventListener('pointerdown', event => {
  if (!colorSession || colorSession.pointer !== null) return;
  event.preventDefault();
  colorSession.pointer = event.pointerId;
  $('colorSurface').setPointerCapture(event.pointerId);
  $('colorSurface').focus({preventScroll: true});
  colorSurfaceInput(event);
});
$('colorSurface').addEventListener('pointermove', event => {
  if (colorSession?.pointer !== event.pointerId) return;
  event.preventDefault();
  colorSurfaceInput(event);
});
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'])
  $('colorSurface').addEventListener(type, event => {
    if (colorSession?.pointer === event.pointerId) colorSession.pointer = null;
  });
$('colorSurface').addEventListener('keydown', event => {
  if (!colorSession) return;
  const step = event.shiftKey ? .1 : .01;
  if (event.key === 'ArrowLeft') colorSession.hsv.s = clamp(colorSession.hsv.s - step, 0, 1);
  else if (event.key === 'ArrowRight') colorSession.hsv.s = clamp(colorSession.hsv.s + step, 0, 1);
  else if (event.key === 'ArrowDown') colorSession.hsv.v = clamp(colorSession.hsv.v - step, 0, 1);
  else if (event.key === 'ArrowUp') colorSession.hsv.v = clamp(colorSession.hsv.v + step, 0, 1);
  else return;
  event.preventDefault();
  updateColorHsv();
});
$('colorModal').addEventListener('click', event => {
  if (event.target === $('colorModal')) closeColorPicker(false);
});
document.addEventListener('keydown', event => {
  if (!colorSession) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    closeColorPicker(false);
  } else if (event.key === 'Enter' && event.target === $('colorHex')) {
    event.preventDefault();
    closeColorPicker(true);
  } else if (event.key === 'Tab') {
    const buttons = [...$('colorModal').querySelectorAll('button:not(:disabled), input, [tabindex="0"]')];
    const first = buttons[0], last = buttons.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault(); first.focus();
    }
  }
});
