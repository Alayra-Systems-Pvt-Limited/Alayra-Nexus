import { useState, useRef } from 'preact/hooks';
import { Upload, Trash2 } from 'lucide-preact';
import { PUT, ApiError, type Branding } from '../../api';
import { Card, Button, Field, Input, FormError, Spinner } from '../../ui';
import { useApi } from '../../hooks/useApi';
import { announceBrandingChange } from '../../hooks/useBranding';
import s from '../pages.module.css';
import b from './branding.module.css';

// Company name + logo on the dashboard and the sign-in screen (P7.11).
//
// The logo is read in the browser and sent as a base64 data URI, so it is stored in the gateway and
// served from its own origin. It is deliberately not a URL: this gateway self-hosts its assets (the
// chart CDN was removed for exactly this reason), and a remote logo would both break air-gapped or
// strict-CSP deployments and leak a request to a third party on every load of a public sign-in page.

const MAX_LOGO_KB = 64;
const ACCEPT = 'image/png,image/jpeg,image/webp,image/svg+xml';

export function BrandingCard() {
  const { data, loading, error, reload } = useApi<Branding>('/branding');

  if (loading && !data) return <Card heading="Branding"><div class={s.centered}><Spinner /> <span>Loading…</span></div></Card>;
  if (error && !data) {
    return (
      <Card heading="Branding">
        <div class={s.errBody}>
          <p>Couldn’t load branding — {error}.</p>
          <Button size="sm" onClick={reload}>Retry</Button>
        </div>
      </Card>
    );
  }
  return <BrandingForm data={data ?? { companyName: '', logoDataUri: '' }} onSaved={reload} />;
}

function BrandingForm({ data, onSaved }: { data: Branding; onSaved: () => void }) {
  const [name, setName] = useState(data.companyName);
  const [logo, setLogo] = useState(data.logoDataUri);
  const [busy, setBusy] = useState(false);
  const [err, setErr]   = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const dirty = name !== data.companyName || logo !== data.logoDataUri;

  const pick = (e: Event) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    setErr(null); setSaved(false);
    // Checked here for a fast, specific message; the gateway validates again on write, because a
    // client-side check is a courtesy, never a control.
    if (file.size > MAX_LOGO_KB * 1024) {
      setErr(`That image is ${Math.round(file.size / 1024)}KB. Please use one under ${MAX_LOGO_KB}KB.`);
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => setErr('That file could not be read.');
    reader.onload  = () => setLogo(String(reader.result ?? ''));
    reader.readAsDataURL(file);
  };

  const save = async () => {
    if (busy) return;
    setBusy(true); setErr(null); setSaved(false);
    try {
      await PUT<Branding>('/admin/branding', { companyName: name.trim(), logoDataUri: logo });
      setSaved(true);
      onSaved();
      // The sidebar (and the next sign-in screen) read branding through their own fetch, so tell
      // them to re-read — otherwise saving a new name leaves the old one on screen until a reload.
      announceBrandingChange();
    } catch (e) {
      setErr(e instanceof ApiError && e.status === 403
        ? 'Your session is read-only (viewer). An owner credential is required to change branding.'
        : e instanceof ApiError ? e.message : 'Could not save branding.');
    } finally { setBusy(false); }
  };

  return (
    <Card heading="Branding" class={s.section}>
      <p class={s.setDesc}>
        Your company’s name and logo, shown in the sidebar and on the sign-in screen. Leave both empty
        to use Alayra Nexus’s own. This is a gateway setting — everyone who signs in sees it.
      </p>

      {err && <FormError>{err}</FormError>}

      <Field label="Company name" hint="blank = “Alayra Nexus”">
        <Input value={name} placeholder="e.g. Acme Corp" maxLength={60}
          onInput={(e) => { setName((e.target as HTMLInputElement).value); setSaved(false); }} />
      </Field>

      <div class={b.logoRow}>
        <span class={b.logoPreview}>
          <img src={logo || '/logo.svg'} alt="" width="40" height="40" />
        </span>
        <div class={b.logoActions}>
          <input ref={fileRef} type="file" accept={ACCEPT} class={b.fileInput} onChange={pick} />
          <Button size="sm" onClick={() => fileRef.current?.click()}><Upload size={13} /> Choose logo</Button>
          {logo && (
            <Button size="sm" variant="ghost" onClick={() => { setLogo(''); setSaved(false); }}>
              <Trash2 size={13} /> Remove
            </Button>
          )}
          <span class={b.logoHint}>PNG, JPEG, WEBP or SVG · under {MAX_LOGO_KB}KB</span>
        </div>
      </div>

      <p class={s.setHint}>
        The logo is stored in the gateway and served from it — never fetched from another site — so it
        keeps working on an air-gapped or strict-CSP deployment.
      </p>

      <div class={s.setSave}>
        <Button variant="primary" size="sm" onClick={save} disabled={!dirty || busy}>
          {busy ? 'Saving…' : 'Save branding'}
        </Button>
        {saved && !dirty && <span class={s.setSaved}>Saved</span>}
      </div>
    </Card>
  );
}
