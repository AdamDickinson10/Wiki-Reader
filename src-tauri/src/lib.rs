use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder},
    Emitter,
};

#[tauri::command]
async fn fetch_wikimedia_map_image(url: String) -> Result<String, String> {
    let response = reqwest::Client::new()
        .get(&url)
        .header(reqwest::header::REFERER, "https://en.wikipedia.org/")
        .header(reqwest::header::USER_AGENT, "WikiReader/0.1.0")
        .send()
        .await
        .map_err(|error| error.to_string())?;

    if !response.status().is_success() {
        return Err(format!("Wikimedia returned {}", response.status()));
    }

    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("image/png")
        .to_string();

    let bytes = response.bytes().await.map_err(|error| error.to_string())?;

    Ok(format!("data:{};base64,{}", content_type, BASE64.encode(bytes)))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(|app| {
            let find = MenuItemBuilder::with_id("view-find", "Find in Article")
                .accelerator("CmdOrCtrl+F")
                .build(app)?;
            let contents = MenuItemBuilder::with_id("view-contents", "Article Contents")
                .accelerator("CmdOrCtrl+Alt+C")
                .build(app)?;
            let width = MenuItemBuilder::with_id("view-width", "Toggle Article Width")
                .accelerator("CmdOrCtrl+Alt+W")
                .build(app)?;
            let zoom_in = MenuItemBuilder::with_id("view-zoom-in", "Zoom In")
                .accelerator("CmdOrCtrl+=")
                .build(app)?;
            let zoom_out = MenuItemBuilder::with_id("view-zoom-out", "Zoom Out")
                .accelerator("CmdOrCtrl+Minus")
                .build(app)?;
            let zoom_reset = MenuItemBuilder::with_id("view-zoom-reset", "Reset Zoom")
                .accelerator("CmdOrCtrl+0")
                .build(app)?;
            let zoom_menu = SubmenuBuilder::new(app, "Zoom")
                .item(&zoom_in)
                .item(&zoom_out)
                .item(&zoom_reset)
                .build()?;
            let tools = MenuItemBuilder::with_id("view-tools", "Toggle Reader Tools")
                .accelerator("CmdOrCtrl+Alt+T")
                .build(app)?;
            let back = MenuItemBuilder::with_id("view-back", "Back")
                .accelerator("CmdOrCtrl+Alt+B")
                .build(app)?;
            let reload = MenuItemBuilder::with_id("view-reload", "Reload Article")
                .accelerator("CmdOrCtrl+Alt+R")
                .build(app)?;
            let external = MenuItemBuilder::with_id("view-external", "External Open")
                .accelerator("CmdOrCtrl+Alt+E")
                .build(app)?;
            let media = MenuItemBuilder::with_id("view-media", "Play/Pause Media")
                .accelerator("Space")
                .build(app)?;

            let app_menu = SubmenuBuilder::new(app, "Wiki-Reader")
                .item(&PredefinedMenuItem::about(app, None, None)?)
                .separator()
                .item(&PredefinedMenuItem::hide(app, None)?)
                .item(&PredefinedMenuItem::hide_others(app, None)?)
                .item(&PredefinedMenuItem::show_all(app, None)?)
                .separator()
                .item(&PredefinedMenuItem::quit(app, None)?)
                .build()?;

            let file_menu = SubmenuBuilder::new(app, "File")
                .item(&PredefinedMenuItem::close_window(app, None)?)
                .build()?;

            let edit_menu = SubmenuBuilder::new(app, "Edit")
                .item(&PredefinedMenuItem::undo(app, None)?)
                .item(&PredefinedMenuItem::redo(app, None)?)
                .separator()
                .item(&PredefinedMenuItem::cut(app, None)?)
                .item(&PredefinedMenuItem::copy(app, None)?)
                .item(&PredefinedMenuItem::paste(app, None)?)
                .item(&PredefinedMenuItem::select_all(app, None)?)
                .build()?;

            let view_menu = SubmenuBuilder::new(app, "View")
                .item(&find)
                .item(&contents)
                .item(&width)
                .item(&zoom_menu)
                .item(&tools)
                .item(&back)
                .item(&reload)
                .item(&external)
                .item(&media)
                .separator()
                .item(&PredefinedMenuItem::fullscreen(app, None)?)
                .build()?;

            let window_menu = SubmenuBuilder::new(app, "Window")
                .item(&PredefinedMenuItem::minimize(app, None)?)
                .item(&PredefinedMenuItem::maximize(app, None)?)
                .separator()
                .item(&PredefinedMenuItem::close_window(app, None)?)
                .build()?;

            let attribution = MenuItemBuilder::with_id("help-attribution", "Wikipedia && Wikimedia Attribution").build(app)?;

            let help_menu = SubmenuBuilder::new(app, "Help")
                .item(&attribution)
                .build()?;

            let menu = MenuBuilder::new(app)
                .items(&[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu, &help_menu])
                .build()?;

            app.set_menu(menu)?;
            app.on_menu_event(|app, event| {
                if event.id().0 == "view-find" {
                    let _ = app.emit("reader-menu-find", ());
                } else if event.id().0 == "view-contents" {
                    let _ = app.emit("reader-menu-contents", ());
                } else if event.id().0 == "view-width" {
                    let _ = app.emit("reader-menu-width", ());
                } else if event.id().0 == "view-zoom-in" {
                    let _ = app.emit("reader-menu-zoom-in", ());
                } else if event.id().0 == "view-zoom-out" {
                    let _ = app.emit("reader-menu-zoom-out", ());
                } else if event.id().0 == "view-zoom-reset" {
                    let _ = app.emit("reader-menu-zoom-reset", ());
                } else if event.id().0 == "view-tools" {
                    let _ = app.emit("reader-menu-tools", ());
                } else if event.id().0 == "view-back" {
                    let _ = app.emit("reader-menu-back", ());
                } else if event.id().0 == "view-reload" {
                    let _ = app.emit("reader-menu-reload", ());
                } else if event.id().0 == "view-external" {
                    let _ = app.emit("reader-menu-external", ());
                } else if event.id().0 == "view-media" {
                    let _ = app.emit("reader-menu-media", ());
                } else if event.id().0 == "help-attribution" {
                    let _ = app.emit("reader-menu-attribution", ());
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![fetch_wikimedia_map_image])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
