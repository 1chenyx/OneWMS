//! OneWMS 桌面壳：
//! 启动时拉起内置 Node 服务端（resources/server/node.exe），
//! 健康检查通过后创建窗口加载 http://127.0.0.1:<动态端口>；
//! 应用退出时杀掉服务端子进程。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::{TcpListener, TcpStream};
use std::os::windows::process::CommandExt;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

/// 持有服务端子进程，退出时统一回收
struct ServerChild(Mutex<Option<Child>>);

fn main() {
    let app = tauri::Builder::default()
        .manage(ServerChild(Mutex::new(None)))
        .setup(|app| {
            let port = spawn_server(app.handle())?;
            let url = format!("http://127.0.0.1:{port}/").parse()?;
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("OneWMS")
                .inner_size(1280.0, 820.0)
                .min_inner_size(960.0, 600.0)
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if let RunEvent::Exit = event {
            kill_server(app_handle);
        }
    });
}

/// 启动内置服务端并等待端口就绪，返回分配到的端口
// 剥掉 Tauri 返回的 \\?\ 扩展路径前缀：该前缀传给 node.exe 作 argv/cwd 会导致
// 其模块解析异常（EISDIR 'D:'），必须是普通 Win32 路径
fn normalize_path(p: std::path::PathBuf) -> std::path::PathBuf {
    let s = p.as_os_str().to_string_lossy();
    match s.strip_prefix(r"\\?\UNC\") {
        Some(rest) => std::path::PathBuf::from(format!(r"\\{}", rest)),
        None => match s.strip_prefix(r"\\?\") {
            Some(rest) => std::path::PathBuf::from(rest),
            None => p,
        },
    }
}

fn spawn_server(app: &AppHandle) -> Result<u16, Box<dyn std::error::Error>> {
    // 动态取空闲端口，避免与已占用端口冲突
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    drop(listener);

    let resource_dir = normalize_path(app.path().resource_dir()?);
    // 兼容两种布局：便携版 exe 同级 server\，安装版 resource_dir 下 resources\server\
    let payload = ["server", "resources/server"]
        .iter()
        .map(|p| resource_dir.join(p))
        .find(|p| p.join("node.exe").exists())
        .ok_or_else(|| format!("未找到内置服务端 payload（{}）", resource_dir.display()))?;
    let node_exe = normalize_path(payload.join("node.exe"));
    let script = normalize_path(payload.join("packages").join("server").join("dist").join("main.js"));

    // 数据目录：优先 exe 旁边的 data\（便携模式，可整体携带）；
    // 不可写（如安装到 Program Files）则回退 AppData\Roaming\com.onewms.desktop\data
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()));
    let portable_data = exe_dir.map(|d| d.join("data")).filter(|d| {
        std::fs::create_dir_all(d).is_ok()
    });
    let data_dir = match portable_data {
        Some(d) => normalize_path(d),
        None => normalize_path(app.path().app_data_dir()?.join("data")),
    };
    std::fs::create_dir_all(&data_dir)?;

    let child = Command::new(&node_exe)
        .arg(&script)
        .current_dir(&data_dir)
        .env("ONE_PORT", port.to_string())
        .env("ONE_DB_PATH", data_dir.join("onewms.db"))
        .env("ONE_WORKSPACE", "default")
        // node.exe 是控制台子系统程序，不加此标志会弹出黑色控制台窗口
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .spawn()
        .map_err(|e| format!("启动内置服务端失败（{}）: {e}", node_exe.display()))?;

    *app.state::<ServerChild>().0.lock().unwrap() = Some(child);

    // 等待服务端监听（最多约 15s）
    for _ in 0..75 {
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return Ok(port);
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    Err("内置服务端启动超时".into())
}

/// 退出时回收服务端子进程
fn kill_server(app: &AppHandle) {
    if let Some(mut child) = app.state::<ServerChild>().0.lock().unwrap().take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}
