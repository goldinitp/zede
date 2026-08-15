#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app;
mod capture;
mod db;
mod pty;
mod selftest;
mod settings;
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

    let viewport = egui::ViewportBuilder::default()
        .with_title("Zede")
        .with_app_id("dev.zede.Zede")
        .with_inner_size(egui::vec2(1280.0, 820.0))
        .with_min_inner_size(egui::vec2(640.0, 400.0));

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
