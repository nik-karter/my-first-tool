(() => {
  const $ = (id) => document.getElementById(id);
  const searchEl = $('search');
  const resultsEl = $('results');
  const fileEl = $('file');
  const statusEl = $('status');
  const reportEl = $('report');
  const summaryEl = $('summary');
  const bitmapCache = new Map();

  const fmt = new Intl.DateTimeFormat('he-IL', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });

  function startOfToday() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  async function purgeOld() {
    const removed = await DB.purgeBefore(startOfToday());
    if (removed) bitmapCache.clear();
    return removed;
  }

  async function getBitmap(imageId) {
    if (!bitmapCache.has(imageId)) {
      bitmapCache.set(imageId, DB.getImage(imageId).then((img) => OCR.loadBitmap(img.blob)));
    }
    return bitmapCache.get(imageId);
  }

  // חותך את פס השורה: רוחב הטבלה, מיושר לפי זווית הצילום (אפשר להוסיף שורות סמוכות)
  function drawBand(canvas, bitmap, entry, extraRows = 0) {
    const k = bitmap.width; // המידות שמורות ביחס לרוחב התמונה
    const s = entry.strip;
    const top = s.top - extraRows * entry.pitch;
    const bottom = s.bottom + extraRows * entry.pitch;
    canvas.width = Math.max(1, Math.round((s.right - s.left) * k));
    canvas.height = Math.max(1, Math.round((bottom - top) * k));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(1, 0, 0, 1, -s.left * k, -top * k);
    ctx.rotate(entry.angle);
    ctx.drawImage(bitmap, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // מסגרת סביב המספר שנמצא
    const m = entry.mark;
    ctx.strokeStyle = '#e02424';
    ctx.lineWidth = Math.max(2, canvas.width / 300);
    ctx.strokeRect((m.cx - m.w / 2 - s.left) * k - 4, (m.cy - m.h / 2 - top) * k - 4, m.w * k + 8, m.h * k + 8);
  }

  // ---------- חיפוש ----------
  let searchSeq = 0;
  async function runSearch() {
    const q = searchEl.value.replace(/\D/g, '');
    if (searchEl.value !== q) searchEl.value = q;
    const seq = ++searchSeq;
    resultsEl.textContent = '';
    if (q.length < 3) return;

    await purgeOld();
    const all = await DB.allEntries();
    const matches = all
      .filter((e) => e.number.includes(q))
      .sort((a, b) => (b.number === q) - (a.number === q) || b.imageId - a.imageId)
      .slice(0, 20);
    if (seq !== searchSeq) return;

    if (!matches.length) {
      resultsEl.innerHTML = '<p class="hint">לא נמצאה שיירה עם המספר הזה בתמונות של היום.</p>';
      return;
    }
    const images = new Map((await DB.allImagesMeta()).map((m) => [m.id, m]));
    for (const entry of matches) {
      const bitmap = await getBitmap(entry.imageId);
      if (seq !== searchSeq) return;
      const meta = images.get(entry.imageId);
      const div = document.createElement('div');
      div.className = 'result';
      const title = document.createElement('div');
      title.innerHTML = 'שיירה <span class="num"></span>';
      title.querySelector('.num').textContent = entry.number;
      const canvas = document.createElement('canvas');
      drawBand(canvas, bitmap, entry);
      canvas.addEventListener('click', () => openViewer(entry, bitmap, meta));
      const info = document.createElement('div');
      info.className = 'meta';
      info.textContent = `הועלה: ${fmt.format(meta.uploadedAt)} · לחץ על הפס להגדלה`;
      div.append(title, canvas, info);
      resultsEl.append(div);
    }
  }
  searchEl.addEventListener('input', runSearch);

  // ---------- מסך הגדלה ----------
  const viewer = $('viewer');
  const viewerCanvas = $('viewer-canvas');
  const viewerBody = viewer.querySelector('.viewer-body');
  let view = null;

  function renderViewer() {
    drawBand(viewerCanvas, view.bitmap, view.entry, view.extraRows);
    viewerCanvas.style.width = `${Math.round(viewerBody.clientWidth * view.zoom)}px`;
    viewer.querySelector('[data-act=ctx]').textContent = view.extraRows ? 'שורה אחת בלבד' : 'הצג שורות סמוכות';
  }

  function openViewer(entry, bitmap, meta) {
    view = { entry, bitmap, zoom: 2, extraRows: 0 };
    $('viewer-caption').textContent = `שיירה ${entry.number} · הועלה: ${fmt.format(meta.uploadedAt)}`;
    viewer.hidden = false;
    renderViewer();
    // בטבלה מימין לשמאל – מתחילים מהצד הימני של השורה
    viewerBody.scrollLeft = viewerBody.scrollWidth;
    history.pushState({ viewer: true }, '');
  }

  function closeViewer() {
    viewer.hidden = true;
    view = null;
  }

  viewer.querySelector('.viewer-bar').addEventListener('click', (ev) => {
    const act = ev.target.dataset.act;
    if (!act || !view) return;
    if (act === 'close') { history.back(); return; }
    if (act === 'in') view.zoom = Math.min(8, view.zoom * 1.5);
    if (act === 'out') view.zoom = Math.max(1, view.zoom / 1.5);
    if (act === 'ctx') view.extraRows = view.extraRows ? 0 : 2;
    renderViewer();
  });
  // כפתור "חזרה" של אנדרואיד סוגר את ההגדלה במקום לצאת מהאפליקציה
  window.addEventListener('popstate', () => { if (!viewer.hidden) closeViewer(); });

  // ---------- העלאה ----------
  function setStatus(text, progress) {
    statusEl.textContent = text;
    if (progress != null) {
      const p = document.createElement('progress');
      p.max = 1;
      p.value = progress;
      statusEl.append(document.createElement('br'), p);
    }
  }

  function drawReport(bitmap, result, fileName) {
    const item = document.createElement('div');
    item.className = 'report-item';
    const scale = Math.min(1, 1200 / bitmap.width);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const W = canvas.width, H = canvas.height;
    const box = (b, color, dash) => {
      ctx.setLineDash(dash ? [6, 4] : []);
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.strokeRect(b.x0 * W - 3, b.y0 * H - 3, (b.x1 - b.x0) * W + 6, (b.y1 - b.y0) * H + 6);
    };
    result.nearMiss.forEach((e) => box(e.box, '#8a8f98', true));
    result.rejected.forEach((e) => box(e.box, '#c7771a'));
    result.entries.forEach((e) => box(e.box, '#1d8a4a'));

    const head = document.createElement('div');
    head.innerHTML = '<b></b>';
    head.querySelector('b').textContent = `${fileName}: זוהו ${result.entries.length} שיירות`;
    const legend = document.createElement('div');
    legend.className = 'legend';
    legend.innerHTML = '<span class="g">■ ירוק</span> נשמר · <span class="o">■ כתום</span> 6 ספרות מחוץ לעמודה הימנית (לא נשמר) · ▭ אפור מקווקו: מספר עם 5/7/8 ספרות (כנראה זיהוי שגוי)';
    const chips = document.createElement('div');
    chips.className = 'chips';
    for (const e of result.entries) {
      const c = document.createElement('span');
      c.className = 'chip';
      c.textContent = e.number;
      chips.append(c);
    }
    item.append(head, legend, canvas, chips);
    reportEl.prepend(item);
  }

  fileEl.addEventListener('change', async () => {
    const files = [...fileEl.files];
    fileEl.value = '';
    if (!files.length) return;
    fileEl.disabled = true;
    await purgeOld();
    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const label = files.length > 1 ? `תמונה ${i + 1} מתוך ${files.length}` : 'התמונה';
        setStatus(`מעבד את ${label}…`);
        const result = await OCR.analyze(file, (m) => {
          const what = m.status === 'recognizing text' ? `סורק את ${label}`
            : m.status === 'reading rows' ? `קורא את השורות ב${label}`
            : 'טוען את מנוע הזיהוי';
          setStatus(`${what}…`, m.progress);
        });
        const uploadedAt = Date.now();
        const imageId = await DB.addImage(
          { blob: file, uploadedAt, name: file.name, count: result.entries.length },
          result.entries,
        );
        bitmapCache.set(imageId, Promise.resolve(result.bitmap));
        drawReport(result.bitmap, result, file.name || label);
      }
      setStatus('✔ הסתיים. אפשר לחפש.');
    } catch (err) {
      console.error(err);
      setStatus(`שגיאה: ${err && err.message ? err.message : err}`);
    } finally {
      fileEl.disabled = false;
      refreshSummary();
      runSearch();
    }
  });

  // ---------- סיכום ומחיקה ----------
  async function refreshSummary() {
    const images = await DB.allImagesMeta();
    const count = images.reduce((s, m) => s + (m.count || 0), 0);
    summaryEl.textContent = images.length
      ? `שמורות היום: ${images.length} תמונות, ${count} שיירות. הכל יימחק אוטומטית מחר.`
      : 'אין נתונים שמורים כרגע.';
  }

  $('clear').addEventListener('click', async () => {
    if (!confirm('למחוק את כל התמונות והמספרים מהטלפון?')) return;
    await DB.clearAll();
    bitmapCache.clear();
    reportEl.textContent = '';
    resultsEl.textContent = '';
    setStatus('');
    refreshSummary();
  });

  async function onVisible() {
    if (document.visibilityState !== 'visible') return;
    if (await purgeOld()) {
      reportEl.textContent = '';
      runSearch();
    }
    refreshSummary();
  }
  document.addEventListener('visibilitychange', onVisible);
  onVisible();
})();
