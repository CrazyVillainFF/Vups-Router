package com.vupsrouter.app.downloads;

import java.net.HttpURLConnection;

public class DownloadRecord {

    public static final String STATUS_QUEUED = "queued";
    public static final String STATUS_RUNNING = "running";
    public static final String STATUS_COMPLETED = "completed";
    public static final String STATUS_FAILED = "failed";
    public static final String STATUS_CANCELLED = "cancelled";

    public String id = "";
    public String filename = "download";
    public String mimeType = "application/octet-stream";
    public String status = STATUS_QUEUED;
    public long bytes = 0L;
    public long total = -1L;
    public long speedBytesPerSecond = 0L;
    public String error;
    public String uri;
    public long createdAt = 0L;
    public long updatedAt = 0L;
    public int notificationId = 0;

    /** Kept out of every notification and JS payload; only used to resume a retry. */
    String sourceUrl;
    String tempPath;
    String userAgent;
    String cookie;

    public volatile boolean cancelRequested = false;
    public volatile HttpURLConnection connection;

    public boolean isActive() {
        return STATUS_QUEUED.equals(status) || STATUS_RUNNING.equals(status);
    }

    public boolean canRetry() {
        return (STATUS_FAILED.equals(status) || STATUS_CANCELLED.equals(status))
                && (sourceUrl != null || tempPath != null);
    }
}
