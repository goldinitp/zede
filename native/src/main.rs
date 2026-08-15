#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app;
mod capture;
mod db;
mod embed;
mod extract;
mod inject;
mod pty;
mod redact;
mod selftest;
mod settings;
mod sync;
mod term;
mod theme;
mod ui;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--version" || a == "-V") {
        println!("zede {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    if args.iter().any(|a| a == "--selftest") {
        std::process::exit(selftest::run());
    }
    if let Some(pos) = args.iter().position(|a| a == "--import-electron") {
        let source = args
            .get(pos + 1)
            .map(std::path::PathBuf::from)
            .unwrap_or_else(app::electron_db_path);
        match app::open_db().and_then(|db| db.import_from_electron(&source)) {
            Ok(r) => {
                println!(
                    "imported {} memories, {} spaces, {} tombstones ({} skipped) from {}",
                    r.memories, r.spaces, r.tombstones, r.skipped, source.display()
                );
                return;
            }
            Err(e) => {
                eprintln!("import failed: {e}");
                std::process::exit(1);
            }
        }
    }

    if args.iter().any(|a| a == "--dedupe") {
        match app::open_db() {
            Ok(db) => {
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0);
                let fast = embed::dedupe_pass(&db, now);
                println!("hashing tier: collapsed {fast} near-verbatim opinions");
                match embed::llm_dedupe(&db, now) {
                    Ok((n, groups)) => {
                        println!("claude tier: collapsed {n} restatements across {groups} groups")
                    }
                    Err(e) => println!("claude tier skipped: {e}"),
                }
                return;
            }
            Err(e) => {
                eprintln!("dedupe failed: {e}");
                std::process::exit(1);
            }
        }
    }

    // `--screenshot out.png [--shot-ui memory,settings]`: render a few frames,
    // save a composited capture, exit. Drives visual iteration + CI snapshots.
    if let Some(pos) = args.iter().position(|a| a == "--screenshot") {
        if let Some(path) = args.get(pos + 1) {
            std::env::set_var("ZEDE_SHOT_PATH", path);
        }
        if let Some(ui_pos) = args.iter().position(|a| a == "--shot-ui") {
            if let Some(list) = args.get(ui_pos + 1) {
                std::env::set_var("ZEDE_SHOT_UI", list);
            }
        }
    }

    let viewport = egui::ViewportBuilder::default()
        .with_title("Zede")
        .with_app_id("com.zede.native")
        .with_inner_size(egui::vec2(1280.0, 820.0))
        .with_min_inner_size(egui::vec2(640.0, 400.0));
    // Full-width titlebar: the window keeps its traffic lights but drops the
    // native bar; the app paints its own 38px titlebar (drag included).
    #[cfg(target_os = "macos")]
    let viewport = viewport
        .with_fullsize_content_view(true)
        .with_titlebar_shown(false)
        .with_title_shown(false);

    let options = eframe::NativeOptions {
        viewport,
        renderer: eframe::Renderer::Wgpu,
        vsync: true,
        ..Default::default()
    };

    let result = eframe::run_native(
        "Zede",
        options,
        Box::new(|cc| {
            let app = app::ZedeApp::new(cc)
                .map_err(Box::<dyn std::error::Error + Send + Sync>::from)?;
            Ok(Box::new(app) as Box<dyn eframe::App>)
        }),
    );
    if let Err(err) = result {
        eprintln!("zede: {err}");
        std::process::exit(1);
    }
}
