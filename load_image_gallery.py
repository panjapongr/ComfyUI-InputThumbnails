"""
Load Image (Gallery) — browse ComfyUI/input with thumbnails.

Does not replace the core Load Image node.
Does not delete files.
All file access is confined to folder_paths.get_input_directory().
"""

from __future__ import annotations

import hashlib
import os
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
    if any(p == ".." for p in parts):
        raise ValueError("path traversal is not allowed")
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
        if child.suffix.lower() not in IMAGE_EXTS:
            continue
        files.append(_rel_to_input(child))
    files.sort(key=str.lower)
    return files or ["(empty)"]


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
        files.append(
            {
                "name": child.name,
                "rel": rel,
                "subfolder": parent,
                "mtime": int(stat.st_mtime),
                "size": stat.st_size,
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
