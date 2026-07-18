/**
 * PDF Düzenleyici — ana uygulama.
 * pdf.js ile sayfaları çizer, her sayfanın üstünde bir düzenleme katmanı (overlay canvas)
 * ve serbest konumlu yazı kutuları tutar. pdf-lib ile yeni PDF üretir.
 */
(() => {
  "use strict";

  pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

  const RENDER_SCALE = 2;      // kalite için çizim ölçeği
  const MAX_UNDO = 25;         // sayfa başına geri alma adımı
  const JPEG_QUALITY = 0.92;

  // ---- DOM ----
  const el = (id) => document.getElementById(id);
  const welcomeEl = el("welcome");
  const editorEl = el("editor");
  const pagesEl = el("pages");
  const toolbarEl = el("toolbar");
  const dropzoneEl = el("dropzone");
  const fileInput = el("fileInput");
  const colorPicker = el("colorPicker");
  const sizePicker = el("sizePicker");
  const sizeWrap = el("sizeWrap");
  const textOptsWrap = el("textOptsWrap");
  const fontFamilyPicker = el("fontFamilyPicker");
  const fontSizePicker = el("fontSizePicker");
  const fontDecBtn = el("fontDecBtn");
  const fontIncBtn = el("fontIncBtn");
  const boldBtn = el("boldBtn");
  const italicBtn = el("italicBtn");
  const underlineTextBtn = el("underlineTextBtn");
  const loadingEl = el("loading");
  const loadingText = el("loadingText");
  const historyPanel = el("historyPanel");
  const historyList = el("historyList");
  const overlayBg = el("overlayBg");
  const changesBtn = el("changesBtn");
  const changesPanel = el("changesPanel");
  const changesList = el("changesList");

  // ---- Durum ----
  let currentTool = "select";
  let pages = [];          // { wrap, base, overlay, octx, undoStack, ptWidth, ptHeight }
  let docName = "belge.pdf";
  let selectedBox = null;
  let textFormat = {
    fontFamily: fontFamilyPicker.value,
    fontSize: Number(fontSizePicker.value),
    bold: false,
    italic: false,
    underline: false,
  };
  let changeLog = [];   // { id, page, kind: "stroke"|"dom", icon, label, time, snapshot, el }
  let changeSeq = 0;

  // ================= Yardımcılar =================

  function showLoading(text) {
    loadingText.textContent = text;
    loadingEl.hidden = false;
  }
  function hideLoading() { loadingEl.hidden = true; }

  function toCanvasPoint(canvas, e) {
    const r = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) * (canvas.width / r.width),
      y: (e.clientY - r.top) * (canvas.height / r.height),
    };
  }

  function cssScale(page) {
    // CSS pikselinden canvas pikseline çarpan
    const r = page.overlay.getBoundingClientRect();
    return page.overlay.width / r.width;
  }

  // ================= PDF yükleme =================

  async function loadPdf(arrayBuffer, name) {
    showLoading("PDF açılıyor…");
    try {
      const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
      docName = name || "belge.pdf";
      resetEditor();

      for (let i = 1; i <= pdf.numPages; i++) {
        loadingText.textContent = `Sayfa hazırlanıyor: ${i} / ${pdf.numPages}`;
        await addPageFromPdf(await pdf.getPage(i));
      }

      welcomeEl.hidden = true;
      editorEl.hidden = false;
      toolbarEl.hidden = false;
      changesBtn.hidden = false;
      setTool("select");
    } catch (err) {
      console.error(err);
      alert("PDF açılamadı. Dosyanın geçerli bir PDF olduğundan emin olun.");
    } finally {
      hideLoading();
    }
  }

  /** pdf.js sayfasını editöre yeni bir sayfa olarak ekler (sona). */
  async function addPageFromPdf(pdfPage) {
    const viewport = pdfPage.getViewport({ scale: RENDER_SCALE });
    const ptView = pdfPage.getViewport({ scale: 1 });

    const wrap = document.createElement("div");
    wrap.className = "page-wrap";
    wrap.style.width = Math.round(viewport.width / 2) + "px";

    const base = document.createElement("canvas");
    base.width = viewport.width;
    base.height = viewport.height;

    const overlay = document.createElement("canvas");
    overlay.className = "overlay";
    overlay.width = viewport.width;
    overlay.height = viewport.height;

    const num = document.createElement("span");
    num.className = "page-num";
    num.textContent = `Sayfa ${pages.length + 1}`;

    wrap.append(base, overlay, num);
    pagesEl.appendChild(wrap);

    await pdfPage.render({ canvasContext: base.getContext("2d"), viewport }).promise;

    const page = {
      wrap, base, overlay,
      octx: overlay.getContext("2d"),
      undoStack: [],
      ptWidth: ptView.width,
      ptHeight: ptView.height,
    };
    bindDrawingEvents(page);
    pages.push(page);
    return page;
  }

  /** Bir PDF dosyasının tüm sayfalarını belgenin sonuna ekler (alt alta). */
  async function appendPdfPages(file) {
    showLoading("PDF sayfaları ekleniyor…");
    try {
      const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
      for (let i = 1; i <= pdf.numPages; i++) {
        loadingText.textContent = `Sayfa ekleniyor: ${i} / ${pdf.numPages}`;
        await addPageFromPdf(await pdf.getPage(i));
      }
      pages[pages.length - pdf.numPages].wrap.scrollIntoView({ behavior: "smooth" });
    } catch (err) {
      console.error(err);
      alert("PDF sayfaları eklenemedi.");
    } finally {
      hideLoading();
    }
  }

  function resetEditor() {
    pagesEl.innerHTML = "";
    pages = [];
    selectedBox = null;
    changeLog = [];
    renderChanges();
    changesBtn.hidden = true;
  }

  function closeDocument() {
    resetEditor();
    editorEl.hidden = true;
    toolbarEl.hidden = true;
    welcomeEl.hidden = false;
    fileInput.value = "";
  }

  // ================= Araçlar =================

  let eraseMode = "white"; // "white" | "paper"

  function setTool(tool) {
    currentTool = tool;
    document.querySelectorAll(".tool-btn").forEach((b) =>
      b.classList.toggle("active", b.dataset.tool === tool)
    );
    el("eraseModeWrap").hidden = tool !== "erase";
    textOptsWrap.hidden = tool !== "text";
    sizeWrap.hidden = tool === "text";
    const interactive = tool === "select" || tool === "text";
    document.querySelectorAll(".textbox, .imgbox").forEach((box) => {
      box.style.pointerEvents = interactive ? "auto" : "none";
    });
    pagesEl.style.cursor =
      tool === "select" ? "default" :
      tool === "text" ? "text" : "crosshair";
    deselectBox();
  }

  function pushUndo(page) {
    page.undoStack.push(
      page.octx.getImageData(0, 0, page.overlay.width, page.overlay.height)
    );
    if (page.undoStack.length > MAX_UNDO) page.undoStack.shift();
  }

  function undoLast() {
    // En son çizim yapılan sayfayı bulmak yerine basitçe: her sayfanın kendi
    // yığını var; en son işlem hangi sayfadaysa onu geri al.
    if (!lastEditedPage || lastEditedPage.undoStack.length === 0) return;
    const img = lastEditedPage.undoStack.pop();
    lastEditedPage.octx.putImageData(img, 0, 0);
    if (lastEditedPage.undoStack.length === 0) {
      // bir önceki düzenlenen sayfaya düşemeyiz; sorun değil
    }
  }

  let lastEditedPage = null;

  // ---- Kağıt rengi algılama ----

  /**
   * Seçilen alanın İÇİNDEKİ en baskın rengi bulur — kağıt zemini alanın
   * çoğunluğunu kapladığı için yazı/çizgiler sonucu etkilemez.
   */
  function samplePaperColor(page, x0, y0, x1, y1) {
    const ctx = page.base.getContext("2d");

    // Çok küçük seçimlerde çevreden de örnek alabilmek için alanı genişlet
    const minSize = 16 * RENDER_SCALE;
    let left = Math.min(x0, x1), top = Math.min(y0, y1);
    let w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
    if (w < minSize) { left -= (minSize - w) / 2; w = minSize; }
    if (h < minSize) { top -= (minSize - h) / 2; h = minSize; }
    left = Math.max(0, Math.round(left));
    top = Math.max(0, Math.round(top));
    w = Math.min(page.base.width - left, Math.round(w));
    h = Math.min(page.base.height - top, Math.round(h));
    if (w < 1 || h < 1) return "#ffffff";

    const data = ctx.getImageData(left, top, w, h).data;

    // Renkleri kabaca grupla (histogram), en kalabalık grubun ortalamasını al
    const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 5000))); // ~5000 örnek
    const buckets = new Map(); // anahtar: kaba renk, değer: [say, rT, gT, bT]
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        const i = (y * w + x) * 4;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
        const bk = buckets.get(key) || [0, 0, 0, 0];
        bk[0]++; bk[1] += r; bk[2] += g; bk[3] += b;
        buckets.set(key, bk);
      }
    }

    let best = null;
    for (const bk of buckets.values()) {
      if (!best || bk[0] > best[0]) best = bk;
    }
    if (!best) return "#ffffff";
    return `rgb(${Math.round(best[1] / best[0])}, ${Math.round(best[2] / best[0])}, ${Math.round(best[3] / best[0])})`;
  }

  // ---- Çizim olayları ----

  function bindDrawingEvents(page) {
    const { overlay, octx } = page;
    let drawing = false;
    let start = null;
    let snapshot = null;
    let lastP = null;
    let eraseColor = "#ffffff";
    let strokeSnapshot = null;
    let strokeTool = null;

    overlay.addEventListener("pointerdown", (e) => {
      if (currentTool === "select") return;

      if (currentTool === "text") {
        e.preventDefault(); // tarayıcının odağı geri almasını engelle
        createTextBox(page, e);
        return;
      }

      e.preventDefault();
      overlay.setPointerCapture(e.pointerId);
      drawing = true;
      strokeTool = currentTool;
      start = toCanvasPoint(overlay, e);
      lastP = start;
      pushUndo(page);
      strokeSnapshot = page.undoStack[page.undoStack.length - 1];
      lastEditedPage = page;
      snapshot = octx.getImageData(0, 0, overlay.width, overlay.height);

      if (currentTool === "erase") {
        eraseColor = eraseMode === "paper"
          ? samplePaperColor(page, start.x, start.y, start.x, start.y)
          : "#ffffff";
      }

      if (currentTool === "draw") {
        octx.beginPath();
        octx.moveTo(start.x, start.y);
      }
    });

    overlay.addEventListener("pointermove", (e) => {
      if (!drawing) return;
      const p = toCanvasPoint(overlay, e);
      lastP = p;
      const size = Number(sizePicker.value) * RENDER_SCALE;
      const color = colorPicker.value;

      if (currentTool === "draw") {
        octx.strokeStyle = color;
        octx.lineWidth = size;
        octx.lineCap = "round";
        octx.lineJoin = "round";
        octx.lineTo(p.x, p.y);
        octx.stroke();
        return;
      }

      // Dikdörtgen/çizgi araçları: önizleme için anlık görüntüyü geri yükle
      octx.putImageData(snapshot, 0, 0);

      if (currentTool === "erase") {
        octx.fillStyle = eraseColor;
        octx.fillRect(
          Math.min(start.x, p.x), Math.min(start.y, p.y),
          Math.abs(p.x - start.x), Math.abs(p.y - start.y)
        );
      } else if (currentTool === "highlight") {
        octx.fillStyle = hexToRgba(color, 0.35);
        octx.fillRect(
          Math.min(start.x, p.x), Math.min(start.y, p.y),
          Math.abs(p.x - start.x), Math.abs(p.y - start.y)
        );
      } else if (currentTool === "underline") {
        octx.strokeStyle = color;
        octx.lineWidth = size;
        octx.lineCap = "round";
        octx.beginPath();
        octx.moveTo(start.x, start.y);
        octx.lineTo(p.x, start.y); // düz yatay çizgi
        octx.stroke();
      }
    });

    const endDraw = (e) => {
      if (!drawing) return;
      drawing = false;

      // Kağıt rengi modunda son rengi tüm seçim çevresinden yeniden örnekle
      if (currentTool === "erase" && eraseMode === "paper" && lastP && snapshot) {
        octx.putImageData(snapshot, 0, 0);
        eraseColor = samplePaperColor(page, start.x, start.y, lastP.x, lastP.y);
        octx.fillStyle = eraseColor;
        octx.fillRect(
          Math.min(start.x, lastP.x), Math.min(start.y, lastP.y),
          Math.abs(lastP.x - start.x), Math.abs(lastP.y - start.y)
        );
      }

      snapshot = null;
      if (strokeSnapshot) {
        logChange({ page, kind: "stroke", type: strokeTool, snapshot: strokeSnapshot });
        strokeSnapshot = null;
      }
      try { overlay.releasePointerCapture(e.pointerId); } catch (_) {}
    };
    overlay.addEventListener("pointerup", endDraw);
    overlay.addEventListener("pointercancel", endDraw);
  }

  function hexToRgba(hex, alpha) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }

  // ---- Yazı kutuları ----

  function createTextBox(page, e) {
    const wrapRect = page.wrap.getBoundingClientRect();
    const box = document.createElement("div");
    box.className = "textbox";
    box.style.left = (e.clientX - wrapRect.left) + "px";
    box.style.top = (e.clientY - wrapRect.top) + "px";

    // Düzenlenebilir içerik (silme/taşıma butonlarından ayrı)
    const content = document.createElement("div");
    content.className = "tb-content";
    content.contentEditable = "true";
    content.spellcheck = false;
    content.style.color = colorPicker.value;
    applyTextFormat(content, textFormat);

    const move = document.createElement("button");
    move.className = "move";
    move.type = "button";
    move.textContent = "✥";
    move.title = "Taşı (sürükle)";

    const del = document.createElement("button");
    del.className = "del";
    del.type = "button";
    del.textContent = "✕";
    del.title = "Yazıyı sil";
    del.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      box.remove();
      removeChangeLogForEl(box);
      if (selectedBox === box) selectedBox = null;
    });

    box.append(move, del, content);
    page.wrap.appendChild(box);
    makeBoxDraggable(box, move, page);

    let textEntry = null;
    content.addEventListener("blur", () => {
      // İçerik boşsa kutuyu kaldır
      if (!content.innerText.replace(/\s/g, "")) {
        box.remove();
        removeChangeLogForEl(box);
        return;
      }
      if (!textEntry) {
        textEntry = logChange({ page, kind: "dom", type: "text", el: box, text: content.innerText });
      } else {
        textEntry.text = content.innerText;
        renderChanges();
      }
    });
    content.addEventListener("pointerdown", (ev) => {
      ev.stopPropagation();
      selectBox(box);
    });

    focusBox(content);
  }

  function focusBox(content) {
    // pointerdown içinde anında focus tarayıcı tarafından geri alınabilir
    setTimeout(() => {
      content.focus();
      const range = document.createRange();
      range.selectNodeContents(content);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }, 0);
  }

  /** Bir tb-content öğesine yazı biçimini (tip, boyut, kalın, italik, altı çizili) uygular. */
  function applyTextFormat(content, fmt) {
    content.style.fontFamily = fmt.fontFamily;
    content.style.fontSize = Math.max(8, fmt.fontSize) + "px";
    content.style.fontWeight = fmt.bold ? "700" : "400";
    content.style.fontStyle = fmt.italic ? "italic" : "normal";
    content.style.textDecoration = fmt.underline ? "underline" : "none";
    content.dataset.fontFamily = fmt.fontFamily;
    content.dataset.fontSize = content.style.fontSize;
    content.dataset.bold = fmt.bold ? "1" : "";
    content.dataset.italic = fmt.italic ? "1" : "";
    content.dataset.underline = fmt.underline ? "1" : "";
  }

  /** Seçili kutunun mevcut biçimini araç çubuğu kontrollerine ve genel biçim durumuna yansıtır. */
  function syncTextOptsToBox(content) {
    textFormat = {
      fontFamily: content.dataset.fontFamily || textFormat.fontFamily,
      fontSize: parseFloat(content.dataset.fontSize) || textFormat.fontSize,
      bold: !!content.dataset.bold,
      italic: !!content.dataset.italic,
      underline: !!content.dataset.underline,
    };
    fontFamilyPicker.value = textFormat.fontFamily;
    fontSizePicker.value = textFormat.fontSize;
    boldBtn.classList.toggle("active", textFormat.bold);
    italicBtn.classList.toggle("active", textFormat.italic);
    underlineTextBtn.classList.toggle("active", textFormat.underline);
  }

  function selectBox(box) {
    deselectBox();
    selectedBox = box;
    box.classList.add("selected");
    const content = box.querySelector(".tb-content");
    if (content) {
      syncTextOptsToBox(content);
      textOptsWrap.hidden = false;
    }
  }

  function deselectBox() {
    if (selectedBox) {
      selectedBox.classList.remove("selected");
      selectedBox = null;
    }
    if (currentTool !== "text") textOptsWrap.hidden = true;
  }

  function makeBoxDraggable(box, handle, page) {
    let dragging = false;
    let offX = 0, offY = 0;

    handle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      selectBox(box);
      dragging = true;
      const wrapRect = page.wrap.getBoundingClientRect();
      offX = e.clientX - wrapRect.left - box.offsetLeft;
      offY = e.clientY - wrapRect.top - box.offsetTop;
      handle.setPointerCapture(e.pointerId);
    });

    handle.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const wrapRect = page.wrap.getBoundingClientRect();
      box.style.left = (e.clientX - wrapRect.left - offX) + "px";
      box.style.top = (e.clientY - wrapRect.top - offY) + "px";
    });

    handle.addEventListener("pointerup", (e) => {
      dragging = false;
      try { handle.releasePointerCapture(e.pointerId); } catch (_) {}
    });
  }

  // ---- Resim ekleme (CV fotoğrafı gibi) ----

  /** Ekranda en çok görünen sayfayı bulur (resim oraya eklenir). */
  function mostVisiblePage() {
    let best = pages[0];
    let bestArea = -1;
    for (const page of pages) {
      const r = page.wrap.getBoundingClientRect();
      const visible =
        Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
      if (visible > bestArea) { bestArea = visible; best = page; }
    }
    return best;
  }

  async function handleImageFile(file) {
    showLoading("Resim hazırlanıyor…");
    try {
      let dataUrl, natW, natH;

      if (/\.pdf$/i.test(file.name) || file.type === "application/pdf") {
        // PDF seçildiyse ilk sayfasını resme çevir
        const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
        const p = await pdf.getPage(1);
        const vp = p.getViewport({ scale: 2 });
        const c = document.createElement("canvas");
        c.width = vp.width;
        c.height = vp.height;
        await p.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
        dataUrl = c.toDataURL("image/jpeg", JPEG_QUALITY);
        natW = vp.width; natH = vp.height;
      } else {
        dataUrl = await new Promise((res, rej) => {
          const fr = new FileReader();
          fr.onload = () => res(fr.result);
          fr.onerror = () => rej(fr.error);
          fr.readAsDataURL(file);
        });
        const probe = new Image();
        await new Promise((res, rej) => {
          probe.onload = res;
          probe.onerror = () => rej(new Error("Resim okunamadı"));
          probe.src = dataUrl;
        });
        natW = probe.naturalWidth; natH = probe.naturalHeight;
      }

      createImageBox(mostVisiblePage(), dataUrl, natW, natH);
    } catch (err) {
      console.error(err);
      alert("Resim eklenemedi. Geçerli bir resim veya PDF dosyası seçin.");
    } finally {
      hideLoading();
    }
  }

  function createImageBox(page, dataUrl, natW, natH) {
    const wrapRect = page.wrap.getBoundingClientRect();
    const maxW = wrapRect.width * 0.35;
    const w = Math.min(natW, maxW);
    const h = w * (natH / natW);

    const box = document.createElement("div");
    box.className = "imgbox";
    box.style.left = Math.max(8, (wrapRect.width - w) / 2) + "px";
    box.style.top = Math.max(8, (wrapRect.height - h) / 3) + "px";
    box.style.width = w + "px";

    const img = document.createElement("img");
    img.src = dataUrl;
    img.draggable = false;

    const del = document.createElement("button");
    del.className = "del";
    del.type = "button";
    del.textContent = "✕";
    del.title = "Resmi sil";
    del.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      box.remove();
      removeChangeLogForEl(box);
    });

    const resize = document.createElement("button");
    resize.className = "resize";
    resize.type = "button";
    resize.title = "Boyutlandır (sürükle)";

    box.append(img, del, resize);
    page.wrap.appendChild(box);
    logChange({ page, kind: "dom", type: "image", el: box });

    // Taşıma: kutunun kendisinden sürükle
    let dragging = false, offX = 0, offY = 0;
    box.addEventListener("pointerdown", (e) => {
      if (e.target === del || e.target === resize) return;
      if (currentTool !== "select" && currentTool !== "text") return;
      e.preventDefault();
      dragging = true;
      const r = page.wrap.getBoundingClientRect();
      offX = e.clientX - r.left - box.offsetLeft;
      offY = e.clientY - r.top - box.offsetTop;
      box.setPointerCapture(e.pointerId);
      box.classList.add("selected");
    });
    box.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const r = page.wrap.getBoundingClientRect();
      box.style.left = (e.clientX - r.left - offX) + "px";
      box.style.top = (e.clientY - r.top - offY) + "px";
    });
    box.addEventListener("pointerup", (e) => {
      dragging = false;
      box.classList.remove("selected");
      try { box.releasePointerCapture(e.pointerId); } catch (_) {}
    });

    // Boyutlandırma: sağ alt köşe, en-boy oranı korunur
    let resizing = false, startW = 0, startX = 0;
    resize.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      resizing = true;
      startW = box.offsetWidth;
      startX = e.clientX;
      resize.setPointerCapture(e.pointerId);
    });
    resize.addEventListener("pointermove", (e) => {
      if (!resizing) return;
      const newW = Math.max(24, startW + (e.clientX - startX));
      box.style.width = newW + "px";
    });
    resize.addEventListener("pointerup", (e) => {
      resizing = false;
      try { resize.releasePointerCapture(e.pointerId); } catch (_) {}
    });
  }

  // ================= Birleştirme (export) =================

  // ---- Zengin metin çözümleme (kısmi büyütme/küçültme, kalın/italik/altı çizili) ----

  function isBlockNode(node) {
    if (node.nodeType !== 1) return false;
    if (node.tagName === "DIV" || node.tagName === "P") return true;
    try { return getComputedStyle(node).display === "block"; } catch (_) { return false; }
  }

  function styleFromNode(node, inherited) {
    const style = { ...inherited };
    if (node.nodeType !== 1) return style;
    const tag = node.tagName;
    if (tag === "B" || tag === "STRONG") style.bold = true;
    if (tag === "I" || tag === "EM") style.italic = true;
    if (tag === "U") style.underline = true;
    const inlineStyle = node.style;
    if (!inlineStyle) return style;
    if (inlineStyle.fontSize) style.fontPx = parseFloat(inlineStyle.fontSize);
    if (inlineStyle.fontFamily) style.fontFamily = inlineStyle.fontFamily;
    if (inlineStyle.color) style.color = inlineStyle.color;
    if (inlineStyle.fontWeight) {
      const fw = inlineStyle.fontWeight;
      style.bold = fw === "bold" || fw === "bolder" || parseInt(fw, 10) >= 600;
    }
    if (inlineStyle.fontStyle) style.italic = inlineStyle.fontStyle === "italic";
    if (inlineStyle.textDecoration) style.underline = inlineStyle.textDecoration.includes("underline");
    return style;
  }

  /** tb-content içeriğini satır satır, her satırı biçim korunmuş metin parçalarına (run) ayırır. */
  function collectRichLines(content, baseStyle) {
    const lines = [[]];
    function pushText(text, style) {
      if (text) lines[lines.length - 1].push({ text, style });
    }
    function walk(node, inherited) {
      node.childNodes.forEach((child) => {
        if (child.nodeType === 3) {
          pushText(child.textContent, inherited);
          return;
        }
        if (child.nodeType !== 1) return;
        if (child.tagName === "BR") {
          lines.push([]);
          return;
        }
        const startNewLine = isBlockNode(child) && !(lines.length === 1 && lines[0].length === 0);
        if (startNewLine) lines.push([]);
        walk(child, styleFromNode(child, inherited));
      });
    }
    walk(content, baseStyle);
    return lines;
  }

  function fontStringFor(style, scale) {
    const px = Math.max(1, style.fontPx * scale);
    return `${style.italic ? "italic " : "normal "}${style.bold ? "700" : "400"} ${px}px ${style.fontFamily}`;
  }

  /** Satırları verilen genişliğe göre kelime bazlı satır kaydırmasıyla böler. */
  function wrapRichLine(runs, maxWidth, ctx, scale) {
    const out = [];
    let line = [];
    let lineWidth = 0;
    for (const run of runs) {
      const parts = run.text.split(/(\s+)/).filter((p) => p !== "");
      for (const part of parts) {
        ctx.font = fontStringFor(run.style, scale);
        const w = ctx.measureText(part).width;
        if (lineWidth + w > maxWidth && line.length > 0 && part.trim() !== "") {
          out.push(line);
          line = [];
          lineWidth = 0;
        }
        line.push({ text: part, style: run.style, width: w });
        lineWidth += w;
      }
    }
    out.push(line);
    return out;
  }

  /** Bir yazı kutusunu, kısmi (seçili metin) biçimlendirmeler dahil, canvas'a çizer. */
  function drawTextBox(ctx, content, x, yTop, maxWidth, scale) {
    const baseStyle = {
      fontPx: parseFloat(content.dataset.fontSize || content.style.fontSize || "16"),
      fontFamily: content.dataset.fontFamily || content.style.fontFamily || "'Segoe UI', Arial, sans-serif",
      bold: !!content.dataset.bold,
      italic: !!content.dataset.italic,
      underline: !!content.dataset.underline,
      color: content.style.color || "#000",
    };
    const lineGroups = collectRichLines(content, baseStyle);
    ctx.textBaseline = "top";

    let y = yTop;
    lineGroups.forEach((runs) => {
      const wrapped = runs.length ? wrapRichLine(runs, maxWidth, ctx, scale) : [[]];
      wrapped.forEach((tokens) => {
        const maxPx = tokens.length
          ? Math.max(...tokens.map((t) => t.style.fontPx)) * scale
          : baseStyle.fontPx * scale;
        let cx = x;
        tokens.forEach((tok) => {
          ctx.font = fontStringFor(tok.style, scale);
          ctx.fillStyle = tok.style.color;
          ctx.fillText(tok.text, cx, y);
          if (tok.style.underline && tok.text.trim() !== "") {
            const px = Math.max(1, tok.style.fontPx * scale);
            const uy = y + px * 1.05;
            ctx.save();
            ctx.strokeStyle = tok.style.color;
            ctx.lineWidth = Math.max(1, px * 0.06);
            ctx.beginPath();
            ctx.moveTo(cx, uy);
            ctx.lineTo(cx + tok.width, uy);
            ctx.stroke();
            ctx.restore();
          }
          cx += tok.width;
        });
        y += maxPx * 1.25;
      });
    });
  }

  /** Sayfayı (PDF + çizimler + yazılar) tek bir canvas'ta birleştirir. */
  function compositePage(page) {
    const out = document.createElement("canvas");
    out.width = page.base.width;
    out.height = page.base.height;
    const ctx = out.getContext("2d");
    ctx.drawImage(page.base, 0, 0);
    ctx.drawImage(page.overlay, 0, 0);

    const scale = cssScale(page);
    const wrapRect = page.wrap.getBoundingClientRect();

    // Eklenen resimler — CSS konumundan canvas ölçeğine çevir
    page.wrap.querySelectorAll(".imgbox img").forEach((img) => {
      const r = img.getBoundingClientRect();
      ctx.drawImage(
        img,
        (r.left - wrapRect.left) * scale,
        (r.top - wrapRect.top) * scale,
        r.width * scale,
        r.height * scale
      );
    });

    // Yazı kutuları
    page.wrap.querySelectorAll(".textbox .tb-content").forEach((content) => {
      const text = content.innerText.replace(/\s+$/, "");
      if (!text.trim()) return;
      const rect = content.getBoundingClientRect();
      const x = (rect.left - wrapRect.left) * scale;
      const yTop = (rect.top - wrapRect.top) * scale;
      const maxWidth = Math.max(20, rect.width) * scale;
      drawTextBox(ctx, content, x, yTop, maxWidth, scale);
    });

    return out;
  }

  async function buildPdfBlob() {
    const { PDFDocument } = PDFLib;
    const doc = await PDFDocument.create();

    for (const page of pages) {
      const canvas = compositePage(page);
      const dataUrl = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
      const jpg = await doc.embedJpg(dataUrl);
      const p = doc.addPage([page.ptWidth, page.ptHeight]);
      p.drawImage(jpg, { x: 0, y: 0, width: page.ptWidth, height: page.ptHeight });
    }

    const bytes = await doc.save();
    return new Blob([bytes], { type: "application/pdf" });
  }

  function editedFileName() {
    const base = docName.replace(/\.pdf$/i, "");
    return `${base}-duzenlenmis.pdf`;
  }

  // ---- Kaydet ----

  async function savePdf() {
    if (pages.length === 0) return;
    showLoading("PDF oluşturuluyor…");
    try {
      deselectBox();
      const blob = await buildPdfBlob();
      const name = editedFileName();

      // Geçmişe kaydet
      try { await PdfStore.save(name, blob); } catch (e) { console.warn("Geçmişe kaydedilemedi:", e); }

      // İndir
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (err) {
      console.error(err);
      alert("PDF kaydedilirken bir hata oluştu.");
    } finally {
      hideLoading();
    }
  }

  // ---- Yazdır ----

  async function printPdf() {
    if (pages.length === 0) return;
    showLoading("Yazdırma hazırlanıyor…");
    try {
      deselectBox();

      // Sayfaları görüntü olarak aynı belge içindeki gizli yazdırma alanına koy,
      // sonra tarayıcının kendi yazdırma penceresini aç (yazıcı seçimi +
      // "PDF olarak kaydet" seçeneği oradan geliyor).
      let printArea = document.getElementById("printArea");
      if (printArea) printArea.remove();
      printArea = document.createElement("div");
      printArea.id = "printArea";
      document.body.appendChild(printArea);

      const decodes = pages.map((p) => {
        const img = document.createElement("img");
        img.src = compositePage(p).toDataURL("image/jpeg", JPEG_QUALITY);
        printArea.appendChild(img);
        return img.decode().catch(() => {});
      });
      await Promise.all(decodes);

      hideLoading();
      window.print();
      printArea.remove();
    } catch (err) {
      console.error(err);
      hideLoading();
      alert("Yazdırma hazırlanırken bir hata oluştu.");
    }
  }

  // ================= Geçmiş paneli =================

  function formatDate(ts) {
    return new Date(ts).toLocaleString("tr-TR", {
      day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  }

  function formatSize(bytes) {
    if (bytes > 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB";
    return Math.round(bytes / 1024) + " KB";
  }

  async function renderHistory() {
    let items = [];
    try { items = await PdfStore.list(); } catch (e) { console.warn(e); }

    historyList.innerHTML = "";
    if (items.length === 0) {
      historyList.innerHTML = '<p class="empty">Henüz kaydedilmiş PDF yok.<br>Bir PDF düzenleyip "PDF Kaydet" deyince burada görünür.</p>';
      return;
    }

    for (const item of items) {
      const div = document.createElement("div");
      div.className = "history-item";
      div.innerHTML = `
        <span class="name">📄 ${item.name}</span>
        <span class="date">${formatDate(item.date)} · ${formatSize(item.size)}</span>
        <div class="row">
          <button class="action-btn" data-act="open">👁️ Aç / Düzenle</button>
          <button class="action-btn" data-act="download">⬇️ İndir</button>
          <button class="action-btn" data-act="delete">🗑️ Sil</button>
        </div>`;

      div.querySelector('[data-act="open"]').addEventListener("click", async () => {
        const rec = await PdfStore.get(item.id);
        if (!rec) return;
        toggleHistory(false);
        const buf = await rec.blob.arrayBuffer();
        await loadPdf(buf, rec.name);
      });

      div.querySelector('[data-act="download"]').addEventListener("click", async () => {
        const rec = await PdfStore.get(item.id);
        if (!rec) return;
        const url = URL.createObjectURL(rec.blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = rec.name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      });

      div.querySelector('[data-act="delete"]').addEventListener("click", async () => {
        if (!confirm(`"${item.name}" geçmişten silinsin mi?`)) return;
        await PdfStore.remove(item.id);
        renderHistory();
      });

      historyList.appendChild(div);
    }
  }

  // ---- Değişiklik günlüğü (bu belgede yapılan tekil düzenlemeler) ----

  const CHANGE_LABELS = {
    draw: { icon: "✏️", label: "Karalama" },
    erase: { icon: "🧽", label: "Yazı silindi" },
    highlight: { icon: "🖍️", label: "Fosforlu işaret" },
    underline: { icon: "〰️", label: "Altı çizildi" },
    text: { icon: "🅰️", label: "Yazı eklendi" },
    image: { icon: "🖼️", label: "Resim eklendi" },
  };

  function pageNumberOf(page) {
    return pages.indexOf(page) + 1;
  }

  /** Yeni bir değişikliği günlüğe ekler. kind: "stroke" (canvas'a çizilen) veya "dom" (yazı/resim kutusu). */
  function logChange({ page, kind, type, snapshot = null, el = null, text = "" }) {
    const meta = CHANGE_LABELS[type] || { icon: "📝", label: type };
    const entry = {
      id: ++changeSeq,
      page,
      kind,
      type,
      icon: meta.icon,
      label: meta.label,
      time: Date.now(),
      snapshot,
      el,
      text,
    };
    changeLog.unshift(entry);
    renderChanges();
    return entry;
  }

  function escapeHtml(str) {
    return str.replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function changeEntryTitle(entry) {
    if (entry.type === "text") {
      const preview = entry.text.trim().replace(/\s+/g, " ").slice(0, 40);
      return preview
        ? `🅰️ "${escapeHtml(preview)}${entry.text.trim().length > 40 ? "…" : ""}"`
        : "🅰️ Yazı eklendi";
    }
    return `${entry.icon} ${entry.label}`;
  }

  /** İlgili sayfaya/kutuya kaydırır ve düzenleme için seçili hale getirir. */
  function jumpToChange(entry) {
    toggleChanges(false);
    entry.page.wrap.scrollIntoView({ behavior: "smooth", block: "center" });
    if (entry.kind === "dom" && entry.el) {
      if (entry.type === "text") {
        setTool("select");
        selectBox(entry.el);
        const content = entry.el.querySelector(".tb-content");
        if (content) focusBox(content);
      } else {
        setTool("select");
        entry.el.classList.add("selected");
        setTimeout(() => entry.el.classList.remove("selected"), 1600);
      }
    } else {
      entry.page.wrap.classList.add("flash-highlight");
      setTimeout(() => entry.page.wrap.classList.remove("flash-highlight"), 900);
    }
  }

  /** Bir DOM tabanlı kutu (yazı/resim) kendi ✕ butonundan silindiğinde günlükten de temizler. */
  function removeChangeLogForEl(domEl) {
    const before = changeLog.length;
    changeLog = changeLog.filter((c) => c.el !== domEl);
    if (changeLog.length !== before) renderChanges();
  }

  function deleteChangeEntry(entry) {
    if (entry.kind === "dom") {
      if (entry.el) entry.el.remove();
      if (selectedBox === entry.el) selectedBox = null;
    } else if (entry.kind === "stroke") {
      const idx = entry.page.undoStack.indexOf(entry.snapshot);
      if (idx === -1) {
        alert("Bu işlem artık geri alınamıyor (çok fazla yeni işlem yapıldı).");
        return;
      }
      entry.page.octx.putImageData(entry.snapshot, 0, 0);
      entry.page.undoStack.length = idx;
      // Bu işlemden sonra aynı sayfada yapılan karalamalar da bu anlık görüntüye dahil, günlükten kaldırılmalı
      changeLog = changeLog.filter(
        (c) => !(c.kind === "stroke" && c.page === entry.page && c.id >= entry.id)
      );
      renderChanges();
      return;
    }
    changeLog = changeLog.filter((c) => c.id !== entry.id);
    renderChanges();
  }

  function renderChanges() {
    changesList.innerHTML = "";
    if (changeLog.length === 0) {
      changesList.innerHTML = '<p class="empty">Henüz bir değişiklik yapılmadı.</p>';
      return;
    }
    for (const entry of changeLog) {
      const div = document.createElement("div");
      div.className = "history-item";
      div.innerHTML = `
        <span class="name">${changeEntryTitle(entry)} — Sayfa ${pageNumberOf(entry.page)}</span>
        <span class="date">${formatDate(entry.time)}</span>
        <div class="row">
          <button class="action-btn" data-act="edit" title="Sayfaya git / düzenle">✏️ Git</button>
          <button class="action-btn" data-act="delete">🗑️ Sil</button>
        </div>`;
      div.querySelector('[data-act="edit"]').addEventListener("click", () => jumpToChange(entry));
      div.querySelector('[data-act="delete"]').addEventListener("click", () => {
        const hasLaterStrokes =
          entry.kind === "stroke" &&
          changeLog.some((c) => c.kind === "stroke" && c.page === entry.page && c.id > entry.id);
        const msg = hasLaterStrokes
          ? "Bu değişiklik geri alınsın mı? Not: bu sayfada bundan sonra yapılan karalama/silme/işaretleme işlemleri de birlikte geri alınacak."
          : "Bu değişiklik geri alınsın mı?";
        if (!confirm(msg)) return;
        deleteChangeEntry(entry);
      });
      changesList.appendChild(div);
    }
  }

  function toggleChanges(show) {
    if (show) historyPanel.hidden = true;
    changesPanel.hidden = !show;
    overlayBg.hidden = !show;
    if (show) renderChanges();
  }

  function toggleHistory(show) {
    if (show) changesPanel.hidden = true;
    historyPanel.hidden = !show;
    overlayBg.hidden = !show;
    if (show) renderHistory();
  }

  // ================= Olay bağlama =================

  // Araç butonları
  document.querySelectorAll(".tool-btn[data-tool]").forEach((btn) => {
    btn.addEventListener("click", () => setTool(btn.dataset.tool));
  });

  el("undoBtn").addEventListener("click", undoLast);
  el("saveBtn").addEventListener("click", savePdf);
  el("printBtn").addEventListener("click", printPdf);
  el("closeBtn").addEventListener("click", () => {
    if (confirm("Belge kapatılsın mı? Kaydedilmemiş değişiklikler kaybolur.")) closeDocument();
  });

  // Renk kareleri
  document.querySelectorAll(".swatch").forEach((sw) => {
    sw.addEventListener("click", () => {
      colorPicker.value = sw.dataset.color;
      document.querySelectorAll(".swatch").forEach((s) => s.classList.remove("active"));
      sw.classList.add("active");
    });
  });
  colorPicker.addEventListener("input", () => {
    document.querySelectorAll(".swatch").forEach((s) =>
      s.classList.toggle("active", s.dataset.color === colorPicker.value)
    );
    if (selectedBox) {
      const content = selectedBox.querySelector(".tb-content");
      if (content) content.style.color = colorPicker.value;
    }
  });

  // Yazı biçim seçenekleri (yazı tipi, boyut, kalın, italik, altı çizili)
  function currentTextTarget() {
    return selectedBox ? selectedBox.querySelector(".tb-content") : null;
  }

  /** Odaklanmış bir tb-content içinde, boş olmayan (gerçek) bir metin seçimi varsa onu döndürür. */
  function getActiveTextSelection() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    const anchor = range.commonAncestorContainer;
    const anchorEl = anchor.nodeType === 1 ? anchor : anchor.parentElement;
    const content = anchorEl ? anchorEl.closest(".tb-content") : null;
    if (!content) return null;
    return { sel, range, content };
  }

  /** Seçili aralığı yeni bir span ile sarar (aralık birden çok düğüme yayılsa bile). */
  function wrapRangeInSpan(range, applyStyle) {
    const span = document.createElement("span");
    applyStyle(span);
    try {
      range.surroundContents(span);
    } catch (_) {
      const frag = range.extractContents();
      span.appendChild(frag);
      range.insertNode(span);
    }
    return span;
  }

  function reselect(sel, node) {
    sel.removeAllRanges();
    const r = document.createRange();
    r.selectNodeContents(node);
    sel.addRange(r);
  }

  /** Seçili metnin boyutunu, seçim yoksa tüm kutunun boyutunu ölçeklendirir. */
  function stepFontSize(factor) {
    const active = getActiveTextSelection();
    if (active) {
      const { sel, range, content } = active;
      const startEl = range.startContainer.nodeType === 1
        ? range.startContainer
        : range.startContainer.parentElement;
      const currentPx = parseFloat(getComputedStyle(startEl).fontSize) || textFormat.fontSize;
      const newPx = Math.max(6, Math.min(300, Math.round(currentPx * factor)));
      const span = wrapRangeInSpan(range, (s) => { s.style.fontSize = newPx + "px"; });
      reselect(sel, span);
      content.dispatchEvent(new Event("blur")); // önizleme metnini güncelle
      return;
    }
    const content = currentTextTarget();
    const basePx = content ? parseFloat(content.dataset.fontSize) || textFormat.fontSize : textFormat.fontSize;
    textFormat.fontSize = Math.max(6, Math.min(300, Math.round(basePx * factor)));
    fontSizePicker.value = textFormat.fontSize;
    if (content) applyTextFormat(content, textFormat);
  }

  /** Seçili metne kalın/italik/altı çizili uygular, seçim yoksa tüm kutuya uygular. */
  function toggleInlineStyle(prop, btn) {
    const active = getActiveTextSelection();
    if (active) {
      const { sel, range } = active;
      const startEl = range.startContainer.nodeType === 1
        ? range.startContainer
        : range.startContainer.parentElement;
      const cs = getComputedStyle(startEl);
      const isOn =
        prop === "bold" ? (cs.fontWeight === "bold" || parseInt(cs.fontWeight, 10) >= 600) :
        prop === "italic" ? cs.fontStyle === "italic" :
        (cs.textDecorationLine || cs.textDecoration || "").includes("underline");
      const span = wrapRangeInSpan(range, (s) => {
        if (prop === "bold") s.style.fontWeight = isOn ? "400" : "700";
        if (prop === "italic") s.style.fontStyle = isOn ? "normal" : "italic";
        if (prop === "underline") s.style.textDecoration = isOn ? "none" : "underline";
      });
      reselect(sel, span);
      return;
    }
    textFormat[prop] = !textFormat[prop];
    btn.classList.toggle("active", textFormat[prop]);
    const content = currentTextTarget();
    if (content) applyTextFormat(content, textFormat);
  }

  // Butonlar tıklanırken contenteditable'daki metin seçiminin kaybolmaması için
  [fontDecBtn, fontIncBtn, boldBtn, italicBtn, underlineTextBtn].forEach((btn) => {
    btn.addEventListener("mousedown", (e) => e.preventDefault());
  });

  fontFamilyPicker.addEventListener("change", () => {
    textFormat.fontFamily = fontFamilyPicker.value;
    const content = currentTextTarget();
    if (content) applyTextFormat(content, textFormat);
  });

  fontSizePicker.addEventListener("input", () => {
    textFormat.fontSize = Number(fontSizePicker.value) || textFormat.fontSize;
    const content = currentTextTarget();
    if (content) applyTextFormat(content, textFormat);
  });

  fontDecBtn.addEventListener("click", () => stepFontSize(1 / 1.15));
  fontIncBtn.addEventListener("click", () => stepFontSize(1.15));

  boldBtn.addEventListener("click", () => toggleInlineStyle("bold", boldBtn));
  italicBtn.addEventListener("click", () => toggleInlineStyle("italic", italicBtn));
  underlineTextBtn.addEventListener("click", () => toggleInlineStyle("underline", underlineTextBtn));

  // Silgi modu (Beyaz / Kağıt Rengi)
  document.querySelectorAll(".mode-btn[data-emode]").forEach((btn) => {
    btn.addEventListener("click", () => {
      eraseMode = btn.dataset.emode;
      document.querySelectorAll(".mode-btn[data-emode]").forEach((b) =>
        b.classList.toggle("active", b === btn)
      );
    });
  });

  // Resim / PDF ekleme
  const imageInput = el("imageInput");
  const pdfChoiceModal = el("pdfChoiceModal");
  let pendingPdfFile = null;

  el("addImageBtn").addEventListener("click", () => {
    if (pages.length === 0) return;
    imageInput.click();
  });

  imageInput.addEventListener("change", async () => {
    const file = imageInput.files[0];
    imageInput.value = "";
    if (!file) return;
    if (/\.pdf$/i.test(file.name) || file.type === "application/pdf") {
      // PDF seçildi: üst üste mi, alt alta mı diye sor
      pendingPdfFile = file;
      pdfChoiceModal.hidden = false;
      return;
    }
    setTool("select"); // resim eklenince taşınabilsin
    await handleImageFile(file);
  });

  el("pdfOverlayBtn").addEventListener("click", async () => {
    pdfChoiceModal.hidden = true;
    if (!pendingPdfFile) return;
    const file = pendingPdfFile;
    pendingPdfFile = null;
    setTool("select");
    await handleImageFile(file);
  });

  el("pdfAppendBtn").addEventListener("click", async () => {
    pdfChoiceModal.hidden = true;
    if (!pendingPdfFile) return;
    const file = pendingPdfFile;
    pendingPdfFile = null;
    await appendPdfPages(file);
  });

  el("pdfCancelBtn").addEventListener("click", () => {
    pdfChoiceModal.hidden = true;
    pendingPdfFile = null;
  });

  el("historyBtn").addEventListener("click", () => toggleHistory(historyPanel.hidden));
  el("historyCloseBtn").addEventListener("click", () => toggleHistory(false));
  el("changesBtn").addEventListener("click", () => toggleChanges(changesPanel.hidden));
  el("changesCloseBtn").addEventListener("click", () => toggleChanges(false));
  overlayBg.addEventListener("click", () => {
    toggleHistory(false);
    toggleChanges(false);
  });

  // Dosya seçme + sürükle bırak
  el("pickFileBtn").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files[0];
    if (file) await loadPdf(await file.arrayBuffer(), file.name);
  });

  ["dragover", "dragenter"].forEach((ev) =>
    dropzoneEl.addEventListener(ev, (e) => {
      e.preventDefault();
      dropzoneEl.classList.add("dragover");
    })
  );
  ["dragleave", "drop"].forEach((ev) =>
    dropzoneEl.addEventListener(ev, (e) => {
      e.preventDefault();
      dropzoneEl.classList.remove("dragover");
    })
  );
  dropzoneEl.addEventListener("drop", async (e) => {
    const file = e.dataTransfer.files[0];
    if (!file) return;
    if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") {
      alert("Lütfen bir PDF dosyası bırakın.");
      return;
    }
    await loadPdf(await file.arrayBuffer(), file.name);
  });

  // Klavye kısayolları
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.key.toLowerCase() === "z" && !e.target.isContentEditable) {
      e.preventDefault();
      undoLast();
    }
    if (e.key === "Delete" && selectedBox && !e.target.isContentEditable) {
      selectedBox.remove();
      selectedBox = null;
    }
  });

  // Sayfa boşluğuna tıklayınca yazı kutusu seçimini kaldır
  document.addEventListener("pointerdown", (e) => {
    if (!e.target.closest(".textbox")) deselectBox();
  });
})();
