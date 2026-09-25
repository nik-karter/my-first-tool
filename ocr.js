// זיהוי טקסט בדפדפן בלבד. כל קובצי המנוע נטענים מהאתר עצמו (תיקיית vendor), לא מאתר חיצוני.
//
// שלבים:
// 1. מעבר ראשון על כל התמונה – מוצא מספרים בני 6 ספרות ואת מיקום כל הטקסט בטבלה.
// 2. בוחר את העמודה הימנית ביותר.
// 3. עובר על העמודה שורה-שורה וקורא כל תא בנפרד (מדויק יותר, ומשלים שורות שפוספסו).
// 4. מחשב לכל שורה "פס" – מלבן (מיושר לפי זווית הצילום) שמכסה את כל רוחב הטבלה.
const OCR = (() => {
  const MAX_SIDE = 2400; // מקטינים תמונות ענק כדי שהזיהוי בטלפון לא ייקח נצח
  const base = new URL('vendor/', document.baseURI).href;
  const SPARSE = { tessedit_pageseg_mode: '11', tessedit_char_whitelist: '' };
  const CELL = { tessedit_pageseg_mode: '7', tessedit_char_whitelist: '0123456789' };
  let workerPromise;
  let progressCb = () => {};

  function getWorker() {
    if (!workerPromise) {
      workerPromise = Tesseract.createWorker('eng', Tesseract.OEM.LSTM_ONLY, {
        workerPath: base + 'tesseract/worker.min.js',
        corePath: base + 'core/',
        langPath: base + 'lang/',
        workerBlobURL: false,
        logger: (m) => progressCb(m),
      }).then(async (worker) => {
        await worker.setParameters({ ...SPARSE, debug_file: '/dev/null' });
        return worker;
      });
      workerPromise.catch(() => { workerPromise = null; });
    }
    return workerPromise;
  }

  async function loadBitmap(blob) {
    return createImageBitmap(blob, { imageOrientation: 'from-image' });
  }

  // תמונה מוקטנת בגווני אפור עם מתיחת ניגודיות – עוזר בצילומי מסך מחשב
  function preprocess(bitmap) {
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    const hist = new Uint32Array(256);
    for (let i = 0; i < d.length; i += 4) {
      const g = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000 | 0;
      d[i] = g;
      hist[g]++;
    }
    const total = w * h;
    let lo = 0, hi = 255, acc = 0;
    while (lo < 255 && (acc += hist[lo]) < total * 0.02) lo++;
    acc = 0;
    while (hi > 0 && (acc += hist[hi]) < total * 0.02) hi--;
    const range = Math.max(1, hi - lo);
    for (let i = 0; i < d.length; i += 4) {
      const v = Math.max(0, Math.min(255, ((d[i] - lo) * 255) / range));
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  function median(values) {
    if (!values.length) return 0;
    const s = [...values].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  }

  const cy = (w) => (w.y0 + w.y1) / 2;
  const cx = (w) => (w.x0 + w.x1) / 2;

  // תיקון טעויות נפוצות (O במקום 0, l במקום 1) והשארת ספרות בלבד
  function toDigits(raw) {
    const t = raw.replace(/[Oo]/g, '0').replace(/[lI|]/g, '1').replace(/[.,:;'"`()[\]{}]/g, '');
    return /^\d+$/.test(t) ? t : '';
  }

  function flattenWords(data) {
    const out = [];
    for (const block of data.blocks || []) {
      for (const par of block.paragraphs || []) {
        for (const line of par.lines || []) {
          for (const w of line.words || []) {
            const raw = (w.text || '').trim();
            if (raw) out.push({ raw, text: toDigits(raw), conf: w.confidence, ...w.bbox });
          }
        }
      }
    }
    return out;
  }

  // בוחר רק את המספרים שבעמודה הימנית ביותר
  function pickRightColumn(words) {
    const six = words.filter((w) => /^\d{6}$/.test(w.text));
    if (!six.length) return { accepted: [], rejected: [] };

    const width = median(six.map((w) => w.x1 - w.x0));
    const sorted = [...six].sort((a, b) => cx(a) - cx(b));
    // חלוקה לעמודות לפי רווחים אופקיים בין מרכזי המספרים
    const clusters = [[sorted[0]]];
    for (let i = 1; i < sorted.length; i++) {
      if (cx(sorted[i]) - cx(sorted[i - 1]) > width * 0.8) clusters.push([]);
      clusters[clusters.length - 1].push(sorted[i]);
    }
    // העמודה הימנית ביותר שיש בה מספיק מספרים (כדי לא ליפול על רעש בודד בשוליים)
    const biggest = Math.max(...clusters.map((c) => c.length));
    const minSize = Math.min(biggest, Math.max(2, Math.ceil(biggest * 0.3)));
    let column = clusters[clusters.length - 1];
    for (let i = clusters.length - 1; i >= 0; i--) {
      if (clusters[i].length >= minSize) { column = clusters[i]; break; }
    }
    const accepted = new Set(column);
    return { accepted: column, rejected: six.filter((w) => !accepted.has(w)) };
  }

  // מרווח בין שורות. גם כשחלק מהשורות חסרות: כל מרווח מחולק למספר השורות שהוא כנראה מכיל
  function estimatePitch(column) {
    const byY = [...column].sort((a, b) => cy(a) - cy(b));
    const height = median(column.map((w) => w.y1 - w.y0));
    const gaps = [];
    for (let i = 1; i < byY.length; i++) {
      const g = cy(byY[i]) - cy(byY[i - 1]);
      if (g > height * 1.2) gaps.push(g);
    }
    if (!gaps.length) return height * 2;
    const unit = Math.min(...gaps);
    return median(gaps.map((g) => g / Math.max(1, Math.round(g / unit))));
  }

  // קו ישר שעובר במרכזי העמודה (x כפונקציה של y) – מתמודד עם צילום קצת עקום
  function fitColumnLine(column) {
    const n = column.length;
    const my = column.reduce((s, w) => s + cy(w), 0) / n;
    const mx = column.reduce((s, w) => s + cx(w), 0) / n;
    let num = 0, den = 0;
    for (const w of column) { num += (cy(w) - my) * (cx(w) - mx); den += (cy(w) - my) ** 2; }
    const slope = n >= 3 && den > 0 ? num / den : 0;
    return { slope, at: (y) => mx + slope * (y - my) };
  }

  // קורא תא בודד: חיתוך צמוד סביב המספר (בלי קווי הטבלה), גובה ספרות נוח למנוע, שוליים לבנים
  async function readCell(worker, bitmap, sx, x, y, width, height) {
    const cw = width * 1.2, ch = height * 1.5;
    const scale = 24 / (height * sx);
    const pad = 12;
    const c = document.createElement('canvas');
    c.width = Math.round(cw * sx * scale) + pad * 2;
    c.height = Math.round(ch * sx * scale) + pad * 2;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.filter = 'grayscale(1) contrast(1.3)';
    ctx.drawImage(bitmap, (x - cw / 2) * sx, (y - ch / 2) * sx, cw * sx, ch * sx,
      pad, pad, c.width - pad * 2, c.height - pad * 2);
    const { data } = await worker.recognize(c);
    return { text: (data.text || '').replace(/\D/g, ''), conf: data.confidence };
  }

  // עובר על העמודה שורה-שורה: קורא מחדש כל מספר שנמצא, משלים שורות חסרות וממשיך למעלה/למטה
  async function readColumn(worker, bitmap, column, W, H, onStep) {
    const sx = bitmap.width / W;
    const width = median(column.map((w) => w.x1 - w.x0));
    const height = median(column.map((w) => w.y1 - w.y0));
    const pitch = estimatePitch(column);
    const line = fitColumnLine(column);
    const found = [...column].sort((a, b) => cy(a) - cy(b));
    const inside = (y) => y - height >= 0 && y + height <= H;
    const read = (y) => readCell(worker, bitmap, sx, line.at(y), y, width, height);
    const rows = [];
    let step = 0;
    const tick = () => onStep(++step, found.length);

    await worker.setParameters(CELL);
    try {
      for (let i = 0; i < found.length; i++) {
        const w = found[i];
        const r = await read(cy(w));
        tick();
        rows.push(/^\d{6}$/.test(r.text) ? { text: r.text, conf: r.conf, x: cx(w), y: cy(w) }
                                          : { text: w.text, conf: w.conf, x: cx(w), y: cy(w) });
        // שורות חסרות בין המספר הקודם לנוכחי
        if (i > 0) {
          const a = cy(found[i - 1]), b = cy(w);
          const k = Math.round((b - a) / pitch);
          for (let j = 1; j < k; j++) {
            const y = a + ((b - a) * j) / k;
            const g = await read(y);
            if (/^\d{6}$/.test(g.text)) rows.push({ text: g.text, conf: g.conf, x: line.at(y), y });
          }
        }
      }
      // המשך למעלה ולמטה עד שנגמרים המספרים (שתי החטאות ברצף)
      for (const dir of [-1, 1]) {
        let y = cy(dir < 0 ? found[0] : found[found.length - 1]);
        for (let misses = 0; misses < 2;) {
          y += dir * pitch;
          if (!inside(y)) break;
          const g = await read(y);
          if (/^\d{6}$/.test(g.text) && g.conf >= 60) {
            rows.push({ text: g.text, conf: g.conf, x: line.at(y), y });
            misses = 0;
          } else misses++;
        }
      }
    } finally {
      await worker.setParameters(SPARSE);
    }
    return { rows: rows.sort((a, b) => a.y - b.y), width, height, pitch };
  }

  async function analyze(blob, onProgress) {
    const report = onProgress || (() => {});
    progressCb = report;
    const bitmap = await loadBitmap(blob);
    const canvas = preprocess(bitmap);
    const worker = await getWorker();
    const { data } = await worker.recognize(canvas, {}, { blocks: true, text: false });
    const words = flattenWords(data);
    const { accepted, rejected } = pickRightColumn(words);
    const W = canvas.width, H = canvas.height;
    const norm = (b) => ({ x0: b.x0 / W, y0: b.y0 / H, x1: b.x1 / W, y1: b.y1 / H });
    const nearMiss = words.filter((w) => /^\d{5}$|^\d{7,8}$/.test(w.text)).map((w) => ({ number: w.text, box: norm(w) }));
    const result = { bitmap, entries: [], rejected: rejected.map((w) => ({ number: w.text, box: norm(w) })), nearMiss };
    if (!accepted.length) return result;

    progressCb = () => {};
    const { rows, width, height, pitch } = await readColumn(worker, bitmap, accepted, W, H,
      (i, n) => report({ status: 'reading rows', progress: Math.min(1, i / n) }));
    progressCb = report;

    // זווית הצילום לפי שיפוע העמודה; מסובבים כך שהשורות יהיו אופקיות
    const slope = fitColumnLine(rows.map((r) => ({ x0: r.x, x1: r.x, y0: r.y, y1: r.y }))).slope;
    let angle = rows.length >= 3 ? Math.atan(slope) : 0;
    if (Math.abs(angle) < 0.005 || Math.abs(angle) > 0.3) angle = 0;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    // יחידות: פיקסלים של המעבר הראשון חלקי W (אותו קנה מידה לשני הצירים, כדי שהסיבוב יישאר נכון)
    const rot = (x, y) => ({ x: (x * cos - y * sin) / W, y: (x * sin + y * cos) / W });

    // רוחב הטבלה: כל הטקסט שנמצא בגובה של השורות, משמאל לעמודה
    const rr = rows.map((r) => rot(r.x, r.y));
    const top = Math.min(...rr.map((p) => p.y)) - pitch / W;
    const bottom = Math.max(...rr.map((p) => p.y)) + pitch / W;
    const colX = median(rr.map((p) => p.x));
    const lefts = words
      .map((w) => ({ p: rot(cx(w), cy(w)), half: (w.x1 - w.x0) / 2 / W }))
      .filter(({ p }) => p.y >= top && p.y <= bottom && p.x < colX)
      .map(({ p, half }) => p.x - half)
      .sort((a, b) => a - b);
    const margin = width * 0.4 / W;
    const left = (lefts.length ? lefts[Math.floor(lefts.length * 0.02)] : colX - 1) - margin;
    const right = colX + width / 2 / W + margin;
    const half = Math.max(pitch * 0.55, height * 0.9) / W;

    result.entries = rows.map((r, i) => ({
      number: r.text,
      conf: Math.round(r.conf),
      angle,
      pitch: pitch / W,
      strip: { left, right, top: rr[i].y - half, bottom: rr[i].y + half },
      mark: { cx: rr[i].x, cy: rr[i].y, w: width / W, h: height / W },
      box: norm({ x0: r.x - width / 2, x1: r.x + width / 2, y0: r.y - height / 2, y1: r.y + height / 2 }),
    }));
    return result;
  }

  return { analyze, loadBitmap };
})();
