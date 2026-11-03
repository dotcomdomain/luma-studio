#!/bin/sh
# Development helper, run from the t3 container. It builds on the phone and runs
# Luma on an offscreen virtual display, so nothing opens on the user's screen.
#   scripts/dev.sh build            build and install the APK
#   scripts/dev.sh clones t1 t2 ..  build and install test copies (studio.luma.editor.tN)
#   scripts/dev.sh start [W H DPI]  start the virtual display and launch Luma on it
#   scripts/dev.sh relaunch         force-stop Luma and launch it on the display again
#   scripts/dev.sh shot FILE        save the display's newest frame to FILE (container path)
#   scripts/dev.sh eval 'JS'        evaluate JS in the WebView and print the JSON result
#   scripts/dev.sh stop             stop the display (closes Luma)
# For a test copy, set LUMA_INSTANCE=t1 (etc.): its own package, display and DevTools port.
# The phone must be awake; a sleeping phone draws nothing on virtual displays.
set -eu
case "${LUMA_INSTANCE:-}" in
  '') PKG=studio.luma.editor PORT=9222 RUNDIR=run ;;
  t[1-9]) n=${LUMA_INSTANCE#t}; PKG=studio.luma.editor.$LUMA_INSTANCE PORT=$((9222 + n)) RUNDIR=run-$LUMA_INSTANCE ;;
  *) echo "LUMA_INSTANCE must be empty or t1..t9" >&2; exit 2 ;;
esac
VD="LUMA_VD_RUN=/data/data/com.termux/files/home/.cache/luma-vd/$RUNDIR /data/data/com.termux/files/home/.cache/luma-vd/vd"
PROJECT='/data/data/com.termux/files/home/Codex Projects/media-editor'
ADB='adb -s 127.0.0.1:5555'
here=$(cd "$(dirname "$0")" && pwd)
forward() {
  ssh phone "for i in \$(seq 1 50); do P=\$(su -c 'pidof $PKG' 2>/dev/null) && break; sleep 0.2; done
    $ADB forward --remove tcp:$PORT 2>/dev/null; $ADB forward tcp:$PORT localabstract:webview_devtools_remote_\$P >/dev/null"
}
launch() {
  id=$(ssh phone "$VD id")
  ssh phone "su -c 'am force-stop $PKG; am start --display $id -n $PKG/studio.luma.MainActivity >/dev/null'"
  forward
}
case "$1" in
  build)
    # A failed compile must not go on to install the previous APK.
    ssh phone "set -o pipefail; cd '$PROJECT' && { ./build.sh 2>&1 | awk '!/^Note:/'; } || { echo 'BUILD FAILED'; exit 1; }
      $ADB get-state >/dev/null 2>&1 || adb connect 127.0.0.1:5555 >/dev/null
      $ADB install --no-incremental -r artifacts/luma-studio.apk | tail -1" ;;
  clones)
    shift
    ssh phone "cd '$PROJECT' && scripts/build-clones.sh $*" ;;
  start)
    shift
    ssh phone "$VD start $*" >/dev/null
    launch ;;
  relaunch) launch ;;
  shot)
    ssh phone "$VD shot /data/data/com.termux/files/home/.luma-shot-$PORT.png >/dev/null; cat /data/data/com.termux/files/home/.luma-shot-$PORT.png" > "$2" ;;
  eval)
    LUMA_PORT=$PORT node --experimental-websocket --no-warnings "$here/eval.mjs" "$2" ;;
  stop)
    ssh phone "$VD stop" ;;
  *) echo "unknown command $1" >&2; exit 2 ;;
esac
