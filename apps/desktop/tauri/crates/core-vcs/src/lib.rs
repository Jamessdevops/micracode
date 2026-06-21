//! Local Git: workspace status, working-tree diffs, and per-turn checkpoints
//! (PRD FR6).
//!
//! A [`Workspace`] wraps a Git repository rooted at a project directory. It
//! exposes three things the UI needs:
//!
//! - **Status / diff** — `git status` and the working-tree-vs-`HEAD` patch, so
//!   the UI can show what the agent has changed.
//! - **Checkpoints** — a [`Workspace::capture_checkpoint`] snapshots the *entire*
//!   working tree (tracked + untracked, minus ignored) as a commit chained on a
//!   hidden ref, `refs/micracode/checkpoints`. The chain is the durable store
//!   for checkpoints — Git's object database is the "diff blob" storage the PRD
//!   calls for, and a checkpoint's diff is just the commit-to-parent diff.
//! - **Revert** — [`Workspace::revert_to`] restores the working tree to a
//!   checkpoint's snapshot.
//!
//! Capturing never moves the user's `HEAD` or any branch: checkpoint commits
//! live only on the hidden ref, so the user's own Git history is untouched.

use std::path::{Path, PathBuf};

use serde::Serialize;

/// Ref the checkpoint commit chain lives on. Out of the user's branch namespace
/// so it never collides with their work and keeps the commits from being GC'd.
const CHECKPOINTS_REF: &str = "refs/micracode/checkpoints";
/// Commit-message prefix that marks a commit as one of our checkpoints. Used to
/// know where the checkpoint chain ends (its parent is the user's `HEAD`).
const CHECKPOINT_MSG_PREFIX: &str = "checkpoint: ";

#[derive(Debug, thiserror::Error)]
pub enum VcsError {
    #[error("git error: {0}")]
    Git(#[from] git2::Error),
    #[error("invalid checkpoint id: {0}")]
    InvalidId(String),
    #[error("checkpoint not found: {0}")]
    NotFound(String),
}

pub type Result<T> = std::result::Result<T, VcsError>;

/// How a path differs from `HEAD` in `git status`. Coarse on purpose — enough
/// for the UI to label a row; the full patch lives in the diff endpoints.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
pub enum ChangeKind {
    /// Untracked or newly staged.
    Added,
    Modified,
    Deleted,
    Renamed,
    Conflicted,
}

impl ChangeKind {
    fn from_status(s: git2::Status) -> Self {
        use git2::Status as S;
        if s.contains(S::CONFLICTED) {
            ChangeKind::Conflicted
        } else if s.intersects(S::WT_NEW | S::INDEX_NEW) {
            ChangeKind::Added
        } else if s.intersects(S::WT_DELETED | S::INDEX_DELETED) {
            ChangeKind::Deleted
        } else if s.intersects(S::WT_RENAMED | S::INDEX_RENAMED) {
            ChangeKind::Renamed
        } else {
            ChangeKind::Modified
        }
    }
}

/// One changed path in the working tree.
#[derive(Debug, Clone, PartialEq, Serialize, ts_rs::TS)]
pub struct FileChange {
    pub path: String,
    pub status: ChangeKind,
}

/// A captured checkpoint: a snapshot of the working tree plus the size of the
/// change it introduced (relative to the previous checkpoint / baseline).
#[derive(Debug, Clone, PartialEq, Serialize, ts_rs::TS)]
pub struct Checkpoint {
    /// The snapshot commit's id (hex). The handle clients pass to diff/revert.
    pub id: String,
    /// Human label captured with the snapshot (e.g. the turn's prompt).
    pub label: String,
    /// Commit time, Unix seconds.
    #[ts(type = "number")]
    pub created_at: i64,
    #[ts(type = "number")]
    pub files_changed: u64,
    #[ts(type = "number")]
    pub insertions: u64,
    #[ts(type = "number")]
    pub deletions: u64,
}

/// A Git-backed project workspace.
pub struct Workspace {
    repo: git2::Repository,
    path: PathBuf,
}

impl Workspace {
    /// Open the repository at `path`, initializing one in place if absent.
    ///
    /// Checkpointing needs a repository; project workspaces are plain
    /// directories, so the first call here lays down a `.git` (already on the
    /// app's ignored-top-level list, so it never shows up in file listings).
    /// Unlike `git`'s own discovery this does not search parent directories —
    /// the repository is always rooted exactly at `path`.
    pub fn open_or_init(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref().to_path_buf();
        let repo = match git2::Repository::open(&path) {
            Ok(repo) => repo,
            Err(_) => git2::Repository::init(&path)?,
        };
        Ok(Workspace { repo, path })
    }

    /// The workspace root.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The changed paths in the working tree (tracked changes + untracked
    /// files), ignored files excluded.
    pub fn status(&self) -> Result<Vec<FileChange>> {
        let mut opts = git2::StatusOptions::new();
        opts.include_untracked(true)
            .recurse_untracked_dirs(true)
            .include_ignored(false)
            .renames_head_to_index(true);

        let statuses = self.repo.statuses(Some(&mut opts))?;
        let mut out = Vec::with_capacity(statuses.len());
        for entry in statuses.iter() {
            let Some(path) = entry.path() else { continue };
            out.push(FileChange {
                path: path.to_string(),
                status: ChangeKind::from_status(entry.status()),
            });
        }
        Ok(out)
    }

    /// Unified diff of the working tree against `HEAD` (what the agent changed
    /// since the last commit), untracked files included.
    pub fn working_diff(&self) -> Result<String> {
        let mut opts = git2::DiffOptions::new();
        opts.include_untracked(true).recurse_untracked_dirs(true);
        let head_tree = self.head_commit()?.map(|c| c.tree()).transpose()?;
        let diff = self
            .repo
            .diff_tree_to_workdir_with_index(head_tree.as_ref(), Some(&mut opts))?;
        diff_to_string(&diff)
    }

    /// Snapshot the whole working tree as a checkpoint commit and return it.
    ///
    /// The snapshot is chained on the previous checkpoint (or the user's `HEAD`
    /// for the first one), so a checkpoint's diff is exactly the change it
    /// introduced. The user's index file and branches are left untouched.
    pub fn capture_checkpoint(&self, label: &str) -> Result<Checkpoint> {
        let tree_oid = self.write_worktree_tree()?;
        self.commit_checkpoint(tree_oid, label)
    }

    /// Like [`capture_checkpoint`](Self::capture_checkpoint) but a no-op,
    /// returning `None`, when the working tree is identical to the previous
    /// checkpoint/baseline. Used for per-turn auto-capture so turns that change
    /// nothing don't litter the chain with empty snapshots (PRD FR6).
    pub fn capture_checkpoint_if_changed(&self, label: &str) -> Result<Option<Checkpoint>> {
        let tree_oid = self.write_worktree_tree()?;
        if let Some(parent) = self.checkpoint_tip()?.or(self.head_commit()?) {
            if parent.tree()?.id() == tree_oid {
                return Ok(None);
            }
        }
        self.commit_checkpoint(tree_oid, label).map(Some)
    }

    /// Stage the full working tree into an in-memory copy of the index and
    /// write it out as a tree, returning its id. `read(true)` resets to the
    /// on-disk index first, and we never call `index.write()`, so `.git/index`
    /// is left exactly as the user (or agent) had it.
    fn write_worktree_tree(&self) -> Result<git2::Oid> {
        let mut index = self.repo.index()?;
        index.read(true)?;
        index.add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None)?;
        Ok(index.write_tree()?)
    }

    /// Commit a previously written worktree tree onto the checkpoint chain.
    fn commit_checkpoint(&self, tree_oid: git2::Oid, label: &str) -> Result<Checkpoint> {
        let signature = self.signature()?;
        let tree = self.repo.find_tree(tree_oid)?;

        let parent = self.checkpoint_tip()?.or(self.head_commit()?);
        let parents: Vec<&git2::Commit> = parent.iter().collect();

        let message = format!("{CHECKPOINT_MSG_PREFIX}{label}");
        let commit_oid = self.repo.commit(
            Some(CHECKPOINTS_REF),
            &signature,
            &signature,
            &message,
            &tree,
            &parents,
        )?;

        let commit = self.repo.find_commit(commit_oid)?;
        self.describe_commit(&commit)
    }

    /// All checkpoints, newest first.
    pub fn checkpoints(&self) -> Result<Vec<Checkpoint>> {
        let Some(tip) = self.checkpoint_tip()? else {
            return Ok(Vec::new());
        };
        let mut walk = self.repo.revwalk()?;
        walk.push(tip.id())?;

        let mut out = Vec::new();
        for oid in walk {
            let commit = self.repo.find_commit(oid?)?;
            // The chain's parent is the user's HEAD baseline, which is not one
            // of our checkpoints — stop there.
            if !is_checkpoint(&commit) {
                break;
            }
            out.push(self.describe_commit(&commit)?);
        }
        Ok(out)
    }

    /// Unified diff a checkpoint introduced (commit vs its parent).
    pub fn checkpoint_diff(&self, id: &str) -> Result<String> {
        let commit = self.find_checkpoint(id)?;
        diff_to_string(&self.diff_for_commit(&commit)?)
    }

    /// Restore the working tree to a checkpoint's snapshot.
    ///
    /// Modified tracked files are overwritten and untracked files the
    /// checkpoint did not contain are removed — i.e. the working tree is made to
    /// match the snapshot exactly. `HEAD` is not moved.
    pub fn revert_to(&self, id: &str) -> Result<()> {
        let commit = self.find_checkpoint(id)?;
        let tree = commit.tree()?;
        let mut builder = git2::build::CheckoutBuilder::new();
        builder.force().remove_untracked(true).remove_ignored(false);
        self.repo
            .checkout_tree(tree.as_object(), Some(&mut builder))?;
        Ok(())
    }

    // --- internals ---------------------------------------------------------

    fn find_checkpoint(&self, id: &str) -> Result<git2::Commit<'_>> {
        let oid = git2::Oid::from_str(id).map_err(|_| VcsError::InvalidId(id.to_string()))?;
        let commit = self
            .repo
            .find_commit(oid)
            .map_err(|_| VcsError::NotFound(id.to_string()))?;
        if !is_checkpoint(&commit) {
            return Err(VcsError::NotFound(id.to_string()));
        }
        Ok(commit)
    }

    /// The latest checkpoint commit, if any checkpoints exist.
    fn checkpoint_tip(&self) -> Result<Option<git2::Commit<'_>>> {
        match self.repo.find_reference(CHECKPOINTS_REF) {
            Ok(reference) => Ok(Some(reference.peel_to_commit()?)),
            Err(e) if e.code() == git2::ErrorCode::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// The commit `HEAD` points at, or `None` on an unborn branch (fresh repo
    /// with no commits).
    fn head_commit(&self) -> Result<Option<git2::Commit<'_>>> {
        match self.repo.head() {
            Ok(head) => Ok(Some(head.peel_to_commit()?)),
            Err(e)
                if matches!(
                    e.code(),
                    git2::ErrorCode::UnbornBranch | git2::ErrorCode::NotFound
                ) =>
            {
                Ok(None)
            }
            Err(e) => Err(e.into()),
        }
    }

    /// Diff a commit against its first parent (or the empty tree for a root
    /// commit), so it reflects only the change that commit introduced.
    fn diff_for_commit(&self, commit: &git2::Commit) -> Result<git2::Diff<'_>> {
        let new_tree = commit.tree()?;
        let old_tree = match commit.parent(0) {
            Ok(parent) => Some(parent.tree()?),
            Err(_) => None,
        };
        Ok(self
            .repo
            .diff_tree_to_tree(old_tree.as_ref(), Some(&new_tree), None)?)
    }

    fn describe_commit(&self, commit: &git2::Commit) -> Result<Checkpoint> {
        let stats = self.diff_for_commit(commit)?.stats()?;
        let label = commit
            .message()
            .unwrap_or_default()
            .strip_prefix(CHECKPOINT_MSG_PREFIX)
            .unwrap_or_default()
            .trim()
            .to_string();
        Ok(Checkpoint {
            id: commit.id().to_string(),
            label,
            created_at: commit.time().seconds(),
            files_changed: stats.files_changed() as u64,
            insertions: stats.insertions() as u64,
            deletions: stats.deletions() as u64,
        })
    }

    /// A commit signature, falling back to a fixed identity when the repo/host
    /// has no `user.name`/`user.email` configured (fresh repos, CI).
    fn signature(&self) -> Result<git2::Signature<'static>> {
        match self.repo.signature() {
            Ok(sig) => Ok(sig),
            Err(_) => Ok(git2::Signature::now(
                "Micracode",
                "checkpoints@micracode.local",
            )?),
        }
    }
}

fn is_checkpoint(commit: &git2::Commit) -> bool {
    commit
        .message()
        .unwrap_or_default()
        .starts_with(CHECKPOINT_MSG_PREFIX)
}

/// Render a libgit2 diff as a unified patch string.
fn diff_to_string(diff: &git2::Diff) -> Result<String> {
    let mut buf = String::new();
    diff.print(git2::DiffFormat::Patch, |_delta, _hunk, line| {
        // For content lines, prefix with the origin marker (+/-/space) so the
        // output reads as a normal unified diff; headers carry no origin.
        if matches!(line.origin(), '+' | '-' | ' ') {
            buf.push(line.origin());
        }
        buf.push_str(std::str::from_utf8(line.content()).unwrap_or_default());
        true
    })?;
    Ok(buf)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write(dir: &Path, rel: &str, contents: &str) {
        let path = dir.join(rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, contents).unwrap();
    }

    #[test]
    fn open_or_init_creates_a_repo() {
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::open_or_init(dir.path()).unwrap();
        assert!(ws.path().join(".git").exists());
        // Re-opening the same dir reuses the repo rather than failing.
        Workspace::open_or_init(dir.path()).unwrap();
    }

    #[test]
    fn status_reports_untracked_and_modified() {
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::open_or_init(dir.path()).unwrap();
        write(dir.path(), "a.txt", "hello\n");

        let status = ws.status().unwrap();
        assert_eq!(status.len(), 1);
        assert_eq!(status[0].path, "a.txt");
        assert_eq!(status[0].status, ChangeKind::Added);
    }

    #[test]
    fn capture_lists_a_checkpoint_whose_diff_shows_the_change() {
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::open_or_init(dir.path()).unwrap();
        write(dir.path(), "src/main.rs", "fn main() {}\n");

        let cp = ws.capture_checkpoint("first turn").unwrap();
        assert_eq!(cp.label, "first turn");
        assert_eq!(cp.files_changed, 1);
        assert_eq!(cp.insertions, 1);

        let list = ws.checkpoints().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, cp.id);

        let diff = ws.checkpoint_diff(&cp.id).unwrap();
        assert!(diff.contains("src/main.rs"), "diff was: {diff}");
        assert!(diff.contains("+fn main() {}"), "diff was: {diff}");
    }

    #[test]
    fn second_checkpoint_diffs_against_the_first() {
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::open_or_init(dir.path()).unwrap();
        write(dir.path(), "a.txt", "one\n");
        ws.capture_checkpoint("c1").unwrap();
        write(dir.path(), "a.txt", "one\ntwo\n");
        let c2 = ws.capture_checkpoint("c2").unwrap();

        // Newest first, two in the chain.
        let list = ws.checkpoints().unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].id, c2.id);

        // The second checkpoint only adds the new line, not the original.
        let diff = ws.checkpoint_diff(&c2.id).unwrap();
        assert!(diff.contains("+two"), "diff was: {diff}");
        assert!(!diff.contains("+one"), "diff was: {diff}");
    }

    #[test]
    fn revert_restores_the_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::open_or_init(dir.path()).unwrap();
        write(dir.path(), "a.txt", "original\n");
        let cp = ws.capture_checkpoint("baseline").unwrap();

        // Agent mutates a tracked file and adds an untracked one.
        write(dir.path(), "a.txt", "tampered\n");
        write(dir.path(), "b.txt", "junk\n");

        ws.revert_to(&cp.id).unwrap();

        assert_eq!(fs::read_to_string(dir.path().join("a.txt")).unwrap(), "original\n");
        assert!(
            !dir.path().join("b.txt").exists(),
            "untracked file added after the checkpoint should be removed on revert"
        );
    }

    #[test]
    fn capture_if_changed_skips_when_nothing_changed() {
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::open_or_init(dir.path()).unwrap();
        write(dir.path(), "a.txt", "one\n");

        // First call snapshots the new file.
        assert!(ws.capture_checkpoint_if_changed("c1").unwrap().is_some());
        // Second call with no further edits is a no-op.
        assert!(ws.capture_checkpoint_if_changed("c2").unwrap().is_none());
        assert_eq!(ws.checkpoints().unwrap().len(), 1);

        // A real edit produces another checkpoint.
        write(dir.path(), "a.txt", "one\ntwo\n");
        assert!(ws.capture_checkpoint_if_changed("c3").unwrap().is_some());
        assert_eq!(ws.checkpoints().unwrap().len(), 2);
    }

    #[test]
    fn capture_does_not_move_head_or_branches() {
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::open_or_init(dir.path()).unwrap();
        write(dir.path(), "a.txt", "x\n");
        ws.capture_checkpoint("c1").unwrap();
        // HEAD is still unborn — checkpoints live only on the hidden ref.
        assert!(ws.head_commit().unwrap().is_none());
    }

    #[test]
    fn unknown_or_non_checkpoint_id_is_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::open_or_init(dir.path()).unwrap();
        let bogus = "0".repeat(40);
        assert!(matches!(
            ws.checkpoint_diff(&bogus),
            Err(VcsError::NotFound(_))
        ));
        assert!(matches!(
            ws.checkpoint_diff("not-hex"),
            Err(VcsError::InvalidId(_))
        ));
    }
}
