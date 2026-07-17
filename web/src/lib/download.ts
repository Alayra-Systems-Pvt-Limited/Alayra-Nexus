// Save a string to a file the browser downloads. Used for the credentials shown exactly once —
// recovery keys and codes — so "I'll write it down" has a reliable alternative to a screenshot.
//
// A Blob + object URL is the whole mechanism: no server round-trip (these secrets must never leave
// the browser a second time), and the URL is revoked once the click is dispatched so the blob is
// not held in memory for the tab's lifetime.
export function download(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick — revoking synchronously can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
