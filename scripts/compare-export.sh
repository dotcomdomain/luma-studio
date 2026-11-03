#!/bin/bash
# Compares the newest export in Movies/Luma with the app's preview at the same moment.
# Usage (with LUMA_INSTANCE set as for dev.sh): scripts/compare-export.sh SOURCE_TIME_SECONDS
# Both pictures are reduced to an 8 × 8 grid of block averages (area filter), which ignores
# sub-pixel differences such as the export's even width. Prints the mean absolute
# difference per channel (0-255) and the largest single block difference.
T=$1
. "$(dirname "$0")/test-helpers.sh"
PREVIEW=$(ev "new Promise(r => { const done = () => { const c = document.createElement('canvas'); renderTo(c, 8192); const g = c.getContext('2d'); const d = g.getImageData(0, 0, c.width, c.height).data; const out = []; for (let by = 0; by < 8; by++) for (let bx = 0; bx < 8; bx++) { const m = [0, 0, 0]; let n = 0; for (let y = Math.floor(by * c.height / 8); y < Math.floor((by + 1) * c.height / 8); y += 2) for (let x = Math.floor(bx * c.width / 8); x < Math.floor((bx + 1) * c.width / 8); x += 2) { const o = (y * c.width + x) * 4; m[0] += d[o]; m[1] += d[o + 1]; m[2] += d[o + 2]; n++; } out.push(...m.map(v => v / n)); } r(JSON.stringify(out)); }; video.pause(); if (Math.abs(video.currentTime - $T) < .001) done(); else { video.addEventListener('seeked', done, {once: true}); video.currentTime = $T; } })")
OUT=$(ev "(($T - state.start) / state.speed).toFixed(3)" | tr -d '"')
ssh phone "F=\$(ls -t /sdcard/Movies/Luma/*.mp4 | head -1); \$PREFIX/bin/ffmpeg -v error -ss $OUT -i \"\$F\" -frames:v 1 -vf scale=8:8:flags=area,format=rgb24 -f rawvideo - | od -An -tu1 -v" > /tmp/export-px.txt
python3 -I - "$PREVIEW" <<'PY'
import json, sys
p = json.loads(json.loads(sys.argv[1]))
e = [int(v) for v in open('/tmp/export-px.txt').read().split()]
d = [0, 0, 0]; worst = 0
for i in range(64):
    for c in range(3):
        diff = abs(p[i * 3 + c] - e[i * 3 + c]); d[c] += diff; worst = max(worst, diff)
print('MAD R G B:', [round(v / 64, 1) for v in d], 'worst block:', round(worst, 1))
import os
if os.environ.get("BLOCKS"):
    for i in range(64):
        dd = [round(p[i*3+c] - e[i*3+c]) for c in range(3)]
        if max(map(abs, dd)) > 6: print(i % 8, i // 8, dd, [round(p[i*3+c]) for c in range(3)])
PY
