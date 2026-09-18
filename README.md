# Load Image (Gallery)

A small ComfyUI custom node that shows **thumbnails while you browse** `ComfyUI/input`.

- New node: **Load Image (Gallery)**
- Does **not** replace the built-in Load Image node
- Does **not** delete files
- Stays inside the `input/` folder (rejects `..` path traversal)
- Subfolder navigation, search, sort by name / newest / oldest
- Same outputs as Load Image: `IMAGE` + `MASK`

## Install

1. Copy the `ComfyUI-InputThumbnails` folder into:

   `ComfyUI/custom_nodes/ComfyUI-InputThumbnails`

2. Restart ComfyUI.
3. Hard-refresh the browser (`Ctrl+F5` / `Cmd+Shift+R`).

## Use

1. Add node: **image → Load Image (Gallery)**
2. Click a folder card to enter it, **↑** to go up.
3. Click a thumbnail to select it.
4. Wire `image` into the rest of the workflow as usual.

The dropdown and upload button still work. The grid is just the visual picker.

## Files

```
ComfyUI-InputThumbnails/
  __init__.py
  load_image_gallery.py   # node + /input_thumbs/list API
  js/input_thumbnails.js  # thumbnail grid UI
  README.md
```

## Notes

Do not install this *and* a pack that also overrides core `LoadImage` if you only want one picker. This pack uses its own class name (`LoadImageGallery`), so it will not fight those packs — you will simply have two different loader nodes.

## License

[GPL-3.0-or-later](LICENSE.txt). See [`LICENSE.txt`](LICENSE.txt).