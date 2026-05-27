from __future__ import annotations

import io
import os
import zipfile
from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Path, Response, status

from pydantic import BaseModel

from micracode_core.schemas.project import (
    CreateProjectRequest,
    ProjectRecord,
    PromptRecord,
    SnapshotRecord,
    UpdateProjectFileRequest,
)
from micracode_core.storage import SLUG_RE, SNAPSHOT_ID_RE, iter_ignored_top_level


class ProjectWithRootPath(ProjectRecord):
    """ProjectRecord extended with the on-disk root path (for desktop clients)."""
    root_path: str

from ..deps import StorageDep

router = APIRouter(prefix="/projects")


def _normalize_rel_path(raw: str) -> str:
    return raw.replace("\\", "/").strip().lstrip("/")


def _reject_sidecar_path(rel: str) -> None:
    if rel == ".micracode" or rel.startswith(".micracode/"):
        raise HTTPException(status_code=400, detail="cannot write under .micracode")


SlugPath = Annotated[
    str,
    Path(pattern=SLUG_RE.pattern, min_length=1, max_length=63, description="Project slug."),
]

SnapshotIdPath = Annotated[
    str,
    Path(
        pattern=SNAPSHOT_ID_RE.pattern,
        min_length=1,
        max_length=32,
        description="Snapshot id.",
    ),
]


@router.get("", response_model=list[ProjectRecord])
async def list_projects(storage: StorageDep) -> list[ProjectRecord]:
    return storage.list_projects()


@router.post("", response_model=ProjectRecord, status_code=status.HTTP_201_CREATED)
async def create_project(body: CreateProjectRequest, storage: StorageDep) -> ProjectRecord:
    try:
        return storage.create_project(name=body.name, template=body.template)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/{project_id}", response_model=ProjectWithRootPath)
async def get_project(project_id: SlugPath, storage: StorageDep) -> ProjectWithRootPath:
    record = storage.get_project(project_id)
    if record is None:
        raise HTTPException(status_code=404, detail="project not found")
    return ProjectWithRootPath(
        **record.model_dump(),
        root_path=str(storage.project_dir(project_id)),
    )


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_project(project_id: SlugPath, storage: StorageDep) -> Response:
    if not storage.delete_project(project_id):
        raise HTTPException(status_code=404, detail="project not found")
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/{project_id}/files")
async def get_project_files(
    project_id: SlugPath, storage: StorageDep
) -> dict[str, dict[str, Any]]:
    if storage.get_project(project_id) is None:
        raise HTTPException(status_code=404, detail="project not found")
    storage.ensure_next_preview_layout(project_id)
    return {"tree": storage.read_tree(project_id)}


@router.put("/{project_id}/files", status_code=status.HTTP_204_NO_CONTENT)
async def put_project_file(
    project_id: SlugPath,
    body: UpdateProjectFileRequest,
    storage: StorageDep,
) -> Response:
    if storage.get_project(project_id) is None:
        raise HTTPException(status_code=404, detail="project not found")
    rel = _normalize_rel_path(body.path)
    if not rel:
        raise HTTPException(status_code=400, detail="path is empty")
    _reject_sidecar_path(rel)
    try:
        storage.write_file(project_id, rel, body.content)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="project not found") from None
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/{project_id}/download")
async def download_project_zip(project_id: SlugPath, storage: StorageDep) -> Response:
    if storage.get_project(project_id) is None:
        raise HTTPException(status_code=404, detail="project not found")

    proj = storage.project_dir(project_id)
    ignored = frozenset(iter_ignored_top_level())
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for dirpath, dirnames, filenames in os.walk(proj, followlinks=False):
            rel_dir = os.path.relpath(dirpath, proj)
            if rel_dir == ".":
                dirnames[:] = [d for d in dirnames if d not in ignored]
                rel_prefix = ""
            else:
                rel_prefix = rel_dir.replace(os.sep, "/")
            dirnames.sort()
            for name in sorted(filenames):
                abs_path = os.path.join(dirpath, name)
                if os.path.islink(abs_path):
                    continue
                rel_path = f"{rel_prefix}/{name}" if rel_prefix else name
                arcname = f"{project_id}/{rel_path}"
                zf.write(abs_path, arcname)

    return Response(
        content=buf.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{project_id}.zip"'},
    )


@router.get("/{project_id}/prompts", response_model=list[PromptRecord])
async def get_project_prompts(
    project_id: SlugPath, storage: StorageDep
) -> list[PromptRecord]:
    if storage.get_project(project_id) is None:
        raise HTTPException(status_code=404, detail="project not found")
    return storage.read_prompts(project_id)


@router.post("/{project_id}/prompts/pop-assistant")
async def pop_last_assistant_prompt(
    project_id: SlugPath, storage: StorageDep
) -> dict[str, bool]:
    if storage.get_project(project_id) is None:
        raise HTTPException(status_code=404, detail="project not found")
    dropped = storage.pop_last_assistant_prompt(project_id)
    return {"popped": dropped is not None}


@router.get("/{project_id}/snapshots", response_model=list[SnapshotRecord])
async def list_project_snapshots(
    project_id: SlugPath, storage: StorageDep
) -> list[SnapshotRecord]:
    if storage.get_project(project_id) is None:
        raise HTTPException(status_code=404, detail="project not found")
    return storage.list_snapshots(project_id)


@router.post(
    "/{project_id}/snapshots/{snapshot_id}/restore",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def restore_project_snapshot(
    project_id: SlugPath,
    snapshot_id: SnapshotIdPath,
    storage: StorageDep,
) -> Response:
    if storage.get_project(project_id) is None:
        raise HTTPException(status_code=404, detail="project not found")
    try:
        restored = storage.restore_snapshot(project_id, snapshot_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not restored:
        raise HTTPException(status_code=404, detail="snapshot not found")
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.delete(
    "/{project_id}/snapshots/{snapshot_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_project_snapshot(
    project_id: SlugPath,
    snapshot_id: SnapshotIdPath,
    storage: StorageDep,
) -> Response:
    if storage.get_project(project_id) is None:
        raise HTTPException(status_code=404, detail="project not found")
    try:
        deleted = storage.delete_snapshot(project_id, snapshot_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not deleted:
        raise HTTPException(status_code=404, detail="snapshot not found")
    return Response(status_code=status.HTTP_204_NO_CONTENT)
