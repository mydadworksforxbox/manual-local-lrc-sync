(() => {
  "use strict";

  const ADDON_ID = "manual-local-lrc-sync";
  const ADDON_NAME = "Manual Local LRC Sync";
  const STORAGE_PREFIX = "ivLyrics:manual-local-lrc-sync:";
  const TYPE_ROW_ID = "ivmlrc-type-row";
  const SYNC_ROW_ID = "ivmlrc-sync-row";
  const PANEL_ID = "ivmlrc-inline-panel";
  const STYLE_ID = "ivmlrc-inline-style";

  window.__ivmlrcInline?.destroy?.();

  const runtime = {
    observer: null
  };

  window.__ivmlrcInline = {
    destroy() {
      runtime.observer?.disconnect?.();
      document.getElementById(TYPE_ROW_ID)?.remove();
      document.getElementById(SYNC_ROW_ID)?.remove();
      document.getElementById(PANEL_ID)?.remove();
      document.getElementById(STYLE_ID)?.remove();
    }
  };

  function waitForReady(fn) {
    if (window.Spicetify?.Player && window.Spicetify?.LocalStorage && window.LyricsAddonManager) {
      fn();
    } else {
      setTimeout(() => waitForReady(fn), 300);
    }
  }

  function getTrack() {
    const item = Spicetify.Player?.data?.item || {};
    const meta = item.metadata || {};
    const artists = item.artists || meta.artists || [];

    return {
      uri: item.uri || meta.uri || "",
      id: String(item.uri || meta.uri || "").split(":").pop() || "",
      title: item.name || meta.title || meta.name || "",
      artist: Array.isArray(artists)
        ? artists.map(a => a.name || a).join(", ")
        : String(meta.artist_name || meta.artist || ""),
      album: item.album?.name || meta.album_title || meta.album || "",
      durationMs: Number(item.duration?.milliseconds || item.duration_ms || meta.duration || meta.duration_ms || 0)
    };
  }

  function storageKey(track = getTrack()) {
    return STORAGE_PREFIX + encodeURIComponent(track.uri || "unknown");
  }

  function getProgressMs() {
    return Spicetify.Player?.getProgress?.() ?? 0;
  }

  function seekTo(ms) {
    ms = Math.max(0, Number(ms) || 0);

    if (typeof Spicetify.Player.seek === "function") {
      Spicetify.Player.seek(ms);
    } else if (typeof Spicetify.Player.seekTo === "function") {
      Spicetify.Player.seekTo(ms);
    }
  }

  function seekBy(ms) {
    seekTo(getProgressMs() + ms);
  }

  function togglePlay() {
    Spicetify.Player?.togglePlay?.();
  }

  function timestamp(ms) {
    const cs = Math.floor(Math.max(0, Number(ms) || 0) / 10);
    const min = Math.floor(cs / 6000);
    const sec = Math.floor((cs % 6000) / 100);
    const centi = cs % 100;

    return `[${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}.${String(centi).padStart(2, "0")}]`;
  }

  function parseTimestamp(raw) {
    const m = String(raw || "").match(/\[(\d{1,3}):(\d{2})(?:[.,](\d{1,3}))?\]/);
    if (!m) return null;

    const min = Number(m[1]);
    const sec = Number(m[2]);
    const frac = m[3] || "0";

    let ms = 0;
    if (frac.length === 1) ms = Number(frac) * 100;
    else if (frac.length === 2) ms = Number(frac) * 10;
    else ms = Number(frac.slice(0, 3));

    return min * 60000 + sec * 1000 + ms;
  }

  function stripTimestamp(line) {
    return String(line || "")
      .replace(/^\s*(\[\d{1,3}:\d{2}(?:[.,]\d{1,3})?\]\s*)+/, "")
      .trim();
  }

  function splitLyrics(text) {
    return String(text || "")
      .split(/\r?\n/)
      .map(stripTimestamp)
      .filter(Boolean);
  }

  function parseLrc(text) {
    const synced = [];
    const unsynced = [];

    for (const raw of String(text || "").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;

      const clean = stripTimestamp(line);
      if (!clean) continue;

      unsynced.push({ text: clean });

      const t = line.match(/\[\d{1,3}:\d{2}(?:[.,]\d{1,3})?\]/);
      if (t) {
        synced.push({
          startTime: parseTimestamp(t[0]) ?? 0,
          text: clean
        });
      }
    }

    return {
      synced: synced.length ? synced : null,
      unsynced: unsynced.length ? unsynced : null
    };
  }

  function buildLrc(lines, timings) {
    return lines
      .map((line, i) => {
        const clean = stripTimestamp(line);
        if (!clean) return null;

        return typeof timings[i] === "number"
          ? `${timestamp(timings[i])} ${clean}`
          : clean;
      })
      .filter(Boolean)
      .join("\n");
  }

  function saveLyrics(track, lrc) {
    const parsed = parseLrc(lrc);

    const payload = {
      provider: ADDON_ID,
      uri: track.uri,
      title: track.title,
      artist: track.artist,
      album: track.album,
      durationMs: track.durationMs,
      lrc,
      synced: parsed.synced,
      unsynced: parsed.unsynced,
      savedAt: Date.now()
    };

    Spicetify.LocalStorage.set(storageKey(track), JSON.stringify(payload));
    return payload;
  }

  function loadSavedLyrics(track = getTrack()) {
    const raw = Spicetify.LocalStorage.get(storageKey(track));
    if (!raw) return null;

    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function looksLikeLyrics(text) {
    return String(text || "").split(/\r?\n/).filter(x => x.trim()).length >= 2;
  }

  function normalize(x) {
    return String(x || "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  }

  function findImportedLyricsForCurrentTrack(track = getTrack()) {
    const candidates = [];

    const uri = String(track.uri || "").toLowerCase();
    const id = String(track.id || "").toLowerCase();
    const title = normalize(track.title);
    const artist = normalize(track.artist);

    function add(text, key, score) {
      if (!looksLikeLyrics(text)) return;
      candidates.push({ text, key, score });
    }

    function extractFromJson(obj) {
      const found = [];

      function walk(value, depth = 0) {
        if (depth > 6 || value == null) return;

        if (typeof value === "string") {
          if (looksLikeLyrics(value)) found.push(value);
          return;
        }

        if (Array.isArray(value)) {
          const lines = value
            .map(x => {
              if (typeof x === "string") return x;
              if (x && typeof x.text === "string") return x.text;
              if (x && typeof x.lyric === "string") return x.lyric;
              if (x && typeof x.words === "string") return x.words;
              return "";
            })
            .filter(Boolean);

          if (lines.length >= 2) found.push(lines.join("\n"));
          value.forEach(x => walk(x, depth + 1));
          return;
        }

        if (typeof value === "object") {
          for (const [k, v] of Object.entries(value)) {
            if (/lyrics|lyric|lrc|synced|unsynced|lines|local/i.test(k) || typeof v === "object") {
              walk(v, depth + 1);
            }
          }
        }
      }

      walk(obj);
      return found;
    }

    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !/ivlyrics|lyrics|lyric|lrc|local/i.test(key)) continue;

      const raw = localStorage.getItem(key);
      if (!raw) continue;

      const keyLower = key.toLowerCase();
      const rawLower = raw.toLowerCase();
      const haystack = normalize(`${key} ${raw}`);

      let score = 0;

      if (uri && (keyLower.includes(uri) || rawLower.includes(uri))) score += 120;
      if (id && (keyLower.includes(id) || rawLower.includes(id))) score += 90;
      if (title && haystack.includes(title)) score += 35;
      if (artist && haystack.includes(artist)) score += 35;

      if (score < 70) continue;

      try {
        const parsed = JSON.parse(raw);
        for (const text of extractFromJson(parsed)) {
          add(text, key, score);
        }
      } catch {
        add(raw, key, score);
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates[0]?.text || "";
  }

  function refreshLyrics() {
    try {
      const item = Spicetify.Player?.data?.item;

      window.LyricsAddonManager?.setProviderEnabled?.(ADDON_ID, true);

      const order = window.LyricsAddonManager?.getProviderOrder?.() || [];
      if (Array.isArray(order)) {
        window.LyricsAddonManager?.setProviderOrder?.([
          ADDON_ID,
          ...order.filter(id => id !== ADDON_ID)
        ]);
      }

      if (window.lyricContainer?.fetchLyrics && item) {
        window.lyricContainer.fetchLyrics(item, -1, true);
      }
    } catch (e) {
      console.warn("[Manual LRC Sync] refresh failed", e);
    }
  }

  function html(x) {
    return String(x || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function findLocalLyricsPanel() {
    return [...document.querySelectorAll("div, section, aside, [role='dialog']")].find(el => {
      const text = el.textContent || "";
      return (
        text.includes("Local Lyrics") &&
        text.includes("Import LRC File") &&
        text.includes("Search LRCLIB")
      );
    });
  }

  function getRowsContainer(panel) {
    const rows = [...panel.querySelectorAll("div")];

    const importRow = rows.find(row => {
      const text = row.textContent || "";
      return text.includes("Import LRC File") && !text.includes("Search LRCLIB");
    });

    return importRow?.parentElement || panel;
  }

  function createOfficialLikeRow({ id, icon, title, subtitle, buttonText, onClick }) {
    const row = document.createElement("div");
    row.id = id;
    row.className = "ivmlrc-official-row";
    row.innerHTML = `
      <div class="ivmlrc-row-left">
        <span class="ivmlrc-row-icon">${icon}</span>
        <div>
          <div class="ivmlrc-row-title">${title}</div>
          <div class="ivmlrc-row-subtitle">${subtitle}</div>
        </div>
      </div>
      <button class="ivmlrc-row-button">${buttonText}</button>
    `;

    row.querySelector("button").onclick = e => {
      e.preventDefault();
      e.stopPropagation();
      onClick();
    };

    row.onclick = e => {
      if (e.target.tagName === "BUTTON") return;
      onClick();
    };

    return row;
  }

  function injectRows() {
    document.querySelectorAll("#ivlse-edit-sync-button, #ivlse-v2-edit-sync-button, #ivmlrc-edit-sync").forEach(x => x.remove());

    const panel = findLocalLyricsPanel();
    if (!panel) return;

    const container = getRowsContainer(panel);

    if (!panel.querySelector(`#${TYPE_ROW_ID}`)) {
      const typeRow = createOfficialLikeRow({
        id: TYPE_ROW_ID,
        icon: "✎",
        title: "Type / Edit Lyrics",
        subtitle: "Paste, type, or fix lyrics for this song",
        buttonText: "Edit",
        onClick: () => openInlineEditor("edit")
      });

      const importRow = [...container.children].find(child => (child.textContent || "").includes("Import LRC File"));
      if (importRow?.nextSibling) {
        container.insertBefore(typeRow, importRow.nextSibling);
      } else {
        container.appendChild(typeRow);
      }
    }

    if (!panel.querySelector(`#${SYNC_ROW_ID}`)) {
      const syncRow = createOfficialLikeRow({
        id: SYNC_ROW_ID,
        icon: "⏱",
        title: "Edit Sync",
        subtitle: "Manually timestamp this song’s local lyrics",
        buttonText: "Sync",
        onClick: () => openInlineEditor("sync")
      });

      const typeRow = panel.querySelector(`#${TYPE_ROW_ID}`);
      if (typeRow?.nextSibling) {
        container.insertBefore(syncRow, typeRow.nextSibling);
      } else {
        container.appendChild(syncRow);
      }
    }
  }

  async function openInlineEditor(mode = "edit") {
    const panel = findLocalLyricsPanel();
    if (!panel) return;

    document.getElementById(PANEL_ID)?.remove();

    const track = getTrack();
    const saved = loadSavedLyrics(track);
    const imported = saved?.lrc ? "" : await findImportedLyricsForCurrentTrack(track);
    const initial = saved?.lrc || imported || "";

    const editor = document.createElement("div");
    editor.id = PANEL_ID;
    editor.innerHTML = `
      <div class="ivmlrc-editor-header">
        <div>
          <div class="ivmlrc-editor-title">${mode === "sync" ? "Manual Sync Editor" : "Type / Edit Lyrics"}</div>
          <div class="ivmlrc-editor-subtitle">${html(track.title || "Unknown track")} — ${html(track.artist || "Unknown artist")}</div>
        </div>
        <button class="ivmlrc-editor-close">Close</button>
      </div>

        <div class="ivmlrc-editor-help">
        ${mode === "sync"
            ? "Use <b>Start Sync</b>, then press <b>Space</b> or <b>Tap Line</b> when each line starts. To change lyric text, use <b>Type / Edit Lyrics</b>."
            : "Type, paste, or correct the lyrics here. Click <b>Save Lyrics Text</b> to keep them locally for this exact song. You can sync them after."}
        </div>

        ${mode === "edit" ? `
        <textarea class="ivmlrc-input" spellcheck="false" placeholder="Type or paste lyrics here..."></textarea>

        <div class="ivmlrc-controls">
            <button class="ivmlrc-save-text">Save Lyrics Text</button>
            <button class="ivmlrc-clear">Clear Saved Lyrics</button>
            <button class="ivmlrc-copy">Copy LRC/Text</button>
        </div>
        ` : ""}

      <div class="ivmlrc-sync-area">
        <div class="ivmlrc-controls">
          <button class="ivmlrc-restart">Restart</button>
          <button class="ivmlrc-back5">-5s</button>
          <button class="ivmlrc-play">Play/Pause</button>
          <button class="ivmlrc-forward5">+5s</button>
        </div>

        <div class="ivmlrc-controls">
          <button class="ivmlrc-start">Start Sync</button>
          <button class="ivmlrc-tap primary" disabled>Tap Line</button>
          <button class="ivmlrc-undo" disabled>Undo Timing</button>
          <button class="ivmlrc-save-sync" disabled>Save Synced Lyrics</button>
        </div>

        <div class="ivmlrc-lines"></div>
      </div>

      <div class="ivmlrc-status"></div>
    `;

    const insertAfter = mode === "sync"
      ? panel.querySelector(`#${SYNC_ROW_ID}`)
      : panel.querySelector(`#${TYPE_ROW_ID}`);

    insertAfter?.insertAdjacentElement("afterend", editor);

    const input = editor.querySelector(".ivmlrc-input");
    const status = editor.querySelector(".ivmlrc-status");
    const linesBox = editor.querySelector(".ivmlrc-lines");

    const saveTextBtn = editor.querySelector(".ivmlrc-save-text");
    const clearBtn = editor.querySelector(".ivmlrc-clear");
    const copyBtn = editor.querySelector(".ivmlrc-copy");

    const startBtn = editor.querySelector(".ivmlrc-start");
    const tapBtn = editor.querySelector(".ivmlrc-tap");
    const undoBtn = editor.querySelector(".ivmlrc-undo");
    const saveSyncBtn = editor.querySelector(".ivmlrc-save-sync");

    if (input) input.value = initial;

    let lines = [];
    let timings = [];
    let currentIndex = 0;
    let syncing = false;

    function setStatus(text) {
      status.textContent = text;
    }

    function render() {
      linesBox.innerHTML = "";

      lines.forEach((line, i) => {
        const row = document.createElement("div");
        row.className = "ivmlrc-line";

        if (i < currentIndex) row.classList.add("done");
        if (i === currentIndex && syncing) row.classList.add("active");

        row.innerHTML = `
          <span class="ivmlrc-time">${typeof timings[i] === "number" ? timestamp(timings[i]) : "--:--.--"}</span>
          <span class="ivmlrc-text">${html(line)}</span>
        `;

        row.onclick = () => {
          currentIndex = i;
          syncing = true;
          tapBtn.disabled = false;
          undoBtn.disabled = !timings.some(x => typeof x === "number");
          saveSyncBtn.disabled = false;
          render();
          setStatus(`Selected line ${i + 1}/${lines.length}.`);
        };

        linesBox.appendChild(row);
      });
    }

    function getCurrentTextForEditor() {
      if (mode === "edit") return input?.value || "";
      return initial || "";
    }

    function applyTextChanges({ preserveExistingTimings = true } = {}) {
    const oldLines = lines.slice();
    const oldTimings = timings.slice();

    const sourceText = getCurrentTextForEditor();
    const nextLines = splitLyrics(sourceText);
    const parsed = parseLrc(sourceText);

    lines = nextLines;

    if (parsed.synced && parsed.synced.length === lines.length) {
        timings = parsed.synced.map(x => x.startTime);
    } else if (preserveExistingTimings && oldLines.length) {
        timings = lines.map((line, i) => {
        const oldIndex = oldLines.findIndex(old => old === line);
        if (oldIndex !== -1 && typeof oldTimings[oldIndex] === "number") return oldTimings[oldIndex];
        if (typeof oldTimings[i] === "number") return oldTimings[i];
        return undefined;
        });
    } else {
        timings = [];
    }

    currentIndex = Math.min(currentIndex, Math.max(0, lines.length - 1));
    syncing = false;
    tapBtn.disabled = true;
    undoBtn.disabled = !timings.some(x => typeof x === "number");
    saveSyncBtn.disabled = false;

    render();

    if (!lines.length) {
        setStatus("No lyrics loaded. Use Type / Edit Lyrics or import lyrics first, then reopen Sync.");
    } else {
        setStatus(`Loaded ${lines.length} lines for syncing.`);
    }
    }

    function saveTextOnly() {
      const plainText = splitLyrics(input?.value || "").join("\n");

      if (!plainText.trim()) {
        setStatus("Nothing to save. Type or paste lyrics first.");
        return;
      }

      if (input) input.value = plainText;
      const payload = saveLyrics(track, plainText);
      refreshLyrics();

      lines = splitLyrics(plainText);
      timings = [];
      currentIndex = 0;
      syncing = false;

      tapBtn.disabled = true;
      undoBtn.disabled = true;
      saveSyncBtn.disabled = false;

      render();
      setStatus(`Saved lyrics text locally for this song. Lines: ${payload.unsynced?.length || 0}.`);
    }

    function startSync() {
      applyTextChanges({ preserveExistingTimings: true });

      if (!lines.length) {
        syncing = false;
        tapBtn.disabled = true;
        undoBtn.disabled = true;
        saveSyncBtn.disabled = true;
        setStatus("No lyrics loaded. Use Type / Edit Lyrics first, or import lyrics and reopen Sync.");
        return;
      }

      currentIndex = 0;
      syncing = true;

      tapBtn.disabled = false;
      undoBtn.disabled = !timings.some(x => typeof x === "number");
      saveSyncBtn.disabled = false;

      render();
      setStatus(`Ready. Tap line 1/${lines.length}.`);
    }

    function tapLine() {
      if (!syncing || currentIndex >= lines.length) return;

      timings[currentIndex] = getProgressMs();
      currentIndex++;

      if (currentIndex >= lines.length) {
        syncing = false;
        tapBtn.disabled = true;
        setStatus("Done. Click Save Synced Lyrics.");
      } else {
        setStatus(`Next line ${currentIndex + 1}/${lines.length}.`);
      }

      undoBtn.disabled = false;
      saveSyncBtn.disabled = false;
      render();
    }

    function undoTiming() {
      if (!lines.length) return;

      if (currentIndex < lines.length && typeof timings[currentIndex] === "number") {
        delete timings[currentIndex];
        syncing = true;
        tapBtn.disabled = false;
        setStatus(`Removed timing from line ${currentIndex + 1}/${lines.length}.`);
      } else if (currentIndex > 0) {
        currentIndex--;
        delete timings[currentIndex];
        syncing = true;
        tapBtn.disabled = false;
        setStatus(`Removed timing from line ${currentIndex + 1}/${lines.length}.`);
      } else {
        delete timings[0];
        currentIndex = 0;
        syncing = true;
        tapBtn.disabled = false;
        setStatus("Removed timing from line 1.");
      }

      undoBtn.disabled = !timings.some(x => typeof x === "number");
      saveSyncBtn.disabled = false;
      render();
    }

    function saveSync() {
      applyTextChanges({ preserveExistingTimings: true });

      const lrc = buildLrc(lines, timings);
      if (input) input.value = lrc;

      const payload = saveLyrics(track, lrc);
      refreshLyrics();

      saveSyncBtn.disabled = true;
      setStatus(`Saved synced lyrics locally for this song. Synced lines: ${payload.synced?.length || 0}.`);
    }

    function clearSaved() {
      Spicetify.LocalStorage.remove(storageKey(track));

      if (input) input.value = "";
      lines = [];
      timings = [];
      currentIndex = 0;
      syncing = false;

      tapBtn.disabled = true;
      undoBtn.disabled = true;
      saveSyncBtn.disabled = true;

      render();
      refreshLyrics();
      setStatus("Cleared saved local lyrics for this song.");
    }

    function copy() {
    const sourceText = input?.value || initial || "";
    const text = buildLrc(lines.length ? lines : splitLyrics(sourceText), timings);
    navigator.clipboard?.writeText(text || sourceText);
      setStatus("Copied.");
    }

    if (saveTextBtn) {
    saveTextBtn.onclick = () => {
        applyTextChanges({ preserveExistingTimings: true });
        saveTextOnly();
    };
    }

    if (clearBtn) clearBtn.onclick = clearSaved;
    if (copyBtn) copyBtn.onclick = copy;

    startBtn.onclick = startSync;
    tapBtn.onclick = tapLine;
    undoBtn.onclick = undoTiming;
    saveSyncBtn.onclick = saveSync;

    editor.querySelector(".ivmlrc-restart").onclick = () => seekTo(0);
    editor.querySelector(".ivmlrc-back5").onclick = () => seekBy(-5000);
    editor.querySelector(".ivmlrc-play").onclick = togglePlay;
    editor.querySelector(".ivmlrc-forward5").onclick = () => seekBy(5000);
    editor.querySelector(".ivmlrc-editor-close").onclick = () => editor.remove();

    editor.addEventListener("keydown", e => {
      const typing = e.target === input;

      if (e.code === "Space" && !typing) {
        e.preventDefault();
        tapLine();
      }

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !typing) {
        e.preventDefault();
        undoTiming();
      }

      if (e.key === "ArrowLeft" && !typing) {
        e.preventDefault();
        seekBy(-5000);
      }

      if (e.key === "ArrowRight" && !typing) {
        e.preventDefault();
        seekBy(5000);
      }
    });

    if (input) {
    input.addEventListener("input", () => {
        saveSyncBtn.disabled = false;
        if (saveTextBtn) saveTextBtn.disabled = false;
        setStatus("Unsaved lyric edits. Click Save Lyrics Text.");
    });
    }

    editor.tabIndex = -1;
    editor.focus();

    if (saved?.lrc) {
    setStatus("Loaded saved lyrics for this song.");
    } else if (imported) {
    setStatus("Loaded imported lyrics for this song.");
    } else if (mode === "sync") {
    setStatus("No lyrics found for syncing. Use Type / Edit Lyrics first, or import lyrics and reopen this menu.");
    } else {
    setStatus("No imported lyrics found. Type or paste lyrics here, then save.");
    }

    applyTextChanges({ preserveExistingTimings: false });

    if (mode === "edit") {
      editor.querySelector(".ivmlrc-sync-area").classList.add("collapsed");
    }
  }

  function registerProvider() {
    if (window.LyricsAddonManager.getAddon?.(ADDON_ID)) return;

    window.LyricsAddonManager.register({
      id: ADDON_ID,
      name: ADDON_NAME,
      author: "local",
      description: "Manual local-only lyrics and synced lyrics saved per track.",
      version: "1.0.0",
      supports: {
        karaoke: false,
        synced: true,
        unsynced: true
      },
      async getLyrics(info) {
        const current = getTrack();
        const track = {
          ...current,
          ...info,
          uri: info?.uri || current.uri
        };

        const payload = loadSavedLyrics(track);

        if (!payload?.lrc) {
          return {
            provider: ADDON_ID,
            error: "No manually saved local lyrics for this track."
          };
        }

        const parsed = parseLrc(payload.lrc);

        return {
          provider: ADDON_ID,
          synced: parsed.synced,
          unsynced: parsed.unsynced,
          karaoke: null,
          skipCache: true
        };
      }
    });

    window.LyricsAddonManager.setProviderEnabled?.(ADDON_ID, true);

    const order = window.LyricsAddonManager.getProviderOrder?.() || [];
    if (Array.isArray(order)) {
      window.LyricsAddonManager.setProviderOrder?.([
        ADDON_ID,
        ...order.filter(id => id !== ADDON_ID)
      ]);
    }
  }

  function injectCss() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${TYPE_ROW_ID},
      #${SYNC_ROW_ID} {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        min-height: 58px;
        padding: 12px 14px;
        border-top: 1px solid rgba(255,255,255,.09);
        background: rgba(255,255,255,.015);
        cursor: pointer;
      }

      #${TYPE_ROW_ID}:hover,
      #${SYNC_ROW_ID}:hover {
        background: rgba(255,255,255,.045);
      }

      .ivmlrc-row-left {
        display: flex;
        align-items: center;
        gap: 12px;
        min-width: 0;
      }

      .ivmlrc-row-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 20px;
        height: 20px;
        border: 1px solid rgba(255,255,255,.16);
        color: rgba(255,255,255,.72);
        font-size: 12px;
      }

      .ivmlrc-row-title {
        color: rgba(255,255,255,.92);
        font-weight: 600;
        font-size: 13px;
        line-height: 1.25;
      }

      .ivmlrc-row-subtitle {
        color: rgba(255,255,255,.50);
        font-size: 11.5px;
        font-weight: 400;
        margin-top: 3px;
      }

      .ivmlrc-row-button {
        border: 1px solid rgba(255,255,255,.18);
        background: rgba(255,255,255,.035);
        color: rgba(255,255,255,.92);
        padding: 8px 14px;
        font-weight: 600;
        font-size: 12px;
        cursor: pointer;
      }

      .ivmlrc-row-button:hover {
        background: rgba(255,255,255,.075);
      }

      #${PANEL_ID} {
        border-top: 1px solid rgba(255,255,255,.10);
        background: rgba(0,0,0,.16);
        padding: 16px 14px;
      }

      #${PANEL_ID} .ivmlrc-editor-header {
        display: flex;
        justify-content: space-between;
        gap: 16px;
        align-items: flex-start;
        margin-bottom: 10px;
      }

      #${PANEL_ID} .ivmlrc-editor-title {
        color: rgba(255,255,255,.94);
        font-size: 15px;
        font-weight: 650;
      }

      #${PANEL_ID} .ivmlrc-editor-subtitle,
      #${PANEL_ID} .ivmlrc-editor-help,
      #${PANEL_ID} .ivmlrc-status {
        color: rgba(255,255,255,.62);
        font-size: 12px;
        line-height: 1.45;
      }

      #${PANEL_ID} .ivmlrc-editor-help {
        margin-bottom: 10px;
      }

      #${PANEL_ID} button {
        border: 1px solid rgba(255,255,255,.17);
        background: rgba(255,255,255,.035);
        color: rgba(255,255,255,.92);
        padding: 8px 12px;
        font-weight: 600;
        font-size: 12px;
        cursor: pointer;
      }

      #${PANEL_ID} button:hover {
        background: rgba(255,255,255,.075);
      }

      #${PANEL_ID} button:disabled {
        opacity: .45;
        cursor: not-allowed;
      }

      #${PANEL_ID} .primary {
        background: #1db954;
        border-color: #1db954;
        color: #000;
      }

      #${PANEL_ID} .ivmlrc-save-sync,
      #${PANEL_ID} .ivmlrc-save-text {
        background: #fff;
        color: #000;
      }

      #${PANEL_ID} .ivmlrc-input {
        width: 100%;
        min-height: 155px;
        box-sizing: border-box;
        resize: vertical;
        background: #050505;
        color: #fff;
        border: 1px solid rgba(255,255,255,.14);
        padding: 10px;
        font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
        font-size: 12px;
        line-height: 1.45;
        outline: none;
      }

      #${PANEL_ID} .ivmlrc-controls {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin: 10px 0;
      }

      #${PANEL_ID} .ivmlrc-lines {
        display: flex;
        flex-direction: column;
        gap: 4px;
        max-height: 230px;
        overflow: auto;
        margin-top: 10px;
      }

      #${PANEL_ID} .ivmlrc-line {
        display: grid;
        grid-template-columns: 88px 1fr;
        gap: 10px;
        padding: 8px 10px;
        background: rgba(255,255,255,.045);
        border: 1px solid transparent;
        cursor: pointer;
      }

      #${PANEL_ID} .ivmlrc-line:hover {
        background: rgba(255,255,255,.07);
      }

      #${PANEL_ID} .ivmlrc-line.active {
        background: rgba(30, 215, 96, .16);
        border-color: rgba(30, 215, 96, .50);
      }

      #${PANEL_ID} .ivmlrc-time {
        font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
        color: #1ed760;
      }

      #${PANEL_ID} .collapsed {
        display: none;
      }
    `;

    document.head.appendChild(style);
  }

  waitForReady(() => {
    injectCss();
    registerProvider();
    injectRows();

    runtime.observer = new MutationObserver(injectRows);
    runtime.observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    console.log("[Manual Local LRC Sync] ready");
  });
})();