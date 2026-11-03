#!/data/data/com.termux/files/usr/bin/sh
set -eu
cd "$(dirname "$0")/.."
DISPLAY_ID=$(cat artifacts/display-id)
: > artifacts/startup-profile.txt
for sample in 1 2 3; do
 adb -s 127.0.0.1:5555 shell am force-stop studio.luma.editor
 adb -s 127.0.0.1:5555 shell am start --display "$DISPLAY_ID" -W -n studio.luma.editor/studio.luma.MainActivity >> artifacts/startup-profile.txt
 done
APP_PID=$(adb -s 127.0.0.1:5555 shell pidof studio.luma.editor | tr -d '\r')
adb -s 127.0.0.1:5555 forward tcp:9222 "localabstract:webview_devtools_remote_$APP_PID"
cat artifacts/startup-profile.txt
