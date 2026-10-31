package com.vupsrouter.app.downloads;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.IBinder;
import android.provider.MediaStore;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.ConnectException;
import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.net.UnknownHostException;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Foreground service that keeps downloads alive when the WebView is paused,
 * the app is backgrounded, or the screen is locked. Every download has its own
 * notification; the currently promoted download owns the foreground slot.
 */
public class DownloadService extends Service {

    public static final String ACTION_START = "com.vupsrouter.app.downloads.START";
    public static final String ACTION_RETRY = "com.vupsrouter.app.downloads.RETRY";
    public static final String ACTION_CANCEL = "com.vupsrouter.app.downloads.CANCEL";
    public static final String EXTRA_ID = "download_id";

    private static final String CHANNEL_ID = "vups_downloads";
    private static final String GROUP_KEY = "com.vupsrouter.app.downloads";
    private static final long PROGRESS_EMIT_MS = 400L;
    private static final int SUMMARY_ID = 2099;

    private final ExecutorService executor = Executors.newFixedThreadPool(3);
    private final Map<String, Future<?>> jobs = new ConcurrentHashMap<>();
    private final AtomicInteger activeCount = new AtomicInteger();
    private volatile int foregroundNotificationId = 0;

    public static void enqueue(Context context, String downloadId) {
        Intent intent = new Intent(context, DownloadService.class);
        intent.setAction(ACTION_START);
        intent.putExtra(EXTRA_ID, downloadId);
        ContextCompat.startForegroundService(context, intent);
    }

    public static void retry(Context context, String downloadId) {
        Intent intent = new Intent(context, DownloadService.class);
        intent.setAction(ACTION_RETRY);
        intent.putExtra(EXTRA_ID, downloadId);
        ContextCompat.startForegroundService(context, intent);
    }

    public static void cancel(Context context, String downloadId) {
        Intent intent = new Intent(context, DownloadService.class);
        intent.setAction(ACTION_CANCEL);
        intent.putExtra(EXTRA_ID, downloadId);
        ContextCompat.startForegroundService(context, intent);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();
        DownloadStore.init(this);
    }

    @Override
    public int onStartCommand(@Nullable Intent intent, int flags, int startId) {
        if (intent == null) {
            stopSelf();
            return START_NOT_STICKY;
        }
        String id = intent.getStringExtra(EXTRA_ID);
        DownloadRecord record = id == null ? null : DownloadStore.get(id);
        if (record == null) {
            stopSelf();
            return START_NOT_STICKY;
        }
        String action = intent.getAction() == null ? "" : intent.getAction();
        if (ACTION_CANCEL.equals(action)) {
            // Every startForegroundService() call owes the system a
            // startForeground() within five seconds, including a quick cancel.
            startForegroundFor(record);
            cancelRecord(record);
            if (jobs.get(record.id) == null && !record.isActive()) syncForeground();
            return START_NOT_STICKY;
        }
        if (ACTION_RETRY.equals(action)) {
            if (record.isActive()) {
                startForegroundFor(record);
                return START_NOT_STICKY;
            }
            record.status = DownloadRecord.STATUS_QUEUED;
            record.error = null;
            record.bytes = 0L;
            record.total = -1L;
            record.speedBytesPerSecond = 0L;
            record.cancelRequested = false;
            DownloadStore.update(record);
            startForegroundFor(record);
            dispatch(record);
            return START_NOT_STICKY;
        }
        startForegroundFor(record);
        if (!record.isActive()) {
            syncForeground();
            return START_NOT_STICKY;
        }
        dispatch(record);
        return START_NOT_STICKY;
    }

    private void dispatch(DownloadRecord record) {
        if (!record.isActive()) return;
        if (jobs.containsKey(record.id)) return;
        activeCount.incrementAndGet();
        jobs.put(record.id, executor.submit(() -> runJob(record)));
    }

    private void cancelRecord(DownloadRecord record) {
        record.cancelRequested = true;
        HttpURLConnection connection = record.connection;
        if (connection != null) {
            try {
                connection.disconnect();
            } catch (Exception ignored) {
            }
        }
        Future<?> job = jobs.get(record.id);
        if (job != null) job.cancel(true);
        if (DownloadRecord.STATUS_QUEUED.equals(record.status)) {
            finishCancelled(record);
            syncForeground();
        }
    }

    private void runJob(DownloadRecord record) {
        Destination destination = null;
        try {
            if (record.cancelRequested) {
                finishCancelled(record);
                return;
            }
            record.status = DownloadRecord.STATUS_RUNNING;
            record.error = null;
            DownloadStore.update(record);
            destination = transfer(record);
            if (record.cancelRequested) {
                destination.discard();
                destination = null;
                finishCancelled(record);
                return;
            }
            destination.finish();
            record.uri = destination.uriString;
            destination = null;
            record.status = DownloadRecord.STATUS_COMPLETED;
            record.speedBytesPerSecond = 0L;
            if (record.total <= 0) record.total = record.bytes;
            DownloadStore.update(record);
            notifyRecord(record);
        } catch (Throwable error) {
            if (destination != null) destination.discard();
            if (record.cancelRequested || error instanceof CancelledDownload) {
                finishCancelled(record);
            } else {
                record.status = DownloadRecord.STATUS_FAILED;
                record.error = friendlyError(error);
                record.speedBytesPerSecond = 0L;
                DownloadStore.update(record);
                notifyRecord(record);
            }
        } finally {
            if (record.tempPath != null) {
                try {
                    new File(record.tempPath).delete();
                } catch (Exception ignored) {
                }
                record.tempPath = null;
                if (DownloadRecord.STATUS_FAILED.equals(record.status)) {
                    DownloadStore.update(record);
                }
            }
            record.connection = null;
            jobs.remove(record.id);
            activeCount.decrementAndGet();
            syncForeground();
        }
    }

    private Destination transfer(DownloadRecord record) throws Exception {
        InputStream input;
        long total;
        if (record.tempPath != null) {
            File temp = new File(record.tempPath);
            if (!temp.isFile()) throw new IOException("The prepared file is no longer available.");
            input = new BufferedInputStream(new FileInputStream(temp));
            total = temp.length();
        } else {
            if (record.sourceUrl == null) throw new IOException("This download cannot be started again.");
            URL url = new URL(record.sourceUrl);
            String protocol = url.getProtocol();
            if (!"https".equals(protocol) && !"http".equals(protocol)) {
                throw new IOException("Only http and https downloads are allowed.");
            }
            HttpURLConnection connection = (HttpURLConnection) url.openConnection();
            record.connection = connection;
            connection.setInstanceFollowRedirects(true);
            connection.setConnectTimeout(30000);
            connection.setReadTimeout(60000);
            connection.setRequestProperty("Accept", "*/*");
            if (record.userAgent != null) connection.setRequestProperty("User-Agent", record.userAgent);
            if (record.cookie != null) connection.setRequestProperty("Cookie", record.cookie);
            int status = connection.getResponseCode();
            if (status < 200 || status >= 300) {
                connection.disconnect();
                throw new HttpStatusException(status);
            }
            String contentType = connection.getContentType();
            if (contentType != null && (record.mimeType == null || record.mimeType.isEmpty()
                    || "application/octet-stream".equals(record.mimeType))) {
                int separator = contentType.indexOf(';');
                record.mimeType = separator >= 0 ? contentType.substring(0, separator) : contentType;
            }
            total = connection.getContentLengthLong();
            input = connection.getInputStream();
        }

        record.total = total > 0 ? total : -1L;
        Destination destination = openDestination(record);
        OutputStream output = destination.stream;
        byte[] buffer = new byte[64 * 1024];
        long lastEmit = 0L;
        long windowStart = System.currentTimeMillis();
        long windowBytes = 0L;
        try {
            int read;
            while ((read = input.read(buffer)) != -1) {
                if (record.cancelRequested || Thread.currentThread().isInterrupted()) {
                    throw new CancelledDownload();
                }
                output.write(buffer, 0, read);
                record.bytes += read;
                long now = System.currentTimeMillis();
                if (now - lastEmit >= PROGRESS_EMIT_MS) {
                    long elapsed = now - windowStart;
                    if (elapsed >= 500L) {
                        record.speedBytesPerSecond = Math.max(0L, (record.bytes - windowBytes) * 1000L / elapsed);
                        windowStart = now;
                        windowBytes = record.bytes;
                    }
                    DownloadStore.progress(record);
                    notifyRecord(record);
                    lastEmit = now;
                }
            }
        } finally {
            try {
                input.close();
            } catch (Exception ignored) {
            }
        }
        output.flush();
        return destination;
    }

    private void finishCancelled(DownloadRecord record) {
        record.status = DownloadRecord.STATUS_CANCELLED;
        record.speedBytesPerSecond = 0L;
        record.error = null;
        DownloadStore.update(record);
        notifyRecord(record);
    }

    private Destination openDestination(DownloadRecord record) throws IOException {
        String filename = safeFilename(record.filename);
        String mime = record.mimeType == null || record.mimeType.isEmpty()
                ? "application/octet-stream" : record.mimeType;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ContentResolver resolver = getContentResolver();
            String relativePath = Environment.DIRECTORY_DOWNLOADS + "/VupsRouter/";
            ContentValues values = new ContentValues();
            values.put(MediaStore.Downloads.DISPLAY_NAME, uniqueMediaName(resolver, relativePath, filename));
            values.put(MediaStore.Downloads.MIME_TYPE, mime);
            values.put(MediaStore.Downloads.RELATIVE_PATH, relativePath);
            values.put(MediaStore.Downloads.IS_PENDING, 1);
            Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (uri == null) throw new IOException("Android could not create the download file.");
            OutputStream stream = resolver.openOutputStream(uri);
            if (stream == null) {
                resolver.delete(uri, null, null);
                throw new IOException("Android could not open the download file.");
            }
            return new Destination(this, stream, uri, null, mime);
        }
        File directory = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
        if (directory == null) directory = new File(getFilesDir(), "Downloads");
        if (!directory.isDirectory() && !directory.mkdirs()) {
            throw new IOException("The downloads folder could not be created.");
        }
        File file = uniqueFile(directory, filename);
        OutputStream stream = new FileOutputStream(file);
        Uri uri = FileProvider.getUriForFile(this, getPackageName() + ".fileprovider", file);
        return new Destination(this, stream, uri, file, mime);
    }

    private static String uniqueMediaName(ContentResolver resolver, String relativePath, String filename) {
        Set<String> existing = new HashSet<>();
        try (Cursor cursor = resolver.query(
                MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                new String[] { MediaStore.Downloads.DISPLAY_NAME },
                MediaStore.Downloads.RELATIVE_PATH + "=?",
                new String[] { relativePath },
                null)) {
            if (cursor != null) {
                while (cursor.moveToNext()) {
                    String name = cursor.getString(0);
                    if (name != null) existing.add(name);
                }
            }
        } catch (Exception ignored) {
        }
        return numberedName(filename, existing);
    }

    private static File uniqueFile(File directory, String filename) {
        File candidate = new File(directory, filename);
        if (!candidate.exists()) return candidate;
        String base = filename;
        String extension = "";
        int dot = filename.lastIndexOf('.');
        if (dot > 0) {
            base = filename.substring(0, dot);
            extension = filename.substring(dot);
        }
        for (int index = 1; index < 1000; index += 1) {
            candidate = new File(directory, base + " (" + index + ")" + extension);
            if (!candidate.exists()) return candidate;
        }
        return new File(directory, base + "-" + System.currentTimeMillis() + extension);
    }

    private static String numberedName(String filename, Set<String> existing) {
        if (!existing.contains(filename)) return filename;
        String base = filename;
        String extension = "";
        int dot = filename.lastIndexOf('.');
        if (dot > 0) {
            base = filename.substring(0, dot);
            extension = filename.substring(dot);
        }
        for (int index = 1; index < 1000; index += 1) {
            String candidate = base + " (" + index + ")" + extension;
            if (!existing.contains(candidate)) return candidate;
        }
        return base + "-" + System.currentTimeMillis() + extension;
    }

    private static String safeFilename(String value) {
        String name = value == null ? "" : value.trim();
        if (name.isEmpty()) name = "download";
        name = name.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_");
        if (name.length() > 120) name = name.substring(0, 120);
        return name.isEmpty() ? "download" : name;
    }

    private void promoteForeground() {
        DownloadRecord next = null;
        for (DownloadRecord record : DownloadStore.all()) {
            if (record.isActive() && jobs.containsKey(record.id)) {
                next = record;
                break;
            }
        }
        if (next != null) {
            startForegroundFor(next);
        }
    }

    private void startForegroundFor(DownloadRecord record) {
        Notification notification = buildNotification(record, true);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(record.notificationId, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
            } else {
                startForeground(record.notificationId, notification);
            }
            foregroundNotificationId = record.notificationId;
        } catch (Throwable ignored) {
            // Without the foreground slot the download still runs while the app
            // process is alive; notifications and the in-app panel stay accurate.
            foregroundNotificationId = 0;
        }
        NotificationManagerCompat.from(this).notify(record.notificationId, notification);
    }

    private void syncForeground() {
        if (activeCount.get() > 0) {
            promoteForeground();
            return;
        }
        if (foregroundNotificationId != 0) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                stopForeground(STOP_FOREGROUND_DETACH);
            } else {
                stopForeground(false);
            }
            foregroundNotificationId = 0;
        }
        stopSelf();
    }

    private void notifyRecord(DownloadRecord record) {
        NotificationManagerCompat.from(this).notify(record.notificationId, buildNotification(record, false));
    }

    private Notification buildNotification(DownloadRecord record, boolean foreground) {
        boolean active = record.isActive();
        String title;
        String text;
        String subText = null;
        int smallIcon = android.R.drawable.stat_sys_download;

        if (DownloadRecord.STATUS_QUEUED.equals(record.status)) {
            title = "Downloading file";
            text = record.filename + " · Preparing download…";
        } else if (DownloadRecord.STATUS_RUNNING.equals(record.status)) {
            title = "Downloading file";
            if (record.total > 0) {
                int percent = (int) Math.min(100L, Math.max(0L, record.bytes * 100L / record.total));
                text = record.filename + " · " + percent + "% · "
                        + formatBytes(record.bytes) + " of " + formatBytes(record.total);
            } else {
                text = record.filename + " · " + formatBytes(record.bytes) + " downloaded";
            }
        } else if (DownloadRecord.STATUS_COMPLETED.equals(record.status)) {
            title = "Download complete";
            text = record.filename;
            subText = "Tap to open";
            smallIcon = android.R.drawable.stat_sys_download_done;
        } else if (DownloadRecord.STATUS_CANCELLED.equals(record.status)) {
            title = "Download cancelled";
            text = record.filename;
            smallIcon = android.R.drawable.stat_notify_error;
        } else {
            title = "Download failed";
            text = record.filename;
            subText = record.error == null ? "Tap to retry" : record.error + " Tap to retry.";
            smallIcon = android.R.drawable.stat_notify_error;
        }

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(smallIcon)
                .setContentTitle(title)
                .setContentText(text)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(subText == null ? text : text + "\n" + subText))
                .setOnlyAlertOnce(true)
                .setOngoing(active)
                .setAutoCancel(false)
                .setShowWhen(false)
                .setCategory(active ? NotificationCompat.CATEGORY_PROGRESS : NotificationCompat.CATEGORY_STATUS)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setGroup(GROUP_KEY)
                .setVisibility(NotificationCompat.VISIBILITY_PRIVATE);
        if (subText != null) builder.setSubText(subText);

        PendingIntent cancelIntent = PendingIntent.getService(
                this,
                record.notificationId * 10 + 1,
                new Intent(this, DownloadService.class).setAction(ACTION_CANCEL).putExtra(EXTRA_ID, record.id),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        PendingIntent retryIntent = PendingIntent.getService(
                this,
                record.notificationId * 10 + 2,
                new Intent(this, DownloadService.class).setAction(ACTION_RETRY).putExtra(EXTRA_ID, record.id),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        if (DownloadRecord.STATUS_COMPLETED.equals(record.status) && record.uri != null) {
            PendingIntent openIntent = openPendingIntent(record);
            if (openIntent != null) {
                builder.setContentIntent(openIntent);
                builder.addAction(android.R.drawable.ic_menu_view, "Open", openIntent);
            }
        } else if (DownloadRecord.STATUS_FAILED.equals(record.status)
                || DownloadRecord.STATUS_CANCELLED.equals(record.status)) {
            builder.addAction(android.R.drawable.ic_menu_rotate, "Retry", retryIntent);
            if (record.canRetry()) builder.setContentIntent(retryIntent);
        } else {
            Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
            if (launch != null) {
                builder.setContentIntent(PendingIntent.getActivity(
                        this,
                        record.notificationId * 10 + 3,
                        launch,
                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
            }
            builder.addAction(android.R.drawable.ic_menu_close_clear_cancel, "Cancel", cancelIntent);
        }

        if (DownloadRecord.STATUS_RUNNING.equals(record.status) && record.total > 0) {
            int percent = (int) Math.min(100L, Math.max(0L, record.bytes * 100L / record.total));
            builder.setProgress(100, percent, false);
        } else if (active) {
            builder.setProgress(0, 0, true);
        }

        Notification notification = builder.build();
        notification.flags |= Notification.FLAG_NO_CLEAR;
        if (DownloadRecord.STATUS_COMPLETED.equals(record.status)
                || DownloadRecord.STATUS_FAILED.equals(record.status)
                || DownloadRecord.STATUS_CANCELLED.equals(record.status)) {
            notification.flags &= ~Notification.FLAG_NO_CLEAR;
        }
        return notification;
    }

    public PendingIntent openPendingIntent(DownloadRecord record) {
        Intent view = buildOpenIntent(record);
        if (view == null) return null;
        return PendingIntent.getActivity(
                this,
                record.notificationId * 10 + 4,
                Intent.createChooser(view, "Open " + record.filename),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    public static Intent buildOpenIntent(DownloadRecord record) {
        if (record == null || record.uri == null) return null;
        Uri uri;
        try {
            uri = Uri.parse(record.uri);
        } catch (Exception error) {
            return null;
        }
        Intent view = new Intent(Intent.ACTION_VIEW);
        view.setDataAndType(uri, record.mimeType == null ? "*/*" : record.mimeType);
        view.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        return view;
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) return;
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                getString(com.vupsrouter.app.R.string.download_channel_name),
                NotificationManager.IMPORTANCE_LOW);
        channel.setDescription(getString(com.vupsrouter.app.R.string.download_channel_description));
        channel.setShowBadge(false);
        manager.createNotificationChannel(channel);
    }

    private static String friendlyError(Throwable error) {
        if (error instanceof HttpStatusException) {
            int status = ((HttpStatusException) error).status;
            if (status == 401 || status == 403) return "The server did not allow this download. Sign in again and retry.";
            if (status == 404) return "That file is no longer available on the server.";
            if (status == 429) return "The download server is busy. Wait a moment and retry.";
            return "The server returned HTTP " + status + ". Tap to retry.";
        }
        if (error instanceof UnknownHostException) return "The download server could not be found. Check your connection.";
        if (error instanceof SocketTimeoutException) return "The download timed out. Tap to retry.";
        if (error instanceof ConnectException) return "Could not connect to the download server. Try again.";
        if (error instanceof SecurityException) return "Android blocked saving this file. Check storage access.";
        if (error instanceof IOException) return "The file could not be saved. Check free space and try again.";
        return "The download failed. Tap to retry.";
    }

    private static String formatBytes(long bytes) {
        if (bytes < 1024L) return bytes + " B";
        double value = bytes / 1024.0;
        if (value < 1024.0) return String.format(java.util.Locale.US, "%.1f KB", value);
        value /= 1024.0;
        if (value < 1024.0) return String.format(java.util.Locale.US, "%.1f MB", value);
        return String.format(java.util.Locale.US, "%.1f GB", value / 1024.0);
    }

    @Override
    public void onDestroy() {
        for (DownloadRecord record : DownloadStore.all()) {
            if (record.isActive()) {
                record.status = DownloadRecord.STATUS_FAILED;
                record.error = "The app stopped before this download finished. Tap retry to start again.";
                record.speedBytesPerSecond = 0L;
                DownloadStore.update(record);
            }
        }
        executor.shutdownNow();
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private static final class HttpStatusException extends IOException {
        final int status;

        HttpStatusException(int status) {
            super("HTTP " + status);
            this.status = status;
        }
    }

    private static final class CancelledDownload extends IOException {}

    private static final class Destination {
        final Context context;
        final OutputStream stream;
        final Uri uri;
        final File file;
        final String mimeType;
        String uriString;

        Destination(Context context, OutputStream stream, Uri uri, File file, String mimeType) {
            this.context = context;
            this.stream = stream;
            this.uri = uri;
            this.file = file;
            this.mimeType = mimeType;
            this.uriString = uri == null ? null : uri.toString();
        }

        void finish() throws IOException {
            try {
                stream.flush();
            } finally {
                try {
                    stream.close();
                } catch (Exception ignored) {
                }
            }
            if (uri != null && file == null) {
                ContentValues values = new ContentValues();
                values.put(MediaStore.Downloads.IS_PENDING, 0);
                context.getContentResolver().update(uri, values, null, null);
            }
        }

        void discard() {
            try {
                stream.close();
            } catch (Exception ignored) {
            }
            try {
                if (uri != null && file == null) {
                    context.getContentResolver().delete(uri, null, null);
                } else if (file != null) {
                    file.delete();
                }
            } catch (Exception ignored) {
            }
        }
    }
}
