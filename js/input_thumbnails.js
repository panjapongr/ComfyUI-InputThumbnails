import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_CLASS = "LoadImageGallery";
const THUMB = 140;

function fileFromRel(rel) {
  const parts = String(rel || "").replace(/\\/g, "/").split("/").filter(Boolean);
  const name = parts.pop() || "";
  return {
    name,
    subfolder: parts.join("/"),
    rel: parts.length ? `${parts.join("/")}/${name}` : name,
  };
}

function thumbQuery(file) {
  const params = new URLSearchParams({
    filename: file.name,
    subfolder: file.subfolder || "",
  });
  if (file.hash) params.set("hash", file.hash);
  if (file.mtime) params.set("t", String(file.mtime));
  return params.toString();
}

function viewQuery(file) {
  return new URLSearchParams({
    filename: file.name,
    type: "input",
    subfolder: file.subfolder || "",
  }).toString();
}

function comboValues(widget) {
  const out = [];
  const push = (v) => {
    if (typeof v === "string" && v && v !== "(empty)" && !out.includes(v)) out.push(v);
  };
  if (!widget) return out;
  push(widget.value);
  const opts = widget.options;
  if (Array.isArray(opts?.values)) opts.values.forEach(push);
  else if (Array.isArray(opts)) opts.forEach(push);
  if (Array.isArray(widget.values)) widget.values.forEach(push);
  return out;
}

function filesInFolder(allRels, folder) {
  const prefix = folder ? `${folder}/` : "";
  const dirs = new Map();
  const files = [];
  for (const rel of allRels) {
    if (rel.startsWith(".cache/") || rel === ".cache") continue;
    const parsed = fileFromRel(rel);
    if (folder) {
      if (parsed.rel === folder || !parsed.rel.startsWith(prefix)) continue;
      const rest = parsed.rel.slice(prefix.length);
      const cut = rest.indexOf("/");
      if (cut >= 0) {
        dirs.set(`${folder}/${rest.slice(0, cut)}`, rest.slice(0, cut));
        continue;
      }
      files.push(parsed);
    } else if (parsed.subfolder) {
      const top = parsed.subfolder.split("/")[0];
      dirs.set(top, top);
    } else {
      files.push(parsed);
    }
  }
  return {
    dirs: [...dirs.entries()].map(([rel, name]) => ({ rel, name })),
    files,
  };
}

function imageWidget(node) {
  return node.widgets?.find((w) => w.name === "image");
}

function setImageWidget(node, rel) {
  const widget = imageWidget(node);
  if (!widget) return;
  if (Array.isArray(widget.options?.values) && !widget.options.values.includes(rel)) {
    widget.options.values = [...widget.options.values, rel];
  }
  widget.value = rel;
  if (typeof widget.callback === "function") widget.callback(rel);
  node.setDirtyCanvas?.(true, true);
}

async function blobUrlFor(file) {
  const tq = thumbQuery(file);
  const vq = viewQuery(file);
  const attempts = [
    `/input_thumbs/thumb?${tq}`,
    `/view?${vq}`,
    `/api/view?${vq}`,
  ];
  let lastErr = "preview failed";
  for (const path of attempts) {
    try {
      const res = await api.fetchApi(path);
      if (!res.ok) {
        lastErr = `HTTP ${res.status}`;
        continue;
      }
      const blob = await res.blob();
      if (!blob || blob.size < 10) {
        lastErr = "empty file";
        continue;
      }
      if (blob.type && !blob.type.startsWith("image/") && blob.type !== "application/octet-stream") {
        lastErr = blob.type;
        continue;
      }
      return URL.createObjectURL(blob);
    } catch (err) {
      lastErr = err?.message || String(err);
    }
  }
  throw new Error(lastErr);
}

function thumbBox() {
  const box = document.createElement("div");
  box.style.cssText = [
    `width:100%`,
    `height:${THUMB}px`,
    `min-height:${THUMB}px`,
    `max-height:${THUMB}px`,
    `background:#0d0d0d`,
    `display:flex`,
    `align-items:center`,
    `justify-content:center`,
    `overflow:hidden`,
    `flex:0 0 ${THUMB}px`,
  ].join(";");
  return box;
}

function injectStyles() {
  if (document.getElementById("itg-modal-styles")) return;
  const style = document.createElement("style");
  style.id = "itg-modal-styles";
  style.textContent = `
    .itg-overlay {
      position: fixed !important;
      inset: 0 !important;
      z-index: 100000 !important;
      background: rgba(0, 0, 0, 0.65);
      display: flex !important;
      align-items: center;
      justify-content: center;
      font: 13px/1.35 sans-serif;
      color: #eee;
    }
    .itg-panel {
      width: min(960px, calc(100vw - 40px));
      height: min(80vh, 820px);
      background: #1c1c1c;
      border: 1px solid #444;
      border-radius: 10px;
      display: flex !important;
      flex-direction: column;
      overflow: hidden;
    }
    .itg-head {
      display: flex;
      gap: 8px;
      align-items: center;
      padding: 10px 12px;
      border-bottom: 1px solid #333;
    }
    .itg-head input, .itg-head button {
      background: #111;
      color: #eee;
      border: 1px solid #555;
      border-radius: 4px;
      padding: 6px 10px;
      font-size: 13px;
    }
    .itg-head input { flex: 1; min-width: 120px; }
    .itg-head button { cursor: pointer; }
    .itg-path { padding: 6px 12px 0; color: #9aa; font-size: 12px; }
    .itg-grid {
      flex: 1 1 auto;
      overflow: auto;
      display: grid !important;
      grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
      gap: 10px;
      align-content: start;
      padding: 12px;
    }
    .itg-card {
      background: #141414;
      border: 1px solid #333;
      border-radius: 8px;
      cursor: pointer;
      overflow: hidden;
      display: flex !important;
      flex-direction: column;
      min-height: ${THUMB + 32}px;
    }
    .itg-card:hover { border-color: #777; }
    .itg-card.is-selected { border-color: #6ea8fe; }
    .itg-name { padding: 6px 8px 8px; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .itg-empty { grid-column: 1 / -1; text-align: center; color: #aaa; padding: 40px 10px; }
  `;
  document.head.appendChild(style);
}

function closeModal() {
  document.querySelectorAll(".itg-overlay").forEach((el) => {
    if (el._itgObserver) {
      el._itgObserver.disconnect();
      el._itgObserver = null;
    }
    el.querySelectorAll("img").forEach((img) => {
      if (img.src && img.src.startsWith("blob:")) URL.revokeObjectURL(img.src);
    });
    el.remove();
  });
}

async function loadList(folder, node) {
  const fromCombo = comboValues(imageWidget(node));
  try {
    const res = await api.fetchApi(`/input_thumbs/list?${new URLSearchParams({ folder: folder || "" })}`);
    if (res.ok) {
      const data = await res.json();
      if (data && (data.files?.length || data.dirs?.length)) {
        return {
          folder: data.folder || folder || "",
          dirs: data.dirs || [],
          files: data.files || [],
        };
      }
    }
  } catch (_) {}
  const listed = filesInFolder(fromCombo, folder || "");
  return { folder: folder || "", dirs: listed.dirs, files: listed.files };
}

async function openModal(node) {
  injectStyles();
  closeModal();

  const overlay = document.createElement("div");
  overlay.className = "itg-overlay";
  overlay.innerHTML = `
    <div class="itg-panel">
      <div class="itg-head">
        <button type="button" data-act="up">↑ Folder</button>
        <button type="button" data-act="refresh">↻ Refresh</button>
        <input type="search" placeholder="Search images…" data-act="search" />
        <button type="button" data-act="close">Close</button>
      </div>
      <div class="itg-path">input/</div>
      <div class="itg-grid"></div>
    </div>
  `;
  document.body.appendChild(overlay);

  const grid = overlay.querySelector(".itg-grid");
  const pathEl = overlay.querySelector(".itg-path");
  const searchEl = overlay.querySelector("[data-act=search]");
  const upBtn = overlay.querySelector("[data-act=up]");
  const state = { folder: "", dirs: [], files: [] };

  function initObserver() {
    if (overlay._itgObserver) {
      overlay._itgObserver.disconnect();
      overlay._itgObserver = null;
    }
    if (window.IntersectionObserver) {
      overlay._itgObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              overlay._itgObserver.unobserve(entry.target);
              if (typeof entry.target._loadThumb === "function") {
                entry.target._loadThumb();
                delete entry.target._loadThumb;
              }
            }
          }
        },
        { root: grid, rootMargin: "200px" }
      );
    }
  }

  function render() {
    initObserver();
    const query = searchEl.value.trim().toLowerCase();
    pathEl.textContent = state.folder ? `input/${state.folder}` : "input/";
    upBtn.disabled = !state.folder;
    const dirs = state.dirs.filter((d) => d.name.toLowerCase().includes(query));
    const files = state.files.filter((f) => f.name.toLowerCase().includes(query));
    grid.innerHTML = "";
    if (!dirs.length && !files.length) {
      const empty = document.createElement("div");
      empty.className = "itg-empty";
      empty.textContent = "No images in this folder. Put files in ComfyUI/input and click Refresh.";
      grid.appendChild(empty);
      return;
    }

    for (const dir of dirs) {
      const card = document.createElement("div");
      card.className = "itg-card";
      const box = thumbBox();
      box.textContent = "📁";
      box.style.fontSize = "42px";
      const name = document.createElement("div");
      name.className = "itg-name";
      name.textContent = dir.name;
      card.append(box, name);
      card.addEventListener("click", () => refresh(dir.rel));
      grid.appendChild(card);
    }

    const current = imageWidget(node)?.value || "";
    for (const file of files) {
      const card = document.createElement("div");
      card.className = "itg-card" + (file.rel === current ? " is-selected" : "");
      const box = thumbBox();
      box.textContent = "…";
      box.style.color = "#666";
      const name = document.createElement("div");
      name.className = "itg-name";
      name.textContent = file.name;
      card.append(box, name);
      card.addEventListener("click", () => {
        setImageWidget(node, file.rel);
        closeModal();
      });
      grid.appendChild(card);

      const loadThumb = () => {
        blobUrlFor(file)
          .then((url) => {
            const img = document.createElement("img");
            img.alt = file.name;
            img.src = url;
            img.style.cssText = `width:100%;height:${THUMB}px;min-height:${THUMB}px;object-fit:cover;display:block;border:0;`;
            box.replaceChildren(img);
          })
          .catch((err) => {
            box.textContent = err.message || "no preview";
            box.style.color = "#c88";
            box.style.fontSize = "11px";
            box.style.padding = "8px";
          });
      };

      if (overlay._itgObserver) {
        card._loadThumb = loadThumb;
        overlay._itgObserver.observe(card);
      } else {
        loadThumb();
      }
    }
  }

  async function refresh(folder) {
    grid.innerHTML = `<div class="itg-empty">Loading…</div>`;
    const data = await loadList(folder, node);
    state.folder = data.folder;
    state.dirs = data.dirs;
    state.files = data.files;
    render();
  }

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeModal();
  });
  overlay.querySelector("[data-act=close]").addEventListener("click", closeModal);
  overlay.querySelector("[data-act=refresh]").addEventListener("click", () => refresh(state.folder));
  upBtn.addEventListener("click", () => {
    if (!state.folder) return;
    const parts = state.folder.split("/").filter(Boolean);
    parts.pop();
    refresh(parts.join("/"));
  });
  searchEl.addEventListener("input", render);

  const current = imageWidget(node)?.value || "";
  const initial = current.includes("/") ? current.split("/").slice(0, -1).join("/") : "";
  await refresh(initial);
}

function attachButton(node) {
  if (node._itgButton) return;
  node._itgButton = true;
  if (node.widgets?.some((w) => w.name === "browse_thumbnails")) return;
  node.addWidget("button", "browse_thumbnails", "Browse thumbnails", () => openModal(node));
}

app.registerExtension({
  name: "local.LoadImageGallery",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_CLASS) return;
    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      onNodeCreated?.apply(this, arguments);
      attachButton(this);
    };
  },
  async nodeCreated(node) {
    if (node.comfyClass === NODE_CLASS) attachButton(node);
  },
  async loadedGraphNode(node) {
    if (node.comfyClass === NODE_CLASS) attachButton(node);
  },
});
