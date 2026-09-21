use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Component, Path, PathBuf},
    process::{Command, Output, Stdio},
    time::{SystemTime, UNIX_EPOCH},
};

#[cfg(unix)]
use std::os::unix::process::ExitStatusExt;
#[cfg(windows)]
use std::os::windows::process::{CommandExt, ExitStatusExt};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

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
    /// Files created during the review session which are not present in the
    /// baseline. They are candidates for cleanup when the worktree is
    /// restored from the index. Tracked files are always left to `git restore`.
    #[serde(default)]
    pub(crate) untracked_assets: Vec<String>,
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
    // `ls-files` also reports paths which are merely staged. Such a path has
    // no usable review baseline until it exists in HEAD, so determine
    // tracking from the commit that will actually seed the review.
    let tracked = head_contains_path(&repo, &relative);
    let mut committed = false;
    if !tracked {
        run_git(&repo, &["add", "--", &relative])?;
        commit_path(
            &repo,
            &relative,
            &format!("Markit review: add {} as baseline", file_name(&path)),
        )?;
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
pub(crate) fn git_review_accept_hunk(
    input: GitReviewHunkInput,
) -> Result<GitReviewPayload, String> {
    let path = validated_file_path(&input.path)?;
    let repo = discover_repo(&path)?.ok_or_else(|| "文档不在 Git 工作区内".to_string())?;
    let relative = relative_path(&repo, &path)?;
    ensure_head(&repo, &input.expected_commit)?;
    let mut assets = Vec::new();
    for asset in input.assets {
        if let Some(asset_relative) = relative_asset_path(&repo, &asset) {
            if !asset_can_be_staged(&repo, &asset_relative) {
                continue;
            }
            if asset_relative != relative && !assets.iter().any(|value| value == &asset_relative) {
                assets.push(asset_relative);
            }
        }
    }
    commit_review_hunk(
        &repo,
        &relative,
        &input.patch,
        &assets,
        &input.expected_commit,
        input
            .message
            .as_deref()
            .unwrap_or("Markit review: accept change"),
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
            if !asset_can_be_staged(&repo, &asset_relative) {
                continue;
            }
            if !paths.iter().any(|value| value == &asset_relative) {
                paths.push(asset_relative);
            }
        }
    }
    let message = input
        .message
        .as_deref()
        .unwrap_or("Markit review: accept all changes in document");
    let assets = paths.iter().skip(1).cloned().collect::<Vec<_>>();
    let committed = commit_review_all(&repo, &relative, &assets, &input.expected_commit, message)?;
    payload_for_head(&repo, &relative, committed)
}

#[tauri::command]
pub(crate) fn git_review_reject(input: GitReviewRejectInput) -> Result<(), String> {
    let path = validated_file_path(&input.path)?;
    let repo = discover_repo(&path)?.ok_or_else(|| "文档不在 Git 工作区内".to_string())?;
    let relative = relative_path(&repo, &path)?;
    let mut paths = vec![relative.clone()];
    for asset in input.assets {
        if let Some(asset_relative) = relative_asset_path(&repo, &asset) {
            let tracked = index_contains_path(&repo, &asset_relative);
            if tracked && !paths.iter().any(|value| value == &asset_relative) {
                paths.push(asset_relative);
            }
        }
    }
    let mut args = vec!["restore", "--worktree", "--"]
        .into_iter()
        .map(String::from)
        .collect::<Vec<_>>();
    args.extend(paths);
    run_git(&repo, &args.iter().map(String::as_str).collect::<Vec<_>>())?;

    // `git restore --worktree` cannot remove files which never entered the
    // index. Delete only explicit candidates supplied by the UI, and only
    // while they are still untracked. This preserves unrelated untracked
    // files and assets that were already part of the baseline.
    for asset in input.untracked_assets {
        let Some(asset_relative) = relative_asset_path(&repo, &asset) else {
            continue;
        };
        if asset_relative == relative || index_contains_path(&repo, &asset_relative) {
            continue;
        }
        remove_untracked_asset(&repo, &asset_relative)?;
    }
    Ok(())
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

fn payload_for_head(
    repo: &Path,
    relative: &str,
    committed: bool,
) -> Result<GitReviewPayload, String> {
    let commit = head_commit(repo)?;
    let output = run_git(repo, &["show", &format!("HEAD:{relative}")])?;
    let (content, _) = crate::file_system::decode_markdown(&output.stdout)
        .map_err(|error| format!("读取 Git 审阅基线失败：{error}"))?;
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
    let directory = path
        .parent()
        .ok_or_else(|| "无法确定文档目录".to_string())?;
    let output = run_git_allow_failure(directory, &["rev-parse", "--show-toplevel"]);
    if !output.status.success() {
        return Ok(None);
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        Ok(None)
    } else {
        Ok(Some(PathBuf::from(text)))
    }
}

fn relative_path(repo: &Path, path: &Path) -> Result<String, String> {
    let normalized_repo = normalize_path_for_comparison(repo);
    let normalized_path = normalize_path_for_comparison(path);
    let repo_text = normalized_repo.to_string_lossy().replace('\\', "/");
    let path_text = normalized_path.to_string_lossy().replace('\\', "/");
    let repo_text = trim_trailing_separators(&repo_text);
    let path_text = trim_trailing_separators(&path_text);

    // Git returns a normalised path while `canonicalize` may return an
    // extended Windows path. Compare the normalised forms case-insensitively
    // on Windows, but preserve the document's original casing in the path
    // sent to Git. `strip_prefix` still performs component-aware matching, so
    // a directory such as `paperwork` cannot be mistaken for `paper`.
    let repo_comparison = comparison_path(&repo_text);
    let path_comparison = comparison_path(&path_text);
    let relative = Path::new(&path_comparison)
        .strip_prefix(Path::new(&repo_comparison))
        .map_err(|_| "文档不在 Git 工作区内".to_string())?;
    let relative_comparison = relative.to_string_lossy().replace('\\', "/");
    if relative_comparison.is_empty() {
        return Ok(String::new());
    }

    // ASCII case folding does not change byte lengths. Use the comparison
    // suffix only to locate the corresponding slice in the original path,
    // retaining the repository's filename casing where possible.
    let suffix_offset = path_comparison
        .len()
        .saturating_sub(relative_comparison.len());
    let relative_text = path_text
        .get(suffix_offset..)
        .unwrap_or(&relative_comparison)
        .trim_start_matches('/');
    Ok(relative_text.to_string())
}

fn relative_asset_path(repo: &Path, value: &str) -> Option<String> {
    // Apply the same slash/extended-prefix normalisation before checking
    // existence. Otherwise a valid `\\?\` path can be treated as missing and
    // handed to `relative_path` in a different format than the document path.
    let normalized = normalize_path_for_comparison(Path::new(value));
    let exists = normalized.exists();
    let resolved = if exists {
        fs::canonicalize(&normalized).ok()?
    } else {
        normalized
    };
    let relative = relative_path(repo, &resolved).ok()?;
    if !is_safe_relative_path(&relative) {
        return None;
    }
    // Windows file lookup is case-insensitive, while Git tree paths are not.
    // A deleted resource cannot be canonicalized from disk, so recover the
    // exact HEAD spelling before passing it to `cat-file`/`git commit`.
    Some(normalize_missing_asset_case(repo, &relative, exists))
}

/// Git's tree paths retain their original casing even on a case-insensitive
/// Windows worktree.  Once a referenced asset has been deleted there is no
/// filesystem spelling left to canonicalize, so resolve the path against
/// HEAD before passing it to `git add`/`git commit`.
fn normalize_missing_asset_case(repo: &Path, relative: &str, exists: bool) -> String {
    if !exists {
        head_path_with_matching_case(repo, relative)
    } else {
        relative.to_string()
    }
}

fn head_path_with_matching_case(repo: &Path, relative: &str) -> String {
    if !cfg!(windows) {
        return relative.to_string();
    }
    let output = run_git_allow_failure(repo, &["ls-tree", "-rz", "--name-only", "HEAD"]);
    if !output.status.success() {
        return relative.to_string();
    }
    let tree_paths = String::from_utf8_lossy(&output.stdout);
    let matched = tree_paths
        .split('\0')
        .find(|candidate| candidate.eq_ignore_ascii_case(relative));
    matched.unwrap_or(relative).to_string()
}

fn is_safe_relative_path(relative: &str) -> bool {
    let path = Path::new(relative);
    !path.is_absolute()
        && path.components().all(|component| {
            !matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
}

fn index_contains_path(repo: &Path, relative: &str) -> bool {
    run_git_allow_failure(
        repo,
        &["ls-files", "--cached", "--error-unmatch", "--", relative],
    )
    .status
    .success()
}

fn commit_contains_path(repo: &Path, commit: &str, relative: &str) -> bool {
    run_git_allow_failure(repo, &["cat-file", "-e", &format!("{commit}:{relative}")])
        .status
        .success()
}

fn remove_untracked_asset(repo: &Path, relative: &str) -> Result<(), String> {
    if !is_safe_relative_path(relative) {
        return Ok(());
    }
    let path = repo.join(relative);
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("读取审阅资源失败：{error}")),
    };
    if !metadata.file_type().is_file() && !metadata.file_type().is_symlink() {
        return Ok(());
    }
    fs::remove_file(&path).map_err(|error| format!("清理未跟踪审阅资源失败：{error}"))
}

/// 失效的 Markdown 资源引用不应让文档 hunk 的暂存失败。已删除但仍由
/// Git 跟踪的资源则必须保留，`git add` 才能把删除记录进暂存区。
fn asset_can_be_staged(repo: &Path, relative: &str) -> bool {
    if worktree_asset_exists(repo, relative) {
        true
    } else {
        // A resource removed during the review is still a valid review
        // path when it was tracked by HEAD, even if another tool already
        // staged that deletion in the real index. A staged-only addition
        // which has disappeared from the worktree is not review content.
        head_contains_path(repo, relative)
    }
}

fn worktree_asset_exists(repo: &Path, relative: &str) -> bool {
    match fs::symlink_metadata(repo.join(relative)) {
        Ok(metadata) => metadata.file_type().is_file() || metadata.file_type().is_symlink(),
        Err(_) => false,
    }
}

/// `fs::canonicalize` 在 Windows 上可能返回 `\\?\` 扩展路径，而 Git
/// 通常返回普通盘符路径。统一成普通斜杠路径后再做前缀比较，避免同一
/// 工作区被误判为不在 Git 仓库内。
fn normalize_path_for_comparison(path: &Path) -> PathBuf {
    let value = path.to_string_lossy().replace('\\', "/");
    let has_unc_prefix = value
        .get(..8)
        .map(|prefix| prefix.eq_ignore_ascii_case("//?/UNC/"))
        .unwrap_or(false);
    let has_extended_prefix = value
        .get(..4)
        .map(|prefix| prefix.eq_ignore_ascii_case("//?/"))
        .unwrap_or(false);
    let normalized = if has_unc_prefix {
        format!("//{}", &value[8..])
    } else if has_extended_prefix {
        value[4..].to_string()
    } else {
        value
    };
    let mut collapsed = String::with_capacity(normalized.len());
    for character in normalized.chars() {
        if character == '/' && collapsed.ends_with('/') {
            // Preserve the two leading slashes of an UNC path, but collapse
            // accidental duplicate separators elsewhere.
            if collapsed.len() != 1 || !normalized.starts_with("//") {
                continue;
            }
        }
        collapsed.push(character);
    }
    let collapsed = normalize_dot_segments(&collapsed);
    if collapsed.as_bytes().get(1) == Some(&b':') {
        let mut chars = collapsed.chars();
        if let Some(drive) = chars.next() {
            return PathBuf::from(format!("{}{}", drive.to_ascii_uppercase(), &collapsed[1..]));
        }
    }
    PathBuf::from(collapsed)
}

/// Resolve `.` and `..` lexically without requiring the final path to exist.
/// This matters for deleted Markdown resources: canonicalize() cannot resolve
/// a missing leaf, but Git still needs its normalized repository-relative path.
fn normalize_dot_segments(value: &str) -> String {
    let is_unc = value.starts_with("//");
    let is_drive_root = value.len() >= 3
        && value.as_bytes().get(1) == Some(&b':')
        && value.as_bytes().get(2) == Some(&b'/');
    let is_rooted = is_unc || is_drive_root || value.starts_with('/');
    let mut parts = value.split('/');
    let mut prefix = String::new();
    let mut components: Vec<&str> = Vec::new();
    let root_depth;

    if is_unc {
        prefix.push_str("//");
        // The server and share are the UNC root. Do not allow `..` to pop
        // above either component.
        for _ in 0..2 {
            if let Some(component) = parts.find(|component| !component.is_empty()) {
                components.push(component);
            }
        }
        root_depth = components.len();
    } else if is_drive_root {
        let drive = parts.next().unwrap_or_default();
        prefix.push_str(drive);
        prefix.push('/');
        root_depth = 0;
    } else if value.starts_with('/') {
        prefix.push('/');
        root_depth = 0;
    } else {
        root_depth = 0;
    }

    for component in parts {
        if component.is_empty() || component == "." {
            continue;
        }
        if component == ".." {
            if components.len() > root_depth {
                components.pop();
            } else if !is_rooted {
                components.push(component);
            }
            continue;
        }
        components.push(component);
    }

    let body = components.join("/");
    if prefix == "//" {
        format!("//{body}")
    } else if prefix.ends_with('/') || prefix.is_empty() {
        format!("{prefix}{body}")
    } else if body.is_empty() {
        prefix
    } else {
        format!("{prefix}/{body}")
    }
}

fn trim_trailing_separators(value: &str) -> String {
    if value == "/" || value == "//" {
        return value.to_string();
    }
    let mut end = value.len();
    while end > 1 && value.as_bytes().get(end - 1) == Some(&b'/') {
        // Keep the separator in a drive root (`C:/`).
        if end == 3 && value.as_bytes().get(1) == Some(&b':') {
            break;
        }
        end -= 1;
    }
    value[..end].to_string()
}

fn comparison_path(value: &str) -> String {
    // Keep Unix paths case-sensitive, while still making the helper
    // deterministic in cross-platform unit tests that use Windows-shaped
    // paths (`C:/...` or UNC paths).
    let windows_shaped = value.as_bytes().get(1) == Some(&b':') || value.starts_with("//");
    if cfg!(windows) || windows_shaped {
        value.to_ascii_lowercase()
    } else {
        value.to_string()
    }
}

fn head_commit(repo: &Path) -> Result<String, String> {
    let output = run_git(repo, &["rev-parse", "HEAD"])?;
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn head_contains_path(repo: &Path, relative: &str) -> bool {
    commit_contains_path(repo, "HEAD", relative)
}

fn ensure_head(repo: &Path, expected: &str) -> Result<(), String> {
    let actual = head_commit(repo)?;
    if actual != expected {
        return Err("Git HEAD 已变化，请刷新审阅基线后重试".to_string());
    }
    Ok(())
}

/// A review hunk must be committed from an index built from the current HEAD.
/// Using the real index here is unsafe: `git commit -- <path>` takes the
/// path's complete worktree contents and can therefore commit hunks which the
/// user did not accept. The temporary index also keeps unrelated staged files
/// untouched while the review commit is assembled.
struct TemporaryGitIndex {
    path: PathBuf,
}

impl TemporaryGitIndex {
    fn create() -> Result<Self, String> {
        let directory = std::env::temp_dir();
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        for attempt in 0..32u8 {
            let path = directory.join(format!(
                "nomo-review-index-{}-{}-{}",
                std::process::id(),
                timestamp,
                attempt
            ));
            match fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
            {
                Ok(_) => {
                    fs::remove_file(&path)
                        .map_err(|error| format!("创建临时 Git index 失败：{error}"))?;
                    return Ok(Self { path });
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(format!("创建临时 Git index 失败：{error}")),
            }
        }
        Err("创建临时 Git index 失败：路径冲突".to_string())
    }
}

impl Drop for TemporaryGitIndex {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
        let lock_path = PathBuf::from(format!("{}.lock", self.path.to_string_lossy()));
        let _ = fs::remove_file(lock_path);
    }
}

/// Snapshot the repository's real index before an accept-all operation mutates
/// its review paths. A path-only reset cannot restore an already staged
/// deletion or an unmerged entry, so failures must restore the index bytes that
/// were present before the operation began.
struct GitIndexSnapshot {
    index_path: PathBuf,
    backup: Option<TemporaryGitIndex>,
}

impl GitIndexSnapshot {
    fn capture(repo: &Path) -> Result<Self, String> {
        let index_path = git_index_path(repo)?;
        let backup = if index_path.exists() {
            let backup = TemporaryGitIndex::create()?;
            fs::copy(&index_path, &backup.path)
                .map_err(|error| format!("保存 Git 暂存区失败：{error}"))?;
            Some(backup)
        } else {
            None
        };
        Ok(Self { index_path, backup })
    }

    fn was_missing(&self) -> bool {
        self.backup.is_none()
    }

    fn restore(&self) -> Result<(), String> {
        if let Some(backup) = &self.backup {
            fs::copy(&backup.path, &self.index_path)
                .map(|_| ())
                .map_err(|error| format!("恢复 Git 暂存区失败：{error}"))
        } else {
            match fs::remove_file(&self.index_path) {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(error) => Err(format!("恢复 Git 暂存区失败：{error}")),
            }
        }
    }
}

fn git_index_path(repo: &Path) -> Result<PathBuf, String> {
    let output = run_git(repo, &["rev-parse", "--git-path", "index"])?;
    let raw = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if raw.is_empty() {
        return Err("无法确定 Git 暂存区路径".to_string());
    }
    let path = PathBuf::from(raw);
    if path.is_absolute() {
        Ok(path)
    } else {
        Ok(repo.join(path))
    }
}

fn commit_review_hunk(
    repo: &Path,
    relative: &str,
    patch: &str,
    assets: &[String],
    expected_commit: &str,
    message: &str,
) -> Result<(), String> {
    let temporary_index = TemporaryGitIndex::create()?;
    run_git_with_index(repo, &temporary_index.path, &["read-tree", expected_commit])?;
    apply_patch_to_index(repo, &temporary_index.path, patch)?;

    let mut paths = vec![relative.to_string()];
    for asset in assets {
        let asset = normalize_missing_asset_case(repo, asset, repo.join(asset).exists());
        if !is_safe_relative_path(&asset) || paths.iter().any(|value| value == &asset) {
            continue;
        }
        run_git_with_index(
            repo,
            &temporary_index.path,
            &["add", "--force", "--", asset.as_str()],
        )?;
        paths.push(asset);
    }

    ensure_head(repo, expected_commit)?;
    // There is deliberately no pathspec here. The temporary index contains
    // exactly HEAD plus the selected hunk and its resources.
    run_git_with_index(repo, &temporary_index.path, &["commit", "-m", message])?;

    // The real index is the source used by the reject action. Align only the
    // paths represented by this review commit, leaving unrelated staged files
    // untouched and preserving the complete worktree contents.
    restore_index_paths_from_head(repo, &paths)
}

fn commit_review_all(
    repo: &Path,
    relative: &str,
    assets: &[String],
    expected_commit: &str,
    message: &str,
) -> Result<bool, String> {
    let review_assets = assets
        .iter()
        .map(|asset| normalize_missing_asset_case(repo, asset, repo.join(asset).exists()))
        .filter(|asset| is_safe_relative_path(asset))
        // Markdown may retain a stale image reference after the file has been
        // removed.  Such a path is not part of the review tree and must not
        // make the document's accept-all operation fail with a pathspec
        // error.  Tracked deletions still pass this check via HEAD/index.
        .filter(|asset| asset_can_be_staged(repo, asset))
        .filter(|asset| asset.as_str() != relative)
        .fold(Vec::<String>::new(), |mut result, asset| {
            if !result.iter().any(|value| value == &asset) {
                result.push(asset);
            }
            result
        });
    // Build the complete review tree first. This validates every referenced
    // asset without touching the user's real index, so an ignored/missing
    // resource cannot leave the document partially staged.
    let temporary_index = TemporaryGitIndex::create()?;
    run_git_with_index(repo, &temporary_index.path, &["read-tree", expected_commit])?;
    run_git_with_index(repo, &temporary_index.path, &["add", "--", relative])?;
    let mut staged_assets = Vec::new();
    for asset in &review_assets {
        // Re-check immediately before touching the temporary index.  A
        // resource can disappear between the initial asset scan and this
        // operation (for example, when an external image tool cleans it up).
        // Ignore only that now-invalid untracked reference; report real Git
        // failures and retain tracked deletions.
        if !asset_can_be_staged(repo, asset) {
            continue;
        }
        match run_git_with_index(
            repo,
            &temporary_index.path,
            &["add", "--force", "--", asset.as_str()],
        ) {
            Ok(_) => {
                let diff = run_git_allow_failure_with_index(
                    repo,
                    &temporary_index.path,
                    &[
                        "diff",
                        "--cached",
                        "--quiet",
                        "--exit-code",
                        "--",
                        asset.as_str(),
                    ],
                );
                match diff.status.code() {
                    Some(0) => {}
                    Some(1) => staged_assets.push(asset.clone()),
                    _ => return Err(format_git_error("检查审阅资源失败", &diff)),
                }
            }
            Err(_error) if !asset_can_be_staged(repo, asset) => {}
            Err(error) => return Err(error),
        }
    }

    let diff = run_git_allow_failure_with_index(
        repo,
        &temporary_index.path,
        &["diff", "--cached", "--quiet", "--exit-code"],
    );
    match diff.status.code() {
        Some(0) => {
            ensure_head(repo, expected_commit)?;
            return Ok(false);
        }
        Some(1) => {}
        _ => return Err(format_git_error("检查审阅修改失败", &diff)),
    }

    // Stage only the review paths in the real index, then use Git's native
    // `commit --only` flow. It preserves unrelated staged files and, unlike a
    // post-commit index restore, has no second operation which can report a
    // false failure after HEAD has already advanced.
    ensure_head(repo, expected_commit)?;
    let index_snapshot = GitIndexSnapshot::capture(repo)?;
    if index_snapshot.was_missing() {
        if let Err(error) = run_git(repo, &["read-tree", expected_commit]) {
            return Err(restore_index_after_failure(index_snapshot, error));
        }
    }
    let mut add_args = vec!["add".to_string(), "--force".to_string(), "--".to_string()];
    add_args.push(relative.to_string());
    // A deleted tracked asset may already be staged by another tool. In that
    // case it is absent from the worktree and from the real index, so passing
    // it to `git add` would produce a pathspec error. The deletion is already
    // represented in the index and still belongs in the commit pathspec.
    let mut real_index_assets = Vec::new();
    for asset in &staged_assets {
        if worktree_asset_exists(repo, asset) || index_contains_path(repo, asset) {
            add_args.push(asset.clone());
            real_index_assets.push(asset.clone());
        }
    }
    if let Err(error) = run_git(
        repo,
        &add_args.iter().map(String::as_str).collect::<Vec<_>>(),
    ) {
        return Err(restore_index_after_failure(index_snapshot, error));
    }

    if let Err(error) = ensure_head(repo, expected_commit) {
        return Err(restore_index_after_failure(index_snapshot, error));
    }
    let mut commit_args = vec![
        "commit".to_string(),
        "--only".to_string(),
        "-m".to_string(),
        message.to_string(),
        "--".to_string(),
    ];
    // Use the paths which survived the real-index validation.  In
    // particular, do not pass a disappeared, never-tracked asset as a
    // pathspec to `git commit --only`.
    let mut commit_paths = vec![relative.to_string()];
    commit_paths.extend(real_index_assets);
    for asset in staged_assets {
        if !commit_paths.iter().any(|path| path == &asset)
            && (head_contains_path(repo, &asset) || index_contains_path(repo, &asset))
        {
            // A tracked deletion may already be represented in the real
            // index, even though `git add` cannot be called again for the
            // missing worktree path. Keep it in the commit pathspec.
            commit_paths.push(asset);
        }
    }
    commit_args.extend(commit_paths);
    if let Err(error) = run_git(
        repo,
        &commit_args.iter().map(String::as_str).collect::<Vec<_>>(),
    ) {
        return Err(restore_index_after_failure(index_snapshot, error));
    }
    Ok(true)
}

fn restore_index_after_failure(snapshot: GitIndexSnapshot, error: String) -> String {
    match snapshot.restore() {
        Ok(()) => error,
        Err(restore_error) => format!("{error}；{restore_error}"),
    }
}

fn apply_patch_to_index(repo: &Path, index: &Path, patch: &str) -> Result<(), String> {
    let mut child = git_command()
        .current_dir(repo)
        .env("GIT_INDEX_FILE", index)
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
        .write_all(patch.as_bytes())
        .map_err(|error| format!("写入 Git patch 失败：{error}"))?;
    let output = child
        .wait_with_output()
        .map_err(|error| format!("等待 git apply 失败：{error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format_git_error("暂存审阅修改失败", &output))
    }
}

fn restore_index_paths_from_head(repo: &Path, paths: &[String]) -> Result<(), String> {
    restore_index_paths_from_commit(repo, "HEAD", paths)
}

fn restore_index_paths_from_commit(
    repo: &Path,
    source: &str,
    paths: &[String],
) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    let mut tracked = Vec::new();
    let mut untracked = Vec::new();
    for path in paths {
        if commit_contains_path(repo, source, path) {
            tracked.push(path.clone());
        } else {
            untracked.push(path.clone());
        }
    }

    if !tracked.is_empty() {
        let mut args = vec![
            "restore".to_string(),
            "--staged".to_string(),
            format!("--source={source}"),
            "--".to_string(),
        ];
        args.extend(tracked);
        run_git(repo, &args.iter().map(String::as_str).collect::<Vec<_>>())?;
    }

    // A newly added review asset has no source-tree entry to restore. Reset
    // only its index entry while leaving the worktree file in place.
    for path in untracked {
        let _ = run_git_allow_failure(repo, &["reset", "--", path.as_str()]);
    }
    Ok(())
}

fn commit_path(repo: &Path, relative: &str, message: &str) -> Result<(), String> {
    commit_paths(repo, &[relative.to_string()], message)
}

fn commit_paths(repo: &Path, paths: &[String], message: &str) -> Result<(), String> {
    let mut args = vec![
        "commit".to_string(),
        "-m".to_string(),
        message.to_string(),
        "--".to_string(),
    ];
    args.extend(paths.iter().cloned());
    run_git(repo, &args.iter().map(String::as_str).collect::<Vec<_>>()).map(|_| ())
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("document")
        .to_string()
}

fn run_git(repo: &Path, args: &[&str]) -> Result<Output, String> {
    let output = run_git_allow_failure(repo, args);
    if output.status.success() {
        Ok(output)
    } else {
        Err(format_git_error("Git 操作失败", &output))
    }
}

fn run_git_with_index(repo: &Path, index: &Path, args: &[&str]) -> Result<Output, String> {
    let output = run_git_allow_failure_with_index(repo, index, args);
    if output.status.success() {
        Ok(output)
    } else {
        Err(format_git_error("Git 操作失败", &output))
    }
}

fn run_git_allow_failure(repo: &Path, args: &[&str]) -> Output {
    git_command()
        .current_dir(repo)
        .args(args)
        .output()
        .unwrap_or_else(|error| Output {
            status: std::process::ExitStatus::from_raw(1),
            stdout: Vec::new(),
            stderr: error.to_string().into_bytes(),
        })
}

fn run_git_allow_failure_with_index(repo: &Path, index: &Path, args: &[&str]) -> Output {
    git_command()
        .current_dir(repo)
        .env("GIT_INDEX_FILE", index)
        .args(args)
        .output()
        .unwrap_or_else(|error| Output {
            status: std::process::ExitStatus::from_raw(1),
            stdout: Vec::new(),
            stderr: error.to_string().into_bytes(),
        })
}

fn git_command() -> Command {
    let mut command = Command::new("git");
    command.arg("--literal-pathspecs");
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

fn format_git_error(prefix: &str, output: &Output) -> String {
    let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if detail.is_empty() {
        prefix.to_string()
    } else {
        format!("{prefix}：{detail}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestRepo {
        path: PathBuf,
    }

    impl TestRepo {
        fn create() -> Self {
            let timestamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            for attempt in 0..32u8 {
                let path = std::env::temp_dir().join(format!(
                    "nomo-git-review-test-{}-{}-{}",
                    std::process::id(),
                    timestamp,
                    attempt
                ));
                if fs::create_dir(&path).is_ok() {
                    return Self { path };
                }
            }
            panic!("无法创建 Git 审阅测试目录");
        }
    }

    impl Drop for TestRepo {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn git_output(repo: &Path, args: &[&str]) -> Output {
        run_git(repo, args).unwrap_or_else(|error| panic!("Git 测试命令失败：{error}"))
    }

    fn git_text(repo: &Path, args: &[&str]) -> String {
        String::from_utf8(git_output(repo, args).stdout).expect("Git 测试输出不是 UTF-8")
    }

    fn init_test_repo(repo: &Path, paths: &[&str]) {
        git_output(repo, &["init"]);
        git_output(repo, &["config", "user.email", "test@example.com"]);
        git_output(repo, &["config", "user.name", "Nomo Test"]);
        git_output(repo, &["config", "commit.gpgsign", "false"]);
        git_output(repo, &["config", "core.autocrlf", "false"]);
        let mut add_args = vec!["add", "--"];
        add_args.extend_from_slice(paths);
        git_output(repo, &add_args);
        git_output(repo, &["commit", "-m", "baseline"]);
    }

    fn install_failing_pre_commit_hook(repo: &Path) {
        let hook = repo.join(".git/hooks/pre-commit");
        fs::write(&hook, "#!/bin/sh\nexit 1\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            let mut permissions = fs::metadata(&hook).unwrap().permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(hook, permissions).unwrap();
        }
    }

    #[test]
    fn git_baseline_decodes_supported_markdown_encodings() {
        let test_repo = TestRepo::create();
        let repo = &test_repo.path;
        let expected = "# 中文基线\n";

        let mut utf8_bom = vec![0xEF, 0xBB, 0xBF];
        utf8_bom.extend_from_slice(expected.as_bytes());
        fs::write(repo.join("utf8-bom.md"), utf8_bom).unwrap();

        let mut utf16_le = vec![0xFF, 0xFE];
        for unit in expected.encode_utf16() {
            utf16_le.extend_from_slice(&unit.to_le_bytes());
        }
        fs::write(repo.join("utf16-le.md"), utf16_le).unwrap();

        let (gbk, _, had_errors) = encoding_rs::GBK.encode(expected);
        assert!(!had_errors);
        fs::write(repo.join("gbk.md"), gbk.as_ref()).unwrap();

        init_test_repo(repo, &["utf8-bom.md", "utf16-le.md", "gbk.md"]);

        for path in ["utf8-bom.md", "utf16-le.md", "gbk.md"] {
            let payload = payload_for_head(repo, path, false).unwrap();
            assert_eq!(
                payload.baseline_content.as_deref(),
                Some(expected),
                "{path}"
            );
        }
    }

    #[test]
    fn accepting_all_preserves_encoded_document_bytes() {
        let test_repo = TestRepo::create();
        let repo = &test_repo.path;
        let document = repo.join("utf16-le.md");
        let encode_utf16_le = |value: &str| {
            let mut bytes = vec![0xFF, 0xFE];
            for unit in value.encode_utf16() {
                bytes.extend_from_slice(&unit.to_le_bytes());
            }
            bytes
        };

        fs::write(&document, encode_utf16_le("# 基线\n")).unwrap();
        init_test_repo(repo, &["utf16-le.md"]);
        let expected_bytes = encode_utf16_le("# 已修改\n");
        fs::write(&document, &expected_bytes).unwrap();

        let payload = git_review_accept_all(GitReviewAllInput {
            path: document.to_string_lossy().to_string(),
            expected_commit: head_commit(repo).unwrap(),
            assets: Vec::new(),
            message: Some("accept encoded document".to_string()),
        })
        .unwrap();

        assert!(payload.committed);
        assert_eq!(payload.baseline_content.as_deref(), Some("# 已修改\n"));
        assert_eq!(
            git_output(repo, &["show", "HEAD:utf16-le.md"]).stdout,
            expected_bytes
        );
    }

    #[test]
    fn normalizes_windows_extended_paths_before_prefix_matching() {
        let repo = Path::new(r"\\?\D:\workspace\paper");
        let document = Path::new(r"D:\workspace\paper\draft.md");
        assert_eq!(relative_path(repo, document).unwrap(), "draft.md");
    }

    #[test]
    fn normalizes_windows_drive_letter_case_before_prefix_matching() {
        let repo = Path::new(r"D:\workspace\paper");
        let document = Path::new(r"d:\workspace\paper\draft.md");
        assert_eq!(relative_path(repo, document).unwrap(), "draft.md");
    }

    #[test]
    fn compares_windows_directory_components_without_case_or_separator_differences() {
        let repo = Path::new(r"D:\Workspace\Paper\\");
        let document = Path::new(r"d:/workspace/paper\Draft.md");
        assert_eq!(relative_path(repo, document).unwrap(), "Draft.md");
    }

    #[test]
    fn does_not_accept_a_similar_but_outside_directory() {
        let repo = Path::new(r"D:\workspace\paper");
        let document = Path::new(r"D:\workspace\paperwork\draft.md");
        assert!(relative_path(repo, document).is_err());
    }

    #[test]
    fn normalizes_asset_paths_before_relative_matching() {
        let repo = Path::new(r"D:\workspace\paper");
        let asset = r"\\?\d:\workspace\paper\assets\figure.png";
        assert_eq!(
            relative_asset_path(repo, asset).as_deref(),
            Some("assets/figure.png")
        );
    }

    #[test]
    fn normalizes_nonexistent_asset_paths_with_parent_segments() {
        let repo = Path::new(r"D:\workspace\paper");
        let asset = r"D:\workspace\paper\docs\..\assets\deleted.png";
        assert_eq!(
            relative_asset_path(repo, asset).as_deref(),
            Some("assets/deleted.png")
        );
    }

    #[test]
    fn normalizes_windows_extended_unc_paths() {
        let path = Path::new(r"\\?\UNC\server\share\paper");
        assert_eq!(
            normalize_path_for_comparison(path),
            PathBuf::from("//server/share/paper"),
        );
    }

    #[test]
    fn accepting_a_hunk_does_not_commit_unselected_worktree_changes() {
        let test_repo = TestRepo::create();
        let repo = &test_repo.path;
        fs::write(repo.join("f.md"), "a\nb\nc\n").unwrap();
        fs::write(repo.join("other.txt"), "base\n").unwrap();
        fs::write(repo.join("untouched.txt"), "keep\n").unwrap();
        git_output(repo, &["init"]);
        git_output(repo, &["config", "user.email", "test@example.com"]);
        git_output(repo, &["config", "user.name", "Nomo Test"]);
        git_output(repo, &["config", "commit.gpgsign", "false"]);
        git_output(repo, &["config", "core.autocrlf", "false"]);
        git_output(repo, &["add", "--", "f.md", "other.txt", "untouched.txt"]);
        git_output(repo, &["commit", "-m", "baseline"]);

        // The selected hunk changes only line 2. Line 3 remains an
        // unaccepted worktree change, and another file is already staged.
        fs::write(repo.join("f.md"), "a\nB\nC\n").unwrap();
        fs::write(repo.join("other.txt"), "staged\n").unwrap();
        fs::remove_file(repo.join("untouched.txt")).unwrap();
        git_output(repo, &["add", "--", "other.txt"]);
        let patch = concat!(
            "diff --git a/f.md b/f.md\n",
            "--- a/f.md\n",
            "+++ b/f.md\n",
            "@@ -1,3 +1,3 @@\n",
            " a\n",
            "-b\n",
            "+B\n",
            " c\n",
        );

        let baseline = head_commit(repo).unwrap();
        commit_review_hunk(repo, "f.md", patch, &[], &baseline, "accept line 2").unwrap();

        assert_eq!(git_text(repo, &["show", "HEAD:f.md"]), "a\nB\nc\n");
        assert_eq!(git_text(repo, &["show", "HEAD:untouched.txt"]), "keep\n");
        assert_eq!(fs::read_to_string(repo.join("f.md")).unwrap(), "a\nB\nC\n");
        assert_eq!(
            git_text(repo, &["diff", "--cached", "--name-only"]),
            "other.txt\n"
        );
        assert!(
            git_output(repo, &["diff", "--cached", "--quiet", "--", "f.md"])
                .status
                .success()
        );

        // Reject uses the real index. It should keep the accepted line from
        // the new HEAD while removing only the still-unaccepted line 3.
        git_output(repo, &["restore", "--worktree", "--", "f.md"]);
        assert_eq!(fs::read_to_string(repo.join("f.md")).unwrap(), "a\nB\nc\n");
    }

    #[test]
    fn accepting_all_uses_only_paths_and_preserves_unrelated_staging() {
        let test_repo = TestRepo::create();
        let repo = &test_repo.path;
        fs::write(repo.join("paper.md"), "base\n").unwrap();
        fs::write(repo.join("other.txt"), "base\n").unwrap();
        init_test_repo(repo, &["paper.md", "other.txt"]);

        fs::write(repo.join("paper.md"), "changed\n").unwrap();
        fs::write(repo.join("figure.png"), b"image").unwrap();
        fs::write(repo.join("other.txt"), "staged\n").unwrap();
        git_output(repo, &["add", "--", "other.txt"]);

        let baseline = head_commit(repo).unwrap();
        let committed = commit_review_all(
            repo,
            "paper.md",
            &["figure.png".to_string()],
            &baseline,
            "accept all",
        )
        .unwrap();

        assert!(committed);
        assert_eq!(git_text(repo, &["show", "HEAD:paper.md"]), "changed\n");
        assert_eq!(git_text(repo, &["show", "HEAD:figure.png"]), "image");
        assert_eq!(git_text(repo, &["show", "HEAD:other.txt"]), "base\n");
        assert_eq!(
            git_text(repo, &["diff", "--cached", "--name-only"]),
            "other.txt\n"
        );
    }

    #[test]
    fn accepting_all_treats_pathspec_metacharacters_literally() {
        let test_repo = TestRepo::create();
        let repo = &test_repo.path;
        fs::write(repo.join("paper[1].md"), "base bracket\n").unwrap();
        fs::write(repo.join("paper1.md"), "base plain\n").unwrap();
        init_test_repo(repo, &["paper[1].md", "paper1.md"]);

        fs::write(repo.join("paper[1].md"), "changed bracket\n").unwrap();
        fs::write(repo.join("paper1.md"), "changed plain\n").unwrap();
        let baseline = head_commit(repo).unwrap();

        let committed =
            commit_review_all(repo, "paper[1].md", &[], &baseline, "accept all").unwrap();

        assert!(committed);
        assert_eq!(
            git_text(repo, &["show", "HEAD:paper[1].md"]),
            "changed bracket\n"
        );
        assert_eq!(git_text(repo, &["show", "HEAD:paper1.md"]), "base plain\n");
        assert_eq!(
            fs::read_to_string(repo.join("paper1.md")).unwrap(),
            "changed plain\n"
        );
    }

    #[test]
    fn accepting_all_preserves_staged_only_content_for_an_unchanged_asset() {
        let test_repo = TestRepo::create();
        let repo = &test_repo.path;
        fs::write(repo.join("paper.md"), "base\n").unwrap();
        fs::write(repo.join("figure.png"), b"base image").unwrap();
        init_test_repo(repo, &["paper.md", "figure.png"]);

        fs::write(repo.join("paper.md"), "changed\n").unwrap();
        fs::write(repo.join("figure.png"), b"staged image").unwrap();
        git_output(repo, &["add", "--", "figure.png"]);
        git_output(
            repo,
            &["restore", "--source=HEAD", "--worktree", "--", "figure.png"],
        );
        let baseline = head_commit(repo).unwrap();

        let committed = commit_review_all(
            repo,
            "paper.md",
            &["figure.png".to_string()],
            &baseline,
            "accept all",
        )
        .unwrap();

        assert!(committed);
        assert_eq!(git_text(repo, &["show", "HEAD:paper.md"]), "changed\n");
        assert_eq!(git_text(repo, &["show", "HEAD:figure.png"]), "base image");
        assert_eq!(git_text(repo, &["show", ":figure.png"]), "staged image");
        assert_eq!(fs::read(repo.join("figure.png")).unwrap(), b"base image");
    }

    #[test]
    fn accepting_all_ignores_a_missing_staged_only_asset() {
        let test_repo = TestRepo::create();
        let repo = &test_repo.path;
        fs::write(repo.join("paper.md"), "base\n").unwrap();
        init_test_repo(repo, &["paper.md"]);

        fs::write(repo.join("paper.md"), "changed\n").unwrap();
        fs::write(repo.join("figure.png"), b"staged image").unwrap();
        git_output(repo, &["add", "--", "figure.png"]);
        fs::remove_file(repo.join("figure.png")).unwrap();
        let baseline = head_commit(repo).unwrap();

        let committed = commit_review_all(
            repo,
            "paper.md",
            &["figure.png".to_string()],
            &baseline,
            "accept all",
        )
        .unwrap();

        assert!(committed);
        assert_eq!(git_text(repo, &["show", "HEAD:paper.md"]), "changed\n");
        assert!(
            !run_git_allow_failure(repo, &["cat-file", "-e", "HEAD:figure.png"])
                .status
                .success()
        );
        assert_eq!(git_text(repo, &["show", ":figure.png"]), "staged image");
    }

    #[test]
    fn accepting_all_force_adds_an_explicitly_referenced_ignored_asset() {
        let test_repo = TestRepo::create();
        let repo = &test_repo.path;
        fs::write(repo.join("paper.md"), "base\n").unwrap();
        fs::write(repo.join(".gitignore"), "assets/\n").unwrap();
        init_test_repo(repo, &["paper.md", ".gitignore"]);

        fs::write(repo.join("paper.md"), "changed\n").unwrap();
        fs::create_dir(repo.join("assets")).unwrap();
        fs::write(repo.join("assets/figure.png"), b"image").unwrap();
        let baseline = head_commit(repo).unwrap();

        let committed = commit_review_all(
            repo,
            "paper.md",
            &["assets/figure.png".to_string()],
            &baseline,
            "accept all",
        )
        .unwrap();

        assert!(committed);
        assert_eq!(git_text(repo, &["show", "HEAD:assets/figure.png"]), "image");
    }

    #[test]
    fn accepting_all_keeps_a_deleted_head_asset_in_the_review_paths() {
        let test_repo = TestRepo::create();
        let repo = &test_repo.path;
        fs::write(repo.join("paper.md"), "base\n").unwrap();
        fs::create_dir(repo.join("assets")).unwrap();
        fs::write(repo.join("assets/figure.png"), b"image").unwrap();
        init_test_repo(repo, &["paper.md", "assets/figure.png"]);

        fs::write(repo.join("paper.md"), "changed\n").unwrap();
        fs::remove_file(repo.join("assets/figure.png")).unwrap();
        git_output(repo, &["add", "--", "assets/figure.png"]);
        let baseline = head_commit(repo).unwrap();

        let committed = commit_review_all(
            repo,
            "paper.md",
            &["assets/figure.png".to_string()],
            &baseline,
            "accept all",
        )
        .unwrap();

        assert!(committed);
        assert!(
            !run_git_allow_failure(repo, &["cat-file", "-e", "HEAD:assets/figure.png"])
                .status
                .success()
        );
    }

    #[test]
    fn accepting_all_handles_a_deleted_tracked_asset_without_pre_staging() {
        let test_repo = TestRepo::create();
        let repo = &test_repo.path;
        fs::write(repo.join("paper.md"), "base\n").unwrap();
        fs::create_dir(repo.join("assets")).unwrap();
        fs::write(repo.join("assets/figure.png"), b"image").unwrap();
        init_test_repo(repo, &["paper.md", "assets/figure.png"]);

        fs::write(repo.join("paper.md"), "changed\n").unwrap();
        fs::remove_file(repo.join("assets/figure.png")).unwrap();
        let baseline = head_commit(repo).unwrap();

        let committed = commit_review_all(
            repo,
            "paper.md",
            &["assets/figure.png".to_string()],
            &baseline,
            "accept all",
        )
        .unwrap();

        assert!(committed);
        assert_eq!(git_text(repo, &["show", "HEAD:paper.md"]), "changed\n");
        assert!(
            !run_git_allow_failure(repo, &["cat-file", "-e", "HEAD:assets/figure.png"])
                .status
                .success()
        );
        assert_eq!(git_text(repo, &["status", "--porcelain"]), "");
    }

    #[test]
    #[cfg(windows)]
    fn deleted_asset_path_uses_head_casing_on_windows() {
        let test_repo = TestRepo::create();
        let repo = &test_repo.path;
        fs::write(repo.join("paper.md"), "base\n").unwrap();
        fs::write(repo.join("Figure.PNG"), b"image").unwrap();
        init_test_repo(repo, &["paper.md", "Figure.PNG"]);

        fs::write(repo.join("paper.md"), "changed\n").unwrap();
        fs::remove_file(repo.join("Figure.PNG")).unwrap();
        let baseline = head_commit(repo).unwrap();
        let document = repo.join("paper.md");
        let committed = git_review_accept_all(GitReviewAllInput {
            path: document.to_string_lossy().to_string(),
            expected_commit: baseline,
            assets: vec![repo.join("figure.png").to_string_lossy().to_string()],
            message: Some("accept all".to_string()),
        })
        .unwrap()
        .committed;

        assert!(committed);
        assert!(
            !run_git_allow_failure(repo, &["cat-file", "-e", "HEAD:Figure.PNG"])
                .status
                .success()
        );
    }

    #[test]
    fn accepting_all_rejects_a_changed_head_before_touching_the_real_index() {
        let test_repo = TestRepo::create();
        let repo = &test_repo.path;
        fs::write(repo.join("paper.md"), "base\n").unwrap();
        fs::write(repo.join("other.txt"), "base\n").unwrap();
        init_test_repo(repo, &["paper.md", "other.txt"]);
        let baseline = head_commit(repo).unwrap();

        fs::write(repo.join("paper.md"), "review\n").unwrap();
        fs::write(repo.join("other.txt"), "external\n").unwrap();
        git_output(repo, &["add", "--", "other.txt"]);
        git_output(repo, &["commit", "-m", "external change"]);

        let result = commit_review_all(repo, "paper.md", &[], &baseline, "accept all");

        assert!(result.is_err());
        assert_eq!(git_text(repo, &["show", "HEAD:paper.md"]), "base\n");
        assert_eq!(git_text(repo, &["diff", "--cached", "--name-only"]), "");
    }

    #[test]
    fn accepting_all_without_a_disk_diff_is_a_successful_noop() {
        let test_repo = TestRepo::create();
        let repo = &test_repo.path;
        let document = repo.join("paper.md");
        fs::write(&document, "base\n").unwrap();
        init_test_repo(repo, &["paper.md"]);
        let head = head_commit(repo).unwrap();

        let payload = git_review_accept_all(GitReviewAllInput {
            path: document.to_string_lossy().to_string(),
            expected_commit: head.clone(),
            assets: Vec::new(),
            message: Some("accept all".to_string()),
        })
        .unwrap();

        assert!(!payload.committed);
        assert_eq!(payload.baseline_commit.as_deref(), Some(head.as_str()));
        assert_eq!(payload.baseline_content.as_deref(), Some("base\n"));
        assert_eq!(git_text(repo, &["rev-list", "--count", "HEAD"]), "1\n");
    }

    #[test]
    fn accept_all_ignores_missing_untracked_asset_reference() {
        let test_repo = TestRepo::create();
        let repo = &test_repo.path;
        fs::write(repo.join("paper.md"), "base\n").unwrap();
        fs::write(repo.join("other.txt"), "base\n").unwrap();
        init_test_repo(repo, &["paper.md", "other.txt"]);

        fs::write(repo.join("paper.md"), "changed\n").unwrap();
        fs::write(repo.join("other.txt"), "staged\n").unwrap();
        git_output(repo, &["add", "--", "other.txt"]);

        let baseline = head_commit(repo).unwrap();
        let committed = commit_review_all(
            repo,
            "paper.md",
            &["missing/figure.png".to_string()],
            &baseline,
            "accept all",
        )
        .unwrap();

        assert!(committed);
        assert_eq!(git_text(repo, &["show", "HEAD:paper.md"]), "changed\n");
        assert_eq!(
            fs::read_to_string(repo.join("paper.md")).unwrap(),
            "changed\n"
        );
        assert_eq!(
            git_text(repo, &["diff", "--cached", "--name-only"]),
            "other.txt\n"
        );
    }

    #[test]
    fn failed_accept_all_after_commit_hook_failure_restores_review_paths() {
        let test_repo = TestRepo::create();
        let repo = &test_repo.path;
        fs::write(repo.join("paper.md"), "base\n").unwrap();
        fs::write(repo.join("other.txt"), "base\n").unwrap();
        init_test_repo(repo, &["paper.md", "other.txt"]);

        fs::write(repo.join("paper.md"), "changed\n").unwrap();
        fs::write(repo.join("other.txt"), "staged\n").unwrap();
        git_output(repo, &["add", "--", "other.txt"]);
        install_failing_pre_commit_hook(repo);

        let baseline = head_commit(repo).unwrap();
        let result = commit_review_all(repo, "paper.md", &[], &baseline, "accept all");

        assert!(result.is_err());
        assert_eq!(git_text(repo, &["show", "HEAD:paper.md"]), "base\n");
        assert_eq!(
            git_text(repo, &["diff", "--cached", "--name-only"]),
            "other.txt\n"
        );
        let staged_diff = git_text(repo, &["diff", "--cached", "--", "other.txt"]);
        assert!(staged_diff.contains("-base\n+staged\n"));
        assert_eq!(git_text(repo, &["diff", "--cached", "--", "paper.md"]), "");
    }

    #[test]
    fn failed_accept_all_after_identity_failure_restores_the_index() {
        let test_repo = TestRepo::create();
        let repo = &test_repo.path;
        fs::write(repo.join("paper.md"), "base\n").unwrap();
        fs::write(repo.join("other.txt"), "base\n").unwrap();
        init_test_repo(repo, &["paper.md", "other.txt"]);

        fs::write(repo.join("paper.md"), "changed\n").unwrap();
        fs::write(repo.join("other.txt"), "staged\n").unwrap();
        git_output(repo, &["add", "--", "other.txt"]);
        git_output(repo, &["config", "user.name", ""]);
        git_output(repo, &["config", "user.email", ""]);

        let baseline = head_commit(repo).unwrap();
        let result = commit_review_all(repo, "paper.md", &[], &baseline, "accept all");

        assert!(result.is_err());
        assert_eq!(git_text(repo, &["show", "HEAD:paper.md"]), "base\n");
        assert_eq!(
            git_text(repo, &["diff", "--cached", "--name-only"]),
            "other.txt\n"
        );
        assert_eq!(git_text(repo, &["diff", "--cached", "--", "paper.md"]), "");
    }

    #[test]
    fn accepting_all_preserves_unicode_and_space_paths() {
        let test_repo = TestRepo::create();
        let repo = &test_repo.path;
        let document = repo.join("论文 draft.md");
        let asset = repo.join("图表 1.png");
        fs::write(&document, "base\n").unwrap();
        fs::write(&asset, b"image").unwrap();
        let document_name = document.file_name().unwrap().to_str().unwrap();
        let asset_name = asset.file_name().unwrap().to_str().unwrap();
        init_test_repo(repo, &[document_name, asset_name]);

        fs::write(&document, "changed\n").unwrap();
        fs::write(&asset, b"updated image").unwrap();
        let baseline = head_commit(repo).unwrap();
        let relative_document = relative_path(repo, &document).unwrap();
        let relative_asset = relative_path(repo, &asset).unwrap();

        let committed = commit_review_all(
            repo,
            &relative_document,
            &[relative_asset],
            &baseline,
            "accept all",
        )
        .unwrap();

        assert!(committed);
        assert_eq!(
            git_text(repo, &["show", &format!("HEAD:{relative_document}")]),
            "changed\n"
        );
        assert_eq!(
            git_text(repo, &["show", &format!("HEAD:{asset_name}")]),
            "updated image"
        );
    }

    #[test]
    fn accepting_all_can_recreate_a_missing_index() {
        let test_repo = TestRepo::create();
        let repo = &test_repo.path;
        fs::write(repo.join("paper.md"), "base\n").unwrap();
        fs::write(repo.join("other.txt"), "other\n").unwrap();
        init_test_repo(repo, &["paper.md", "other.txt"]);
        fs::write(repo.join("paper.md"), "changed\n").unwrap();
        let baseline = head_commit(repo).unwrap();
        let index_path = PathBuf::from(
            git_text(repo, &["rev-parse", "--git-path", "index"])
                .trim()
                .to_string(),
        );
        let index_path = if index_path.is_absolute() {
            index_path
        } else {
            repo.join(index_path)
        };
        fs::remove_file(index_path).unwrap();

        let committed = commit_review_all(repo, "paper.md", &[], &baseline, "accept all").unwrap();

        assert!(committed);
        assert_eq!(git_text(repo, &["show", "HEAD:paper.md"]), "changed\n");
        assert_eq!(git_text(repo, &["show", "HEAD:other.txt"]), "other\n");
        assert_eq!(git_text(repo, &["status", "--porcelain"]), "");
    }

    #[test]
    fn accepting_all_does_not_partially_commit_during_an_unresolved_merge() {
        let test_repo = TestRepo::create();
        let repo = &test_repo.path;
        fs::write(repo.join("paper.md"), "base\n").unwrap();
        fs::write(repo.join("conflict.txt"), "base\n").unwrap();
        init_test_repo(repo, &["paper.md", "conflict.txt"]);
        let base_branch = git_text(repo, &["branch", "--show-current"])
            .trim()
            .to_string();

        git_output(repo, &["checkout", "-b", "review-side"]);
        fs::write(repo.join("conflict.txt"), "side\n").unwrap();
        git_output(repo, &["add", "--", "conflict.txt"]);
        git_output(repo, &["commit", "-m", "side"]);
        git_output(repo, &["checkout", "-q", &base_branch]);
        fs::write(repo.join("conflict.txt"), "main\n").unwrap();
        git_output(repo, &["add", "--", "conflict.txt"]);
        git_output(repo, &["commit", "-m", "main"]);
        assert!(
            run_git_allow_failure(repo, &["merge", "review-side"])
                .status
                .code()
                != Some(0)
        );

        fs::write(repo.join("paper.md"), "changed\n").unwrap();
        let baseline = git_text(repo, &["rev-parse", "HEAD"]).trim().to_string();
        let result = commit_review_all(repo, "paper.md", &[], &baseline, "accept all");

        assert!(result.is_err());
        assert_eq!(git_text(repo, &["show", "HEAD:paper.md"]), "base\n");
        assert_eq!(
            git_text(repo, &["diff", "--cached", "--name-only"]),
            "conflict.txt\n"
        );
        assert_eq!(
            git_text(repo, &["status", "--porcelain"]),
            "UU conflict.txt\n M paper.md\n"
        );
    }

    #[test]
    fn failed_accept_all_preserves_a_pre_staged_asset_deletion() {
        let test_repo = TestRepo::create();
        let repo = &test_repo.path;
        fs::write(repo.join("paper.md"), "base\n").unwrap();
        fs::write(repo.join("figure.png"), b"image").unwrap();
        init_test_repo(repo, &["paper.md", "figure.png"]);

        fs::write(repo.join("paper.md"), "changed\n").unwrap();
        fs::remove_file(repo.join("figure.png")).unwrap();
        git_output(repo, &["add", "--", "figure.png"]);
        install_failing_pre_commit_hook(repo);

        let baseline = head_commit(repo).unwrap();
        let result = commit_review_all(
            repo,
            "paper.md",
            &["figure.png".to_string()],
            &baseline,
            "accept all",
        );

        assert!(result.is_err());
        assert_eq!(git_text(repo, &["show", "HEAD:paper.md"]), "base\n");
        assert_eq!(
            git_text(repo, &["diff", "--cached", "--name-status"]),
            "D\tfigure.png\n"
        );
    }
}
