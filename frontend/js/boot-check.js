// Classic script, deliberately NOT a module.
//
// The dashboard is built from ES modules, and a browser refuses to load a module
// over `file://` (its origin is `null`, so the fetch fails CORS). Opening
// index.html by double-clicking it therefore leaves every button inert with no
// visible error — the markup renders, but no handler is ever attached.
//
// A classic script *is* allowed over `file://`, so this one runs when main.js
// cannot, and says so.
(function () {
  if (window.location.protocol !== 'file:') return;

  var box = document.querySelector('.login-box');
  if (!box) return;

  box.innerHTML =
    '<div class="login-logo">Alayra Nexus™</div>' +
    '<div class="login-sub">by Alayra Systems</div>' +
    '<p style="margin-top:18px;font-size:13px;line-height:1.6;color:var(--muted)">' +
      'This page is open from your filesystem, so the browser blocks the dashboard\'s ' +
      'scripts. It needs to be served over HTTP.' +
    '</p>' +
    '<p style="margin-top:14px;font-size:13px;line-height:1.6;color:var(--muted)">' +
      'Start the gateway and open <code style="color:var(--accent)">http://localhost:3000</code>:' +
    '</p>' +
    '<pre style="margin-top:10px;padding:10px;border-radius:6px;background:#0d0d12;' +
      'border:1px solid var(--border);font-size:12px;color:var(--text);overflow-x:auto">npm run dev</pre>' +
    '<p style="margin-top:14px;font-size:12px;color:var(--subtle)">' +
      'To preview the dashboard without a database, serve this folder on its own:' +
    '</p>' +
    '<pre style="margin-top:8px;padding:10px;border-radius:6px;background:#0d0d12;' +
      'border:1px solid var(--border);font-size:12px;color:var(--text);overflow-x:auto">npx serve frontend</pre>';
})();
