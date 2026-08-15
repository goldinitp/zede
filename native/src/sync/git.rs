//! Thin git runner for sync, ported from `src/main/sync/git.ts`. Every call
//! resolves to a result instead of panicking; network calls get the long
//! timeout. `GIT_TERMINAL_PROMPT=0` makes a missing credential fail fast
//! instead of wedging on an invisible prompt.

use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const LOCAL_TIMEOUT: Duration = Duration::from_secs(30);
const NETWORK_TIMEOUT: Duration = Duration::from_secs(120);

pub struct RunResult {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum GitAuth {
    /// Plain git: whatever credentials the user's git already has (ssh keys,
    /// credential helpers, a NAS remote, a local bare repo…).
    Git,
    /// Delegate credentials to the GitHub CLI's own store.
    GhCli,
}

fn auth_args(auth: GitAuth) -> Vec<String> {
    match auth {
        GitAuth::Git => Vec::new(),
        // The leading empty helper clears any system helper so a stale
        // keychain credential can't shadow the intended one.
        GitAuth::GhCli => vec![
            "-c".into(),
            "credential.helper=".into(),
            "-c".into(),
            "credential.helper=!gh auth git-credential".into(),
        ],
    }
}

fn run(bin: &str, args: &[String], cwd: Option<&Path>, timeout: Duration) -> RunResult {
    let mut cmd = Command::new(bin);
    cmd.args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return RunResult { code: -1, stdout: String::new(), stderr: e.to_string() },
    };

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let out_handle = std::thread::spawn(move || {
        use std::io::Read;
        let mut s = String::new();
        if let Some(mut p) = stdout {
            let _ = p.read_to_string(&mut s);
        }
        s
    });
    let err_handle = std::thread::spawn(move || {
        use std::io::Read;
        let mut s = String::new();
        if let Some(mut p) = stderr {
            let _ = p.read_to_string(&mut s);
        }
        s
    });

    let start = Instant::now();
    let code = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code().unwrap_or(-1),
            Ok(None) => {
                if start.elapsed() > timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    break -1;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(_) => break -1,
        }
    };
    RunResult {
        code,
        stdout: out_handle.join().unwrap_or_default(),
        stderr: err_handle.join().unwrap_or_default(),
    }
}

pub fn git(dir: &Path, args: &[&str], auth: GitAuth, network: bool) -> RunResult {
    let mut full: Vec<String> = vec!["-C".into(), dir.to_string_lossy().into_owned()];
    full.extend(auth_args(auth));
    full.extend(args.iter().map(|s| s.to_string()));
    run("git", &full, None, if network { NETWORK_TIMEOUT } else { LOCAL_TIMEOUT })
}

pub fn git_available() -> bool {
    run("git", &["--version".into()], None, LOCAL_TIMEOUT).code == 0
}

/// Init (idempotent) + point origin at the remote. Identity is passed
/// per-commit via -c, so nothing is written to the user's git config.
pub fn ensure_repo(dir: &Path, remote_url: &str) -> Option<String> {
    let init = git(dir, &["init", "-b", "main"], GitAuth::Git, false);
    if init.code != 0 {
        return Some(format!("git init failed: {}", init.stderr.trim()));
    }
    let has = git(dir, &["remote", "get-url", "origin"], GitAuth::Git, false);
    let r = if has.code == 0 {
        git(dir, &["remote", "set-url", "origin", remote_url], GitAuth::Git, false)
    } else {
        git(dir, &["remote", "add", "origin", remote_url], GitAuth::Git, false)
    };
    if r.code == 0 {
        None
    } else {
        Some(format!("git remote failed: {}", r.stderr.trim()))
    }
}

pub enum FetchOutcome {
    Ok,
    NoRemoteBranch,
    Offline,
}

pub fn fetch_main(dir: &Path, auth: GitAuth) -> FetchOutcome {
    let r = git(dir, &["fetch", "origin", "main"], auth, true);
    if r.code == 0 {
        return FetchOutcome::Ok;
    }
    // A brand-new remote has no main yet — a fine state, not offline.
    if r.stderr.to_lowercase().contains("couldn't find remote ref") {
        return FetchOutcome::NoRemoteBranch;
    }
    FetchOutcome::Offline
}

/// Adopt the remote tree exactly. Guarded so a bug can never hard-reset
/// anything but the dedicated sync working copy (regenerable from the DB).
pub fn reset_to_remote(dir: &Path) -> Result<bool, String> {
    if dir.file_name().and_then(|n| n.to_str()) != Some("sync") {
        return Err(format!("refusing to hard-reset non-sync dir: {}", dir.display()));
    }
    Ok(git(dir, &["reset", "--hard", "origin/main"], GitAuth::Git, false).code == 0)
}

/// Stage everything and commit if anything changed.
pub fn commit_all(dir: &Path, message: &str) -> Result<bool, String> {
    let add = git(dir, &["add", "-A"], GitAuth::Git, false);
    if add.code != 0 {
        return Err(add.stderr.trim().to_string());
    }
    let clean = git(dir, &["diff", "--cached", "--quiet"], GitAuth::Git, false).code == 0;
    let no_head = git(dir, &["rev-parse", "--verify", "HEAD"], GitAuth::Git, false).code != 0;
    if clean && !no_head {
        return Ok(false);
    }
    let c = git(
        dir,
        &[
            "-c", "user.name=Zede Sync",
            "-c", "user.email=sync@zede.local",
            "commit", "-m", message, "--allow-empty-message",
        ],
        GitAuth::Git,
        false,
    );
    if c.code != 0 {
        let all = format!("{}{}", c.stdout, c.stderr).to_lowercase();
        if all.contains("nothing to commit") {
            return Ok(false);
        }
        return Err(c.stderr.trim().to_string());
    }
    Ok(true)
}

pub enum PushOutcome {
    Ok,
    Rejected,
    Auth,
    Offline,
}

pub fn push(dir: &Path, auth: GitAuth) -> PushOutcome {
    let r = git(dir, &["push", "-u", "origin", "main"], auth, true);
    if r.code == 0 {
        return PushOutcome::Ok;
    }
    let err = r.stderr.to_lowercase();
    if err.contains("[rejected]") || err.contains("non-fast-forward") || err.contains("fetch first")
    {
        return PushOutcome::Rejected;
    }
    if err.contains("authentication")
        || err.contains("permission")
        || err.contains("403")
        || err.contains("401")
        || err.contains("could not read username")
        || err.contains("invalid credentials")
    {
        return PushOutcome::Auth;
    }
    PushOutcome::Offline
}
