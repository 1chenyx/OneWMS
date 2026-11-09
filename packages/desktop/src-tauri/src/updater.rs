//! 无感升级：后台静默检查 + 静默下载，只在「安装包已就绪」时打扰用户一次。
//!
//! 为什么整条链路都在 Rust 侧、完全不碰前端：本壳的窗口加载的是内置 Node 服务端的
//! `http://127.0.0.1:<port>`（WebviewUrl::External），前端与 Tauri 之间没有 IPC 通道
//! （capabilities 为空），也不该为「弹一个更新提示」把 web 端和壳耦合起来。
//! 原生对话框够用，壳的职责边界仍然是「拉起服务端 + 开窗 + 回收」。
//!
//! 时序：
//!   启动 15s 后首查（让开启动高峰：拉 node 服务端 + 迁移 + 投影追账）→ 之后每 4 小时复查
//!   有新版 → 静默下载到 %TEMP%（不打断收货/拣货）
//!         → 弹一次框：「立即重启」/「退出时安装」
//!         → 立即重启：NSIS 装完自己把新版拉起来
//!         → 退出时安装：暂存，进程退出时静默装（且不让安装器再拉起来）
//!
//! 任何一步失败都只记日志、绝不打断业务——升级失败不该让人干不了活。
//! 数据侧的安全由另一套机制负责（升级闸门 + 投影版本戳），本模块只管把新程序装上去。

use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::{Update, UpdaterExt};

/// 启动后多久首查
const FIRST_CHECK_DELAY: Duration = Duration::from_secs(15);
/// 复查间隔：仓库一天两班，4 小时足够新，又不至于反复敲 GitHub
const RECHECK_INTERVAL: Duration = Duration::from_secs(4 * 60 * 60);
/// 下载体的临时文件名。用固定名而不是带版本号：反复下载互相覆盖，不会在 %TEMP% 里堆垃圾
const PENDING_FILE: &str = "onewms-pending-update.bin";

/// 已下载、正等安装时机的更新包。
///
/// 落盘不落内存：WMS 客户端常常一开就是一整天，把 ~80MB 安装包常驻内存
/// 只为等用户点「稍后」不划算。`update` 必须留着——install() 要靠它验签。
#[derive(Default)]
pub struct PendingUpdate(Mutex<Option<Pending>>);

struct Pending {
    update: Update,
    file: PathBuf,
    version: String,
}

/// 便携版（解压即用的 zip）不参与自动更新：NSIS 会装进默认安装目录，
/// 解压目录里仍是旧版，用户下次双击绿色包又触发一轮更新——死循环。
/// 判据用「目录里有没有 NSIS 卸载器」：安装版必有 uninstall.exe，便携版必无。
fn is_portable() -> bool {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join("uninstall.exe")))
        .map_or(true, |uninstaller| !uninstaller.exists())
}

/// 起后台检查线程。dev（cargo tauri dev）与便携版直接跳过。
pub fn spawn(app: AppHandle) {
    if cfg!(debug_assertions) {
        println!("[updater] 开发模式，跳过自动更新");
        return;
    }
    if is_portable() {
        println!("[updater] 便携版，跳过自动更新（请手动换 zip）");
        return;
    }
    std::thread::spawn(move || {
        std::thread::sleep(FIRST_CHECK_DELAY);
        loop {
            tauri::async_runtime::block_on(check_and_download(&app));
            std::thread::sleep(RECHECK_INTERVAL);
        }
    });
}

async fn check_and_download(app: &AppHandle) {
    // 已有一份在等安装 → 不重复下载、不重复弹框
    if app.state::<PendingUpdate>().0.lock().unwrap_or_else(|e| e.into_inner()).is_some() {
        return;
    }

    // on_before_exit：Windows 上 install() 起完安装器就直接 std::process::exit(0)，
    // 不走 RunEvent::Exit —— 少了这个钩子会留下一个占着 SQLite 的孤儿 node.exe，
    // 下次启动撞锁文件。幂等，所以「立即重启」和「退出时安装」两条路都安全。
    let killer = app.clone();
    let updater = match app
        .updater_builder()
        .on_before_exit(move || crate::kill_server(&killer))
        .build()
    {
        Ok(updater) => updater,
        Err(e) => {
            println!("[updater] 更新器初始化失败（忽略）: {e}");
            return;
        }
    };

    let update = match updater.check().await {
        Ok(Some(update)) => update,
        Ok(None) => return, // 已是最新
        Err(e) => {
            // 断网、被墙、还没发过 latest.json 都会走到这里——常态，不是事故
            println!("[updater] 检查更新失败（忽略）: {e}");
            return;
        }
    };

    let version = update.version.clone();
    let current = update.current_version.clone();
    println!("[updater] 发现新版本 v{version}（当前 v{current}），开始后台下载");

    let bytes = match update.download(|_done, _total| {}, || {}).await {
        Ok(bytes) => bytes,
        Err(e) => {
            println!("[updater] 下载失败（忽略，下轮重试）: {e}");
            return;
        }
    };

    let file = std::env::temp_dir().join(PENDING_FILE);
    if let Err(e) = std::fs::write(&file, &bytes) {
        println!("[updater] 更新包落盘失败（忽略）: {e}");
        return;
    }
    drop(bytes); // 尽早还内存：后面可能要在 RAM 里躺一整天

    *app.state::<PendingUpdate>().0.lock().unwrap_or_else(|e| e.into_inner()) =
        Some(Pending { update, file, version: version.clone() });
    println!("[updater] v{version} 已就绪，等待用户选择安装时机");
    prompt(app, &current, &version);
}

/// 下载完成后唯一一次打扰。用户不点就一直等（阻塞的是后台线程，界面照常能用）；
/// 直接关对话框按「退出时安装」处理——宁可装上，也别让用户天天看见这个框。
fn prompt(app: &AppHandle, current: &str, version: &str) {
    let (tx, rx) = mpsc::channel();
    app.dialog()
        .message(format!(
            "OneWMS v{version} 已下载完成（当前 v{current}）。\n\n\
             立即重启即可完成更新；也可以先把手头的活干完——\n\
             关闭程序时会自动装好，下次打开就是新版本。"
        ))
        .title("OneWMS 更新就绪")
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "立即重启".into(),
            "退出时安装".into(),
        ))
        .show(move |restart_now| {
            let _ = tx.send(restart_now);
        });

    if rx.recv().unwrap_or(false) {
        install_now(app);
    }
}

fn take_pending(app: &AppHandle) -> Option<Pending> {
    app.state::<PendingUpdate>()
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take()
}

/// 「立即重启」。Windows 上 install() 内部 exit(0)，本函数正常情况不会返回。
pub fn install_now(app: &AppHandle) {
    let Some(pending) = take_pending(app) else { return };
    let Ok(bytes) = std::fs::read(&pending.file) else {
        println!("[updater] 更新包已不在（{}），放弃安装", pending.file.display());
        return;
    };
    println!("[updater] 安装 v{} 并重启", pending.version);
    if let Err(e) = pending.update.install(bytes) {
        println!("[updater] 安装失败: {e}");
    }
}

/// 「退出时安装」：进程退出时静默装好，并且**不要让安装器把程序再拉起来**
/// （restart_after_install(false)）——用户是主动关的，装完自己弹出来会很吓人。
/// 必须在 kill_server 之后调用（见 main.rs 的 RunEvent::Exit）。
pub fn install_on_exit(app: &AppHandle) {
    let Some(pending) = take_pending(app) else { return };
    let Ok(bytes) = std::fs::read(&pending.file) else { return };
    println!("[updater] 退出时静默安装 v{}", pending.version);
    if let Err(e) = pending.update.clone().restart_after_install(false).install(bytes) {
        println!("[updater] 安装失败: {e}");
    }
    let _ = std::fs::remove_file(&pending.file);
}
