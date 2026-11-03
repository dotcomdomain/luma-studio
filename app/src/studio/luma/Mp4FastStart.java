package studio.luma;

import java.io.File;
import java.io.IOException;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.nio.ByteBuffer;

// MediaMuxer writes the index (moov) after the media data (mdat). Players that stream a
// file need the index first, so this writes the file out as ftyp, moov, mdat, adding the
// size of moov to every chunk offset in its stco/co64 tables. The reordered file goes
// straight to the destination stream; no second copy is made on disk.
final class Mp4FastStart {
  static final class Plan {
    long length, moovPos, mdatPos;
    byte[] moov; // with its chunk offsets already shifted
  }
  // Returns null if the file is already in order or its layout isn't one this handles;
  // the caller then copies the file as it is.
  static Plan plan(File in) throws IOException {
    try (RandomAccessFile file = new RandomAccessFile(in, "r")) {
      long length = file.length(), pos = 0, moovPos = -1, moovSize = 0, mdatPos = -1;
      while (pos + 8 <= length) {
        file.seek(pos);
        long size = file.readInt() & 0xffffffffL;
        int type = file.readInt();
        if (size == 1) size = file.readLong();
        else if (size == 0) size = length - pos;
        if (size < 8 || pos + size > length) return null;
        if (type == fourcc("moov")) { moovPos = pos; moovSize = size; }
        if (type == fourcc("mdat") && mdatPos < 0) mdatPos = pos;
        pos += size;
      }
      if (moovPos < 0 || mdatPos < 0 || moovPos < mdatPos || moovSize > 64 << 20) return null;
      byte[] moov = new byte[(int) moovSize];
      file.seek(moovPos);
      file.readFully(moov);
      if (!shiftOffsets(ByteBuffer.wrap(moov), 8, moov.length, moovSize)) return null;
      Plan p = new Plan();
      p.length = length;
      p.moovPos = moovPos;
      p.mdatPos = mdatPos;
      p.moov = moov;
      return p;
    }
  }
  static void write(File in, Plan p, OutputStream out) throws IOException {
    try (RandomAccessFile file = new RandomAccessFile(in, "r")) {
      copy(file, out, 0, p.mdatPos);                 // ftyp and anything else before the data
      out.write(p.moov);
      copy(file, out, p.mdatPos, p.moovPos - p.mdatPos); // the data
      long after = p.moovPos + p.moov.length;
      copy(file, out, after, p.length - after);
    }
  }
  static int fourcc(String s) {
    return (s.charAt(0) << 24) | (s.charAt(1) << 16) | (s.charAt(2) << 8) | s.charAt(3);
  }
  // Walks moov's container boxes and adds `shift` to each chunk offset. Returns false for
  // anything malformed, so a damaged index is never rewritten.
  static boolean shiftOffsets(ByteBuffer b, int start, int end, long shift) {
    int pos = start;
    while (pos + 8 <= end) {
      long size = b.getInt(pos) & 0xffffffffL;
      int type = b.getInt(pos + 4);
      if (size < 8 || pos + size > end) return false;
      if (type == fourcc("trak") || type == fourcc("mdia") || type == fourcc("minf") ||
          type == fourcc("stbl")) {
        if (!shiftOffsets(b, pos + 8, (int) (pos + size), shift)) return false;
      } else if (type == fourcc("stco") || type == fourcc("co64")) {
        boolean wide = type == fourcc("co64");
        if (size < 16) return false;
        long count = b.getInt(pos + 12) & 0xffffffffL;
        if (16 + count * (wide ? 8 : 4) > size) return false;
        for (int i = 0; i < count; i++) {
          if (wide) {
            int at = pos + 16 + i * 8;
            b.putLong(at, b.getLong(at) + shift);
          } else {
            int at = pos + 16 + i * 4;
            long v = (b.getInt(at) & 0xffffffffL) + shift;
            if (v > 0xffffffffL) return false; // would need co64; leave the file as it is
            b.putInt(at, (int) v);
          }
        }
      }
      pos += size;
    }
    return true;
  }
  static void copy(RandomAccessFile from, OutputStream to, long offset, long count)
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
