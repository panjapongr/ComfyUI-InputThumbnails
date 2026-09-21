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
      flex-wrap: wrap;
    }
    .itg-head input, .itg-head button, .itg-head select {
      background: #111;
      color: #eee;
      border: 1px solid #555;
      border-radius: 4px;
      padding: 6px 10px;
      font-size: 13px;
    }
    .itg-toggle-label {
      display: flex;
      align-items: center;
      gap: 6px;
      cursor: pointer;
      font-size: 13px;
      color: #ddd;
      user-select: none;
      padding: 0 4px;
    }
    .itg-toggle-label input[type="checkbox"] {
      cursor: pointer;
      accent-color: #6ea8fe;
      margin: 0;
      width: 14px;
      height: 14px;
    }
    .itg-head select { cursor: pointer; }
    .itg-head select:focus { outline: none; border-color: #6ea8fe; }
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
    .itg-grid img {
      width: 100%;
      height: ${THUMB}px;
      min-height: ${THUMB}px;
      display: block;
      border: 0;
    }
    .itg-grid.fit-cover img { object-fit: cover !important; object-position: center !important; }
    .itg-grid.fit-contain img { object-fit: contain !important; object-position: center !important; }
    .itg-grid.fit-stretch img { object-fit: fill !important; }
    .itg-grid.fit-center img { object-fit: none !important; object-position: center !important; }
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
    .itg-foot {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 8px 12px;
      border-top: 1px solid #333;
      background: #181818;
      font-size: 12px;
      color: #bbb;
      flex-wrap: wrap;
    }
    .itg-foot-info {
      flex: 1 1 auto;
      min-width: 140px;
      white-space: nowrap;
    }
    .itg-foot-nav {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .itg-foot-nav button {
      background: #111;
      color: #eee;
      border: 1px solid #555;
      border-radius: 4px;
      padding: 4px 10px;
      font-size: 13px;
      cursor: pointer;
      min-width: 32px;
    }
    .itg-foot-nav button:hover:not(:disabled) {
      border-color: #888;
      background: #222;
    }
    .itg-foot-nav button:disabled {
      opacity: 0.35;
      cursor: not-allowed;
    }
    .itg-page-label {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 0 4px;
    }
    .itg-page-label input {
      width: 48px;
      background: #111;
      color: #eee;
      border: 1px solid #555;
      border-radius: 4px;
      padding: 3px 6px;
      font-size: 12px;
      text-align: center;
    }
    .itg-page-label input:focus {
      outline: none;
      border-color: #6ea8fe;
    }
    .itg-foot-size select {
      background: #111;
      color: #eee;
      border: 1px solid #555;
      border-radius: 4px;
      padding: 4px 8px;
      font-size: 12px;
      cursor: pointer;
    }
    .itg-foot-size select:focus {
      outline: none;
      border-color: #6ea8fe;
    }
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
        <select data-act="fit-style" title="Thumbnail Display Style">
          <option value="cover">Fill</option>
          <option value="contain">Fit</option>
          <option value="stretch">Stretch</option>
          <option value="center">Center</option>
        </select>
        <select data-act="sort-by" title="Sort Images">
          <option value="name_asc">Name (A–Z)</option>
          <option value="name_desc">Name (Z–A)</option>
          <option value="date_desc">Newest First</option>
          <option value="date_asc">Oldest First</option>
        </select>
        <label class="itg-toggle-label" title="Show or hide folder cards in the grid">
          <input type="checkbox" data-act="show-folders" checked /> Folders
        </label>
        <input type="search" placeholder="Search images…" data-act="search" maxlength="128" autocomplete="off" spellcheck="false" />
        <button type="button" data-act="close">Close</button>
      </div>
      <div class="itg-path">input/</div>
      <div class="itg-grid fit-cover"></div>
      <div class="itg-foot">
        <div class="itg-foot-info" data-el="foot-info"></div>
        <div class="itg-foot-nav">
          <button type="button" data-act="page-first" title="First Page">«</button>
          <button type="button" data-act="page-prev" title="Previous Page">‹</button>
          <span class="itg-page-label">Page <input type="number" data-act="page-input" min="1" value="1" /> of <span class="itg-page-total">1</span></span>
          <button type="button" data-act="page-next" title="Next Page">›</button>
          <button type="button" data-act="page-last" title="Last Page">»</button>
        </div>
        <div class="itg-foot-size">
          <select data-act="page-size" title="Items per page">
            <option value="60">60 / page</option>
            <option value="120">120 / page</option>
            <option value="240">240 / page</option>
            <option value="300">300 / page</option>
            <option value="600">600 / page</option>
          </select>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const grid = overlay.querySelector(".itg-grid");
  const pathEl = overlay.querySelector(".itg-path");
  const searchEl = overlay.querySelector("[data-act=search]");
  const upBtn = overlay.querySelector("[data-act=up]");
  const fitSelect = overlay.querySelector("[data-act=fit-style]");
  const sortSelect = overlay.querySelector("[data-act=sort-by]");
  const foldersCheckbox = overlay.querySelector("[data-act=show-folders]");
  const footInfo = overlay.querySelector("[data-el=foot-info]");
  const btnFirst = overlay.querySelector("[data-act=page-first]");
  const btnPrev = overlay.querySelector("[data-act=page-prev]");
  const btnNext = overlay.querySelector("[data-act=page-next]");
  const btnLast = overlay.querySelector("[data-act=page-last]");
  const pageInput = overlay.querySelector("[data-act=page-input]");
  const pageTotalEl = overlay.querySelector(".itg-page-total");
  const pageSizeSelect = overlay.querySelector("[data-act=page-size]");

  const state = {
    folder: "",
    dirs: [],
    files: [],
    page: 1,
    pageSize: 60,
    sortBy: "name_asc",
    showFolders: true,
  };

  function applyFitStyle(style) {
    grid.classList.remove("fit-cover", "fit-contain", "fit-stretch", "fit-center");
    if (style) grid.classList.add(`fit-${style}`);
  }

  function sanitizeSearchQuery(raw) {
    return String(raw || "")
      .slice(0, 128)
      .replace(/[\x00-\x1F\x7F]/g, "")
      .normalize("NFC")
      .trim()
      .toLowerCase();
  }

  api.fetchApi("/input_thumbs/settings")
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      if (data) {
        let needRender = false;
        if (data.fit_style) {
          fitSelect.value = data.fit_style;
          applyFitStyle(data.fit_style);
        }
        if (data.page_size && [60, 120, 240, 300, 600].includes(Number(data.page_size))) {
          state.pageSize = Number(data.page_size);
          pageSizeSelect.value = String(state.pageSize);
          needRender = true;
        }
        if (data.sort_by && ["name_asc", "name_desc", "date_desc", "date_asc"].includes(data.sort_by)) {
          state.sortBy = data.sort_by;
          sortSelect.value = data.sort_by;
          needRender = true;
        }
        if (typeof data.show_folders === "boolean") {
          state.showFolders = data.show_folders;
          foldersCheckbox.checked = data.show_folders;
          needRender = true;
        }
        if (needRender) render();
      }
    })
    .catch(() => {});

  fitSelect.addEventListener("change", () => {
    const style = fitSelect.value;
    applyFitStyle(style);
    api.fetchApi("/input_thumbs/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fit_style: style }),
    }).catch((err) => {
      console.warn("[InputThumbnails] Failed to save fit style:", err);
    });
  });

  sortSelect.addEventListener("change", () => {
    const val = sortSelect.value;
    state.sortBy = val;
    state.page = 1;
    render();
    grid.scrollTop = 0;
    api.fetchApi("/input_thumbs/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sort_by: val }),
    }).catch((err) => {
      console.warn("[InputThumbnails] Failed to save sort option:", err);
    });
  });

  foldersCheckbox.addEventListener("change", () => {
    const val = foldersCheckbox.checked;
    state.showFolders = val;
    render();
    api.fetchApi("/input_thumbs/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ show_folders: val }),
    }).catch((err) => {
      console.warn("[InputThumbnails] Failed to save folders toggle:", err);
    });
  });

  pageSizeSelect.addEventListener("change", () => {
    const val = parseInt(pageSizeSelect.value, 10);
    if ([60, 120, 240, 300, 600].includes(val)) {
      state.pageSize = val;
      state.page = 1;
      render();
      grid.scrollTop = 0;
      api.fetchApi("/input_thumbs/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ page_size: val }),
      }).catch((err) => {
        console.warn("[InputThumbnails] Failed to save page size:", err);
      });
    }
  });

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
    const query = sanitizeSearchQuery(searchEl.value);
    pathEl.textContent = state.folder ? `input/${state.folder}` : "input/";
    upBtn.disabled = !state.folder;

    // Search across ALL directories and files in this folder
    const dirs = state.dirs.filter((d) => d.name.toLowerCase().includes(query));
    let files = state.files.filter((f) => f.name.toLowerCase().includes(query));

    // Sort the entire filtered file set BEFORE pagination slicing
    if (state.sortBy === "name_desc") {
      files.sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true, sensitivity: "base" }));
    } else if (state.sortBy === "date_desc") {
      files.sort(
        (a, b) =>
          (b.mtime || 0) - (a.mtime || 0) ||
          a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })
      );
    } else if (state.sortBy === "date_asc") {
      files.sort(
        (a, b) =>
          (a.mtime || 0) - (b.mtime || 0) ||
          a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })
      );
    } else {
      // Default: name_asc
      files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
    }

    // Revoke previous blob URLs to prevent memory bloat
    grid.querySelectorAll("img").forEach((img) => {
      if (img.src && img.src.startsWith("blob:")) URL.revokeObjectURL(img.src);
    });
    grid.innerHTML = "";

    // Strict bounds calculations based on image files
    const total = files.length;
    const totalPages = Math.max(1, Math.ceil(total / state.pageSize));
    state.page = Math.min(Math.max(1, state.page || 1), totalPages);

    const startIdx = (state.page - 1) * state.pageSize;
    const endIdx = Math.min(startIdx + state.pageSize, total);
    const pagedFiles = files.slice(startIdx, endIdx);

    // Update pagination footer controls
    pageInput.value = String(state.page);
    pageInput.max = String(totalPages);
    pageTotalEl.textContent = String(totalPages);

    btnFirst.disabled = state.page <= 1;
    btnPrev.disabled = state.page <= 1;
    btnNext.disabled = state.page >= totalPages;
    btnLast.disabled = state.page >= totalPages;

    if (total === 0) {
      footInfo.textContent = query ? "No matching images" : "0 images";
    } else {
      const rangeStr = `${startIdx + 1}–${endIdx}`;
      footInfo.textContent = query
        ? `Showing ${rangeStr} of ${total} match${total === 1 ? "" : "es"} (${state.files.length} total)`
        : `Showing ${rangeStr} of ${total} images`;
    }

    const visibleDirsCount = state.page === 1 && state.showFolders ? dirs.length : 0;
    if (!visibleDirsCount && !pagedFiles.length) {
      const empty = document.createElement("div");
      empty.className = "itg-empty";
      empty.textContent = query
        ? "No files matching your search."
        : "No images in this folder. Put files in ComfyUI/input and click Refresh.";
      grid.appendChild(empty);
      return;
    }

    // Folders appear on Page 1 at the top of the grid when enabled
    if (state.page === 1 && state.showFolders) {
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
        card.addEventListener("click", () => {
          state.page = 1;
          refresh(dir.rel);
        });
        grid.appendChild(card);
      }
    }

    const current = imageWidget(node)?.value || "";
    for (const file of pagedFiles) {
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

  btnFirst.addEventListener("click", () => {
    if (state.page > 1) {
      state.page = 1;
      render();
      grid.scrollTop = 0;
    }
  });

  btnPrev.addEventListener("click", () => {
    if (state.page > 1) {
      state.page--;
      render();
      grid.scrollTop = 0;
    }
  });

  btnNext.addEventListener("click", () => {
    const query = sanitizeSearchQuery(searchEl.value);
    const total = state.files.filter((f) => f.name.toLowerCase().includes(query)).length;
    const totalPages = Math.max(1, Math.ceil(total / state.pageSize));
    if (state.page < totalPages) {
      state.page++;
      render();
      grid.scrollTop = 0;
    }
  });

  btnLast.addEventListener("click", () => {
    const query = sanitizeSearchQuery(searchEl.value);
    const total = state.files.filter((f) => f.name.toLowerCase().includes(query)).length;
    const totalPages = Math.max(1, Math.ceil(total / state.pageSize));
    if (state.page < totalPages) {
      state.page = totalPages;
      render();
      grid.scrollTop = 0;
    }
  });

  function jumpToPage() {
    const query = sanitizeSearchQuery(searchEl.value);
    const total = state.files.filter((f) => f.name.toLowerCase().includes(query)).length;
    const totalPages = Math.max(1, Math.ceil(total / state.pageSize));
    let target = parseInt(pageInput.value, 10);
    if (isNaN(target) || target < 1) target = 1;
    if (target > totalPages) target = totalPages;
    state.page = target;
    render();
    grid.scrollTop = 0;
  }

  pageInput.addEventListener("change", jumpToPage);
  pageInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      jumpToPage();
    }
  });

  async function refresh(folder) {
    grid.innerHTML = `<div class="itg-empty">Loading…</div>`;
    const data = await loadList(folder, node);
    state.folder = data.folder;
    state.dirs = data.dirs;
    state.files = data.files;
    state.page = 1;
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
    state.page = 1;
    refresh(parts.join("/"));
  });
  searchEl.addEventListener("input", () => {
    state.page = 1;
    render();
  });

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
