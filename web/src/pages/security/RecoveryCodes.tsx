import { Download } from 'lucide-preact';
import { Button, CopyButton } from '../../ui';
import { download } from '../../lib/download';
import s from '../pages.module.css';

// The one-time reveal of recovery codes, shown after enrolling or regenerating. They are stored only
// as hashes on the server, so this is the single moment they exist in the clear — the copy is loud
// about that, because there is no second chance to see them.

// The saved file, headed so it is recognisable months later in a downloads folder. Kept here (not
// in the download helper) because this heading is specific to recovery codes.
function recoveryFile(codes: string[]): string {
  return `Alayra Nexus TOTP Recovery code\n\n${codes.join('\n')}\n`;
}

export function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  return (
    <div class={s.recovery}>
      <p class={s.recoveryWarn}>
        <b>Save these recovery codes now.</b> Each one works once, to sign in if you lose your
        authenticator. They are never shown again — the gateway keeps only a hash.
      </p>
      <div class={s.recoveryGrid}>
        {codes.map((c) => <code key={c} class={s.recoveryCode}>{c}</code>)}
      </div>
      <div class={s.recoveryActions}>
        <CopyButton value={codes.join('\n')} label="Copy all" copiedLabel="Copied all" variant="secondary" />
        <Button size="sm" variant="secondary" onClick={() => download('nexus-recovery.txt', recoveryFile(codes))}>
          <Download size={14} /> Download
        </Button>
        <Button size="sm" variant="primary" onClick={onDone}>I’ve saved them</Button>
      </div>
    </div>
  );
}
