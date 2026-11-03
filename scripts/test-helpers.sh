# Shell helpers for driving Luma on the hidden display from the t3 container.
# Source this file. Set LUMA_INSTANCE=t1..t9 first to drive a test copy instead of the app.
case "${LUMA_INSTANCE:-}" in
  '') LUMA_PKG=studio.luma.editor LUMA_PORT=9222 _run=run ;;
  *) LUMA_PKG=studio.luma.editor.$LUMA_INSTANCE LUMA_PORT=$((9222 + ${LUMA_INSTANCE#t})) _run=run-$LUMA_INSTANCE ;;
esac
LUMA_VD="LUMA_VD_RUN=/data/data/com.termux/files/home/.cache/luma-vd/$_run /data/data/com.termux/files/home/.cache/luma-vd/vd"
D=/data/user/0/$LUMA_PKG/files
here_t=$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)
vdid() { ssh phone "$LUMA_VD id"; }
# edit FILE MIME: send ACTION_EDIT for a file in Luma's files dir.
edit() { ssh phone "su -mm -c 'am start --display $(vdid) -a android.intent.action.EDIT -d file://$D/$1 -t $2 -n $LUMA_PKG/studio.luma.MainActivity >/dev/null 2>&1'"; }
ev() { LUMA_PORT=$LUMA_PORT node --experimental-websocket --no-warnings "$here_t/eval.mjs" "$1"; }
shot() { ssh phone "$LUMA_VD shot /data/data/com.termux/files/home/.luma-shot-$LUMA_PORT.png >/dev/null && cat /data/data/com.termux/files/home/.luma-shot-$LUMA_PORT.png" > "$1"; }
files() { ssh phone "su -mm -c 'ls -la $D | grep -v ^total'"; }
key() { ssh phone "su -c 'input -d $(vdid) keyevent $1'"; }
tap() { ssh phone "su -c 'input -d $(vdid) tap $1 $2'"; }
swipe() { ssh phone "su -c 'input -d $(vdid) swipe $1 $2 $3 $4 ${5:-300}'"; }
# pixel PNG X Y: print the RGBA of one pixel of a screenshot.
pixel() { python3 -I "$here_t/png-pixel.py" "$@"; }
cdp() { LUMA_PORT=$LUMA_PORT node --experimental-websocket --no-warnings "$here_t/cdp-call.mjs" "$@"; }
