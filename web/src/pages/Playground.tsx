import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Eraser, RotateCcw, Send, ShieldCheck, SlidersHorizontal, Square, Sparkles } from 'lucide-preact';
import { PageHeader, Button, Field, Input, Select, Spinner } from '../ui';
import { useApi } from '../hooks/useApi';
import { canWrite } from '../lib/access';
import {
  runPlayground,
  type PlaygroundMessage,
  type PlaygroundModelsResponse,
  type PlaygroundResult,
} from '../lib/playground';
import s from './playground/playground.module.css';

interface ChatMessage extends PlaygroundMessage {
  id: string;
  model?: string;
  error?: string;
  stopped?: boolean;
}

const AUTO_MODEL = 'alayra-nexus-1';
const text = (message: PlaygroundMessage): string => message.content.map((part) => part.text).join('\n');
const makeMessage = (role: ChatMessage['role'], value: string): ChatMessage => ({
  id: crypto.randomUUID(),
  role,
  content: [{ type: 'text', text: value }],
});

export function Playground() {
  const { data, loading, error: modelsError, reload } =
    useApi<PlaygroundModelsResponse>('/admin/playground/models');
  const [model, setModel] = useState(AUTO_MODEL);
  const [temperature, setTemperature] = useState(0.7);
  const [maxTokens, setMaxTokens] = useState(2048);
  const [systemPrompt, setSystemPrompt] = useState('');
  const [systemOpen, setSystemOpen] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [running, setRunning] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const conversation = useRef<HTMLDivElement | null>(null);
  const writable = canWrite();

  const models = data?.models ?? [];
  useEffect(() => {
    if (models.length > 0 && !models.some((item) => item.id === model)) setModel(models[0].id);
  }, [model, models]);

  useEffect(() => {
    const node = conversation.current;
    if (!node) return;
    if (typeof node.scrollTo === 'function') node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' });
    else node.scrollTop = node.scrollHeight;
  }, [messages]);

  const selected = useMemo(() => models.find((item) => item.id === model), [model, models]);

  const updateAssistant = (id: string, change: (message: ChatMessage) => ChatMessage) => {
    setMessages((current) => current.map((message) => message.id === id ? change(message) : message));
  };

  const execute = async (history: ChatMessage[]) => {
    const assistant = makeMessage('assistant', '');
    setMessages([...history, assistant]);
    setRunning(true);
    const abort = new AbortController();
    controller.current = abort;

    const requestMessages: PlaygroundMessage[] = [
      ...(systemPrompt.trim() ? [{ role: 'system' as const, content: [{ type: 'text' as const, text: systemPrompt.trim() }] }] : []),
      ...history.map(({ role, content }) => ({ role, content })),
    ];

    try {
      await runPlayground({
        model,
        messages: requestMessages,
        temperature,
        maxTokens,
      }, {
        onDelta: (delta) => updateAssistant(assistant.id, (message) => ({
          ...message,
          content: [{ type: 'text', text: text(message) + delta }],
        })),
        onResult: (result: PlaygroundResult) => updateAssistant(assistant.id, (message) => ({
          ...message,
          model: result.trace.route?.modelString
            ?? result.response.headers['x-nexus-model']
            ?? selected?.displayName
            ?? model,
        })),
      }, abort.signal);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') {
        updateAssistant(assistant.id, (message) => ({ ...message, stopped: true }));
      } else {
        const message = cause instanceof Error ? cause.message : 'The Playground request failed.';
        updateAssistant(assistant.id, (current) => ({ ...current, error: message }));
      }
    } finally {
      if (controller.current === abort) controller.current = null;
      setRunning(false);
    }
  };

  const send = () => {
    const value = prompt.trim();
    if (!value || running || !writable || models.length === 0) return;
    const history = [...messages, makeMessage('user', value)];
    setPrompt('');
    void execute(history);
  };

  const regenerate = () => {
    if (running) return;
    let lastUser = -1;
    for (let index = messages.length - 1; index >= 0; index--) {
      if (messages[index].role === 'user') { lastUser = index; break; }
    }
    if (lastUser >= 0) void execute(messages.slice(0, lastUser + 1));
  };

  const stop = () => controller.current?.abort();
  const clear = () => {
    controller.current?.abort();
    setMessages([]);
    setPrompt('');
  };

  return (
    <div class={s.page}>
      <PageHeader
        title="Playground"
        subtitle="Test the gateway through the same route your apps use."
        actions={
          <Button size="sm" onClick={clear} disabled={messages.length === 0 && !prompt}>
            <Eraser size={15} /> Clear chat
          </Button>
        }
      />

      <section class={s.controls} aria-label="Request settings">
        <Field label="Model">
          <Select value={model} disabled={loading || models.length === 0 || running}
            onChange={(event) => setModel(event.currentTarget.value)}>
            {models.map((item) => (
              <option key={item.id} value={item.id}>
                {item.auto ? 'Auto — Nexus routing' : item.displayName + ' — ' + item.provider}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Temperature">
          <div class={s.rangeRow}>
            <input class={s.range} type="range" min="0" max="2" step="0.1" value={temperature}
              disabled={running}
              onInput={(event) => setTemperature(Number(event.currentTarget.value))} />
            <output class={s.number}>{temperature.toFixed(1)}</output>
          </div>
        </Field>

        <Field label="Max tokens">
          <Input type="number" min="1" max={selected?.maxTokens || 131072} value={maxTokens}
            disabled={running}
            onInput={(event) => setMaxTokens(Math.max(1, Number(event.currentTarget.value) || 1))} />
        </Field>

        <div class={s.systemControl}>
          <Button size="sm" variant={systemOpen ? 'secondary' : 'ghost'} onClick={() => setSystemOpen((open) => !open)}>
            <SlidersHorizontal size={14} /> System prompt
          </Button>
        </div>

        {systemOpen && (
          <label class={s.systemPrompt}>
            <span>System prompt</span>
            <textarea value={systemPrompt} disabled={running} rows={2}
              placeholder="Give the model instructions for this conversation."
              onInput={(event) => setSystemPrompt(event.currentTarget.value)} />
          </label>
        )}
      </section>

      <section class={s.workspace}>
        {loading && (
          <div class={s.state}><Spinner /> <span>Loading available models…</span></div>
        )}
        {modelsError && (
          <div class={s.state} role="alert">
            <span>Couldn’t load models — {modelsError}</span>
            <Button size="sm" onClick={reload}>Retry</Button>
          </div>
        )}
        {!loading && !modelsError && models.length === 0 && (
          <div class={s.empty}>
            <Sparkles size={24} />
            <strong>No chat models are ready</strong>
            <p>Add an active provider key and chat model in Nexus, then return here to test it.</p>
          </div>
        )}
        {!loading && !modelsError && models.length > 0 && messages.length === 0 && (
          <div class={s.empty}>
            <Sparkles size={24} />
            <strong>Test your gateway</strong>
            <p>Choose a model or leave Nexus routing on Auto, then send your first prompt.</p>
          </div>
        )}

        {messages.length > 0 && (
          <div class={s.conversation} ref={conversation} aria-live="polite">
            {messages.filter((message) => message.role !== 'system').map((message) => (
              <article key={message.id} class={message.role === 'user' ? s.userMessage : s.assistantMessage}>
                <div class={s.avatar} aria-hidden="true">{message.role === 'user' ? 'Y' : 'N'}</div>
                <div class={s.messageMain}>
                  <div class={s.messageHead}>
                    <strong>{message.role === 'user' ? 'You' : 'Nexus'}</strong>
                    {message.model && <span>{message.model} · routed</span>}
                    {message.stopped && <span>stopped</span>}
                  </div>
                  {text(message) && <div class={s.messageText}>{text(message)}</div>}
                  {message.role === 'assistant' && running && message.id === messages[messages.length - 1]?.id && !message.error && (
                    <span class={s.cursor} aria-label="Streaming response" />
                  )}
                  {message.error && <div class={s.messageError} role="alert">{message.error}</div>}
                </div>
              </article>
            ))}
            {!running && messages.some((message) => message.role === 'assistant') && (
              <div class={s.regenerate}>
                <Button size="sm" onClick={regenerate}><RotateCcw size={14} /> Regenerate</Button>
              </div>
            )}
          </div>
        )}
      </section>

      <section class={s.composer}>
        <textarea
          value={prompt}
          rows={2}
          disabled={running || models.length === 0 || !writable}
          placeholder={writable ? 'Write a message…' : 'Viewer access cannot run provider requests.'}
          aria-label="Message"
          onInput={(event) => setPrompt(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              send();
            }
          }}
        />
        <div class={s.composerActions}>
          {running ? (
            <Button onClick={stop}><Square size={13} fill="currentColor" /> Stop</Button>
          ) : (
            <Button variant="primary" onClick={send}
              disabled={!prompt.trim() || models.length === 0 || !writable}>
              <Send size={15} /> Send
            </Button>
          )}
        </div>
      </section>
      <div class={s.privacy}><ShieldCheck size={14} /> Prompts pass through your gateway and are not stored.</div>
    </div>
  );
}
