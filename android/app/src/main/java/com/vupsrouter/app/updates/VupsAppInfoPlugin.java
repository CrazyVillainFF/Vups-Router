package com.vupsrouter.app.updates;

import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.vupsrouter.app.downloads.DownloadRecord;
import com.vupsrouter.app.downloads.DownloadStore;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.security.MessageDigest;
import java.util.LinkedHashSet;
import java.util.Set;

/**
 * Exposes the installed build and opens Android's own package installer for a
 * verified update. Verification happens here, not in the WebView: the package
 * must carry this app id, the same signing identity, and a higher version code
 * before an installer intent is ever created. Nothing is uninstalled.
 */
@CapacitorPlugin(name = "VupsAppInfo")
public class VupsAppInfoPlugin extends Plugin {

    private static final long MAX_UPDATE_BYTES = 512L * 1024L * 1024L;

    @PluginMethod
    public void info(PluginCall call) {
        try {
            PackageManager manager = getContext().getPackageManager();
            PackageInfo installed = manager.getPackageInfo(getContext().getPackageName(), 0);
            JSObject result = new JSObject();
            result.put("version", installed.versionName == null ? "" : installed.versionName);
            result.put("build", versionCode(installed));
            result.put("packageId", getContext().getPackageName());
            call.resolve(result);
        } catch (Exception error) {
            call.reject("The installed app version could not be read.");
        }
    }

    @PluginMethod
    public void installUpdate(PluginCall call) {
        String id = call.getString("id");
        if (id == null || id.trim().isEmpty()) {
            call.reject("Choose a downloaded update first.");
            return;
        }
        DownloadStore.init(getContext());
        DownloadRecord record = DownloadStore.get(id.trim());
        if (record == null) {
            call.reject("That update download no longer exists.");
            return;
        }
        if (!DownloadRecord.STATUS_COMPLETED.equals(record.status) || record.uri == null) {
            call.reject("The update is still downloading. Wait for it to finish.");
            return;
        }
        getBridge().execute(() -> verifyAndOpen(record, call));
    }

    private void verifyAndOpen(DownloadRecord record, PluginCall call) {
        File apk = null;
        try {
            File directory = new File(getContext().getCacheDir(), "updates");
            if (!directory.isDirectory() && !directory.mkdirs()) {
                call.reject("The update could not be prepared on this device.");
                return;
            }
            apk = copyPackage(record, directory);
            if (apk == null) {
                call.reject("The downloaded update file is not available.");
                return;
            }

            PackageManager manager = getContext().getPackageManager();
            int flags = signingFlags();
            PackageInfo archive = manager.getPackageArchiveInfo(apk.getAbsolutePath(), flags);
            if (archive == null || archive.packageName == null) {
                call.reject("This file is not a valid Android app package.");
                return;
            }
            if (!getContext().getPackageName().equals(archive.packageName)) {
                call.reject("This update belongs to a different app and was not opened for installation.");
                return;
            }

            PackageInfo installed = manager.getPackageInfo(getContext().getPackageName(), flags);
            Set<String> installedSigners = fingerprints(installed);
            Set<String> archiveSigners = fingerprints(archive);
            if (archiveSigners.isEmpty()) {
                call.reject("The update's signing certificate could not be read, so it was not opened for installation.");
                return;
            }
            boolean signerMatches = false;
            for (String signer : archiveSigners) {
                if (installedSigners.contains(signer)) {
                    signerMatches = true;
                    break;
                }
            }
            if (!signerMatches) {
                call.reject(
                        "This update is signed with a different certificate than the installed app, so Android cannot apply it over this installation. Install a build signed with the same key.");
                return;
            }

            long targetCode = versionCode(archive);
            long installedCode = versionCode(installed);
            if (targetCode <= installedCode) {
                call.reject("This package is not newer than the installed version.");
                return;
            }

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !manager.canRequestPackageInstalls()) {
                openUnknownSourcesSettings();
                call.reject("Allow installs from VupsRouter in Android settings, then tap Install update again.");
                return;
            }

            Uri uri = FileProvider.getUriForFile(
                    getContext(), getContext().getPackageName() + ".fileprovider", apk);
            Intent installer = new Intent(Intent.ACTION_VIEW);
            installer.setDataAndType(uri, "application/vnd.android.package-archive");
            installer.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            getContext().startActivity(installer);

            JSObject result = new JSObject();
            result.put("started", true);
            result.put("version", archive.versionName == null ? "" : archive.versionName);
            result.put("build", targetCode);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("The update could not be opened for installation. Download it again and retry.");
        }
    }

    private File copyPackage(DownloadRecord record, File directory) throws Exception {
        File[] previous = directory.listFiles();
        if (previous != null) {
            for (File old : previous) old.delete();
        }
        File target = new File(directory, "vupsrouter-update.apk");
        InputStream input = getContext().getContentResolver().openInputStream(Uri.parse(record.uri));
        if (input == null) return null;
        try (OutputStream output = new FileOutputStream(target)) {
            byte[] buffer = new byte[64 * 1024];
            long copied = 0L;
            int read;
            while ((read = input.read(buffer)) != -1) {
                copied += read;
                if (copied > MAX_UPDATE_BYTES) {
                    throw new IllegalStateException("The update package is too large.");
                }
                output.write(buffer, 0, read);
            }
        } finally {
            try {
                input.close();
            } catch (Exception ignored) {
            }
        }
        return target.isFile() && target.length() > 0 ? target : null;
    }

    private void openUnknownSourcesSettings() {
        try {
            Intent settings = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES);
            settings.setData(Uri.parse("package:" + getContext().getPackageName()));
            settings.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(settings);
        } catch (Exception ignored) {
        }
    }

    private static int signingFlags() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                ? PackageManager.GET_SIGNING_CERTIFICATES | PackageManager.GET_SIGNATURES
                : PackageManager.GET_SIGNATURES;
    }

    private static long versionCode(PackageInfo info) {
        if (info == null) return -1L;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) return info.getLongVersionCode();
        return info.versionCode;
    }

    private static Set<String> fingerprints(PackageInfo info) throws Exception {
        Set<String> result = new LinkedHashSet<>();
        if (info == null) return result;
        Signature[] signers = null;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && info.signingInfo != null) {
            signers = info.signingInfo.hasMultipleSigners()
                    ? info.signingInfo.getApkContentsSigners()
                    : info.signingInfo.getSigningCertificateHistory();
        }
        if (signers == null || signers.length == 0) signers = info.signatures;
        if (signers == null) return result;
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        for (Signature signer : signers) {
            if (signer == null) continue;
            result.add(hex(digest.digest(signer.toByteArray())));
        }
        return result;
    }

    private static String hex(byte[] bytes) {
        StringBuilder builder = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) {
            builder.append(Character.forDigit((value >> 4) & 0xF, 16));
            builder.append(Character.forDigit(value & 0xF, 16));
        }
        return builder.toString();
    }
}
