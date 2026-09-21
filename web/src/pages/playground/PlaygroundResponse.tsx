import { CircleAlert, CircleCheck, LoaderCircle } from 'lucide-preact';
import type { PlaygroundMessage, PlaygroundTrace } from '../../lib/playground';
import { PlaygroundDiagnostics } from './PlaygroundDiagnostics';
import s from './playground.module.css';

export interface PlaygroundAssistant extends PlaygroundMessage {
  id: string;
  requestedModel: string;
  requestedLabel: string;
  provider: string;
  status: 'streaming' | 'complete' | 'error' | 'stopped';
  resolvedModel?: string;
  error?: string;
  diagnostics?: PlaygroundTrace;
}

interface Props {
  response: PlaygroundAssistant;
  comparison?: boolean;
}

const messageText = (message: PlaygroundMessage): string =>
  message.content.map((part) => part.text).join('\n');

export function PlaygroundResponse({ response, comparison = false }: Props) {
  const body = messageText(response);
  const stateLabel = response.status === 'complete' ? 'Complete'
    : response.status === 'error' ? 'Failed'
      : response.status === 'stopped' ? 'Stopped'
        : 'Streaming';

  return (
    <article class={comparison ? s.comparisonResponse : s.assistantMessage}>
      {!comparison && <div class={s.avatar} aria-hidden="true">N</div>}
      <div class={s.messageMain}>
        <div class={s.messageHead}>
          <strong>{comparison ? response.requestedLabel : 'Nexus'}</strong>
          <span>{response.resolvedModel
            ? `${response.resolvedModel} - routed`
            : `${response.provider} - ${response.requestedModel}`}</span>
          {comparison && (
            <span class={response.status === 'error' ? s.statusError : s.responseStatus}>
              {response.status === 'streaming' && <LoaderCircle size={12} class={s.spin} />}
              {response.status === 'complete' && <CircleCheck size={12} />}
              {response.status === 'error' && <CircleAlert size={12} />}
              {stateLabel}
            </span>
          )}
        </div>
        {body && <div class={s.messageText}>{body}</div>}
        {response.status === 'streaming' && (
          <span class={s.cursor} aria-label={`Streaming response from ${response.requestedLabel}`} />
        )}
        {response.error && <div class={s.messageError} role="alert">{response.error}</div>}
        {response.status === 'stopped' && !body && <div class={s.stopped}>Response stopped.</div>}
        {response.diagnostics && <PlaygroundDiagnostics trace={response.diagnostics} />}
      </div>

    </article>
  );
}
