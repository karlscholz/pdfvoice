// PDF Voice toolbar button: open the active tab's document in the viewer.
chrome.action.onClicked.addListener((tab) => {
  const url = tab && tab.url ? tab.url : '';
  let target = chrome.runtime.getURL('pdfvoice.html');
  // pass along anything that looks fetchable; the viewer handles errors
  if (/^(https?|file):/.test(url)) target += '?file=' + encodeURIComponent(url);
  chrome.tabs.create({ url: target, index: tab ? tab.index + 1 : undefined });
});
