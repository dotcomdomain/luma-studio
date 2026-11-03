#!/data/data/com.termux/files/usr/bin/sh
set -eu
cd "$(dirname "$0")"
SDK=/data/data/com.termux/files/home/android-sdk
JAR="$SDK/platforms/android-36/android.jar"
mkdir -p build/classes build/dex artifacts
aapt2 compile --dir app/res -o build/res.zip
aapt2 link -o build/base.apk -I "$JAR" --manifest app/AndroidManifest.xml -A app/assets build/res.zip
javac -source 8 -target 8 -Xlint:-options -classpath "$JAR" -d build/classes app/src/studio/luma/*.java
jar cf build/classes.jar -C build/classes .
d8 --lib "$JAR" --min-api 29 --output build/dex build/classes.jar
cp build/base.apk build/luma-unsigned.apk
(cd build/dex && zip -q -u ../luma-unsigned.apk classes.dex)
if [ ! -f build/debug.keystore ]; then keytool -genkeypair -keystore build/debug.keystore -storepass android -keypass android -alias androiddebugkey -dname 'CN=Luma Studio' -keyalg RSA -validity 10000 >/dev/null 2>&1; fi
apksigner sign --ks build/debug.keystore --ks-pass pass:android --out artifacts/luma-studio.apk build/luma-unsigned.apk
