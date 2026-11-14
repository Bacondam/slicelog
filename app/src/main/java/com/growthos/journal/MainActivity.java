package com.growthos.journal;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.ActivityNotFoundException;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.provider.Settings;
import android.util.Log;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.JsResult;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Arrays;
import java.util.Comparator;
import java.util.Date;
import java.util.Locale;

import org.json.JSONObject;

public class MainActivity extends Activity {
    private static final String TAG = "GrowthOS";
    private static final int REQUEST_IMPORT = 4101;
    private static final int REQUEST_EXPORT = 4102;
    private static final int REQUEST_NOTIFY = 4103;

    private FrameLayout root;
    private WebView webView;
    private ValueCallback<Uri[]> filePathCallback;
    private String pendingBackup;
    private String pendingBackupName;
    private long lastBackPressedAt;
    private boolean isForeground = true;

    // 从外部打开/分享进来的备份文件（如微信里「用其他应用打开」）
    private String pendingImportText;
    private String pendingImportName;
    private boolean pageReady;

    // 真实系统栏尺寸（像素），用于换算成 CSS px 传给页面
    private int insetTop;
    private int insetRight;
    private int insetBottom;
    private int insetLeft;
    private float density = 1f;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        density = getResources().getDisplayMetrics().density;
        if (density <= 0f) density = 1f;

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#F4F7F5"));

        webView = new WebView(this);
        webView.setBackgroundColor(Color.parseColor("#F4F7F5"));
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        root.addView(webView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

        setContentView(root);
        goEdgeToEdge();
        listenSystemInsets();
        configureWebView();

        // 桥接必须在 loadUrl 之前注入，页面 <head> 里的脚本可同步取到安全区
        webView.addJavascriptInterface(new AndroidBridge(), "AndroidBridge");

        ensureNotificationChannel();
        requestNotificationPermission();

        if (savedInstanceState == null || webView.restoreState(savedInstanceState) == null) {
            webView.loadUrl("file:///android_asset/index.html");
        }

        // 冷启动时如果是从外部「打开备份文件」进来的，读完直接弹导入确认
        handleImportIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleImportIntent(intent);
    }

    /* ---------- 外部 json → 导入 ---------- */

    private void handleImportIntent(Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        Uri uri = null;
        if (Intent.ACTION_VIEW.equals(action)) {
            uri = intent.getData();
        } else if (Intent.ACTION_SEND.equals(action)) {
            uri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
        }
        if (uri == null) return;

        final Uri target = uri;
        final String name = displayNameOf(uri);
        new Thread(() -> {
            String text = null;
            String error = null;
            try {
                text = readUriText(target);
            } catch (SecurityException se) {
                error = "没有读取该文件的权限，请先在微信里「保存到手机」再导入";
            } catch (Exception e) {
                error = "无法读取该文件，请先保存到手机再导入";
                Log.w(TAG, "read import uri failed", e);
            }
            final String body = text;
            final String err = error;
            runOnUiThread(() -> {
                if (err != null) {
                    toastJs("receiveImportError", err);
                } else {
                    pendingImportText = body;
                    pendingImportName = name;
                    flushPendingImport(0);
                }
            });
        }).start();
    }

    private String displayNameOf(Uri uri) {
        try (android.database.Cursor c = getContentResolver().query(uri, null, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                int idx = c.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME);
                if (idx >= 0) {
                    String n = c.getString(idx);
                    if (n != null && !n.isEmpty()) return n;
                }
            }
        } catch (Exception ignored) {
            // 部分 provider 不支持 query，退回用路径末段
        }
        String p = uri.getLastPathSegment();
        return p == null || p.isEmpty() ? "备份文件" : p;
    }

    private String readUriText(Uri uri) throws Exception {
        InputStream in;
        if ("file".equals(uri.getScheme())) {
            in = new FileInputStream(new File(uri.getPath()));
        } else {
            in = getContentResolver().openInputStream(uri);
        }
        if (in == null) throw new Exception("openInputStream returned null");
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) {
            bos.write(buf, 0, n);
            if (bos.size() > 20 * 1024 * 1024) {
                in.close();
                throw new Exception("backup too large");
            }
        }
        in.close();
        return new String(bos.toByteArray(), StandardCharsets.UTF_8);
    }

    /** 页面就绪后再把内容交给 JS；最多等 3 秒，避免恢复态下拿不到回调。 */
    private void flushPendingImport(int attempt) {
        if (pendingImportText == null || webView == null) return;
        if (!pageReady && attempt < 12) {
            webView.postDelayed(() -> flushPendingImport(attempt + 1), 250);
            return;
        }
        final String text = pendingImportText;
        final String name = pendingImportName;
        pendingImportText = null;
        pendingImportName = null;
        String js = "if(window.receiveImportFile){receiveImportFile("
                + JSONObject.quote(text) + "," + JSONObject.quote(name) + ");}";
        webView.evaluateJavascript(js, null);
    }

    private void toastJs(String fn, String msg) {
        if (webView == null) return;
        webView.evaluateJavascript("if(window." + fn + "){window." + fn + "("
                + JSONObject.quote(msg) + ");}", null);
    }

    /* ---------- 通知 ---------- */

    private void ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm == null) return;
        NotificationChannel channel = new NotificationChannel(
                GoalAlarmReceiver.CHANNEL_ID, "目标到期提醒", NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription("目标结束前 1 小时提醒");
        channel.enableVibration(true);
        nm.createNotificationChannel(channel);
    }

    private void requestNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return;
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return;
        requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQUEST_NOTIFY);
    }

    /** 全面屏：内容铺满整块屏幕，由页面按真实安全区自行留白。 */
    private void goEdgeToEdge() {
        Window window = getWindow();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.setDecorFitsSystemWindows(false);
        } else {
            window.getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
            window.setStatusBarColor(Color.TRANSPARENT);
            window.setNavigationBarColor(Color.TRANSPARENT);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            WindowManager.LayoutParams attrs = window.getAttributes();
            // Find X8 Ultra 为居中挖孔屏，允许绘制到挖孔区域，再用安全区避开
            attrs.layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            window.setAttributes(attrs);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            window.setNavigationBarContrastEnforced(false);
            window.setStatusBarContrastEnforced(false);
        }
    }

    private void listenSystemInsets() {
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            int top, right, bottom, left, imeBottom = 0;

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                int[] values = Api30.readInsets(insets);
                top = values[0];
                right = values[1];
                bottom = values[2];
                left = values[3];
                imeBottom = values[4];
            } else {
                top = insets.getSystemWindowInsetTop();
                right = insets.getSystemWindowInsetRight();
                bottom = insets.getSystemWindowInsetBottom();
                left = insets.getSystemWindowInsetLeft();
            }

            if (top != insetTop || right != insetRight || bottom != insetBottom || left != insetLeft) {
                insetTop = top;
                insetRight = right;
                insetBottom = bottom;
                insetLeft = left;
                pushInsetsToPage();
            }

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && webView != null) {
                FrameLayout.LayoutParams lp = (FrameLayout.LayoutParams) webView.getLayoutParams();
                int margin = imeBottom > 0 ? imeBottom : 0;
                if (lp.bottomMargin != margin) {
                    lp.bottomMargin = margin;
                    webView.setLayoutParams(lp);
                }
            }
            return insets;
        });
        root.requestApplyInsets();
    }

    private void pushInsetsToPage() {
        if (webView == null) return;
        final String js = String.format(Locale.US,
                "window.applySafeInsets&&window.applySafeInsets(%s,%s,%s,%s)",
                cssPx(insetTop), cssPx(insetRight), cssPx(insetBottom), cssPx(insetLeft));
        webView.post(() -> webView.evaluateJavascript(js, null));
    }

    private String cssPx(int px) {
        return String.format(Locale.US, "%.1f", px / density);
    }

    private void configureWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        // 应用型界面：锁定文字缩放与整页缩放，避免系统字号/双指缩放打乱版式
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setTextZoom(100);
        settings.setLoadWithOverviewMode(false);
        settings.setUseWideViewPort(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        }
        // ColorOS 的「强制深色」会二次反色，应用自带 7 套主题，这里统一关闭
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            settings.setAlgorithmicDarkeningAllowed(false);
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            settings.setForceDark(WebSettings.FORCE_DARK_OFF);
        }
        WebView.setWebContentsDebuggingEnabled(false);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                if (url != null && url.startsWith("file:///android_asset/")) return false;
                Toast.makeText(MainActivity.this, "成长日志为完全离线应用", Toast.LENGTH_SHORT).show();
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                pageReady = true;
                pushInsetsToPage();
                flushPendingImport(0);
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (filePathCallback != null) filePathCallback.onReceiveValue(null);
                filePathCallback = callback;
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*");
                intent.putExtra(Intent.EXTRA_MIME_TYPES,
                        new String[]{"application/json", "text/plain", "application/octet-stream"});
                try {
                    startActivityForResult(intent, REQUEST_IMPORT);
                    return true;
                } catch (ActivityNotFoundException e) {
                    filePathCallback = null;
                    Toast.makeText(MainActivity.this, "没有找到可用的文件选择器", Toast.LENGTH_LONG).show();
                    return false;
                }
            }

            @Override
            public boolean onJsAlert(WebView view, String url, String message, JsResult result) {
                new AlertDialog.Builder(MainActivity.this)
                        .setMessage(message)
                        .setPositiveButton("知道了", (dialog, which) -> result.confirm())
                        .setOnCancelListener(dialog -> result.cancel())
                        .show();
                return true;
            }

            @Override
            public boolean onJsConfirm(WebView view, String url, String message, JsResult result) {
                new AlertDialog.Builder(MainActivity.this)
                        .setMessage(message)
                        .setPositiveButton("确定", (dialog, which) -> result.confirm())
                        .setNegativeButton("取消", (dialog, which) -> result.cancel())
                        .setOnCancelListener(dialog -> result.cancel())
                        .show();
                return true;
            }
        });
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQUEST_IMPORT) {
            if (filePathCallback != null) {
                Uri[] uris = null;
                if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                    uris = new Uri[]{data.getData()};
                }
                filePathCallback.onReceiveValue(uris);
                filePathCallback = null;
            }
            return;
        }
        if (requestCode == REQUEST_EXPORT) {
            final String backup = pendingBackup;
            pendingBackup = null;
            if (resultCode == RESULT_OK && data != null && data.getData() != null && backup != null) {
                final Uri destination = data.getData();
                new Thread(() -> writeBackup(destination, backup)).start();
            } else {
                Toast.makeText(this, "已取消导出", Toast.LENGTH_SHORT).show();
            }
        }
    }

    private void writeBackup(Uri destination, String backup) {
        try (OutputStream stream = getContentResolver().openOutputStream(destination, "wt");
             OutputStreamWriter writer = new OutputStreamWriter(stream, StandardCharsets.UTF_8)) {
            writer.write(backup);
            writer.flush();
            runOnUiThread(() -> Toast.makeText(this, "备份已保存", Toast.LENGTH_LONG).show());
        } catch (Exception e) {
            runOnUiThread(() -> Toast.makeText(this,
                    "导出失败：" + e.getMessage(), Toast.LENGTH_LONG).show());
        }
    }

    /* ---------- 备份文件 ---------- */

    private static String safeName(String filename, String fallback) {
        if (filename == null || filename.trim().isEmpty()) return fallback;
        return filename.replaceAll("[\\\\/:*?\"<>|\\s]", "-");
    }

    private void startExportPicker() {
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("application/json");
        intent.putExtra(Intent.EXTRA_TITLE, pendingBackupName);
        try {
            startActivityForResult(intent, REQUEST_EXPORT);
        } catch (ActivityNotFoundException e) {
            pendingBackup = null;
            Toast.makeText(this, "没有找到可用的文件保存工具", Toast.LENGTH_LONG).show();
        }
    }

    /** 写入系统「下载/GrowthOS」，返回可分享的 content Uri；失败返回 null */
    private Uri writeToDownloads(String name, String content) {
        try {
            byte[] bytes = content.getBytes(StandardCharsets.UTF_8);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentValues values = new ContentValues();
                values.put(MediaStore.Downloads.DISPLAY_NAME, name);
                values.put(MediaStore.Downloads.MIME_TYPE, "application/json");
                values.put(MediaStore.Downloads.RELATIVE_PATH,
                        Environment.DIRECTORY_DOWNLOADS + "/GrowthOS");
                values.put(MediaStore.Downloads.IS_PENDING, 1);
                Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (uri == null) return null;
                try (OutputStream out = getContentResolver().openOutputStream(uri)) {
                    if (out == null) return null;
                    out.write(bytes);
                    out.flush();
                }
                values.clear();
                values.put(MediaStore.Downloads.IS_PENDING, 0);
                getContentResolver().update(uri, values, null, null);
                return uri;
            }
            // Android 9 及以下：file:// 无法直接分享，交给另存为流程
            return null;
        } catch (Exception e) {
            Log.w(TAG, "写入下载目录失败", e);
            return null;
        }
    }

    private File autoDir() {
        File dir = new File(getFilesDir(), "autobackup");
        if (!dir.exists()) dir.mkdirs();
        return dir;
    }

    private void writeAutoSnapshot(String json) throws Exception {
        File dir = autoDir();
        File latest = new File(dir, "auto-latest.json");
        if (latest.exists()) {
            String stamp = new SimpleDateFormat("yyyyMMdd", Locale.US).format(new Date());
            File day = new File(dir, "auto-" + stamp + ".json");
            if (!day.exists()) copyFile(latest, day);
        }
        try (OutputStreamWriter writer = new OutputStreamWriter(
                new FileOutputStream(latest), StandardCharsets.UTF_8)) {
            writer.write(json);
            writer.flush();
        }
        File[] files = dir.listFiles((d, n) ->
                n.startsWith("auto-") && n.endsWith(".json") && !n.equals("auto-latest.json"));
        if (files != null && files.length > 8) {
            Arrays.sort(files, new Comparator<File>() {
                @Override
                public int compare(File a, File b) {
                    return Long.compare(a.lastModified(), b.lastModified());
                }
            });
            for (int i = 0; i < files.length - 8; i++) {
                //noinspection ResultOfMethodCallIgnored
                files[i].delete();
            }
        }
    }

    private static void copyFile(File from, File to) throws Exception {
        try (InputStream in = new FileInputStream(from);
             OutputStream out = new FileOutputStream(to)) {
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        }
    }

    private static String readFile(File file) throws Exception {
        try (InputStream in = new FileInputStream(file)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        }
    }

    @Override
    public void onBackPressed() {
        if (webView == null) {
            super.onBackPressed();
            return;
        }
        webView.evaluateJavascript(
                "window.androidHandleBack ? window.androidHandleBack() : false",
                value -> {
                    if ("true".equals(value)) return;
                    long now = System.currentTimeMillis();
                    if (now - lastBackPressedAt < 2000) {
                        finish();
                    } else {
                        lastBackPressedAt = now;
                        Toast.makeText(this, "再按一次退出成长日志", Toast.LENGTH_SHORT).show();
                    }
                });
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        webView.saveState(outState);
        super.onSaveInstanceState(outState);
    }

    @Override
    protected void onResume() {
        super.onResume();
        isForeground = true;
        if (webView != null) webView.onResume();
    }

    @Override
    protected void onPause() {
        isForeground = false;
        if (webView != null) webView.onPause();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        if (filePathCallback != null) {
            filePathCallback.onReceiveValue(null);
            filePathCallback = null;
        }
        if (webView != null) {
            webView.removeJavascriptInterface("AndroidBridge");
            webView.stopLoading();
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    /** 跟随页面主题切换状态栏 / 导航栏图标的明暗，颜色由网页自身铺底。 */
    private void applySystemBars(String color, boolean dark) {
        try {
            Window window = getWindow();
            int parsed = Color.parseColor(color);
            if (root != null) root.setBackgroundColor(parsed);

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                Api30.setBarsAppearance(window, dark);
            } else {
                window.setStatusBarColor(parsed);
                window.setNavigationBarColor(parsed);
                int flags = window.getDecorView().getSystemUiVisibility();
                if (dark) {
                    flags &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        flags &= ~View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
                    }
                } else {
                    flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        flags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
                    }
                }
                window.getDecorView().setSystemUiVisibility(flags);
            }
        } catch (IllegalArgumentException ignored) {
        }
    }

    private final class AndroidBridge {
        @JavascriptInterface
        public String getSafeInsets() {
            return cssPx(insetTop) + "," + cssPx(insetRight) + ","
                    + cssPx(insetBottom) + "," + cssPx(insetLeft);
        }

        /** 设备信息，便于排查显示问题。 */
        @JavascriptInterface
        public String getScreenInfo() {
            android.util.DisplayMetrics dm = getResources().getDisplayMetrics();
            String info = String.format(Locale.US,
                    "dpWidth=%d dpHeight=%d density=%.2f dpi=%d api=%d insets=%s",
                    Math.round(dm.widthPixels / density), Math.round(dm.heightPixels / density),
                    density, dm.densityDpi, Build.VERSION.SDK_INT, getSafeInsets());
            Log.i(TAG, info);
            return info;
        }

        @JavascriptInterface
        public void exportBackup(String backup, String filename) {
            pendingBackup = backup;
            pendingBackupName = safeName(filename, "growth-backup.json");
            runOnUiThread(MainActivity.this::startExportPicker);
        }

        @JavascriptInterface
        public void setSystemBars(String color, boolean dark) {
            runOnUiThread(() -> applySystemBars(color, dark));
        }

        /** 目标提醒：前台由页面弹窗负责，这里只在后台补一条系统通知 */
        @JavascriptInterface
        public void notifyGoal(String title, String message) {
            if (isForeground) return;
            runOnUiThread(() -> GoalAlarmReceiver.postNow(MainActivity.this,
                    "goal-now", String.valueOf(title), String.valueOf(message)));
        }

        /** 页面把「未完成目标 + 提醒时刻」同步过来，交给系统闹钟，App 关掉也能收到 */
        @JavascriptInterface
        public void setGoalReminders(String json) {
            try {
                GoalAlarmReceiver.scheduleAll(MainActivity.this, json == null ? "[]" : json);
            } catch (Exception e) {
                Log.w(TAG, "设置提醒失败", e);
            }
        }

        /** 生成备份文件并拉起系统分享面板（可选微信） */
        @JavascriptInterface
        public void shareBackup(String backup, String filename) {
            final String json = backup == null ? "" : backup;
            final String name = safeName(filename, "growth-backup.json");
            runOnUiThread(() -> {
                Uri uri = writeToDownloads(name, json);
                if (uri == null) {
                    // 低版本或写入失败：退回「另存为」
                    pendingBackup = json;
                    pendingBackupName = name;
                    Toast.makeText(MainActivity.this, "已改为手动选择保存位置", Toast.LENGTH_SHORT).show();
                    startExportPicker();
                    return;
                }
                Intent send = new Intent(Intent.ACTION_SEND);
                send.setType("application/json");
                send.putExtra(Intent.EXTRA_STREAM, uri);
                send.putExtra(Intent.EXTRA_SUBJECT, name);
                send.putExtra(Intent.EXTRA_TEXT, "成长日志备份文件。收到后可在 App「设置 → 导入备份」里恢复。");
                send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                try {
                    startActivity(Intent.createChooser(send, "发送备份到微信"));
                } catch (ActivityNotFoundException e) {
                    Toast.makeText(MainActivity.this,
                            "已保存到「下载/GrowthOS」，没有找到可分享的应用", Toast.LENGTH_LONG).show();
                }
            });
        }

        /** 静默自动存档，防止 localStorage 被系统清理 */
        @JavascriptInterface
        public void autoBackup(String backup) {
            if (backup == null || backup.length() < 2) return;
            try {
                writeAutoSnapshot(backup);
            } catch (Exception e) {
                Log.w(TAG, "自动存档失败", e);
            }
        }

        @JavascriptInterface
        public String readAutoBackup() {
            try {
                File f = new File(autoDir(), "auto-latest.json");
                if (!f.exists()) return "";
                return readFile(f);
            } catch (Exception e) {
                return "";
            }
        }

        @JavascriptInterface
        public void openAppSettings() {
            runOnUiThread(() -> {
                Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
                intent.setData(Uri.parse("package:" + getPackageName()));
                startActivity(intent);
            });
        }
    }

    /**
     * Android 11 及以上才有的窗口接口，单独放在内部类里，
     * 低版本系统不会加载到新 API，避免兼容问题。
     */
    private static final class Api30 {
        static int[] readInsets(WindowInsets insets) {
            Insets bars = insets.getInsets(
                    WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
            Insets ime = insets.getInsets(WindowInsets.Type.ime());
            // 键盘高度单独返回，用于把网页内容整体上移
            return new int[]{bars.top, bars.right, bars.bottom, bars.left, ime.bottom};
        }

        static void setBarsAppearance(Window window, boolean dark) {
            WindowInsetsController controller = window.getInsetsController();
            if (controller == null) return;
            int mask = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                    | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
            controller.setSystemBarsAppearance(dark ? 0 : mask, mask);
        }
    }
}
