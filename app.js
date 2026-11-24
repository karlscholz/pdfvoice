'use strict';
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.min.js', location.href).href;

const $ = id => document.getElementById(id);
const viewer = $('viewer');

const store = {
  get(k, d) { try { const v = localStorage.getItem('pdfvoice.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('pdfvoice.' + k, JSON.stringify(v)); } catch (e) {} }
};

const state = {
  pdf: null,
  pages: [],          // {num, vp1:{width,height}, blocks, wrap, canvas, hlLayer, renderedScale, rendering}
  scale: 1.3,
  reading: null,      // {page, block, sentence}
  playing: false,
  follow: store.get('follow', true),
  userScrolled: false,
  utter: null,
  silentStreak: 0,
};

/* ---------------- voices (searchable custom dropdown) ---------------- */
let voices = [];
let chosenVoiceName = store.get('voice', null);
const vDisp = v => v.name.replace(/^Microsoft /, '').replace(/ Online \(Natural\)/, ' ✦');
const isNat = v => /Online.*Natural/i.test(v.name);
function currentVoice() {
  return voices.find(v => v.name === chosenVoiceName) || null;
}
function defaultVoice() {
  return voices.find(v => /Sonia Online \(Natural\).*English \(United Kingdom\)/.test(v.name)) ||
    voices.find(v => isNat(v) && /English \(United Kingdom\)/.test(v.name)) ||
    voices.find(v => isNat(v) && /English \(United States\)/.test(v.name)) ||
    voices.find(v => isNat(v) && v.lang.startsWith('en')) ||
    voices.find(v => v.lang.startsWith('en')) || voices[0] || null;
}
function syncVoiceBox() {
  const v = currentVoice();
  if (v && document.activeElement !== $('voiceSel')) $('voiceSel').value = vDisp(v);
}
function refreshVoices() {
  voices = speechSynthesis.getVoices();
  if (!voices.length) return;
  if (!currentVoice()) {
    const d = defaultVoice();
    if (d) chosenVoiceName = d.name;
  }
  syncVoiceBox();
}
speechSynthesis.onvoiceschanged = refreshVoices;
refreshVoices();

const drop = $('voiceDrop');
let dropItems = [], dropSel = -1;
function renderDrop(filter) {
  const q = (filter || '').trim().toLowerCase();
  dropItems = voices
    .filter(v => !q || v.name.toLowerCase().includes(q) || v.lang.toLowerCase().includes(q))
    .sort((a, b) => (isNat(b) - isNat(a)) || a.name.localeCompare(b.name));
  dropSel = -1;
  drop.innerHTML = '';
  if (!dropItems.length) { drop.style.display = 'none'; return; }
  let lastNat = null;
  dropItems.forEach((v, i) => {
    if (isNat(v) !== lastNat) {
      lastNat = isNat(v);
      const h = document.createElement('div');
      h.className = 'vhead';
      h.textContent = lastNat ? 'Natural (online)' : 'Local';
      drop.appendChild(h);
    }
    const d = document.createElement('div');
    d.className = 'vopt';
    d.textContent = vDisp(v);
    if (v.name === chosenVoiceName) d.classList.add('sel');
    d.dataset.i = i;
    // mousedown (not click) so it fires before the input's blur hides the list
    d.addEventListener('mousedown', e => { e.preventDefault(); commitVoice(v); });
    drop.appendChild(d);
  });
  drop.style.display = 'block';
}
function commitVoice(v) {
  chosenVoiceName = v.name;
  store.set('voice', v.name);
  drop.style.display = 'none';
  $('voiceSel').blur();
  $('voiceSel').value = vDisp(v);
  if (state.playing) { stopUtterance(); state.playing = true; speakCurrent(); }
}
$('voiceSel').addEventListener('focus', () => { $('voiceSel').select(); renderDrop(''); });
$('voiceSel').addEventListener('input', () => renderDrop($('voiceSel').value));
$('voiceSel').addEventListener('blur', () => setTimeout(() => { drop.style.display = 'none'; syncVoiceBox(); }, 120));
$('voiceSel').addEventListener('keydown', e => {
  const opts = [...drop.querySelectorAll('.vopt')];
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault(); e.stopPropagation();
    if (!opts.length) return;
    dropSel = (dropSel + (e.key === 'ArrowDown' ? 1 : -1) + opts.length) % opts.length;
    opts.forEach((o, i) => o.classList.toggle('sel', i === dropSel));
    opts[dropSel].scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const idx = dropSel >= 0 ? +opts[dropSel].dataset.i : (dropItems.length ? 0 : -1);
    if (idx >= 0) commitVoice(dropItems[idx]);
  } else if (e.key === 'Escape') {
    drop.style.display = 'none';
    $('voiceSel').blur();
  }
});

/* ---------------- loading ---------------- */
$('openBtn').onclick = () => $('fileInput').click();
$('fileInput').onchange = e => {
  const f = e.target.files[0];
  if (f) f.arrayBuffer().then(buf => loadPdfData(buf, f.name, 'f:' + f.name + ':' + f.size));
};
$('urlInput').onkeydown = e => {
  if (e.key !== 'Enter') return;
  openUrl($('urlInput').value.trim());
};
async function openUrl(url) {
  if (!url) return;
  setStatus('Fetching ' + url + ' …');
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    loadPdfData(await r.arrayBuffer(), url.split('/').pop() || url, url);
  } catch (err) {
    const isExt = location.protocol === 'chrome-extension:' || location.protocol === 'moz-extension:';
    setStatus('Could not fetch (' + err.message + ') — ' + (url.startsWith('file:')
      ? (isExt ? 'enable “Allow access to file URLs” for PDF Voice in the extension settings, or open it with 📂.' : 'open local files with 📂 instead.')
      : (isExt ? 'try opening it with 📂.' : 'the site may block cross-origin requests. Download it and open with 📂.')));
  }
}
viewer.addEventListener('dragover', e => { e.preventDefault(); $('drop') && $('drop').classList.add('over'); });
viewer.addEventListener('dragleave', () => { $('drop') && $('drop').classList.remove('over'); });
viewer.addEventListener('drop', e => {
  e.preventDefault();
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) f.arrayBuffer().then(buf => loadPdfData(buf, f.name, 'f:' + f.name + ':' + f.size));
});

/* ---------------- resume (per-PDF position, capped LRU) ---------------- */
let docKey = null;
const RESUME_MAX = 50;
function resumeAll() { return store.get('resume', {}); }
function saveResume() {
  if (!docKey || !state.pages.length) return;
  const all = resumeAll();
  const entry = all[docKey] || {};
  const r = state.reading;
  if (r) {
    const b = state.pages[r.page] && state.pages[r.page].blocks && state.pages[r.page].blocks[r.block];
    const sn = b && b.sentences[r.sentence];
    Object.assign(entry, { page: r.page, block: r.block, sentence: r.sentence, text: sn ? sn.text.slice(0, 80) : '' });
  }
  entry.scrollPage = currentTopPage();
  entry.ts = Date.now();
  all[docKey] = entry;
  const keys = Object.keys(all);
  if (keys.length > RESUME_MAX) {
    keys.sort((a, b) => (all[a].ts || 0) - (all[b].ts || 0));
    for (const k of keys.slice(0, keys.length - RESUME_MAX)) delete all[k];
  }
  store.set('resume', all);
}
function currentTopPage() {
  const vt = viewer.getBoundingClientRect().top;
  for (const rec of state.pages) {
    if (rec.wrap.getBoundingClientRect().bottom > vt + 40) return rec.num - 1;
  }
  return 0;
}
async function restoreReading(saved) {
  const rec = state.pages[saved.page];
  if (!rec) return;
  for (let i = 0; i < 50 && !rec.blocks; i++) await new Promise(res => setTimeout(res, 200));
  if (!rec.blocks || state.reading) return; // user already started reading something
  let { block, sentence } = saved;
  const match = (bi, si) => {
    const sn = rec.blocks[bi] && rec.blocks[bi].sentences[si];
    return sn && (!saved.text || sn.text.startsWith(saved.text));
  };
  if (!match(block, sentence) && saved.text) {
    // extraction may have shifted indices (e.g. after an update) — find the sentence by text
    outer:
    for (let bi = 0; bi < rec.blocks.length; bi++)
      for (let si = 0; si < rec.blocks[bi].sentences.length; si++)
        if (rec.blocks[bi].sentences[si].text.startsWith(saved.text)) { block = bi; sentence = si; break outer; }
  }
  if (!rec.blocks[block] || !rec.blocks[block].sentences[sentence]) return;
  state.reading = { page: saved.page, block, sentence };
  state.playing = false;
  state.userScrolled = true; // highlight without yanking the view
  updateButtons();
  refreshHighlight();
  setStatus('Resumed where you left off — press Space or ▶ to continue.');
}
let scrollSaveTimer = null;
viewer.addEventListener('scroll', () => {
  clearTimeout(scrollSaveTimer);
  scrollSaveTimer = setTimeout(saveResume, 1500);
}, { passive: true });
window.addEventListener('beforeunload', saveResume);

async function loadPdfData(data, name, key) {
  stopReading();
  docKey = key || null;
  setStatus('Loading ' + name + ' …');
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  state.pdf = pdf;
  state.pages = [];
  viewer.innerHTML = '';
  $('docName').textContent = name + ' · ' + pdf.numPages + ' p.';
  document.title = name + ' – PDF Voice';

  // first page decides fit-width scale
  const first = await pdf.getPage(1);
  const vp1f = first.getViewport({ scale: 1 });
  state.scale = Math.min(1.8, Math.max(0.7, (viewer.clientWidth - 90) / vp1f.width));

  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const vp1 = page.getViewport({ scale: 1 });
    const wrap = document.createElement('div');
    wrap.className = 'pageWrap';
    wrap.dataset.page = n;
    const canvas = document.createElement('canvas');
    const textLayer = document.createElement('div');
    textLayer.className = 'textLayer';
    const hlLayer = document.createElement('div');
    hlLayer.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:2;';
    const linkLayer = document.createElement('div');
    linkLayer.className = 'linkLayer';
    const num = document.createElement('span');
    num.className = 'pageNum'; num.textContent = n;
    wrap.append(canvas, textLayer, hlLayer, linkLayer, num);
    viewer.appendChild(wrap);
    const rec = { num: n, page, vp1: { width: vp1.width, height: vp1.height }, blocks: null, wrap, canvas, textLayer, hlLayer, linkLayer, renderedScale: 0, rendering: false };
    state.pages.push(rec);
    sizeWrap(rec);
    observer.observe(wrap);
    extractBlocks(rec); // async, fire & forget; builds click overlays when done
  }
  setStatus('Click a paragraph to start reading.');

  const saved = docKey ? resumeAll()[docKey] : null;
  if (saved) {
    const target = state.pages[saved.block != null ? saved.page : (saved.scrollPage || 0)];
    if (target) requestAnimationFrame(() => target.wrap.scrollIntoView({ block: 'start' }));
    if (saved.block != null) restoreReading(saved);
  }
}

function sizeWrap(rec) {
  rec.wrap.style.width = (rec.vp1.width * state.scale) + 'px';
  rec.wrap.style.height = (rec.vp1.height * state.scale) + 'px';
}

/* ---------------- rendering (lazy) ---------------- */
const observer = new IntersectionObserver(entries => {
  for (const en of entries) {
    const rec = state.pages[+en.target.dataset.page - 1];
    if (en.isIntersecting && rec) renderPage(rec);
  }
}, { root: viewer, rootMargin: '900px' });

async function renderPage(rec) {
  if (rec.rendering || rec.renderedScale === state.scale) return;
  rec.rendering = true;
  try {
    const dpr = window.devicePixelRatio || 1;
    const vp = rec.page.getViewport({ scale: state.scale * dpr });
    rec.canvas.width = vp.width; rec.canvas.height = vp.height;
    rec.canvas.style.width = (vp.width / dpr) + 'px';
    rec.canvas.style.height = (vp.height / dpr) + 'px';
    await rec.page.render({ canvasContext: rec.canvas.getContext('2d'), viewport: vp }).promise;
    rec.renderedScale = state.scale;
    positionOverlays(rec);
    await renderSelectionLayers(rec);
  } finally {
    rec.rendering = false;
    if (rec.renderedScale !== state.scale) renderPage(rec); // scale changed meanwhile
  }
}

// selectable text + clickable links (used in mouse mode)
async function renderSelectionLayers(rec) {
  const vp = rec.page.getViewport({ scale: state.scale });
  rec.textLayer.innerHTML = '';
  rec.textLayer.style.setProperty('--scale-factor', vp.scale);
  try {
    const tc = rec.textContent || (rec.textContent = await rec.page.getTextContent());
    await pdfjsLib.renderTextLayer({ textContentSource: tc, container: rec.textLayer, viewport: vp }).promise;
  } catch (e) {}
  rec.linkLayer.innerHTML = '';
  try {
    const annots = rec.annots || (rec.annots = await rec.page.getAnnotations());
    for (const a of annots) {
      if (a.subtype !== 'Link' || (!a.url && !a.dest)) continue;
      const r = vp.convertToViewportRectangle(a.rect);
      const el = document.createElement('a');
      el.style.cssText = `left:${Math.min(r[0], r[2])}px;top:${Math.min(r[1], r[3])}px;width:${Math.abs(r[2] - r[0])}px;height:${Math.abs(r[3] - r[1])}px;`;
      if (a.url) {
        el.href = a.url; el.target = '_blank'; el.rel = 'noopener'; el.title = a.url;
      } else {
        el.href = '#';
        el.title = 'Go to destination';
        el.onclick = async e => {
          e.preventDefault();
          try {
            const dest = typeof a.dest === 'string' ? await state.pdf.getDestination(a.dest) : a.dest;
            const idx = await state.pdf.getPageIndex(dest[0]);
            state.userScrolled = true;
            state.pages[idx].wrap.scrollIntoView({ block: 'start', behavior: 'smooth' });
          } catch (err) {}
        };
      }
      rec.linkLayer.appendChild(el);
    }
  } catch (e) {}
}

function setScale(s) {
  state.scale = Math.min(3, Math.max(0.5, s));
  for (const rec of state.pages) { sizeWrap(rec); positionOverlays(rec); }
  for (const rec of state.pages) if (isNear(rec.wrap)) renderPage(rec);
  refreshHighlight();
}
function isNear(el) {
  const r = el.getBoundingClientRect();
  return r.bottom > -900 && r.top < innerHeight + 900;
}
$('zoomIn').onclick = () => setScale(state.scale * 1.15);
$('zoomOut').onclick = () => setScale(state.scale / 1.15);

/* ---------------- text extraction ---------------- */
async function extractBlocks(rec) {
  const tc = rec.textContent || (rec.textContent = await rec.page.getTextContent());
  const vp = rec.page.getViewport({ scale: 1 });
  // items -> positioned runs
  const runs = [];
  for (const it of tc.items) {
    const str = it.str;
    if (!str || !str.trim()) continue;
    const tx = pdfjsLib.Util.transform(vp.transform, it.transform);
    // skip non-horizontal text (rotated margin stamps, watermarks, figure axis labels)
    if (Math.abs(tx[1]) > 0.25 * Math.abs(tx[0])) continue;
    const fh = Math.hypot(tx[2], tx[3]) || Math.abs(tx[3]) || 10;
    runs.push({ str, x: tx[4], top: tx[5] - fh * 0.85, w: it.width, h: fh, base: tx[5] });
  }
  if (!runs.length) { rec.blocks = []; return; }

  // group into raw lines by baseline
  runs.sort((a, b) => a.base - b.base || a.x - b.x);
  const rawLines = [];
  for (const r of runs) {
    const ln = rawLines[rawLines.length - 1];
    if (ln && Math.abs(r.base - ln.base) < Math.max(2, ln.h * 0.45)) {
      ln.runs.push(r);
      ln.h = Math.max(ln.h, r.h);
    } else {
      rawLines.push({ base: r.base, h: r.h, runs: [r] });
    }
  }
  // split each raw line at large horizontal gaps (column gutters, side-by-side cells);
  // a gap wider than ~1.4em is never normal word spacing
  const lines = [];
  for (const ln of rawLines) {
    ln.runs.sort((a, b) => a.x - b.x);
    const gapThr = Math.max(10, ln.h * 1.4);
    let cur = null, prevEnd = -1e9;
    for (const r of ln.runs) {
      if (!cur || r.x - prevEnd > gapThr) {
        cur = { base: ln.base, h: r.h, runs: [] };
        lines.push(cur);
      }
      cur.runs.push(r);
      cur.h = Math.max(cur.h, r.h);
      prevEnd = Math.max(prevEnd, r.x + r.w);
    }
  }
  for (const ln of lines) {
    ln.x0 = ln.runs[0].x;
    ln.x1 = Math.max(...ln.runs.map(r => r.x + r.w));
    ln.top = Math.min(...ln.runs.map(r => r.top));
  }

  // group lines into blocks: a line may continue ANY open block that is
  // vertically adjacent and shares its column (x-overlap), since segments
  // of different columns interleave in reading order of the lines array
  lines.sort((a, b) => a.base - b.base || a.x0 - b.x0);
  const med = median(lines.map(l => l.h));
  const blocks = [];
  for (const ln of lines) {
    let home = null;
    for (let i = blocks.length - 1; i >= 0 && i >= blocks.length - 12; i--) {
      const b = blocks[i];
      const last = b.lines[b.lines.length - 1];
      const gap = ln.top - (last.top + last.h);
      if (gap > med * 0.9 || gap < -med * 0.6) continue;
      if (Math.abs(ln.h - last.h) > 0.22 * Math.max(ln.h, last.h)) continue; // font-size change = new block (e.g. caption vs body)
      const overlap = Math.min(b.x1, ln.x1) - Math.max(b.x0, ln.x0);
      if (overlap > 0.5 * Math.min(b.x1 - b.x0, ln.x1 - ln.x0)) { home = b; break; }
    }
    if (home) {
      home.lines.push(ln);
      home.x0 = Math.min(home.x0, ln.x0); home.x1 = Math.max(home.x1, ln.x1);
    } else {
      blocks.push({ lines: [ln], x0: ln.x0, x1: ln.x1 });
    }
  }

  // assemble text + char ranges per run
  for (const b of blocks) {
    b.top = Math.min(...b.lines.map(l => l.top));
    b.bottom = Math.max(...b.lines.map(l => l.top + l.h));
    let text = '';
    b.chars = []; // {start,end,x,top,w,h}
    for (let li = 0; li < b.lines.length; li++) {
      const ln = b.lines[li];
      for (const r of ln.runs) {
        if (text && !text.endsWith(' ') && !text.endsWith('-')) text += ' ';
        if (text.endsWith('-') && li > 0) text = text.slice(0, -1); // join hyphenated line break
        const start = text.length;
        text += r.str.trim();
        b.chars.push({ start, end: text.length, x: r.x, top: r.top, w: r.w, h: r.h });
      }
    }
    b.text = text;
    b.sentences = splitSentences(text);
  }

  const useful = blocks.filter(b => b.text.replace(/[^A-Za-zÀ-ÿ0-9]/g, '').length >= 3);

  // reading order: bands split by spanning blocks, columns inside bands
  const pageW = vp.width;
  for (const b of useful) b.span = (b.x1 - b.x0) > pageW * 0.6;
  useful.sort((a, b) => a.top - b.top);
  const ordered = [];
  let band = [];
  const flushBand = () => {
    if (!band.length) return;
    band.sort((a, b) => a.x0 - b.x0);
    const cols = [];
    for (const b of band) {
      const c = cols.find(c => Math.min(c.x1, b.x1) - Math.max(c.x0, b.x0) > 0.3 * (b.x1 - b.x0));
      if (c) { c.items.push(b); c.x0 = Math.min(c.x0, b.x0); c.x1 = Math.max(c.x1, b.x1); }
      else cols.push({ x0: b.x0, x1: b.x1, items: [b] });
    }
    cols.sort((a, b) => a.x0 - b.x0);
    for (const c of cols) { c.items.sort((a, b) => a.top - b.top); ordered.push(...c.items); }
    band = [];
  };
  for (const b of useful) {
    if (b.span) { flushBand(); ordered.push(b); }
    else band.push(b);
  }
  flushBand();

  rec.blocks = ordered;
  buildOverlays(rec);
}

function median(a) { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] || 10; }

function splitSentences(text) {
  const parts = text.split(/(?<=[.!?…])\s+(?=[A-Z0-9("'“])/).flatMap(p => {
    if (p.length <= 320) return [p];
    const out = []; // very long "sentence": chunk at commas/spaces
    let rest = p;
    while (rest.length > 320) {
      let cut = rest.lastIndexOf(', ', 300);
      if (cut < 100) cut = rest.lastIndexOf(' ', 300);
      if (cut < 100) cut = 300;
      out.push(rest.slice(0, cut + 1)); rest = rest.slice(cut + 1);
    }
    out.push(rest);
    return out;
  }).map(s => s.trim()).filter(Boolean);
  // map char offsets
  const sentences = [];
  let pos = 0;
  for (const s of parts) {
    const start = text.indexOf(s, pos);
    sentences.push({ text: s, start, end: start + s.length });
    pos = start + s.length;
  }
  return sentences;
}

/* ---------------- overlays & highlight ---------------- */
function buildOverlays(rec) {
  for (const el of rec.wrap.querySelectorAll('.blk')) el.remove();
  rec.blocks.forEach((b, bi) => {
    const d = document.createElement('div');
    d.className = 'blk';
    d.dataset.b = bi;
    d.title = 'Read from here';
    d.onclick = e => {
      const y = (e.clientY - rec.wrap.getBoundingClientRect().top) / state.scale;
      startReading(rec.num - 1, bi, sentenceAtY(b, y));
    };
    b.el = d;
    rec.wrap.appendChild(d);
  });
  positionOverlays(rec);
}
function positionOverlays(rec) {
  if (!rec.blocks) return;
  const s = state.scale;
  for (const b of rec.blocks) {
    if (!b.el) continue;
    b.el.style.left = ((b.x0 - 3) * s) + 'px';
    b.el.style.top = ((b.top - 2) * s) + 'px';
    b.el.style.width = ((b.x1 - b.x0 + 6) * s) + 'px';
    b.el.style.height = ((b.bottom - b.top + 4) * s) + 'px';
  }
}
function sentenceAtY(b, y) {
  // find first char-run at or below click line, return its sentence
  let best = 0, bestD = 1e9;
  for (const c of b.chars) {
    const d = Math.abs(c.top + c.h / 2 - y);
    if (d < bestD) { bestD = d; best = c.start; }
  }
  const i = b.sentences.findIndex(sn => best < sn.end);
  return Math.max(0, i);
}

function refreshHighlight() {
  for (const rec of state.pages) if (rec.hlLayer) rec.hlLayer.innerHTML = '';
  const r = state.reading;
  if (!r) return;
  const rec = state.pages[r.page];
  const b = rec.blocks && rec.blocks[r.block];
  if (!b) return;
  const sn = b.sentences[r.sentence];
  if (!sn) return;
  const s = state.scale;
  // merge char runs of this sentence per line
  const rows = new Map();
  for (const c of b.chars) {
    if (c.end <= sn.start || c.start >= sn.end) continue;
    const key = Math.round(c.top);
    const row = rows.get(key) || { x0: c.x, x1: c.x + c.w, top: c.top, h: c.h };
    row.x0 = Math.min(row.x0, c.x); row.x1 = Math.max(row.x1, c.x + c.w);
    row.h = Math.max(row.h, c.h);
    rows.set(key, row);
  }
  for (const row of rows.values()) {
    const d = document.createElement('div');
    d.className = 'hlrect';
    d.style.cssText = `left:${(row.x0 - 1) * s}px;top:${(row.top - 1) * s}px;width:${(row.x1 - row.x0 + 2) * s}px;height:${(row.h + 2) * s}px;`;
    rec.hlLayer.appendChild(d);
  }
  $('nowReading').textContent = sn.text;
  $('nowReading').classList.add('active');
  if (state.follow && !state.userScrolled) {
    const first = rec.hlLayer.firstChild;
    if (first) first.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

/* ---------------- reading engine ---------------- */
let speakTimer = null, lastCancelTs = 0;
function startReading(pageIdx, blockIdx, sentIdx = 0) {
  stopUtterance();
  state.reading = { page: pageIdx, block: blockIdx, sentence: sentIdx };
  state.silentStreak = 0;
  state.playing = true;
  state.userScrolled = false;
  saveResume();
  updateButtons();
  speakCurrent();
}
function speakCurrent() {
  clearTimeout(speakTimer);
  const r = state.reading;
  if (!r || !state.playing) return;
  const rec = state.pages[r.page];
  if (!rec.blocks) { speakTimer = setTimeout(speakCurrent, 150); return; } // extraction still running
  const b = rec.blocks[r.block];
  if (!b || !b.sentences[r.sentence]) { advance(); return; }
  // Edge silently swallows a speak() issued too soon after cancel() (rapid re-clicks) — wait out the window
  const since = Date.now() - lastCancelTs;
  if (since < 220) { speakTimer = setTimeout(speakCurrent, 230 - since); return; }
  refreshHighlight();
  const text = b.sentences[r.sentence].text;
  const u = new SpeechSynthesisUtterance(text);
  const v = currentVoice();
  if (v) u.voice = v;
  u.rate = parseFloat($('rate').value);
  // Edge's online voices sometimes fire bogus error events while the audio still
  // plays, and sometimes drop onend — so poll the actual audio state and never
  // stop the flow on an error event alone
  let done = false, sawSpeaking = false;
  const started = Date.now();
  const maxMs = 5000 + (text.length * 95) / (u.rate || 1); // ceiling for a zombie 'speaking' flag
  const finish = ok => {
    if (done || state.utter !== u) return;
    done = true;
    clearInterval(watch);
    if (!state.playing) return;
    if (ok) { state.silentStreak = 0; advance(); }
    else if (++state.silentStreak >= 3) {
      setStatus('No audio is coming through' + (/Online/.test((v || {}).name || '') ? ' — online voices need network; try a local voice.' : '.'));
      state.playing = false; updateButtons();
    } else advance(); // skip this sentence; the next one may work
  };
  const watch = setInterval(() => {
    if (done || state.utter !== u) { clearInterval(watch); return; }
    if (speechSynthesis.speaking) {
      sawSpeaking = true;
      if (Date.now() - started > maxMs) { // zombie: 'speaking' stuck true after heavy cancel use
        done = true;
        clearInterval(watch);
        stopUtterance();
        if (state.playing && state.reading) advance();
      }
    }
    else if (sawSpeaking) finish(true);                 // audio played and ended (onend was dropped)
    else if (Date.now() - started > 7000) finish(false); // never started
  }, 400);
  u.onend = () => finish(true);
  u.onerror = e => {
    if (e.error === 'interrupted' || e.error === 'canceled') { done = true; clearInterval(watch); }
  };
  state.utter = u;
  speechSynthesis.speak(u);
}
function advance() {
  const r = state.reading;
  if (!r) return;
  const rec = state.pages[r.page];
  const b = rec.blocks[r.block];
  if (b && r.sentence + 1 < b.sentences.length) r.sentence++;
  else if (rec.blocks && r.block + 1 < rec.blocks.length) { r.block++; r.sentence = 0; }
  else if (r.page + 1 < state.pages.length) { r.page++; r.block = 0; r.sentence = 0; }
  else { finish(); return; }
  saveResume();
  if (state.playing) speakCurrent();
  else refreshHighlight();
}
function retreat() {
  const r = state.reading;
  if (!r) return;
  if (r.sentence > 0) r.sentence--;
  else if (r.block > 0) { r.block--; r.sentence = Math.max(0, (state.pages[r.page].blocks[r.block].sentences.length || 1) - 1); }
  else if (r.page > 0) {
    r.page--;
    const bl = state.pages[r.page].blocks || [];
    r.block = Math.max(0, bl.length - 1);
    r.sentence = bl.length ? Math.max(0, bl[r.block].sentences.length - 1) : 0;
  }
  if (state.playing) { stopUtterance(); state.playing = true; speakCurrent(); } else refreshHighlight();
}
function moveBlock(dir) {
  const r = state.reading;
  if (!r) return;
  const rec = state.pages[r.page];
  if (dir > 0) {
    if (rec.blocks && r.block + 1 < rec.blocks.length) { r.block++; r.sentence = 0; }
    else if (r.page + 1 < state.pages.length) { r.page++; r.block = 0; r.sentence = 0; }
  } else {
    if (r.block > 0) { r.block--; r.sentence = 0; }
    else if (r.page > 0) { r.page--; r.block = Math.max(0, (state.pages[r.page].blocks || []).length - 1); r.sentence = 0; }
  }
  if (state.playing) { stopUtterance(); state.playing = true; speakCurrent(); } else refreshHighlight();
}
function stopUtterance() {
  state.utter = null;
  clearTimeout(speakTimer);
  lastCancelTs = Date.now();
  try { speechSynthesis.cancel(); } catch (e) {}
}
function pauseReading() {
  state.playing = false;
  stopUtterance();
  saveResume();
  updateButtons();
}
function resumeReading() {
  if (!state.reading) return;
  state.playing = true;
  updateButtons();
  speakCurrent();
}
function stopReading() {
  state.playing = false;
  saveResume();
  state.reading = null;
  stopUtterance();
  refreshHighlight();
  $('nowReading').textContent = '';
  $('nowReading').classList.remove('active');
  updateButtons();
}
function finish() {
  setStatus('Finished the document.');
  state.playing = false;
  updateButtons();
}
function updateButtons() {
  $('playBtn').textContent = state.playing ? '⏸' : '▶';
  $('playBtn').disabled = !state.reading && !state.pdf;
  $('stopBtn').disabled = !state.reading;
  $('jumpBtn').disabled = !state.reading;
  $('followBtn').classList.toggle('active', state.follow);
}
function setStatus(msg) {
  $('nowReading').classList.remove('active');
  $('nowReading').textContent = msg;
}

/* ---------------- controls ---------------- */
$('playBtn').onclick = () => {
  if (state.playing) pauseReading();
  else if (state.reading) resumeReading();
  else if (state.pages.length && state.pages[0].blocks && state.pages[0].blocks.length) startReading(0, 0, 0);
};
$('stopBtn').onclick = stopReading;
$('rate').oninput = () => {
  $('rateVal').textContent = parseFloat($('rate').value).toFixed(1) + '×';
  store.set('rate', $('rate').value);
  if (state.playing) { stopUtterance(); state.playing = true; speakCurrent(); }
};
$('rate').value = store.get('rate', 1.1);
$('rateVal').textContent = parseFloat($('rate').value).toFixed(1) + '×';

$('followBtn').onclick = () => {
  state.follow = !state.follow;
  store.set('follow', state.follow);
  if (state.follow) state.userScrolled = false;
  updateButtons();
  refreshHighlight();
};
$('jumpBtn').onclick = () => { state.userScrolled = false; refreshHighlight(); };

// manual scroll disables follow until "Current" pressed (reading itself is never affected)
for (const evt of ['wheel', 'touchmove']) viewer.addEventListener(evt, () => { state.userScrolled = true; }, { passive: true });

document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.code === 'Space') { e.preventDefault(); $('playBtn').onclick(); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); if (state.reading) { stopUtterance(); advance(); } }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); retreat(); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); if (state.reading) moveBlock(1); else state.userScrolled = true; }
  else if (e.key === 'ArrowUp') { e.preventDefault(); if (state.reading) moveBlock(-1); else state.userScrolled = true; }
  else if (['PageDown', 'PageUp', 'Home', 'End'].includes(e.key)) state.userScrolled = true;
});

window.addEventListener('beforeunload', stopUtterance);
updateButtons();

/* ---------------- ear / mouse mode ---------------- */
function setMode(m) {
  store.set('mode', m);
  document.body.dataset.mode = m;
  $('modeEar').classList.toggle('active', m === 'ear');
  $('modeMouse').classList.toggle('active', m === 'mouse');
}
$('modeEar').onclick = () => setMode('ear');
$('modeMouse').onclick = () => setMode('mouse');
setMode(store.get('mode', 'ear'));

// optional ?file= URL
const qp = new URLSearchParams(location.search).get('file');
if (qp) { $('urlInput').value = qp; openUrl(qp); }
