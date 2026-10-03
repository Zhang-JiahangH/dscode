import { LlmError, EMPTY_RESPONSE_CODE } from '@deepseek-ai/dsh-llm';
import { errorCode, errorMessage } from './http-errors.mjs';

/**
 * SSE `data:` payloads from a response body, skipping `:` keep-alive comments.
 * @param onActivity - called for every received chunk, comments included.
 */
export async function* sseData(body, onActivity) {
  const decoder = new TextDecoder();
  let buffer = '', data = [];
  const lines = function* (final) {
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0 || final && buffer.length > 0) {
      let line = newline >= 0 ? buffer.slice(0, newline) : buffer;
      buffer = newline >= 0 ? buffer.slice(newline + 1) : '';
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line === '') {
        // A bare `data:` line assembles to whitespace; the SSE spec reads it as a newline, but every consumer here parses JSON.
        const payload = data.join('\n');
        if (payload.trim() !== '') yield payload;
        data = [];
      } else if (line.startsWith('data:')) data.push(line.slice(line.startsWith('data: ') ? 6 : 5));
    }
  };
  for await (const chunk of body) {
    onActivity?.();
    buffer += decoder.decode(chunk, { stream: true });
    yield* lines(false);
  }
  buffer += decoder.decode();
  yield* lines(true);
  const tail = data.join('\n');
  if (tail.trim() !== '') yield tail;
}

/** Map OpenRouter usage to disjoint harness counts (`prompt_tokens` includes cache reads and writes). */
export function mapUsage(usage) {
  const valid = value => Number.isSafeInteger(value) && value >= 0;
  const prompt = usage?.prompt_tokens, completion = usage?.completion_tokens;
  if (!valid(prompt) || !valid(completion)) return undefined;
  const read = valid(usage.prompt_tokens_details?.cached_tokens) ? usage.prompt_tokens_details.cached_tokens : 0;
  const write = valid(usage.prompt_tokens_details?.cache_write_tokens) ? usage.prompt_tokens_details.cache_write_tokens : 0;
  const reasoning = usage.completion_tokens_details?.reasoning_tokens;
  return {
    inputTokens: Math.max(0, prompt - read - write),
    outputTokens: completion,
    ...(usage.total_tokens === undefined || usage.total_tokens === prompt + completion ? { totalTokens: prompt + completion } : {}),
    ...(read > 0 ? { cacheReadTokens: read } : {}),
    ...(write > 0 ? { cacheWriteTokens: write } : {}),
    ...(valid(reasoning) && reasoning > 0 ? { reasoningTokens: reasoning } : {}),
  };
}

/** Streamed reasoning details merged into the blocks a replay sends back unmodified. */
function mergeDetails(items) {
  const merged = [];
  for (const item of items) {
    if (item === null || typeof item !== 'object') continue;
    const last = merged.at(-1);
    if (last && last.type === item.type && item.type !== 'reasoning.encrypted' && (last.index ?? 0) === (item.index ?? 0)) {
      if (typeof item.text === 'string') last.text = (last.text ?? '') + item.text;
      if (typeof item.summary === 'string') last.summary = (last.summary ?? '') + item.summary;
      for (const key of ['id', 'format', 'signature']) if (item[key] !== undefined && item[key] !== null && item[key] !== '') last[key] = item[key];
    } else merged.push({ ...item });
  }
  return merged;
}

function closeBlock(block) {
  if (block.kind === 'tool-call') return { type: 'tool-call', id: block.callId ?? '', name: block.name ?? '', arguments: block.text };
  return { type: block.kind, text: block.text };
}

function finishReason(reason, blocks, label) {
  if (reason === 'length') return { kind: 'max-tokens' };
  if (reason === 'content_filter') return { kind: 'error', failure: { message: `${label} stopped the response for content filtering`, code: 'CONTENT_FILTER' } };
  if (reason === 'tool_calls' || blocks.some(block => block.kind === 'tool-call') && (reason === undefined || reason === 'stop')) return { kind: 'tool-calls' };
  if (reason === undefined || reason === null || reason === 'stop' || reason === 'end') {
    return blocks.length === 0 ? { kind: 'error', failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE } } : { kind: 'stop' };
  }
  return { kind: 'error', failure: { message: `model stopped: ${reason}`, code: String(reason).toUpperCase() } };
}

/**
 * Translate SSE payloads into harness chunks. Block ends, usage and the finish are
 * held until `[DONE]`; the finish of a successful response carries the replay state:
 * reasoning details per block, the generation id, the serving provider and the billed cost.
 * An error inside the stream throws with its routed code.
 * @param kind - the replay kind stamped on the response; `label` names the route in errors.
 */
export async function* translate(payloads, { model, kind = 'dscode-openrouter', label = 'OpenRouter' }) {
  let nextIndex = 0, textBlock, reasoningBlock, finish, usage, cost, id, provider;
  const tools = new Map();
  const order = [];
  const open = kind => {
    const block = { index: nextIndex++, kind, text: '', details: [] };
    order.push(block);
    return block;
  };
  for await (const payload of payloads) {
    if (payload === '[DONE]') {
      for (const block of order) yield { type: 'block-end', index: block.index, block: closeBlock(block) };
      if (usage) yield { type: 'usage', usage };
      const reason = finishReason(finish, order, label);
      const succeeded = reason.kind === 'stop' || reason.kind === 'tool-calls' || reason.kind === 'max-tokens';
      yield {
        type: 'finish', reason,
        ...(succeeded ? { replayState: {
          response: { kind, version: 1, model, ...(id ? { id } : {}), ...(provider ? { provider } : {}), ...(cost !== undefined ? { cost } : {}) },
          blocks: order.map(block => block.kind === 'reasoning' && block.details.length > 0 ? { type: 'reasoning', reasoningDetails: mergeDetails(block.details) } : { type: block.kind }),
        } } : {}),
      };
      return;
    }
    let chunk;
    try {
      chunk = JSON.parse(payload);
    } catch {
      throw new LlmError(`malformed ${label} stream payload: ${payload.slice(0, 120)}`, 'MALFORMED_RESPONSE');
    }
    if (chunk?.error) {
      const status = Number.isInteger(chunk.error.code) ? chunk.error.code : undefined;
      throw new LlmError(errorMessage(chunk.error, `${label} stream error`), errorCode(undefined, chunk.error), status === undefined ? {} : { status });
    }
    if (typeof chunk?.id === 'string') id ??= chunk.id;
    if (typeof chunk?.provider === 'string') provider ??= chunk.provider;
    for (const choice of chunk?.choices ?? []) {
      const delta = choice.delta ?? {};
      const details = Array.isArray(delta.reasoning_details) ? delta.reasoning_details : [];
      let reasoning = typeof delta.reasoning === 'string' ? delta.reasoning : typeof delta.reasoning_content === 'string' ? delta.reasoning_content : '';
      if (reasoning.length === 0) reasoning = details.map(detail => detail?.type === 'reasoning.text' ? detail.text : detail?.type === 'reasoning.summary' ? detail.summary : '').filter(text => typeof text === 'string').join('');
      if (reasoning.length > 0 || details.length > 0) {
        if (!reasoningBlock) {
          reasoningBlock = open('reasoning');
          yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' };
        }
        reasoningBlock.details.push(...details);
        if (reasoning.length > 0) {
          reasoningBlock.text += reasoning;
          yield { type: 'reasoning-delta', index: reasoningBlock.index, text: reasoning };
        }
      }
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        if (!textBlock) {
          textBlock = open('text');
          yield { type: 'block-start', index: textBlock.index, blockType: 'text' };
        }
        textBlock.text += delta.content;
        yield { type: 'text-delta', index: textBlock.index, text: delta.content };
      }
      for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
        const key = call.index ?? call.id;
        let block = tools.get(key);
        if (!block) {
          block = open('tool-call');
          tools.set(key, block);
          yield { type: 'block-start', index: block.index, blockType: 'tool-call' };
        }
        // id and name arrive once; an empty or null repeat is no update.
        if (typeof call.id === 'string' && call.id.length > 0) block.callId = call.id;
        if (typeof call.function?.name === 'string' && call.function.name.length > 0) block.name = call.function.name;
        const fragment = typeof call.function?.arguments === 'string' ? call.function.arguments : '';
        block.text += fragment;
        yield { type: 'tool-call-delta', index: block.index, id: block.callId ?? '', ...(block.name !== undefined ? { name: block.name } : {}), argumentsDelta: fragment };
      }
      if (typeof choice.finish_reason === 'string') finish = choice.finish_reason;
    }
    if (chunk?.usage) {
      usage = mapUsage(chunk.usage) ?? usage;
      if (Number.isFinite(chunk.usage.cost) && chunk.usage.cost >= 0) cost = chunk.usage.cost;
    }
  }
  throw new LlmError(`${label} stream ended without [DONE]`, 'TRANSPORT');
}
