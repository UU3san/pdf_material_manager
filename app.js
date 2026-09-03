(() => {
  const { PDFDocument, degrees } = PDFLib;

  if (window.pdfjsLib) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc =
      "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js";
  }

  const DEFAULTS = {
    year: ["2026年度","2025年度","2024年度","2023年度","2022年度","2021年度","2020年度","2019年度","2018年度","不明"],
    grade: ["小1","小2","小3","小4","小5","小6","中1","中2","中3","高1","高2","高3","その他"],
    subject: ["国語","算数","数学","英語","理科","社会","その他"],
    testName: ["中間テスト","期末テスト","学年末テスト","実力テスト","模試","小テスト","課題テスト","確認テスト","その他"],
    term: ["1学期","2学期","3学期","前期","後期","通年","不明"],
    answer: ["あり","なし","問題・解答一体","不明"]
  };

  const labels = {
    year: "年度", grade: "学年", subject: "科目",
    testName: "テスト名", term: "学期", answer: "解答"
  };

  let settings = loadSettings();
  let editSettings = structuredClone(settings);
  let files = [];
  let outputDirectoryHandle = null;
  let analysisQueue = Promise.resolve();
  let osdWorkerPromise = null;
  let analysisRunning = false;
  let currentDocumentId = null;
  let editingExistingManagedPdf = false;

  const $ = (id) => document.getElementById(id);
  const selectors = ["year","grade","subject","testName","term","answer"];

  function loadSettings() {
    try {
      const raw = localStorage.getItem("pdfMaterialManagerSettings");
      if (!raw) return structuredClone(DEFAULTS);
      const parsed = JSON.parse(raw);
      for (const k of Object.keys(DEFAULTS)) {
        if (!Array.isArray(parsed[k]) || parsed[k].length === 0) parsed[k] = [...DEFAULTS[k]];
      }
      return parsed;
    } catch {
      return structuredClone(DEFAULTS);
    }
  }

  function saveLocalSettings() {
    localStorage.setItem("pdfMaterialManagerSettings", JSON.stringify(settings));
  }

  function ensureSelectValue(key, value) {
    if (!value) return;
    if (!settings[key].includes(value)) {
      settings[key].push(value);
      saveLocalSettings();
    }
  }

  function populateSelects(preserveCurrent = true) {
    selectors.forEach(key => {
      const sel = $(key);
      const current = preserveCurrent ? sel.value : "";

      sel.innerHTML = "";

      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = "— 未選択 —";
      sel.appendChild(placeholder);

      settings[key].forEach(v => {
        const opt = document.createElement("option");
        opt.value = v;
        opt.textContent = v;
        sel.appendChild(opt);
      });

      if (!settings[key].includes("混在")) {
        const mixed = document.createElement("option");
        mixed.value = "混在";
        mixed.textContent = "混在";
        sel.appendChild(mixed);
      }

      if (current && Array.from(sel.options).some(o => o.value === current)) {
        sel.value = current;
      } else {
        sel.value = "";
      }
    });
    updateFilenamePreview();
  }

  function humanSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024*1024) return `${(bytes/1024).toFixed(1)} KB`;
    return `${(bytes/1024/1024).toFixed(1)} MB`;
  }

  function typeLabel(file) {
    if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) return "PDF";
    if (file.type === "image/png" || file.name.toLowerCase().endsWith(".png")) return "PNG";
    return "JPEG";
  }

  function normalizedRotation(value) {
    return ((value % 360) + 360) % 360;
  }

  async function parseManagedPdfMetadata(file) {
    try {
      const bytes = await file.arrayBuffer();
      const pdf = await PDFDocument.load(bytes, { ignoreEncryption: false });
      const subject = pdf.getSubject?.() || "";

      if (!subject.startsWith("AI_SCAN_MANAGER_V8|")) return null;

      const payload = subject.slice("AI_SCAN_MANAGER_V8|".length);
      const parsed = JSON.parse(decodeURIComponent(payload));

      if (!parsed?.documentId) return null;
      return {
        documentId: parsed.documentId,
        metadata: parsed.metadata || {}
      };
    } catch (err) {
      console.warn("Managed PDF metadata could not be read.", err);
      return null;
    }
  }

  function parseManagedFilename(filename) {
    const base = String(filename || "").replace(/\.pdf$/i, "");
    const match = /^(\d{8}-\d{3})_(.+)$/.exec(base);
    if (!match) return null;

    const documentId = match[1];
    const parts = match[2].split("_");

    const metadata = {};
    const keys = ["year","grade","subject","testName","term","answer"];
    keys.forEach((key, i) => {
      if (parts[i]) metadata[key] = parts[i];
    });

    return { documentId, metadata };
  }

  function applyManagedMetadata(parsed) {
    if (!parsed) return;

    currentDocumentId = parsed.documentId;
    editingExistingManagedPdf = true;

    Object.entries(parsed.metadata || {}).forEach(([key, value]) => {
      if (!selectors.includes(key) || !value) return;
      ensureSelectValue(key, value);
    });

    populateSelects(false);

    Object.entries(parsed.metadata || {}).forEach(([key, value]) => {
      const sel = $(key);
      if (sel && Array.from(sel.options).some(o => o.value === value)) {
        sel.value = value;
      }
    });

    updateEditModeNotice();
    updateFilenamePreview();
  }

  function resetEditMode() {
    currentDocumentId = null;
    editingExistingManagedPdf = false;
    // The old management cover remains excluded; only the management number changes.
    updateEditModeNotice();
    updateFilenamePreview();
    renderPagePreviews();
  }

  function updateEditModeNotice() {
    const box = $("editModeNotice");
    const text = $("editModeText");
    if (!box || !text) return;

    if (editingExistingManagedPdf && currentDocumentId) {
      box.hidden = false;
      text.textContent = `管理番号 ${currentDocumentId} を引き継ぎます。1ページ目は旧管理表紙として除外予定です。サムネイルから復活できます。`;
    } else {
      box.hidden = true;
      text.textContent = "";
    }
  }

  async function addFiles(fileList) {
    const accepted = Array.from(fileList).filter(f =>
      /application\/pdf|image\/jpeg|image\/png/.test(f.type) ||
      /\.(pdf|jpe?g|png)$/i.test(f.name)
    );

    const startingEmpty = files.length === 0;
    let managedParsed = null;

    if (startingEmpty && accepted.length === 1) {
      const only = accepted[0];
      const isPdf = only.type === "application/pdf" || only.name.toLowerCase().endsWith(".pdf");
      if (isPdf) {
        managedParsed =
          await parseManagedPdfMetadata(only) ||
          parseManagedFilename(only.name);
      }
    }

    if (!managedParsed && startingEmpty) {
      currentDocumentId = null;
      editingExistingManagedPdf = false;
      updateEditModeNotice();
    }

    const added = accepted.map((file, idx) => ({
      id: crypto.randomUUID(),
      file,
      rotation: 0,
      pages: [],
      analyzed: false,
      analyzing: false,
      analysisError: null,
      managedDocument: Boolean(managedParsed && idx === 0),
      skipExistingCover: Boolean(managedParsed && idx === 0)
    }));

    files.push(...added);

    if (managedParsed) {
      applyManagedMetadata(managedParsed);
    }

    renderFiles();
    renderPagePreviews();
    queueAnalysis(added);
  }

  function openOriginal(item) {
    const url = URL.createObjectURL(item.file);
    window.open(url, "_blank", "noopener");
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  function rotateItem(id, delta) {
    const item = files.find(x => x.id === id);
    if (!item) return;
    item.rotation = normalizedRotation(item.rotation + delta);
    renderFiles();
    renderPagePreviews();
  }

  function getPageFinalRotation(item, page) {
    const auto = $("autoOrient").checked ? Number(page?.autoRotation || 0) : 0;
    return normalizedRotation(auto + Number(item.rotation || 0) + Number(page?.manualRotation || 0));
  }

  function isPageExcluded(page) {
    if (!page) return false;
    if (page.manualExclude) return true;
    if (page.keepOverride) return false;
    if (page.systemExclude) return true;
    return Boolean($("removeBlankPages").checked && page.isBlank);
  }

  function renderFiles() {
    const list = $("fileList");
    list.innerHTML = "";

    if (!files.length) {
      list.classList.add("empty");
      list.innerHTML = '<div class="empty-message">まだ資料が追加されていません。</div>';
      updateAnalysisSummary();
      return;
    }

    list.classList.remove("empty");

    files.forEach(item => {
      const row = document.createElement("div");
      row.className = "file-item";
      row.draggable = true;
      row.dataset.id = item.id;

      const handle = document.createElement("div");
      handle.className = "drag-handle";
      handle.textContent = "☰";

      const info = document.createElement("div");
      info.className = "file-info";

      const name = document.createElement("div");
      name.className = "file-name";
      name.textContent = item.file.name;

      const meta = document.createElement("div");
      meta.className = "file-meta";
      const pageText = item.analyzing ? " / 解析中…" : item.analyzed ? ` / ${item.pages.length}ページ` : "";
      meta.textContent = `${typeLabel(item.file)} / ${humanSize(item.file.size)}${pageText}`;

      const rotation = document.createElement("span");
      rotation.className = "rotation-badge";
      rotation.textContent = item.rotation === 0 ? "一括回転なし" : `一括回転 ${item.rotation}°`;
      meta.appendChild(rotation);

      info.append(name, meta);

      const actions = document.createElement("div");
      actions.className = "file-actions";

      const open = document.createElement("button");
      open.type = "button";
      open.className = "small-button open-button";
      open.textContent = "開いて確認";
      open.addEventListener("click", () => openOriginal(item));

      const left = document.createElement("button");
      left.type = "button";
      left.className = "small-button rotate-button";
      left.textContent = "↶ 全体左90°";
      left.addEventListener("click", () => rotateItem(item.id, -90));

      const right = document.createElement("button");
      right.type = "button";
      right.className = "small-button rotate-button";
      right.textContent = "↷ 全体右90°";
      right.addEventListener("click", () => rotateItem(item.id, 90));

      const del = document.createElement("button");
      del.type = "button";
      del.className = "small-button danger";
      del.textContent = "削除";
      del.addEventListener("click", () => {
        files = files.filter(x => x.id !== item.id);
        renderFiles();
        renderPagePreviews();
      });

      actions.append(open, left, right, del);
      row.append(handle, info, actions);
      attachDragEvents(row);
      list.appendChild(row);
    });

    updateAnalysisSummary();
  }

  function updateAnalysisSummary() {
    const el = $("analysisSummary");
    if (!el) return;
    if (!files.length) {
      el.textContent = "資料を追加すると自動解析します。";
      el.className = "analysis-summary";
      return;
    }
    const pages = files.flatMap(f => f.pages || []);
    const analyzedFiles = files.filter(f => f.analyzed).length;
    const blanks = pages.filter(p => p.isBlank).length;
    const low = pages.filter(p => p.orientationConfidence != null && p.orientationConfidence < 2).length;
    if (analysisRunning) {
      el.textContent = `文字方向を解析中… ${analyzedFiles}/${files.length}ファイル`;
      el.className = "analysis-summary analysis-progress";
    } else {
      el.textContent = `${pages.length}ページ確認済み / 白紙候補 ${blanks} / 向き判定が弱いページ ${low}`;
      el.className = "analysis-summary";
    }
  }

  function pageDisplayRotation(item, page) {
    return getPageFinalRotation(item, page);
  }

  function renderPagePreviews() {
    const box = $("pagePreviewList");
    if (!box) return;
    box.innerHTML = "";

    const hasPages = files.some(f => (f.pages || []).length);
    if (!hasPages) {
      box.classList.add("empty");
      box.innerHTML = '<div class="empty-message">解析したページのサムネイルがここに表示されます。</div>';
      return;
    }
    box.classList.remove("empty");

    files.forEach(item => {
      if (!item.pages?.length) return;
      const group = document.createElement("div");
      group.className = "preview-group";

      const title = document.createElement("div");
      title.className = "preview-group-title";
      title.innerHTML = `<span>${escapeHtml(item.file.name)}</span><small>${item.pages.length}ページ</small>`;
      group.appendChild(title);

      const grid = document.createElement("div");
      grid.className = "thumbnail-grid";

      item.pages.forEach(page => {
        const excluded = isPageExcluded(page);
        const card = document.createElement("div");
        card.className = `page-card${excluded ? " excluded" : ""}${page.isBlank ? " blank-page" : ""}${page.selected ? " selected" : ""}`;

        const selectRow = document.createElement("label");
        selectRow.className = "page-select-row";
        const selectBox = document.createElement("input");
        selectBox.type = "checkbox";
        selectBox.checked = Boolean(page.selected);
        selectBox.addEventListener("change", () => {
          page.selected = selectBox.checked;
          renderPagePreviews();
        });
        const selectText = document.createElement("span");
        selectText.textContent = "一括編集に選択";
        selectRow.append(selectBox, selectText);

        const frame = document.createElement("div");
        frame.className = "thumb-frame";
        if (page.thumbnail) {
          const img = document.createElement("img");
          img.src = page.thumbnail;
          img.alt = `${item.file.name} ${page.index + 1}ページ`;
          img.style.transform = `rotate(${pageDisplayRotation(item, page)}deg)`;
          frame.appendChild(img);
        } else {
          const ph = document.createElement("div");
          ph.className = "thumb-placeholder";
          ph.textContent = page.analyzing ? "解析中…" : "プレビューなし";
          frame.appendChild(ph);
        }

        const body = document.createElement("div");
        body.className = "page-card-body";

        const ptitle = document.createElement("div");
        ptitle.className = "page-title";
        ptitle.textContent = `ページ ${page.index + 1}`;

        const badges = document.createElement("div");
        badges.className = "page-badges";

        const autoBadge = document.createElement("span");
        autoBadge.className = "page-badge good";
        if (page.orientationDetected) {
          autoBadge.textContent = `自動 ${page.autoRotation || 0}°`;
        } else {
          autoBadge.className = "page-badge warn";
          autoBadge.textContent = "向き判定不可";
        }
        badges.appendChild(autoBadge);

        if (page.orientationConfidence != null) {
          const conf = document.createElement("span");
          conf.className = `page-badge ${page.orientationConfidence < 2 ? "warn" : ""}`;
          conf.textContent = `信頼 ${Number(page.orientationConfidence).toFixed(1)}`;
          badges.appendChild(conf);
        }

        if (page.systemExcludeReason) {
          const sys = document.createElement("span");
          sys.className = "page-badge system";
          sys.textContent = page.systemExcludeReason;
          badges.appendChild(sys);
        }

        if (page.isBlank) {
          const blank = document.createElement("span");
          blank.className = "page-badge bad";
          blank.textContent = "白紙候補";
          badges.appendChild(blank);
        }

        if (page.manualRotation) {
          const manual = document.createElement("span");
          manual.className = "page-badge";
          manual.textContent = `手動 ${page.manualRotation}°`;
          badges.appendChild(manual);
        }

        const controls = document.createElement("div");
        controls.className = "page-controls";

        const left = document.createElement("button");
        left.type = "button";
        left.textContent = "↶ 左90°";
        left.addEventListener("click", () => {
          page.manualRotation = normalizedRotation(Number(page.manualRotation || 0) - 90);
          renderPagePreviews();
        });

        const right = document.createElement("button");
        right.type = "button";
        right.textContent = "↷ 右90°";
        right.addEventListener("click", () => {
          page.manualRotation = normalizedRotation(Number(page.manualRotation || 0) + 90);
          renderPagePreviews();
        });

        const exclude = document.createElement("button");
        exclude.type = "button";
        exclude.className = "exclude-button";
        exclude.textContent = excluded ? "このページを残す" : "このページを除外";
        exclude.addEventListener("click", () => {
          if (excluded) {
            page.manualExclude = false;
            page.keepOverride = true;
          } else {
            page.manualExclude = true;
            page.keepOverride = false;
          }
          renderPagePreviews();
        });

        controls.append(left, right, exclude);
        body.append(ptitle, badges, controls);
        card.append(selectRow, frame, body);
        grid.appendChild(card);
      });

      group.appendChild(grid);
      box.appendChild(group);
    });
  }

  function allPages() {
    return files.flatMap(item =>
      (item.pages || []).map(page => ({ item, page }))
    );
  }

  function selectedPages() {
    return allPages().filter(({ page }) => page.selected);
  }

  function setAllPageSelection(selected) {
    allPages().forEach(({ page }) => {
      page.selected = selected;
    });
    renderPagePreviews();
  }

  function rotateSelectedPages(delta) {
    const selected = selectedPages();
    if (!selected.length) {
      const status = $("status");
      status.className = "status error";
      status.textContent = "回転するページにチェックを付けてください。";
      return;
    }

    selected.forEach(({ page }) => {
      page.manualRotation = normalizedRotation(Number(page.manualRotation || 0) + delta);
    });

    renderPagePreviews();
    const status = $("status");
    status.className = "status ok";
    status.textContent = `選択した ${selected.length}ページを ${Math.abs(delta)}° 回転しました。`;
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function attachDragEvents(row) {
    row.addEventListener("dragstart", e => {
      row.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", row.dataset.id);
    });

    row.addEventListener("dragend", () => row.classList.remove("dragging"));

    row.addEventListener("dragover", e => {
      e.preventDefault();
      const dragging = document.querySelector(".file-item.dragging");
      if (!dragging || dragging === row) return;
      const rect = row.getBoundingClientRect();
      const after = e.clientY > rect.top + rect.height / 2;
      row.parentNode.insertBefore(dragging, after ? row.nextSibling : row);
    });

    row.addEventListener("drop", e => {
      e.preventDefault();
      const ids = Array.from(document.querySelectorAll(".file-item")).map(el => el.dataset.id);
      files.sort((a,b) => ids.indexOf(a.id) - ids.indexOf(b.id));
      renderPagePreviews();
    });
  }

  function queueAnalysis(items = files) {
    analysisQueue = analysisQueue.then(async () => {
      analysisRunning = true;
      updateAnalysisSummary();
      try {
        for (const item of items) {
          await analyzeFile(item);
        }
      } finally {
        analysisRunning = false;
        renderFiles();
        renderPagePreviews();
        updateAnalysisSummary();
      }
    });
    return analysisQueue;
  }

  async function getOsdWorker() {
    if (!window.Tesseract) throw new Error("文字方向判定ライブラリを読み込めませんでした。");
    if (!osdWorkerPromise) {
      osdWorkerPromise = window.Tesseract.createWorker("eng", 1, {
        legacyCore: true,
        legacyLang: true,
        logger: m => {
          if (m?.status && analysisRunning) {
            const el = $("analysisSummary");
            if (el && /loading|initializing/i.test(m.status)) {
              el.textContent = `文字方向判定を準備中… ${Math.round((m.progress || 0) * 100)}%`;
              el.className = "analysis-summary analysis-progress";
            }
          }
        }
      });
    }
    return osdWorkerPromise;
  }

  function makeThumbDataUrl(canvas, maxSide = 240) {
    const scale = Math.min(1, maxSide / Math.max(canvas.width, canvas.height));
    const thumb = document.createElement("canvas");
    thumb.width = Math.max(1, Math.round(canvas.width * scale));
    thumb.height = Math.max(1, Math.round(canvas.height * scale));
    const ctx = thumb.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, thumb.width, thumb.height);
    ctx.drawImage(canvas, 0, 0, thumb.width, thumb.height);
    return thumb.toDataURL("image/jpeg", 0.78);
  }

  async function detectOrientationCorrection(canvas) {
    if (!$("autoOrient").checked) {
      return { rotation: 0, confidence: null, detected: false, script: null };
    }

    try {
      const worker = await getOsdWorker();
      const { data } = await worker.detect(canvas);
      const orientation = Number(data?.orientation_degrees);
      const confidence = Number(data?.orientation_confidence);

      if ([0, 90, 180, 270].includes(orientation)) {
        // Tesseract reports current orientation; rotate the opposite way to correct it.
        const correction = normalizedRotation(360 - orientation);
        return {
          rotation: correction,
          confidence: Number.isFinite(confidence) ? confidence : null,
          detected: true,
          script: data?.script || null
        };
      }
    } catch (err) {
      console.warn("Orientation detection failed", err);
    }

    // Fallback only handles landscape/portrait. Upside-down pages require OSD or manual check.
    const fallback = canvas.width > canvas.height ? 90 : 0;
    return { rotation: fallback, confidence: null, detected: false, script: null };
  }

  async function analyzeFile(item) {
    item.analyzing = true;
    item.analysisError = null;
    item.pages = [];
    renderFiles();
    renderPagePreviews();

    try {
      const isPdf = item.file.type === "application/pdf" || item.file.name.toLowerCase().endsWith(".pdf");
      if (isPdf) await analyzePdfFile(item);
      else await analyzeImageFile(item);
      item.analyzed = true;
    } catch (err) {
      console.error(err);
      item.analysisError = String(err?.message || err);
      item.analyzed = false;
    } finally {
      item.analyzing = false;
      renderFiles();
      renderPagePreviews();
      updateAnalysisSummary();
    }
  }

  async function analyzePdfFile(item) {
    if (!window.pdfjsLib) throw new Error("PDF解析ライブラリを読み込めませんでした。");
    const bytes = new Uint8Array(await item.file.arrayBuffer());
    const pdf = await window.pdfjsLib.getDocument({ data: bytes.slice() }).promise;

    try {
      for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
        const pageState = {
          index: pageNo - 1,
          thumbnail: null,
          isBlank: false,
          autoRotation: 0,
          orientationConfidence: null,
          orientationDetected: false,
          orientationScript: null,
          manualRotation: 0,
          manualExclude: false,
          keepOverride: false,
          systemExclude: Boolean(item.skipExistingCover && pageNo === 1),
          systemExcludeReason: item.skipExistingCover && pageNo === 1 ? "旧管理表紙" : null,
          selected: false,
          analyzing: true
        };
        item.pages.push(pageState);
        renderPagePreviews();

        const status = $("status");
        status.className = "status working";
        status.textContent = `${item.file.name}：ページ ${pageNo}/${pdf.numPages} の向きを解析中…`;

        const page = await pdf.getPage(pageNo);
        const base = page.getViewport({ scale: 1 });
        const scale = Math.min(2, Math.max(0.7, 1050 / Math.max(base.width, base.height)));
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.ceil(viewport.width));
        canvas.height = Math.max(1, Math.ceil(viewport.height));
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport, background: "white" }).promise;

        pageState.thumbnail = makeThumbDataUrl(canvas);
        pageState.isBlank = isCanvasBlank(canvas);

        if (!pageState.isBlank) {
          const detect = await detectOrientationCorrection(canvas);
          pageState.autoRotation = detect.rotation;
          pageState.orientationConfidence = detect.confidence;
          pageState.orientationDetected = detect.detected;
          pageState.orientationScript = detect.script;
        }

        pageState.analyzing = false;
        page.cleanup();
        renderPagePreviews();
      }
    } finally {
      try { await pdf.destroy(); } catch {}
    }
  }

  async function loadImageToCanvas(file, maxSide = 1200) {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.decoding = "async";
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = url;
      });
      const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      return canvas;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function analyzeImageFile(item) {
    const pageState = {
      index: 0,
      thumbnail: null,
      isBlank: false,
      autoRotation: 0,
      orientationConfidence: null,
      orientationDetected: false,
      orientationScript: null,
      manualRotation: 0,
      manualExclude: false,
      keepOverride: false,
      systemExclude: false,
      systemExcludeReason: null,
      selected: false,
      analyzing: true
    };
    item.pages = [pageState];
    renderPagePreviews();

    const status = $("status");
    status.className = "status working";
    status.textContent = `${item.file.name}：画像の向きを解析中…`;

    const canvas = await loadImageToCanvas(item.file, 1200);
    pageState.thumbnail = makeThumbDataUrl(canvas);
    pageState.isBlank = isCanvasBlank(canvas);
    if (!pageState.isBlank) {
      const detect = await detectOrientationCorrection(canvas);
      pageState.autoRotation = detect.rotation;
      pageState.orientationConfidence = detect.confidence;
      pageState.orientationDetected = detect.detected;
      pageState.orientationScript = detect.script;
    }
    pageState.analyzing = false;
  }

  async function reanalyzeAllPages() {
    if (!files.length) return;
    files.forEach(item => {
      item.analyzed = false;
      item.pages = [];
      item.analysisError = null;
    });
    renderFiles();
    renderPagePreviews();
    await queueAnalysis([...files]);
    const status = $("status");
    status.className = "status ok";
    status.textContent = "ページの向きを再判定しました。サムネイルで確認してください。";
  }

  function getLocalDateKey() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}${m}${day}`;
  }

  function loadDailyCounters() {
    try {
      return JSON.parse(localStorage.getItem("pdfMaterialDailyCounters") || "{}");
    } catch {
      return {};
    }
  }

  function getPendingDocumentId() {
    const dateKey = getLocalDateKey();
    const counters = loadDailyCounters();
    const next = Number(counters[dateKey] || 0) + 1;
    return `${dateKey}-${String(next).padStart(3, "0")}`;
  }

  function commitDocumentId(documentId) {
    const match = /^(\d{8})-(\d+)$/.exec(documentId);
    if (!match) return;

    const [, dateKey, serialText] = match;
    const serial = Number(serialText);
    const counters = loadDailyCounters();
    counters[dateKey] = Math.max(Number(counters[dateKey] || 0), serial);
    localStorage.setItem("pdfMaterialDailyCounters", JSON.stringify(counters));
  }

  function safePart(s) {
    return (s || "")
      .replace(/[\\/:*?"<>|]/g, "")
      .replace(/\s+/g, "")
      .slice(0, 50);
  }

  function getActiveDocumentId() {
    return currentDocumentId || getPendingDocumentId();
  }

  function buildFilename(documentId = getActiveDocumentId()) {
    const parts = selectors.map(id => safePart($(id).value)).filter(Boolean);
    const detail = parts.join("_") || "資料";
    return `${documentId}_${detail}.pdf`;
  }

  function updateFilenamePreview() {
    const documentId = getActiveDocumentId();
    $("documentIdPreview").textContent =
      editingExistingManagedPdf ? `${documentId}（再編集）` : documentId;
    $("filenamePreview").textContent = buildFilename(documentId);
  }

  async function createCoverPng(documentId) {
    const canvas = document.createElement("canvas");
    canvas.width = 1240;
    canvas.height = 1754;

    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = "#111827";
    ctx.textAlign = "center";
    ctx.font = 'bold 64px -apple-system, BlinkMacSystemFont, "Yu Gothic", Meiryo, sans-serif';
    ctx.fillText("資料管理票", canvas.width / 2, 155);

    ctx.strokeStyle = "#111827";
    ctx.lineWidth = 3;
    ctx.strokeRect(120, 220, 1000, 1040);

    const rows = [
      ["管理番号", documentId],
      ["年度", $("year").value || "—"],
      ["学年", $("grade").value || "—"],
      ["科目", $("subject").value || "—"],
      ["テスト名", $("testName").value || "—"],
      ["学期", $("term").value || "—"],
      ["解答", $("answer").value || "—"]
    ];

    ctx.textAlign = "left";
    const startY = 310;
    const rowH = 125;

    rows.forEach((r, i) => {
      const y = startY + i * rowH;

      if (i > 0) {
        ctx.strokeStyle = "#d1d5db";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(120, y - 72);
        ctx.lineTo(1120, y - 72);
        ctx.stroke();
      }

      ctx.fillStyle = "#6b7280";
      ctx.font = 'bold 34px -apple-system, BlinkMacSystemFont, "Yu Gothic", Meiryo, sans-serif';
      ctx.fillText(r[0], 175, y);

      ctx.fillStyle = "#111827";
      fitText(ctx, r[1], 430, y, 620, 46, 28);
    });

    ctx.fillStyle = "#6b7280";
    ctx.textAlign = "center";
    ctx.font = '28px -apple-system, BlinkMacSystemFont, "Yu Gothic", Meiryo, sans-serif';

    const d = new Date();
    ctx.fillText(`登録日：${d.getFullYear()}年${d.getMonth()+1}月${d.getDate()}日`, canvas.width/2, 1390);

    ctx.font = '24px -apple-system, BlinkMacSystemFont, "Yu Gothic", Meiryo, sans-serif';
    ctx.fillText("このページは資料整理用に自動生成されました。", canvas.width/2, 1460);

    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
    return new Uint8Array(await blob.arrayBuffer());
  }

  function fitText(ctx, text, x, y, maxWidth, startSize, minSize) {
    let size = startSize;
    while (size > minSize) {
      ctx.font = `bold ${size}px -apple-system, BlinkMacSystemFont, "Yu Gothic", Meiryo, sans-serif`;
      if (ctx.measureText(text).width <= maxWidth) break;
      size -= 2;
    }
    ctx.fillText(text, x, y, maxWidth);
  }

  async function loadImageFromFile(file) {
    const url = URL.createObjectURL(file);
    try {
      const image = new Image();
      image.decoding = "async";
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = reject;
        image.src = url;
      });
      return image;
    } finally {
      // revoke is done after canvas draw in rotateImageFile()
    }
  }

  function blankThresholds() {
    const mode = $("blankSensitivity")?.value || "careful";

    // Lower ratio / higher pixel threshold = more aggressive deletion.
    if (mode === "strong") {
      return { darkThreshold: 247, darkRatioLimit: 0.0035, meanDarknessLimit: 4.5 };
    }
    if (mode === "normal") {
      return { darkThreshold: 244, darkRatioLimit: 0.0020, meanDarknessLimit: 3.2 };
    }
    // Careful: keep pages even when only a small amount of faint content exists.
    return { darkThreshold: 240, darkRatioLimit: 0.0010, meanDarknessLimit: 2.2 };
  }

  function isCanvasBlank(canvas) {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const { width, height } = canvas;
    if (!width || !height) return true;

    const imageData = ctx.getImageData(0, 0, width, height).data;
    const { darkThreshold, darkRatioLimit, meanDarknessLimit } = blankThresholds();

    let darkPixels = 0;
    let darknessSum = 0;
    let sampled = 0;

    // Ignore a very small outer edge because scanners often create edge shadows.
    const marginX = Math.max(1, Math.floor(width * 0.025));
    const marginY = Math.max(1, Math.floor(height * 0.025));

    for (let y = marginY; y < height - marginY; y += 1) {
      for (let x = marginX; x < width - marginX; x += 1) {
        const i = (y * width + x) * 4;
        const a = imageData[i + 3] / 255;

        // Composite transparency over white.
        const r = imageData[i] * a + 255 * (1 - a);
        const g = imageData[i + 1] * a + 255 * (1 - a);
        const b = imageData[i + 2] * a + 255 * (1 - a);

        const gray = (r + g + b) / 3;
        darknessSum += 255 - gray;
        sampled += 1;

        if (Math.min(r, g, b) < darkThreshold) {
          darkPixels += 1;
        }
      }
    }

    if (!sampled) return true;

    const darkRatio = darkPixels / sampled;
    const meanDarkness = darknessSum / sampled;

    // A page is blank only if both tests say there is almost no content.
    return darkRatio < darkRatioLimit && meanDarkness < meanDarknessLimit;
  }

  function makeAnalysisCanvas(sourceWidth, sourceHeight, maxSide = 360) {
    const scale = Math.min(1, maxSide / Math.max(sourceWidth, sourceHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(sourceWidth * scale));
    canvas.height = Math.max(1, Math.round(sourceHeight * scale));
    return { canvas, scale };
  }

  async function isImageFileBlank(file) {
    if (!$("removeBlankPages").checked) return false;

    const url = URL.createObjectURL(file);
    try {
      const image = new Image();
      image.decoding = "async";
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = reject;
        image.src = url;
      });

      const { canvas } = makeAnalysisCanvas(image.naturalWidth, image.naturalHeight);
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

      return isCanvasBlank(canvas);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function getNonBlankPdfPageIndices(file, status) {
    const bytes = new Uint8Array(await file.arrayBuffer());

    if (!$("removeBlankPages").checked || !window.pdfjsLib) {
      // Use pdf-lib page count as fallback when blank detection is off/unavailable.
      const src = await PDFDocument.load(bytes, { ignoreEncryption: false });
      return {
        bytes,
        keepIndices: src.getPageIndices(),
        removedCount: 0,
        blankCheckAvailable: Boolean(window.pdfjsLib)
      };
    }

    const loadingTask = window.pdfjsLib.getDocument({ data: bytes });
    const pdf = await loadingTask.promise;
    const keepIndices = [];
    let removedCount = 0;

    try {
      for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
        status.textContent =
          `${file.name}：白紙チェック ${pageNo}/${pdf.numPages} ページ…`;

        const page = await pdf.getPage(pageNo);
        const baseViewport = page.getViewport({ scale: 1 });
        const targetScale = Math.min(
          0.6,
          360 / Math.max(baseViewport.width, baseViewport.height)
        );
        const viewport = page.getViewport({ scale: Math.max(0.1, targetScale) });

        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.ceil(viewport.width));
        canvas.height = Math.max(1, Math.ceil(viewport.height));

        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        await page.render({
          canvasContext: ctx,
          viewport,
          background: "white"
        }).promise;

        const blank = isCanvasBlank(canvas);
        if (blank) removedCount += 1;
        else keepIndices.push(pageNo - 1);

        page.cleanup();
      }
    } finally {
      try { await pdf.destroy(); } catch {}
    }

    return { bytes, keepIndices, removedCount, blankCheckAvailable: true };
  }

  function autoPortraitRotation(width, height, rotation) {
    const r = normalizedRotation(rotation);
    const swaps = r === 90 || r === 270;
    const visualWidth = swaps ? height : width;
    const visualHeight = swaps ? width : height;

    if ($("autoOrient").checked && visualWidth > visualHeight) {
      return normalizedRotation(r + 90);
    }
    return r;
  }

  async function rotateImageFile(file, rotation) {
    const normalized = normalizedRotation(rotation);
    const url = URL.createObjectURL(file);

    try {
      const image = new Image();
      image.decoding = "async";
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = reject;
        image.src = url;
      });

      const swap = normalized === 90 || normalized === 270;
      const canvas = document.createElement("canvas");
      canvas.width = swap ? image.naturalHeight : image.naturalWidth;
      canvas.height = swap ? image.naturalWidth : image.naturalHeight;

      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate(normalized * Math.PI / 180);
      ctx.drawImage(image, -image.naturalWidth / 2, -image.naturalHeight / 2);

      const isPng = file.type === "image/png" || file.name.toLowerCase().endsWith(".png");
      const mime = isPng ? "image/png" : "image/jpeg";
      const blob = await new Promise(resolve => canvas.toBlob(resolve, mime, isPng ? undefined : 0.94));

      return {
        bytes: new Uint8Array(await blob.arrayBuffer()),
        kind: isPng ? "png" : "jpg"
      };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function addImageAsA4(pdfDoc, item, rotation) {
    const rotated = await rotateImageFile(item.file, rotation);
    let image;

    if (rotated.kind === "png") image = await pdfDoc.embedPng(rotated.bytes);
    else image = await pdfDoc.embedJpg(rotated.bytes);

    const pageW = 595.28;
    const pageH = 841.89;
    const margin = 24;
    const page = pdfDoc.addPage([pageW, pageH]);

    const maxW = pageW - margin * 2;
    const maxH = pageH - margin * 2;
    const scale = Math.min(maxW / image.width, maxH / image.height);
    const w = image.width * scale;
    const h = image.height * scale;

    page.drawImage(image, {
      x: (pageW - w) / 2,
      y: (pageH - h) / 2,
      width: w,
      height: h
    });
  }

  function rotateCopiedPdfPages(pages, delta) {
    pages.forEach(page => {
      const current = page.getRotation().angle || 0;
      let target = normalizedRotation(current + delta);

      const { width, height } = page.getSize();
      const swaps = target === 90 || target === 270;
      const visualWidth = swaps ? height : width;
      const visualHeight = swaps ? width : height;

      if ($("autoOrient").checked && visualWidth > visualHeight) {
        target = normalizedRotation(target + 90);
      }

      page.setRotation(degrees(target));
    });
  }

  async function chooseOutputFolder() {
    const status = $("status");

    if ("showDirectoryPicker" in window) {
      try {
        outputDirectoryHandle = await window.showDirectoryPicker({
          id: "ai-scan-output",
          mode: "readwrite"
        });

        $("folderName").textContent = outputDirectoryHandle.name;
        $("folderHelp").textContent =
          "このフォルダへ直接PDFを保存します。Y:\AIスキャンを選んだ場合は、そのフォルダ内に保存されます。";

        status.className = "status ok";
        status.textContent = `保存先「${outputDirectoryHandle.name}」を選択しました。`;
        return;
      } catch (err) {
        if (err?.name === "AbortError") return;

        console.error(err);
        status.className = "status error";
        status.textContent =
          "フォルダ選択がブラウザにブロックされました。GitHub PagesをEdge/Chromeで開いているか確認してください。";
        return;
      }
    }

    // Unsupported: don't disable the button; explain and offer fallback.
    const isSecure = window.isSecureContext;
    status.className = "status error";

    if (!isSecure) {
      status.textContent =
        "このページは安全な接続(HTTPS)で開かれていないため、フォルダを直接選べません。GitHub Pages版をEdge/Chromeで開いてください。";
    } else {
      status.textContent =
        "このブラウザはフォルダ直接保存に対応していません。「PDF作成時に保存場所を選ぶ」をONにするか、Edge/Chromeで開いてください。";
    }

    $("askSaveLocation").checked = true;
  }

  async function savePdfBytes(pdfBytes, filename) {
    if (outputDirectoryHandle) {
      try {
        if (outputDirectoryHandle.requestPermission) {
          const permission = await outputDirectoryHandle.requestPermission({ mode: "readwrite" });
          if (permission !== "granted") throw new Error("write permission not granted");
        }

        const fileHandle = await outputDirectoryHandle.getFileHandle(filename, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(pdfBytes);
        await writable.close();

        return { mode: "folder", folder: outputDirectoryHandle.name };
      } catch (err) {
        console.warn("Direct folder save failed.", err);
      }
    }

    // Fallback: ask the user to choose a file location each time.
    if ($("askSaveLocation").checked && "showSaveFilePicker" in window) {
      try {
        const handle = await window.showSaveFilePicker({
          id: "ai-scan-pdf-save",
          suggestedName: filename,
          types: [{
            description: "PDF",
            accept: { "application/pdf": [".pdf"] }
          }]
        });

        const writable = await handle.createWritable();
        await writable.write(pdfBytes);
        await writable.close();
        return { mode: "filepicker" };
      } catch (err) {
        if (err?.name === "AbortError") {
          throw new Error("保存がキャンセルされました。");
        }
        console.warn("Save file picker failed; falling back to download.", err);
      }
    }

    // Universal fallback: normal browser download.
    const blob = new Blob([pdfBytes], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);

    return { mode: "download" };
  }

  async function buildPdf() {
    const status = $("status");

    if (!files.length && !$("addCover").checked) {
      status.className = "status error";
      status.textContent = "PDFまたは画像を1つ以上追加してください。";
      return;
    }

    if (!window.PDFLib) {
      status.className = "status error";
      status.textContent = "PDFライブラリを読み込めませんでした。インターネット接続を確認してください。";
      return;
    }

    try {
      $("buildPdf").disabled = true;
      status.className = "status working";
      status.textContent = "ページ解析の完了を確認しています…";

      await analysisQueue;
      const notAnalyzed = files.filter(f => !f.analyzed);
      if (notAnalyzed.length) {
        await queueAnalysis(notAnalyzed);
      }
      await analysisQueue;

      status.textContent = "PDFを作成しています…";
      const wasEditingExisting = editingExistingManagedPdf && Boolean(currentDocumentId);
      const documentId = getActiveDocumentId();
      const out = await PDFDocument.create();

      const embeddedMetadata = {
        documentId,
        metadata: Object.fromEntries(
          selectors.map(id => [id, $(id).value || ""])
        )
      };

      out.setTitle(buildFilename(documentId).replace(/\.pdf$/i, ""));
      out.setSubject(
        `AI_SCAN_MANAGER_V8|${encodeURIComponent(JSON.stringify(embeddedMetadata))}`
      );
      out.setKeywords([
        "AI_SCAN_MANAGER_V8",
        `documentId:${documentId}`
      ]);
      let removedBlankPages = 0;
      let manuallyExcludedPages = 0;
      let contentPagesAdded = 0;

      if ($("addCover").checked) {
        status.textContent = "管理表紙を作成しています…";
        const coverPng = await createCoverPng(documentId);
        const coverImg = await out.embedPng(coverPng);

        const pageW = 595.28;
        const pageH = 841.89;
        const page = out.addPage([pageW, pageH]);
        page.drawImage(coverImg, { x: 0, y: 0, width: pageW, height: pageH });
      }

      for (let i = 0; i < files.length; i++) {
        const item = files[i];
        status.textContent = `${i+1}/${files.length}：${item.file.name} を処理中…`;

        const isPdf =
          item.file.type === "application/pdf" ||
          item.file.name.toLowerCase().endsWith(".pdf");

        const pages = item.pages || [];

        if (isPdf) {
          const srcBytes = await item.file.arrayBuffer();
          const src = await PDFDocument.load(srcBytes, { ignoreEncryption: false });

          for (const pageState of pages) {
            const excluded = isPageExcluded(pageState);
            if (excluded) {
              if (pageState.systemExclude && !pageState.keepOverride && !pageState.manualExclude) {
                // Existing management cover: replaced by the newly generated cover.
              } else if (pageState.isBlank && !pageState.manualExclude) {
                removedBlankPages += 1;
              } else {
                manuallyExcludedPages += 1;
              }
              continue;
            }

            const [copied] = await out.copyPages(src, [pageState.index]);
            const current = copied.getRotation().angle || 0;
            const correction = getPageFinalRotation(item, pageState);
            copied.setRotation(degrees(normalizedRotation(current + correction)));
            out.addPage(copied);
            contentPagesAdded += 1;
          }
        } else if (pages[0]) {
          const pageState = pages[0];
          const excluded = isPageExcluded(pageState);
          if (excluded) {
            if (pageState.isBlank && !pageState.manualExclude) removedBlankPages += 1;
            else manuallyExcludedPages += 1;
          } else {
            await addImageAsA4(out, item, getPageFinalRotation(item, pageState));
            contentPagesAdded += 1;
          }
        }
      }

      if (contentPagesAdded === 0) {
        throw new Error("資料ページがすべて白紙と判定されました。白紙判定をOFFにするか、判定を「慎重」にして確認してください。");
      }

      status.textContent = "保存用PDFを仕上げています…";
      const pdfBytes = await out.save();
      const filename = buildFilename(documentId);

      const result = await savePdfBytes(pdfBytes, filename);
      if (!wasEditingExisting) {
        commitDocumentId(documentId);
      }
      updateFilenamePreview();

      status.className = "status ok";
      let message = "";
      if (result.mode === "folder") {
        message = `「${result.folder}」に ${filename} を保存しました。`;
      } else if (result.mode === "filepicker") {
        message = `${filename} を選択した場所へ保存しました。`;
      } else {
        message = "PDFを作成し、通常のダウンロード先へ保存しました。";
      }

      if ($("removeBlankPages").checked) {
        message += ` 白紙 ${removedBlankPages}ページを削除しました。`;
      }
      if (manuallyExcludedPages) {
        message += ` 手動で ${manuallyExcludedPages}ページを除外しました。`;
      }
      message += " 元ファイルは変更されていません。";
      status.textContent = message;
    } catch (err) {
      console.error(err);
      status.className = "status error";

      if (/すべて白紙/.test(String(err))) {
        status.textContent = String(err.message || err);
      } else if (/encrypted/i.test(String(err))) {
        status.textContent = "パスワード保護されたPDFは処理できません。保護を解除したPDFを使用してください。";
      } else {
        status.textContent = "PDF作成中にエラーが発生しました。別のPDF/画像で試してください。";
      }
    } finally {
      $("buildPdf").disabled = false;
    }
  }

  function fillUnselectedWithMixed() {
    let changed = 0;

    selectors.forEach(key => {
      const sel = $(key);
      if (!sel.value) {
        if (!Array.from(sel.options).some(o => o.value === "混在")) {
          const opt = document.createElement("option");
          opt.value = "混在";
          opt.textContent = "混在";
          sel.appendChild(opt);
        }
        sel.value = "混在";
        changed += 1;
      }
    });

    updateFilenamePreview();

    const status = $("status");
    status.className = "status ok";
    status.textContent = changed
      ? `未選択の ${changed}項目を「混在」にしました。`
      : "すべての項目がすでに選択されています。";
  }

  // Settings UI
  function renderOptionEditor() {
    const key = $("settingsCategory").value;
    const box = $("optionEditor");
    box.innerHTML = "";

    editSettings[key].forEach((value, idx) => {
      const row = document.createElement("div");
      row.className = "option-row";
      row.draggable = true;
      row.dataset.index = idx;

      const handle = document.createElement("div");
      handle.className = "drag-handle";
      handle.textContent = "☰";

      const input = document.createElement("input");
      input.value = value;
      input.addEventListener("input", () => {
        editSettings[key][Number(row.dataset.index)] = input.value;
      });

      const del = document.createElement("button");
      del.type = "button";
      del.className = "small-button danger";
      del.textContent = "削除";
      del.addEventListener("click", () => {
        if (editSettings[key].length <= 1) {
          alert("最低1項目は残してください。");
          return;
        }
        const currentIndex = Number(row.dataset.index);
        editSettings[key].splice(currentIndex, 1);
        renderOptionEditor();
      });

      row.append(handle, input, del);
      attachOptionDrag(row, key);
      box.appendChild(row);
    });
  }

  function attachOptionDrag(row, key) {
    row.addEventListener("dragstart", e => {
      row.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", row.dataset.index);
    });

    row.addEventListener("dragend", () => row.classList.remove("dragging"));

    row.addEventListener("dragover", e => {
      e.preventDefault();
      const dragging = document.querySelector(".option-row.dragging");
      if (!dragging || dragging === row) return;
      const rect = row.getBoundingClientRect();
      const after = e.clientY > rect.top + rect.height/2;
      row.parentNode.insertBefore(dragging, after ? row.nextSibling : row);
    });

    row.addEventListener("drop", e => {
      e.preventDefault();
      const rows = Array.from(document.querySelectorAll(".option-row"));
      editSettings[key] = rows.map(el => el.querySelector("input").value);
      renderOptionEditor();
    });
  }

  $("openSettings").addEventListener("click", () => {
    editSettings = structuredClone(settings);
    $("settingsDialog").showModal();
    renderOptionEditor();
  });

  $("settingsCategory").addEventListener("change", renderOptionEditor);

  $("addOption").addEventListener("click", () => {
    const key = $("settingsCategory").value;
    editSettings[key].push(`新しい${labels[key]}`);
    renderOptionEditor();
    const inputs = $("optionEditor").querySelectorAll("input");
    inputs[inputs.length - 1]?.select();
  });

  $("saveSettings").addEventListener("click", () => {
    for (const key of Object.keys(editSettings)) {
      editSettings[key] = editSettings[key].map(v => v.trim()).filter(Boolean);
      if (!editSettings[key].length) editSettings[key] = [...DEFAULTS[key]];
    }

    settings = structuredClone(editSettings);
    saveLocalSettings();
    populateSelects();
    $("settingsDialog").close();
  });

  $("resetSettings").addEventListener("click", () => {
    if (!confirm("プルダウン設定を初期値に戻しますか？")) return;
    editSettings = structuredClone(DEFAULTS);
    renderOptionEditor();
  });

  $("exportSettings").addEventListener("click", () => {
    const blob = new Blob(
      [JSON.stringify(editSettings, null, 2)],
      { type: "application/json" }
    );

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "pdf-app-settings.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  });

  $("importSettings").addEventListener("change", async e => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const parsed = JSON.parse(await file.text());

      for (const key of Object.keys(DEFAULTS)) {
        if (!Array.isArray(parsed[key]) || !parsed[key].length) {
          throw new Error("invalid");
        }
      }

      editSettings = parsed;
      renderOptionEditor();
      alert("設定を読み込みました。「設定を保存」を押すと反映されます。");
    } catch {
      alert("設定ファイルの形式が正しくありません。");
    } finally {
      e.target.value = "";
    }
  });

  // Files + drop zone
  $("fileInput").addEventListener("change", e => {
    addFiles(e.target.files);
    e.target.value = "";
  });

  const dz = $("dropZone");

  ["dragenter","dragover"].forEach(evt => dz.addEventListener(evt, e => {
    e.preventDefault();
    dz.classList.add("dragover");
  }));

  ["dragleave","drop"].forEach(evt => dz.addEventListener(evt, e => {
    e.preventDefault();
    dz.classList.remove("dragover");
  }));

  dz.addEventListener("drop", e => addFiles(e.dataTransfer.files));

  $("clearFiles").addEventListener("click", () => {
    if (!files.length) return;

    if (confirm("追加したファイルをすべて一覧から削除しますか？")) {
      files = [];
      currentDocumentId = null;
      editingExistingManagedPdf = false;
      updateEditModeNotice();
      updateFilenamePreview();
      renderFiles();
      renderPagePreviews();
    }
  });

  $("autoOrient").addEventListener("change", async () => {
    const status = $("status");
    status.className = "status";
    if ($("autoOrient").checked) {
      status.textContent = "文字向き自動判定：ON。必要なら「向きを再判定」を押してください。";
    } else {
      status.textContent = "文字向き自動判定：OFF（サムネイルから手動回転できます）。";
    }
    renderPagePreviews();
  });

  $("removeBlankPages").addEventListener("change", () => {
    const status = $("status");
    status.className = "status";
    status.textContent = $("removeBlankPages").checked
      ? "白紙ページ自動削除：ON"
      : "白紙ページ自動削除：OFF";
    renderPagePreviews();
    updateAnalysisSummary();
  });

  $("blankSensitivity").addEventListener("change", () => {
    const status = $("status");
    status.className = "status";
    status.textContent = "白紙判定の強さを変更しました。既存ページへ反映するには「向きを再判定」を押してください。";
  });

  $("reanalyzePages").addEventListener("click", reanalyzeAllPages);

  $("selectAllPages").addEventListener("click", () => setAllPageSelection(true));
  $("clearPageSelection").addEventListener("click", () => setAllPageSelection(false));
  $("rotateSelectedLeft").addEventListener("click", () => rotateSelectedPages(-90));
  $("rotateSelectedRight").addEventListener("click", () => rotateSelectedPages(90));
  $("rotateSelected180").addEventListener("click", () => rotateSelectedPages(180));

  $("fillMixedFields").addEventListener("click", fillUnselectedWithMixed);

  $("leaveEditMode").addEventListener("click", () => {
    resetEditMode();
    const status = $("status");
    status.className = "status ok";
    status.textContent = "新しい資料として扱います。保存時に新しい管理番号を発行します。";
  });

  $("chooseFolder").addEventListener("click", chooseOutputFolder);
  $("buildPdf").addEventListener("click", buildPdf);

  selectors.forEach(id => $(id).addEventListener("change", updateFilenamePreview));

  function updateBrowserSupportMessage() {
    const el = $("browserSupport");

    if ("showDirectoryPicker" in window && window.isSecureContext) {
      el.textContent = "この環境ではフォルダ直接保存を利用できます。";
      el.className = "support-note good";
    } else if (!window.isSecureContext) {
      el.textContent = "現在はHTTPSではないため、フォルダ直接保存は使えません。GitHub Pages版で利用してください。";
      el.className = "support-note warn";
    } else {
      el.textContent = "このブラウザではフォルダ直接保存に未対応です。Edge/Chromeをおすすめします。";
      el.className = "support-note warn";
    }
  }

  // The button is deliberately kept enabled so the user always gets an explanation.
  updateBrowserSupportMessage();
  populateSelects(false);
  updateEditModeNotice();
  renderFiles();
  renderPagePreviews();
})();
