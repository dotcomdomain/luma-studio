let photoProbeCancel = null;
function cancelPhotoTransparencyProbe() {
  photoProbeCancel?.();
  photoProbeCancel = null;
}
function transparencyWorker() {
  onmessage = ({data: bitmap}) => {
    try {
      const c = new OffscreenCanvas(512, 512), ctx = c.getContext('2d', {willReadFrequently: true});
      for (let y = 0; y < bitmap.height; y += 512) {
        for (let x = 0; x < bitmap.width; x += 512) {
          const w = Math.min(512, bitmap.width - x), h = Math.min(512, bitmap.height - y);
          ctx.clearRect(0, 0, 512, 512);
          ctx.drawImage(bitmap, x, y, w, h, 0, 0, w, h);
          const pixels = ctx.getImageData(0, 0, w, h).data;
          for (let i = 3; i < pixels.length; i += 4)
            if (pixels[i] < 255) { postMessage(true); return; }
        }
      }
      postMessage(false);
    } catch (_) { postMessage(null); }
    finally { bitmap.close(); }
  };
}
async function fallbackPhotoTransparency(source, sequence) {
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 512;
    const ctx = c.getContext('2d', {willReadFrequently: true});
    let count = 0;
    for (let y = 0; y < source.naturalHeight; y += 512) {
      for (let x = 0; x < source.naturalWidth; x += 512) {
        if (sequence !== mediaLoadSequence) return false;
        const w = Math.min(512, source.naturalWidth - x), h = Math.min(512, source.naturalHeight - y);
        ctx.clearRect(0, 0, 512, 512);
        ctx.drawImage(source, x, y, w, h, 0, 0, w, h);
        const pixels = ctx.getImageData(0, 0, w, h).data;
        for (let i = 3; i < pixels.length; i += 4) if (pixels[i] < 255) return true;
        if (++count % 4 === 0) await new Promise(requestAnimationFrame);
      }
    }
    return false;
  } catch (_) { return true; }
}
async function probePhotoTransparency(source, sequence) {
  if (typeof createImageBitmap === 'undefined' || typeof OffscreenCanvas === 'undefined')
    return fallbackPhotoTransparency(source, sequence);
  let bitmap;
  try { bitmap = await createImageBitmap(source); }
  catch (_) { return fallbackPhotoTransparency(source, sequence); }
  if (sequence !== mediaLoadSequence) { bitmap.close(); return false; }
  let worker, url;
  try {
    url = URL.createObjectURL(new Blob(['(' + transparencyWorker.toString() + ')()'], {type: 'text/javascript'}));
    worker = new Worker(url);
  } catch (_) {
    bitmap.close();
    if (url) URL.revokeObjectURL(url);
    return fallbackPhotoTransparency(source, sequence);
  }
  const result = await new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      worker.terminate();
      URL.revokeObjectURL(url);
      if (photoProbeCancel === cancel) photoProbeCancel = null;
      resolve(value);
    };
    const cancel = () => finish(false);
    photoProbeCancel = cancel;
    worker.onmessage = ({data}) => finish(data);
    worker.onerror = () => finish(null);
    worker.postMessage(bitmap, [bitmap]);
  });
  if (sequence !== mediaLoadSequence) return false;
  return result === null ? fallbackPhotoTransparency(source, sequence) : result;
}
