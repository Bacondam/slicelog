package com.growthos.journal;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 目标到期提醒：负责系统闹钟的注册，以及到点后弹出通知。
 * 页面在前台时由网页自己弹窗，这里只在后台补通知。
 */
public class GoalAlarmReceiver extends BroadcastReceiver {

    private static final String TAG = "GrowthOSAlarm";
    public static final String CHANNEL_ID = "goal-reminder";
    public static final String ACTION_REMIND = "com.growthos.journal.GOAL_REMIND";
    private static final String PREFS = "growthos_reminders";
    private static final String KEY_LIST = "list";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        if (Intent.ACTION_BOOT_COMPLETED.equals(action)) {
            SharedPreferences sp = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            scheduleAll(context, sp.getString(KEY_LIST, "[]"));
            return;
        }
        String goalId = intent.getStringExtra("goalId");
        String title = intent.getStringExtra("title");
        if (title == null || title.trim().isEmpty()) title = "一个目标";
        post(context, goalId == null ? "goal" : goalId, "目标快到期了 ⏰",
                "「" + title + "」还有不到 1 小时就到期了，现在推进一下还来得及。");
    }

    /** 立即发一条通知（页面在后台时使用） */
    public static void postNow(Context context, String id, String title, String message) {
        post(context, id, title, message);
    }

    private static void post(Context context, String id, String title, String message) {
        NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        ensureChannel(context, nm);

        Intent open = new Intent(context, MainActivity.class);
        open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) piFlags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent content = PendingIntent.getActivity(
                context, id.hashCode(), open, piFlags);

        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(context, CHANNEL_ID)
                : new Notification.Builder(context);
        builder.setSmallIcon(android.R.drawable.ic_popup_reminder)
                .setContentTitle(title)
                .setContentText(message)
                .setStyle(new Notification.BigTextStyle().bigText(message))
                .setAutoCancel(true)
                .setContentIntent(content)
                .setWhen(System.currentTimeMillis());
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            builder.setPriority(Notification.PRIORITY_HIGH);
        }
        try {
            nm.notify(id.hashCode(), builder.build());
        } catch (SecurityException e) {
            Log.w(TAG, "没有通知权限", e);
        }
    }

    private static void ensureChannel(Context context, NotificationManager nm) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID, "目标到期提醒", NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription("目标结束前 1 小时提醒");
        channel.enableVibration(true);
        nm.createNotificationChannel(channel);
    }

    /**
     * @param json [{"id":"g1","title":"跑完半马","at":1731600000000}]
     *             at 为提醒触发时刻（截止时间前 1 小时）
     */
    public static void scheduleAll(Context context, String json) {
        AlarmManager am = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        SharedPreferences sp = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        cancelAll(context, am, sp.getString(KEY_LIST, "[]"));

        JSONArray list;
        try {
            list = new JSONArray(json == null ? "[]" : json);
        } catch (Exception e) {
            list = new JSONArray();
        }
        long now = System.currentTimeMillis();
        JSONArray kept = new JSONArray();
        for (int i = 0; i < list.length(); i++) {
            JSONObject o = list.optJSONObject(i);
            if (o == null) continue;
            String id = o.optString("id", "");
            String title = o.optString("title", "");
            long at = o.optLong("at", 0L);
            if (id.isEmpty() || at <= now) continue;
            PendingIntent pi = buildIntent(context, id, title);
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && am.canScheduleExactAlarms()) {
                    am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
                } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
                } else {
                    am.set(AlarmManager.RTC_WAKEUP, at, pi);
                }
                kept.put(o);
            } catch (SecurityException e) {
                try {
                    am.set(AlarmManager.RTC_WAKEUP, at, pi);
                    kept.put(o);
                } catch (Exception ignored) {
                }
            }
        }
        sp.edit().putString(KEY_LIST, kept.toString()).apply();
    }

    private static void cancelAll(Context context, AlarmManager am, String json) {
        JSONArray list;
        try {
            list = new JSONArray(json == null ? "[]" : json);
        } catch (Exception e) {
            return;
        }
        for (int i = 0; i < list.length(); i++) {
            JSONObject o = list.optJSONObject(i);
            if (o == null) continue;
            String id = o.optString("id", "");
            if (id.isEmpty()) continue;
            PendingIntent pi = buildIntent(context, id, "");
            am.cancel(pi);
            pi.cancel();
        }
    }

    private static PendingIntent buildIntent(Context context, String id, String title) {
        Intent intent = new Intent(context, GoalAlarmReceiver.class)
                .setAction(ACTION_REMIND)
                .setData(Uri.parse("growthos://goal/" + id))
                .putExtra("goalId", id)
                .putExtra("title", title);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getBroadcast(context, id.hashCode(), intent, flags);
    }
}
