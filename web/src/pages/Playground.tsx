import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Check, Columns3, Eraser, MessageSquare, RotateCcw, Send, ShieldCheck, SlidersHorizontal, Square, Sparkles } from 'lucide-preact';
import { PageHeader, Button, Field, Input, Select, Spinner } from '../ui';
import { useApi } from '../hooks/useApi';
import { canWrite } from '../lib/access';
import { runPlayground, type PlaygroundMessage, type PlaygroundModel, type PlaygroundModelsResponse, type PlaygroundResult } from '../lib/playground';
import { PlaygroundResponse, type PlaygroundAssistant } from './playground/PlaygroundResponse';
import s from './playground/playground.module.css';

interface UserMessage extends PlaygroundMessage { id: string }
interface ChatTurn { id: string; user: UserMessage; responses: PlaygroundAssistant[] }
type PlaygroundMode = 'single' | 'compare';

const AUTO_MODEL = 'alayra-nexus-1';
const MAX_COMPARISON_MODELS = 4;
const EMPTY_MODELS: PlaygroundModel[] = [];
const text = (message: PlaygroundMessage): string => message.content.map((part) => part.text).join('\n');
const makeUserMessage = (value: string): UserMessage => ({
  id: crypto.randomUUID(), role: 'user', content: [{ type: 'text', text: value }],
});

export function Playground() {
  const { data, loading, error: modelsError, reload } = useApi<PlaygroundModelsResponse>('/admin/playground/models');
  const [mode, setMode] = useState<PlaygroundMode>('single');
  const [model, setModel] = useState(AUTO_MODEL);
  const [comparisonModels, setComparisonModels] = useState<string[]>([]);
  const [temperature, setTemperature] = useState(0.7);
  const [maxTokens, setMaxTokens] = useState(2048);
  const [systemPrompt, setSystemPrompt] = useState('');
  const [systemOpen, setSystemOpen] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [running, setRunning] = useState(false);
  const controllers = useRef(new Map<string, AbortController>());
  const conversation = useRef<HTMLDivElement | null>(null);
  const writable = canWrite();

  useEffect(() => () => {
    controllers.current.forEach((abort) => abort.abort());
  }, []);

  const models = data?.models ?? EMPTY_MODELS;
  useEffect(() => {
    if (models.length > 0 && !models.some((item) => item.id === model)) setModel(models[0].id);
    setComparisonModels((current) => {
      const available = current.filter((id) => models.some((item) => item.id === id));
      if (available.length >= Math.min(2, models.length)) return available;
      return models.slice(0, Math.min(2, models.length)).map((item) => item.id);
    });
  }, [model, models]);

  useEffect(() => {
    const node = conversation.current;
    if (!node) return;
    if (typeof node.scrollTo === 'function') node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' });
    else node.scrollTop = node.scrollHeight;
  }, [turns]);

  const selected = useMemo(() => models.find((item) => item.id === model), [model, models]);
  const comparisonSelected = useMemo(
    () => comparisonModels.flatMap((id) => models.find((item) => item.id === id) ?? []),
    [comparisonModels, models],
  );
  const activeModels = useMemo(
    () => mode === 'single' ? (selected ? [selected] : []) : comparisonSelected,
    [comparisonSelected, mode, selected],
  );
  const maxTokenLimit = useMemo(() => {
    const limits = activeModels.map((item) => item.maxTokens).filter((limit) => limit > 0);
    return limits.length > 0 ? Math.min(...limits) : 131_072;
  }, [activeModels]);

  useEffect(() => setMaxTokens((current) => Math.min(current, maxTokenLimit)), [maxTokenLimit]);

  const updateAssistant = (
    turnId: string,
    responseId: string,
    change: (message: PlaygroundAssistant) => PlaygroundAssistant,
  ) => {
    setTurns((current) => current.map((turn) => turn.id === turnId
      ? { ...turn, responses: turn.responses.map((response) => response.id === responseId ? change(response) : response) }
      : turn));
  };

  const execute = async (history: ChatTurn[], user: UserMessage, targets: PlaygroundModel[] = activeModels) => {
    const turnId = crypto.randomUUID();
    const responses: PlaygroundAssistant[] = targets.map((target) => ({
      id: crypto.randomUUID(),
      role: 'assistant',
      content: [{ type: 'text', text: '' }],
      requestedModel: target.id,
      requestedLabel: target.auto ? 'Nexus Auto' : target.displayName,
      provider: target.provider,
      status: 'streaming',
    }));
    setTurns([...history, { id: turnId, user, responses }]);
    setRunning(true);

    await Promise.all(responses.map(async (response, index) => {
      const target = targets[index];
      const abort = new AbortController();
      controllers.current.set(response.id, abort);
      const branchHistory: PlaygroundMessage[] = history.flatMap((turn) => {
        const prior = turn.responses.find((item) => item.requestedModel === target.id);
        return prior && text(prior).trim()
          ? [{ role: 'user' as const, content: turn.user.content }, { role: 'assistant' as const, content: prior.content }]
          : [{ role: 'user' as const, content: turn.user.content }];
      });
      const requestMessages: PlaygroundMessage[] = [
        ...(systemPrompt.trim() ? [{ role: 'system' as const, content: [{ type: 'text' as const, text: systemPrompt.trim() }] }] : []),
        ...branchHistory,
        { role: 'user', content: user.content },
      ];

      try {
        await runPlayground({ model: target.id, messages: requestMessages, temperature, maxTokens }, {
          onDelta: (delta) => updateAssistant(turnId, response.id, (message) => ({
            ...message, content: [{ type: 'text', text: text(message) + delta }],
          })),
          onResult: (result: PlaygroundResult) => updateAssistant(turnId, response.id, (message) => ({
            ...message,
            status: 'complete',
            diagnostics: result.trace,
            resolvedModel: result.trace.route?.modelString ?? result.response.headers['x-nexus-model'] ?? target.displayName,
          })),
        }, abort.signal);
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === 'AbortError') {
          updateAssistant(turnId, response.id, (message) => ({ ...message, status: 'stopped' }));
        } else {
          const error = cause instanceof Error ? cause.message : 'The Playground request failed.';
          updateAssistant(turnId, response.id, (current) => ({ ...current, status: 'error', error }));
        }
      } finally {
        controllers.current.delete(response.id);
      }
    }));
    setRunning(false);
  };

  const send = () => {
    const value = prompt.trim();
    const minimumModels = mode === 'compare' ? 2 : 1;
    if (!value || running || !writable || activeModels.length < minimumModels) return;
    setPrompt('');
    void execute(turns, makeUserMessage(value));
  };

  const regenerate = () => {
    if (running) return;
    const last = turns.at(-1);
    if (!last) return;
    const targets = last.responses.flatMap((response) => models.find((item) => item.id === response.requestedModel) ?? []);
    void execute(turns.slice(0, -1), last.user, targets);
  };

  const stop = () => controllers.current.forEach((abort) => abort.abort());
  const clear = () => { stop(); setTurns([]); setPrompt(''); };
  const toggleComparisonModel = (id: string) => {
    if (running || turns.length > 0) return;
    setComparisonModels((current) => current.includes(id)
      ? current.filter((item) => item !== id)
      : current.length < MAX_COMPARISON_MODELS ? [...current, id] : current);
  };
  const changeMode = (next: PlaygroundMode) => {
    if (!running && turns.length === 0) setMode(next);
  };

  const selectionLocked = running || turns.length > 0;
  const comparisonReady = comparisonModels.length >= 2;

  return (
    <div class={s.page}>
      <PageHeader
        title="Playground"
        subtitle="Test one route or compare models through the same gateway path your apps use."
        actions={
          <Button size="sm" onClick={clear} disabled={turns.length === 0 && !prompt}>
            <Eraser size={15} /> Clear chat
          </Button>
        }
      />

      <section class={s.controls} aria-label="Request settings">
        <div class={s.modeControl} role="group" aria-label="Playground mode">
          <Button size="sm" variant={mode === 'single' ? 'primary' : 'ghost'} aria-pressed={mode === 'single'}
            disabled={selectionLocked} onClick={() => changeMode('single')}>
            <MessageSquare size={14} /> Single
          </Button>
          <Button size="sm" variant={mode === 'compare' ? 'primary' : 'ghost'} aria-pressed={mode === 'compare'}
            disabled={selectionLocked} onClick={() => changeMode('compare')}>
            <Columns3 size={14} /> Compare
          </Button>
        </div>

        {mode === 'single' ? (
          <Field label="Model">
            <Select value={model} disabled={loading || models.length === 0 || selectionLocked}
              onChange={(event) => setModel(event.currentTarget.value)}>
              {models.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.auto ? 'Auto - Nexus routing' : item.displayName + ' - ' + item.provider}
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <div class={s.modelSelection}>
            <span class={s.controlLabel}>Models <small>{comparisonModels.length}/{MAX_COMPARISON_MODELS}</small></span>
            <div class={s.modelChoices} role="group" aria-label="Comparison models">
              {models.map((item) => {
                const chosen = comparisonModels.includes(item.id);
                const atLimit = comparisonModels.length >= MAX_COMPARISON_MODELS;
                return (
                  <button type="button" key={item.id} aria-pressed={chosen}
                    disabled={selectionLocked || (!chosen && atLimit)}
                    class={chosen ? s.modelChoiceActive : s.modelChoice}
                    onClick={() => toggleComparisonModel(item.id)}>
                    <span class={s.choiceCheck}>{chosen && <Check size={11} />}</span>
                    <span><strong>{item.auto ? 'Nexus Auto' : item.displayName}</strong><small>{item.provider}</small></span>
                  </button>
                );
              })}
            </div>
            {!comparisonReady && <span class={s.selectionHint}>Select at least two models.</span>}
          </div>
        )}

        <Field label="Temperature">
          <div class={s.rangeRow}>
            <input class={s.range} type="range" min="0" max="2" step="0.1" value={temperature}
              disabled={running}
              onInput={(event) => setTemperature(Number(event.currentTarget.value))} />
            <output class={s.number}>{temperature.toFixed(1)}</output>
          </div>
        </Field>

        <Field label="Max tokens">
          <Input type="number" min="1" max={maxTokenLimit} value={maxTokens}
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
        {loading && <div class={s.state}><Spinner /> <span>Loading available models...</span></div>}
        {modelsError && (
          <div class={s.state} role="alert">
            <span>Couldn't load models - {modelsError}</span>
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
        {!loading && !modelsError && models.length > 0 && turns.length === 0 && (
          <div class={s.empty}>
            <Sparkles size={24} />
            <strong>{mode === 'compare' ? 'Compare models side by side' : 'Test your gateway'}</strong>
            <p>{mode === 'compare'
              ? 'Choose two to four models, then send one prompt to every lane at the same time.'
              : 'Choose a model or leave Nexus routing on Auto, then send your first prompt.'}</p>
          </div>
        )}

        {turns.length > 0 && (
          <div class={s.conversation} ref={conversation} aria-live="polite">
            {turns.map((turn) => (
              <div class={s.turn} key={turn.id}>
                <article class={s.userMessage}>
                  <div class={s.avatar} aria-hidden="true">Y</div>
                  <div class={s.messageMain}>
                    <div class={s.messageHead}><strong>You</strong></div>
                    <div class={s.messageText}>{text(turn.user)}</div>
                  </div>
                </article>
                {mode === 'compare' || turn.responses.length > 1 ? (
                  <div class={s.comparisonGrid} data-lanes={turn.responses.length}>
                    {turn.responses.map((response) => (
                      <PlaygroundResponse key={response.id} response={response} comparison />
                    ))}
                  </div>
                ) : turn.responses[0] ? <PlaygroundResponse response={turn.responses[0]} /> : null}
              </div>
            ))}
            {!running && turns.length > 0 && (
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
          disabled={running || models.length === 0 || !writable || (mode === 'compare' && !comparisonReady)}
          placeholder={!writable ? 'Viewer access cannot run provider requests.'
            : mode === 'compare' && !comparisonReady ? 'Select at least two models to compare.'
              : mode === 'compare' ? `Ask ${comparisonModels.length} models the same question...` : 'Write a message...'}
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
            <Button onClick={stop}><Square size={13} fill="currentColor" /> Stop all</Button>
          ) : (
            <Button variant="primary" onClick={send}
              disabled={!prompt.trim() || models.length === 0 || !writable || (mode === 'compare' && !comparisonReady)}>
              <Send size={15} /> {mode === 'compare' ? `Run ${comparisonModels.length} models` : 'Send'}
            </Button>
          )}
        </div>
      </section>
      <div class={s.privacy}><ShieldCheck size={14} /> Prompts pass through your gateway and are not stored.</div>
    </div>
  );
}
