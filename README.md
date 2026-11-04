# Luma Studio

An installed Android photo and single-clip video editor, designed for this device. A dark, spacious studio keeps editing tools in focused panels around a large preview.

## Editing

- Photos and videos: six looks with a strength slider, brightness, contrast, saturation, warmth, shadows, highlights and vignette.
- Free crop with draggable corners/edges and a grid; aspect presets, drag-to-pan positioning, pinch/slider zoom, straighten (±45°, zoomed so no corners show), rotation and horizontal/vertical flipping.
- Editable text layers: drag to position, multiline text, three fonts, size, color, rotation, opacity, bold/italic, outline and background.
- Drawing layers with multiple strokes per layer, pen, translucent marker and a layer-local eraser; color, width, opacity, undo/redo and clear selected drawing. Clear sits in the layer row; the ↺ icon beside Pen/Marker/Eraser resets the current tool’s width and opacity (the color stays).
- Video: draggable start/end trim handles with shaded excluded regions and precise time fields, scrubbing, preview playback, 0.5–2× speed, pitch-preserving audio, volume and mute, fade in/out (picture and sound, up to 3 s each, in Trim), saving the frame under the playhead as a photo (the photo button beside Export); H.264/AAC MP4 export with progress and cancellation.
- JPEG/PNG/WebP export, custom output sizing and continuous JPEG/WebP quality; fifty-step undo/redo, original comparison, reversible reset, saved settings for the last imported project, gallery saving and native sharing.

Tap the preview to play or pause outside Frame, Text and Draw. **Playback** holds speed and volume: speed chips from 0.5× to 2×, and one volume slider where 0% mutes and raising it restores sound. Tools are ordered from most to least used, and the editor opens on the first: videos get Trim, Frame, Playback, Adjust, Looks, Text and Draw, and photos get Frame, Adjust, Looks, Text and Draw. The order is two lists at the top of `navigation.js`.

In **Frame**, the aspect chips (Free, Original, 1:1…) set the shape. Drag an edge or corner to crop; when you let go, the view zooms in so the crop fills the preview again, with the cropped-off picture still showing, dimmed, around it. Dragging an edge back out into that margin undoes the crop, and each release zooms out to show more. Dragging anywhere else moves the picture under the box, and pinching zooms around the point between your fingers. In **Text**, add/select a layer and drag it directly on the preview; **Style** contains its extra formatting controls. **Draw** contains the pen, marker and eraser. Drawing and text share a custom color sheet with presets, hue/saturation/brightness controls, hex entry and live text preview. **Done** saves the color (for text, one undo step; the brush color is a tool setting like Pen/Marker, which undo leaves alone); **Cancel** restores the original. **Reset all** removes every edit; Undo brings them back. The editor shows no hint bubbles or confirmation toasts; only failures (a file that won't open, a clip that won't play, a failed export or frame save, full storage) get a message. A saved frame shows as a brief check on the photo button.

Text and ink stay attached to the image through crop, pan, zoom, rotate and flip. They remain editable in the project and are baked into saved photos and videos. On video, each text layer has its own **Layer timing**, like drawing layers. In **Draw**, just draw: the first stroke starts a drawing layer. Select a drawing chip or tap **+** for another layer. New strokes join the selected layer. **Layer timing** sets that layer’s start/end interval on video, preserved through trimming, speed changes, preview and export. Clear and eraser affect only the selected layer; the delete button removes it. Older projects migrate their existing strokes and shared timing into one drawing layer.

Hold a trim, drawing-timing or progress selector still for about 0.7 seconds to enter temporary 4× precision zoom. Move first and zoom is disabled for the rest of that touch, even if you later stop. Releasing restores the full timeline. The progress bar visibly expands into a tick-marked ruler with a larger knob while zoomed. A small touch-jitter allowance keeps an intentional stationary hold reliable. Zoom alone does not change edits or create an undo entry.

The **Export** menu offers High quality, Balanced and Small file presets, remembered separately for photos and videos. High quality is the default: source resolution and frame rate with the least compression of the three (95% for photos, quality 20 for video). Settings saved by versions before 1.2 start over from this default, keeping only the codec and photo format. Presets preserve the selected codec, image format and file name. Small file caps known high frame rates at 30 fps without raising lower rates. Its custom dropdowns use padded SVG chevrons and matching menus, with touch, keyboard and Back support. Resolution options show actual width × height, including the original size; Custom exposes linked Width/Height fields. Main controls include resolution, image format/quality and video frame rate (original, 24, 25, 30, 50 or 60 fps). For videos, **More options** holds the file name, H.264/HEVC (HEVC only when the phone can encode it), quality or target bitrate (0.2–100 Mbps), AAC quality, original/mono/stereo channels and original/44.1/48 kHz audio. Photos have no More options: compression quality (JPEG and WebP) and the file name show directly. Sizes preserve the edited aspect ratio and do not upscale. Transparent photos default to PNG after a full-resolution background alpha scan. Explicit image-format choices are remembered per image; JPEG shows a short transparency-loss note when relevant. PNG is lossless; JPEG and WebP expose 50–100% compression quality. Optional info explains lossy quality and the 8-bit SDR video output. Target bitrate Auto suggests a starting point from dimensions, frame rate and codec, while manual values remain pinned. Video settings preserve trim, speed, text and independent drawing-layer timing. Presets are one segmented control, and the settings sit in rounded cards of rows with the label on the left and the value on the right. One line above Save sums up the output (for videos, with an estimated file size). Once saved, the button says so; the status line only appears for a note such as dropped audio, or for time left during a video export. After a preset, changing any setting by hand shows "Custom settings".

Originals are preserved: Luma edits a private copy. **Recent** on the home screen keeps the last six projects with their saved edits; copies that drop off the list are deleted. HEIC/HEIF and other formats the WebView can't decode are converted on import (PNG when the image has transparency, otherwise high-quality JPEG). A file that fails to open never replaces a Recent project. Back leaves the app from the home screen; when another app opened Luma (Edit or Share), Back from the editor returns there. A file that arrives during an export opens when the export finishes. Landscape phones get their own layout: preview on the left, the tool panel and a vertical tool rail on the right, and two-column export and color sheets.

New creations are saved to **Pictures/Luma** or **Movies/Luma**. Imports use Android's document picker. The app also appears in a gallery's **Edit** and **Share** menus for photos and videos. The app has no Internet permission.

## Device setup

The app is installed as **Luma Studio**, package `studio.luma.editor`. The APK is [artifacts/luma-studio.apk](artifacts/luma-studio.apk).

Photo processing uses WebView Canvas and a dedicated worker for asynchronous image encoding. Video export uses only Android's own media stack, with no root and no external tools:

- `VideoExporter.java`: the hardware decoder renders each frame into an OpenGL texture. One shader pass applies the file's rotation metadata, flips, rotation, crop and scale, then warmth, brightness, contrast and saturation in the same order as the preview's canvas filters. Overlays (vignette, timed drawing layers, text) are drawn on top, and the hardware encoder (H.264 High or HEVC Main, BT.709) takes the result from its input surface. Quality levels are bitrates per pixel; a target bitrate uses CBR.
- `AudioPipeline.java`: decode, trim, channel mix, volume, WSOLA time-stretch (keeps pitch at 0.5–2×), resample, AAC. It runs on its own thread while the video encodes, and drops the AAC encoder's priming samples so audio starts in sync.
- `Mp4FastStart.java`: moves the index before the media data if MediaMuxer wrote it last, so every export can start playing while it downloads. The reordered file is written straight into the gallery entry, so this costs no extra time or space, and the old "Optimize for streaming" switch is gone.
- `ExportService.java`: a foreground service with a progress notification while a video exports, so leaving the app or the screen turning off doesn't stop it. The screen also stays on while Luma is in front during any export. Notifications only show if they're allowed for Luma in Android's settings.

Frame timing follows the preview: each output frame is the frame the preview shows at that moment (a trim start between two frames begins with the frame on screen there), and a drawing layer appears on every frame the preview shows it on. A chosen frame rate never adds frames; Original keeps the source rate, dropping frames when sped up. Surround audio is downmixed to stereo with the centre and surround channels at -3 dB; gaps in a file's audio become silence; audio the phone can't decode is left out with a note instead of failing the export. HDR clips (PQ or HLG) are tone-mapped to standard video in the shader, since this phone's decoder ignores Android's tone-mapping request. Audio the extractor can't read at all (DTS in MKV) shows in the Playback tool as "no sound track the phone can play". Frames bigger than the decoder's input buffers (about 7 MB; only lossless or near-lossless 4K files have them) can't be decoded on this phone: neither decoder can get bigger buffers, and both lose data when a frame is split. Such files get a clear error. Exports that would pass 4 GB (MediaMuxer's limit) or the free storage are refused up front.

Colors: the exporter normally reads frames through the GPU's own YUV-to-RGB conversion, which this phone's Mali driver gets right for limited-range video. It treats full-range video (yuvj, as in some cameras and the sample clip) as limited, so for full-range, BT.2020 and HDR sources the shader reads the YUV values (GL_EXT_YUV_target, OpenGL ES 3) and converts with the file's own matrix and range; the matrix and range come from the decoder, which also decodes Android's "extended" color standards (64 + primaries + 7 × matrix). Exports match ffmpeg's decode of the source within about 1 level. The WebView preview is less consistent: depending on what it played before, it may decode a BT.709 video with the BT.601 matrix. So when a video opens, Java decodes the frame on screen into a 32 × 18 reference with the exporter's conversion, and if the WebView's picture differs the page corrects the preview (and saved frames) with the fitted color matrix. The preview also places color slightly differently at sharp color edges; that's the WebView's and doesn't affect exports. A 2-minute 1280×854 clip exports in about 45 s on this phone.

Resource use was profiled on this phone (`scripts/profile-scenarios.sh`, `scripts/measure.sh`, `scripts/thread-cpu.sh`, `scripts/js-profile.mjs`). The main measures: the tool panel is its own compositor layer and the trim playhead moves by transform, so playback doesn't repaint the panel; the preview caches its filtered base picture while only annotations change; sliders render the preview at 720 px while held; an unedited picture skips the filter pass; large photos keep only a 2048 px preview copy in memory and reload the full image for exports; JPEGs skip the transparency scan; Recent thumbnails are small JPEGs made and cached by Java. Measured in % of one core (app process / WebView renderer):

| Scenario | Before | After |
|---|---|---|
| 1080p video playback (Trim) | 134% / 93%, frames dropped | 67% / 57%, none dropped |
| Drawing a stroke on a 12 MP photo | 73% / 43% | 45% / 29% |
| Slider drag on a 12 MP photo | ~14 fps | ~23 fps |
| 20 s 1080p export | 30.8 s | 13.5 s |
| Home screen, renderer memory | 65 MB | 56 MB |

Memory levels off at about 117 MB (app) and 95 MB (renderer) after repeated switching between a 12 MP photo and a 1080p video; it doesn't grow further.

## Build and install

Run `./build.sh` in Termux. It uses the installed JDK, Android 36 platform, aapt2, d8 and apksigner, without Gradle or downloaded build dependencies. Minimum Android version: 10; target SDK: 34.

```
adb -s 127.0.0.1:5555 install --no-incremental -r artifacts/luma-studio.apk
```

## Default editor

`scripts/SetDefaultEditor.java` makes Luma the "Always" choice for gallery Edit buttons, the same setting the system app picker saves. Build it to a dex with javac, jar and d8 (as for the virtual-display helper), then run it as root with the MIME types to claim:

```
su -c 'app_process -cp /data/local/tmp/sde.dex / SetDefaultEditor image/jpeg image/png video/mp4'
```

`--dry-run` lists the handlers without changing anything. Android drops a default when another app that handles the same type is installed. Run the script again after that.

## Development scripts

Run from the t3 container. The phone must be awake: virtual displays draw nothing while it sleeps.

- `scripts/dev.sh build|start|relaunch|shot FILE|eval 'JS'|stop` builds and installs, runs Luma on a private offscreen display, and evaluates JS through WebView DevTools. The installed app only enables DevTools while the root-made flag file `files/devtools` exists; `start`/`relaunch` create it and `stop` removes it. Test copies always have DevTools. `LUMA_INSTANCE=t1` (to `t9`) drives a test copy instead.
- `scripts/dev.sh clones t1 t2 t3` installs test copies (`studio.luma.editor.tN`) with their own data. They have no intent filters, so they never appear in the launcher or in Edit/Share pickers.
- `scripts/test-helpers.sh` (source it) adds `edit FILE MIME`, `ev`, `shot`, `pixel`, `cdp` (raw DevTools commands such as multi-touch) and more.

## Offscreen device testing

The root-owned virtual display uses an ImageReader surface and does not mirror or open an overlay on the physical display. It keeps testing off the user's screen.

```
python scripts/virtual-display.py start
# Use the display ID printed by the command:
adb -s 127.0.0.1:5555 shell am start --display DISPLAY_ID -n studio.luma.editor/studio.luma.MainActivity
python scripts/virtual-display.py stop
```

While it is running, create `artifacts/capture.request` and make an edit to save an actual surface screenshot to `artifacts/display.png`. Chromium's screenshot API can omit accelerated video canvas content; use the surface capture to verify video visuals.

`scripts/startup-profile.sh` records three process-cold launches on the virtual display and forwards WebView DevTools to localhost:9222. `scripts/profile.mjs` measures repeated adjustment rendering and animation-frame intervals. `scripts/probe-latest.sh` prints the streams of the newest export and `scripts/compare-export.sh` compares it with the preview; `scripts/analysis/` has the frame and audio checks used on exports. Test output isn't kept in the repo: delete test exports from the gallery when done.

## Credits

The bundled alpine photograph is from [Unsplash](https://images.unsplash.com/photo-1470770841072-f978cf4d019e); the sample motion clip is generated from that photograph with a synthesized tone. Photo asset: https://images.unsplash.com/photo-1470770841072-f978cf4d019e . Interface icons are hand-authored SVG paths.
