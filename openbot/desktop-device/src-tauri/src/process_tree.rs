//! Starting the runner so that everything it starts can be stopped with it.
//!
//! The runner is not one process. It runs shell commands for an assistant and drives a browser, and
//! `playwright-core` starts that browser in a process group of its own on macOS and Linux. Killing
//! the runner's pid, or even its process group, leaves the browser and whatever a command left
//! behind running after the app has quit, which is the failure WIN1 is about: an app that says it
//! has stopped while a machine is still being worked on.
//!
//! - **Windows**: the runner is put in a job object that kills every process in it when the job's
//!   last handle closes. Children join their parent's job, so the browser and every command are in
//!   it too, and the handle closes when this app exits for any reason, including a crash.
//! - **macOS and Linux**: there is no job object, so the tree is read from `ps` while the runner is
//!   still alive (once it exits its children are re-parented and can no longer be found that way),
//!   the runner is asked to stop with SIGTERM so it can close its browser and let it save its
//!   profile, and after a grace period everything in the tree that is still running is killed.

use std::io;
use std::process::{Child, Command, ExitStatus};
use std::time::{Duration, Instant};

/// A started process and the means to stop everything under it.
pub struct Tree {
    child: Child,
    exited: Option<ExitStatus>,
    #[cfg(windows)]
    job: Option<windows::Job>,
}

/// Start `command` in a form [`Tree::kill_tree`] can stop completely.
pub fn spawn(mut command: Command) -> io::Result<Tree> {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Its own group, so a Ctrl-C meant for a terminal that launched this app in development does
        // not reach the runner, and so stragglers that stayed in the group can be killed as one.
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // A console program started from a windowed app would otherwise open a console window.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let child = command.spawn()?;
    #[cfg(windows)]
    {
        // Assigned after start: std has no way to start a process suspended. The runner takes far
        // longer to load than this takes, so nothing it starts can escape the job in between. If the
        // job cannot be made, `kill_tree` falls back to `taskkill /T`.
        let job = windows::Job::new()
            .and_then(|job| job.assign(&child).map(|_| job))
            .map_err(|error| eprintln!("[device] no job object for the runner: {error}"))
            .ok();
        Ok(Tree {
            child,
            exited: None,
            job,
        })
    }
    #[cfg(not(windows))]
    Ok(Tree {
        child,
        exited: None,
    })
}

impl Tree {
    pub fn id(&self) -> u32 {
        self.child.id()
    }

    pub fn child_mut(&mut self) -> &mut Child {
        &mut self.child
    }

    /// Whether the process has exited, without waiting for it.
    pub fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        if self.exited.is_none() {
            self.exited = self.child.try_wait()?;
        }
        Ok(self.exited)
    }

    /// Stop the process and everything it started. Waits at most about `grace` for the process to
    /// stop on its own before killing what is left.
    pub fn kill_tree(&mut self, grace: Duration) {
        #[cfg(unix)]
        self.kill_tree_unix(grace);
        #[cfg(windows)]
        self.kill_tree_windows(grace);
        // Reap it, so it does not stay a zombie for as long as this app runs.
        if self.exited.is_none() {
            self.exited = self.child.wait().ok();
        }
    }

    #[cfg(unix)]
    fn kill_tree_unix(&mut self, grace: Duration) {
        let root = self.child.id();
        // Read first. After the root exits, its children belong to init and the tree is gone.
        let tree = if self.try_wait().ok().flatten().is_none() {
            ps_table()
                .map(|table| descendants(root, &table))
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        if self.exited.is_none() {
            signal(root, libc::SIGTERM);
            let until = Instant::now() + grace;
            while Instant::now() < until {
                if self.try_wait().ok().flatten().is_some() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
        }
        if self.exited.is_none() {
            signal(root, libc::SIGKILL);
        }
        // The group the runner was started in: whatever stayed in it, found or not.
        // SAFETY: killpg only sends a signal; a group that no longer exists is an ESRCH.
        unsafe {
            libc::killpg(root as libc::pid_t, libc::SIGKILL);
        }
        for pid in tree {
            signal(pid, libc::SIGKILL);
        }
    }

    #[cfg(windows)]
    fn kill_tree_windows(&mut self, _grace: Duration) {
        // There is no SIGTERM for a console process without a console. The runner gets no chance to
        // close its browser here; the browser's profile is written on the next start instead.
        if let Some(job) = &self.job {
            if job.terminate() {
                return;
            }
        }
        if self.try_wait().ok().flatten().is_none() {
            let _ = Command::new("taskkill")
                .args(["/PID", &self.child.id().to_string(), "/T", "/F"])
                .output();
            let _ = self.child.kill();
        }
    }
}

impl Drop for Tree {
    /// A tree nobody stopped is stopped now, without waiting.
    fn drop(&mut self) {
        if self.try_wait().ok().flatten().is_none() {
            self.kill_tree(Duration::ZERO);
        }
    }
}

#[cfg(unix)]
fn signal(pid: u32, signal: libc::c_int) {
    // SAFETY: kill only sends a signal; a pid that is gone is an ESRCH, which is the goal.
    unsafe {
        libc::kill(pid as libc::pid_t, signal);
    }
}

/// `(pid, parent pid)` for every process, as `ps` reports it on macOS and Linux.
#[cfg(unix)]
fn ps_table() -> Option<Vec<(u32, u32)>> {
    let output = Command::new("ps")
        .args(["-A", "-o", "pid=", "-o", "ppid="])
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| parse_ps_table(&String::from_utf8_lossy(&output.stdout)))
}

/// Parse `ps -o pid= -o ppid=` output. Lines that are not two numbers are skipped.
pub fn parse_ps_table(text: &str) -> Vec<(u32, u32)> {
    text.lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let pid = fields.next()?.parse().ok()?;
            let parent = fields.next()?.parse().ok()?;
            fields.next().is_none().then_some((pid, parent))
        })
        .collect()
}

/// Every process below `root`, children before grandchildren. `root` itself is not included.
pub fn descendants(root: u32, table: &[(u32, u32)]) -> Vec<u32> {
    let mut found = Vec::new();
    let mut frontier = vec![root];
    while let Some(parent) = frontier.pop() {
        for &(pid, ppid) in table {
            // `pid != root` and the `contains` check keep a malformed table from looping forever.
            if ppid == parent && pid != root && pid != ppid && !found.contains(&pid) {
                found.push(pid);
                frontier.push(pid);
            }
        }
    }
    found
}

/// Whether `pid` is a process that is still running (a zombie is not). For the tests.
#[cfg(test)]
pub fn is_running(pid: u32) -> bool {
    #[cfg(unix)]
    {
        // SAFETY: signal 0 only checks that the process exists.
        if unsafe { libc::kill(pid as libc::pid_t, 0) } != 0 {
            return false;
        }
        // An orphan nobody has reaped yet still answers kill(0). `ps` says whether it is a zombie.
        Command::new("ps")
            .args(["-o", "stat=", "-p", &pid.to_string()])
            .output()
            .map(|output| {
                let state = String::from_utf8_lossy(&output.stdout);
                let state = state.trim();
                !state.is_empty() && !state.starts_with('Z')
            })
            .unwrap_or(true)
    }
    #[cfg(windows)]
    {
        windows::is_running(pid)
    }
}

#[cfg(windows)]
mod windows {
    use std::io;
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    /// A job object that kills its processes when its last handle closes.
    pub struct Job(HANDLE);

    // SAFETY: a job handle is a kernel handle, usable from any thread.
    unsafe impl Send for Job {}

    impl Job {
        pub fn new() -> io::Result<Self> {
            // SAFETY: null attributes and name ask for an unnamed job with default security.
            let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if handle.is_null() {
                return Err(io::Error::last_os_error());
            }
            let job = Job(handle);
            // SAFETY: an all-zero JOBOBJECT_EXTENDED_LIMIT_INFORMATION is the "no limits" value.
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            // SAFETY: `info` is the structure this information class names, with its own size.
            let ok = unsafe {
                SetInformationJobObject(
                    job.0,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const core::ffi::c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            };
            if ok == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(job)
        }

        pub fn assign(&self, child: &Child) -> io::Result<()> {
            // SAFETY: the child's handle is valid for as long as `child` is.
            let ok = unsafe { AssignProcessToJobObject(self.0, child.as_raw_handle() as HANDLE) };
            if ok == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        }

        pub fn terminate(&self) -> bool {
            // SAFETY: ends every process in the job; the handle stays valid.
            unsafe { TerminateJobObject(self.0, 1) != 0 }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            // SAFETY: closing the last handle is what KILL_ON_JOB_CLOSE acts on.
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    #[cfg(test)]
    pub fn is_running(pid: u32) -> bool {
        use windows_sys::Win32::System::Threading::{
            GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        const STILL_ACTIVE: u32 = 259;
        // SAFETY: a handle opened here is closed here; a failed open means the process is gone.
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                return false;
            }
            let mut code = 0u32;
            let ok = GetExitCodeProcess(handle, &mut code);
            CloseHandle(handle);
            ok != 0 && code == STILL_ACTIVE
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    #[test]
    fn ps_output_is_read_as_pid_and_parent() {
        let table = parse_ps_table("    1     0\n  412     1\nnot a line\n  9 8 7\n 500   412\n");
        assert_eq!(table, vec![(1, 0), (412, 1), (500, 412)]);
    }

    #[test]
    fn descendants_include_grandchildren_and_not_siblings() {
        let table = [(10, 1), (11, 10), (12, 11), (13, 10), (20, 1), (21, 20)];
        let mut found = descendants(10, &table);
        found.sort();
        assert_eq!(found, vec![11, 12, 13]);
        assert!(descendants(99, &table).is_empty());
    }

    #[test]
    fn a_malformed_table_does_not_loop() {
        // A cycle cannot happen in a real table, but a snapshot taken while pids are reused can look
        // like one.
        let table = [(10, 11), (11, 10), (12, 12)];
        assert_eq!(descendants(10, &table), vec![11]);
    }

    /// The fake runner used by the tests below: this test binary, started again with an
    /// environment variable that makes the ignored test `fake_child` behave as one.
    pub(crate) fn fake(mode: &str) -> Command {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "process_tree::tests::fake_child",
                "--exact",
                "--ignored",
                "--nocapture",
                "--test-threads=1",
            ])
            .env("XB_FAKE_CHILD", mode)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null());
        command
    }

    /// Not a test: the body of the fake runner. Does nothing unless started by `fake`.
    ///
    /// Modes: `exit:<code>` exits at once; `sleep` sleeps; `tree:<file>` starts a grandchild in a
    /// process group of its own (as playwright starts a browser), writes both pids to `<file>`,
    /// ignores SIGTERM (a runner that will not stop) and sleeps.
    #[test]
    #[ignore]
    // The grandchild is meant to be left behind: that is what kill_tree has to find.
    #[allow(clippy::zombie_processes)]
    fn fake_child() {
        let Ok(mode) = std::env::var("XB_FAKE_CHILD") else {
            return;
        };
        if let Some(code) = mode.strip_prefix("exit:") {
            println!("runner: fake exiting with {code}");
            std::process::exit(code.parse().unwrap());
        }
        if let Some(file) = mode.strip_prefix("tree:") {
            let mut grandchild = fake("sleep");
            #[cfg(unix)]
            {
                use std::os::unix::process::CommandExt;
                grandchild.process_group(0);
                // SAFETY: ignoring a signal has no preconditions.
                unsafe {
                    libc::signal(libc::SIGTERM, libc::SIG_IGN);
                }
            }
            let grandchild = grandchild.spawn().unwrap();
            std::fs::write(file, format!("{} {}", std::process::id(), grandchild.id())).unwrap();
        }
        std::thread::sleep(Duration::from_secs(60));
        std::process::exit(0);
    }

    pub(crate) fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "xb-device-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn read_pids(file: &Path) -> (u32, u32) {
        let until = Instant::now() + Duration::from_secs(20);
        loop {
            if let Ok(text) = std::fs::read_to_string(file) {
                let mut parts = text.split_whitespace().map(|p| p.parse().unwrap());
                if let (Some(child), Some(grandchild)) = (parts.next(), parts.next()) {
                    return (child, grandchild);
                }
            }
            assert!(
                Instant::now() < until,
                "the fake runner never started its grandchild"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn wait_gone(pid: u32) -> bool {
        let until = Instant::now() + Duration::from_secs(10);
        while Instant::now() < until {
            if !is_running(pid) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        false
    }

    #[test]
    fn kill_tree_stops_the_runner_and_a_grandchild_outside_its_group() {
        let dir = scratch("tree");
        let file = dir.join("pids");
        let mut tree = spawn(fake(&format!("tree:{}", file.display()))).unwrap();
        let (child, grandchild) = read_pids(&file);
        assert_eq!(child, tree.id());
        assert!(is_running(grandchild));

        let started = Instant::now();
        tree.kill_tree(Duration::from_millis(300));
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "a runner that ignores SIGTERM is killed after the grace period, not waited on"
        );
        assert!(
            tree.try_wait().unwrap().is_some(),
            "the runner itself is gone"
        );
        assert!(
            wait_gone(grandchild),
            "a process the runner started in its own group outlived the app (WIN1)"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn dropping_a_tree_stops_it() {
        let dir = scratch("drop");
        let file = dir.join("pids");
        let tree = spawn(fake(&format!("tree:{}", file.display()))).unwrap();
        let (child, grandchild) = read_pids(&file);
        drop(tree);
        assert!(wait_gone(child));
        assert!(wait_gone(grandchild));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn an_exited_process_reports_its_status() {
        let mut tree = spawn(fake("exit:3")).unwrap();
        let until = Instant::now() + Duration::from_secs(20);
        let status = loop {
            if let Some(status) = tree.try_wait().unwrap() {
                break status;
            }
            assert!(Instant::now() < until);
            std::thread::sleep(Duration::from_millis(20));
        };
        assert_eq!(status.code(), Some(3));
        // Stopping something that already stopped is not an error.
        tree.kill_tree(Duration::from_millis(10));
    }
}
