package com.vupsrouter.app;

import android.os.Bundle;
import android.webkit.CookieManager;
import android.webkit.URLUtil;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;
import com.vupsrouter.app.downloads.DownloadRecord;
import com.vupsrouter.app.downloads.DownloadService;
import com.vupsrouter.app.downloads.DownloadStore;
import com.vupsrouter.app.downloads.VupsDownloadsPlugin;
import com.vupsrouter.app.updates.VupsAppInfoPlugin;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(VupsDownloadsPlugin.class);
        registerPlugin(VupsAppInfoPlugin.class);
        super.onCreate(savedInstanceState);
        DownloadStore.init(this);
        WebView webView = bridge == null ? null : bridge.getWebView();
        if (webView == null) return;
        // Links answered with a file (installers, release assets) arrive here
        // before the WebView tries to render them; hand them to the download
        // service so they survive backgrounding and get real notifications.
        webView.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) -> {
            if (url == null) return;
            if (!url.startsWith("https://") && !url.startsWith("http://")) return;
            String filename = URLUtil.guessFileName(url, contentDisposition, mimeType);
            DownloadRecord record = DownloadStore.createForUrl(
                    filename,
                    mimeType,
                    url,
                    userAgent,
                    CookieManager.getInstance().getCookie(url),
                    contentLength);
            DownloadService.enqueue(MainActivity.this, record.id);
        });
    }
}
