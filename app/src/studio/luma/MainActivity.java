package studio.luma;
import android.app.*;
import android.content.*;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.ImageDecoder;
import android.net.Uri;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.os.*;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.webkit.*;
import java.io.*;
import java.util.*;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.*;
public class MainActivity extends Activity {
  static final int MAX_RECENTS = 6;
  // Formats Chromium's WebView decodes itself. Everything else is converted on import.
  static final List<String> WEB_IMAGES =
      Arrays.asList("image/jpeg", "image/png", "image/webp", "image/gif", "image/bmp", "image/avif");
  WebView web;
  Uri lastExport;
  volatile boolean cancelled = false, publishing = false;
  // Per process, not per activity: a rebuilt activity (renderer crash) must not start a
  // second export or clean up the files of one that is still finishing.
  static volatile boolean exportBusy = false;
  File photoPart;
  // The page calls into Java only once it has loaded; files that arrive before that wait.
  boolean pageReady = false;
  final List<Intent> waitingIntents = new ArrayList<>();
  // Imports copied but not yet confirmed by the page; pruning never deletes these.
  final Set<String> inFlightImports = Collections.synchronizedSet(new HashSet<>());
  // Imports run one at a time, in the order they were requested.
  final ExecutorService importer = Executors.newSingleThreadExecutor();
  // Home-screen thumbnails are made one at a time, off the UI thread.
  final ExecutorService thumbnails = Executors.newSingleThreadExecutor();
  public void onCreate(Bundle b) {
    super.onCreate(b);
    getWindow().setStatusBarColor(Color.rgb(17, 23, 21));
    getWindow().setNavigationBarColor(Color.rgb(17, 23, 21));
    photoPart = new File(getCacheDir(), "photo.part");
    migrateRecents();
    pruneSources(null);
    if (!exportBusy) cleanUpInterruptedExports();
    // A restored activity (process death, or a relaunch from Recents) still carries the
    // intent that first opened it. That file was already imported, so don't import it again.
    final boolean freshIntent = b == null &&
        (getIntent().getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) == 0;
    web = new WebView(this);
    web.setHapticFeedbackEnabled(false);
    web.setBackgroundColor(Color.rgb(17, 23, 21));
    setContentView(web);
    WebSettings s = web.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);
    s.setAllowFileAccess(true);
    s.setAllowFileAccessFromFileURLs(true);
    s.setMediaPlaybackRequiresUserGesture(false);
    s.setTextZoom(Math.round(getResources().getConfiguration().fontScale * 100));
    // DevTools lets anything with adb access script the page and its Java bridge. Test
    // copies always have it; the real app only while a root-created flag file exists
    // (scripts/dev.sh makes and removes it).
    WebView.setWebContentsDebuggingEnabled(!getPackageName().equals("studio.luma.editor") ||
        new File(getFilesDir(), "devtools").exists());
    web.addJavascriptInterface(new Bridge(), "Native");
    web.setWebViewClient(new WebViewClient() {
      boolean handled = !freshIntent;
      public boolean shouldOverrideUrlLoading(WebView v, String u) {
        return !u.startsWith("file:");
      }
      public void onPageFinished(WebView v, String u) {
        pageReady = true;
        if (!handled) {
          handled = true;
          handleIncoming(getIntent());
        }
        for (Intent i : waitingIntents) handleIncoming(i);
        waitingIntents.clear();
      }
      public boolean onRenderProcessGone(WebView v, RenderProcessGoneDetail detail) {
        // The renderer died (usually out of memory on a very large file). Rebuild the page
        // instead of letting the whole app crash.
        ((android.view.ViewGroup) v.getParent()).removeView(v);
        v.destroy();
        recreate();
        return true;
      }
    });
    web.loadUrl("file:///android_asset/index.html");
  }
  @Override
  public void onConfigurationChanged(android.content.res.Configuration c) {
    super.onConfigurationChanged(c);
    // Font size changes are handled here rather than by restarting the activity.
    if (web != null) web.getSettings().setTextZoom(Math.round(c.fontScale * 100));
  }
  // A process that died mid-export leaves its temporary files, and possibly a gallery
  // entry that was never finished. Neither is ever used again.
  void cleanUpInterruptedExports() {
    for (String name : new String[] {"export.mp4", "export-fast.mp4", "export.mp4.aac.tmp", "photo.part"})
      new File(getCacheDir(), name).delete();
    new Thread(() -> {
      for (Uri collection : new Uri[] {MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
               MediaStore.Video.Media.EXTERNAL_CONTENT_URI}) {
        try {
          Bundle q = new Bundle();
          q.putString(ContentResolver.QUERY_ARG_SQL_SELECTION, MediaStore.MediaColumns.IS_PENDING
              + "=1 AND " + MediaStore.MediaColumns.OWNER_PACKAGE_NAME + "=?");
          q.putStringArray(ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS, new String[] {getPackageName()});
          if (Build.VERSION.SDK_INT >= 30) q.putInt(MediaStore.QUERY_ARG_MATCH_PENDING, MediaStore.MATCH_ONLY);
          Uri from = Build.VERSION.SDK_INT >= 30 ? collection : MediaStore.setIncludePending(collection);
          try (Cursor c = getContentResolver().query(from, new String[] {MediaStore.MediaColumns._ID}, q, null)) {
            while (c != null && c.moveToNext())
              getContentResolver().delete(ContentUris.withAppendedId(collection, c.getLong(0)), null, null);
          }
        } catch (Exception ignored) {
        }
      }
    }, "luma-cleanup").start();
  }
  @Override
  protected void onDestroy() {
    // A running video export stops at its next frame.
    if (exportBusy) cancelled = true;
    importer.shutdownNow();
    thumbnails.shutdownNow();
    super.onDestroy();
  }
  void js(String x) {
    runOnUiThread(() -> web.evaluateJavascript(x, null));
  }
  void fail(String x) {
    js("exportError(" + JSONObject.quote(x) + ")");
  }

  // ---- Recent projects -------------------------------------------------------------
  // A short list of imported projects, newest first. Each entry owns one copied source file
  // in filesDir; files that fall off the list are deleted.
  SharedPreferences prefs() {
    return getPreferences(0);
  }
  JSONArray recents() {
    try {
      return new JSONArray(prefs().getString("recents", "[]"));
    } catch (JSONException e) {
      return new JSONArray();
    }
  }
  void migrateRecents() {
    String old = prefs().getString("path", "");
    if (old.isEmpty()) return;
    try {
      JSONArray list = recents();
      if (list.length() == 0)
        list.put(new JSONObject().put("path", old).put("name", prefs().getString("name", ""))
            .put("type", prefs().getString("type", "photo")));
      prefs().edit().putString("recents", list.toString()).remove("path").remove("name")
          .remove("type").apply();
    } catch (JSONException ignored) {
    }
  }
  synchronized void rememberProject(String path, String name, String type) {
    try {
      JSONArray list = recents(), next = new JSONArray();
      next.put(new JSONObject().put("path", path).put("name", name).put("type", type));
      for (int i = 0; i < list.length() && next.length() < MAX_RECENTS; i++) {
        JSONObject item = list.getJSONObject(i);
        if (!item.optString("path").equals(path) && new File(item.optString("path")).exists())
          next.put(item);
      }
      prefs().edit().putString("recents", next.toString()).commit();
      pruneSources(path);
    } catch (JSONException ignored) {
    }
  }
  // Deletes copied sources that no recent project uses. `keep` survives too (a file that
  // is open but whose load hasn't been confirmed yet).
  synchronized void pruneSources(String keep) {
    Set<String> used = new HashSet<>(inFlightImports);
    if (keep != null) used.add(keep);
    JSONArray list = recents();
    for (int i = 0; i < list.length(); i++) used.add(list.optJSONObject(i).optString("path"));
    // At startup every leftover goes; later, a half-copied import (.part) is still in use.
    File[] files = getFilesDir().listFiles((dir, name) -> name.startsWith("source-") &&
        (keep == null || !name.endsWith(".part")));
    if (files != null)
      for (File f : files)
        if (!used.contains(f.toString())) f.delete();
    // Thumbnails are named after their source file; drop the ones whose source is gone.
    File[] thumbs = new File(getCacheDir(), "thumbs").listFiles();
    if (thumbs != null)
      for (File t : thumbs) {
        String name = t.getName().replaceFirst("-[0-9]+\\.jpg$", "");
        if (!new File(getFilesDir(), name).exists()) t.delete();
      }
  }
  // A small JPEG of a project for the Recent list, cached by file name and modification
  // time. Photos decode at the target size (with EXIF rotation); videos give one frame.
  File thumbnail(File f) throws IOException {
    File dir = new File(getCacheDir(), "thumbs");
    dir.mkdirs();
    File t = new File(dir, f.getName() + "-" + f.lastModified() + ".jpg");
    if (t.exists()) return t;
    final int edge = 192;
    Bitmap b;
    if (f.getName().endsWith(".mp4")) {
      android.media.MediaMetadataRetriever r = new android.media.MediaMetadataRetriever();
      try {
        r.setDataSource(f.toString());
        b = r.getScaledFrameAtTime(500_000, android.media.MediaMetadataRetriever.OPTION_CLOSEST_SYNC,
            edge * 2, edge * 2);
      } finally {
        r.release();
      }
    } else {
      b = ImageDecoder.decodeBitmap(ImageDecoder.createSource(f), (decoder, info, src) -> {
        int w = info.getSize().getWidth(), h = info.getSize().getHeight();
        float scale = Math.min(1f, (float) edge / Math.min(w, h));
        decoder.setTargetSize(Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale)));
        decoder.setAllocator(ImageDecoder.ALLOCATOR_SOFTWARE);
      });
    }
    if (b == null) throw new IOException("No thumbnail");
    try (OutputStream o = new FileOutputStream(t)) {
      b.compress(Bitmap.CompressFormat.JPEG, 85, o);
    } finally {
      b.recycle();
    }
    return t;
  }
  // Only files Luma copied itself (or the bundled demo) may be opened or exported.
  File ownedFile(String path) {
    if (path == null || path.isEmpty()) return null;
    if (path.startsWith("file://")) path = path.substring(7);
    try {
      File f = new File(path).getCanonicalFile();
      // Return the same spelling of the path that getFilesDir() uses, so it matches the
      // paths stored in Recent and listed by pruneSources.
      if (getFilesDir().getCanonicalFile().equals(f.getParentFile()) && f.exists())
        return new File(getFilesDir(), f.getName());
    } catch (IOException ignored) {
    }
    return null;
  }

  // ---- Importing -------------------------------------------------------------------
  // A type like image/* says what kind of file it is but not its format.
  static boolean vagueType(String type) {
    return type == null || type.endsWith("/*") || type.equals("application/octet-stream");
  }
  // Another app may point Edit at a file:// path inside Luma's own data. Only the files
  // folder (where Luma keeps its imports, and tests place their media) may be read.
  boolean privateFile(Uri uri) {
    if (!"file".equals(uri.getScheme()) || uri.getPath() == null) return false;
    try {
      File f = new File(uri.getPath()).getCanonicalFile();
      String data = getDataDir().getCanonicalPath() + File.separator;
      String files = getFilesDir().getCanonicalPath() + File.separator;
      String path = f.getPath();
      String user0 = "/data/user/0/" + getPackageName() + File.separator;
      boolean inside = path.startsWith(data) || path.startsWith(user0) ||
          path.startsWith("/data/data/" + getPackageName() + File.separator);
      return inside && !(f.getParentFile() != null &&
          (f.getParentFile().getCanonicalPath() + File.separator).equals(files));
    } catch (IOException e) {
      return true;
    }
  }
  void importUri(Uri uri, String fallbackType, boolean external) {
    importer.execute(() -> {
      File dest = null;
      try {
        if (privateFile(uri)) throw new IOException("Private file");
        String type = getContentResolver().getType(uri);
        if (vagueType(type)) type = vagueType(fallbackType) ? null : fallbackType;
        String name = "Untitled";
        long size = -1;
        try (Cursor c = getContentResolver().query(uri, null, null, null, null)) {
          if (c != null && c.moveToFirst()) {
            int n = c.getColumnIndex(OpenableColumns.DISPLAY_NAME),
                s = c.getColumnIndex(OpenableColumns.SIZE);
            if (n >= 0 && c.getString(n) != null) name = c.getString(n);
            if (s >= 0 && !c.isNull(s)) size = c.getLong(s);
          }
        } catch (Exception ignored) {
        }
        if ("Untitled".equals(name) && "file".equals(uri.getScheme()) && uri.getLastPathSegment() != null)
          name = uri.getLastPathSegment();
        js("importStarted(" + JSONObject.quote(name) + ")");
        File raw = new File(getFilesDir(), "source-" + System.currentTimeMillis() + ".part");
        dest = raw;
        if (size > 0 && size > getFilesDir().getUsableSpace() - FREE_SPACE_RESERVE)
          throw new NoSpaceException();
        copy(uri, raw, size);
        if (type == null || !(type.startsWith("image/") || type.startsWith("video/")))
          type = sniffType(raw, name);
        if (type == null) throw new IOException("Not a photo or video");
        boolean video = type.startsWith("video/");
        String base = raw.toString().replaceFirst("\\.part$", "");
        File finalFile;
        if (video) {
          finalFile = new File(base + ".mp4");
        } else if (WEB_IMAGES.contains(type)) {
          finalFile = new File(base + "." + type.substring(6).replace("jpeg", "jpg"));
        } else {
          // HEIC/HEIF and other formats the WebView can't read are decoded here and saved
          // as a lossless PNG (alpha) or a high-quality JPEG.
          finalFile = convertImage(raw, base);
        }
        if (!finalFile.equals(raw) && raw.exists() && !raw.renameTo(finalFile))
          throw new IOException("Could not store the file");
        dest = finalFile;
        inFlightImports.add(finalFile.toString());
        js("openImported(" + JSONObject.quote("file://" + finalFile) + "," +
            JSONObject.quote(video ? "video" : "photo") + "," + JSONObject.quote(name) + "," +
            external + ")");
      } catch (Throwable e) {
        if (dest != null) {
          inFlightImports.remove(dest.toString());
          dest.delete();
        }
        js("importFailed(" + JSONObject.quote(
            e instanceof OutOfMemoryError ? "This file is too large to open." :
            e instanceof NoSpaceException ? "There isn't enough free storage to open this file." :
            "Could not open this file. Try another photo or video.") + ")");
      }
    });
  }
  // Imports stop while this much storage is still free, so a huge or endless stream can't
  // fill the phone.
  static final long FREE_SPACE_RESERVE = 512L << 20;
  static final class NoSpaceException extends IOException {}
  void copy(Uri uri, File dest, long size) throws IOException {
    try (InputStream in = getContentResolver().openInputStream(uri);
        OutputStream out = new FileOutputStream(dest)) {
      if (in == null) throw new IOException("No data");
      byte[] buf = new byte[1 << 20];
      long done = 0, reported = 0;
      int n;
      long checked = 0;
      while ((n = in.read(buf)) != -1) {
        out.write(buf, 0, n);
        done += n;
        if (done - checked > (64 << 20)) {
          checked = done;
          if (dest.getParentFile().getUsableSpace() < FREE_SPACE_RESERVE) throw new NoSpaceException();
        }
        // Large files report progress about every 4%.
        if (size > (8 << 20) && done - reported > size / 25) {
          reported = done;
          js("importProgress(" + Math.min(99, done * 100 / size) + ")");
        }
      }
    }
  }
  String sniffType(File f, String name) {
    BitmapFactory.Options o = new BitmapFactory.Options();
    o.inJustDecodeBounds = true;
    BitmapFactory.decodeFile(f.toString(), o);
    if (o.outWidth > 0 && o.outMimeType != null) return o.outMimeType;
    MediaExtractor extractor = new MediaExtractor();
    try {
      extractor.setDataSource(f.toString());
      for (int i = 0; i < extractor.getTrackCount(); i++) {
        String mime = extractor.getTrackFormat(i).getString(MediaFormat.KEY_MIME);
        if (mime != null && mime.startsWith("video/")) return "video/mp4";
      }
    } catch (Exception ignored) {
    } finally {
      extractor.release();
    }
    String lower = name.toLowerCase(Locale.ROOT);
    if (lower.matches(".*\\.(heic|heif)$")) return "image/heic";
    return null;
  }
  File convertImage(File raw, String base) throws IOException {
    Bitmap bitmap = ImageDecoder.decodeBitmap(ImageDecoder.createSource(raw),
        (decoder, info, src) -> decoder.setAllocator(ImageDecoder.ALLOCATOR_SOFTWARE));
    boolean alpha = bitmap.hasAlpha();
    File out = new File(base + (alpha ? ".png" : ".jpg"));
    try (OutputStream o = new FileOutputStream(out)) {
      bitmap.compress(alpha ? Bitmap.CompressFormat.PNG : Bitmap.CompressFormat.JPEG, 95, o);
    } finally {
      bitmap.recycle();
    }
    raw.delete();
    return out;
  }
  @Override
  protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    if (!pageReady) {
      // The page can't take the file yet. The intent that started the activity is still
      // handled in onPageFinished, so it isn't replaced.
      waitingIntents.add(intent);
      return;
    }
    setIntent(intent);
    handleIncoming(intent);
  }
  // Share sends the file in EXTRA_STREAM; a gallery's Edit button sends it as the intent data.
  void handleIncoming(Intent intent) {
    if (intent == null)
      return;
    Uri uri = null;
    String type = intent.getType(); // read first: setData(null) also clears the type
    if (Intent.ACTION_SEND.equals(intent.getAction())) {
      uri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
      intent.removeExtra(Intent.EXTRA_STREAM);
    } else if (Intent.ACTION_EDIT.equals(intent.getAction())) {
      uri = intent.getData();
      intent.setData(null);
    }
    if (uri != null)
      importUri(uri, type, true);
  }
  public void onActivityResult(int req, int res, Intent d) {
    super.onActivityResult(req, res, d);
    if (req == 7 && res == RESULT_OK && d != null && d.getData() != null)
      importUri(d.getData(), d.getType(), false);
  }

  // ---- Saving ----------------------------------------------------------------------
  interface Writer {
    void write(OutputStream out) throws IOException;
  }
  Uri publish(File f, String mime, String requestedName) throws Exception {
    return publish(out -> {
      try (InputStream in = new FileInputStream(f)) {
        byte[] b = new byte[1 << 20];
        int n;
        while ((n = in.read(b)) != -1) out.write(b, 0, n);
      }
    }, mime, requestedName);
  }
  Uri publish(Writer writer, String mime, String requestedName) throws Exception {
    boolean video = mime.startsWith("video");
    ContentValues v = new ContentValues();
    String extension = video ? ".mp4" : mime.equals("image/png") ? ".png" :
        mime.equals("image/webp") ? ".webp" : ".jpg";
    String name = requestedName == null ? "" : requestedName.trim()
        .replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_")
        .replaceFirst("(?i)\\.(jpg|jpeg|png|webp|mp4)$", "")
        .replaceFirst("^\\.+", "");
    if (name.codePointCount(0, name.length()) > 64)
      name = name.substring(0, name.offsetByCodePoints(0, 64));
    name = name.replaceFirst("[\\s.]+$", "");
    if (name.isEmpty()) name = "Luma_" + System.currentTimeMillis();
    v.put(MediaStore.MediaColumns.DISPLAY_NAME, name + extension);
    v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
    v.put(MediaStore.MediaColumns.RELATIVE_PATH, video ? "Movies/Luma" : "Pictures/Luma");
    v.put(MediaStore.MediaColumns.IS_PENDING, 1);
    Uri uri = getContentResolver().insert(video ? MediaStore.Video.Media.EXTERNAL_CONTENT_URI
                                                : MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
        v);
    if (uri == null) throw new IOException("The gallery did not accept the file. Check free storage.");
    try (OutputStream out = getContentResolver().openOutputStream(uri)) {
      if (out == null) throw new IOException("The gallery did not accept the file.");
      BufferedOutputStream buffered = new BufferedOutputStream(out, 1 << 20);
      writer.write(buffered);
      buffered.flush();
      v.clear();
      v.put(MediaStore.MediaColumns.IS_PENDING, 0);
      getContentResolver().update(uri, v, null, null);
    } catch (Exception e) {
      getContentResolver().delete(uri, null, null);
      throw e;
    }
    lastExport = uri;
    return uri;
  }
  // Codec errors usually carry no message; say which part failed instead of nothing.
  static String describe(Throwable e) {
    if (e.getMessage() != null && !e.getMessage().trim().isEmpty()) return e.getMessage();
    if (e instanceof android.media.MediaCodec.CodecException || e instanceof IllegalStateException)
      return "The phone's video decoder or encoder stopped with an error. The file may be "
          + "larger or more unusual than it can handle.";
    return e.getClass().getSimpleName();
  }
  // Turns an exception into something a person can act on, keeping the detail.
  static String friendly(String detail) {
    String d = detail == null ? "" : detail.trim();
    String lower = d.toLowerCase(Locale.ROOT);
    String summary = lower.contains("no space left") || lower.contains("enospc") ?
        "There isn't enough free storage." : "";
    if (d.length() > 240) d = "…" + d.substring(d.length() - 240);
    return (summary + (summary.isEmpty() || d.isEmpty() ? "" : "\n") + d).trim();
  }
  public class Bridge {
    @JavascriptInterface
    public void pick() {
      runOnUiThread(() -> {
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        i.setType("*/*");
        i.putExtra(Intent.EXTRA_MIME_TYPES, new String[] {"image/*", "video/*"});
        i.addCategory(Intent.CATEGORY_OPENABLE);
        startActivityForResult(i, 7);
      });
    }
    @JavascriptInterface
    public String recentProjects() {
      JSONArray list = recents(), out = new JSONArray();
      for (int i = 0; i < list.length(); i++) {
        JSONObject item = list.optJSONObject(i);
        if (item == null || !new File(item.optString("path")).exists()) continue;
        try {
          out.put(new JSONObject(item.toString()).put("path", "file://" + item.optString("path")));
        } catch (JSONException ignored) {
        }
      }
      return out.toString();
    }
    // Called by the page once an imported file has actually loaded.
    @JavascriptInterface
    public void projectOpened(String path, String name, String type) {
      File f = ownedFile(path);
      if (f == null || f.getName().equals("demo.mp4")) return;
      rememberProject(f.toString(), name, "video".equals(type) ? "video" : "photo");
      inFlightImports.remove(f.toString());
    }
    @JavascriptInterface
    public void requestThumbnail(String path) {
      thumbnails.execute(() -> {
        File f = ownedFile(path);
        if (f == null) return;
        try {
          File t = thumbnail(f);
          js("showRecentThumbnail(" + JSONObject.quote(path) + "," + JSONObject.quote("file://" + t) + ")");
        } catch (Throwable ignored) {
        }
      });
    }
    @JavascriptInterface
    public void forgetFile(String path) {
      File f = ownedFile(path);
      if (f == null) return;
      inFlightImports.remove(f.toString());
      JSONArray list = recents();
      for (int i = 0; i < list.length(); i++)
        if (f.toString().equals(list.optJSONObject(i).optString("path"))) return;
      f.delete();
    }
    // The screen stays on while something is being saved; a screen timeout would
    // otherwise stop the app in the middle of a long export.
    @JavascriptInterface
    public void keepScreenOn(boolean on) {
      runOnUiThread(() -> {
        if (on) getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        else getWindow().clearFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
      });
    }
    @JavascriptInterface
    public void exit() {
      runOnUiThread(MainActivity.this::finish);
    }
    @JavascriptInterface
    public void photoBegin() {
      photoPart.delete();
    }
    @JavascriptInterface
    public boolean photoChunk(String data) {
      try (OutputStream f = new FileOutputStream(photoPart, true)) {
        f.write(android.util.Base64.decode(data, 0));
        return true;
      } catch (Throwable e) {
        photoPart.delete();
        return false;
      }
    }
    @JavascriptInterface
    public void photoFinish(String format, String name) {
      if (!Arrays.asList("jpg", "png", "webp").contains(format)) {
        fail("Unsupported image format");
        return;
      }
      new Thread(() -> {
        try {
          if (!photoPart.exists() || photoPart.length() == 0)
            throw new IOException("The image data did not arrive.");
          publish(photoPart, "image/" + (format.equals("jpg") ? "jpeg" : format), name);
          js("exportDone()");
        } catch (Throwable e) {
          fail("Could not save the photo. " + friendly(e.getMessage()));
        } finally {
          photoPart.delete();
        }
      }).start();
    }
    @JavascriptInterface
    public void share() {
      runOnUiThread(() -> {
        if (lastExport == null)
          return;
        Intent i = new Intent(Intent.ACTION_SEND);
        i.setType(getContentResolver().getType(lastExport));
        i.putExtra(Intent.EXTRA_STREAM, lastExport);
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        startActivity(Intent.createChooser(i, "Share your creation"));
      });
    }
    @JavascriptInterface
    public void cancel() {
      if (!publishing) cancelled = true;
    }
    // Which video codecs this phone can encode.
    @JavascriptInterface
    public String videoEncoders() {
      try {
        return new JSONObject()
            .put("h264", VideoExporter.hasEncoder(MediaFormat.MIMETYPE_VIDEO_AVC))
            .put("hevc", VideoExporter.hasEncoder(MediaFormat.MIMETYPE_VIDEO_HEVC)).toString();
      } catch (JSONException e) {
        return "{}";
      }
    }
    @JavascriptInterface
    public String videoInfo(String path) {
      MediaExtractor extractor = new MediaExtractor();
      JSONObject info = new JSONObject();
      try {
        File f = ownedFile(path);
        if (f == null) return "{}";
        extractor.setDataSource(f.toString());
        for (int i = 0; i < extractor.getTrackCount(); i++) {
          MediaFormat format = extractor.getTrackFormat(i);
          String mime = format.getString(MediaFormat.KEY_MIME);
          if (mime != null && mime.startsWith("video/")) {
            Number value = format.getNumber(MediaFormat.KEY_FRAME_RATE);
            if (value != null && Double.isFinite(value.doubleValue()) && value.doubleValue() > 0)
              info.put("fps", value.doubleValue());
            break;
          }
        }
      } catch (Exception ignored) {
      } finally { extractor.release(); }
      return info.toString();
    }
    @JavascriptInterface
    public void demoVideo() {
      importer.execute(() -> {
        try {
          File f = new File(getFilesDir(), "demo.mp4");
          long size;
          try (android.content.res.AssetFileDescriptor fd = getAssets().openFd("demo.mp4")) {
            size = fd.getLength();
          } catch (IOException e) {
            size = -1;
          }
          if (!f.exists() || f.length() != size) {
            try (InputStream i = getAssets().open("demo.mp4");
                OutputStream o = new FileOutputStream(f)) {
              byte[] b = new byte[1 << 20];
              int n;
              while ((n = i.read(b)) > 0) o.write(b, 0, n);
            }
          }
          js("openImported(" + JSONObject.quote("file://" + f) + ",'video','Alpine motion.mp4',false)");
        } catch (Exception e) {
          js("importFailed('The sample video could not be opened.')");
        }
      });
    }
    @JavascriptInterface
    public synchronized void exportVideo(String json) {
      if (exportBusy) {
        fail("An export is still finishing. Try again shortly.");
        return;
      }
      exportBusy = true;
      cancelled = false;
      publishing = false;
      // A foreground service keeps the process running (and the CPU awake) if the person
      // switches apps or the screen goes off during the export.
      ExportService.start(MainActivity.this);
      new Thread(() -> {
        File out = new File(getCacheDir(), "export.mp4");
        boolean done = false;
        try {
          VideoExporter job = videoJob(new JSONObject(json), out);
          job.run();
          if (cancelled) return;
          publishing = true;
          js("exportFinalizing()");
          // Streaming optimization reorders the file on its way into the gallery. If the
          // file can't be reordered it is saved as it is; it still plays everywhere.
          Mp4FastStart.Plan plan = null;
          if (job.fastStart) try { plan = Mp4FastStart.plan(out); } catch (Exception ignored) {}
          final Mp4FastStart.Plan fast = plan;
          if (fast != null) publish(o -> Mp4FastStart.write(out, fast, o), "video/mp4", job.name);
          else publish(out, "video/mp4", job.name);
          done = true;
          List<String> notes = new ArrayList<>();
          if (job.shortBy != null)
            notes.add("The source file ended early, so only its first " + job.shortBy + " s could be saved.");
          if (job.audioNote != null) notes.add(job.audioNote);
          if (job.colorNote != null) notes.add(job.colorNote);
          js(notes.isEmpty() ? "exportDone()" : "exportDone(" + JSONObject.quote(String.join("\n", notes)) + ")");
        } catch (VideoExporter.CancelledException e) {
          // reported in finally
        } catch (Throwable e) {
          if (!cancelled || publishing)
            fail("Video export failed. " + friendly(describe(e)));
        } finally {
          out.delete();
          exportBusy = false;
          ExportService.stop(MainActivity.this);
          if (cancelled && !done && !publishing)
            js("exportCancelled()");
          publishing = false;
        }
      }, "luma-export").start();
    }
  }
  // Builds the export job from the page's settings and checks every value.
  VideoExporter videoJob(JSONObject j, File out) throws Exception {
    VideoExporter job = new VideoExporter();
    job.source = ownedFile(j.optString("source"));
    if (job.source == null) throw new Exception("Import a video first");
    job.output = out;
    double start = j.getDouble("start"), duration = j.getDouble("duration"),
           speed = j.getDouble("speed");
    if (start < 0 || !Double.isFinite(duration) || speed < .5 || speed > 2)
      throw new Exception("Invalid trim range");
    // At least two frames of output, so the file always has a picture in it.
    if (duration / speed < .1) throw new Exception("The trimmed clip is too short to export.");
    job.startUs = Math.round(start * 1e6);
    job.durationUs = Math.round(duration * 1e6);
    job.speed = speed;
    job.flipH = j.optBoolean("flipH");
    job.flipV = j.optBoolean("flipV");
    job.rotation = j.optInt("rotation");
    if (!Arrays.asList(0, 90, 180, 270).contains(job.rotation)) throw new Exception("Invalid rotation");
    JSONObject crop = j.getJSONObject("crop");
    job.crop = new float[] {(float) crop.getDouble("x"), (float) crop.getDouble("y"),
        (float) crop.getDouble("w"), (float) crop.getDouble("h")};
    job.width = j.getInt("width");
    job.height = j.getInt("height");
    if (job.width < 2 || job.height < 2 || job.width > 8192 || job.height > 8192 ||
        job.width % 2 != 0 || job.height % 2 != 0)
      throw new Exception("Invalid output size");
    job.brightness = (float) j.optDouble("brightness", 1);
    job.contrast = (float) j.optDouble("contrast", 1);
    job.saturation = (float) j.optDouble("saturation", 1);
    JSONArray warm = j.optJSONArray("warmth");
    if (warm != null && warm.length() == 3)
      job.warmth = new float[] {(float) warm.getDouble(0), (float) warm.getDouble(1),
          (float) warm.getDouble(2)};
    String codec = j.optString("codec", "h264"), rateMode = j.optString("rateMode", "quality");
    int crf = j.optInt("crf", 23), fps = j.optInt("fps", 0),
        audioBitrate = j.optInt("audioBitrate", 192),
        channels = j.optInt("channels", 0), sampleRate = j.optInt("sampleRate", 0);
    double bitrate = j.optDouble("bitrate", 8);
    if (!Arrays.asList("h264", "hevc").contains(codec) ||
        !Arrays.asList("quality", "bitrate").contains(rateMode) ||
        !Arrays.asList(18, 20, 23, 28).contains(crf) ||
        !Arrays.asList(0, 24, 25, 30, 50, 60).contains(fps) ||
        !Arrays.asList(96, 128, 192, 256).contains(audioBitrate) ||
        channels < 0 || channels > 2 ||
        !Arrays.asList(0, 44100, 48000).contains(sampleRate) ||
        !Double.isFinite(bitrate) || bitrate < .2 || bitrate > 100)
      throw new Exception("Invalid export settings");
    job.mime = codec.equals("hevc") ? MediaFormat.MIMETYPE_VIDEO_HEVC : MediaFormat.MIMETYPE_VIDEO_AVC;
    // Hardware encoders have no quality setting like x264's CRF, so each quality level is a
    // bitrate per pixel per frame. HEVC needs about two thirds of H.264's.
    if (rateMode.equals("bitrate")) job.bitrate = (int) Math.round(bitrate * 1e6);
    else {
      double bpp = crf == 18 ? .2 : crf == 20 ? .15 : crf == 23 ? .1 : .06;
      job.bitsPerPixel = (float) (codec.equals("hevc") ? bpp * .65 : bpp);
    }
    job.fps = fps;
    job.mute = j.getBoolean("mute");
    job.volume = (float) j.getDouble("volume");
    job.audioBitrate = audioBitrate * 1000;
    job.channels = channels;
    job.sampleRate = sampleRate;
    job.fastStart = j.optBoolean("fastStart", true);
    job.name = j.optString("name", "");
    job.listener = new VideoExporter.Listener() {
      int last = -1;
      public void progress(int percent) {
        if (percent == last) return;
        last = percent;
        js("exportProgress(" + percent + ")");
        ExportService.progress(MainActivity.this, percent);
      }
      public boolean cancelled() { return cancelled; }
    };
    // Overlays in drawing order: vignette, drawing layers (timed), text.
    addOverlay(job, j.optString("overlay", ""), 0, Long.MAX_VALUE);
    JSONArray drawings = j.optJSONArray("drawingLayers");
    if (drawings != null)
      for (int i = 0; i < drawings.length(); i++) {
        JSONObject layer = drawings.getJSONObject(i);
        double inkStart = layer.optDouble("start", 0), inkEnd = layer.optDouble("end", start + duration);
        if (!Double.isFinite(inkStart) || !Double.isFinite(inkEnd))
          throw new Exception("Invalid drawing timing");
        long from = Math.max(0, Math.round((inkStart - start) / speed * 1e6)),
             to = inkEnd >= start + duration ? Long.MAX_VALUE : Math.round((inkEnd - start) / speed * 1e6);
        if (to > from) addOverlay(job, layer.optString("overlay", ""), from, to);
      }
    addOverlay(job, j.optString("textOverlay", ""), 0, Long.MAX_VALUE);
    return job;
  }
  void addOverlay(VideoExporter job, String base64, long fromUs, long toUs) throws IOException {
    if (base64.isEmpty()) return;
    byte[] png = android.util.Base64.decode(base64, 0);
    VideoExporter.Overlay o = new VideoExporter.Overlay();
    Bitmap full = BitmapFactory.decodeByteArray(png, 0, png.length);
    if (full == null) throw new IOException("An overlay image could not be read.");
    if (full.getWidth() != job.width || full.getHeight() != job.height) {
      Bitmap scaled = Bitmap.createScaledBitmap(full, job.width, job.height, true);
      full.recycle();
      full = scaled;
    }
    // Only the rectangle that has pixels is kept and blended on each frame; text or a
    // small drawing covers a fraction of a 4K frame.
    int[] box = opaqueBounds(full);
    if (box == null) {
      full.recycle();
      return;
    }
    o.x = box[0];
    o.y = box[1];
    o.w = box[2] - box[0];
    o.h = box[3] - box[1];
    if (o.w == full.getWidth() && o.h == full.getHeight()) o.bitmap = full;
    else {
      o.bitmap = Bitmap.createBitmap(full, o.x, o.y, o.w, o.h);
      full.recycle();
    }
    o.fromUs = fromUs;
    o.toUs = toUs;
    job.overlays.add(o);
  }
  // left, top, right, bottom of the pixels with any alpha, with a 1 px margin for filtering;
  // null for a fully transparent bitmap.
  static int[] opaqueBounds(Bitmap b) {
    int w = b.getWidth(), h = b.getHeight(), left = w, top = h, right = -1, bottom = -1;
    int[] row = new int[w];
    for (int y = 0; y < h; y++) {
      b.getPixels(row, 0, w, 0, y, w, 1);
      int first = -1, last = -1;
      for (int x = 0; x < w; x++)
        if ((row[x] >>> 24) != 0) { if (first < 0) first = x; last = x; }
      if (first < 0) continue;
      if (top > y) top = y;
      bottom = y;
      left = Math.min(left, first);
      right = Math.max(right, last);
    }
    if (right < 0) return null;
    return new int[] {Math.max(0, left - 1), Math.max(0, top - 1), Math.min(w, right + 2), Math.min(h, bottom + 2)};
  }
  @Override
  public void onBackPressed() {
    // The page answers true when it handled Back (closed a sheet, left the editor).
    web.evaluateJavascript("goBack()", handled -> {
      if (!"true".equals(handled)) finish();
    });
  }
}
