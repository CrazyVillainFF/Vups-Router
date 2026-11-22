// Hardware facts for the Local AI page. Physical memory and free disk space
// come from Windows directly; CPU and GPU names come from CIM. CPU RAM is
// reported as RAM only — this file never labels it as VRAM.

use serde::Serialize;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HardwareGpu {
    name: String,
    vram_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HardwareInfo {
    cpu: String,
    logical_cores: u32,
    total_ram_bytes: u64,
    available_ram_bytes: u64,
    storage_total_bytes: u64,
    storage_free_bytes: u64,
    gpus: Vec<HardwareGpu>,
}

#[cfg(windows)]
fn memory() -> (u64, u64) {
    use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    let mut status: MEMORYSTATUSEX = unsafe { std::mem::zeroed() };
    status.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
    let ok = unsafe { GlobalMemoryStatusEx(&mut status) };
    if ok == 0 {
        (0, 0)
    } else {
        (status.ullTotalPhys, status.ullAvailPhys)
    }
}

#[cfg(not(windows))]
fn memory() -> (u64, u64) {
    (0, 0)
}

#[cfg(windows)]
fn storage() -> (u64, u64) {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;

    let root = dirs::document_dir()
        .or_else(dirs::home_dir)
        .unwrap_or_default();
    let wide: Vec<u16> = root.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let mut free_to_caller: u64 = 0;
    let mut total: u64 = 0;
    let mut free_total: u64 = 0;
    let ok = unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut free_to_caller, &mut total, &mut free_total) };
    if ok == 0 {
        (0, 0)
    } else {
        (total, free_total)
    }
}

#[cfg(not(windows))]
fn storage() -> (u64, u64) {
    (0, 0)
}

#[cfg(windows)]
fn names() -> (String, Vec<HardwareGpu>) {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let script = "$ErrorActionPreference='SilentlyContinue'; \
        $cpu=(Get-CimInstance Win32_Processor | Select-Object -First 1 -ExpandProperty Name); \
        $gpus=@(Get-CimInstance Win32_VideoController | ForEach-Object { \
            [pscustomobject]@{ name=$_.Name; vramBytes=[int64]$_.AdapterRAM } }); \
        [pscustomobject]@{ cpu=$cpu; gpus=$gpus } | ConvertTo-Json -Compress -Depth 3";
    let output = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    let Ok(output) = output else {
        return (String::new(), Vec::new());
    };
    if !output.status.success() {
        return (String::new(), Vec::new());
    }
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(&output.stdout) else {
        return (String::new(), Vec::new());
    };
    let cpu = value
        .get("cpu")
        .and_then(|item| item.as_str())
        .unwrap_or_default()
        .trim()
        .to_string();
    let gpus = value
        .get("gpus")
        .and_then(|item| item.as_array())
        .map(|rows| {
            rows.iter()
                .filter_map(|row| {
                    let name = row.get("name").and_then(|item| item.as_str())?.trim();
                    if name.is_empty() {
                        return None;
                    }
                    let vram = row.get("vramBytes").and_then(|item| item.as_i64()).unwrap_or(0);
                    Some(HardwareGpu {
                        name: name.to_string(),
                        // AdapterRAM is a 32-bit value on some drivers and
                        // saturates at 4 GB. An implausible reading is dropped
                        // rather than shown as exact.
                        vram_bytes: if vram > 0 && vram < 4_294_967_295 { vram as u64 } else { 0 },
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    (cpu, gpus)
}

#[cfg(not(windows))]
fn names() -> (String, Vec<HardwareGpu>) {
    (String::new(), Vec::new())
}

#[tauri::command]
pub fn local_hardware_info() -> HardwareInfo {
    let (total_ram_bytes, available_ram_bytes) = memory();
    let (storage_total_bytes, storage_free_bytes) = storage();
    let (cpu, gpus) = names();
    HardwareInfo {
        cpu,
        logical_cores: std::thread::available_parallelism()
            .map(|count| count.get() as u32)
            .unwrap_or(0),
        total_ram_bytes,
        available_ram_bytes,
        storage_total_bytes,
        storage_free_bytes,
        gpus,
    }
}
