"""Git utilities for checkpoint/undo functionality.

Uses temporary commits to create checkpoints without polluting visible history.
Checkpoints are identified by commit message prefix [Micracode-checkpoint].
"""

import subprocess
import os
from typing import Optional


CHECKPOINT_PREFIX = "[Micracode-checkpoint]"


def _run_git_command(args: list[str], cwd: Optional[str] = None) -> tuple[bool, str]:
    """Run a git command and return (success, output).
    
    Args:
        args: Git command arguments (without 'git' prefix)
        cwd: Working directory (defaults to current directory)
        
    Returns:
        Tuple of (success: bool, output: str)
    """
    try:
        result = subprocess.run(
            ["git"] + args,
            capture_output=True,
            text=True,
            cwd=cwd or os.getcwd(),
        )
        output = result.stdout.strip() or result.stderr.strip()
        return result.returncode == 0, output
    except FileNotFoundError:
        return False, "Git is not installed"
    except Exception as e:
        return False, str(e)


def is_git_repo(path: Optional[str] = None) -> bool:
    """Check if the given path is inside a Git repository.
    
    Args:
        path: Directory to check (defaults to current directory)
        
    Returns:
        True if inside a Git repo, False otherwise
    """
    success, _ = _run_git_command(
        ["rev-parse", "--is-inside-work-tree"],
        cwd=path
    )
    return success


def is_working_dir_dirty(path: Optional[str] = None) -> bool:
    """Check if the working directory has uncommitted changes.
    
    Args:
        path: Directory to check (defaults to current directory)
        
    Returns:
        True if there are uncommitted changes, False otherwise
    """
    success, output = _run_git_command(
        ["status", "--porcelain"],
        cwd=path
    )
    return success and bool(output.strip())


def get_current_head(path: Optional[str] = None) -> tuple[bool, str]:
    """Get the current HEAD commit SHA.
    
    Args:
        path: Working directory (defaults to current directory)
        
    Returns:
        Tuple of (success: bool, sha_or_error: str)
    """
    return _run_git_command(["rev-parse", "HEAD"], cwd=path)


def create_checkpoint(path: Optional[str] = None) -> tuple[bool, str]:
    """Create a checkpoint by committing current state.
    
    Creates a temporary commit that captures the current state.
    This works even if the directory is clean (creates empty commit).
    
    Args:
        path: Working directory (defaults to current directory)
        
    Returns:
        Tuple of (success: bool, commit_sha_or_error: str)
    """
    if not is_git_repo(path):
        return False, "Not a Git repository"
    
    # Stage all changes (including untracked files)
    _run_git_command(["add", "-A"], cwd=path)
    
    # Create commit (allow empty if no changes)
    success, output = _run_git_command(
        ["commit", "--allow-empty", "-m", CHECKPOINT_PREFIX],
        cwd=path
    )
    
    if not success:
        return False, f"Failed to create checkpoint: {output}"
    
    # Get the SHA of the checkpoint commit
    success, sha = get_current_head(path)
    if success:
        return True, sha
    return False, "Failed to get checkpoint SHA"


def revert_to_checkpoint(checkpoint_sha: str, path: Optional[str] = None) -> tuple[bool, str]:
    """Revert to a checkpoint commit.
    
    Performs a hard reset to the commit BEFORE the checkpoint,
    effectively undoing everything since that point.
    
    Args:
        checkpoint_sha: The SHA of the checkpoint commit to revert from
        path: Working directory (defaults to current directory)
        
    Returns:
        Tuple of (success: bool, message: str)
    """
    if not is_git_repo(path):
        return False, "Not a Git repository"
    
    # Reset to the commit BEFORE the checkpoint (parent of checkpoint)
    success, output = _run_git_command(
        ["reset", "--hard", f"{checkpoint_sha}~1"],
        cwd=path
    )
    
    if success:
        return True, "Reverted to previous state"
    return False, f"Failed to revert: {output}"


def get_last_checkpoint_sha(path: Optional[str] = None) -> tuple[bool, str]:
    """Get the SHA of the most recent checkpoint commit.
    
    Args:
        path: Working directory (defaults to current directory)
        
    Returns:
        Tuple of (success: bool, sha_or_error: str)
    """
    # Find the most recent commit with our checkpoint prefix
    success, output = _run_git_command(
        ["log", "--oneline", "-n", "50", "--format=%H %s"],
        cwd=path
    )
    
    if not success:
        return False, f"Failed to read git log: {output}"
    
    for line in output.split("\n"):
        if CHECKPOINT_PREFIX in line:
            sha = line.split()[0]
            return True, sha
    
    return False, "No checkpoint found"
