package com.vupsrouter.app.downloads;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.util.Base64;

import androidx.core.app.NotificationManagerCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONException;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.util.List;

@CapacitorPlugin(
        name = "VupsDownloads",
        permissions = {
                @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
        })
public class VupsDownloadsPlugin extends Plugin {

    /** 64 MB of base64 stays well below a WebView bridge that can stall on huge payloads. */
    private static final int MAX_BASE64_CHARS = 64 * 1024 * 1024;
    private static final String DEFAULT_MIME = "application/octet-stream";

    private DownloadStore.Listener listener;

    @Override
    public void load() {
        DownloadStore.init(getContext());
        listener = snapshot -> {
            try {
                notifyListeners("download", new JSObject(snapshot.toString()));
            } catch (JSONException ignored) {
            }
        };
        DownloadStore.addListener(listener);
    }

    @Override
    protected void handleOnDestroy() {
        DownloadStore.removeListener(listener);
    }

    @PluginMethod
    public void saveBlob(PluginCall call) {
        String data = call.getString("base64");
        if (data == null || data.isEmpty()) {
            call.reject("The file data is empty.");
            return;
        }
        if (data.length() > MAX_BASE64_CHARS) {
            call.reject("This file is too large to download on this device.");
            return;
        }
        String filename = sanitizeFilename(call.getString("filename"));
        String mimeType = normalizeMime(call.getString("mimeType"));
        DownloadStore.init(getContext());
        DownloadRecord record = DownloadStore.create(filename, mimeType);

        getBridge().execute(() -> {
            File directory = new File(getContext().getCacheDir(), "downloads");
            if (!directory.isDirectory() && !directory.mkdirs()) {
                call.reject("The download could not be prepared on this device.");
                return;
            }
            File temp = new File(directory, record.id + ".part");
            try (OutputStream output = new FileOutputStream(temp)) {
                output.write(Base64.decode(data, Base64.DEFAULT));
            } catch (Exception error) {
                temp.delete();
                call.reject("The download could not be prepared on this device.");
                return;
            }
            record.tempPath = temp.getAbsolutePath();
            record.total = temp.length();
            DownloadStore.put(record);
            DownloadService.enqueue(getContext(), record.id);
            JSObject result = new JSObject();
            result.put("id", record.id);
            call.resolve(result);
        });
    }

    @PluginMethod
    public void enqueue(PluginCall call) {
        String rawUrl = call.getString("url");
        if (rawUrl == null || rawUrl.trim().isEmpty()) {
            call.reject("A download address is required.");
            return;
        }
        Uri uri;
        try {
            uri = Uri.parse(rawUrl.trim());
        } catch (Exception error) {
            call.reject("That download address is not valid.");
            return;
        }
        String scheme = uri.getScheme();
        if (!"https".equals(scheme) && !"http".equals(scheme)) {
            call.reject("Only http and https downloads are allowed.");
            return;
        }
        if (uri.getUserInfo() != null) {
            call.reject("Download addresses with embedded credentials are not allowed.");
            return;
        }
        String filename = sanitizeFilename(call.getString("filename"));
        if ("download".equals(filename)) {
            String lastSegment = uri.getLastPathSegment();
            if (lastSegment != null && !lastSegment.isEmpty()) filename = sanitizeFilename(lastSegment);
        }
        DownloadStore.init(getContext());
        DownloadRecord record = DownloadStore.create(filename, normalizeMime(call.getString("mimeType")));
        record.sourceUrl = uri.toString();
        record.total = -1L;
        DownloadStore.put(record);
        DownloadService.enqueue(getContext(), record.id);
        JSObject result = new JSObject();
        result.put("id", record.id);
        call.resolve(result);
    }

    @PluginMethod
    public void list(PluginCall call) {
        DownloadStore.init(getContext());
        JSArray downloads = new JSArray();
        List<DownloadRecord> records = DownloadStore.all();
        for (DownloadRecord record : records) {
            downloads.put(DownloadStore.snapshot(record));
        }
        JSObject result = new JSObject();
        result.put("downloads", downloads);
        call.resolve(result);
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        DownloadRecord record = findRecord(call);
        if (record == null) {
            call.reject("That download no longer exists.");
            return;
        }
        if (record.isActive()) {
            DownloadService.cancel(getContext(), record.id);
        }
        JSObject result = new JSObject();
        result.put("cancelled", record.isActive());
        call.resolve(result);
    }

    @PluginMethod
    public void retry(PluginCall call) {
        DownloadRecord record = findRecord(call);
        if (record == null) {
            call.reject("That download no longer exists.");
            return;
        }
        if (!record.canRetry()) {
            call.reject("This download cannot be retried. Start it again from the app.");
            return;
        }
        DownloadService.retry(getContext(), record.id);
        call.resolve();
    }

    @PluginMethod
    public void openFile(PluginCall call) {
        DownloadRecord record = findRecord(call);
        if (record == null) {
            call.reject("That download no longer exists.");
            return;
        }
        Intent view = DownloadService.buildOpenIntent(record);
        if (view == null) {
            call.reject("This file is not ready to open yet.");
            return;
        }
        Activity activity = getActivity();
        if (activity == null) {
            call.reject("Open the app to view this file.");
            return;
        }
        try {
            activity.startActivity(Intent.createChooser(view, "Open " + record.filename));
            call.resolve();
        } catch (Exception error) {
            call.reject("No app on this device can open this file.");
        }
    }

    @PluginMethod
    public void clearFinished(PluginCall call) {
        DownloadStore.init(getContext());
        NotificationManagerCompat manager = NotificationManagerCompat.from(getContext());
        for (DownloadRecord record : DownloadStore.all()) {
            if (!record.isActive()) manager.cancel(record.notificationId);
        }
        DownloadStore.clearFinished();
        call.resolve();
    }

    @PluginMethod
    public void notificationsStatus(PluginCall call) {
        call.resolve(notificationStatus());
    }

    @PluginMethod
    public void requestNotifications(PluginCall call) {
        if (notificationsGranted()) {
            call.resolve(notificationStatus());
            return;
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            call.resolve(notificationStatus());
            return;
        }
        requestPermissionForAlias("notifications", call, "notificationsCallback");
    }

    @PermissionCallback
    private void notificationsCallback(PluginCall call) {
        call.resolve(notificationStatus());
    }

    private JSObject notificationStatus() {
        boolean granted = notificationsGranted();
        boolean canRequest = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && !granted;
        JSObject result = new JSObject();
        result.put("granted", granted);
        result.put("canRequest", canRequest);
        result.put("enabled", NotificationManagerCompat.from(getContext()).areNotificationsEnabled());
        return result;
    }

    private boolean notificationsGranted() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true;
        return getContext().checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED;
    }

    private DownloadRecord findRecord(PluginCall call) {
        String id = call.getString("id");
        if (id == null || id.isEmpty()) return null;
        DownloadStore.init(getContext());
        return DownloadStore.get(id);
    }

    private static String sanitizeFilename(String value) {
        String name = value == null ? "" : value.trim();
        int slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
        if (slash >= 0) name = name.substring(slash + 1);
        name = name.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim();
        if (name.length() > 120) name = name.substring(0, 120);
        return name.isEmpty() || ".".equals(name) || "..".equals(name) ? "download" : name;
    }

    private static String normalizeMime(String value) {
        if (value == null) return DEFAULT_MIME;
        String mime = value.trim();
        int separator = mime.indexOf(';');
        if (separator >= 0) mime = mime.substring(0, separator).trim();
        return mime.isEmpty() ? DEFAULT_MIME : mime;
    }
}
