#!/bin/bash
# Resource use of a Luma instance (app process + its WebView renderer).
#   scripts/measure.sh mem           PSS in MB of both processes
#   scripts/measure.sh cpu SECONDS   CPU used over that window, in % of one core
# Instance from LUMA_INSTANCE (empty = the real app, t1..t9 = test copies).
PKG=studio.luma.editor${LUMA_INSTANCE:+.$LUMA_INSTANCE}
ssh phone "su -c 'sh \"/data/data/com.termux/files/home/Codex Projects/media-editor/scripts/measure-phone.sh\" $PKG $1 ${2:-0}'"
