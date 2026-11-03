package studio.luma;

import java.io.File;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.ByteBuffer;

// MediaMuxer writes the index (moov) after the media data (mdat). Players that stream a
// file need the index first, so this rewrites the file as ftyp, moov, mdat, adding the
// size of moov to every chunk offset in its stco/co64 tables.
final class Mp4FastStart {
  // Returns false (and leaves `out` untouched) if the file is already in order or its
  // layout isn't one this handles.
  static boolean process(File in, File out) throws IOException {
    try (RandomAccessFile file = new RandomAccessFile(in, "r")) {
      long length = file.length(), pos = 0, moovPos = -1, moovSize = 0, mdatPos = -1;
      while (pos + 8 <= length) {
        file.seek(pos);
        long size = file.readInt() & 0xffffffffL;
        int type = file.readInt();
        if (size == 1) size = file.readLong();
        else if (size == 0) size = length - pos;
        if (size < 8) return false;
        if (type == fourcc("moov")) { moovPos = pos; moovSize = size; }
        if (type == fourcc("mdat") && mdatPos < 0) mdatPos = pos;
        pos += size;
      }
      if (moovPos < 0 || mdatPos < 0 || moovPos < mdatPos || moovSize > Integer.MAX_VALUE) return false;
      byte[] moov = new byte[(int) moovSize];
      file.seek(moovPos);
      file.readFully(moov);
      if (!shiftOffsets(ByteBuffer.wrap(moov), 8, moov.length, moovSize)) return false;
      try (RandomAccessFile o = new RandomAccessFile(out, "rw")) {
        o.setLength(0);
        copy(file, o, 0, mdatPos);              // ftyp and anything else before the data
        o.write(moov);
        copy(file, o, mdatPos, moovPos - mdatPos); // the data
        copy(file, o, moovPos + moovSize, length - moovPos - moovSize);
      }
      return true;
    }
  }
  static int fourcc(String s) {
    return (s.charAt(0) << 24) | (s.charAt(1) << 16) | (s.charAt(2) << 8) | s.charAt(3);
  }
  // Walks moov's container boxes and adds `shift` to each chunk offset.
  static boolean shiftOffsets(ByteBuffer b, int start, int end, long shift) {
    int pos = start;
    while (pos + 8 <= end) {
      long size = b.getInt(pos) & 0xffffffffL;
      int type = b.getInt(pos + 4);
      if (size < 8 || pos + size > end) return false;
      if (type == fourcc("trak") || type == fourcc("mdia") || type == fourcc("minf") ||
          type == fourcc("stbl")) {
        if (!shiftOffsets(b, pos + 8, (int) (pos + size), shift)) return false;
      } else if (type == fourcc("stco")) {
        int count = b.getInt(pos + 12);
        for (int i = 0; i < count; i++) {
          int at = pos + 16 + i * 4;
          long v = (b.getInt(at) & 0xffffffffL) + shift;
          if (v > 0xffffffffL) return false; // would need co64; leave the file as it is
          b.putInt(at, (int) v);
        }
      } else if (type == fourcc("co64")) {
        int count = b.getInt(pos + 12);
        for (int i = 0; i < count; i++) {
          int at = pos + 16 + i * 8;
          b.putLong(at, b.getLong(at) + shift);
        }
      }
      pos += size;
    }
    return true;
  }
  static void copy(RandomAccessFile from, RandomAccessFile to, long offset, long count)
      throws IOException {
    byte[] buf = new byte[1 << 20];
    from.seek(offset);
    while (count > 0) {
      int n = from.read(buf, 0, (int) Math.min(buf.length, count));
      if (n < 0) throw new IOException("Unexpected end of file");
      to.write(buf, 0, n);
      count -= n;
    }
  }
}
