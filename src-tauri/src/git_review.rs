use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
};

#[cfg(unix)]
use std::os::unix::process::ExitStatusExt;
#[cfg(windows)]
use std::os::windows::process::ExitStatusExt;

#[derive(Debug, Deserialize)]
pub(crate) struct GitReviewStartInput {
    pub(crate) path: String,
    #[serde(default)]
    pub(crate) create_repo: bool,
}

#[derive(Debug, Deserialize)]
pub(crate) struct GitReviewRefreshInput {
    pub(crate) path: String,
    pub(crate) baseline_commit: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct GitReviewHunkInput {
    pub(crate) path: String,
    pub(crate) patch: String,
    pub(crate) expected_commit: String,
    #[serde(default)]
    pub(crate) message: Option<String>,
    #[serde(default)]
    pub(crate) assets: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct GitReviewAllInput {
    pub(crate) path: String,
    pub(crate) expected_commit: String,
    #[serde(default)]
    pub(crate) assets: Vec<String>,
    #[serde(default)]
    pub(crate) message: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct GitReviewRejectInput {
    pub(crate) path: String,
    #[serde(default)]
    pub(crate) assets: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct GitReviewPayload {
    pub(crate) state: String,
    pub(crate) repo_root: Option<String>,
    pub(crate) relative_path: Option<String>,
    pub(crate) baseline_commit: Option<String>,
    pub(crate) baseline_content: Option<String>,
    pub(crate) head_changed: bool,
    pub(crate) committed: bool,
}

#[tauri::command]
pub(crate) fn git_review_start(input: GitReviewStartInput) -> Result<GitReviewPayload, String> {
    let path = validated_file_path(&input.path)?;
    let mut repo = discover_repo(&path)?;
    if repo.is_none() {
        if !input.create_repo {
            return Ok(empty_payload("requires-init"));
        }
        let root = path
            .parent()
            .ok_or_else(|| "无法确定文档所在目录".to_string())?;
        run_git(root, &["init"])?;
        repo = discover_repo(&path)?;
    }
    let repo = repo.ok_or_else(|| "Git 仓库初始化失败".to_string())?;
    let relative = relative_path(&repo, &path)?;
    let tracked = run_git_allow_failure(&repo, &["ls-files", "--error-unmatch", "--", &relative])
        .status
        .success();
    let mut committed = false;
    if !tracked {
        run_git(&repo, &["add", "--", &relative])?;
        commit_path(&repo, &relative, &format!("Markit review: add {} as baseline", file_name(&path)))?;
        committed = true;
    }
    payload_for_head(&repo, &relative, committed)
}

#[tauri::command]
pub(crate) fn git_review_refresh(input: GitReviewRefreshInput) -> Result<GitReviewPayload, String> {
    let path = validated_file_path(&input.path)?;
    let repo = discover_repo(&path)?.ok_or_else(|| "文档不在 Git 工作区内".to_string())?;
    let relative = relative_path(&repo, &path)?;
    let current = head_commit(&repo)?;
    if current == input.baseline_commit {
        return Ok(GitReviewPayload {
            state: "ready".to_string(),
            repo_root: Some(repo.to_string_lossy().to_string()),
            relative_path: Some(relative),
            baseline_commit: Some(current),
            baseline_content: None,
            head_changed: false,
            committed: false,
        });
    }
    let mut payload = payload_for_head(&repo, &relative, false)?;
    payload.head_changed = true;
    Ok(payload)
}

#[tauri::command]
pub(crate) fn git_review_accept_hunk(input: GitReviewHunkInput) -> Result<GitReviewPayload, String> {
    let path = validated_file_path(&input.path)?;
    let repo = discover_repo(&path)?.ok_or_else(|| "文档不在 Git 工作区内".to_string())?;
    let relative = relative_path(&repo, &path)?;
    ensure_head(&repo, &input.expected_commit)?;
    let mut child = Command::new("git")
        .current_dir(&repo)
        .args(["apply", "--cached", "--recount", "--whitespace=nowarn"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("执行 git apply 失败：{error}"))?;
    child
        .stdin
        .take()
        .ok_or_else(|| "无法打开 git apply 输入".to_string())?
        .write_all(input.patch.as_bytes())
        .map_err(|error| format!("写入 Git patch 失败：{error}"))?;
    let output = child
        .wait_with_output()
        .map_err(|error| format!("等待 git apply 失败：{error}"))?;
    if !output.status.success() {
        return Err(format_git_error("暂存审阅修改失败", &output));
    }
    let mut paths = vec![relative.clone()];
    for asset in input.assets {
        if let Some(asset_relative) = relative_asset_path(&repo, &asset) {
            run_git(&repo, &["add", "--", &asset_relative])?;
            paths.push(asset_relative);
        }
    }
    commit_paths(
        &repo,
        &paths,
        input.message.as_deref().unwrap_or("Markit review: accept change"),
    )?;
    payload_for_head(&repo, &relative, true)
}

#[tauri::command]
pub(crate) fn git_review_accept_all(input: GitReviewAllInput) -> Result<GitReviewPayload, String> {
    let path = validated_file_path(&input.path)?;
    let repo = discover_repo(&path)?.ok_or_else(|| "文档不在 Git 工作区内".to_string())?;
    let relative = relative_path(&repo, &path)?;
    ensure_head(&repo, &input.expected_commit)?;
    let mut paths = vec![relative.clone()];
    for asset in input.assets {
        if let Some(asset_relative) = relative_asset_path(&repo, &asset) {
            if !paths.iter().any(|value| value == &asset_relative) {
                paths.push(asset_relative);
            }
        }
    }
    let mut add_args = vec!["add".to_string(), "--".to_string()];
    add_args.extend(paths.iter().cloned());
    run_git(&repo, &add_args.iter().map(String::as_str).collect::<Vec<_>>())?;
    let message = input
        .message
        .as_deref()
        .unwrap_or("Markit review: accept all changes in document");
    let mut commit_args = vec!["commit".to_string(), "--only".to_string(), "-m".to_string(), message.to_string(), "--".to_string()];
    commit_args.extend(paths.iter().cloned());
    run_git(&repo, &commit_args.iter().map(String::as_str).collect::<Vec<_>>())?;
    payload_for_head(&repo, &relative, true)
}

#[tauri::command]
pub(crate) fn git_review_reject(input: GitReviewRejectInput) -> Result<(), String> {
    let path = validated_file_path(&input.path)?;
    let repo = discover_repo(&path)?.ok_or_else(|| "文档不在 Git 工作区内".to_string())?;
    let relative = relative_path(&repo, &path)?;
    let mut paths = vec![relative];
    for asset in input.assets {
        if let Some(asset_relative) = relative_asset_path(&repo, &asset) {
            let tracked = run_git_allow_failure(&repo, &["ls-files", "--error-unmatch", "--", &asset_relative])
                .status
                .success();
            if tracked {
                paths.push(asset_relative);
            }
        }
    }
    let mut args = vec!["restore", "--worktree", "--"].into_iter().map(String::from).collect::<Vec<_>>();
    args.extend(paths);
    run_git(&repo, &args.iter().map(String::as_str).collect::<Vec<_>>())
}

fn empty_payload(state: &str) -> GitReviewPayload {
    GitReviewPayload {
        state: state.to_string(),
        repo_root: None,
        relative_path: None,
        baseline_commit: None,
        baseline_content: None,
        head_changed: false,
        committed: false,
    }
}

fn payload_for_head(repo: &Path, relative: &str, committed: bool) -> Result<GitReviewPayload, String> {
    let commit = head_commit(repo)?;
    let output = run_git(repo, &["show", &format!("HEAD:{relative}")])?;
    let content = String::from_utf8(output.stdout).map_err(|_| "Git 基线不是有效的 UTF-8 文本".to_string())?;
    Ok(GitReviewPayload {
        state: "ready".to_string(),
        repo_root: Some(repo.to_string_lossy().to_string()),
        relative_path: Some(relative.to_string()),
        baseline_commit: Some(commit),
        baseline_content: Some(content),
        head_changed: false,
        committed,
    })
}

fn validated_file_path(value: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(value);
    if !path.is_file() {
        return Err(format!("文档不存在或不是文件：{value}"));
    }
    fs::canonicalize(&path).map_err(|error| format!("解析文档路径失败：{error}"))
}

fn discover_repo(path: &Path) -> Result<Option<PathBuf>, String> {
    let directory = path.parent().ok_or_else(|| "无法确定文档目录".to_string())?;
    let output = run_git_allow_failure(directory, &["rev-parse", "--show-toplevel"]);
    if !output.status.success() {
        return Ok(None);
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() { Ok(None) } else { Ok(Some(PathBuf::from(text))) }
}

fn relative_path(repo: &Path, path: &Path) -> Result<String, String> {
    path.strip_prefix(repo)
        .map_err(|_| "文档不在 Git 工作区内".to_string())
        .map(|value| value.to_string_lossy().replace('\\', "/"))
}

fn relative_asset_path(repo: &Path, value: &str) -> Option<String> {
    let path = PathBuf::from(value);
    let resolved = if path.exists() {
        fs::canonicalize(&path).ok()?
    } else {
        path
    };
    resolved
        .strip_prefix(repo)
        .ok()
        .map(|value| value.to_string_lossy().replace('\\', "/"))
}

fn head_commit(repo: &Path) -> Result<String, String> {
    let output = run_git(repo, &["rev-parse", "HEAD"])?;
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn ensure_head(repo: &Path, expected: &str) -> Result<(), String> {
    let actual = head_commit(repo)?;
    if actual != expected {
        return Err("Git HEAD 已变化，请刷新审阅基线后重试".to_string());
    }
    Ok(())
}

fn commit_path(repo: &Path, relative: &str, message: &str) -> Result<(), String> {
    commit_paths(repo, &[relative.to_string()], message)
}

fn commit_paths(repo: &Path, paths: &[String], message: &str) -> Result<(), String> {
    let mut args = vec!["commit".to_string(), "-m".to_string(), message.to_string(), "--".to_string()];
    args.extend(paths.iter().cloned());
    run_git(repo, &args.iter().map(String::as_str).collect::<Vec<_>>()).map(|_| ())
}

fn file_name(path: &Path) -> String {
    path.file_name().and_then(|name| name.to_str()).unwrap_or("document").to_string()
}

fn run_git(repo: &Path, args: &[&str]) -> Result<Output, String> {
    let output = run_git_allow_failure(repo, args);
    if output.status.success() { Ok(output) } else { Err(format_git_error("Git 操作失败", &output)) }
}

fn run_git_allow_failure(repo: &Path, args: &[&str]) -> Output {
    Command::new("git")
        .current_dir(repo)
        .args(args)
        .output()
        .unwrap_or_else(|error| Output {
            status: std::process::ExitStatus::from_raw(1),
            stdout: Vec::new(),
            stderr: error.to_string().into_bytes(),
        })
}

fn format_git_error(prefix: &str, output: &Output) -> String {
    let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if detail.is_empty() { prefix.to_string() } else { format!("{prefix}：{detail}") }
}
