package com.vupsrouter.app.storage;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.List;

/** Private app-owned storage; no broad external-storage permission is needed. */
@CapacitorPlugin(name = "VupsStorage")
public class VupsStoragePlugin extends Plugin {
    private static final String ROOT = "VupsRouter";
    private static final List<String> DIRECTORIES = Arrays.asList(
            "Projects", "LocalChats", "Plugins", "Skills", "Data", "Backups");

    private File root() { return new File(getContext().getFilesDir(), ROOT); }

    private void ensureLayout() throws Exception {
        if (!root().isDirectory() && !root().mkdirs()) throw new Exception("Android storage is unavailable.");
        for (String name : DIRECTORIES) {
            File directory = new File(root(), name);
            if (!directory.isDirectory() && !directory.mkdirs()) throw new Exception("Could not create Android storage folder: " + name);
        }
    }

    private File safeFile(String relative) throws Exception {
        String value = relative == null ? "" : relative.trim().replace('\\', '/');
        if (value.isEmpty() || value.startsWith("/") || value.contains("..")) throw new Exception("That storage path is not valid.");
        File file = new File(root(), value);
        if (!file.getCanonicalPath().startsWith(root().getCanonicalPath() + File.separator)) throw new Exception("That storage path is not valid.");
        return file;
    }

    @Override public void load() { try { ensureLayout(); } catch (Exception ignored) {} }

    @PluginMethod public void initialize(PluginCall call) {
        try {
            ensureLayout();
            JSObject result = new JSObject();
            result.put("root", root().getAbsolutePath());
            result.put("directories", DIRECTORIES);
            call.resolve(result);
        } catch (Exception error) { call.reject(error.getMessage()); }
    }

    @PluginMethod public void read(PluginCall call) {
        try {
            ensureLayout();
            File file = safeFile(call.getString("path"));
            JSObject result = new JSObject();
            if (!file.isFile()) { result.put("exists", false); call.resolve(result); return; }
            byte[] bytes = new byte[(int) file.length()];
            try (FileInputStream input = new FileInputStream(file)) {
                int offset = 0;
                while (offset < bytes.length) { int count = input.read(bytes, offset, bytes.length - offset); if (count < 0) break; offset += count; }
            }
            result.put("exists", true);
            result.put("text", new String(bytes, StandardCharsets.UTF_8));
            call.resolve(result);
        } catch (Exception error) { call.reject("Android storage could not be read."); }
    }

    @PluginMethod public void write(PluginCall call) {
        try {
            ensureLayout();
            File file = safeFile(call.getString("path"));
            File parent = file.getParentFile();
            if (parent != null && !parent.isDirectory() && !parent.mkdirs()) throw new Exception("Could not create the storage folder.");
            File temporary = new File(parent, file.getName() + ".tmp");
            byte[] bytes = String.valueOf(call.getString("text") == null ? "" : call.getString("text")).getBytes(StandardCharsets.UTF_8);
            try (FileOutputStream output = new FileOutputStream(temporary)) { output.write(bytes); output.getFD().sync(); }
            if (file.exists() && !file.delete()) throw new Exception("Could not replace the storage file.");
            if (!temporary.renameTo(file)) throw new Exception("Could not finish the storage write.");
            call.resolve();
        } catch (Exception error) { call.reject(error.getMessage() == null ? "Android storage could not be written." : error.getMessage()); }
    }
}
