#!/bin/bash
# Runs the resource-use scenarios on a test copy (default t1) and prints one line each.
# Needs photo12.jpg (4000x3000) and video1080.mp4 (20 s 1080p30) in the copy's files dir.
export LUMA_INSTANCE=${LUMA_INSTANCE:-t1}
here=$(cd "$(dirname "$0")" && pwd)
. "$here/test-helpers.sh"
m() { "$here/measure.sh" "$@" | tr '\n' ' '; }
line() { echo "$1: $(m mem) $(m cpu ${2:-4}) $3"; }
ev 'showHome(); 1' >/dev/null; sleep 3
line home
edit photo12.jpg image/jpeg; sleep 8
ev 'setTool("looks"); 1' >/dev/null; sleep 2
line photo-idle
ev 'setTool("adjust"); window.__f = 0; window.__d = 0; const od = window.draw; (function loop(t0) { const t = performance.now(); if (!window.__t0) window.__t0 = t; if (t - window.__t0 < 4000) { slide("brightness", Math.round(50 * Math.sin(t / 300))); window.__f++; requestAnimationFrame(loop); } else window.__t0 = 0; })(); 1' >/dev/null
line slider-drag 4 "frames=$(sleep .3; ev 'window.__f')"
ev 'slide("brightness", 0); setTool("draw"); if (!state.drawingLayers.length) addDrawingLayer(); 1' >/dev/null; sleep 1
(LUMA_PORT=$LUMA_PORT node --experimental-websocket --no-warnings "$here/touch-stroke.mjs" 200 300 200 &) ; sleep .3
line drawing 3
sleep 2
ev 'undo(); 1' >/dev/null
edit video1080.mp4 video/mp4; sleep 6
ev 'setTool("trim"); video.currentTime = 0; togglePlay(); 1' >/dev/null; sleep 1
line video-play 4 "quality=$(ev 'JSON.stringify((q => ({total: q.totalVideoFrames, dropped: q.droppedVideoFrames}))(video.getVideoPlaybackQuality()))')"
ev 'video.pause(); openExport(); setExportPreset("balanced"); window.__x0 = performance.now(); doExport(); 1' >/dev/null; sleep 3
line video-export 6
while [ "$(ev 'exporting')" = "true" ]; do sleep 1; done
echo "video-export took $(ev 'Math.round((performance.now() - window.__x0) / 100) / 10')s: $(ev '$("exportStatus").textContent')"
ev 'closeExport(); 1' >/dev/null
for i in 1 2 3; do edit photo12.jpg image/jpeg; sleep 5; edit video1080.mp4 video/mp4; sleep 5; done
ev 'showHome(); 1' >/dev/null; sleep 4
line after-6-switches 2
