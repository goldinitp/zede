//! PTY spawn planning: environment rules, shell/claude command construction,
//! transcript paths and foreground-process helpers. Ported from
//! `src/main/pty/{env,manager}.ts` and `src/main/capture/paths.ts`.

use std::collections::BTreeMap;
use std::path::PathBuf;

use uuid::Uuid;

/// Environment every Zede PTY gets, inherited by a hand-started `claude` too.
/// `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` is load-bearing: Claude Code is a
/// full-screen TUI and its alternate screen has no scrollback, which collapses
/// the whole scrollback story the app is built on.
pub const TERMINAL_ENV: &[(&str, &str)] = &[
    ("CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN", "1"),
    ("TERM", "xterm-256color"),
    ("COLORTERM", "truecolor"),
    ("TERM_PROGRAM", "Zede"),
    ("CLICOLOR", "1"),
];

/// Host-process env that must not leak into an interactive terminal (IDE and
/// agent hosts disable color or tag their subprocesses).
pub const HOST_ONLY_ENV: &[&str] = &[
    "NO_COLOR",
    "FORCE_COLOR",
    "CURSOR_AGENT",
    "CURSOR_CONVERSATION_ID",
    "AGENT_TRANSCRIPTS",
    "__CURSOR_SANDBOX_ENV_RESTORE",
];

/// Build a clean interactive-terminal environment from the host env.
pub fn terminal_environment() -> Vec<(String, String)> {
    let mut env: BTreeMap<String, String> = std::env::vars()
        .filter(|(k, _)| !HOST_ONLY_ENV.contains(&k.as_str()))
        .collect();
    for (k, v) in TERMINAL_ENV {
        env.insert((*k).to_string(), (*v).to_string());
    }
    env.into_iter().collect()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TabKind {
    Claude,
    Shell,
}

impl TabKind {
    pub fn as_str(self) -> &'static str {
        match self {
            TabKind::Claude => "claude",
            TabKind::Shell => "shell",
        }
    }

    pub fn from_str(s: &str) -> TabKind {
        match s {
            "shell" => TabKind::Shell,
            _ => TabKind::Claude,
        }
    }
}

/// Session and conversation ids are always v4-shaped UUIDs (ours and claude's
/// own). Anything else is a tampered or corrupt record — reject it before the
/// id reaches a shell string or a filesystem path.
pub fn is_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 36 {
        return false;
    }
    for (i, ch) in b.iter().enumerate() {
        match i {
            8 | 13 | 18 | 23 => {
                if *ch != b'-' {
                    return false;
                }
            }
            _ => {
                if !ch.is_ascii_hexdigit() {
                    return false;
                }
            }
        }
    }
    true
}

/// Lossy/non-invertible forward encoder (every non-alphanumeric -> '-').
/// Only ever compute forward from a known cwd; never decode.
pub fn encode_cwd(cwd: &str) -> String {
    cwd.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

pub fn transcript_dir_for(cwd: &str) -> PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"));
    home.join(".claude").join("projects").join(encode_cwd(cwd))
}

pub fn transcript_path_for(cwd: &str, session_id: &str) -> PathBuf {
    transcript_dir_for(cwd).join(format!("{session_id}.jsonl"))
}

pub fn default_shell() -> String {
    if cfg!(windows) {
        std::env::var("ZEDE_SHELL").unwrap_or_else(|_| "powershell.exe".to_string())
    } else {
        std::env::var("ZEDE_SHELL")
            .or_else(|_| std::env::var("SHELL"))
            .unwrap_or_else(|_| "/bin/zsh".to_string())
    }
}

#[derive(Clone, Debug)]
pub struct SpawnPlan {
    pub program: String,
    pub args: Vec<String>,
    /// Client-generated (or resumed) Claude session id. The transcript path is
    /// deterministic from cwd + this id, so capture needs no discovery step.
    pub session_id: String,
    pub resumed: bool,
}

/// Build the shell invocation for a tab.
///
/// POSIX claude tabs need an interactive login shell (`-i -l`): zsh only reads
/// .zshrc for INTERACTIVE shells, and that's how `claude` lands on PATH when
/// the app is launched from the GUI. claude runs AS the shell's command (typing
/// it raced shell startup and dropped flags); afterwards `exec $SHELL -il`
/// drops to an interactive shell so the tab stays usable.
pub fn spawn_plan(kind: TabKind, resume_session_id: Option<&str>) -> SpawnPlan {
    let shell = default_shell();
    let resume = resume_session_id.filter(|s| is_uuid(s));
    let session_id = resume
        .map(str::to_string)
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let resumed = resume.is_some();
    let windows = cfg!(windows);

    let args = match kind {
        TabKind::Claude => {
            let id_flag = if resumed {
                format!("--resume {session_id}")
            } else {
                format!("--session-id {session_id}")
            };
            let claude_cmd = format!("claude {id_flag}");
            if windows {
                vec![
                    "-NoLogo".into(),
                    "-NoExit".into(),
                    "-Command".into(),
                    claude_cmd,
                ]
            } else {
                vec![
                    "-i".into(),
                    "-l".into(),
                    "-c".into(),
                    format!("{claude_cmd}; exec {shell} -il"),
                ]
            }
        }
        TabKind::Shell => {
            if windows {
                vec!["-NoLogo".into()]
            } else {
                vec!["-l".into()]
            }
        }
    };

    SpawnPlan { program: shell, args, session_id, resumed }
}

/// POSIX single-quote (close-escape-reopen for embedded quotes). Used for
/// paths pasted into the terminal on file drop.
#[allow(dead_code)] // wired up with file-drop support (P5)
pub fn shell_quote(p: &str) -> String {
    if cfg!(windows) {
        format!("'{}'", p.replace('\'', "''"))
    } else {
        format!("'{}'", p.replace('\'', "'\\''"))
    }
}

const SHELL_NAMES: &[&str] = &[
    "zsh", "bash", "fish", "sh", "dash", "tcsh", "nu", "pwsh", "powershell", "cmd",
];

/// True when a foreground process name is a shell (used to defer SIGWINCH on
/// idle tabs — rich prompts like Powerlevel10k append a redraw per resize).
pub fn is_shell_process(name: &str) -> bool {
    let base = name
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(name)
        .trim_start_matches('-')
        .to_ascii_lowercase();
    let base = base.strip_suffix(".exe").unwrap_or(&base);
    SHELL_NAMES.contains(&base)
}

/// Name of a live process, for the shell→claude tab icon swap and resize
/// deferral. Best-effort; `None` on unsupported platforms.
#[cfg(target_os = "macos")]
pub fn process_name(pid: i32) -> Option<String> {
    libproc::libproc::proc_pid::name(pid).ok()
}

#[cfg(target_os = "linux")]
pub fn process_name(pid: i32) -> Option<String> {
    std::fs::read_to_string(format!("/proc/{pid}/comm"))
        .ok()
        .map(|s| s.trim().to_string())
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn process_name(_pid: i32) -> Option<String> {
    None
}
