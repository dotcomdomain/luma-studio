package studio.luma;

import android.media.AudioFormat;
import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import java.io.Closeable;
import java.io.File;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

// Re-encodes the trimmed audio of a clip as AAC: decode → channel mix → volume →
// time-stretch (keeps pitch) → resample → encode. Encoded frames go to a temporary file;
// VideoExporter interleaves them with the video.
final class AudioPipeline {
  interface Cancel {
    boolean cancelled();
    void progress(double fraction);
  }
  // Volume (0..1) at an output time, for fades.
  interface Envelope {
    float gain(long outUs);
  }
  // Filled in by the audio thread while the video is being encoded. The video thread
  // reads finished samples through its own file handle.
  static final class Result implements Closeable {
    volatile MediaFormat format;
    volatile boolean finished;
    volatile Throwable error;
    // Each sample: offset in data, size, presentation time (µs), codec flags.
    final List<long[]> samples = new ArrayList<>();
    RandomAccessFile data;
    synchronized long[] sample(int i) { return i < samples.size() ? samples.get(i) : null; }
    synchronized void add(long[] s) { samples.add(s); }
    public void close() {
      try { if (data != null) data.close(); } catch (IOException ignored) {}
    }
  }
  // Codec calls don't wait; the loop sleeps briefly only when nothing moved.
  static final long TIMEOUT_US = 0;

  static void encode(Result result, File source, int track, long startUs, long durationUs,
      double speed, float volume, int wantChannels, int wantRate, int bitrate, File tmp,
      Envelope envelope, Cancel cancel) throws Exception {
    result.data = new RandomAccessFile(tmp, "rw");
    result.data.setLength(0);
    MediaExtractor extractor = new MediaExtractor();
    MediaCodec decoder = null, encoder = null;
    try {
      extractor.setDataSource(source.toString());
      extractor.selectTrack(track);
      extractor.seekTo(startUs, MediaExtractor.SEEK_TO_PREVIOUS_SYNC);
      MediaFormat inFormat = extractor.getTrackFormat(track);
      decoder = MediaCodec.createDecoderByType(inFormat.getString(MediaFormat.KEY_MIME));
      decoder.configure(inFormat, null, null, 0);
      decoder.start();

      MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
      int inRate = inFormat.getInteger(MediaFormat.KEY_SAMPLE_RATE),
          inChannels = inFormat.getInteger(MediaFormat.KEY_CHANNEL_COUNT);
      boolean floatPcm = false;
      int outRate = 0, outChannels = 0;
      long inputLimit = 0, outputLimit = 0, inputFrames = 0, outputFrames = 0, queuedFrames = 0;
      Stretch stretch = null;
      Resampler resampler = null;
      FloatList stage = new FloatList(), processed = new FloatList(), resampled = new FloatList();
      short[] pending = new short[0];
      int pendingPos = 0, pendingLen = 0;
      boolean extractorDone = false, decoderDone = false, pcmDone = false, encoderInputDone = false,
          encoderDone = false;
      long primingUs = 0, endUs = Long.MAX_VALUE;
      int idle = 0;
      long lastReport = 0;
      while (!encoderDone) {
        if (cancel.cancelled()) throw new VideoExporter.CancelledException();
        // After a few passes with nothing to do, wait inside a codec call instead: it
        // returns as soon as that codec has output, unlike a sleep.
        long waitUs = idle > 2 ? 2_000 : 0;
        idle++;
        if (inputLimit > 0 && inputFrames - lastReport > inputLimit / 50) {
          lastReport = inputFrames;
          cancel.progress((double) inputFrames / inputLimit);
        }
        if (!extractorDone) {
          int index = decoder.dequeueInputBuffer(TIMEOUT_US);
          if (index >= 0) {
            int size = extractor.readSampleData(decoder.getInputBuffer(index), 0);
            long time = extractor.getSampleTime();
            if (size < 0 || time > startUs + durationUs + 500_000) {
              decoder.queueInputBuffer(index, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM);
              extractorDone = true;
            } else {
              decoder.queueInputBuffer(index, 0, size, time, 0);
              extractor.advance();
            }
            idle = 0;
          }
        }
        if (!decoderDone) {
          int d = decoder.dequeueOutputBuffer(info, waitUs);
          if (d == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
            MediaFormat f = decoder.getOutputFormat();
            inRate = f.getInteger(MediaFormat.KEY_SAMPLE_RATE);
            inChannels = f.getInteger(MediaFormat.KEY_CHANNEL_COUNT);
            floatPcm = f.containsKey(MediaFormat.KEY_PCM_ENCODING) &&
                f.getInteger(MediaFormat.KEY_PCM_ENCODING) == AudioFormat.ENCODING_PCM_FLOAT;
          } else if (d >= 0) {
            idle = 0;
            if (encoder == null) {
              // The output format follows the decoded audio unless a format was chosen.
              outChannels = wantChannels > 0 ? wantChannels : Math.min(2, inChannels);
              outRate = wantRate > 0 ? wantRate : inRate;
              inputLimit = Math.round(durationUs * inRate / 1e6);
              outputLimit = Math.round(durationUs / speed * outRate / 1e6);
              if (Math.abs(speed - 1) > 1e-6) stretch = new Stretch(outChannels, inRate, speed);
              if (outRate != inRate) resampler = new Resampler(outChannels, inRate, outRate);
              MediaFormat outFormat = MediaFormat.createAudioFormat(
                  MediaFormat.MIMETYPE_AUDIO_AAC, outRate, outChannels);
              outFormat.setInteger(MediaFormat.KEY_AAC_PROFILE,
                  MediaCodecInfo.CodecProfileLevel.AACObjectLC);
              outFormat.setInteger(MediaFormat.KEY_BIT_RATE, bitrate);
              outFormat.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 1 << 16);
              encoder = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC);
              encoder.configure(outFormat, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
              encoder.start();
            }
            ByteBuffer pcm = decoder.getOutputBuffer(d).order(ByteOrder.nativeOrder());
            pcm.position(info.offset).limit(info.offset + info.size);
            int bytesPerFrame = inChannels * (floatPcm ? 4 : 2);
            int frames = info.size / bytesPerFrame;
            // Frames before the trim start are dropped; so is anything after its end.
            long first = Math.round((info.presentationTimeUs - startUs) * inRate / 1e6);
            int skip = (int) Math.max(0, Math.min(frames, -first));
            stage.clear();
            // A gap in the audio (it starts after the video, or the file skips) becomes
            // silence, so everything after it stays in sync with the picture. Timestamps a
            // few milliseconds off are normal rounding and left alone.
            long gap = first - inputFrames;
            if (gap > inRate / 50 && inputFrames < inputLimit) {
              int silence = (int) Math.min(gap, inputLimit - inputFrames);
              stage.zeros(silence, outChannels);
              inputFrames += silence;
            } else if (-gap > inRate / 50 && first >= 0) {
              // Overlapping timestamps: drop what was already played.
              skip = (int) Math.max(skip, Math.min(frames, -gap));
            }
            int take = (int) Math.max(0, Math.min(frames - skip, inputLimit - inputFrames));
            if (take > 0) {
              stage.reserve(take, outChannels);
              for (int f = skip; f < skip + take; f++) {
                int at = info.offset + f * bytesPerFrame;
                mix(pcm, at, floatPcm, inChannels, outChannels, volume, stage);
              }
              inputFrames += take;
            }
            if (stage.frames > 0) process(stage, stretch, resampler, processed, resampled);
            decoder.releaseOutputBuffer(d, false);
            if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0 ||
                (inputLimit > 0 && inputFrames >= inputLimit)) {
              decoderDone = true;
              if (encoder != null) {
                // Pad so the stretcher and resampler release their last frames.
                if (stretch != null) {
                  stage.clear();
                  stage.zeros(stretch.n + 2 * stretch.delta, outChannels);
                  process(stage, stretch, resampler, processed, resampled);
                }
              }
              pcmDone = true;
            }
          }
        }
        if (encoder == null) {
          if (decoderDone) break; // no audio decoded at all
          continue;
        }
        // Move finished PCM into the pending encoder input, capped at the clip's length.
        FloatList ready = resampler != null ? resampled : processed;
        if (ready.frames > 0) {
          int allowed = (int) Math.max(0, Math.min(ready.frames, outputLimit - outputFrames));
          int need = pendingLen - pendingPos + allowed * outChannels;
          if (pending.length < need) pending = Arrays.copyOf(pending, Math.max(need, pending.length * 2));
          if (pendingPos > 0) {
            System.arraycopy(pending, pendingPos, pending, 0, pendingLen - pendingPos);
            pendingLen -= pendingPos;
            pendingPos = 0;
          }
          for (int i = 0; i < allowed * outChannels; i++) {
            float v = ready.data[i];
            if (envelope != null) v *= envelope.gain((outputFrames + i / outChannels) * 1_000_000L / outRate);
            v = Math.max(-1f, Math.min(1f, v));
            pending[pendingLen++] = (short) Math.round(v * 32767f);
          }
          outputFrames += allowed;
          ready.clear();
        }
        if (!encoderInputDone && (pendingLen > pendingPos || pcmDone)) {
          int index = encoder.dequeueInputBuffer(TIMEOUT_US);
          if (index >= 0) {
            ByteBuffer in = encoder.getInputBuffer(index).order(ByteOrder.nativeOrder());
            in.clear();
            int samples = Math.min((pendingLen - pendingPos), in.remaining() / 2 / outChannels * outChannels);
            long pts = queuedFrames * 1_000_000L / outRate;
            if (samples > 0) {
              in.asShortBuffer().put(pending, pendingPos, samples);
              pendingPos += samples;
              queuedFrames += samples / outChannels;
              encoder.queueInputBuffer(index, 0, samples * 2, pts, 0);
              idle = 0;
            } else {
              encoder.queueInputBuffer(index, 0, 0, pts, MediaCodec.BUFFER_FLAG_END_OF_STREAM);
              encoderInputDone = true;
            }
          }
        }
        int e = encoder.dequeueOutputBuffer(info, decoderDone ? Math.max(waitUs, encoderInputDone ? 2_000 : 0) : 0);
        if (e == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
          result.format = encoder.getOutputFormat();
          // AAC encoders put silent priming samples first (2048 for this phone's encoder).
          // Without an edit list the player would play them, so their packets are dropped
          // and the rest moved earlier by the same amount.
          int delay = result.format.containsKey("encoder-delay") ?
              result.format.getInteger("encoder-delay") : 2048;
          primingUs = delay * 1_000_000L / outRate;
          endUs = outputLimit * 1_000_000L / outRate;
        } else if (e >= 0) {
          idle = 0;
          long pts = info.presentationTimeUs - primingUs;
          if ((info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0 && info.size > 0 &&
              pts >= 0 && pts < endUs) {
            ByteBuffer out = encoder.getOutputBuffer(e);
            byte[] bytes = new byte[info.size];
            out.position(info.offset);
            out.get(bytes);
            long offset = result.data.length();
            result.data.seek(offset);
            result.data.write(bytes);
            result.add(new long[] {offset, info.size, pts, info.flags});
          }
          encoder.releaseOutputBuffer(e, false);
          if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) encoderDone = true;
        }
      }
    } finally {
      if (decoder != null) try { decoder.stop(); } catch (Exception ignored) {} finally { decoder.release(); }
      if (encoder != null) try { encoder.stop(); } catch (Exception ignored) {} finally { encoder.release(); }
      extractor.release();
    }
    if (result.samples.isEmpty()) result.format = null;
  }

  // One input frame, converted to the output channel layout with volume applied.
  // Surround sources (decoders output FL FR FC LFE BL BR [SL SR]) fold the centre and
  // surround channels into left and right at -3 dB, the usual stereo downmix; LFE is left
  // out. The sum is scaled so a full-level centre channel doesn't clip.
  static final float MINUS_3DB = .7071f;
  static void mix(ByteBuffer pcm, int at, boolean floatPcm, int inCh, int outCh, float volume,
      FloatList out) {
    float l = sample(pcm, at, 0, floatPcm), r = inCh > 1 ? sample(pcm, at, 1, floatPcm) : l;
    if (inCh >= 3) {
      // Quad has no centre; 5.0 has no LFE.
      boolean centre = inCh != 4;
      int surround = inCh == 4 ? 2 : inCh == 5 ? 3 : 4;
      if (centre) {
        float c = sample(pcm, at, 2, floatPcm) * MINUS_3DB;
        l += c;
        r += c;
      }
      for (int ch = surround; ch + 1 < Math.min(inCh, 8); ch += 2) {
        l += sample(pcm, at, ch, floatPcm) * MINUS_3DB;
        r += sample(pcm, at, ch + 1, floatPcm) * MINUS_3DB;
      }
      l /= 1 + MINUS_3DB;
      r /= 1 + MINUS_3DB;
    }
    if (outCh == 1) {
      out.add1((l + r) * .5f * volume);
    } else {
      out.add2(l * volume, r * volume);
    }
  }
  static float sample(ByteBuffer pcm, int at, int channel, boolean floatPcm) {
    return floatPcm ? pcm.getFloat(at + channel * 4) : pcm.getShort(at + channel * 2) / 32768f;
  }
  static void process(FloatList in, Stretch stretch, Resampler resampler, FloatList processed,
      FloatList resampled) {
    FloatList stretched = in;
    if (stretch != null) {
      stretch.put(in);
      stretch.run(processed);
      stretched = processed;
    } else {
      processed.append(in);
      stretched = processed;
    }
    if (resampler != null) {
      resampler.process(stretched, resampled);
      stretched.clear();
    }
  }

  // Growable interleaved float buffer.
  static final class FloatList {
    float[] data = new float[4096];
    int size, frames;
    int channels = 1;
    void clear() { size = 0; frames = 0; }
    void reserve(int frames, int channels) {
      this.channels = channels;
      grow(size + frames * channels);
    }
    void grow(int n) { if (data.length < n) data = Arrays.copyOf(data, Math.max(n, data.length * 2)); }
    void add1(float a) { grow(size + 1); data[size++] = a; if (size % channels == 0) frames = size / channels; }
    void add2(float a, float b) { grow(size + 2); data[size++] = a; data[size++] = b; frames = size / channels; }
    void zeros(int n, int channels) {
      this.channels = channels;
      grow(size + n * channels);
      Arrays.fill(data, size, size + n * channels, 0);
      size += n * channels;
      frames = size / channels;
    }
    void append(FloatList other) {
      channels = other.channels;
      grow(size + other.size);
      System.arraycopy(other.data, 0, data, size, other.size);
      size += other.size;
      frames = size / channels;
    }
    void addFrames(float[] src, int offset, int count, int channels) {
      this.channels = channels;
      grow(size + count * channels);
      System.arraycopy(src, offset * channels, data, size, count * channels);
      size += count * channels;
      frames = size / channels;
    }
  }

  // WSOLA time-stretch: changes duration by 1/speed without changing pitch. Windows of
  // 30 ms overlap by half; each new window is taken from near its nominal input position,
  // at the offset whose waveform best continues the previous window.
  static final class Stretch {
    final int ch, n, hs, delta;
    final double speed;
    final float[] win, acc;
    float[] buf = new float[1 << 16];
    int len; // frames held in buf
    long base; // absolute index of buf's first frame
    double nominal;
    long prev = Long.MIN_VALUE;

    Stretch(int channels, int rate, double speed) {
      ch = channels;
      this.speed = speed;
      n = Math.max(64, (int) Math.round(rate * .03)) & ~1;
      hs = n / 2;
      delta = (int) Math.round(rate * .012);
      win = new float[n];
      for (int i = 0; i < n; i++) win[i] = (float) (.5 - .5 * Math.cos(2 * Math.PI * i / n));
      acc = new float[n * ch];
    }
    void put(FloatList in) {
      int need = (len + in.frames) * ch;
      if (buf.length < need) buf = Arrays.copyOf(buf, Math.max(need, buf.length * 2));
      System.arraycopy(in.data, 0, buf, len * ch, in.frames * ch);
      len += in.frames;
    }
    float mono(int frame) {
      float s = 0;
      for (int c = 0; c < ch; c++) s += buf[frame * ch + c];
      return s;
    }
    void run(FloatList out) {
      while (true) {
        long p = Math.round(nominal);
        long lo = Math.max(base, p - delta), hi = p + delta;
        long target = prev == Long.MIN_VALUE ? p : prev + hs;
        if (Math.max(hi, target) + n > base + len) return;
        long best = p;
        if (prev != Long.MIN_VALUE) {
          int to = (int) (target - base);
          double bestScore = Double.NEGATIVE_INFINITY;
          for (long c = lo; c <= hi; c += 2) {
            int co = (int) (c - base);
            double dot = 0, energy = 1e-9;
            for (int i = 0; i < n; i += 4) {
              float a = mono(co + i);
              dot += a * mono(to + i);
              energy += a * a;
            }
            double score = dot / Math.sqrt(energy);
            if (score > bestScore) { bestScore = score; best = c; }
          }
        }
        int bo = (int) (best - base);
        // The first window starts at full level instead of fading in from silence.
        boolean first = prev == Long.MIN_VALUE;
        for (int i = 0; i < n; i++) {
          float w = first && i < hs ? 1 : win[i];
          for (int c = 0; c < ch; c++) acc[i * ch + c] += w * buf[(bo + i) * ch + c];
        }
        out.addFrames(acc, 0, hs, ch);
        System.arraycopy(acc, hs * ch, acc, 0, (n - hs) * ch);
        Arrays.fill(acc, (n - hs) * ch, n * ch, 0);
        prev = best;
        nominal += hs * speed;
        // Drop input no later window can reach.
        long keep = Math.min(prev, Math.round(nominal) - delta);
        int drop = (int) Math.max(0, keep - base);
        if (drop > 0) {
          System.arraycopy(buf, drop * ch, buf, 0, (len - drop) * ch);
          len -= drop;
          base += drop;
        }
      }
    }
  }

  // Streaming linear-interpolation resampler.
  static final class Resampler {
    final int ch;
    final double step;
    double pos;
    float[] last;

    Resampler(int channels, int from, int to) {
      ch = channels;
      step = (double) from / to;
    }
    void process(FloatList in, FloatList out) {
      int frames = in.frames + (last != null ? 1 : 0);
      if (frames < 2) {
        if (in.frames > 0) last = Arrays.copyOfRange(in.data, (in.frames - 1) * ch, in.frames * ch);
        return;
      }
      out.channels = ch;
      while (pos < frames - 1) {
        int i = (int) pos;
        float t = (float) (pos - i);
        for (int c = 0; c < ch; c++) {
          float a = frame(in, i, c), b = frame(in, i + 1, c);
          out.add1(a + (b - a) * t);
        }
        pos += step;
      }
      pos -= frames - 1;
      last = Arrays.copyOfRange(in.data, (in.frames - 1) * ch, in.frames * ch);
    }
    float frame(FloatList in, int i, int c) {
      if (last != null) return i == 0 ? last[c] : in.data[(i - 1) * ch + c];
      return in.data[i * ch + c];
    }
  }
}
