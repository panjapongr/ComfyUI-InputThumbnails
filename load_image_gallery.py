"""
Load Image (Gallery) — browse ComfyUI/input with thumbnails.

Does not replace the core Load Image node.
Does not delete files.
All file access is confined to folder_paths.get_input_directory().
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import queue
import threading
from pathlib import Path

import numpy as np
import torch
from aiohttp import web
from PIL import Image, ImageFile, ImageOps, ImageSequence, UnidentifiedImageError

import folder_paths
from server import PromptServer


IMAGE_EXTS = {
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
    ".bmp",
    ".gif",
    ".tif",
    ".tiff",
    ".avif",
}


def _input_root() -> Path:
    return Path(folder_paths.get_input_directory()).resolve()


def _safe_under_input(rel: str, *, must_exist: bool = False) -> Path:
    """Resolve a relative path and reject anything outside input/."""
    root = _input_root()
    cleaned = (rel or "").replace("\\", "/").strip()
    parts = [p for p in cleaned.split("/") if p and p not in (".",)]
    if any(p == ".." or ":" in p for p in parts):
        raise ValueError("path traversal is not allowed")
    if parts and parts[0] == ".cache":
        raise ValueError("access to .cache folder is not allowed")
    path = (root.joinpath(*parts) if parts else root).resolve()
    try:
        path.relative_to(root)
    except ValueError as exc:
        raise ValueError("path is outside the input folder") from exc
    if must_exist and not path.exists():
        raise FileNotFoundError(cleaned or ".")
    return path


def _rel_to_input(path: Path) -> str | None:
    try:
        rel = path.resolve().relative_to(_input_root())
        text = str(rel).replace("\\", "/")
        return "" if text == "." else text
    except ValueError:
        return None


def _list_combo_values() -> list[str]:
    root = _input_root()
    if not root.is_dir():
        return ["(empty)"]
    files: list[str] = []
    for child in root.rglob("*"):
        if not child.is_file():
            continue
        try:
            rel_parts = child.resolve().relative_to(root).parts
        except ValueError:
            continue
        if any(part.startswith(".") for part in rel_parts):
            continue
        if child.suffix.lower() not in IMAGE_EXTS:
            continue
        rel = _rel_to_input(child)
        if rel:
            files.append(rel)
    files.sort(key=str.lower)
    return files or ["(empty)"]


_HASH_CACHE: dict[str, tuple[int, int, str]] = {}
_HASH_LOCK: threading.Lock = threading.Lock()
_MAX_HASH_CACHE_ENTRIES: int = 20000
_CACHE_QUEUE: queue.Queue = queue.Queue()
_PENDING_BUILDS: set[str] = set()
_PENDING_LOCK: threading.Lock = threading.Lock()
_MAX_CACHE_WORKERS: int = 2


def _cache_root() -> Path:
    """Return the .cache/thumb folder located inside ComfyUI input folder."""
    root = _input_root()
    cache_dir = (root / ".cache" / "thumb").resolve()
    cache_dir.relative_to(root)  # Enforce: must be strictly inside input/
    cache_dir.mkdir(parents=True, exist_ok=True)
    return cache_dir


def _assert_under_cache(path: Path) -> Path:
    """Guarantee that a path is strictly inside the .cache/thumb directory before any write or delete."""
    resolved = path.resolve()
    cache_root = _cache_root()
    try:
        resolved.relative_to(cache_root)
    except ValueError as exc:
        raise ValueError(f"Filesystem mutation rejected: {path} is outside .cache/thumb") from exc
    return resolved


DEFAULT_SETTINGS = {
    "fit_style": "cover",
    "page_size": 60,
    "sort_by": "name_asc",
    "show_folders": True,
}
ALLOWED_FIT_STYLES = {"cover", "contain", "stretch", "center"}
ALLOWED_PAGE_SIZES = {60, 120, 240, 300, 600}
ALLOWED_SORT_OPTIONS = {"name_asc", "name_desc", "date_desc", "date_asc"}
SETTINGS_FILENAME = "settings.json"
_SETTINGS_LOCK: threading.RLock = threading.RLock()


def _settings_path() -> Path:
    """Return path to settings.json, strictly guarded under .cache/thumb."""
    return _assert_under_cache(_cache_root() / SETTINGS_FILENAME)


def _save_settings(data: dict) -> bool:
    """Save settings dictionary to settings.json atomically inside .cache/thumb."""
    with _SETTINGS_LOCK:
        temp_file = None
        try:
            target = _settings_path()
            temp_file = target.with_name(f".settings.tmp.{os.getpid()}.{threading.get_ident()}")
            _assert_under_cache(temp_file)
            with open(temp_file, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2)
            temp_file.replace(target)
            return True
        except Exception as exc:
            if temp_file and temp_file.is_file():
                try:
                    _assert_under_cache(temp_file).unlink()
                except (OSError, ValueError):
                    pass
            print(f"[InputThumbnails] Failed to save settings: {exc}")
            return False


def _get_settings() -> dict:
    """Read settings from settings.json with automatic corruption recovery."""
    with _SETTINGS_LOCK:
        path = _settings_path()
        if not path.is_file():
            _save_settings(DEFAULT_SETTINGS)
            return DEFAULT_SETTINGS.copy()

        try:
            if path.stat().st_size == 0:
                raise ValueError("settings.json is 0 bytes")

            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)

            if not isinstance(data, dict):
                raise ValueError("settings.json root is not an object")

            fit_style = data.get("fit_style")
            if fit_style not in ALLOWED_FIT_STYLES:
                fit_style = DEFAULT_SETTINGS["fit_style"]

            page_size = data.get("page_size")
            if page_size not in ALLOWED_PAGE_SIZES:
                page_size = DEFAULT_SETTINGS["page_size"]

            sort_by = data.get("sort_by")
            if sort_by not in ALLOWED_SORT_OPTIONS:
                sort_by = DEFAULT_SETTINGS["sort_by"]

            show_folders = data.get("show_folders")
            if not isinstance(show_folders, bool):
                show_folders = DEFAULT_SETTINGS["show_folders"]

            clean_settings = {
                "fit_style": fit_style,
                "page_size": page_size,
                "sort_by": sort_by,
                "show_folders": show_folders,
            }
            if (
                data.get("fit_style") != fit_style
                or data.get("page_size") != page_size
                or data.get("sort_by") != sort_by
                or data.get("show_folders") != show_folders
            ):
                _save_settings(clean_settings)

            return clean_settings
        except Exception as exc:
            print(f"[InputThumbnails] settings.json corrupted or invalid ({exc}), recovering to defaults...")
            _save_settings(DEFAULT_SETTINGS)
            return DEFAULT_SETTINGS.copy()


def _cache_path(subfolder: str, filename: str, file_hash: str) -> Path:
    """Resolve cache file location using Option B:
    Mirrored input subfolders + 2-character hex hash prefix subfolder:
    .cache/thumb / (subfolder or "_root") / hash[:2] / f"{clean_filename}_{hash[:12]}.webp"
    """
    cache_root = _cache_root()
    clean_sub = [p for p in (subfolder or "").replace("\\", "/").split("/") if p and p not in (".", "..")]
    sub_parts = clean_sub if clean_sub else ["_root"]
    hash_prefix = file_hash[:2] if len(file_hash) >= 2 else "00"
    short_hash = file_hash[:12] if len(file_hash) >= 12 else file_hash
    clean_name = Path(filename).name

    path = cache_root.joinpath(*sub_parts, hash_prefix, f"{clean_name}_{short_hash}.webp")
    return _assert_under_cache(path)


def _clean_old_cache(subfolder: str, filename: str, current_cache_path: Path) -> None:
    """Remove previous cache files for the same filename in this subfolder if hash changed."""
    clean_sub = [p for p in (subfolder or "").replace("\\", "/").split("/") if p and p not in (".", "..")]
    sub_parts = clean_sub if clean_sub else ["_root"]
    sub_dir = _cache_root().joinpath(*sub_parts)
    try:
        _assert_under_cache(sub_dir)
    except ValueError:
        return
    if not sub_dir.is_dir():
        return
    clean_name = Path(filename).name
    expected_prefix = f"{clean_name}_"
    # Iterate subdirectories safely without glob pattern injection
    try:
        for hash_dir in sub_dir.iterdir():
            if not hash_dir.is_dir():
                continue
            for old_file in hash_dir.iterdir():
                try:
                    target = _assert_under_cache(old_file)
                    if target.name.startswith(expected_prefix) and target.name.endswith(".webp"):
                        if target != current_cache_path.resolve():
                            target.unlink()
                except (ValueError, OSError):
                    pass
    except OSError:
        pass


def _cleanup_stale_tmp_files() -> None:
    """Clean up any leftover temporary files from abruptly terminated sessions."""
    try:
        cache_root = _cache_root()
        if cache_root.is_dir():
            for tmp_file in cache_root.rglob(".*.tmp.*"):
                try:
                    _assert_under_cache(tmp_file).unlink()
                except (ValueError, OSError):
                    pass
    except Exception:
        pass


def _compute_file_hash(path: Path) -> str:
    """Compute SHA-256 hash of file content, using in-memory (mtime_ns, size) caching."""
    try:
        path.resolve().relative_to(_input_root())  # Enforce: file must be under input/
        stat = path.stat()
    except (OSError, ValueError):
        return ""

    key = str(path.resolve())
    mtime_ns = stat.st_mtime_ns
    size = stat.st_size

    with _HASH_LOCK:
        cached = _HASH_CACHE.get(key)
        if cached is not None and cached[0] == mtime_ns and cached[1] == size:
            return cached[2]

    h = hashlib.sha256()
    try:
        with open(path, "rb") as f:
            while chunk := f.read(131072):
                h.update(chunk)
        digest = h.hexdigest()
    except OSError:
        fingerprint = f"{path.as_posix()}::{size}::{mtime_ns}"
        digest = hashlib.sha256(fingerprint.encode("utf-8")).hexdigest()

    with _HASH_LOCK:
        if len(_HASH_CACHE) >= _MAX_HASH_CACHE_ENTRIES:
            _HASH_CACHE.clear()
        _HASH_CACHE[key] = (mtime_ns, size, digest)
    return digest


def _generate_thumbnail(src_path: Path, dest_path: Path, max_size: int = 280) -> bool:
    """Generate an optimized WebP thumbnail downscaled to max_size using an atomic temp file."""
    temp_dest = None
    try:
        root = _input_root()
        # Strict boundary assertions: source must be under input/, destination strictly under .cache
        src_path.resolve().relative_to(root)
        _assert_under_cache(dest_path)

        # Directory creation strictly inside .cache
        _assert_under_cache(dest_path.parent).mkdir(parents=True, exist_ok=True)
        img = _open_image(src_path)
        img = ImageOps.exif_transpose(img)

        if hasattr(img, "is_animated") and img.is_animated:
            img.seek(0)

        if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
            img = img.convert("RGBA")
        elif img.mode != "RGB":
            img = img.convert("RGB")

        img.thumbnail((max_size, max_size), Image.Resampling.LANCZOS)

        # Unique temp filename with PID and thread ID strictly in dest_path parent inside .cache
        temp_dest = dest_path.with_name(f".{dest_path.name}.tmp.{os.getpid()}.{threading.get_ident()}")
        _assert_under_cache(temp_dest)
        img.save(temp_dest, format="WEBP", quality=85, method=4)
        temp_dest.replace(dest_path)
        return True
    except Exception as exc:
        if temp_dest and temp_dest.is_file():
            try:
                _assert_under_cache(temp_dest).unlink()
            except (OSError, ValueError):
                pass
        print(f"[InputThumbnails] Failed to generate thumbnail for {src_path}: {exc}")
        return False


def _cache_worker_loop() -> None:
    """Background daemon worker: processes queued thumbnail generation tasks."""
    while True:
        try:
            item = _CACHE_QUEUE.get()
            if item is None:
                break
            src_path, cache_path, subfolder, filename = item
            try:
                success = _generate_thumbnail(src_path, cache_path)
                if success and cache_path.is_file() and cache_path.stat().st_size > 0:
                    _clean_old_cache(subfolder, filename, cache_path)
            except Exception as exc:
                print(f"[InputThumbnails] Background cache error for {src_path.name}: {exc}")
            finally:
                with _PENDING_LOCK:
                    _PENDING_BUILDS.discard(str(cache_path))
                _CACHE_QUEUE.task_done()
        except Exception:
            pass


# Start daemon worker threads so they NEVER block ComfyUI process exit
for _worker_idx in range(_MAX_CACHE_WORKERS):
    _t = threading.Thread(target=_cache_worker_loop, name=f"input_thumbs_worker_{_worker_idx}", daemon=True)
    _t.start()

# Ensure .cache/thumb directory is created if it does not exist on startup
def _init_cache_dir() -> None:
    try:
        _cache_root()
        _get_settings()
    except Exception:
        pass

_init_cache_dir()

# Clean up any leftover temporary files on a daemon thread
threading.Thread(target=_cleanup_stale_tmp_files, name="input_thumbs_cleanup", daemon=True).start()


def _open_image(path: Path) -> Image.Image:
    previous = ImageFile.LOAD_TRUNCATED_IMAGES
    try:
        try:
            return Image.open(path)
        except (OSError, UnidentifiedImageError, ValueError):
            ImageFile.LOAD_TRUNCATED_IMAGES = True
            return Image.open(path)
    finally:
        ImageFile.LOAD_TRUNCATED_IMAGES = previous


@PromptServer.instance.routes.get("/input_thumbs/thumb")
async def get_input_thumbnail(request):
    filename = request.rel_url.query.get("filename", "")
    subfolder = request.rel_url.query.get("subfolder", "")

    if not filename:
        return web.json_response({"error": "filename required"}, status=400)

    rel = f"{subfolder}/{filename}" if subfolder else filename
    try:
        src_path = _safe_under_input(rel, must_exist=True)
    except (ValueError, FileNotFoundError) as exc:
        return web.json_response({"error": str(exc)}, status=404)

    if not src_path.is_file():
        return web.json_response({"error": "not a file"}, status=404)

    # Compute hash in thread pool to prevent blocking the async server event loop
    loop = asyncio.get_running_loop()
    file_hash = await loop.run_in_executor(None, _compute_file_hash, src_path)
    if not file_hash:
        return web.FileResponse(src_path)

    cache_path = _cache_path(subfolder, filename, file_hash)

    # 1. If valid cached thumbnail exists (and non-empty), serve it immediately!
    if cache_path.is_file():
        try:
            if cache_path.stat().st_size > 0:
                etag = f'"{file_hash[:16]}"'
                if request.headers.get("If-None-Match") == etag:
                    return web.Response(status=304)

                return web.FileResponse(
                    cache_path,
                    headers={
                        "Cache-Control": "public, max-age=86400",
                        "ETag": etag,
                        "X-Thumb-Cache": "hit",
                    },
                )
            else:
                # Corrupted 0-byte file removed strictly inside .cache
                _assert_under_cache(cache_path).unlink()
        except OSError:
            pass

    # 2. Cache MISS: Queue background generation in daemon worker
    cache_key = str(cache_path)
    with _PENDING_LOCK:
        if cache_key not in _PENDING_BUILDS:
            _PENDING_BUILDS.add(cache_key)
            _CACHE_QUEUE.put((src_path, cache_path, subfolder, filename))

    # 3. Immediately return the real image so the UI displays it right away without freeze/delay
    return web.FileResponse(
        src_path,
        headers={
            "Cache-Control": "no-cache",
            "X-Thumb-Cache": "miss",
        },
    )


@PromptServer.instance.routes.get("/input_thumbs/list")
async def list_input_folder(request):
    folder = request.rel_url.query.get("folder", "")
    try:
        base = _safe_under_input(folder)
    except (ValueError, FileNotFoundError) as exc:
        return web.json_response({"error": str(exc)}, status=400)

    if not base.is_dir():
        return web.json_response({"error": "not a folder"}, status=400)

    dirs = []
    files = []
    try:
        children = list(base.iterdir())
    except OSError as exc:
        return web.json_response({"error": str(exc)}, status=500)

    for child in sorted(children, key=lambda p: p.name.lower()):
        if child.name.startswith("."):
            continue
        if child.is_dir():
            dirs.append({"name": child.name, "rel": _rel_to_input(child)})
            continue
        if child.suffix.lower() not in IMAGE_EXTS:
            continue
        try:
            stat = child.stat()
        except OSError:
            continue
        rel = _rel_to_input(child)
        parent = _rel_to_input(child.parent)

        key = str(child.resolve())
        cached = _HASH_CACHE.get(key)
        file_hash = cached[2] if cached and cached[0] == stat.st_mtime_ns and cached[1] == stat.st_size else ""

        files.append(
            {
                "name": child.name,
                "rel": rel,
                "subfolder": parent,
                "mtime": int(stat.st_mtime),
                "size": stat.st_size,
                "hash": file_hash,
            }
        )

    current = _rel_to_input(base)
    parent = None
    if base != _input_root():
        parent = _rel_to_input(base.parent)

    return web.json_response(
        {
            "folder": current,
            "parent": parent,
            "dirs": dirs,
            "files": files,
        }
    )


@PromptServer.instance.routes.get("/input_thumbs/settings")
async def get_input_thumbnails_settings(request):
    loop = asyncio.get_running_loop()
    settings = await loop.run_in_executor(None, _get_settings)
    return web.json_response(settings)


@PromptServer.instance.routes.post("/input_thumbs/settings")
async def save_input_thumbnails_settings(request):
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "invalid json"}, status=400)

    if not isinstance(body, dict):
        return web.json_response({"error": "payload must be a JSON object"}, status=400)

    current_settings = _get_settings()
    updated = False

    if "fit_style" in body:
        fit_style = body.get("fit_style")
        if fit_style not in ALLOWED_FIT_STYLES:
            return web.json_response(
                {"error": f"fit_style must be one of {sorted(ALLOWED_FIT_STYLES)}"},
                status=400,
            )
        current_settings["fit_style"] = fit_style
        updated = True

    if "page_size" in body:
        try:
            page_size = int(body.get("page_size"))
        except (ValueError, TypeError):
            return web.json_response(
                {"error": f"page_size must be an integer in {sorted(ALLOWED_PAGE_SIZES)}"},
                status=400,
            )
        if page_size not in ALLOWED_PAGE_SIZES:
            return web.json_response(
                {"error": f"page_size must be one of {sorted(ALLOWED_PAGE_SIZES)}"},
                status=400,
            )
        current_settings["page_size"] = page_size
        updated = True

    if "sort_by" in body:
        sort_by = body.get("sort_by")
        if sort_by not in ALLOWED_SORT_OPTIONS:
            return web.json_response(
                {"error": f"sort_by must be one of {sorted(ALLOWED_SORT_OPTIONS)}"},
                status=400,
            )
        current_settings["sort_by"] = sort_by
        updated = True

    if "show_folders" in body:
        show_folders = body.get("show_folders")
        if not isinstance(show_folders, bool):
            return web.json_response(
                {"error": "show_folders must be a boolean"},
                status=400,
            )
        current_settings["show_folders"] = show_folders
        updated = True

    if not updated:
        return web.json_response({"error": "no valid settings provided"}, status=400)

    loop = asyncio.get_running_loop()
    success = await loop.run_in_executor(None, _save_settings, current_settings)
    if not success:
        return web.json_response({"error": "failed to write settings"}, status=500)

    return web.json_response(current_settings)


class LoadImageGallery:
    CATEGORY = "image"
    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("image", "mask")
    FUNCTION = "load_image"
    DESCRIPTION = "Load an image from ComfyUI/input with a thumbnail browser."

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": (
                    _list_combo_values(),
                    {"image_upload": True},
                ),
            }
        }

    def load_image(self, image):
        if not image or image == "(empty)":
            raise FileNotFoundError("No image selected")

        path = _safe_under_input(image, must_exist=True)
        if not path.is_file():
            raise FileNotFoundError(image)

        img = _open_image(path)
        output_images = []
        output_masks = []

        for frame in ImageSequence.Iterator(img):
            frame = ImageOps.exif_transpose(frame)
            if frame.mode == "I":
                frame = frame.point(lambda i: i * (1 / 255))
            rgb = frame.convert("RGB")
            arr = np.array(rgb).astype(np.float32) / 255.0
            tensor = torch.from_numpy(arr)[None,]
            if "A" in frame.getbands():
                alpha = np.array(frame.getchannel("A")).astype(np.float32) / 255.0
                mask = 1.0 - torch.from_numpy(alpha)
            else:
                mask = torch.zeros((64, 64), dtype=torch.float32, device="cpu")
            output_images.append(tensor)
            output_masks.append(mask.unsqueeze(0))

        if len(output_images) > 1:
            return (torch.cat(output_images, dim=0), torch.cat(output_masks, dim=0))
        return (output_images[0], output_masks[0])

    @classmethod
    def IS_CHANGED(cls, image):
        if not image or image == "(empty)":
            return ""
        try:
            path = _safe_under_input(image, must_exist=True)
            stat = path.stat()
        except (ValueError, FileNotFoundError, OSError):
            return image
        fingerprint = f"{path.as_posix()}::{stat.st_size}::{stat.st_mtime_ns}"
        return hashlib.sha256(fingerprint.encode("utf-8")).hexdigest()

    @classmethod
    def VALIDATE_INPUTS(cls, image):
        if not image or image == "(empty)":
            return "Select an image from the gallery"
        try:
            path = _safe_under_input(image, must_exist=True)
        except Exception as exc:
            return str(exc)
        if not path.is_file():
            return f"Invalid image file: {image}"
        if path.suffix.lower() not in IMAGE_EXTS:
            return f"Unsupported image type: {path.suffix}"
        return True


NODE_CLASS_MAPPINGS = {
    "LoadImageGallery": LoadImageGallery,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "LoadImageGallery": "Load Image (Gallery)",
}
