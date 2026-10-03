// Explicit opt-in live probe. Reads credentials only from the launching environment.
// Example: DSCODE_CUSTOM_BASE_URL=http://host:8000/v1 DSCODE_CUSTOM_MODEL=model
// DSCODE_CUSTOM_KEY_ENV=OMLX_API_KEY node --env-file=.env scripts/verify-custom-provider.mjs
import { CustomProviders } from '../plugins/custom/index.mjs';
import { PROTOCOLS } from '../plugins/custom/config.mjs';

const baseURL = process.env.DSCODE_CUSTOM_BASE_URL;
const modelId = process.env.DSCODE_CUSTOM_MODEL;
const secret = process.env[process.env.DSCODE_CUSTOM_KEY_ENV ?? 'CUSTOM_API_KEY'];
if (!baseURL || !modelId) throw Error('Set DSCODE_CUSTOM_BASE_URL and DSCODE_CUSTOM_MODEL to opt into live probes');
const service = new CustomProviders({ credentials: { resolve: async () => ({ value: secret }) } });
const draft = { ...service.newProfile(), name: 'Live probe', baseURL, auth: secret ? 'bearer' : 'none' };
const listing = await service.discover(draft, undefined);
const model = listing.models.find(m => m.id === modelId);
if (!model) throw Error('Requested model was not discovered');
if (!model.contextWindow && process.env.DSCODE_CUSTOM_CONTEXT) model.contextWindow = Number(process.env.DSCODE_CUSTOM_CONTEXT);
console.log(JSON.stringify({ discovery: 'passed', backend: listing.backend, model }));
for (const api of PROTOCOLS) {
  const start = Date.now();
  const stages = await service.test({ ...draft, api, backend: listing.backend, models: [model] }, modelId, undefined, AbortSignal.timeout(180000));
  console.log(JSON.stringify({ api, elapsedMs: Date.now() - start, stages }).split(secret || '\u0000').join('[redacted]'));
  if (stages.some(s => s.status === 'failed')) process.exitCode = 1;
}
