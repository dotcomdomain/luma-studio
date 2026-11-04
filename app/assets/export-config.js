let exportConfig = exportDefaults(), exportAdvancedOpen = false, exportDropdown = null;
const exportDropdowns = new Map(), exportHelpOpen = new Set();
let exportPhotoFormatExplicit = false, pendingPhotoTransparencyRefresh = false;
function exportDefaults() {
  return {preset: 'quality', codec: 'h264', crf: 20, fps: 0, fpsCap30: false,
    rateMode: 'quality', bitrate: 8, bitrateAutomatic: true,
    preferredPhotoFormat: null,
    audioBitrate: 192, channels: 0, sampleRate: 0, name: ''};
}
const exportEnums = {
  codec: ['h264', 'hevc'], crf: [18, 20, 23, 28], fps: [0, 24, 25, 30, 50, 60],
  rateMode: ['quality', 'bitrate'],
  audioBitrate: [96, 128, 192, 256], channels: [0, 1, 2], sampleRate: [0, 44100, 48000]
};
function initializeExportSettings() {
  exportConfig = exportDefaults();
  exportAdvancedOpen = false;
  exportHelpOpen.clear();
  exportPhotoFormatExplicit = false;
  exportFormat = mediaType === 'photo' ? 'jpg' : 'mp4';
  exportSize = 0;
  quality = .95;
  try {
    // Settings saved before High quality became the default (schema 3) keep only the
    // codec and photo format; the rest starts from the new default.
    const stored = JSON.parse(readSetting('export-settings:' + mediaType) || '{}') || {},
          saved = stored.schema >= 3 ? stored :
              {codec: stored.codec, schema: 2,
               preferredPhotoFormat: stored.schema >= 2 ? stored.preferredPhotoFormat : stored.format};
    for (const [key, options] of Object.entries(exportEnums))
      if (options.includes(saved[key])) exportConfig[key] = saved[key];
    if (['quality', 'balanced', 'small', 'custom'].includes(saved.preset)) exportConfig.preset = saved.preset;
    exportConfig.fpsCap30 = typeof saved.fpsCap30 === 'boolean' ? saved.fpsCap30 : saved.preset === 'small';
    if (typeof saved.customSize === 'boolean') exportConfig.customSize = saved.customSize;
    exportConfig.bitrateAutomatic = typeof saved.bitrateAutomatic === 'boolean' ?
        saved.bitrateAutomatic : saved.rateMode !== 'bitrate';
    const preferred = saved.schema >= 2 ? saved.preferredPhotoFormat : saved.format;
    if (['jpg', 'png', 'webp'].includes(preferred)) exportConfig.preferredPhotoFormat = preferred;
    if (Number.isFinite(saved.bitrate)) exportConfig.bitrate = clamp(saved.bitrate, .2, 100);
    // A pixel size belongs to the file it was chosen for. Other files get the preset's size.
    if (Number.isFinite(saved.size) && saved.sizePath === mediaPath)
      exportSize = clamp(Math.round(saved.size), 0, 8192);
    else exportConfig.customSize = false;
    if (Number.isFinite(saved.quality)) quality = clamp(saved.quality, .5, 1);

  } catch (_) {}
  if (exportConfig.fpsCap30 && mediaType === 'video')
    exportConfig.fps = sourceVideoFps > 30.01 ? 30 : 0;
  if (exportConfig.preset !== 'custom' && !exportConfig.customSize) {
    exportSize = exportConfig.preset === 'small' ? 1280 : 0;
    const g = geometry(state);
    if (exportSize >= Math.max(g.cw, g.ch)) exportSize = 0;
  }
  if (mediaType === 'photo') {
    const specific = readSetting('export-format:' + mediaPath);
    exportPhotoFormatExplicit = ['jpg', 'png', 'webp'].includes(specific);
    exportFormat = exportPhotoFormatExplicit ? specific : automaticPhotoFormat();
  }
  refreshSuggestedBitrate();
}
function automaticPhotoFormat() {
  return photoHasTransparency !== false ? 'png' : exportConfig.preferredPhotoFormat || 'jpg';
}
function photoTransparencyNote() {
  return '<p class="export-format-note" role="status">JPEG has no transparency, so transparent areas turn white. Choose PNG to keep them.</p>';
}
function refreshPhotoTransparencyUI() {
  if (exportDropdown) { pendingPhotoTransparencyRefresh = true; return; }
  pendingPhotoTransparencyRefresh = false;
  if (mediaType !== 'photo' || $('exportModal').classList.contains('hidden')) return;
  const format = exportPhotoFormatExplicit ? exportFormat : automaticPhotoFormat();
  if (format === exportFormat) {
    const note = document.querySelector('.export-format-note');
    if (photoHasTransparency && format === 'jpg') {
      if (!note) $('exportFormat').closest('.export-row').insertAdjacentHTML('afterend', photoTransparencyNote());
    } else note?.remove();
    return;
  }
  const focused = document.activeElement?.id;
  exportFormat = format;
  renderExport();
  if (focused) $(focused)?.focus({preventScroll: true});
}
function suggestedVideoBitrate() {
  if (!nativeW || !nativeH || !state) return 8;
  const [w, h] = exportGeometry(), fps = exportConfig.fps || sourceVideoFps || 30;
  const rate = w * h * fps * (exportConfig.codec === 'hevc' ? .075 : .12) / 1000000;
  return clamp(Math.round(rate * 10) / 10, .5, 100);
}
function refreshSuggestedBitrate() {
  if (mediaType === 'video' && exportConfig.bitrateAutomatic)
    exportConfig.bitrate = suggestedVideoBitrate();
}
function useSuggestedBitrate() {
  if (exporting) return;
  exportConfig.bitrateAutomatic = true;
  refreshSuggestedBitrate();
  saveExportPreferences();
  renderExport();
}
function saveExportPreferences() {
  const {name, ...config} = exportConfig;
  storeSetting('export-settings:' + mediaType,
      JSON.stringify({...config, schema: 3, size: exportSize, sizePath: mediaPath, quality}));
}
function setExportPreset(preset) {
  if (exporting || !['quality', 'balanced', 'small'].includes(preset)) return;
  exportConfig.preset = preset;
  exportConfig.customSize = false;
  exportSize = preset === 'small' ? 1280 : 0;
  const g = geometry(state);
  if (exportSize >= Math.max(g.cw, g.ch)) exportSize = 0;
  if (mediaType === 'photo') {
    quality = preset === 'quality' ? .95 : preset === 'balanced' ? .9 : .75;
  } else {
    exportConfig.crf = preset === 'quality' ? 20 : preset === 'balanced' ? 23 : 28;
    exportConfig.audioBitrate = preset === 'small' ? 96 : 192;
    exportConfig.fpsCap30 = preset === 'small';
    exportConfig.fps = exportConfig.fpsCap30 && sourceVideoFps > 30.01 ? 30 : 0;
    exportConfig.rateMode = 'quality';
    exportConfig.bitrateAutomatic = true;
  }
  refreshSuggestedBitrate();
  saveExportPreferences();
  renderExport();
}
function setExportOption(key, value) {
  if (exporting) return;
  if (key === 'format') {
    if (!['jpg', 'png', 'webp'].includes(value)) return;
    exportFormat = value;
    exportPhotoFormatExplicit = true;
    exportConfig.preferredPhotoFormat = value;
    storeSetting('export-format:' + mediaPath, value);
  } else if (key === 'size') {
    if (value === 'custom') {
      const g = geometry(state);
      exportSize = Math.min(8192, Math.round(Math.max(g.cw, g.ch)));
      exportConfig.customSize = true;
    } else {
      exportSize = +value;
      exportConfig.customSize = false;
    }
  } else {
    const options = exportEnums[key];
    if (!options) return;
    if (typeof options[0] === 'number') value = +value;
    if (!options.includes(value)) return;
    exportConfig[key] = value;
    if (key === 'fps') exportConfig.fpsCap30 = false;
  }
  // Presets leave the format and codec alone, so choosing one isn't a custom setting.
  if (key !== 'format' && key !== 'codec') exportConfig.preset = 'custom';
  refreshSuggestedBitrate();
  saveExportPreferences();
  renderExport();
}
function setCustomExportSize(value) {
  if (exporting || !Number.isFinite(+value) || +value < 2 || +value > 8192) {
    renderExport();
    return;
  }
  exportSize = Math.round(+value);
  exportConfig.customSize = true;
  exportConfig.preset = 'custom';
  refreshSuggestedBitrate();
  saveExportPreferences();
  renderExport();
}
function setPhotoExportQuality(value) {
  if (exporting) return;
  quality = clamp(+value / 100, .5, 1);
  exportConfig.preset = 'custom';
  $('exportQualityValue').value = Math.round(quality * 100) + '%';
  showCustomPreset();
  saveExportPreferences();
  updateExportSummary();
}
function setExportBitrate(value) {
  if (exporting || !Number.isFinite(+value) || +value < .2 || +value > 100) {
    renderExport();
    return;
  }
  exportConfig.bitrate = +value;
  exportConfig.bitrateAutomatic = false;
  exportConfig.preset = 'custom';
  showCustomPreset();
  saveExportPreferences();
  updateExportSummary();
}
// Settings changed by hand leave the presets; a line under them says so.
function presetChips() {
  return [['quality', 'High quality'], ['balanced', 'Balanced'], ['small', 'Small file']]
      .map(([key, label]) => chip(label, exportConfig.preset === key, `setExportPreset('${key}')`)).join('');
}
function presetNote() {
  return `<p id="presetNote" class="preset-note" ${exportConfig.preset === 'custom' ? '' : 'hidden'}>Custom settings. Tap a preset to go back to it.</p>`;
}
function showCustomPreset() {
  const row = document.querySelector('.export-presets');
  if (row) row.innerHTML = presetChips();
  if ($('presetNote')) $('presetNote').hidden = exportConfig.preset !== 'custom';
}
function exportEscape(value) {
  return String(value).replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
}
function exportHelpButton(topic, title) {
  return `<button type="button" class="export-info-button" aria-label="${title}" aria-expanded="${exportHelpOpen.has(topic)}" aria-controls="exportHelp-${topic}" onclick="toggleExportHelp('${topic}')"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7v.5"/></svg></button>`;
}
function exportHelpPanel(topic, text) {
  return `<div id="exportHelp-${topic}" class="export-info ${exportHelpOpen.has(topic) ? '' : 'hidden'}" role="note"><p>${text}</p></div>`;
}
function toggleExportHelp(topic) {
  if (exporting) return;
  if (exportHelpOpen.has(topic)) exportHelpOpen.delete(topic); else exportHelpOpen.add(topic);
  const panel = $('exportHelp-' + topic);
  panel.classList.toggle('hidden', !exportHelpOpen.has(topic));
  document.querySelector(`[aria-controls="exportHelp-${topic}"]`).setAttribute('aria-expanded', String(exportHelpOpen.has(topic)));
  if (exportHelpOpen.has(topic)) requestAnimationFrame(() => panel.scrollIntoView({block: 'nearest'}));
}
function exportSelect(id, label, value, options, key, help = null) {
  exportDropdowns.set(id, {id, label, value, options, key});
  const selected = options.find(([v]) => String(v) === String(value));
  const title = selected?.[2] || selected?.[1] || '';
  return `<div class="export-row">${help ? '<div class="export-field-label">' : ''}<label id="${id}Label" for="${id}">${label}</label>${help ? exportHelpButton(help.topic, help.title) + '</div>' : ''}<button id="${id}" type="button" class="field export-dropdown" aria-haspopup="listbox" aria-expanded="false" aria-controls="exportDropdownMenu" aria-labelledby="${id}Label ${id}Value" onclick="toggleExportDropdown('${id}')"><span id="${id}Value">${exportEscape(title)}</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button></div>${help ? exportHelpPanel(help.topic, help.text) : ''}`;
}
function toggleExportDropdown(id) {
  if (exportDropdown?.id === id) closeExportDropdown();
  else openExportDropdown(id);
}
function openExportDropdown(id, focusEnd = false) {
  // Tool-panel dropdowns (e.g. text font) reuse this menu with an onChoose callback.
  const config = exportDropdowns.get(id) || toolDropdowns.get(id), trigger = $(id);
  if (!config || !trigger || trigger.disabled || exporting) return;
  if (!config.onChoose && $('exportModal').classList.contains('hidden')) return;
  closeExportDropdown(false);
  // The menu lives inside the dialog it belongs to, so TalkBack (which only reads the
  // modal export sheet while it's open) can reach it.
  const host = config.onChoose ? document.body : document.querySelector('.export-sheet');
  if ($('exportDropdownLayer').parentElement !== host) host.appendChild($('exportDropdownLayer'));
  exportDropdown = {...config, typeahead: '', typedAt: 0};
  const menu = $('exportDropdownMenu');
  menu.setAttribute('aria-labelledby', id + 'Label');
  menu.innerHTML = config.options.map(([value, label], index) => {
    const selected = String(value) === String(config.value);
    return `<button type="button" class="export-menu-option" role="option" aria-selected="${selected}" tabindex="-1" onclick="chooseExportDropdown(${index})"><span>${exportEscape(label)}</span>${icon('check')}</button>`;
  }).join('');
  trigger.setAttribute('aria-expanded', 'true');
  $('exportDropdownLayer').classList.remove('hidden');
  positionExportDropdown();
  const options = [...menu.querySelectorAll('[role=option]')];
  const active = focusEnd ? options.at(-1) : options.find(o => o.getAttribute('aria-selected') === 'true') || options[0];
  active.focus({preventScroll: true});
  active.scrollIntoView({block: 'nearest'});
}
function positionExportDropdown() {
  if (!exportDropdown) return;
  const trigger = $(exportDropdown.id);
  if (!trigger || !trigger.getClientRects().length) { closeExportDropdown(false); return; }
  const rect = trigger.getBoundingClientRect(), menu = $('exportDropdownMenu');
  const view = window.visualViewport, topEdge = (view?.offsetTop || 0) + 12,
      bottomEdge = (view?.offsetTop || 0) + (view?.height || innerHeight) - 12;
  const width = Math.min(Math.max(rect.width, 224), innerWidth - 32);
  menu.style.width = width + 'px';
  const desired = Math.min(menu.scrollHeight + 2, 336, bottomEdge - topEdge);
  const below = bottomEdge - rect.bottom - 8, above = rect.top - topEdge - 8;
  const useBelow = below >= desired || below >= above;
  const height = Math.max(48, Math.min(desired, Math.max(above, below)));
  menu.style.maxHeight = height + 'px';
  menu.style.left = clamp(rect.right - width, 16, innerWidth - width - 16) + 'px';
  menu.style.transformOrigin = (useBelow ? 'top' : 'bottom') + ' right';
  menu.style.top = clamp(useBelow ? rect.bottom + 8 : rect.top - height - 8,
      topEdge, bottomEdge - height) + 'px';
}
function closeExportDropdown(restoreFocus = true) {
  const id = exportDropdown?.id;
  exportDropdown = null;
  $('exportDropdownLayer').classList.add('hidden');
  if (id && $(id)) {
    $(id).setAttribute('aria-expanded', 'false');
    if (restoreFocus) $(id).focus({preventScroll: true});
  }
  if (pendingPhotoTransparencyRefresh) {
    pendingPhotoTransparencyRefresh = false;
    queueMicrotask(refreshPhotoTransparencyUI);
  }
}
function chooseExportDropdown(index) {
  if (!exportDropdown || exporting) return;
  const {id, key, options, onChoose} = exportDropdown, choice = options[index];
  if (!choice) return;
  closeExportDropdown(false);
  if (onChoose) onChoose(choice[0]);
  else setExportOption(key, choice[0]);
  $(id)?.focus({preventScroll: true});
}
$('exportDropdownLayer').addEventListener('click', event => {
  if (event.target !== $('exportDropdownLayer')) return;
  event.preventDefault();
  event.stopPropagation();
  closeExportDropdown();
});
$('exportDropdownMenu').addEventListener('keydown', event => {
  if (!exportDropdown) return;
  const options = [...$('exportDropdownMenu').querySelectorAll('[role=option]')];
  const current = options.indexOf(document.activeElement);
  let next;
  if ((event.key === 'Enter' || event.key === ' ') && current >= 0) {
    event.preventDefault();
    chooseExportDropdown(current);
    return;
  }
  if (event.key === 'ArrowDown') next = (current + 1) % options.length;
  else if (event.key === 'ArrowUp') next = (current - 1 + options.length) % options.length;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = options.length - 1;
  else if (event.key === 'Escape') { event.preventDefault(); closeExportDropdown(); return; }
  else if (event.key === 'Tab') {
    event.preventDefault();
    const id = exportDropdown.id;
    closeExportDropdown();
    const targets = [...$('exportModal').querySelectorAll('button:not(:disabled), input:not(:disabled), summary')].filter(e => e.getClientRects().length);
    const index = targets.findIndex(e => e.id === id);
    targets[(index + (event.shiftKey ? -1 : 1) + targets.length) % targets.length]?.focus();
    return;
  } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && event.key !== ' ') {
    const now = performance.now();
    exportDropdown.typeahead = now - exportDropdown.typedAt < 600 ? exportDropdown.typeahead + event.key.toLowerCase() : event.key.toLowerCase();
    exportDropdown.typedAt = now;
    next = exportDropdown.options.findIndex(([, title]) => title.toLowerCase().startsWith(exportDropdown.typeahead));
    if (next < 0) next = exportDropdown.options.findIndex(([, title]) => title.toLowerCase().startsWith(event.key.toLowerCase()));
    if (next < 0) return;
  } else return;
  event.preventDefault();
  options[next].focus({preventScroll: true});
  options[next].scrollIntoView({block: 'nearest'});
});
$('exportOptions').addEventListener('keydown', event => {
  const trigger = event.target.closest('.export-dropdown');
  if (!trigger || !['ArrowDown', 'ArrowUp'].includes(event.key)) return;
  event.preventDefault();
  openExportDropdown(trigger.id, event.key === 'ArrowUp');
});
window.addEventListener('resize', positionExportDropdown);
window.visualViewport?.addEventListener('resize', positionExportDropdown);
document.querySelector('.export-sheet').addEventListener('scroll', () => closeExportDropdown());
// In landscape the options scroll inside their own column.
$('exportOptions').addEventListener('scroll', () => closeExportDropdown());
// Opening More options near the bottom of the sheet would leave the new options out of
// view; scroll them in, keeping the summary row visible.
function revealExportAdvanced(details) {
  if (exporting) return;
  requestAnimationFrame(() => details.scrollIntoView({block: 'nearest', behavior: 'smooth'}));
}
function renderExport() {
  closeExportDropdown(false);
  exportDropdowns.clear();
  const photo = mediaType === 'photo', g = geometry(state), source = Math.max(g.cw, g.ch);
  // A preset's own size always appears in the list, even on a source only a pixel larger.
  const standardSizes = [3840, 2560, 1920, 1280, 854, 640].filter(n => n < source - 1 ||
      (n === exportSize && !exportConfig.customSize && n < source));
  if (exportSize && !standardSizes.includes(exportSize)) exportConfig.customSize = true;
  // Settings sit in rounded cards of plain rows: the label on the left, the value on the
  // right. Videos keep their less used settings under More options.
  const nameRow = `<div class="export-row export-name"><label for="exportName">File name</label><div><input id="exportName" class="field" type="text" maxlength="64" placeholder="Automatic" value="${exportEscape(exportConfig.name)}" oninput="exportConfig.name=this.value"><span>.${exportFormat}</span></div></div>`;
  let content = '<fieldset id="exportFields" class="export-fields">' +
      '<div class="chips export-presets" role="group" aria-label="Presets">' + presetChips() + '</div>' + presetNote() +
      '<div class="export-card">';
  if (photo) {
    content += exportSelect('exportFormat', 'Format', exportFormat,
        [['jpg', 'JPEG'], ['png', 'PNG · lossless'], ['webp', 'WebP']], 'format');
    if (photoHasTransparency && exportFormat === 'jpg') content += photoTransparencyNote();
  }
  const dimensions = exportOutputDimensions();
  content += exportSelect('exportResolution', 'Resolution', exportConfig.customSize ? 'custom' : exportSize,
      [[0, exportOutputDimensions(0).join(' × ') + ' · Original', exportOutputDimensions(0).join(' × ')],
       ...standardSizes.map(n => [n, exportOutputDimensions(n).join(' × ')]),
       ['custom', 'Custom', dimensions.join(' × ')]], 'size');
  if (exportConfig.customSize) {
    const maximum = exportOutputDimensions(Math.min(source, 8192));
    content += `<div class="export-dimensions" role="group" aria-label="Custom resolution, aspect ratio preserved"><label for="exportCustomWidth">Width<input id="exportCustomWidth" class="field" type="number" min="2" max="${maximum[0]}" step="${photo ? 1 : 2}" value="${dimensions[0]}" onchange="setExportDimension('width',this.value)"></label><span aria-hidden="true">×</span><label for="exportCustomHeight">Height<input id="exportCustomHeight" class="field" type="number" min="2" max="${maximum[1]}" step="${photo ? 1 : 2}" value="${dimensions[1]}" onchange="setExportDimension('height',this.value)"></label></div>`;
  }
  if (photo) {
    if (exportFormat !== 'png') content += `<div class="export-quality"><div><div class="export-quality-label"><label for="exportQuality">Compression quality</label>${exportHelpButton('quality', 'About compression quality')}</div><output id="exportQualityValue">${Math.round(quality * 100)}%</output></div><input id="exportQuality" type="range" min="50" max="100" value="${Math.round(quality * 100)}" oninput="setPhotoExportQuality(this.value)">${exportHelpPanel('quality', 'JPEG and WebP are lossy, even at 100%. Choose PNG for lossless output.')}</div>`;
    content += nameRow + '</div>';
  } else {
    if (exportConfig.rateMode === 'quality') content += exportSelect('exportVideoQuality', 'Quality', exportConfig.crf,
        [[18, 'Highest'], [20, 'High'], [23, 'Standard'], [28, 'Compact']], 'crf', {topic:'quality', title:'About video quality', text:'Highest is the least compressed option here, not lossless. Higher quality generally makes larger files.'});
    content += exportSelect('exportFps', 'Frame rate', exportConfig.fps,
        [[0, 'Original'], ...[24,25,30,50,60].map(n => [n, n + ' fps'])], 'fps');
    content += '</div>';
    content += `<details class="export-advanced" ${exportAdvancedOpen ? 'open' : ''} ontoggle="if(this.open&&!exportAdvancedOpen)revealExportAdvanced(this);exportAdvancedOpen=this.open"><summary><span>More options</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></summary><div class="export-advanced-body"><div class="export-card">`;
    content += nameRow;
    if (videoEncoders().hevc)
      content += exportSelect('exportCodec', 'Codec', exportConfig.codec, [['h264', 'H.264 · 8-bit'], ['hevc', 'HEVC / H.265 · 8-bit', 'HEVC · 8-bit']], 'codec', {topic:'codec', title:'About codecs and video color', text:'H.264 plays almost everywhere. HEVC makes smaller files at the same quality, but some older players can\'t open it. Both export 8-bit SDR video with the phone\'s hardware encoder.'});
    content += exportSelect('exportRateMode', 'Rate control', exportConfig.rateMode, [['quality', 'Quality'], ['bitrate', 'Target bitrate']], 'rateMode');
    if (exportConfig.rateMode === 'bitrate') content += `<div class="export-row"><div class="export-field-label"><label for="exportBitrate">Video · Mbps</label>${exportHelpButton('bitrate', 'About suggested bitrate')}</div><div class="export-bitrate-control"><input id="exportBitrate" class="field" type="number" min=".2" max="100" step=".1" value="${exportConfig.bitrate}" onchange="setExportBitrate(this.value)"><button type="button" class="chip ${exportConfig.bitrateAutomatic ? 'selected' : ''}" aria-label="Use suggested bitrate" aria-pressed="${exportConfig.bitrateAutomatic}" onclick="useSuggestedBitrate()">Auto</button></div></div>${exportHelpPanel('bitrate', 'Auto suggests a starting bitrate from resolution, frame rate and codec. Adjust it for motion and detail.')}`;
    content += '</div>';
    if (!state.mute && sourceHasAudio) {
      content += '<div class="export-group-label">Audio</div><div class="export-card">';
      content += exportSelect('exportAudioBitrate', 'Quality', exportConfig.audioBitrate, [96,128,192,256].map(n => [n, n + ' kbps']), 'audioBitrate');
      content += exportSelect('exportChannels', 'Channels', exportConfig.channels, [[0, 'Original'], [2, 'Stereo'], [1, 'Mono']], 'channels');
      content += exportSelect('exportSampleRate', 'Sample rate', exportConfig.sampleRate, [[0, 'Original'], [44100, '44.1 kHz'], [48000, '48 kHz']], 'sampleRate');
      content += '</div>';
    }
    content += '</div></details>';
  }
  content += '</fieldset>';
  $('exportOptions').innerHTML = content;
  if (exporting) $('exportFields').disabled = true;
  updateExportSummary();
}
function exportOutputDimensions(size = exportSize) {
  if (mediaType === 'video') return exportGeometry(size);
  const g = geometry(state), scale = size ? Math.min(1, size / Math.max(g.cw, g.ch)) : 1;
  return [Math.max(2, Math.round(g.cw * scale)), Math.max(2, Math.round(g.ch * scale))];
}
function setExportDimension(side, value) {
  value = Number(value);
  if (exporting || !Number.isFinite(value) || value < 2) { renderExport(); return; }
  const g = geometry(state), edge = side === 'width' ? g.cw : g.ch;
  if (mediaType === 'video') value = Math.max(2, Math.floor(value / 2) * 2);
  const longest = Math.max(g.cw, g.ch), requested = value / edge * longest;
  setCustomExportSize(Math.min(8192, Math.ceil(longest),
      mediaType === 'video' ? Math.ceil(requested) : Math.round(requested)));
}
function updateExportSummary() {
  const dimensions = exportOutputDimensions();
  let info = exportFormat === 'jpg' ? 'JPEG' : exportFormat.toUpperCase();
  if (mediaType === 'video') info = time((state.end - state.start) / state.speed) + ' · ' +
      (exportConfig.codec === 'hevc' ? 'HEVC' : 'H.264') + (exportConfig.fps ? ' · ' + exportConfig.fps + ' fps' : '') +
      ' · about ' + formatSize(estimatedVideoBytes());
  else if (exportFormat !== 'png') info += ' · ' + Math.round(quality * 100) + '%';
  $('exportSummary').textContent = dimensions.join(' × ') + ' · ' + info;
}
// The video exporter's own bitrate rules (VideoExporter.encodeVideo and
// MainActivity.videoJob), so the estimate matches what the encoder is asked for.
function estimatedVideoBytes() {
  const [w, h] = exportOutputDimensions(), seconds = (state.end - state.start) / state.speed,
        source = sourceVideoFps || 30, arrival = source * state.speed,
        grid = exportConfig.fps || (state.speed > 1 ? source : 0),
        fps = Math.max(1, Math.round(grid ? Math.min(grid, arrival) : arrival));
  let video;
  if (exportConfig.rateMode === 'bitrate') video = exportConfig.bitrate * 1e6;
  else {
    const bpp = {18: .2, 20: .15, 23: .1, 28: .06}[exportConfig.crf] * (exportConfig.codec === 'hevc' ? .65 : 1);
    video = clamp(w * h * fps * bpp, 5e5, 1e8);
  }
  const audio = state.mute || !sourceHasAudio ? 0 : exportConfig.audioBitrate * 1000;
  return (video + audio) * seconds / 8;
}
function formatSize(bytes) {
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + ' GB';
  if (bytes >= 1e7) return Math.round(bytes / 1e6) + ' MB';
  return Math.max(.1, bytes / 1e6).toFixed(1) + ' MB';
}
// The phone's encoders, asked once. HEVC is only offered when the phone has one.
let cachedVideoEncoders = null;
function videoEncoders() {
  if (!cachedVideoEncoders) {
    try { cachedVideoEncoders = JSON.parse(Native.videoEncoders()); }
    catch (_) { cachedVideoEncoders = {h264: true, hevc: false}; }
  }
  return cachedVideoEncoders;
}
function videoExportOptions() {
  return {codec: videoEncoders().hevc ? exportConfig.codec : 'h264', crf: exportConfig.crf,
    fps: exportConfig.fps, rateMode: exportConfig.rateMode, bitrate: exportConfig.bitrate,
    audioBitrate: exportConfig.audioBitrate,
    channels: exportConfig.channels, sampleRate: exportConfig.sampleRate,
    name: exportConfig.name};
}
