// Presentation helpers with no API or state dependencies.

/**
 * Escape a value before it is interpolated into `innerHTML`. Provider base URLs,
 * team names, key labels, and upstream error text all originate outside the
 * dashboard, so none of them may reach the document unescaped.
 */
export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

export function toast(msg, isErr) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.style.borderColor = isErr ? 'var(--red)' : 'var(--green)';
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 3000);
}

export function copyText(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    toast('Copied to clipboard');
    if (btn) {
      const orig = btn.textContent;
      btn.textContent = '✓';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = orig; btn.classList.remove('copied'); }, 2000);
    }
  });
}

export function fmtNum(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n || 0);
}

export function openModal() { document.getElementById('modal-bg').classList.add('open'); }

export function closeModal(e) {
  if (!e || e.target === document.getElementById('modal-bg')) {
    document.getElementById('modal-bg').classList.remove('open');
  }
}
