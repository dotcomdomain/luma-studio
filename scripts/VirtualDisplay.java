package studio.luma;
import android.content.Context;
import android.hardware.display.*;
import android.media.Image;
import android.media.ImageReader;
import android.graphics.*;
import android.os.*;
import java.io.*;
import java.nio.*;
public class VirtualDisplay {
  public static void main(String[] args) throws Exception {
    Looper.prepareMainLooper();
    Class<?> at = Class.forName("android.app.ActivityThread");
    Object thread = at.getMethod("systemMain").invoke(null);
    Context context = (Context) at.getMethod("getSystemContext").invoke(thread);
    DisplayManager manager = (DisplayManager) context.getSystemService(Context.DISPLAY_SERVICE);
    ImageReader reader = ImageReader.newInstance(1080, 2220, PixelFormat.RGBA_8888, 3);
    Handler handler = new Handler(Looper.getMainLooper());
    String dir = args[0];
    reader.setOnImageAvailableListener(r -> {
      try (Image image = r.acquireLatestImage()) {
        if (image == null)
          return;
        File request = new File(dir, "capture.request");
        if (request.exists()) {
          request.delete();
          Image.Plane p = image.getPlanes()[0];
          int width = image.getWidth(), height = image.getHeight(),
              stride = p.getRowStride() / p.getPixelStride();
          Bitmap padded = Bitmap.createBitmap(stride, height, Bitmap.Config.ARGB_8888);
          padded.copyPixelsFromBuffer(p.getBuffer());
          Bitmap shot = Bitmap.createBitmap(padded, 0, 0, width, height);
          try (OutputStream out = new FileOutputStream(new File(dir, "display-next.png"))) {
            shot.compress(Bitmap.CompressFormat.PNG, 100, out);
          }
          new File(dir,"display-next.png").renameTo(new File(dir,"display.png"));
          shot.recycle();
          padded.recycle();
        }
      } catch (Exception e) {
        e.printStackTrace();
      }
    }, handler);
    android.hardware.display.VirtualDisplay display =
        manager.createVirtualDisplay("Luma isolated test studio", 1080, 2220, 420,
            reader.getSurface(), 1 | 2 | 8 | 64 | 128 | 256);
    if (display == null)
      throw new Exception("Display creation failed");
    int id = display.getDisplay().getDisplayId();
    try (PrintWriter out = new PrintWriter(new File(dir, "display-id"))) {
      out.println(id);
    }
    try (PrintWriter out = new PrintWriter(new File(dir, "display-pid"))) {
      out.println(android.os.Process.myPid());
    }
    System.out.println("DISPLAY_ID=" + id);
    System.out.flush();
    Looper.loop();
  }
}
