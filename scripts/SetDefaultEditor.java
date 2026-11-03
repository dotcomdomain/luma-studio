// Run as root via app_process: makes Luma Studio the "Always" choice for ACTION_EDIT on
// the given MIME types, replacing any existing default (the same entry the system
// chooser writes when you tap "Always").
//   app_process -cp set-default-editor.dex / SetDefaultEditor [--dry-run] image/jpeg video/mp4 ...
import android.content.ComponentName;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ResolveInfo;
import android.net.Uri;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.List;

public class SetDefaultEditor {
  static final ComponentName LUMA =
      new ComponentName("studio.luma.editor", "studio.luma.MainActivity");

  public static void main(String[] args) throws Exception {
    Object pm = Class.forName("android.app.ActivityThread")
                    .getMethod("getPackageManager")
                    .invoke(null);
    boolean dryRun = false;
    for (String type : args) {
      if (type.equals("--dry-run")) {
        dryRun = true;
        continue;
      }
      Intent intent = new Intent(Intent.ACTION_EDIT);
      intent.addCategory(Intent.CATEGORY_DEFAULT);
      intent.setDataAndType(Uri.parse("content://media/external/file/1"), type);
      List<ResolveInfo> infos = query(pm, intent, type);
      List<ComponentName> set = new ArrayList<>();
      int bestMatch = 0;
      boolean hasLuma = false;
      for (ResolveInfo ri : infos) {
        ComponentName cn = new ComponentName(ri.activityInfo.packageName, ri.activityInfo.name);
        set.add(cn);
        hasLuma |= cn.equals(LUMA);
        bestMatch = Math.max(bestMatch, ri.match & IntentFilter.MATCH_CATEGORY_MASK);
      }
      if (!hasLuma) {
        System.out.println(type + ": Luma does not handle this type, skipped");
        continue;
      }
      IntentFilter filter = new IntentFilter(Intent.ACTION_EDIT);
      filter.addCategory(Intent.CATEGORY_DEFAULT);
      filter.addDataType(type);
      System.out.println(type + ": " + set.size() + " handlers, match=0x"
          + Integer.toHexString(bestMatch) + (dryRun ? " (dry run)" : ""));
      if (dryRun)
        continue;
      // removeExisting=true drops the old default for this exact filter (e.g. Fossify's editor).
      Method add = find(pm, "addPreferredActivity");
      add.invoke(pm, filter, bestMatch, set.toArray(new ComponentName[0]), LUMA,
          0 /* user 0 */, true /* removeExisting */);
    }
  }

  static List<ResolveInfo> query(Object pm, Intent intent, String type) throws Exception {
    Method m = find(pm, "queryIntentActivities");
    Class<?> flagsType = m.getParameterTypes()[2];
    Object flags = flagsType == long.class ? (Object) 0L : (Object) 0;
    Object slice = m.invoke(pm, intent, type, flags, 0);
    @SuppressWarnings("unchecked")
    List<ResolveInfo> list = (List<ResolveInfo>) slice.getClass().getMethod("getList").invoke(slice);
    return list;
  }

  static Method find(Object o, String name) {
    for (Method m : o.getClass().getMethods())
      if (m.getName().equals(name))
        return m;
    throw new IllegalStateException("no method " + name);
  }
}
