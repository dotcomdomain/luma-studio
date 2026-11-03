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
  // A compressed frame bigger than the hardware decoder's input buffers.
  static final class SampleTooLargeException extends Exception {
    final long size;
    SampleTooLargeException(long size) { this.size = size; }
  }

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
  // Straighten: degrees clockwise, the zoom that keeps the corners filled, and the
  // width/height of the 90°-rotated frame.
  float straighten = 0, straightenScale = 1, frameAspect = 1;
  // Shadows/highlights: the preview's 33-point SVG table (feComponentTransfer), or null.
  float[] tone;
  long fadeInUs, fadeOutUs; // in output time
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
                channels, sampleRate, audioBitrate, audioData, VideoExporter.this::fadeGain, new AudioPipeline.Cancel() {
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
        try {
          encodeVideo(videoTrack, videoFormat, sourceRotation, sourceFps, audio, true);
        } catch (SampleTooLargeException e) {
          // Very detailed frames (huge keyframes) don't fit the hardware decoder's input
          // buffers, and it can't be given bigger ones. Android's software decoder can.
          if (muxing) throw new IOException("A frame in this video is too large for the phone's decoder.");
          softwareDecoder = true;
          // Room for frames somewhat larger than the one that didn't fit.
          decoderInputSize = (int) Math.min(256L << 20, Math.max(16L << 20, e.size * 3 / 2));
          output.delete();
          muxer = null;
          muxVideoTrack = muxAudioTrack = -1;
          audioIndex = 0;
          encodeVideo(videoTrack, videoFormat, sourceRotation, sourceFps, audio, true);
        }
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
  private boolean softwareDecoder;
  private int decoderInputSize;
  // 0: SDR. 1: PQ, 2: HLG; the decoder didn't tone-map, so the shader does.
  private int hdrMode;
  static String softwareDecoderFor(String mime) throws IOException {
    for (MediaCodecInfo info : new MediaCodecList(MediaCodecList.REGULAR_CODECS).getCodecInfos()) {
      if (info.isEncoder() || !info.isSoftwareOnly()) continue;
      for (String type : info.getSupportedTypes())
        if (type.equalsIgnoreCase(mime)) return info.getName();
    }
    throw new IOException("A frame in this video is too large for the phone's decoder.");
  }
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
      String sourceMime = sourceFormat.getString(MediaFormat.KEY_MIME);
      decoder = softwareDecoder ? MediaCodec.createByCodecName(softwareDecoderFor(sourceMime)) :
          MediaCodec.createDecoderByType(sourceMime);
      // The decoder would rotate the picture itself (through the texture matrix); the shader
      // already does, so the decoder is told there's nothing to rotate. A copy keeps the
      // source format intact for a retry.
      MediaFormat inFormat = new MediaFormat(sourceFormat);
      inFormat.setInteger(MediaFormat.KEY_ROTATION, 0);
      if (softwareDecoder) inFormat.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, decoderInputSize);
      boolean hdr = isHdr(sourceFormat);
      hdrMode = 0;
      // HDR (PQ/HLG) frames would be read as SDR and look flat; ask the decoder to tone-map.
      if (hdr && Build.VERSION.SDK_INT >= 33)
        inFormat.setInteger(MediaFormat.KEY_COLOR_TRANSFER_REQUEST, MediaFormat.COLOR_TRANSFER_SDR_VIDEO);
      decoder.configure(inFormat, decoderSurface, null, 0);
      decoder.start();
      // Until the decoder's output format shows it tone-mapped the frames to SDR, the
      // shader converts them (PQ or HLG, BT.2020) to standard video itself.
      colorNote = null;
      if (hdr) gl.setHdr(hdrMode = transfer(sourceFormat) == MediaFormat.COLOR_TRANSFER_HLG ? 2 : 1);
      applyColor(gl, sourceFormat);

      muxer = new MediaMuxer(output.toString(), MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4);
      MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
      long endUs = startUs + durationUs, outputEndUs = Math.round(durationUs / speed);
      frameStepUs = gridFps > 0 ? 1e6 / gridFps : 0;
      lastSlot = -1;
      lastOutUs = -1;
      boolean inputDone = false, decoderDone = false, encoderDone = false;
      // Each decoded frame waits in the texture until the next one arrives: only then is it
      // known how long it stays on screen, and so which output time (or grid slot) it
      // fills. heldPts is its source time, or MIN_VALUE when the texture holds nothing.
      long heldPts = Long.MIN_VALUE;
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
            if (extractor.getSampleSize() > buffer.capacity())
              throw new SampleTooLargeException(extractor.getSampleSize());
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
          if (d == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
            // The decoder knows the colors from the bitstream itself (the container may not).
            MediaFormat f = decoder.getOutputFormat();
            if (hdrMode != 0 && f.containsKey(MediaFormat.KEY_COLOR_TRANSFER) && !isHdr(f)) gl.setHdr(hdrMode = 0);
            applyColor(gl, f);
          }
          if (d < 0) continue;
          progress = true;
          boolean end = (info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0;
          long pts = info.presentationTimeUs;
          boolean finished = end || (info.size > 0 && pts >= endUs);
          // The held frame is on screen until this one (or the end of the trim).
          if (heldPts != Long.MIN_VALUE && (info.size > 0 || end)) {
            emit(gl, st, heldPts, info.size > 0 ? Math.min(pts, endUs) : endUs);
            heldPts = Long.MIN_VALUE;
          }
          boolean keep = info.size > 0 && pts < endUs;
          decoder.releaseOutputBuffer(d, keep);
          if (keep) {
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
            heldPts = pts;
          }
          if (finished) {
            // The last frame stays on screen until the end of the trim.
            if (heldPts != Long.MIN_VALUE) emit(gl, st, heldPts, endUs);
            heldPts = Long.MIN_VALUE;
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
  // How much of the picture (and sound) shows at an output time: ramps from black at the
  // start and to black at the end. The preview uses the same formula (app.js fadeGain).
  float fadeGain(long outUs) {
    double end = durationUs / speed, g = 1;
    if (fadeInUs > 0) g = Math.min(g, outUs / (double) fadeInUs);
    if (fadeOutUs > 0) g = Math.min(g, (end - outUs) / fadeOutUs);
    return (float) Math.max(0, Math.min(1, g));
  }
  private double frameStepUs;
  private long lastSlot, lastOutUs;
  // Writes the frame in the texture, which is on screen from source time a to b, the way the
  // preview would show it. Without a fixed rate it keeps its own time (a frame from before
  // the trim start that is still showing there becomes the first frame). With a fixed rate,
  // each grid slot shows the frame that is on screen at the slot's time; a frame no slot
  // falls on is dropped. Drawing layers show if their interval covers that time (or, for a
  // frame at its own time, overlaps its time on screen).
  private void emit(Gl gl, float[] st, long a, long b) {
    long lo = Math.max(a, startUs), hi = Math.min(b, startUs + durationUs);
    if (hi <= lo) return;
    long outUs, spanUs;
    if (frameStepUs > 0) {
      double step = frameStepUs * speed; // one slot, in source time
      long slot = Math.max(lastSlot + 1, (long) Math.ceil((lo - startUs) / step - 1e-6));
      if (startUs + slot * step >= hi) return;
      lastSlot = slot;
      outUs = Math.round(slot * frameStepUs);
      spanUs = 1;
    } else {
      outUs = Math.round((lo - startUs) / speed);
      if (outUs <= lastOutUs) return;
      spanUs = Math.max(1, Math.round((hi - lo) / speed));
    }
    lastOutUs = outUs;
    gl.draw(st, outUs, spanUs);
    gl.present(outUs * 1000);
  }
  // Picks the frame shader for the source's colors: raw YUV for full range, BT.2020 or
  // HDR (when the decoder didn't tone-map), the GPU's own conversion otherwise.
  private void applyColor(Gl gl, MediaFormat f) {
    int standard = f.containsKey(MediaFormat.KEY_COLOR_STANDARD) ? f.getInteger(MediaFormat.KEY_COLOR_STANDARD) : 0;
    boolean full = f.containsKey(MediaFormat.KEY_COLOR_RANGE) &&
        f.getInteger(MediaFormat.KEY_COLOR_RANGE) == MediaFormat.COLOR_RANGE_FULL;
    if (!f.containsKey(MediaFormat.KEY_COLOR_STANDARD) && !f.containsKey(MediaFormat.KEY_COLOR_RANGE) && gl.yuv) return;
    boolean want = full || Gl.matrixOf(standard) == 2020 || hdrMode != 0;
    if (want) {
      if (!gl.setYuv(standard, full) && gl.yuv) gl.buildProgram(false);
    } else if (gl.yuv) gl.buildProgram(false);
  }
  static int transfer(MediaFormat f) {
    return f.containsKey(MediaFormat.KEY_COLOR_TRANSFER) ? f.getInteger(MediaFormat.KEY_COLOR_TRANSFER) : 0;
  }
  static boolean isHdr(MediaFormat f) {
    int t = transfer(f);
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
  static final String VERTEX3 =
      "#version 300 es\n"
      + "in vec2 aPos;\n"
      + "out vec2 vUv;\n"
      + "void main() {\n"
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
      + "uniform vec4 uStraight;\n"
      + "uniform sampler2D uTone;\n"
      + "uniform float uToneOn;\n"
      + "uniform int uHdr;\n"
      + "uniform float uBright, uContrast;\n"
      + "uniform mat3 uSat;\n"
      + "vec2 turn(vec2 p, int deg) {\n"
      + "  if (deg == 90) return vec2(p.y, 1.0 - p.x);\n"
      + "  if (deg == 180) return 1.0 - p;\n"
      + "  if (deg == 270) return vec2(1.0 - p.y, p.x);\n"
      + "  return p;\n"
      + "}\n"
      // Straighten rotates the picture inside the frame (about its centre) and zooms it by
      // the amount that keeps the corners covered: uStraight = cos, -sin, 1 / zoom, aspect.
      + "vec3 pick(vec2 uv) {\n"
      + "  vec2 f = uCrop.xy + uv * uCrop.zw;\n"
      + "  if (uStraight.y != 0.0) {\n"
      + "    vec2 p = (f - 0.5) * vec2(uStraight.w, 1.0);\n"
      + "    p = vec2(p.x * uStraight.x - p.y * uStraight.y, p.x * uStraight.y + p.y * uStraight.x) * uStraight.z;\n"
      + "    f = p / vec2(uStraight.w, 1.0) + 0.5;\n"
      + "  }\n"
      + "  f = turn(f, uRot);\n"
      + "  f = mix(f, 1.0 - f, uFlip);\n"
      + "  vec2 c = turn(f, uSrcRot);\n"
      + "  return texture2D(uTex, (uSt * vec4(c.x, 1.0 - c.y, 0.0, 1.0)).xy).rgb;\n"
      + "}\n"
      // HDR to SDR for decoders that can't: PQ or HLG signal (BT.2020) to light, 203 nits
      // as SDR white (BT.2408), highlights rolled off, BT.2020 to BT.709 primaries, sRGB.
      + "vec3 toSdr(vec3 e) {\n"
      + "  vec3 l;\n"
      + "  if (uHdr == 1) {\n"
      + "    vec3 p = pow(max(e, 0.0), vec3(1.0 / 78.84375));\n"
      + "    l = pow(max(p - 0.8359375, 0.0) / (18.8515625 - 18.6875 * p), vec3(6.277394636)) * (10000.0 / 203.0);\n"
      + "  } else {\n"
      + "    vec3 s = mix(e * e / 3.0, (exp((e - 0.55991073) / 0.17883277) + 0.28466892) / 12.0, step(0.5, e));\n"
      + "    float y = max(dot(s, vec3(0.2627, 0.678, 0.0593)), 1e-6);\n"
      + "    l = s * pow(y, 0.2) * (1000.0 / 203.0);\n"
      + "  }\n"
      + "  l = mat3(1.6605, -0.1246, -0.0182, -0.5876, 1.1329, -0.1006, -0.0728, -0.0083, 1.1187) * l;\n"
      + "  l = max(l, 0.0);\n"
      + "  float m = max(max(l.r, l.g), l.b);\n"
      + "  if (m > 0.75) l *= (0.75 + 0.25 * (1.0 - exp(-(m - 0.75) / 0.25 * 1.0)) ) / m;\n"
      + "  return mix(l * 12.92, 1.055 * pow(l, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, l));\n"
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
      + "  if (uHdr > 0) c = toSdr(c);\n"
      + "  c = clamp(c * uWarm, 0.0, 1.0);\n"
      // Shadows/highlights: the same curve as the preview's table, as a 256-entry LUT.
      + "  if (uToneOn > 0.5) c = vec3(texture2D(uTone, vec2(c.r * 0.99609375 + 0.001953125, 0.5)).r,\n"
      + "      texture2D(uTone, vec2(c.g * 0.99609375 + 0.001953125, 0.5)).r,\n"
      + "      texture2D(uTone, vec2(c.b * 0.99609375 + 0.001953125, 0.5)).r);\n"
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
  // Fades: black over everything, premultiplied.
  static final String SOLID =
      "precision mediump float;\n"
      + "uniform vec4 uColor;\n"
      + "void main() { gl_FragColor = uColor; }\n";

  static final class Gl {
    static final int EGL_RECORDABLE_ANDROID = 0x3142, EGL_OPENGL_ES3_BIT = 0x40;
    boolean es3, yuvSupported;
    final EGLDisplay display;
    final EGLContext context;
    final EGLSurface surface;
    final Surface window;
    int program, overlayProgram, solidProgram, oesTexture, toneTexture;
    final FloatBuffer quad = ByteBuffer.allocateDirect(8 * 4).order(ByteOrder.nativeOrder())
        .asFloatBuffer().put(new float[] {-1, -1, 1, -1, -1, 1, 1, 1});
    VideoExporter job;

    Gl(Surface window) {
      this.window = window;
      display = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY);
      int[] version = new int[2];
      if (!EGL14.eglInitialize(display, version, 0, version, 1))
        throw new RuntimeException("EGL is unavailable");
      // OpenGL ES 3 where available: its GL_EXT_YUV_target lets the shader read the
      // decoded frame's YUV values and convert them itself (see setYuv).
      EGLConfig[] configs = new EGLConfig[1];
      int[] count = new int[1];
      EGLContext made = EGL14.EGL_NO_CONTEXT;
      for (int es : new int[] {3, 2}) {
        int[] attributes = {EGL14.EGL_RED_SIZE, 8, EGL14.EGL_GREEN_SIZE, 8, EGL14.EGL_BLUE_SIZE, 8,
            EGL14.EGL_RENDERABLE_TYPE, es == 3 ? EGL_OPENGL_ES3_BIT : EGL14.EGL_OPENGL_ES2_BIT,
            EGL_RECORDABLE_ANDROID, 1, EGL14.EGL_NONE};
        if (!EGL14.eglChooseConfig(display, attributes, 0, configs, 0, 1, count, 0) || count[0] == 0) continue;
        made = EGL14.eglCreateContext(display, configs[0], EGL14.EGL_NO_CONTEXT,
            new int[] {EGL14.EGL_CONTEXT_CLIENT_VERSION, es, EGL14.EGL_NONE}, 0);
        if (made != EGL14.EGL_NO_CONTEXT) { es3 = es == 3; break; }
      }
      if (made == EGL14.EGL_NO_CONTEXT) throw new RuntimeException("No EGL config for video encoding");
      context = made;
      surface = EGL14.eglCreateWindowSurface(display, configs[0], window,
          new int[] {EGL14.EGL_NONE}, 0);
    }
    void makeCurrent() {
      if (!EGL14.eglMakeCurrent(display, surface, surface, context))
        throw new RuntimeException("eglMakeCurrent failed");
    }
    void setup(VideoExporter job, int sourceRotation) {
      this.job = job;
      this.sourceRotation = sourceRotation;
      yuvSupported = es3 && GLES20.glGetString(GLES20.GL_EXTENSIONS).contains("GL_EXT_YUV_target");
      overlayProgram = link(OVERLAY_VERTEX, OVERLAY);
      solidProgram = link(VERTEX, SOLID);
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
      if (job.tone != null) {
        // The SVG table is piecewise linear between its 33 points; sampled at 256 levels
        // and read back with linear filtering it is the same curve.
        ByteBuffer lut = ByteBuffer.allocateDirect(256);
        int n = job.tone.length - 1;
        for (int i = 0; i < 256; i++) {
          double x = i / 255.0 * n;
          int k = Math.min((int) x, n - 1);
          double v = job.tone[k] + (x - k) * (job.tone[k + 1] - job.tone[k]);
          lut.put((byte) Math.round(Math.max(0, Math.min(1, v)) * 255));
        }
        lut.position(0);
        GLES20.glGenTextures(1, t, 0);
        toneTexture = t[0];
        GLES20.glActiveTexture(GLES20.GL_TEXTURE1);
        GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, toneTexture);
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR);
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR);
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE);
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE);
        GLES20.glPixelStorei(GLES20.GL_UNPACK_ALIGNMENT, 1);
        GLES20.glTexImage2D(GLES20.GL_TEXTURE_2D, 0, GLES20.GL_LUMINANCE, 256, 1, 0,
            GLES20.GL_LUMINANCE, GLES20.GL_UNSIGNED_BYTE, lut);
        GLES20.glActiveTexture(GLES20.GL_TEXTURE0);
      }
      GLES20.glViewport(0, 0, job.width, job.height);
      buildProgram(false);
    }
    // The frame shader, reading either RGB (converted by the GPU) or raw YUV.
    int sourceRotation, hdr, taps = 1;
    float tapX, tapY;
    boolean yuv;
    final float[] yuvMatrix = new float[9], yuvOffset = new float[3];
    void buildProgram(boolean yuv) {
      if (program != 0) GLES20.glDeleteProgram(program);
      this.yuv = yuv;
      program = link(yuv ? VERTEX3 : VERTEX, fragment(yuv));
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
      GLES20.glUniform2f(loc("uTap"), tapX, tapY);
      GLES20.glUniform1f(loc("uTaps"), taps);
      if (yuv) {
        GLES20.glUniformMatrix3fv(loc("uYuv"), 1, false, yuvMatrix, 0);
        GLES20.glUniform3f(loc("uYuvOff"), yuvOffset[0], yuvOffset[1], yuvOffset[2]);
      }
      double a = Math.toRadians(job.straighten);
      GLES20.glUniform4f(loc("uStraight"), (float) Math.cos(a), (float) -Math.sin(a),
          1f / Math.max(1f, job.straightenScale), job.frameAspect);
      GLES20.glUniform1i(loc("uHdr"), hdr);
      GLES20.glUniform1f(loc("uToneOn"), job.tone != null ? 1 : 0);
      // Always on its own unit: two sampler types on one unit (the video's is unit 0) is
      // an error that makes every draw fail, even when the curve isn't used.
      GLES20.glUniform1i(loc("uTone"), 1);
    }
    void setHdr(int mode) {
      hdr = mode;
      GLES20.glUseProgram(program);
      GLES20.glUniform1i(loc("uHdr"), mode);
    }
    // Some GPU drivers (this phone's Mali) convert full-range video as if it were limited
    // range, crushing blacks and clipping whites. For full-range, BT.2020 and HDR sources
    // the shader reads the YUV values instead and applies the file's own matrix and range.
    // Returns false where the GPU can't read YUV.
    boolean setYuv(int standard, boolean full) {
      if (!yuvSupported) return false;
      int matrix = matrixOf(standard);
      double kr = .2126, kb = .0722; // BT.709, also for untagged limited-range video
      if (matrix == 601 || (matrix == 0 && full)) { kr = .299; kb = .114; } // untagged full range: JPEG's
      else if (matrix == 2020) { kr = .2627; kb = .0593; }
      else if (matrix == 240) { kr = .212; kb = .087; }
      double kg = 1 - kr - kb, sy = full ? 1 : 255 / 219.0, sc = full ? 1 : 255 / 224.0;
      float[] m = {
          (float) sy, (float) sy, (float) sy,
          0, (float) (-sc * 2 * (1 - kb) * kb / kg), (float) (sc * 2 * (1 - kb)),
          (float) (sc * 2 * (1 - kr)), (float) (-sc * 2 * (1 - kr) * kr / kg), 0};
      System.arraycopy(m, 0, yuvMatrix, 0, 9);
      yuvOffset[0] = full ? 0 : 16 / 255f;
      yuvOffset[1] = yuvOffset[2] = 128 / 255f;
      buildProgram(true);
      return true;
    }
    // When the output is smaller than the source, average several samples per output
    // pixel so fine detail doesn't alias. Each bilinear sample already covers two source
    // pixels per axis, so a ratio of r needs about r / 2 samples per axis.
    void setDownscale(float ratioX, float ratioY) {
      GLES20.glUseProgram(program);
      float ratio = Math.max(ratioX, ratioY);
      if (ratio < 1.5f) return;
      taps = Math.max(2, Math.min(4, (int) Math.ceil(ratio / 2)));
      tapX = 1f / job.width / taps;
      tapY = 1f / job.height / taps;
      GLES20.glUniform1f(loc("uTaps"), taps);
      GLES20.glUniform2f(loc("uTap"), tapX, tapY);
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
      float shown = job.fadeGain(outUs);
      if (shown < 1) {
        GLES20.glUseProgram(solidProgram);
        GLES20.glUniform4f(GLES20.glGetUniformLocation(solidProgram, "uColor"), 0, 0, 0, 1 - shown);
        drawQuad(solidProgram);
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
    // The YUV matrix behind a MediaFormat color standard: 601, 709, 2020, 240 or 0 if not
    // known. Combinations without a name of their own (the primaries of one standard with
    // the matrix of another, common in re-encoded files) come as 64 + primaries + 7 × matrix.
    static int matrixOf(int standard) {
      switch (standard) {
        case 1: return 709;
        case 2: case 3: case 4: case 5: case 8: return 601;
        case 6: case 7: return 2020;
        default:
          if (standard < 64) return 0;
          switch ((standard - 64) / 7) {
            case 1: return 709;
            case 2: case 3: return 601;
            case 4: return 240;
            case 5: case 6: return 2020;
            default: return 0;
          }
      }
    }
    static String fragment(boolean yuv) {
      String head = yuv ?
          "#version 300 es\n#extension GL_EXT_YUV_target : require\nprecision highp float;\n"
          + "in vec2 vUv;\nout vec4 fragColor;\nuniform __samplerExternal2DY2YEXT uTex;\n"
          + "uniform mat3 uYuv;\nuniform vec3 uYuvOff;\n#define TEX texture\n#define FRAG fragColor\n"
          + "vec3 frameColor(vec2 p) { return uYuv * (texture(uTex, p).xyz - uYuvOff); }\n" :
          "#extension GL_OES_EGL_image_external : require\nprecision highp float;\n"
          + "varying vec2 vUv;\nuniform samplerExternalOES uTex;\n#define TEX texture2D\n#define FRAG gl_FragColor\n"
          + "vec3 frameColor(vec2 p) { return texture2D(uTex, p).rgb; }\n";
      return head + FRAGMENT.substring(FRAGMENT.indexOf("uniform mat4 uSt;"))
          .replace("texture2D(uTex, (uSt * vec4(c.x, 1.0 - c.y, 0.0, 1.0)).xy).rgb",
              "frameColor((uSt * vec4(c.x, 1.0 - c.y, 0.0, 1.0)).xy)")
          .replace("texture2D(", "TEX(").replace("gl_FragColor", "FRAG");
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
