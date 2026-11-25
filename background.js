// PDF Voice toolbar button.
// PDFs open in the viewer; any other page gets website mode injected in place
// (a second click toggles it off). Injection fails on browser-internal pages
// (including the built-in PDF viewer hosting URLs that don't end in .pdf),
// in which case we fall back to the viewer.
function openViewer(tab, url) {
  let target = chrome.runtime.getURL('pdfvoice.html');
  if (/^(https?|file):/.test(url)) target += '?file=' + encodeURIComponent(url);
  chrome.tabs.create({ url: target, index: tab ? tab.index + 1 : undefined });
}

chrome.action.onClicked.addListener(async (tab) => {
  const url = tab && tab.url ? tab.url : '';
  const pdfish = /\.pdf([?#]|$)/i.test(url) || /arxiv\.org\/pdf\//i.test(url);
  if (!pdfish && tab && tab.id != null) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['web.js'] });
      return;
    } catch (e) { /* not injectable — treat as a document for the viewer */ }
  }
  openViewer(tab, url);
});
