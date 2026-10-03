import { CONTEXT_WINDOW_EXCEEDED_CODE, QUOTA_EXCEEDED_CODE, isContextWindowExceededError, isQuotaExceededError } from '@deepseek-ai/dsh-llm';

// OpenRouter's typed `metadata.error_type`, which it asks clients to route on before the status.
const ERROR_TYPES = Object.freeze({
  context_length_exceeded: CONTEXT_WINDOW_EXCEEDED_CODE, token_limit_exceeded: CONTEXT_WINDOW_EXCEEDED_CODE,
  payment_required: QUOTA_EXCEEDED_CODE, authentication: 'AUTH', permission_denied: 'AUTH',
  rate_limit_exceeded: 'RATE_LIMIT', provider_overloaded: 'SERVER', provider_unavailable: 'SERVER', server: 'SERVER', unmapped: 'SERVER',
  timeout: 'TIMEOUT', content_policy_violation: 'CONTENT_POLICY', refusal: 'CONTENT_POLICY',
});

/**
 * Harness failure code for an OpenRouter error.
 * @param status - HTTP status of a rejected request, or undefined for an error inside a 200 stream.
 * @param error - the `error` object (`code`, `message`, `metadata`).
 */
export function errorCode(status, error) {
  const type = error?.metadata?.error_type;
  if (typeof type === 'string' && Object.hasOwn(ERROR_TYPES, type)) return ERROR_TYPES[type];
  const code = Number.isInteger(status) ? status : Number(error?.code);
  // A 402 names token counts ("fewer max_tokens"); its status decides before any wording does.
  if (code === 402) return QUOTA_EXCEEDED_CODE;
  // OpenRouter can reject a replay before generation without typed metadata.
  // Keep this narrow: an ordinary permission-denied 403 still means AUTH.
  if (code === 403 && typeof error?.message === 'string' && /^Request blocked by content filter\b/i.test(error.message)) return 'CONTENT_POLICY';
  const detail = [error?.message, error?.metadata?.raw].filter(value => typeof value === 'string').join(' ');
  if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE;
  if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE;
  if (code === 401 || code === 403) return 'AUTH';
  if (code === 429) return 'RATE_LIMIT';
  if (code === 408 || code === 504) return 'TIMEOUT';
  if (code >= 500) return 'SERVER';
  if (code >= 400) return 'INVALID_REQUEST';
  // A stream that failed after its 200 without a numeric code is an upstream failure worth retrying.
  return 'SERVER';
}

/** Human-readable message for an OpenRouter error object. */
export function errorMessage(error, fallback) {
  const message = typeof error?.message === 'string' && error.message.length > 0 ? error.message : fallback;
  const provider = error?.metadata?.provider_name;
  return typeof provider === 'string' && provider.length > 0 ? `${message} (provider: ${provider})` : message;
}

/** Retry-After as milliseconds (seconds or an HTTP date), when valid. */
export function retryAfterMs(value) {
  if (value === null || value === undefined) return undefined;
  const delay = /^\d+$/.test(value) ? Number(value) * 1e3 : Date.parse(value) - Date.now();
  return Number.isFinite(delay) && delay > 0 ? delay : undefined;
}

