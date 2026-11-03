#!/system/bin/sh
# Phone side of measure.sh; run as root: measure-phone.sh PACKAGE mem|cpu SECONDS
PKG=$1
P=$(pidof $PKG | cut -d' ' -f1)
[ -n "$P" ] || { echo "$PKG is not running"; exit 1; }
U=$(stat -c %u /proc/$P)
A=$((U % 100000 - 10000))
# The renderer is an isolated process tagged with the app's id, e.g. ".../u0a311i26".
R=$(dumpsys activity processes 2>/dev/null | grep "/u0a${A}i" | grep -o '[0-9]*:com.android.webview' | head -1 | cut -d: -f1)
ticks() { awk '{print $14+$15}' /proc/$1/stat; }
pss() { dumpsys meminfo $1 2>/dev/null | awk '/TOTAL PSS:/{printf "%.0f", $3/1024; exit} /^ *TOTAL /{printf "%.0f", $2/1024; exit}'; }
case $2 in
  mem) echo "app_pss_mb=$(pss $P) renderer_pss_mb=$( [ -n "$R" ] && pss $R || echo none)" ;;
  cpu)
    a1=$(ticks $P); r1=$(ticks $R); sleep $3; a2=$(ticks $P); r2=$(ticks $R)
    echo "app_cpu_pct=$(( (a2 - a1) * 100 / (100 * $3) )) renderer_cpu_pct=$(( (r2 - r1) * 100 / (100 * $3) ))" ;;
esac
