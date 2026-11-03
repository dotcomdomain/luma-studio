package studio.luma;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.IBinder;
import android.os.PowerManager;

// Runs only while a video export does. As a foreground service it keeps Android from
// freezing or killing the app when the person leaves it, and its wake lock keeps the CPU
// running with the screen off. The notification shows the progress.
public class ExportService extends Service {
  static final int ID = 1;
  static final String CHANNEL = "export";
  PowerManager.WakeLock lock;

  static void start(Context c) {
    try {
      c.startForegroundService(new Intent(c, ExportService.class));
    } catch (Exception ignored) {
      // Not allowed right now (the app isn't in front); the export still runs.
    }
  }
  static void stop(Context c) {
    c.stopService(new Intent(c, ExportService.class));
  }
  // Updated every few percent; the notification needn't follow every step.
  static int shown = -1;
  static void progress(Context c, int percent) {
    if (percent / 5 == shown / 5) return;
    shown = percent;
    try {
      c.getSystemService(NotificationManager.class).notify(ID, notification(c, percent));
    } catch (Exception ignored) {
    }
  }
  static Notification notification(Context c, int percent) {
    NotificationManager nm = c.getSystemService(NotificationManager.class);
    if (nm.getNotificationChannel(CHANNEL) == null)
      nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Video exports",
          NotificationManager.IMPORTANCE_LOW));
    int icon = c.getResources().getIdentifier("icon_monochrome", "drawable", c.getPackageName());
    PendingIntent open = PendingIntent.getActivity(c, 0,
        new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
        PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    return new Notification.Builder(c, CHANNEL)
        .setSmallIcon(icon != 0 ? icon : android.R.drawable.stat_sys_upload)
        .setContentTitle("Exporting video")
        .setContentText(percent >= 0 ? percent + "%" : "Starting…")
        .setProgress(100, Math.max(0, percent), percent < 0)
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .setContentIntent(open)
        .build();
  }
  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    shown = -1;
    startForeground(ID, notification(this, -1), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
    if (lock == null) {
      lock = getSystemService(PowerManager.class)
          .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "luma:export");
      lock.acquire(60 * 60 * 1000L);
    }
    return START_NOT_STICKY;
  }
  @Override
  public void onDestroy() {
    if (lock != null && lock.isHeld()) lock.release();
    lock = null;
    stopForeground(STOP_FOREGROUND_REMOVE);
    super.onDestroy();
  }
  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }
}
