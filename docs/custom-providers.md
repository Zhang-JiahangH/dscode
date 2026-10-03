# Custom model providers

Use `/provider custom`, or choose **Custom** in `/provider`, to connect a self-hosted or private model API. DSCODE runs its tools in the current workspace; pointing inference at another computer does not move shell commands or file edits to that computer.

Saved services appear by name in `/provider`. Choose a service and press Enter to switch to its current or first configured model; `/model` then selects among that service's models. **Custom · add / edit model services** opens configuration instead of switching. A service without a model context window opens its editor so the missing setting can be completed.

## Add a service

Choose **Add provider** and enter a name and API base URL. The URL is the API prefix, for example `http://studio:8000/v1`, not a complete chat endpoint. The editor displays the final request URL.

Choose one API format:

| Format | Path appended to the base URL | Default authentication |
| --- | --- | --- |
| Chat Completions | `/chat/completions` | Bearer token |
| Responses | `/responses` | Bearer token |
| Anthropic Messages | `/messages` | `x-api-key`, with the Anthropic version header |

Authentication can be changed independently to **none**, **bearer** or **x-api-key**. For example, oMLX uses Bearer authentication even when serving Anthropic Messages. No-auth requests omit the key entirely. API keys are masked while editing; leaving the field blank preserves an existing key.

Use Up/Down to navigate and Enter to edit or activate. For API format, authentication and thinking, Enter opens a choice editor; use the arrow keys to choose, Enter to apply, or Escape to cancel that choice while keeping the provider form open. In text fields, Ctrl+U clears the field and Escape cancels the edit. Terminal paste markers and line breaks are removed from pasted field values. Enter applies a field to the draft; **Save** persists the provider. Outside a field editor, Escape goes back. **Save and switch to this model** also selects the model for the next step, using the existing context-compaction check when needed. Escape cancels discovery and test requests. Saving configuration is allowed while the server is offline.

## Models and context

**Discover models** requests `/models`, relative to the API prefix. Select models with Enter or Space, then choose **Use selected models**. Existing models are kept; remove one from its model editor when needed. If discovery is unavailable, choose **Add model manually** and enter the server's exact model ID.

Each model has its own context window and output budget. The context window is required before the model appears in `/model` or can be tested. Discovery accepts positive `max_model_len`, `context_length` or `context_window` values; unknown values remain blank. It does not infer capacity from the model's name.

For a listing identified as oMLX, DSCODE also reads `/models/status`. Its `max_context_window` takes precedence over the model listing, and `max_tokens` prefills the output budget. These fields are **server-reported configuration**, not proof that a full-window request will fit in memory. The reported output setting is not treated as a hard architectural model limit.

The editor labels values as `server` or `user`. Editing a number makes it a user override; discovery refreshes server values while preserving those overrides. Changing the endpoint or model ID clears the previous deployment's reported limits and keeps explicit user overrides. A blank output budget defaults to the smaller of 4,096 tokens or one quarter of the context window. The existing compaction path reserves the output budget inside the context window.

Thinking defaults to the server's behavior. Identified oMLX models also offer Off/On in the editor and Off/On in `/effort` (the stored effort IDs are `off` and `high`). Other custom APIs do not receive guessed reasoning parameters. Native Responses reasoning items and Anthropic thinking signatures are retained for replay to the same service, model and protocol.

## Test and runtime behavior

The model editor's **Test text, streaming and tools** makes three short streamed requests: a fixed text answer, a synthetic tool call, and an answer after a fixed tool result. It never executes a real shell command or other tool. Results distinguish text/streaming, streamed arguments and the tool-result round trip. Tests are local to the current editor and cleared on configuration changes; they do not certify thinking behavior, image input, model quality or long-context operation. oMLX probes turn thinking off.

The default stream idle timeout is 180 seconds to allow cold model loading. Discovery has a separate ten-second timeout. Each service permits one in-flight inference request per DSCODE Host; queued title and compaction calls yield to queued foreground calls. This is not a machine-wide limit across separate DSCODE processes. Cancellation releases the queue slot and aborts the HTTP request.

This version supports text and structured tool calls. Images are not advertised as supported. The local session history is authoritative for all three protocols; Responses requests use stateless replay rather than relying on a remote response ID. Interrupted streams are errors, and invalid tool arguments are rejected before executing the tool. Requests do not redirect or fall back to another model service.

Automatic review follows its configured model route. When that route is Custom, it skips the cloud Jev shortcut. The default web-search router does not fall back to a cloud search service for Custom sessions; configure a separate web search provider explicitly if needed. This does not disable other configured MCPs, browser tools or external integrations.

## Persistence

Service and model configuration lives in `~/.dscode/providers.yaml`; keys use the existing owner-only `~/.dscode/credentials.yaml` store. Provider records contain no key values. Each service receives a stable `custom-…` ID and a derived `DSCODE_CUSTOM_CUSTOM_…_API_KEY` credential reference. An environment variable with that exact reference takes precedence over the saved key, following the existing credential-store rules.

Configuration is shared across projects and installed versions, written atomically, and reloaded by other running Hosts. Stale editors cannot overwrite newer configuration. Renaming a service preserves its ID, so persisted sessions continue to resolve it. Removing a provider removes its route and writable stored credential; it does not reroute existing sessions or delete their history. An environment-supplied key remains in the environment. If it masks a stored key, clear the environment override before removing the provider to remove that stored key too.

## Development verification

The fixture suites exercise all three stream formats, tool-result replay, credential storage, context budgeting, cancellation, native Harness registration, session route restoration and terminal input. An explicit live probe can use an environment key without saving a provider:

```bash
DSCODE_CUSTOM_BASE_URL=http://studio:8000/v1 \
DSCODE_CUSTOM_MODEL=your-model-id \
DSCODE_CUSTOM_KEY_ENV=OMLX_API_KEY \
node --env-file=.env scripts/verify-custom-provider.mjs
```

That probe tests all three protocols. It requires the endpoint to serve all three; a failed protocol stays failed in its output.
