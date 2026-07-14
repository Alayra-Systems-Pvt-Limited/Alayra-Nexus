import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { Card, Button, Spinner, FormError } from '../../ui';
import { useApi } from '../../hooks/useApi';
import { useSave } from '../../hooks/useSave';
import s from '../pages.module.css';

// Every settings panel is the same shape: load a config, edit it, save it, and be told plainly
// whether that worked. That shape lives here once — loading, failure-with-retry, the save bar, the
// error, and the confirmation — so the six panels only describe their own fields.
//
// A panel seeds its fields from `data` once, when it mounts, and never re-seeds itself. Two reasons:
//
//  1. A panel that re-seeds from a prop in an effect can stamp the server's value back over an edit
//     the operator has already made — the effect runs after mount, which on a slow config load can
//     land *after* the first click and silently undo it.
//  2. After a save, the gateway returns what it actually stored. That, not the stale load, is the
//     new truth — and until the form is re-seeded from it, the panel would go on claiming
//     "unsaved changes" forever.
//
// So: this component owns the current truth, and on a successful save it swaps in the server's
// response and bumps `version`, which remounts the panel so its fields re-seed from it. One rule,
// no effects, no races.

export interface SaveCtx<T> {
  save:      (body: unknown) => Promise<T | null>;
  saving:    boolean;
  saveError: string | null;
  saved:     boolean;
}

interface Props<T> {
  path:        string;
  title:       string;
  description: string;
  children:    (data: T, ctx: SaveCtx<T>) => ComponentChildren;
}

export function SettingsSection<T>({ path, title, description, children }: Props<T>) {
  const { data, loading, error, reload } = useApi<T>(path);
  const { save: put, saving, error: saveError, saved } = useSave<T>(path);
  // What the server last told us it stored. Null until the first successful save.
  const [stored, setStored] = useState<T | null>(null);
  const [version, setVersion] = useState(0);

  const current = stored ?? data;

  if (loading && !current) {
    return <Card heading={title}><div class={s.centered}><Spinner /> <span>Loading…</span></div></Card>;
  }

  if (error || !current) {
    return (
      <Card heading={title}>
        <div class={s.errBody}>
          <p>Couldn’t load these settings{error ? ` — ${error}` : ''}.</p>
          <Button size="sm" onClick={reload}>Retry</Button>
        </div>
      </Card>
    );
  }

  const save = async (body: unknown): Promise<T | null> => {
    const next = await put(body);
    if (next) {
      setStored(next);
      setVersion((v) => v + 1); // remount the panel so its fields re-seed from what was stored
    }
    return next;
  };

  return (
    <Card heading={title}>
      <p class={s.setDesc}>{description}</p>
      {saveError && <FormError>{saveError}</FormError>}
      <div class={s.setBody} key={version}>
        {children(current, { save, saving, saveError, saved })}
      </div>
    </Card>
  );
}

/** The footer every panel ends with: the save action, and an honest word about what just happened. */
export function SaveBar({ ctx, onSave, dirty }: { ctx: SaveCtx<unknown>; onSave: () => void; dirty: boolean }) {
  return (
    <div class={s.setSave}>
      <Button variant="primary" size="sm" onClick={onSave} disabled={ctx.saving || !dirty}>
        {ctx.saving ? 'Saving…' : 'Save changes'}
      </Button>
      {ctx.saved && <span class={s.setSaved}>Saved</span>}
      {!ctx.saved && dirty && <span class={s.setDirty}>Unsaved changes</span>}
    </div>
  );
}
