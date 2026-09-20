import { describe, expect, it } from 'vitest';
import { createOpenAIStreamParser } from './playground';

describe('OpenAI stream parsing for the Playground', () => {
  it('reassembles SSE lines split across arbitrary network chunks', () => {
    const output: string[] = [];
    const parser = createOpenAIStreamParser((delta) => output.push(delta));

    parser.push('data: {"choices":[{"delta":{"cont');
    parser.push('ent":"Hel"}}]}\n\ndata: {"choices":[{"delta":{"content":"lo"}}]}\n');
    parser.push('\ndata: [DONE]\n\n');
    parser.end();

    expect(output.join('')).toBe('Hello');
  });

  it('surfaces an error frame instead of presenting a partial answer as complete', () => {
    const parser = createOpenAIStreamParser(() => undefined);
    expect(() => parser.push('data: {"error":{"message":"Provider stopped"}}\n\n'))
      .toThrow('Provider stopped');
  });

  it('accepts content-part deltas from providers that use an array', () => {
    const output: string[] = [];
    const parser = createOpenAIStreamParser((delta) => output.push(delta));
    parser.push('data: {"choices":[{"delta":{"content":[{"type":"text","text":"Hi"}]}}]}\n\n');
    parser.end();
    expect(output).toEqual(['Hi']);
  });
});
