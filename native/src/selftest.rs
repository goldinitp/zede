//! Headless end-to-end checks (`zede --selftest`): no window, real PTYs.
//! The native successor to the Electron app's `pnpm selftest`.

use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use alacritty_terminal::vte::ansi::{CursorShape, CursorStyle};
use egui::Color32;

use crate::app::osc_from_theme;
use crate::capture::{prompt_from_line, PromptFeed};
use crate::db::{Db, MemoryRow};
use crate::redact::redact;
use crate::{extract, inject};
use crate::pty::{self, TabKind};
use crate::settings::{normalize_setting_value, Settings};
use crate::term::TermSession;
use crate::theme;

fn block_cursor() -> CursorStyle {
    CursorStyle { shape: CursorShape::Block, blinking: false }
}

/// Visible-grid text, joined row by row (for output assertions).
fn grid_text(session: &TermSession) -> String {
    let term = session.term.lock();
    let content = term.renderable_content();
    let rows = session.rows as usize;
    let cols = session.cols as usize;
    let offset = content.display_offset as i32;
    let mut grid = vec![vec![' '; cols]; rows];
    for indexed in content.display_iter {
        let vrow = indexed.point.line.0 + offset;
        let col = indexed.point.column.0;
        if vrow >= 0 && (vrow as usize) < rows && col < cols {
            grid[vrow as usize][col] = indexed.cell.c;
        }
    }
    grid.into_iter()
        .map(|row| row.into_iter().collect::<String>())
        .collect::<Vec<_>>()
        .join("\n")
}

fn wait_until(timeout: Duration, mut check: impl FnMut() -> bool) -> bool {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if check() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    check()
}

type Check = (&'static str, fn() -> Result<(), String>);

fn expect(cond: bool, msg: &str) -> Result<(), String> {
    if cond {
        Ok(())
    } else {
        Err(msg.to_string())
    }
}

fn temp_db() -> Result<(Db, std::path::PathBuf), String> {
    let dir = std::env::temp_dir().join(format!("zede-selftest-{}", uuid::Uuid::new_v4()));
    let path = dir.join("zede.db");
    let db = Db::open(&path)?;
    Ok((db, dir))
}

// --- checks -----------------------------------------------------------------

fn check_db_migrate_seed() -> Result<(), String> {
    let (db, dir) = temp_db()?;
    db.ensure_seed();
    let spaces = db.list_spaces();
    expect(spaces.len() == 1, "seed creates one space")?;
    expect(spaces[0].is_default, "seed space is default")?;
    let tabs = db.list_tabs(&spaces[0].id);
    expect(tabs.len() == 1, "seed creates one tab")?;
    expect(tabs[0].kind == TabKind::Claude, "seed tab is a claude tab")?;
    db.ensure_seed();
    expect(db.list_spaces().len() == 1, "seed is idempotent")?;
    let _ = std::fs::remove_dir_all(dir);
    Ok(())
}

fn check_db_tab_roundtrip() -> Result<(), String> {
    let (db, dir) = temp_db()?;
    let space = db.create_space("Test", None);
    let tab = db.create_tab(&space.id, TabKind::Claude, "Chat", "/tmp");
    db.set_tab_pinned(&tab.id, true);
    db.set_tab_last_session(&tab.id, "0f4bb1f8-0000-4000-8000-000000000000");
    db.rename_tab(&tab.id, "Renamed");
    let rows = db.list_tabs(&space.id);
    expect(rows.len() == 1, "one tab")?;
    expect(rows[0].pinned, "pin persisted")?;
    expect(rows[0].title == "Renamed", "rename persisted")?;
    expect(
        rows[0].last_session_id.as_deref() == Some("0f4bb1f8-0000-4000-8000-000000000000"),
        "last session persisted",
    )?;
    db.delete_space(&space.id);
    expect(db.list_tabs(&space.id).is_empty(), "cascade delete")?;
    let _ = std::fs::remove_dir_all(dir);
    Ok(())
}

fn check_settings_normalize() -> Result<(), String> {
    expect(normalize_setting_value("fontSize", "99") == Some("24".into()), "fontSize clamps high")?;
    expect(normalize_setting_value("fontSize", "1") == Some("9".into()), "fontSize clamps low")?;
    expect(normalize_setting_value("scrollback", "100") == Some("500".into()), "scrollback clamps")?;
    expect(
        normalize_setting_value("scrollback", "1234.7") == Some("1235".into()),
        "scrollback rounds to integer",
    )?;
    expect(normalize_setting_value("theme", "not-a-theme").is_none(), "invalid theme rejected")?;
    expect(normalize_setting_value("theme", "dracula") == Some("dracula".into()), "valid theme kept")?;
    expect(normalize_setting_value("cursorBlink", "yes").is_none(), "bool must be 0/1")?;
    expect(normalize_setting_value("cursorBlink", "1") == Some("1".into()), "bool 1 ok")?;
    expect(normalize_setting_value("nonsenseKey", "x").is_none(), "unknown key rejected")?;
    Ok(())
}

fn check_settings_defaults() -> Result<(), String> {
    let (db, dir) = temp_db()?;
    let s = Settings::load(&db);
    expect(s == Settings::default(), "empty db loads defaults")?;
    db.set_setting("fontSize", "16");
    db.set_setting("theme", "nord");
    let s = Settings::load(&db);
    expect((s.font_size - 16.0).abs() < f32::EPSILON, "fontSize load")?;
    expect(s.theme == "nord", "theme load")?;
    let _ = std::fs::remove_dir_all(dir);
    Ok(())
}

fn check_cwd_encoding() -> Result<(), String> {
    expect(
        pty::encode_cwd("/Users/goldi/My Code.app") == "-Users-goldi-My-Code-app",
        "lossy forward encoding",
    )?;
    let p = pty::transcript_path_for("/tmp/proj", "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed");
    let s = p.to_string_lossy();
    expect(
        s.contains(".claude") && s.contains("projects") && s.contains("-tmp-proj"),
        "transcript path under ~/.claude/projects/<encoded>",
    )?;
    expect(s.ends_with("1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed.jsonl"), "transcript file name")?;
    Ok(())
}

fn check_uuid_guard() -> Result<(), String> {
    expect(pty::is_uuid("1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed"), "lowercase uuid ok")?;
    expect(pty::is_uuid("1B9D6BCD-BBFD-4B2D-9B5D-AB8DFBBD4BED"), "uppercase uuid ok")?;
    expect(!pty::is_uuid("not-a-uuid"), "garbage rejected")?;
    expect(!pty::is_uuid("1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4be"), "short rejected")?;
    expect(
        !pty::is_uuid("1b9d6bcd;rm -rf /-4b2d-9b5d-ab8dfbbd4bed"),
        "injection shape rejected",
    )?;
    Ok(())
}

fn check_spawn_plan_claude() -> Result<(), String> {
    let plan = pty::spawn_plan(TabKind::Claude, None);
    expect(pty::is_uuid(&plan.session_id), "fresh session id is a uuid")?;
    expect(!plan.resumed, "fresh spawn not resumed")?;
    if cfg!(unix) {
        expect(plan.args.len() == 4, "posix claude args: -i -l -c cmd")?;
        expect(plan.args[0] == "-i" && plan.args[1] == "-l" && plan.args[2] == "-c", "interactive login shell")?;
        let cmd = &plan.args[3];
        expect(
            cmd.contains(&format!("claude --session-id {}", plan.session_id)),
            "session id delivered as the shell command",
        )?;
        expect(cmd.contains("; exec "), "drops to interactive shell after claude exits")?;
    }
    Ok(())
}

fn check_spawn_plan_resume() -> Result<(), String> {
    let id = "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed";
    let plan = pty::spawn_plan(TabKind::Claude, Some(id));
    expect(plan.resumed, "valid uuid resumes")?;
    expect(plan.session_id == id, "resume keeps the id")?;
    if cfg!(unix) {
        expect(plan.args[3].contains(&format!("claude --resume {id}")), "resume flag")?;
    }
    let bad = pty::spawn_plan(TabKind::Claude, Some("evil; rm -rf /"));
    expect(!bad.resumed, "invalid resume id starts fresh")?;
    expect(pty::is_uuid(&bad.session_id), "fresh id generated instead")?;
    if cfg!(unix) {
        expect(!bad.args[3].contains("evil"), "tampered id never reaches the command")?;
    }
    let shell = pty::spawn_plan(TabKind::Shell, None);
    if cfg!(unix) {
        expect(shell.args == vec!["-l".to_string()], "shell tab is a login shell")?;
    }
    Ok(())
}

fn check_env_rules() -> Result<(), String> {
    std::env::set_var("NO_COLOR", "1");
    std::env::set_var("CURSOR_AGENT", "1");
    let env = pty::terminal_environment();
    let get = |k: &str| env.iter().find(|(key, _)| key == k).map(|(_, v)| v.clone());
    expect(get("NO_COLOR").is_none(), "NO_COLOR stripped")?;
    expect(get("CURSOR_AGENT").is_none(), "CURSOR_AGENT stripped")?;
    expect(get("TERM").as_deref() == Some("xterm-256color"), "TERM set")?;
    expect(get("COLORTERM").as_deref() == Some("truecolor"), "COLORTERM set")?;
    expect(get("TERM_PROGRAM").as_deref() == Some("Zede"), "TERM_PROGRAM set")?;
    expect(
        get("CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN").as_deref() == Some("1"),
        "alternate screen disabled for claude",
    )?;
    std::env::remove_var("NO_COLOR");
    std::env::remove_var("CURSOR_AGENT");
    Ok(())
}

fn check_key_encoding() -> Result<(), String> {
    use crate::term::keys::{encode_key, encode_paste};
    use alacritty_terminal::term::TermMode;
    use egui::{Key, Modifiers};

    let none = Modifiers::NONE;
    let mode = TermMode::empty();
    expect(encode_key(Key::Enter, none, mode) == Some(b"\r".to_vec()), "enter -> CR")?;
    expect(encode_key(Key::ArrowUp, none, mode) == Some(b"\x1b[A".to_vec()), "arrow up CSI")?;
    expect(
        encode_key(Key::ArrowUp, none, TermMode::APP_CURSOR) == Some(b"\x1bOA".to_vec()),
        "arrow up SS3 in app-cursor mode",
    )?;
    let ctrl = Modifiers { ctrl: true, ..Default::default() };
    expect(encode_key(Key::C, ctrl, mode) == Some(vec![0x03]), "ctrl+c -> ETX")?;
    let shift = Modifiers { shift: true, ..Default::default() };
    expect(encode_key(Key::Tab, shift, mode) == Some(b"\x1b[Z".to_vec()), "shift+tab backtab")?;
    expect(
        encode_key(Key::ArrowRight, ctrl, mode) == Some(b"\x1b[1;5C".to_vec()),
        "ctrl+arrow modifier param",
    )?;
    expect(encode_key(Key::A, none, mode).is_none(), "plain letters come via Text events")?;
    let cmd = Modifiers { mac_cmd: true, command: true, ..Default::default() };
    expect(encode_key(Key::C, cmd, mode).is_none(), "cmd combos never reach the pty")?;

    expect(encode_paste("a\nb", false) == b"a\rb".to_vec(), "plain paste LF->CR")?;
    let bracketed = encode_paste("hi\x1b[201~there", true);
    expect(
        bracketed == b"\x1b[200~hithere\x1b[201~".to_vec(),
        "bracketed paste wraps and strips injected end marker",
    )?;
    Ok(())
}

fn check_color_math() -> Result<(), String> {
    let th = theme::theme_by_id("one-dark");
    expect(theme::xterm_256(196, th) == Color32::from_rgb(255, 0, 0), "cube 196 = red")?;
    expect(theme::xterm_256(232, th) == Color32::from_rgb(8, 8, 8), "grayscale start")?;
    expect(theme::xterm_256(255, th) == Color32::from_rgb(238, 238, 238), "grayscale end")?;
    expect(theme::xterm_256(1, th) == th.term.ansi[1], "low indexes come from theme")?;
    use alacritty_terminal::vte::ansi::{Color as AnsiColor, NamedColor};
    expect(
        theme::bold_variant(AnsiColor::Named(NamedColor::Red)) == AnsiColor::Indexed(9),
        "bold red brightens",
    )?;
    Ok(())
}

fn check_shell_detection() -> Result<(), String> {
    expect(pty::is_shell_process("-zsh"), "login zsh")?;
    expect(pty::is_shell_process("/bin/bash"), "path bash")?;
    expect(pty::is_shell_process("powershell.exe"), "powershell")?;
    expect(!pty::is_shell_process("claude"), "claude is not a shell")?;
    expect(!pty::is_shell_process("vim"), "vim is not a shell")?;
    Ok(())
}

fn check_prompt_parser_filters() -> Result<(), String> {
    expect(
        prompt_from_line(r#"{"type":"user","message":{"content":"hello world"}}"#)
            == Some("hello world".into()),
        "plain user string prompt",
    )?;
    expect(
        prompt_from_line(
            r#"{"type":"user","message":{"content":[{"type":"text","text":"from blocks"}]}}"#,
        ) == Some("from blocks".into()),
        "text-block prompt",
    )?;
    expect(
        prompt_from_line(r#"{"type":"user","isMeta":true,"message":{"content":"m"}}"#).is_none(),
        "isMeta filtered",
    )?;
    expect(
        prompt_from_line(r#"{"type":"user","isSidechain":true,"message":{"content":"s"}}"#)
            .is_none(),
        "isSidechain filtered",
    )?;
    expect(
        prompt_from_line(r#"{"type":"assistant","message":{"content":"a"}}"#).is_none(),
        "assistant filtered",
    )?;
    expect(
        prompt_from_line(
            r#"{"type":"user","message":{"content":[{"type":"tool_result","content":"x"}]}}"#,
        )
        .is_none(),
        "tool_result-only filtered",
    )?;
    expect(
        prompt_from_line(
            r#"{"type":"user","message":{"content":"<command-name>/foo</command-name>"}}"#,
        )
        .is_none(),
        "command echo filtered",
    )?;
    expect(prompt_from_line("not json at all").is_none(), "garbage line filtered")?;
    let long = format!(
        r#"{{"type":"user","message":{{"content":"{}"}}}}"#,
        "x".repeat(500)
    );
    let capped = prompt_from_line(&long).ok_or("long prompt parsed")?;
    expect(
        capped.chars().count() == 281 && capped.ends_with('…'),
        "giant prompt capped with ellipsis",
    )?;
    Ok(())
}

fn check_prompt_feed_incremental() -> Result<(), String> {
    use std::io::Write;
    let dir = std::env::temp_dir().join(format!("zede-selftest-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("session.jsonl");

    let mut f = std::fs::File::create(&path).map_err(|e| e.to_string())?;
    write!(
        f,
        "{}\n{}\n{}",
        r#"{"type":"user","message":{"content":"first"}}"#,
        r#"{"type":"assistant","message":{"content":[{"type":"text","text":"reply"}]}}"#,
        r#"{"type":"user","message":{"content":"sec"#, // incomplete line, no newline
    )
    .map_err(|e| e.to_string())?;
    f.flush().ok();

    let mut feed = PromptFeed::new(path.clone());
    expect(feed.poll_now(), "first poll finds the complete prompt")?;
    expect(
        feed.prompts.iter().map(|p| p.text.as_str()).collect::<Vec<_>>() == vec!["first"],
        "incomplete trailing line is not consumed",
    )?;
    expect(!feed.poll_now(), "no new complete lines -> no change")?;

    let mut f = std::fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    write!(f, "{}", "ond\"}}\n").map_err(|e| e.to_string())?;
    f.flush().ok();
    expect(feed.poll_now(), "completing the line yields the prompt")?;
    expect(
        feed.prompts.iter().map(|p| p.text.as_str()).collect::<Vec<_>>()
            == vec!["first", "second"],
        "split-across-polls line parsed once complete",
    )?;
    let _ = std::fs::remove_dir_all(dir);
    Ok(())
}

fn check_redaction() -> Result<(), String> {
    let r = redact("key is sk-ant-abc123def456ghi789jkl012 ok");
    expect(
        r.text == "key is [REDACTED:anthropic-key] ok" && r.redactions == 1,
        "anthropic key redacted",
    )?;
    let r = redact("AKIAIOSFODNN7EXAMPLE");
    expect(r.text.contains("[REDACTED:aws-akid]"), "aws access key id redacted")?;
    let r = redact("-----BEGIN RSA PRIVATE KEY-----\nMII...x\n-----END RSA PRIVATE KEY-----");
    expect(r.text == "[REDACTED:private-key]", "private key block redacted")?;
    let r = redact("password: hunter2-super-secret");
    expect(r.text.starts_with("[REDACTED:secret-kv]"), "password kv redacted")?;
    let r = redact("token aB3xK9mQ7rT2wY5zN8cV1bH4jL6pD0fG");
    expect(
        r.text.contains("[REDACTED:high-entropy]"),
        "high-entropy opaque token redacted",
    )?;
    let path = "/Users/goldi/Documents/code/zede/native/src/some/deep/path/file.rs";
    let r = redact(path);
    expect(r.text == path && r.redactions == 0, "filesystem paths untouched")?;
    let r = redact("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(r.redactions == 0, "low-entropy long token untouched")?;
    let plain = "we decided to use pnpm for this repo";
    let r = redact(plain);
    expect(r.text == plain, "ordinary prose untouched")?;
    Ok(())
}

fn check_memory_crud() -> Result<(), String> {
    let (db, dir) = temp_db()?;
    let space = db.create_space("Mem", None);
    let a = db.insert_memory(Some(&space.id), "space", "fact", "space-scoped fact", None, None);
    let _b = db.insert_memory(None, "global", "decision", "global decision", None, None);
    let other = db.create_space("Other", None);
    let _c = db.insert_memory(Some(&other.id), "space", "fact", "other space fact", None, None);

    let rows = db.list_memories(&space.id);
    expect(rows.len() == 2, "space sees own + global rows")?;
    db.set_memory_pinned(&a, true);
    let rows = db.list_memories(&space.id);
    expect(rows[0].id == a && rows[0].pinned, "pinned rows sort first")?;

    db.forget_memory(&a, "test");
    let rows = db.list_memories(&space.id);
    expect(rows.len() == 1, "forgotten memory leaves the list")?;
    expect(db.tombstone_count() == 1, "forget writes a tombstone")?;
    let _ = std::fs::remove_dir_all(dir);
    Ok(())
}

fn check_electron_import() -> Result<(), String> {
    let dir = std::env::temp_dir().join(format!("zede-selftest-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    // Fixture mimicking the Electron schema-v6 tables the importer touches.
    let src_path = dir.join("electron.db");
    {
        let src = rusqlite::Connection::open(&src_path).map_err(|e| e.to_string())?;
        src.execute_batch(
            "CREATE TABLE spaces (id TEXT PRIMARY KEY, name TEXT, icon TEXT, settings_json TEXT,
                                  sort_order INTEGER, created_at INTEGER, updated_at INTEGER);
             CREATE TABLE memories (id TEXT PRIMARY KEY, space_id TEXT, scope TEXT, type TEXT,
                                    content TEXT, confidence REAL, salience REAL, status TEXT,
                                    pinned INTEGER DEFAULT 0, use_count INTEGER DEFAULT 0,
                                    source_hash TEXT, created_at INTEGER, updated_at INTEGER,
                                    last_used_at INTEGER, edited_at INTEGER);
             CREATE TABLE tombstones (id TEXT PRIMARY KEY, fingerprint TEXT, scope TEXT,
                                      space_id TEXT, reason TEXT, created_at INTEGER, created_by TEXT);
             INSERT INTO spaces VALUES ('sp1', 'Imported Space', NULL, NULL, 1, 111, 111);
             INSERT INTO memories VALUES ('m1','sp1','space','fact','user prefers pnpm', 0.9, 0.5,
                                          'active', 1, 3, 'hash1', 100, 200, 150, 200);
             INSERT INTO memories VALUES ('m2',NULL,'global','decision','ship native rust', NULL, NULL,
                                          'active', 0, 0, NULL, 100, 200, NULL, 200);
             INSERT INTO memories VALUES ('m3','sp1','space','fact','deleted thing', NULL, NULL,
                                          'tombstoned', 0, 0, 'hash3', 100, 200, NULL, 200);
             INSERT INTO tombstones VALUES ('t1','hash3','space','sp1','user',300,'user');
             PRAGMA user_version = 6;",
        )
        .map_err(|e| e.to_string())?;
    }

    let native = Db::open(&dir.join("native.db"))?;
    let report = native.import_from_electron(&src_path)?;
    expect(report.spaces == 1, "space imported")?;
    expect(report.memories == 2, "active memories imported")?;
    expect(report.skipped == 1, "tombstoned memory skipped")?;
    expect(report.tombstones == 1, "tombstone ledger imported")?;

    let rows = native.list_memories("sp1");
    expect(rows.len() == 2, "imported space sees its memory + the global one")?;
    expect(
        rows.iter().any(|m| m.content == "user prefers pnpm" && m.pinned),
        "pin state survived import",
    )?;
    expect(
        native.list_spaces().iter().any(|s| s.name == "Imported Space"),
        "imported space listed",
    )?;

    let again = native.import_from_electron(&src_path)?;
    expect(
        again.memories == 0 && again.spaces == 0 && again.tombstones == 0,
        "second import is a no-op (idempotent)",
    )?;

    // The guard still refuses to OPEN the Electron db as our own.
    expect(
        Db::open(&src_path).is_err(),
        "native open refuses the electron db",
    )?;
    let _ = std::fs::remove_dir_all(dir);
    Ok(())
}

fn check_heuristic_extractor() -> Result<(), String> {
    let span = "I prefer tabs over spaces for indentation, always. \
                We decided to use pnpm for this repo. \
                my name is Goldi and that's that. \
                need to fix the login bug before friday. \
                I prefer tabs over spaces for indentation, always.";
    let out = extract::extract(span);
    let types: Vec<&str> = out.iter().map(|c| c.mtype).collect();
    expect(types.contains(&"preference"), "preference rule fires")?;
    expect(types.contains(&"decision"), "decision rule fires")?;
    expect(types.contains(&"entity"), "entity (name) rule fires")?;
    expect(types.contains(&"todo"), "todo rule fires")?;
    let name = out.iter().find(|c| c.mtype == "entity").ok_or("entity candidate")?;
    expect(
        name.scope_hint == extract::ScopeHint::Global,
        "name entity is globally scoped",
    )?;
    for c in &out {
        expect(
            c.content.chars().next().map(|ch| ch.is_uppercase() || !ch.is_alphabetic()).unwrap_or(false),
            "candidates are capitalized",
        )?;
        expect(
            c.content.ends_with(['.', '!', '?']),
            "candidates end with punctuation",
        )?;
    }
    let dupes = out
        .iter()
        .filter(|c| c.content.to_lowercase().contains("tabs over spaces"))
        .count();
    expect(dupes == 1, "duplicate matches dedupe")?;
    expect(extract::extract("short").is_empty(), "fragments dropped")?;
    Ok(())
}

fn check_learn_pipeline() -> Result<(), String> {
    let (db, dir) = temp_db()?;
    let space = db.create_space("Learn", None);

    let n = extract::learn_from_text(&db, &space.id, "we decided to use pnpm for this repo");
    expect(n == 1, "decision learned")?;
    let again = extract::learn_from_text(&db, &space.id, "We DECIDED to use pnpm for this repo!");
    expect(again == 0, "fingerprint dedupe suppresses re-derivation")?;

    let rows = db.list_memories(&space.id);
    expect(rows.len() == 1 && rows[0].mtype == "decision", "stored as a decision")?;
    let id = rows[0].id.clone();
    db.forget_memory(&id, "test");
    let n = extract::learn_from_text(&db, &space.id, "we decided to use pnpm for this repo");
    expect(n == 0, "tombstoned fingerprint never returns")?;

    let n = extract::learn_from_text(
        &db,
        &space.id,
        "we decided to use token=sk-ant-abc123def456ghi789jkl012 here",
    );
    if n > 0 {
        let rows = db.list_memories(&space.id);
        expect(
            rows.iter().all(|m| !m.content.contains("sk-ant-")),
            "redaction runs before storage",
        )?;
    }
    let _ = std::fs::remove_dir_all(dir);
    Ok(())
}

fn check_claude_envelope_parsing() -> Result<(), String> {
    use extract::parse_candidates;

    // structured_output envelope (current claude CLI shape).
    let out = parse_candidates(
        r#"{"structured_output":{"memories":[
            {"type":"decision","content":"Ship the rust port","confidence":0.9,"scope_hint":"space"},
            {"type":"preference","content":"Use pnpm","confidence":0.8,"scope_hint":"global"}
        ]}}"#,
    );
    expect(out.len() == 2, "structured_output envelope parsed")?;
    expect(out[0].mtype == "decision" && out[1].mtype == "preference", "types mapped")?;
    expect(
        out[1].scope_hint == extract::ScopeHint::Global,
        "global scope hint honored",
    )?;

    // result-as-JSON-string envelope (older shape).
    let out = parse_candidates(
        r#"{"result":"{\"memories\":[{\"type\":\"fact\",\"content\":\"The db is sqlite\",\"confidence\":0.7}]}"}"#,
    );
    expect(out.len() == 1 && out[0].mtype == "fact", "result-string envelope parsed")?;
    expect((out[0].confidence - 0.7).abs() < 1e-9, "confidence carried")?;

    // result-as-object envelope.
    let out = parse_candidates(
        r#"{"result":{"memories":[{"type":"todo","content":"Wire the watcher"}]}}"#,
    );
    expect(out.len() == 1, "result-object envelope parsed")?;
    expect((out[0].confidence - 0.5).abs() < 1e-9, "missing confidence defaults to 0.5")?;

    // Hostile/garbage output never reaches the store.
    let out = parse_candidates(
        r#"{"structured_output":{"memories":[
            {"type":"exploit","content":"bad type dropped","confidence":1},
            {"type":"fact","content":"","confidence":1},
            {"type":"fact"},
            "not-an-object"
        ]}}"#,
    );
    expect(out.is_empty(), "invalid types, empty and malformed items dropped")?;
    expect(parse_candidates("not json").is_empty(), "non-json stdout dropped")?;
    expect(parse_candidates("{}").is_empty(), "empty envelope dropped")?;
    Ok(())
}

fn check_extraction_worker() -> Result<(), String> {
    let (db, dir) = temp_db()?;
    let space = db.create_space("Worker", None);
    let (tx, rx) = extract::start_worker(None);
    tx.send(extract::LearnRequest {
        space_id: space.id.clone(),
        span: "User: we decided to use rusqlite for storage".into(),
        tier: "heuristic".into(),
    })
    .map_err(|e| e.to_string())?;
    let result = rx
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| "worker did not answer".to_string())?;
    expect(result.space_id == space.id, "result carries the space")?;
    expect(!result.candidates.is_empty(), "worker extracted a candidate")?;
    let stored = extract::store_candidates(&db, &result.space_id, &result.candidates);
    expect(stored > 0, "worker results store")?;
    let again = extract::store_candidates(&db, &result.space_id, &result.candidates);
    expect(again == 0, "re-storing the same result dedupes")?;
    let _ = std::fs::remove_dir_all(dir);
    Ok(())
}

fn mem_row(content: &str, mtype: &str, pinned: bool, salience: Option<f64>) -> MemoryRow {
    MemoryRow {
        id: uuid::Uuid::new_v4().to_string(),
        space_id: None,
        scope: "space".into(),
        mtype: mtype.into(),
        content: content.into(),
        pinned,
        use_count: 0,
        confidence: None,
        salience,
        created_at: Some(0),
        updated_at: Some(0),
        last_used_at: None,
    }
}

fn check_ranker_budget() -> Result<(), String> {
    let mut rows = vec![mem_row("pinned but low salience", "fact", true, Some(0.0))];
    for i in 0..200 {
        rows.push(mem_row(
            &format!("unpinned filler memory number {i} with some extra words to cost tokens"),
            "fact",
            false,
            Some(0.9),
        ));
    }
    let selected = inject::select(&rows, 0);
    expect(selected[0].pinned, "pinned row selected first despite low score")?;
    let tokens: usize = selected.iter().map(|r| inject::est_tokens(&r.content)).sum();
    expect(tokens <= 1500 + 600, "selection respects the token budget")?;
    expect(selected.len() < rows.len(), "over-budget rows are dropped")?;
    Ok(())
}

fn check_context_writer() -> Result<(), String> {
    let dir = std::env::temp_dir().join(format!("zede-selftest-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(dir.join(".git")).map_err(|e| e.to_string())?;
    std::fs::write(
        dir.join("CLAUDE.md"),
        "# My project\n\nSome instructions.\n\n<!-- loom:begin (managed — do not edit) -->\n@.loom/context.md\n<!-- loom:end -->\n",
    )
    .map_err(|e| e.to_string())?;

    let rows = vec![
        mem_row("Use pnpm not npm", "preference", true, None),
        mem_row("Ship the native rust port", "decision", false, None),
    ];
    let cwd = dir.to_string_lossy().to_string();
    inject::write_context(&cwd, &rows, "Default");

    let ctx = std::fs::read_to_string(dir.join(".zede/context.md")).map_err(|e| e.to_string())?;
    expect(ctx.starts_with("# Zede memory — Default"), "context header")?;
    expect(ctx.contains("## Preferences") && ctx.contains("📌 Use pnpm not npm"), "pinned preference rendered")?;
    expect(ctx.contains("## Decisions"), "decision section rendered")?;

    let claude_md = std::fs::read_to_string(dir.join("CLAUDE.md")).map_err(|e| e.to_string())?;
    expect(claude_md.contains("# My project"), "existing CLAUDE.md content kept")?;
    expect(claude_md.contains("@.zede/context.md"), "import line added")?;
    expect(!claude_md.contains("loom:begin"), "legacy loom block stripped")?;

    let gi = std::fs::read_to_string(dir.join(".gitignore")).map_err(|e| e.to_string())?;
    expect(gi.contains(".zede/"), "gitignore wired")?;

    inject::write_context(&cwd, &rows, "Default");
    let claude_md2 = std::fs::read_to_string(dir.join("CLAUDE.md")).map_err(|e| e.to_string())?;
    expect(
        claude_md2.matches("zede:begin").count() == 1,
        "managed block not duplicated on rewrite",
    )?;
    let _ = std::fs::remove_dir_all(dir);
    Ok(())
}

#[cfg(unix)]
fn check_pty_end_to_end() -> Result<(), String> {
    let osc = Arc::new(RwLock::new(osc_from_theme(theme::theme_by_id("one-dark"))));
    let mut session = TermSession::spawn_raw(
        "/bin/sh",
        &["-c", "read line; printf 'echoed:%s' \"$line\""],
        "/tmp",
        1000,
        block_cursor(),
        osc,
    )?;
    std::thread::sleep(Duration::from_millis(120));
    session.write(b"zede-native\r");
    let ok = wait_until(Duration::from_secs(5), || {
        grid_text(&session).contains("echoed:zede-native")
    });
    expect(ok, "pty output reached the grid (spawn -> write -> parse -> cells)")?;
    let dead = wait_until(Duration::from_secs(5), || session.is_dead());
    expect(dead, "reader thread noticed EOF")?;
    expect(session.exit_code() == 0, "clean exit code")?;
    session.kill();
    Ok(())
}

#[cfg(unix)]
fn check_pty_scrollback() -> Result<(), String> {
    let osc = Arc::new(RwLock::new(osc_from_theme(theme::theme_by_id("one-dark"))));
    let session = TermSession::spawn_raw(
        "/bin/sh",
        &["-c", "i=0; while [ $i -lt 60 ]; do echo line-$i; i=$((i+1)); done"],
        "/tmp",
        1000,
        block_cursor(),
        osc,
    )?;
    let ok = wait_until(Duration::from_secs(5), || grid_text(&session).contains("line-59"));
    expect(ok, "burst output parsed")?;
    // 60 lines on a 24-row grid: earlier lines must live in scrollback.
    session.scroll_display(30);
    let scrolled = grid_text(&session);
    expect(scrolled.contains("line-1"), "scrollback holds early lines")?;
    session.scroll_to_bottom();
    expect(grid_text(&session).contains("line-59"), "scroll to bottom restores tail")?;
    Ok(())
}

pub fn run() -> i32 {
    let mut checks: Vec<Check> = vec![
        ("db migrate + seed", check_db_migrate_seed),
        ("db tab roundtrip", check_db_tab_roundtrip),
        ("settings normalize", check_settings_normalize),
        ("settings defaults", check_settings_defaults),
        ("cwd encoding + transcript path", check_cwd_encoding),
        ("uuid guard", check_uuid_guard),
        ("spawn plan: claude", check_spawn_plan_claude),
        ("spawn plan: resume + injection guard", check_spawn_plan_resume),
        ("terminal env rules", check_env_rules),
        ("key encoding", check_key_encoding),
        ("color math", check_color_math),
        ("shell process detection", check_shell_detection),
        ("prompt parser filters", check_prompt_parser_filters),
        ("prompt feed incremental reads", check_prompt_feed_incremental),
        ("secret redaction", check_redaction),
        ("memory crud + tombstones", check_memory_crud),
        ("electron db import", check_electron_import),
        ("heuristic extractor", check_heuristic_extractor),
        ("claude envelope parsing", check_claude_envelope_parsing),
        ("extraction worker roundtrip", check_extraction_worker),
        ("learn pipeline dedupe + suppression", check_learn_pipeline),
        ("ranker token budget", check_ranker_budget),
        ("context writer + CLAUDE.md wiring", check_context_writer),
    ];
    #[cfg(unix)]
    {
        checks.push(("pty end-to-end", check_pty_end_to_end));
        checks.push(("pty scrollback", check_pty_scrollback));
    }

    let total = checks.len();
    let mut passed = 0usize;
    for (name, check) in checks {
        match check() {
            Ok(()) => {
                println!("ok   — {name}");
                passed += 1;
            }
            Err(err) => println!("FAIL — {name}: {err}"),
        }
    }
    println!("selftest: {passed}/{total} passed");
    if passed == total {
        0
    } else {
        1
    }
}
