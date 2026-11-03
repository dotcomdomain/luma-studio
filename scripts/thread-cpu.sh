#!/bin/bash
# Per-thread CPU of a Luma instance's app and renderer processes over a window:
#   thread-cpu.sh SECONDS   (LUMA_INSTANCE selects the copy; prints ticks per thread, 100 = 1 s)
PKG=studio.luma.editor${LUMA_INSTANCE:+.$LUMA_INSTANCE}
ssh phone "su -c '
P=\$(pidof $PKG | cut -d\" \" -f1); U=\$(stat -c %u /proc/\$P); A=\$((U % 100000 - 10000))
R=\$(dumpsys activity processes 2>/dev/null | grep \"/u0a\${A}i\" | grep -o \"[0-9]*:com.android.webview\" | head -1 | cut -d: -f1)
snap() { for p in \$P \$R; do for t in /proc/\$p/task/*; do echo \"\$p \$(basename \$t) \$(cat \$t/comm | tr \" \" _) \$(awk \"{print \\\$14+\\\$15}\" \$t/stat)\"; done; done; }
snap > /data/local/tmp/t1.txt; sleep $1; snap > /data/local/tmp/t2.txt
awk -v app=\$P \"NR==FNR{a[\\\$1\\\" \\\"\\\$2]=\\\$4; next} {d=\\\$4-a[\\\$1\\\" \\\"\\\$2]; if (d>2) printf \\\"%s %-22s %d\\n\\\", (\\\$1==app?\\\"app\\\":\\\"renderer\\\"), \\\$3, d}\" /data/local/tmp/t1.txt /data/local/tmp/t2.txt | sort -k3 -n -r | head -16
rm -f /data/local/tmp/t1.txt /data/local/tmp/t2.txt'"
