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
  const loadingEl = el("loading");
  const loadingText = el("loadingText");
  const historyPanel = el("historyPanel");
  const historyList = el("historyList");
  const overlayBg = el("overlayBg");

  // ---- Durum ----
  let currentTool = "select";
  let pages = [];          // { wrap, base, overlay, octx, undoStack, ptWidth, ptHeight }
  let docName = "belge.pdf";
  let selectedBox = null;

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
      start = toCanvasPoint(overlay, e);
      lastP = start;
      pushUndo(page);
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
    content.style.fontSize = Math.max(12, Number(sizePicker.value) * 4) + "px";
    content.dataset.fontSize = content.style.fontSize;

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
      if (selectedBox === box) selectedBox = null;
    });

    box.append(move, del, content);
    page.wrap.appendChild(box);
    makeBoxDraggable(box, move, page);

    content.addEventListener("blur", () => {
      // İçerik boşsa kutuyu kaldır
      if (!content.innerText.replace(/\s/g, "")) box.remove();
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

  function selectBox(box) {
    deselectBox();
    selectedBox = box;
    box.classList.add("selected");
  }

  function deselectBox() {
    if (selectedBox) {
      selectedBox.classList.remove("selected");
      selectedBox = null;
    }
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
    });

    const resize = document.createElement("button");
    resize.className = "resize";
    resize.type = "button";
    resize.title = "Boyutlandır (sürükle)";

    box.append(img, del, resize);
    page.wrap.appendChild(box);

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
      const fontPx = parseFloat(content.dataset.fontSize || content.style.fontSize || "16") * scale;
      ctx.fillStyle = content.style.color || "#000";
      ctx.font = `${fontPx}px "Segoe UI", Arial, sans-serif`;
      ctx.textBaseline = "top";
      const lineHeight = fontPx * 1.25;
      text.split("\n").forEach((line, idx) => {
        ctx.fillText(line, x, yTop + idx * lineHeight);
      });
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

  function toggleHistory(show) {
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
  });

  // Silgi modu (Beyaz / Kağıt Rengi)
  document.querySelectorAll(".mode-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      eraseMode = btn.dataset.emode;
      document.querySelectorAll(".mode-btn").forEach((b) =>
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
  overlayBg.addEventListener("click", () => toggleHistory(false));

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
