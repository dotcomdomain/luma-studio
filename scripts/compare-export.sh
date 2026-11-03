#!/bin/bash
# Compares the newest export in Movies/Luma with the app's preview at the same moment.
# Usage (with test-helpers.sh sourced): scripts/compare-export.sh SOURCE_TIME_SECONDS
# Prints the mean absolute difference per channel (0-255) over a 32x32 downscale.
T=$1
. "$(dirname "$0")/test-helpers.sh"
PREVIEW=$(ev "new Promise(r => { const done = () => { const c = document.createElement('canvas'); renderTo(c, 256); const s = document.createElement('canvas'); s.width = s.height = 32; s.getContext('2d').drawImage(c, 0, 0, 32, 32); r(JSON.stringify({w: c.width, h: c.height, px: [...s.getContext('2d').getImageData(0, 0, 32, 32).data]})); }; video.pause(); if (Math.abs(video.currentTime - $T) < .001) done(); else { video.addEventListener('seeked', done, {once: true}); video.currentTime = $T; } })")
OUT=$(ev "(($T - state.start) / state.speed).toFixed(3)" | tr -d '"')
ssh phone "F=\$(ls -t /sdcard/Movies/Luma/*.mp4 | head -1); \$PREFIX/bin/ffmpeg -v error -ss $OUT -i \$F -frames:v 1 -vf scale=32:32,format=rgba -f rawvideo - | od -An -tu1 -v" > /tmp/export-px.txt
python3 -I - "$PREVIEW" <<'PY'
import json, sys
p = json.loads(json.loads(sys.argv[1]))
e = [int(v) for v in open('/tmp/export-px.txt').read().split()]
d = [0, 0, 0]
for i in range(32 * 32):
    for c in range(3): d[c] += abs(p['px'][i * 4 + c] - e[i * 4 + c])
print('preview', p['w'], 'x', p['h'], 'MAD R G B:', [round(v / 1024, 1) for v in d])
PY
