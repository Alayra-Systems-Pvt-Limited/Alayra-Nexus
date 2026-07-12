import { Field, Input, FieldRow } from '../../ui';
import { HeaderRows } from './HeaderRows';

// The connection block shared by Add- and Edit-provider dialogs: how to reach the provider and how
// to read its model list. Kept as one component so the two dialogs can never drift apart (no dup).
// Identity (name/slug/provider/tier) stays in each dialog because Add and Edit treat it differently
// — Add lets you set slug and provider; Edit locks them (changing either would orphan the registry
// models keyed by provider slug).
export interface ProviderConn {
  preferredModel: string;
  baseUrl:        string;
  modelFetchUrl:  string;
  authHeader:     string;
  authPrefix:     string;
  modelIdPath:    string;
  extraHeaders:   Record<string, string>;
}

export function ProviderFields({ conn, onChange }: { conn: ProviderConn; onChange: (patch: Partial<ProviderConn>) => void }) {
  const set = (k: keyof ProviderConn) => (e: Event) => onChange({ [k]: (e.target as HTMLInputElement).value });
  return (
    <>
      <Field label="Preferred model" hint="optional">
        <Input value={conn.preferredModel} placeholder="gpt-4o" onInput={set('preferredModel')} />
      </Field>

      <Field label="Base URL">
        <Input value={conn.baseUrl} placeholder="https://api.openai.com/v1" onInput={set('baseUrl')} />
      </Field>

      <Field label="Model fetch URL" hint="optional — defaults to base + /models">
        <Input value={conn.modelFetchUrl} placeholder="https://api.example.com/v1/models" onInput={set('modelFetchUrl')} />
      </Field>

      <FieldRow>
        <Field label="Auth header">
          <Input value={conn.authHeader} onInput={set('authHeader')} />
        </Field>
        <Field label="Auth prefix" hint="optional">
          <Input value={conn.authPrefix} placeholder="Bearer" onInput={set('authPrefix')} />
        </Field>
      </FieldRow>

      <Field label="Model ID path" hint="where model ids live in the list response">
        <Input value={conn.modelIdPath} placeholder="data[].id" onInput={set('modelIdPath')} />
      </Field>

      <Field label="Extra headers" hint="optional — sent on every call to this provider">
        <HeaderRows value={conn.extraHeaders} onChange={(extraHeaders) => onChange({ extraHeaders })} />
      </Field>
    </>
  );
}
