import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Activity, ChevronDown, Columns3, Database, Eraser, Gauge, GitCompareArrows, MessageSquare, RotateCcw, Send, ShieldCheck, SlidersHorizontal, Square, Sparkles, WalletCards } from 'lucide-preact';
import { PageHeader, Button, Field, Input, Select, Spinner } from '../ui';
import { useApi } from '../hooks/useApi';
import { canWrite } from '../lib/access';
import {
  preflightPlayground, runPlayground,
  type PlaygroundCacheMode, type PlaygroundMessage, type PlaygroundModel, type PlaygroundModelsResponse,
  type PlaygroundPreflight, type PlaygroundResult, type PlaygroundStrategy,
} from '../lib/playground';
import { PlaygroundResponse, type PlaygroundAssistant } from './playground/PlaygroundResponse';
import { PlaygroundModelPicker } from './playground/PlaygroundModelPicker';
import { PlaygroundInspector } from './playground/PlaygroundInspector';
import s from './playground/playground.module.css';

interface UserMessage extends PlaygroundMessage { id: string }
interface ChatTurn { id: string; user: UserMessage; responses: PlaygroundAssistant[] }
type PlaygroundMode = 'single' | 'compare';
type CompareTarget = 'models' | 'strategies';
interface RunTarget { model: PlaygroundModel; strategy: PlaygroundStrategy; label: string; key: string }

const AUTO_MODEL = 'alayra-nexus-1';
const MAX_COMPARISON_MODELS = 4;
const STRATEGIES: PlaygroundStrategy[] = ['fastest', 'balanced', 'cheapest'];
const EMPTY_MODELS: PlaygroundModel[] = [];
const text = (message: PlaygroundMessage): string => message.content.map((part) => part.text).join('\n');
const makeUserMessage = (value: string): UserMessage => ({
  id: crypto.randomUUID(), role: 'user', content: [{ type: 'text', text: value }],
});
const title = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
const money = (value: number | null) => value == null ? 'Unpriced' : value > 0 && value < 0.0001 ? '<$0.0001' : '$' + value.toFixed(4);

export function Playground() {
  const { data, loading, error: modelsError, reload } = useApi<PlaygroundModelsResponse>('/admin/playground/models');
  const [mode, setMode] = useState<PlaygroundMode>('single');
  const [compareTarget, setCompareTarget] = useState<CompareTarget>('models');
  const [model, setModel] = useState(AUTO_MODEL);
  const [comparisonModels, setComparisonModels] = useState<string[]>([]);
  const [strategy, setStrategy] = useState<PlaygroundStrategy>('balanced');
  const [cacheMode, setCacheMode] = useState<PlaygroundCacheMode>('fresh');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [temperature, setTemperature] = useState(0.7);
  const [maxTokens, setMaxTokens] = useState(2048);
  const [systemPrompt, setSystemPrompt] = useState('');
  const [systemOpen, setSystemOpen] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [running, setRunning] = useState(false);
  const [preflight, setPreflight] = useState<PlaygroundPreflight | null>(null);
  const controllers = useRef(new Map<string, AbortController>());
  const conversation = useRef<HTMLDivElement | null>(null);
  const writable = canWrite();

  useEffect(() => () => controllers.current.forEach((abort) => abort.abort()), []);

  const models = data?.models ?? EMPTY_MODELS;
  const autoModel = models.find((item) => item.auto);
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
  const activeTargets = useMemo<RunTarget[]>(() => {
    if (mode === 'single') return selected ? [{ model: selected, strategy, label: selected.auto ? 'Nexus Auto' : selected.displayName, key: selected.id }] : [];
    if (compareTarget === 'strategies') return autoModel
      ? STRATEGIES.map((item) => ({ model: autoModel, strategy: item, label: title(item), key: `strategy-${item}` })) : [];
    return comparisonSelected.map((item) => ({ model: item, strategy, label: item.auto ? 'Nexus Auto' : item.displayName, key: item.id }));
  }, [autoModel, compareTarget, comparisonSelected, mode, selected, strategy]);
  const maxTokenLimit = useMemo(() => {
    const limits = activeTargets.map((item) => item.model.maxTokens).filter((limit) => limit > 0);
    return limits.length > 0 ? Math.min(...limits) : 131_072;
  }, [activeTargets]);
  useEffect(() => setMaxTokens((current) => Math.min(current, maxTokenLimit)), [maxTokenLimit]);

  const estimateModel = mode === 'single' ? selected : compareTarget === 'strategies' ? autoModel : undefined;
  useEffect(() => {
    const value = prompt.trim();
    if (!estimateModel || !value) { setPreflight(null); return; }
    const abort = new AbortController();
    const timer = window.setTimeout(() => {
      const messages: PlaygroundMessage[] = [
        ...(systemPrompt.trim() ? [{ role: 'system' as const, content: [{ type: 'text' as const, text: systemPrompt.trim() }] }] : []),
        { role: 'user', content: [{ type: 'text', text: value }] },
      ];
      void preflightPlayground({ model: estimateModel.id, messages, maxTokens }, abort.signal)
        .then(setPreflight).catch(() => setPreflight(null));
    }, 300);
    return () => { window.clearTimeout(timer); abort.abort(); };
  }, [estimateModel, maxTokens, prompt, systemPrompt]);

  const updateAssistant = (turnId: string, responseId: string, change: (message: PlaygroundAssistant) => PlaygroundAssistant) => {
    setTurns((current) => current.map((turn) => turn.id === turnId
      ? { ...turn, responses: turn.responses.map((response) => response.id === responseId ? change(response) : response) }
      : turn));
  };

  const execute = async (history: ChatTurn[], user: UserMessage, targets: RunTarget[] = activeTargets) => {
    const turnId = crypto.randomUUID();
    const responses: PlaygroundAssistant[] = targets.map((target) => ({
      id: crypto.randomUUID(), role: 'assistant', content: [{ type: 'text', text: '' }],
      requestedModel: target.model.id, requestedStrategy: target.strategy,
      requestedLabel: target.label, provider: target.model.provider, status: 'streaming',
    }));
    setTurns([...history, { id: turnId, user, responses }]);
    setRunning(true);

    await Promise.all(responses.map(async (response, index) => {
      const target = targets[index];
      const abort = new AbortController();
      controllers.current.set(response.id, abort);
      const branchHistory: PlaygroundMessage[] = history.flatMap((turn) => {
        const prior = turn.responses.find((item) => item.requestedModel === target.model.id && item.requestedStrategy === target.strategy);
        return prior && text(prior).trim()
          ? [{ role: 'user' as const, content: turn.user.content }, { role: 'assistant' as const, content: prior.content }]
          : [{ role: 'user' as const, content: turn.user.content }];
      });
      const requestMessages: PlaygroundMessage[] = [
        ...(systemPrompt.trim() ? [{ role: 'system' as const, content: [{ type: 'text' as const, text: systemPrompt.trim() }] }] : []),
        ...branchHistory, { role: 'user', content: user.content },
      ];
      try {
        await runPlayground({ model: target.model.id, messages: requestMessages, temperature, maxTokens, strategy: target.strategy, cacheMode }, {
          onDelta: (delta) => updateAssistant(turnId, response.id, (message) => ({ ...message, content: [{ type: 'text', text: text(message) + delta }] })),
          onResult: (result: PlaygroundResult) => updateAssistant(turnId, response.id, (message) => ({
            ...message, status: 'complete', diagnostics: result.trace,
            resolvedModel: result.trace.route?.modelString ?? result.response.headers['x-nexus-model'] ?? target.model.displayName,
          })),
        }, abort.signal);
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === 'AbortError') updateAssistant(turnId, response.id, (message) => ({ ...message, status: 'stopped' }));
        else updateAssistant(turnId, response.id, (current) => ({ ...current, status: 'error', error: cause instanceof Error ? cause.message : 'The Playground request failed.' }));
      } finally { controllers.current.delete(response.id); }
    }));
    setRunning(false);
  };

  const comparisonReady = compareTarget === 'strategies' ? Boolean(autoModel) : comparisonModels.length >= 2;
  const send = () => {
    const value = prompt.trim();
    if (!value || running || !writable || activeTargets.length < (mode === 'compare' ? 2 : 1)) return;
    setPrompt(''); void execute(turns, makeUserMessage(value));
  };
  const regenerate = () => {
    if (running) return;
    const last = turns.at(-1); if (!last) return;
    const targets = last.responses.flatMap((response) => {
      const targetModel = models.find((item) => item.id === response.requestedModel);
      return targetModel ? [{ model: targetModel, strategy: response.requestedStrategy, label: response.requestedLabel, key: response.id }] : [];
    });
    void execute(turns.slice(0, -1), last.user, targets);
  };
  const stop = () => controllers.current.forEach((abort) => abort.abort());
  const clear = () => { stop(); setTurns([]); setPrompt(''); };
  const selectionLocked = running || turns.length > 0;
  const toggleComparisonModel = (id: string) => {
    if (selectionLocked) return;
    setComparisonModels((current) => current.includes(id) ? current.filter((item) => item !== id)
      : current.length < MAX_COMPARISON_MODELS ? [...current, id] : current);
  };
  const changeMode = (next: PlaygroundMode) => { if (!selectionLocked) setMode(next); };
  const latestTrace = mode === 'single' ? turns.at(-1)?.responses[0]?.diagnostics : undefined;

  return (
    <div class={s.page}>
      <PageHeader title="Playground" subtitle="Test models and Nexus routing strategies through the same gateway path your apps use."
        actions={<Button size="sm" onClick={clear} disabled={turns.length === 0 && !prompt}><Eraser size={15} /> Clear chat</Button>} />

      <div class={mode === 'single' ? s.studioSingle : s.studioCompare}>
        <aside class={s.configuration} aria-label="Request configuration">
          <header><SlidersHorizontal size={15} /><span>Configuration</span></header>
          <div class={s.configurationBody}>
            <div><span class={s.controlLabel}>Run mode</span><div class={s.modeControl} role="group" aria-label="Playground mode">
              <Button size="sm" variant={mode === 'single' ? 'primary' : 'ghost'} aria-pressed={mode === 'single'} disabled={selectionLocked} onClick={() => changeMode('single')}><MessageSquare size={14} /> Single</Button>
              <Button size="sm" variant={mode === 'compare' ? 'primary' : 'ghost'} aria-pressed={mode === 'compare'} disabled={selectionLocked} onClick={() => changeMode('compare')}><Columns3 size={14} /> Compare</Button>
            </div></div>

            {mode === 'compare' && <Field label="Compare"><Select value={compareTarget} disabled={selectionLocked} onChange={(event) => setCompareTarget(event.currentTarget.value as CompareTarget)}>
              <option value="models">Models</option><option value="strategies">Routing strategies</option>
            </Select></Field>}

            {mode === 'single' ? <Field label="Model"><Select value={model} disabled={loading || models.length === 0 || selectionLocked} onChange={(event) => setModel(event.currentTarget.value)}>
              {models.map((item) => <option key={item.id} value={item.id}>{item.auto ? 'Auto - Nexus routing' : item.displayName + ' - ' + item.provider}</option>)}
            </Select></Field> : compareTarget === 'models' ? (
              <PlaygroundModelPicker models={models} selectedIds={comparisonModels} disabled={loading || models.length === 0 || selectionLocked} max={MAX_COMPARISON_MODELS} onToggle={toggleComparisonModel} />
            ) : <div class={s.strategyNotice}><GitCompareArrows size={15} /><span><strong>3 strategy lanes</strong><small>Fastest, balanced, and cheapest will run through Nexus Auto.</small></span></div>}

            <Field label="Temperature"><div class={s.rangeRow}><input class={s.range} type="range" min="0" max="2" step="0.1" value={temperature} disabled={running} onInput={(event) => setTemperature(Number(event.currentTarget.value))} /><output class={s.number}>{temperature.toFixed(1)}</output></div></Field>
            <Field label="Max tokens"><Input type="number" min="1" max={maxTokenLimit} value={maxTokens} disabled={running} onInput={(event) => setMaxTokens(Math.max(1, Number(event.currentTarget.value) || 1))} /></Field>

            <details class={s.advanced} open={advancedOpen} onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}>
              <summary><span><Gauge size={14} /> Advanced gateway</span><ChevronDown size={14} /></summary>
              <div class={s.advancedBody}>
                <Field label="Routing strategy"><Select value={strategy} disabled={selectionLocked || (mode === 'single' && !selected?.auto) || (mode === 'compare' && compareTarget === 'strategies')} onChange={(event) => setStrategy(event.currentTarget.value as PlaygroundStrategy)}>
                  <option value="fastest">Fastest eligible</option><option value="balanced">Balanced</option><option value="cheapest">Cheapest eligible</option>
                </Select></Field>
                <p>{mode === 'single' && !selected?.auto ? 'Pinned models use direct routing.' : strategy === 'fastest' ? 'Uses provider priority and first eligible capacity; not predictive latency.' : strategy === 'balanced' ? 'Balances provider priority with configured model cost.' : 'Maximizes cost weight after health and capability checks.'}</p>
                <Field label="Response cache"><Select value={cacheMode} disabled={running} onChange={(event) => setCacheMode(event.currentTarget.value as PlaygroundCacheMode)}><option value="fresh">Fresh response</option><option value="use">Allow cache reuse</option></Select></Field>
              </div>
            </details>

            <Button size="sm" variant={systemOpen ? 'secondary' : 'ghost'} class={s.systemButton} onClick={() => setSystemOpen((open) => !open)}><SlidersHorizontal size={14} /> System prompt</Button>
            {systemOpen && <label class={s.systemPrompt}><span>System prompt</span><textarea value={systemPrompt} disabled={running} rows={4} placeholder="Give the model instructions for this conversation." onInput={(event) => setSystemPrompt(event.currentTarget.value)} /></label>}
            {mode === 'compare' && !comparisonReady && <span class={s.selectionHint}>Select at least two models.</span>}
          </div>
          <footer><ShieldCheck size={13} /> Guardrails and gateway policies apply</footer>
        </aside>

        <div class={s.stage}>
          {preflight && <section class={s.preflight} aria-label="Request estimate">
            <div><Activity size={14} /><span>Input estimate</span><strong>{preflight.inputTokens.toLocaleString()} tokens</strong></div>
            <div><WalletCards size={14} /><span>Maximum cost</span><strong>{preflight.estimate.kind === 'range' ? money(preflight.estimate.minimumUsd) + '–' + money(preflight.estimate.maximumUsd) : money(preflight.estimate.maximumUsd)}</strong></div>
            <div><ShieldCheck size={14} /><span>Healthy keys</span><strong>{preflight.capacity.healthyKeys} / {preflight.capacity.totalKeys}</strong></div>
            <div><Database size={14} /><span>Configured capacity</span><strong>{preflight.capacity.configuredRpm.toLocaleString()} RPM · {preflight.capacity.configuredTpm.toLocaleString()} TPM</strong></div>
          </section>}
          <section class={s.workspace}>
            {loading && <div class={s.state}><Spinner /> <span>Loading available models...</span></div>}
            {modelsError && <div class={s.state} role="alert"><span>Couldn't load models - {modelsError}</span><Button size="sm" onClick={reload}>Retry</Button></div>}
            {!loading && !modelsError && models.length === 0 && <div class={s.empty}><Sparkles size={24} /><strong>No chat models are ready</strong><p>Add an active provider key and chat model in Nexus, then return here to test it.</p></div>}
            {!loading && !modelsError && models.length > 0 && turns.length === 0 && <div class={s.empty}><Sparkles size={24} /><strong>{mode === 'compare' ? compareTarget === 'strategies' ? 'Compare routing strategies' : 'Compare models side by side' : 'Test your gateway'}</strong><p>{mode === 'compare' ? compareTarget === 'strategies' ? 'Send one prompt through fastest, balanced, and cheapest routing at the same time.' : 'Select two to four models, then send one shared prompt.' : 'Choose a model or leave Nexus routing on Auto, then send your first prompt.'}</p></div>}
            {turns.length > 0 && <div class={s.conversation} ref={conversation} aria-live="polite">{turns.map((turn) => {
              const comparing = turn.responses.length > 1;
              return <div class={s.turn} key={turn.id}>
                {comparing && <div class={s.comparisonTurnHead}><span><Columns3 size={13} /> Shared request</span><small>{turn.responses.length} active lanes</small></div>}
                <article class={comparing ? s.sharedPrompt : s.userMessage}><div class={s.avatar} aria-hidden="true">Y</div><div class={s.messageMain}><div class={s.messageHead}><strong>You</strong>{comparing && <span>shared prompt</span>}</div><div class={s.messageText}>{text(turn.user)}</div></div></article>
                {comparing ? <div class={s.comparisonGrid} data-lanes={turn.responses.length} data-testid="comparison-grid">{turn.responses.map((response) => <PlaygroundResponse key={response.id} response={response} comparison />)}</div> : turn.responses[0] ? <PlaygroundResponse response={turn.responses[0]} /> : null}
              </div>;
            })}{!running && turns.length > 0 && <div class={s.regenerate}><Button size="sm" onClick={regenerate}><RotateCcw size={14} /> Regenerate</Button></div>}</div>}
          </section>

          <section class={s.composer}><textarea value={prompt} rows={2} disabled={running || models.length === 0 || !writable || (mode === 'compare' && !comparisonReady)} placeholder={!writable ? 'Viewer access cannot run provider requests.' : mode === 'compare' && !comparisonReady ? 'Select at least two models to compare.' : mode === 'compare' ? 'Ask all ' + activeTargets.length + ' lanes the same question...' : 'Write a message...'} aria-label="Message" onInput={(event) => setPrompt(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); send(); } }} />
            <div class={s.composerActions}>{running ? <Button variant="danger" onClick={stop}><Square size={13} fill="currentColor" /> Stop all</Button> : <Button variant="primary" onClick={send} disabled={!prompt.trim() || models.length === 0 || !writable || (mode === 'compare' && !comparisonReady)}><Send size={15} /> {mode === 'compare' ? 'Run ' + activeTargets.length + (compareTarget === 'models' ? ' models' : ' strategies') : 'Send'}</Button>}</div>
          </section>
          <div class={s.privacy}><ShieldCheck size={14} /> Prompts pass through your gateway and are not stored.</div>
        </div>
        {mode === 'single' && <PlaygroundInspector trace={latestTrace} />}
      </div>
    </div>
  );
}
