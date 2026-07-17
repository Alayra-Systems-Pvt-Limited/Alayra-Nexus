import { CopyButton } from './CopyButton';
import s from './ui.module.css';

/** A multi-line, monospace code sample with a one-click copy. Used for quick-start snippets. */
export function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  return (
    <div class={s.code}>
      {lang && <span class={s.codeLang}>{lang}</span>}
      <CopyButton value={code} iconOnly ariaLabel="Copy code" variant="secondary" class={s.codeCopyPos} />
      <pre><code>{code}</code></pre>
    </div>
  );
}
