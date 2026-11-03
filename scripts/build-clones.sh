#!/data/data/com.termux/files/usr/bin/sh
# Builds test copies of the current build as studio.luma.editor.t1..tN (run ./build.sh
# first). Clones have no intent filters, so they never show up in the launcher, in Edit or
# Share pickers, or disturb the "Always" default; launch them with am start -n.
set -eu
cd "$(dirname "$0")/.."
SDK=/data/data/com.termux/files/home/android-sdk
JAR="$SDK/platforms/android-36/android.jar"
for t in "$@"; do
  sed -e 's|<intent-filter>.*</intent-filter>||' \
      -e "s|android:label=\"Luma Studio\"|android:label=\"Luma test $t\"|" \
      app/AndroidManifest.xml > build/manifest-$t.xml
  aapt2 link -o build/$t.apk -I "$JAR" --manifest build/manifest-$t.xml -A app/assets \
      --rename-manifest-package studio.luma.editor.$t build/res.zip
  (cd build/dex && zip -q -u ../$t.apk classes.dex)
  apksigner sign --ks build/debug.keystore --ks-pass pass:android --out build/$t-signed.apk build/$t.apk
  adb -s 127.0.0.1:5555 install --no-incremental -r build/$t-signed.apk | tail -1
done
