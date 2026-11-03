package studio.luma;

import android.graphics.Bitmap;
import android.graphics.SurfaceTexture;
import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaCodecList;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.media.MediaMuxer;
import android.opengl.EGL14;
import android.opengl.EGLConfig;
import android.opengl.EGLContext;
import android.opengl.EGLDisplay;
import android.opengl.EGLExt;
import android.opengl.EGLSurface;
import android.opengl.GLES11Ext;
import android.opengl.GLES20;
import android.opengl.GLUtils;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.view.Surface;
import java.io.File;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.FloatBuffer;
import java.util.ArrayList;
import java.util.List;

// Exports an edited video with Android's own codecs: the hardware decoder renders each
// frame into an OpenGL texture, one shader pass applies the frame and color edits and the
// overlays, and the hardware encoder takes the result straight from its input surface.
// Audio is decoded, trimmed, time-stretched, resampled and re-encoded as AAC by
// AudioPipeline, then interleaved with the video in MediaMuxer.
final class VideoExporter {
  interface Listener {
    void progress(int percent);
    boolean cancelled();
  }
  static final class Overlay {
    // Only the part of the output that has pixels; x, y, w, h in output pixels.
    Bitmap bitmap;
    int x, y, w, h;
    long fromUs = 0, toUs = Long.MAX_VALUE; // output time
    int texture;
  }
  static final class CancelledException extends Exception {}

  // Settings, filled in by the caller.
  File source, output;
  long startUs, durationUs;
  double speed = 1;
  boolean flipH, flipV;
  int rotation; // user rotation, clockwise degrees
  float[] crop = {0, 0, 1, 1}; // x, y, w, h in the rotated frame, 0..1
  int width, height;
  float brightness = 1, contrast = 1, saturation = 1;
  float[] warmth = {1, 1, 1};
  final List<Overlay> overlays = new ArrayList<>();
  String mime = MediaFormat.MIMETYPE_VIDEO_AVC;
  int bitrate = 8_000_000, fps = 0;
  float bitsPerPixel = 0; // quality mode: bitrate = width × height × frame rate × this
  boolean fastStart = true;
  String name = "";
  boolean mute;
  float volume = 1;
  int audioBitrate = 192_000, channels = 0, sampleRate = 0;
  Listener listener;

  static final long TIMEOUT_US = 10_000;

  // The first codec of this type that can encode this size at this rate, hardware first.
  // If none lists the rate, the first that takes the size.
  static String encoderFor(String mime, int width, int height, int fps) {
    String sizeOnly = null;
    for (MediaCodecInfo info : new MediaCodecList(MediaCodecList.REGULAR_CODECS).getCodecInfos()) {
      if (!info.isEncoder()) continue;
      for (String type : info.getSupportedTypes()) {
        if (!type.equalsIgnoreCase(mime)) continue;
        MediaCodecInfo.VideoCapabilities caps =
            info.getCapabilitiesForType(type).getVideoCapabilities();
        if (caps == null || !caps.isSizeSupported(width, height)) continue;
        if (caps.areSizeAndRateSupported(width, height, fps)) return info.getName();
        if (sizeOnly == null) sizeOnly = info.getName();
      }
    }
    return sizeOnly;
  }
  // H.264 High at the smallest level that fits the frame size and rate, if the encoder
  // supports it at that level. HEVC encoders default to Main, which is what we want.
  static int[] avcHighProfile(String codecName, int width, int height, int fps) {
    long mbs = (long) ((width + 15) / 16) * ((height + 15) / 16), mbps = mbs * fps;
    int[][] levels = { // level, max macroblocks per second, max frame size in macroblocks
        {MediaCodecInfo.CodecProfileLevel.AVCLevel31, 108000, 3600},
        {MediaCodecInfo.CodecProfileLevel.AVCLevel32, 216000, 5120},
        {MediaCodecInfo.CodecProfileLevel.AVCLevel4, 245760, 8192},
        {MediaCodecInfo.CodecProfileLevel.AVCLevel42, 522240, 8704},
        {MediaCodecInfo.CodecProfileLevel.AVCLevel5, 589824, 22080},
        {MediaCodecInfo.CodecProfileLevel.AVCLevel51, 983040, 36864},
        {MediaCodecInfo.CodecProfileLevel.AVCLevel52, 2073600, 36864}};
    int level = 0;
    for (int[] l : levels)
      if (mbps <= l[1] && mbs <= l[2]) { level = l[0]; break; }
    if (level == 0) return null;
    for (MediaCodecInfo info : new MediaCodecList(MediaCodecList.REGULAR_CODECS).getCodecInfos()) {
      if (!info.getName().equals(codecName)) continue;
      for (String type : info.getSupportedTypes()) {
        if (!type.equalsIgnoreCase(MediaFormat.MIMETYPE_VIDEO_AVC)) continue;
        for (MediaCodecInfo.CodecProfileLevel pl : info.getCapabilitiesForType(type).profileLevels)
          if (pl.profile == MediaCodecInfo.CodecProfileLevel.AVCProfileHigh && pl.level >= level)
            return new int[] {pl.profile, level};
      }
    }
    return null;
  }
  static boolean hasEncoder(String mime) {
    for (MediaCodecInfo info : new MediaCodecList(MediaCodecList.REGULAR_CODECS).getCodecInfos())
      if (info.isEncoder())
        for (String type : info.getSupportedTypes())
          if (type.equalsIgnoreCase(mime)) return true;
    return false;
  }

  void run() throws Exception {
    MediaExtractor probe = new MediaExtractor();
    probe.setDataSource(source.toString());
    int videoTrack = -1, audioTrack = -1;
    MediaFormat videoFormat = null;
    for (int i = 0; i < probe.getTrackCount(); i++) {
      MediaFormat f = probe.getTrackFormat(i);
      String m = f.getString(MediaFormat.KEY_MIME);
      if (m == null) continue;
      if (videoTrack < 0 && m.startsWith("video/")) { videoTrack = i; videoFormat = f; }
      if (audioTrack < 0 && m.startsWith("audio/")) audioTrack = i;
    }
    probe.release();
    if (videoTrack < 0) throw new IOException("This file has no video track.");
    // Read once: the decoder is configured with a copy, so a retry sees the same values.
    int sourceRotation = videoFormat.containsKey(MediaFormat.KEY_ROTATION) ?
        videoFormat.getInteger(MediaFormat.KEY_ROTATION) : 0;
    sourceRotation = ((sourceRotation % 360) + 360) % 360;
    double sourceFps = 30;
    try {
      Number rate = videoFormat.getNumber(MediaFormat.KEY_FRAME_RATE);
      if (rate != null && rate.doubleValue() > 0 && rate.doubleValue() < 1000) sourceFps = rate.doubleValue();
    } catch (Exception ignored) {}

    File audioData = new File(output.getParentFile(), output.getName() + ".aac.tmp");
    // Audio is encoded on its own thread while the video encodes; the codecs are separate
    // hardware/software units, so the export takes about as long as the video alone.
    AudioPipeline.Result audio = null;
    Thread audioThread = null;
    RandomAccessFile audioReader = null;
    try {
      if (!mute && audioTrack >= 0) {
        final AudioPipeline.Result result = audio = new AudioPipeline.Result();
        final int track = audioTrack;
        audioThread = new Thread(() -> {
          try {
            AudioPipeline.encode(result, source, track, startUs, durationUs, speed, volume,
                channels, sampleRate, audioBitrate, audioData, new AudioPipeline.Cancel() {
                  public boolean cancelled() { return listener.cancelled(); }
                  public void progress(double fraction) {}
                });
          } catch (Throwable e) {
            result.error = e;
          } finally {
            result.finished = true;
          }
        }, "luma-audio");
        audioThread.start();
        // Wait for the audio file to exist before opening a reader on it.
        while (!audio.finished && !audioData.exists()) Thread.sleep(2);
        if (audioData.exists()) audioReader = new RandomAccessFile(audioData, "r");
      }
      this.audioReader = audioReader;
      this.audioThread = audioThread;
      try {
        encodeVideo(videoTrack, videoFormat, sourceRotation, sourceFps, audio, true);
      } catch (CancelledException e) {
        throw e;
      } catch (Exception e) {
        // Some encoders accept the High profile and then fail on the first frame. Try once
        // more with the encoder's default profile if nothing was written yet.
        if (muxing || !profileRequested) throw e;
        output.delete();
        muxer = null;
        muxVideoTrack = muxAudioTrack = -1;
        audioIndex = 0;
        encodeVideo(videoTrack, videoFormat, sourceRotation, sourceFps, audio, false);
      }
    } finally {
      for (Overlay o : overlays)
        if (o.bitmap != null) { o.bitmap.recycle(); o.bitmap = null; }
      if (audioThread != null) audioThread.join();
      if (audioReader != null) try { audioReader.close(); } catch (IOException ignored) {}
      if (audio != null) audio.close();
      audioData.delete();
    }
  }

  // ---- Video -----------------------------------------------------------------------
  private MediaMuxer muxer;
  private int muxVideoTrack = -1, muxAudioTrack = -1, audioIndex = 0;
  private boolean muxing;
  private AudioPipeline.Result audio;
  private RandomAccessFile audioReader;
  private Thread audioThread;
  private final ByteBuffer audioBuffer = ByteBuffer.allocateDirect(1 << 16);

  private boolean profileRequested;
  // Set when the source ended before the trim did: the seconds that were exported.
  String shortBy;
  // Things the person should know about a finished export (no audio, HDR); null if none.
  String audioNote, colorNote;
  private long lastMuxedVideoUs = -1;
  private void encodeVideo(int track, MediaFormat sourceFormat, int sourceRotation,
      double sourceFps, AudioPipeline.Result audio, boolean useProfile) throws Exception {
    this.audio = audio;
    // "Original" keeps the source's frame rate in output time: a faster clip drops frames
    // to stay on that rate. A chosen rate never adds frames, so the encoder is told the
    // rate the file will really have.
    double gridFps = fps > 0 ? fps : speed > 1 + 1e-6 ? sourceFps : 0;
    double arrivalFps = sourceFps * speed;
    int frameRate = (int) Math.max(1, Math.round(gridFps > 0 ? Math.min(gridFps, arrivalFps) : arrivalFps));
    if (bitsPerPixel > 0)
      bitrate = (int) Math.max(500_000, Math.min(100_000_000,
          Math.round((double) width * height * frameRate * bitsPerPixel)));

    // MediaMuxer's MP4 writer stops writing (without an error) at 4 GB, so a file that
    // large would come out cut short.
    double bytes = (bitrate + (audio != null ? audioBitrate : 0)) * (durationUs / speed / 1e6) / 8;
    if (bytes > 3.9e9)
      throw new IOException("This export would be over 4 GB, the most a video saved on this "
          + "phone can hold. Choose a lower quality or bitrate, or a shorter trim.");
    if (bytes > output.getParentFile().getUsableSpace())
      throw new IOException("There isn't enough free storage for this export (about "
          + Math.round(bytes / 1e6) + " MB).");

    String encoderName = encoderFor(mime, width, height, frameRate);
    if (encoderName == null)
      throw new IOException("The phone's video encoder can't make a " + width + " × " + height
          + " video. Choose a smaller resolution.");
    MediaFormat outFormat = MediaFormat.createVideoFormat(mime, width, height);
    outFormat.setInteger(MediaFormat.KEY_COLOR_FORMAT,
        MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface);
    outFormat.setInteger(MediaFormat.KEY_BIT_RATE, bitrate);
    // A chosen bitrate is held with CBR; this phone's encoder ignores low VBR targets.
    outFormat.setInteger(MediaFormat.KEY_BITRATE_MODE, bitsPerPixel > 0 ?
        MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_VBR :
        MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_CBR);
    outFormat.setInteger(MediaFormat.KEY_FRAME_RATE, frameRate);
    outFormat.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1);
    // Ask for H.264 High (or HEVC Main) when the encoder lists it; it compresses better
    // than the Baseline profile encoders default to.
    int[] profile = useProfile ? avcHighProfile(encoderName, width, height, frameRate) : null;
    profileRequested = profile != null;
    if (profile != null) {
      outFormat.setInteger(MediaFormat.KEY_PROFILE, profile[0]);
      outFormat.setInteger(MediaFormat.KEY_LEVEL, profile[1]);
    }
    outFormat.setInteger(MediaFormat.KEY_COLOR_STANDARD, MediaFormat.COLOR_STANDARD_BT709);
    outFormat.setInteger(MediaFormat.KEY_COLOR_RANGE, MediaFormat.COLOR_RANGE_LIMITED);
    outFormat.setInteger(MediaFormat.KEY_COLOR_TRANSFER, MediaFormat.COLOR_TRANSFER_SDR_VIDEO);

    MediaExtractor extractor = new MediaExtractor();
    MediaCodec encoder = null, decoder = null;
    Gl gl = null;
    Surface encoderSurface = null, decoderSurface = null;
    SurfaceTexture texture = null;
    boolean stopped = false;
    HandlerThread frameThread = new HandlerThread("luma-frames");
    try {
      extractor.setDataSource(source.toString());
      extractor.selectTrack(track);
      extractor.seekTo(startUs, MediaExtractor.SEEK_TO_PREVIOUS_SYNC);

      encoder = MediaCodec.createByCodecName(encoderName);
      encoder.configure(outFormat, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
      encoderSurface = encoder.createInputSurface();
      gl = new Gl(encoderSurface);
      encoderSurface = null; // Gl owns it now
      encoder.start();
      gl.makeCurrent();
      gl.setup(this, sourceRotation);
      int codedW = sourceFormat.getInteger(MediaFormat.KEY_WIDTH), codedH = sourceFormat.getInteger(MediaFormat.KEY_HEIGHT);
      // The crop is in the user-rotated frame, whose width is the source's height when
      // exactly one of the two rotations is a quarter turn.
      boolean sideways = (sourceRotation % 180 != 0) != (rotation % 180 != 0);
      gl.setDownscale((sideways ? codedH : codedW) * crop[2] / width,
          (sideways ? codedW : codedH) * crop[3] / height);

      frameThread.start();
      final Object frameLock = new Object();
      final boolean[] frameReady = {false};
      texture = new SurfaceTexture(gl.oesTexture);
      texture.setOnFrameAvailableListener(t -> {
        synchronized (frameLock) {
          frameReady[0] = true;
          frameLock.notifyAll();
        }
      }, new Handler(frameThread.getLooper()));
      decoderSurface = new Surface(texture);
      decoder = MediaCodec.createDecoderByType(sourceFormat.getString(MediaFormat.KEY_MIME));
      // The decoder would rotate the picture itself (through the texture matrix); the shader
      // already does, so the decoder is told there's nothing to rotate. A copy keeps the
      // source format intact for a retry.
      MediaFormat inFormat = new MediaFormat(sourceFormat);
      inFormat.setInteger(MediaFormat.KEY_ROTATION, 0);
      boolean hdr = isHdr(sourceFormat);
      // HDR (PQ/HLG) frames would be read as SDR and look flat; ask the decoder to tone-map.
      if (hdr && Build.VERSION.SDK_INT >= 33)
        inFormat.setInteger(MediaFormat.KEY_COLOR_TRANSFER_REQUEST, MediaFormat.COLOR_TRANSFER_SDR_VIDEO);
      decoder.configure(inFormat, decoderSurface, null, 0);
      decoder.start();
      // Cleared once the decoder's output turns out to be tone-mapped to SDR.
      colorNote = hdr ?
          "This is an HDR video. The phone couldn't convert it to standard video, so colors may look flat." : null;

      muxer = new MediaMuxer(output.toString(), MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4);
      MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
      long endUs = startUs + durationUs, outputEndUs = Math.round(durationUs / speed);
      // With a fixed output rate, output frames sit on a grid: each grid slot takes the
      // first source frame that lands in it, and gets the slot's exact timestamp.
      double frameStepUs = gridFps > 0 ? 1e6 / gridFps : 0;
      // How long one source frame stays on screen, in output time. A drawing layer shows on
      // every frame the preview would show it on: any frame whose time on screen overlaps
      // the layer's interval.
      long frameSpanUs = Math.max(1, Math.round(1e6 / sourceFps / speed));
      long lastSlot = -1, lastOutUs = -1;
      boolean inputDone = false, decoderDone = false, encoderDone = false;
      // The newest frame before the trim start sits in the texture: the preview shows it at
      // the start point, so it becomes the first output frame.
      boolean heldFrame = false;
      long lastEncoderOutput = System.currentTimeMillis();
      float[] st = new float[16];
      while (!encoderDone) {
        if (listener.cancelled()) throw new CancelledException();
        // Feed every free decoder input buffer without waiting; the decoder often needs
        // several samples before it can output a frame.
        while (!inputDone) {
          int index = decoder.dequeueInputBuffer(0);
          if (index < 0) break;
          {
            ByteBuffer buffer = decoder.getInputBuffer(index);
            int size = extractor.readSampleData(buffer, 0);
            long time = extractor.getSampleTime();
            if (size < 0 || time > endUs + 1_000_000) {
              decoder.queueInputBuffer(index, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM);
              inputDone = true;
            } else {
              decoder.queueInputBuffer(index, 0, size, time, 0);
              extractor.advance();
            }
          }
        }
        boolean progress = true;
        while (progress) {
          progress = false;
          // Once the decoder is done, wait on the encoder instead of spinning.
          int e = encoder.dequeueOutputBuffer(info, decoderDone ? TIMEOUT_US : 0);
          if (e == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
            startMuxer(encoder.getOutputFormat());
            progress = true;
          } else if (e >= 0) {
            lastEncoderOutput = System.currentTimeMillis();
            ByteBuffer data = encoder.getOutputBuffer(e);
            if ((info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0 && info.size > 0) {
              writeAudioUpTo(info.presentationTimeUs);
              data.position(info.offset).limit(info.offset + info.size);
              muxer.writeSampleData(muxVideoTrack, data, info);
              lastMuxedVideoUs = Math.max(lastMuxedVideoUs, info.presentationTimeUs);
              listener.progress((int) Math.min(99, info.presentationTimeUs * 100 / Math.max(1, outputEndUs)));
            }
            encoder.releaseOutputBuffer(e, false);
            if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) encoderDone = true;
            progress = !encoderDone;
          } else if (decoderDone && System.currentTimeMillis() - lastEncoderOutput > 5000) {
            // Every frame was sent; an encoder that never reports the end of the stream
            // has nothing more to give.
            if (!muxing) throw new IOException("The video encoder stopped responding.");
            encoderDone = true;
          }
          if (progress || decoderDone || encoderDone) continue;
          int d = decoder.dequeueOutputBuffer(info, inputDone ? TIMEOUT_US : 2_000);
          if (d == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED && colorNote != null) {
            MediaFormat f = decoder.getOutputFormat();
            if (f.containsKey(MediaFormat.KEY_COLOR_TRANSFER) && !isHdr(f)) colorNote = null;
          }
          if (d < 0) continue;
          progress = true;
          boolean end = (info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0;
          long pts = info.presentationTimeUs;
          boolean inRange = info.size > 0 && pts >= startUs && pts < endUs;
          boolean beforeStart = info.size > 0 && pts < startUs;
          if (inRange && heldFrame && pts > startUs) {
            // The held frame covers the gap between the trim start and this frame.
            gl.draw(st, 0, frameSpanUs);
            gl.present(0);
            lastSlot = 0;
            lastOutUs = 0;
          }
          heldFrame = false;
          long sourceOutUs = Math.round((pts - startUs) / speed), outUs = sourceOutUs;
          boolean keep = inRange;
          if (keep && frameStepUs > 0) {
            long slot = (long) Math.floor((outUs + frameStepUs * .25) / frameStepUs);
            keep = slot > lastSlot;
            if (keep) {
              lastSlot = slot;
              outUs = Math.round(slot * frameStepUs);
            }
          } else if (keep && lastOutUs >= 0 && outUs <= lastOutUs) {
            keep = false;
          }
          decoder.releaseOutputBuffer(d, keep || beforeStart);
          if (keep || beforeStart) {
            synchronized (frameLock) {
              long deadline = System.currentTimeMillis() + 5000;
              while (!frameReady[0]) {
                long wait = deadline - System.currentTimeMillis();
                if (wait <= 0) throw new IOException("The video decoder stopped responding.");
                frameLock.wait(wait);
              }
              frameReady[0] = false;
            }
            texture.updateTexImage();
            texture.getTransformMatrix(st);
          }
          if (beforeStart) heldFrame = true;
          if (keep) {
            lastOutUs = outUs;
            // Overlays follow the frame's own time, not the grid slot it was moved to.
            gl.draw(st, sourceOutUs, frameSpanUs);
            gl.present(outUs * 1000);
          }
          if (end || pts >= endUs) {
            decoderDone = true;
            encoder.signalEndOfInputStream();
          }
        }
      }
      writeAudioUpTo(Long.MAX_VALUE);
      // A damaged or truncated file ends early; say how much could be read.
      if (lastOutUs >= 0 && lastOutUs < outputEndUs - 1_000_000)
        shortBy = String.format(java.util.Locale.ROOT, "%.1f", lastOutUs / 1e6);
      if (!muxing) throw new IOException("The video encoder produced no frames.");
      // stop() writes the index; if it fails the file is unusable, so the error counts.
      stopped = true;
      muxer.stop();
    } finally {
      if (decoder != null) try { decoder.stop(); } catch (Exception ignored) {} finally { decoder.release(); }
      if (encoder != null) try { encoder.stop(); } catch (Exception ignored) {} finally { encoder.release(); }
      if (decoderSurface != null) decoderSurface.release();
      if (texture != null) texture.release();
      if (gl != null) gl.release();
      if (encoderSurface != null) encoderSurface.release();
      frameThread.quitSafely();
      extractor.release();
      if (muxer != null) {
        try { if (muxing && !stopped) muxer.stop(); } catch (Exception ignored) {}
        muxer.release();
      }
    }
  }
  static boolean isHdr(MediaFormat f) {
    if (!f.containsKey(MediaFormat.KEY_COLOR_TRANSFER)) return false;
    int t = f.getInteger(MediaFormat.KEY_COLOR_TRANSFER);
    return t == MediaFormat.COLOR_TRANSFER_ST2084 || t == MediaFormat.COLOR_TRANSFER_HLG;
  }
  private void startMuxer(MediaFormat videoFormat) throws Exception {
    if (muxing) return;
    // Every track must be added before the muxer starts, so wait for the first encoded
    // audio (well under a second in). An audio track with no samples would make the
    // muxer fail when it stops, so audio that ends up empty is left out.
    while (audio != null && audio.sample(0) == null && !audio.finished) {
      if (listener.cancelled()) throw new CancelledException();
      Thread.sleep(2);
    }
    if (audio != null && audio.sample(0) == null) {
      // Audio the phone can't decode (AC-3, DTS…) shouldn't cost the whole video.
      if (audio.error != null && !(audio.error instanceof CancelledException))
        audioNote = "The audio couldn't be converted, so the video was saved without sound.";
      audio = null;
    }
    muxVideoTrack = muxer.addTrack(videoFormat);
    if (audio != null && audio.format != null && audioReader != null)
      muxAudioTrack = muxer.addTrack(audio.format);
    muxer.start();
    muxing = true;
  }
  // Audio samples are written in timestamp order between the video samples.
  // Samples the audio thread hasn't produced yet are written later; at the very end this
  // waits for the audio thread to finish.
  private void writeAudioUpTo(long ptsUs) throws Exception {
    if (audio == null || muxAudioTrack < 0) return;
    if (ptsUs == Long.MAX_VALUE && audioThread != null) audioThread.join();
    if (audio.error != null && !(audio.error instanceof CancelledException))
      throw new IOException(audio.error.getMessage(), audio.error);
    MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
    long[] s;
    while ((s = audio.sample(audioIndex)) != null) {
      if (s[2] > ptsUs) break;
      audioBuffer.clear();
      byte[] bytes = new byte[(int) s[1]];
      audioReader.seek(s[0]);
      audioReader.readFully(bytes);
      audioBuffer.put(bytes).flip();
      info.set(0, bytes.length, s[2], (int) s[3]);
      muxer.writeSampleData(muxAudioTrack, audioBuffer, info);
      audioIndex++;
    }
  }

  // ---- OpenGL ----------------------------------------------------------------------
  static final String VERTEX =
      "attribute vec2 aPos;\n"
      + "varying vec2 vUv;\n"
      + "void main() {\n"
      // vUv is in image coordinates: (0,0) is the top-left corner of the output.
      + "  vUv = vec2((aPos.x + 1.0) * 0.5, (1.0 - aPos.y) * 0.5);\n"
      + "  gl_Position = vec4(aPos, 0.0, 1.0);\n"
      + "}\n";
  // Maps an output pixel back to the decoded frame: crop in the rotated frame, undo the
  // user's rotation and flips, undo the file's rotation metadata, then the texture matrix.
  // Colors follow the preview's CSS filters in order: warmth, brightness, contrast,
  // saturation, each clamped like a CSS filter step.
  static final String FRAGMENT =
      "#extension GL_OES_EGL_image_external : require\n"
      + "precision highp float;\n"
      + "varying vec2 vUv;\n"
      + "uniform samplerExternalOES uTex;\n"
      + "uniform mat4 uSt;\n"
      + "uniform vec4 uCrop;\n"
      + "uniform int uRot, uSrcRot;\n"
      + "uniform vec2 uFlip, uTap;\n"
      + "uniform float uTaps;\n"
      + "uniform vec3 uWarm;\n"
      + "uniform float uBright, uContrast;\n"
      + "uniform mat3 uSat;\n"
      + "vec2 turn(vec2 p, int deg) {\n"
      + "  if (deg == 90) return vec2(p.y, 1.0 - p.x);\n"
      + "  if (deg == 180) return 1.0 - p;\n"
      + "  if (deg == 270) return vec2(1.0 - p.y, p.x);\n"
      + "  return p;\n"
      + "}\n"
      + "vec3 pick(vec2 uv) {\n"
      + "  vec2 f = turn(uCrop.xy + uv * uCrop.zw, uRot);\n"
      + "  f = mix(f, 1.0 - f, uFlip);\n"
      + "  vec2 c = turn(f, uSrcRot);\n"
      + "  return texture2D(uTex, (uSt * vec4(c.x, 1.0 - c.y, 0.0, 1.0)).xy).rgb;\n"
      + "}\n"
      // A downscale averages a grid of uTaps × uTaps bilinear samples spread over the
      // output pixel, so every source pixel under it counts.
      + "void main() {\n"
      + "  vec3 c = vec3(0.0);\n"
      + "  for (int i = 0; i < 4; i++) {\n"
      + "    if (float(i) >= uTaps) break;\n"
      + "    for (int j = 0; j < 4; j++) {\n"
      + "      if (float(j) >= uTaps) break;\n"
      + "      c += pick(vUv + (vec2(float(i), float(j)) + 0.5 - uTaps * 0.5) * uTap);\n"
      + "    }\n"
      + "  }\n"
      + "  c /= uTaps * uTaps;\n"
      + "  c = clamp(c * uWarm, 0.0, 1.0);\n"
      + "  c = clamp(c * uBright, 0.0, 1.0);\n"
      + "  c = clamp((c - 0.5) * uContrast + 0.5, 0.0, 1.0);\n"
      + "  c = clamp(uSat * c, 0.0, 1.0);\n"
      + "  gl_FragColor = vec4(c, 1.0);\n"
      + "}\n";
  // Overlays are premultiplied bitmaps cropped to their pixels, drawn with source-over over
  // their own rectangle (uRect: x, y, w, h as fractions of the output, from the top left).
  static final String OVERLAY_VERTEX =
      "attribute vec2 aPos;\n"
      + "uniform vec4 uRect;\n"
      + "varying vec2 vUv;\n"
      + "void main() {\n"
      + "  vUv = vec2((aPos.x + 1.0) * 0.5, (1.0 - aPos.y) * 0.5);\n"
      + "  vec2 p = uRect.xy + vUv * uRect.zw;\n"
      + "  gl_Position = vec4(p.x * 2.0 - 1.0, 1.0 - p.y * 2.0, 0.0, 1.0);\n"
      + "}\n";
  static final String OVERLAY =
      "precision mediump float;\n"
      + "varying vec2 vUv;\n"
      + "uniform sampler2D uTex;\n"
      + "void main() { gl_FragColor = texture2D(uTex, vUv); }\n";

  static final class Gl {
    static final int EGL_RECORDABLE_ANDROID = 0x3142;
    final EGLDisplay display;
    final EGLContext context;
    final EGLSurface surface;
    final Surface window;
    int program, overlayProgram, oesTexture;
    final FloatBuffer quad = ByteBuffer.allocateDirect(8 * 4).order(ByteOrder.nativeOrder())
        .asFloatBuffer().put(new float[] {-1, -1, 1, -1, -1, 1, 1, 1});
    VideoExporter job;

    Gl(Surface window) {
      this.window = window;
      display = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY);
      int[] version = new int[2];
      if (!EGL14.eglInitialize(display, version, 0, version, 1))
        throw new RuntimeException("EGL is unavailable");
      int[] attributes = {EGL14.EGL_RED_SIZE, 8, EGL14.EGL_GREEN_SIZE, 8, EGL14.EGL_BLUE_SIZE, 8,
          EGL14.EGL_RENDERABLE_TYPE, EGL14.EGL_OPENGL_ES2_BIT, EGL_RECORDABLE_ANDROID, 1,
          EGL14.EGL_NONE};
      EGLConfig[] configs = new EGLConfig[1];
      int[] count = new int[1];
      EGL14.eglChooseConfig(display, attributes, 0, configs, 0, 1, count, 0);
      if (count[0] == 0) throw new RuntimeException("No EGL config for video encoding");
      context = EGL14.eglCreateContext(display, configs[0], EGL14.EGL_NO_CONTEXT,
          new int[] {EGL14.EGL_CONTEXT_CLIENT_VERSION, 2, EGL14.EGL_NONE}, 0);
      surface = EGL14.eglCreateWindowSurface(display, configs[0], window,
          new int[] {EGL14.EGL_NONE}, 0);
    }
    void makeCurrent() {
      if (!EGL14.eglMakeCurrent(display, surface, surface, context))
        throw new RuntimeException("eglMakeCurrent failed");
    }
    void setup(VideoExporter job, int sourceRotation) {
      this.job = job;
      program = link(VERTEX, FRAGMENT);
      overlayProgram = link(OVERLAY_VERTEX, OVERLAY);
      int[] t = new int[1];
      GLES20.glGenTextures(1, t, 0);
      oesTexture = t[0];
      GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, oesTexture);
      GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR);
      GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR);
      GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE);
      GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE);
      for (Overlay o : job.overlays) {
        GLES20.glGenTextures(1, t, 0);
        o.texture = t[0];
        GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, o.texture);
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR);
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR);
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE);
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE);
        // The bitmap is kept: a retry with another profile uploads it again.
        GLUtils.texImage2D(GLES20.GL_TEXTURE_2D, 0, o.bitmap, 0);
      }
      GLES20.glUseProgram(program);
      GLES20.glUniform1i(loc("uTex"), 0);
      GLES20.glUniform4f(loc("uCrop"), job.crop[0], job.crop[1], job.crop[2], job.crop[3]);
      GLES20.glUniform1i(loc("uRot"), job.rotation);
      GLES20.glUniform1i(loc("uSrcRot"), sourceRotation);
      GLES20.glUniform2f(loc("uFlip"), job.flipH ? 1 : 0, job.flipV ? 1 : 0);
      GLES20.glUniform3f(loc("uWarm"), job.warmth[0], job.warmth[1], job.warmth[2]);
      GLES20.glUniform1f(loc("uBright"), job.brightness);
      GLES20.glUniform1f(loc("uContrast"), job.contrast);
      GLES20.glUniformMatrix3fv(loc("uSat"), 1, false, saturationMatrix(job.saturation), 0);
      GLES20.glUniform2f(loc("uTap"), 0, 0);
      GLES20.glUniform1f(loc("uTaps"), 1);
      GLES20.glViewport(0, 0, job.width, job.height);
    }
    // When the output is smaller than the source, average several samples per output
    // pixel so fine detail doesn't alias. Each bilinear sample already covers two source
    // pixels per axis, so a ratio of r needs about r / 2 samples per axis.
    void setDownscale(float ratioX, float ratioY) {
      GLES20.glUseProgram(program);
      float ratio = Math.max(ratioX, ratioY);
      if (ratio < 1.5f) return;
      int taps = Math.max(2, Math.min(4, (int) Math.ceil(ratio / 2)));
      GLES20.glUniform1f(loc("uTaps"), taps);
      GLES20.glUniform2f(loc("uTap"), 1f / job.width / taps, 1f / job.height / taps);
    }
    int loc(String name) {
      return GLES20.glGetUniformLocation(program, name);
    }
    // CSS saturate(), column-major for GLES.
    static float[] saturationMatrix(float s) {
      float[] m = {
          .213f + .787f * s, .715f - .715f * s, .072f - .072f * s,
          .213f - .213f * s, .715f + .285f * s, .072f - .072f * s,
          .213f - .213f * s, .715f - .715f * s, .072f + .928f * s};
      return new float[] {m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]};
    }
    // outUs is when this frame starts in output time and spanUs how long it stays.
    void draw(float[] st, long outUs, long spanUs) {
      GLES20.glDisable(GLES20.GL_BLEND);
      GLES20.glUseProgram(program);
      GLES20.glUniformMatrix4fv(loc("uSt"), 1, false, st, 0);
      GLES20.glActiveTexture(GLES20.GL_TEXTURE0);
      GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, oesTexture);
      drawQuad(program);
      GLES20.glEnable(GLES20.GL_BLEND);
      GLES20.glBlendFunc(GLES20.GL_ONE, GLES20.GL_ONE_MINUS_SRC_ALPHA);
      GLES20.glUseProgram(overlayProgram);
      GLES20.glUniform1i(GLES20.glGetUniformLocation(overlayProgram, "uTex"), 0);
      int rect = GLES20.glGetUniformLocation(overlayProgram, "uRect");
      for (Overlay o : job.overlays) {
        if (outUs + spanUs <= o.fromUs || outUs >= o.toUs) continue;
        GLES20.glUniform4f(rect, (float) o.x / job.width, (float) o.y / job.height,
            (float) o.w / job.width, (float) o.h / job.height);
        GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, o.texture);
        drawQuad(overlayProgram);
      }
    }
    void drawQuad(int p) {
      int a = GLES20.glGetAttribLocation(p, "aPos");
      quad.position(0);
      GLES20.glEnableVertexAttribArray(a);
      GLES20.glVertexAttribPointer(a, 2, GLES20.GL_FLOAT, false, 0, quad);
      GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4);
      GLES20.glDisableVertexAttribArray(a);
    }
    void present(long ptsNs) {
      EGLExt.eglPresentationTimeANDROID(display, surface, ptsNs);
      EGL14.eglSwapBuffers(display, surface);
    }
    static int link(String vertex, String fragment) {
      int p = GLES20.glCreateProgram();
      GLES20.glAttachShader(p, compile(GLES20.GL_VERTEX_SHADER, vertex));
      GLES20.glAttachShader(p, compile(GLES20.GL_FRAGMENT_SHADER, fragment));
      GLES20.glLinkProgram(p);
      int[] ok = new int[1];
      GLES20.glGetProgramiv(p, GLES20.GL_LINK_STATUS, ok, 0);
      if (ok[0] == 0) throw new RuntimeException("Shader link failed: " + GLES20.glGetProgramInfoLog(p));
      return p;
    }
    static int compile(int type, String source) {
      int s = GLES20.glCreateShader(type);
      GLES20.glShaderSource(s, source);
      GLES20.glCompileShader(s);
      int[] ok = new int[1];
      GLES20.glGetShaderiv(s, GLES20.GL_COMPILE_STATUS, ok, 0);
      if (ok[0] == 0) throw new RuntimeException("Shader compile failed: " + GLES20.glGetShaderInfoLog(s));
      return s;
    }
    void release() {
      EGL14.eglMakeCurrent(display, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_CONTEXT);
      EGL14.eglDestroySurface(display, surface);
      EGL14.eglDestroyContext(display, context);
      EGL14.eglReleaseThread();
      EGL14.eglTerminate(display);
      window.release();
    }
  }
}
