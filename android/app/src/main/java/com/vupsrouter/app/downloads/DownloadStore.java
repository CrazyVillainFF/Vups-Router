package com.vupsrouter.app.downloads;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * Process-wide state for downloads. The foreground service writes here and the
 * Capacitor plugin reads from here, so both sides observe the same records even
 * while the WebView is paused or the app is in the background.
 */
public final class DownloadStore {

    public interface Listener {
        void onDownloadChanged(JSONObject snapshot);
    }

    private static final String PREFS = "vups_downloads";
    private static final String KEY_RECORDS = "records";
    private static final Object LOCK = new Object();
    private static final Map<String, DownloadRecord> RECORDS = new LinkedHashMap<>();
    private static final CopyOnWriteArrayList<Listener> LISTENERS = new CopyOnWriteArrayList<>();
    private static final Handler MAIN = new Handler(Looper.getMainLooper());

    private static Context appContext;
    private static SharedPreferences preferences;
    private static int nextNotificationId = 2100;

    private DownloadStore() {}

    public static void init(Context context) {
        synchronized (LOCK) {
            if (appContext != null) return;
            appContext = context.getApplicationContext();
            preferences = appContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            restoreLocked();
        }
    }

    public static DownloadRecord create(String filename, String mimeType) {
        DownloadRecord record = new DownloadRecord();
        record.id = UUID.randomUUID().toString();
        record.filename = filename;
        record.mimeType = mimeType;
        record.notificationId = nextNotificationId;
        nextNotificationId += 1;
        record.createdAt = System.currentTimeMillis();
        record.updatedAt = record.createdAt;
        return record;
    }

    /**
     * Registers a URL download on behalf of the WebView's DownloadListener. The
     * sensitive fields stay package-private so only this store can attach them.
     */
    public static DownloadRecord createForUrl(
            String filename,
            String mimeType,
            String sourceUrl,
            String userAgent,
            String cookie,
            long contentLength) {
        DownloadRecord record = create(filename, mimeType);
        record.sourceUrl = sourceUrl;
        record.userAgent = userAgent;
        record.cookie = cookie;
        record.total = contentLength > 0L ? contentLength : -1L;
        put(record);
        return record;
    }

    public static void put(DownloadRecord record) {
        synchronized (LOCK) {
            RECORDS.put(record.id, record);
            persistLocked();
        }
        emit(record);
    }

    public static DownloadRecord get(String id) {
        synchronized (LOCK) {
            return RECORDS.get(id);
        }
    }

    public static List<DownloadRecord> all() {
        List<DownloadRecord> copy;
        synchronized (LOCK) {
            copy = new ArrayList<>(RECORDS.values());
        }
        Collections.sort(copy, (left, right) -> Long.compare(right.createdAt, left.createdAt));
        return copy;
    }

    public static void update(DownloadRecord record) {
        record.updatedAt = System.currentTimeMillis();
        synchronized (LOCK) {
            RECORDS.put(record.id, record);
            persistLocked();
        }
        emit(record);
    }

    /** Progress ticks do not hit disk; status changes go through update(). */
    public static void progress(DownloadRecord record) {
        record.updatedAt = System.currentTimeMillis();
        emit(record);
    }

    public static void remove(String id) {
        synchronized (LOCK) {
            RECORDS.remove(id);
            persistLocked();
        }
    }

    public static void clearFinished() {
        List<String> removed = new ArrayList<>();
        synchronized (LOCK) {
            Iterator<Map.Entry<String, DownloadRecord>> iterator = RECORDS.entrySet().iterator();
            while (iterator.hasNext()) {
                DownloadRecord record = iterator.next().getValue();
                if (!record.isActive()) {
                    removed.add(record.id);
                    iterator.remove();
                }
            }
            persistLocked();
        }
        for (String id : removed) {
            JSONObject snapshot = new JSONObject();
            try {
                snapshot.put("id", id);
                snapshot.put("status", "removed");
            } catch (Exception ignored) {
            }
            dispatch(snapshot);
        }
    }

    public static void addListener(Listener listener) {
        if (listener != null) LISTENERS.addIfAbsent(listener);
    }

    public static void removeListener(Listener listener) {
        LISTENERS.remove(listener);
    }

    public static JSONObject snapshot(DownloadRecord record) {
        JSONObject json = new JSONObject();
        try {
            json.put("id", record.id);
            json.put("filename", record.filename);
            json.put("mimeType", record.mimeType);
            json.put("status", record.status);
            json.put("bytes", record.bytes);
            json.put("total", record.total);
            json.put("speedBytesPerSecond", record.speedBytesPerSecond);
            json.put("error", record.error == null ? JSONObject.NULL : record.error);
            json.put("createdAt", record.createdAt);
            json.put("updatedAt", record.updatedAt);
            json.put("canOpen", DownloadRecord.STATUS_COMPLETED.equals(record.status) && record.uri != null);
            json.put("canRetry", record.canRetry());
        } catch (Exception ignored) {
        }
        return json;
    }

    private static void emit(DownloadRecord record) {
        dispatch(snapshot(record));
    }

    private static void dispatch(JSONObject snapshot) {
        if (LISTENERS.isEmpty()) return;
        MAIN.post(() -> {
            for (Listener listener : LISTENERS) {
                try {
                    listener.onDownloadChanged(snapshot);
                } catch (Exception ignored) {
                }
            }
        });
    }

    private static void restoreLocked() {
        String raw = preferences.getString(KEY_RECORDS, "");
        if (raw == null || raw.isEmpty()) return;
        try {
            JSONArray array = new JSONArray(raw);
            for (int index = 0; index < array.length(); index += 1) {
                JSONObject json = array.optJSONObject(index);
                if (json == null) continue;
                DownloadRecord record = new DownloadRecord();
                record.id = json.optString("id", "");
                if (record.id.isEmpty()) continue;
                record.filename = json.optString("filename", "download");
                record.mimeType = json.optString("mimeType", "application/octet-stream");
                record.status = json.optString("status", DownloadRecord.STATUS_FAILED);
                record.bytes = json.optLong("bytes", 0L);
                record.total = json.optLong("total", -1L);
                record.error = json.isNull("error") ? null : json.optString("error", null);
                record.uri = json.isNull("uri") ? null : json.optString("uri", null);
                record.createdAt = json.optLong("createdAt", System.currentTimeMillis());
                record.updatedAt = json.optLong("updatedAt", record.createdAt);
                record.notificationId = json.optInt("notificationId", nextNotificationId);
                if (record.notificationId >= nextNotificationId) {
                    nextNotificationId = record.notificationId + 1;
                }
                record.sourceUrl = json.isNull("sourceUrl") ? null : json.optString("sourceUrl", null);
                record.userAgent = json.isNull("userAgent") ? null : json.optString("userAgent", null);
                record.cookie = json.isNull("cookie") ? null : json.optString("cookie", null);
                if (record.isActive()) {
                    record.status = DownloadRecord.STATUS_FAILED;
                    record.error = "The app stopped before this download finished. Tap retry to start again.";
                }
                RECORDS.put(record.id, record);
            }
        } catch (Exception ignored) {
        }
    }

    private static void persistLocked() {
        if (preferences == null) return;
        JSONArray array = new JSONArray();
        for (DownloadRecord record : RECORDS.values()) {
            JSONObject json = new JSONObject();
            try {
                json.put("id", record.id);
                json.put("filename", record.filename);
                json.put("mimeType", record.mimeType);
                json.put("status", record.status);
                json.put("bytes", record.bytes);
                json.put("total", record.total);
                json.put("error", record.error == null ? JSONObject.NULL : record.error);
                json.put("uri", record.uri == null ? JSONObject.NULL : record.uri);
                json.put("createdAt", record.createdAt);
                json.put("updatedAt", record.updatedAt);
                json.put("notificationId", record.notificationId);
                json.put("sourceUrl", record.sourceUrl == null ? JSONObject.NULL : record.sourceUrl);
                json.put("userAgent", record.userAgent == null ? JSONObject.NULL : record.userAgent);
                json.put("cookie", record.cookie == null ? JSONObject.NULL : record.cookie);
            } catch (Exception ignored) {
            }
            array.put(json);
        }
        preferences.edit().putString(KEY_RECORDS, array.toString()).apply();
    }
}
