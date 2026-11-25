# PDF Voice

I don't learn by just reading alone, and every PDF read-aloud I tried sucked —
so I built one that doesn't. Click a paragraph and listen on while your mind
and eyes are free to wander off to the figures...

One codebase, three ways to use it:

| Mode | What it is |
|---|---|
| **Browser extension** (Edge/Chromium + Firefox) | Toolbar button: opens the PDF from the current tab in the viewer. Extension pages may fetch cross-origin, so any PDF URL works. |
| **Standalone app** | `pdfvoice.desktop` opens `pdfvoice.html` as an Edge app window ("PDF Voice" in the app grid). Remote URLs limited by CORS (arXiv works); local files via 📂/drag-drop. |
| **Plain page** | Open `pdfvoice.html` in any browser. |

## Install

### Edge (or any Chromium)
1. `edge://extensions` → enable **Developer mode** (left sidebar)
2. **Load unpacked** → select this folder
3. Optional, for local PDFs opened as `file://`: extension **Details** → enable **Allow access to file URLs**
4. Pin "PDF Voice" via the puzzle-piece menu. Open any PDF, click the button.

### Firefox
`about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → pick `manifest.json`.

Caveats:
- Release Firefox enforces extension signing, so the add-on is **temporary** (gone after restart). Permanent needs AMO self-distribution signing, or Firefox ESR/Developer with `xpinstall.signatures.required=false`.
- Firefox on Linux gets its voices from speech-dispatcher — espeak by default (robotic). Install Piper voices via [Pied](https://github.com/Elleo/pied) for decent local ones. The Microsoft "Natural" voices exist only inside Edge.

### App launcher
```sh
cp pdfvoice.desktop ~/.local/share/applications/
```
(adjust the path in `Exec=` if the repo lives elsewhere)

## Usage
- **Click any paragraph** → reads from that sentence, keeps going (block → block → next page) until you pause or it hits the end
- `Space` pause/resume · `←`/`→` sentence · `↑`/`↓` paragraph (handy to skip figure captions)
- **Voice box**: type to search (e.g. "english", "sonia"); ✦ marks natural online voices
- **Follow** keeps the spoken sentence on screen: the view stays put while the highlight is visible and only scrolls (centering it) when it would leave the screen — so you can glance at a figure and get pulled back when the text moves on. Turn Follow off to scroll freely; **⤓ Current** centers the spoken sentence anytime
- **💬** (top right) shows the bottom bar with the sentence being read — hidden by default since the yellow highlight already marks it; status messages flash it briefly either way
- **Resume**: reopening a PDF jumps back to the sentence you were on (highlighted, `Space` continues) or your scroll position if you never played it. Keyed by URL (or filename+size for local files), capped at the 50 most recent PDFs, oldest evicted — a few KB of localStorage total. Positions survive app updates: the sentence is re-found by its text if extraction indices shift.
- arXiv URLs paste straight into the URL box

## For AI agents (and humans) contributing here

- Keep the commit message style used throughout this repo: short imperative
  summary line, blank line, then a body explaining what changed and why.
- Author commits only as the name and email shown on this repository owner's
  public GitHub profile. Never use any other email address or identity.
- Do not add `Co-Authored-By:` or any other attribution trailers.
- Make sure nothing personal or otherwise unnecessary leaks into the repo:
  no private email addresses, employer or client names, machine usernames,
  local absolute paths, tokens or keys — not in file contents, not in commit
  messages, not in history.
- When in doubt, leave it out: this repo is public.

## Notes
- pdf.js pinned at 3.11.174, vendored (`pdf.min.js`, `pdf.worker.min.js`) — no build step, no CDN, works offline
- Text extraction: lines split at column gutters, paragraph blocks grown per column, bands around full-width blocks for reading order; rotated text (margin stamps, axis labels) is skipped
- The speech engine polls `speechSynthesis.speaking` instead of trusting `onend`/`onerror` — Edge's online voices fire bogus `synthesis-failed` events while audio still plays, and sometimes drop `onend`
- Scanned PDFs have no text layer — OCR them first (e.g. `ocrmypdf`)
