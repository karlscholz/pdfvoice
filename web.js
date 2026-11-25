'use strict';
/* PDF Voice — website mode. Injected into a normal web page by the toolbar
   button (second click toggles it off). Reads the page's own paragraphs in
   place: click a paragraph to listen from there. Never mutates the page's
   DOM except for one floating control bar in shadow DOM and a <style> tag —
   the sentence highlight uses the CSS Custom Highlight API, so the site's
   own scripts and interactive elements keep working untouched. */
(() => {
  if (window.__pdfvoiceWeb) { window.__pdfvoiceWeb.toggle(); return; }

  /* ---------------- prefs (shared via extension storage when available) ---------------- */
  const prefs = { voice: null, rate: 1.1, follow: true };
  const extStore = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
  const loadPrefs = () => new Promise(res => {
    if (extStore) chrome.storage.local.get({ webPrefs: {} }, o => { Object.assign(prefs, o.webPrefs || {}); res(); });
    else { try { Object.assign(prefs, JSON.parse(localStorage.getItem('pdfvoice.webPrefs') || '{}')); } catch (e) {} res(); }
  });
  const savePrefs = () => {
    if (extStore) chrome.storage.local.set({ webPrefs: prefs });
    else try { localStorage.setItem('pdfvoice.webPrefs', JSON.stringify(prefs)); } catch (e) {}
  };

  /* ---------------- voices ---------------- */
  let voices = [];
  const vDisp = v => v.name.replace(/^Microsoft /, '').replace(/ Online \(Natural\)/, ' ✦');
  const isNat = v => /Online.*Natural/i.test(v.name);
  const currentVoice = () => voices.find(v => v.name === prefs.voice) || null;
  const defaultVoice = () =>
    voices.find(v => /Sonia Online \(Natural\).*English \(United Kingdom\)/.test(v.name)) ||
    voices.find(v => isNat(v) && /English \(United Kingdom\)/.test(v.name)) ||
    voices.find(v => isNat(v) && /English \(United States\)/.test(v.name)) ||
    voices.find(v => isNat(v) && v.lang.startsWith('en')) ||
    voices.find(v => v.lang.startsWith('en')) || voices[0] || null;

  /* ---------------- block collection ---------------- */
  const BLOCK_SEL = 'p,h1,h2,h3,h4,h5,h6,li,blockquote,dd,dt,figcaption,pre,caption,td,th,summary,div';
  const AUX_SCOPE = 'nav,header,footer,aside,[role=navigation],[role=banner],[role=contentinfo],[role=complementary],[role=menu],[role=menubar],[role=toolbar]';
  const INTERACTIVE = 'a,button,input,select,textarea,label,summary,video,audio,canvas,svg,iframe,embed,object,[role=button],[role=link],[role=tab],[role=checkbox],[role=menuitem],[role=slider],[contenteditable=true],[contenteditable=""],[onclick]';

  let blocks = [];
  const blockIndex = new Map(); // element -> index in blocks

  function collect() {
    blocks = [];
    blockIndex.clear();
    for (const el of document.body.querySelectorAll(BLOCK_SEL)) {
      if (el.closest('[aria-hidden="true"]')) continue;
      if (!el.getClientRects().length) continue;
      if (getComputedStyle(el).visibility === 'hidden') continue;
      // own text only: text inside a nested block candidate belongs to that candidate
      const nodes = [];
      let text = '';
      const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
        acceptNode(n) {
          const p = n.parentElement;
          if (!p || p.closest('script,style,noscript')) return NodeFilter.FILTER_REJECT;
          return p.closest(BLOCK_SEL) === el ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        }
      });
      let n;
      while ((n = tw.nextNode())) {
        nodes.push({ node: n, start: text.length, end: text.length + n.data.length });
        text += n.data;
      }
      const plain = text.replace(/\s+/g, ' ').trim();
      if (plain.length < (el.tagName === 'DIV' ? 30 : 3)) continue;
      let aux = !!el.closest(AUX_SCOPE);
      if (!aux) { // link-dominated blocks (menus, related-article lists) are furniture too
        let aLen = 0;
        for (const a of el.querySelectorAll('a')) aLen += a.textContent.length;
        aux = aLen > plain.length * 0.6;
      }
      const sentences = splitSentences(text);
      if (!sentences.length) continue;
      blockIndex.set(el, blocks.length);
      blocks.push({ el, nodes, sentences, aux });
    }
  }

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
    const sentences = [];
    let pos = 0;
    for (const s of parts) {
      const start = text.indexOf(s, pos);
      sentences.push({ text: s, start, end: start + s.length });
      pos = start + s.length;
    }
    return sentences;
  }

  function sentenceRange(b, si) {
    const s = b.sentences[si];
    if (!s) return null;
    const r = document.createRange();
    let started = false;
    for (const nm of b.nodes) {
      if (!started && s.start >= nm.start && s.start < nm.end) { r.setStart(nm.node, s.start - nm.start); started = true; }
      if (started && s.end > nm.start && s.end <= nm.end) { r.setEnd(nm.node, s.end - nm.start); return r; }
    }
    if (!started) return null;
    const last = b.nodes[b.nodes.length - 1];
    r.setEnd(last.node, last.node.data.length);
    return r;
  }

  /* ---------------- highlight (never mutates the page) ---------------- */
  const canHL = typeof CSS !== 'undefined' && 'highlights' in CSS;
  const hlObj = canHL ? new Highlight() : null;
  if (canHL) CSS.highlights.set('pdfvoice', hlObj);
  const hlStyle = document.createElement('style');
  hlStyle.textContent = '::highlight(pdfvoice){background-color:rgba(255,213,74,.55);color:#111}';
  document.head.appendChild(hlStyle);
  let fbEl = null, fbPrev = ''; // fallback for browsers without the Highlight API

  function refreshHighlight() {
    if (canHL) hlObj.clear();
    if (fbEl) { fbEl.style.background = fbPrev; fbEl = null; }
    updateBar();
    const r = state.reading;
    if (!r || !blocks[r.block]) return;
    let range = null;
    try { range = sentenceRange(blocks[r.block], r.sentence); } catch (e) {}
    if (range && canHL) hlObj.add(range);
    else if (!canHL) {
      fbEl = blocks[r.block].el; fbPrev = fbEl.style.background;
      fbEl.style.background = 'rgba(255,213,74,.4)';
    }
    if (state.follow) scrollToCurrent(false, range);
  }

  function scrollToCurrent(force, range) {
    const r = state.reading;
    if (!r || !blocks[r.block]) return;
    try { range = range || sentenceRange(blocks[r.block], r.sentence); } catch (e) {}
    if (!range) return;
    const rect = range.getBoundingClientRect();
    if (!rect.width && !rect.height) return;
    const pad = 64; // stay clear of the floating bar
    if (!force && rect.top >= pad && rect.bottom <= innerHeight - 8) return;
    window.scrollTo({ top: scrollY + rect.top + rect.height / 2 - innerHeight / 2, behavior: 'smooth' });
  }

  /* ---------------- speech engine (same Edge workarounds as the PDF viewer) ---------------- */
  const state = { reading: null, playing: false, follow: prefs.follow, utter: null, silentStreak: 0 };
  let speakTimer = null, lastCancelTs = 0;

  function startReading(blockIdx, sentIdx) {
    stopUtterance();
    state.reading = { block: blockIdx, sentence: sentIdx, flow: false };
    state.silentStreak = 0;
    state.playing = true;
    speakCurrent();
  }
  function speakCurrent() {
    clearTimeout(speakTimer);
    const r = state.reading;
    if (!r || !state.playing) return;
    const b = blocks[r.block];
    if (!b || !b.sentences[r.sentence]) { advance(); return; }
    if (b.aux && r.flow) { advance(); return; } // auto-flow skips page furniture
    // Edge silently swallows a speak() issued too soon after cancel() — wait out the window
    const since = Date.now() - lastCancelTs;
    if (since < 220) { speakTimer = setTimeout(speakCurrent, 230 - since); return; }
    refreshHighlight();
    const text = b.sentences[r.sentence].text.replace(/\s+/g, ' ');
    const u = new SpeechSynthesisUtterance(text);
    const v = currentVoice();
    if (v) u.voice = v;
    u.rate = prefs.rate;
    // Edge's online voices fire bogus error events while audio still plays and
    // sometimes drop onend — poll the real audio state, never trust events alone
    let done = false, sawSpeaking = false;
    const started = Date.now();
    const maxMs = 5000 + (text.length * 95) / (u.rate || 1);
    const finish = ok => {
      if (done || state.utter !== u) return;
      done = true;
      clearInterval(watch);
      if (!state.playing) return;
      if (ok) { state.silentStreak = 0; advance(); }
      else if (++state.silentStreak >= 3) {
        setStatus('No audio is coming through' + (/Online/.test((v || {}).name || '') ? ' — online voices need network; try a local voice.' : '.'));
        state.playing = false; updateBar();
      } else advance();
    };
    const watch = setInterval(() => {
      if (done || state.utter !== u) { clearInterval(watch); return; }
      if (speechSynthesis.speaking) {
        sawSpeaking = true;
        if (Date.now() - started > maxMs) { // zombie 'speaking' stuck after heavy cancel use
          done = true;
          clearInterval(watch);
          stopUtterance();
          if (state.playing && state.reading) advance();
        }
      }
      else if (sawSpeaking) finish(true);
      else if (Date.now() - started > 7000) finish(false);
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
    const b = blocks[r.block];
    if (b && r.sentence + 1 < b.sentences.length) r.sentence++;
    else if (r.block + 1 < blocks.length) { r.block++; r.sentence = 0; r.flow = true; }
    else { state.playing = false; state.reading = null; stopUtterance(); refreshHighlight(); setStatus('Finished the page.'); return; }
    if (state.playing) speakCurrent(); else refreshHighlight();
  }
  function retreat() {
    const r = state.reading;
    if (!r) return;
    for (let hop = 0; hop < 60; hop++) {
      if (r.sentence > 0) { r.sentence--; break; }
      if (r.block === 0) break;
      r.block--;
      r.sentence = Math.max(0, blocks[r.block].sentences.length - 1);
      if (!blocks[r.block].aux) break;
      r.sentence = 0; // landed on furniture — keep walking back past it
    }
    r.flow = false;
    if (state.playing) { stopUtterance(); state.playing = true; speakCurrent(); } else refreshHighlight();
  }
  function moveBlock(dir) {
    const r = state.reading;
    if (!r) return;
    for (let hop = 0; hop < 60; hop++) {
      const next = r.block + dir;
      if (next < 0 || next >= blocks.length) break;
      r.block = next; r.sentence = 0;
      if (!blocks[r.block].aux) break;
    }
    r.flow = false;
    if (state.playing) { stopUtterance(); state.playing = true; speakCurrent(); } else refreshHighlight();
  }
  function stopUtterance() {
    state.utter = null;
    clearTimeout(speakTimer);
    lastCancelTs = Date.now();
    try { speechSynthesis.cancel(); } catch (e) {}
  }
  function playPause() {
    if (state.playing) { state.playing = false; stopUtterance(); updateBar(); }
    else if (state.reading) { state.playing = true; updateBar(); speakCurrent(); }
    else setStatus('Click a paragraph to read from there.');
  }

  /* ---------------- floating control bar (shadow DOM, style-proof) ---------------- */
  const host = document.createElement('div');
  host.style.cssText = 'all:initial;position:fixed;top:12px;right:12px;z-index:2147483647;';
  const sh = host.attachShadow({ mode: 'open' });
  sh.innerHTML = `
  <style>
    .bar{display:flex;align-items:center;gap:6px;padding:6px 8px;background:#22242a;color:#e7e9ee;
         border:1px solid #44474f;border-radius:10px;font:13px system-ui,sans-serif;
         box-shadow:0 4px 18px rgba(0,0,0,.45)}
    button{background:#2d3038;color:#e7e9ee;border:1px solid #44474f;border-radius:6px;
           padding:4px 9px;font:inherit;cursor:pointer}
    button:hover{border-color:#4da3ff}
    button.active{background:#4da3ff;color:#082036;border-color:#4da3ff}
    select{max-width:165px;background:#2d3038;color:#e7e9ee;border:1px solid #44474f;border-radius:6px;padding:3px 4px;font:inherit}
    input[type=range]{width:68px;accent-color:#4da3ff}
    #rv{color:#9aa0ab;min-width:30px;text-align:right}
    #st{max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#9aa0ab;font-style:italic;display:none}
  </style>
  <div class="bar">
    <button id="pp" title="Play / pause (Space)">▶</button>
    <select id="vs" title="Voice"></select>
    <input type="range" id="rt" min="0.6" max="2" step="0.1">
    <span id="rv"></span>
    <button id="fl" title="Keep the sentence being read on screen — scrolls only when it would leave the view">Follow</button>
    <span id="st"></span>
    <button id="x" title="Close PDF Voice on this page">✕</button>
  </div>`;
  const $ = id => sh.getElementById(id);

  function fillVoices() {
    voices = speechSynthesis.getVoices();
    if (!voices.length) return;
    if (!currentVoice()) { const d = defaultVoice(); if (d) prefs.voice = d.name; }
    const en = voices.filter(v => v.lang.startsWith('en'));
    const rest = voices.filter(v => !v.lang.startsWith('en'));
    const order = [...en.filter(isNat), ...en.filter(v => !isNat(v)), ...rest];
    $('vs').innerHTML = '';
    for (const v of order) {
      const o = document.createElement('option');
      o.value = v.name; o.textContent = vDisp(v) + ' — ' + v.lang;
      if (v.name === prefs.voice) o.selected = true;
      $('vs').appendChild(o);
    }
  }
  function updateBar() {
    $('pp').textContent = state.playing ? '⏸' : '▶';
    $('fl').classList.toggle('active', state.follow);
  }
  let statusTimer = null;
  function setStatus(msg) {
    const el = $('st');
    el.textContent = msg; el.style.display = 'inline';
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { el.style.display = 'none'; }, 5000);
  }

  /* ---------------- events ---------------- */
  function onClick(e) {
    if (e.target === host || host.contains(e.target)) return;
    if (e.target.closest && e.target.closest(INTERACTIVE)) return; // interactive things stay usable
    const sel = getSelection();
    if (sel && !sel.isCollapsed) return; // selecting text to copy
    const bel = e.target.closest ? e.target.closest(BLOCK_SEL) : null;
    const bi = bel != null ? blockIndex.get(bel) : undefined;
    if (bi === undefined) return;
    e.preventDefault(); e.stopPropagation();
    startReading(bi, sentenceAtPoint(blocks[bi], e.clientX, e.clientY));
  }
  function sentenceAtPoint(b, x, y) {
    let best = 0, bestD = Infinity;
    for (let i = 0; i < b.sentences.length; i++) {
      let range; try { range = sentenceRange(b, i); } catch (e) { continue; }
      if (!range) continue;
      for (const rc of range.getClientRects()) {
        if (y >= rc.top && y <= rc.bottom && x >= rc.left - 4 && x <= rc.right + 4) return i;
        const d = Math.abs((rc.top + rc.bottom) / 2 - y);
        if (d < bestD) { bestD = d; best = i; }
      }
    }
    return best;
  }
  function onKey(e) {
    if (!state.reading) return;
    const t = e.composedPath()[0] || e.target;
    const tag = (t.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable) return;
    if (e.code === 'Space') { e.preventDefault(); e.stopPropagation(); playPause(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); stopUtterance(); advance(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); retreat(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); moveBlock(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveBlock(-1); }
  }
  const onUnload = () => { try { speechSynthesis.cancel(); } catch (e) {} };

  function destroy() {
    state.playing = false; state.reading = null;
    stopUtterance();
    if (canHL) { hlObj.clear(); CSS.highlights.delete('pdfvoice'); }
    if (fbEl) { fbEl.style.background = fbPrev; fbEl = null; }
    hlStyle.remove();
    host.remove();
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('beforeunload', onUnload);
    speechSynthesis.onvoiceschanged = null;
    delete window.__pdfvoiceWeb;
  }

  /* ---------------- init ---------------- */
  loadPrefs().then(() => {
    state.follow = prefs.follow !== false;
    collect();
    document.documentElement.appendChild(host);
    $('rt').value = prefs.rate;
    $('rv').textContent = (+prefs.rate).toFixed(1) + '×';
    fillVoices();
    speechSynthesis.onvoiceschanged = fillVoices;
    updateBar();
    $('pp').onclick = playPause;
    $('x').onclick = destroy;
    $('fl').onclick = () => { state.follow = !state.follow; prefs.follow = state.follow; savePrefs(); updateBar(); };
    $('vs').onchange = () => {
      prefs.voice = $('vs').value; savePrefs();
      if (state.playing) { stopUtterance(); state.playing = true; speakCurrent(); }
    };
    $('rt').oninput = () => {
      prefs.rate = parseFloat($('rt').value); savePrefs();
      $('rv').textContent = prefs.rate.toFixed(1) + '×';
      if (state.playing) { stopUtterance(); state.playing = true; speakCurrent(); }
    };
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('beforeunload', onUnload);
    setStatus(blocks.length ? 'Click a paragraph to read from there.' : 'No readable text found on this page.');
    window.__pdfvoiceWeb = {
      toggle: destroy,
      _debug: () => ({ blocks: blocks.length, aux: blocks.filter(b => b.aux).length, reading: state.reading, playing: state.playing, speaking: speechSynthesis.speaking })
    };
  });
})();
