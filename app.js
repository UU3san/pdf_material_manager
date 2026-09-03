(() => {
  const { PDFDocument, degrees } = PDFLib;

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

  function populateSelects() {
    selectors.forEach(key => {
      const sel = $(key);
      const current = sel.value;
      sel.innerHTML = "";
      settings[key].forEach(v => {
        const opt = document.createElement("option");
        opt.value = v;
        opt.textContent = v;
        sel.appendChild(opt);
      });
      if (settings[key].includes(current)) sel.value = current;
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

  function addFiles(fileList) {
    const accepted = Array.from(fileList).filter(f =>
      /application\/pdf|image\/jpeg|image\/png/.test(f.type) ||
      /\.(pdf|jpe?g|png)$/i.test(f.name)
    );

    files.push(...accepted.map(file => ({
      id: crypto.randomUUID(),
      file,
      rotation: 0
    })));

    renderFiles();
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
  }

  function renderFiles() {
    const list = $("fileList");
    list.innerHTML = "";

    if (!files.length) {
      list.classList.add("empty");
      list.innerHTML = '<div class="empty-message">まだ資料が追加されていません。</div>';
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
      meta.textContent = `${typeLabel(item.file)} / ${humanSize(item.file.size)}`;

      const rotation = document.createElement("span");
      rotation.className = "rotation-badge";
      rotation.textContent = item.rotation === 0 ? "回転なし" : `回転 ${item.rotation}°`;
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
      left.textContent = "↶ 左90°";
      left.addEventListener("click", () => rotateItem(item.id, -90));

      const right = document.createElement("button");
      right.type = "button";
      right.className = "small-button rotate-button";
      right.textContent = "↷ 右90°";
      right.addEventListener("click", () => rotateItem(item.id, 90));

      const del = document.createElement("button");
      del.type = "button";
      del.className = "small-button danger";
      del.textContent = "削除";
      del.addEventListener("click", () => {
        files = files.filter(x => x.id !== item.id);
        renderFiles();
      });

      actions.append(open, left, right, del);

      row.append(handle, info, actions);
      attachDragEvents(row);
      list.appendChild(row);
    });
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
    });
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

  function buildFilename(documentId = getPendingDocumentId()) {
    const parts = selectors.map(id => safePart($(id).value)).filter(Boolean);
    const detail = parts.join("_") || "資料";
    return `${documentId}_${detail}.pdf`;
  }

  function updateFilenamePreview() {
    const documentId = getPendingDocumentId();
    $("documentIdPreview").textContent = documentId;
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
      ["年度", $("year").value],
      ["学年", $("grade").value],
      ["科目", $("subject").value],
      ["テスト名", $("testName").value],
      ["学期", $("term").value],
      ["解答", $("answer").value]
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
    const url = URL.createObjectURL(file);

    try {
      const image = new Image();
      image.decoding = "async";
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = reject;
        image.src = url;
      });

      const normalized = autoPortraitRotation(
        image.naturalWidth,
        image.naturalHeight,
        rotation
      );

      if (normalized === 0) {
        return {
          bytes: new Uint8Array(await file.arrayBuffer()),
          kind: (file.type === "image/png" || file.name.toLowerCase().endsWith(".png")) ? "png" : "jpg"
        };
      }

      const swap = normalized === 90 || normalized === 270;
      const canvas = document.createElement("canvas");
      canvas.width = swap ? image.naturalHeight : image.naturalWidth;
      canvas.height = swap ? image.naturalWidth : image.naturalHeight;

      const ctx = canvas.getContext("2d");
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

  async function addImageAsA4(pdfDoc, item) {
    const rotated = await rotateImageFile(item.file, item.rotation);
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
      status.textContent = "PDFを作成しています…";

      const documentId = getPendingDocumentId();
      const out = await PDFDocument.create();

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

        if (isPdf) {
          const src = await PDFDocument.load(
            await item.file.arrayBuffer(),
            { ignoreEncryption: false }
          );

          const copied = await out.copyPages(src, src.getPageIndices());
          rotateCopiedPdfPages(copied, item.rotation);
          copied.forEach(p => out.addPage(p));
        } else {
          await addImageAsA4(out, item);
        }
      }

      status.textContent = "保存用PDFを仕上げています…";
      const pdfBytes = await out.save();
      const filename = buildFilename(documentId);

      const result = await savePdfBytes(pdfBytes, filename);
      commitDocumentId(documentId);
      updateFilenamePreview();

      status.className = "status ok";
      if (result.mode === "folder") {
        status.textContent = `「${result.folder}」に ${filename} を保存しました。元ファイルは変更されていません。`;
      } else if (result.mode === "filepicker") {
        status.textContent = `${filename} を選択した場所へ保存しました。元ファイルは変更されていません。`;
      } else {
        status.textContent = "PDFを作成しました。通常のダウンロード先へ保存しました。元ファイルは変更されていません。";
      }
    } catch (err) {
      console.error(err);
      status.className = "status error";

      if (/encrypted/i.test(String(err))) {
        status.textContent = "パスワード保護されたPDFは処理できません。保護を解除したPDFを使用してください。";
      } else {
        status.textContent = "PDF作成中にエラーが発生しました。別のPDF/画像で試してください。";
      }
    } finally {
      $("buildPdf").disabled = false;
    }
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
      renderFiles();
    }
  });

  $("autoOrient").addEventListener("change", () => {
    const status = $("status");
    status.className = "status";
    status.textContent = $("autoOrient").checked
      ? "自動縦向き補正：ON"
      : "自動縦向き補正：OFF（手動回転のみ）";
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
  populateSelects();
  renderFiles();
})();
