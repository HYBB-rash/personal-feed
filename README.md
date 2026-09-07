# Personal Feed

Personal Feed is a standalone, single-user MCP service. It observes X through an already-authenticated browser, maintains private personal context, feedback records, and saved items, and exposes a small channel-neutral tool API. Telegram, Web, or any other interface may reach it only through an MCP-capable Agent.

```text
Telegram / Web -> Agent -> generic MCP client -> 127.0.0.1 Personal Feed service
```

The repository is the source of truth. It is MIT-licensed, intentionally `private: true` in npm metadata, and is not published as an npm package.

## Runtime boundary

- The service binds only to `127.0.0.1:43180` in v1.
- `POST /mcp` uses stateful Streamable HTTP MCP and requires `Authorization: Bearer ...`. Protocol connections exist only in memory; authenticated `DELETE /mcp` releases a connection.
- `GET /healthz` proves only that the process is alive.
- `GET /readyz` checks loaded configuration, the writable state directory, and readable Python observer assets. It does not contact X or the model endpoint.
- The existing X browser must expose CDP at `127.0.0.1:9222`. Personal Feed never starts a browser, signs into an account, or exposes CDP.
- If no usable X timeline tab exists, the observer opens one X home tab in that browser within its observation deadline. Later calls reuse an available timeline tab; existing post-detail tabs are left untouched. A failed page creation remains an incomplete observation.
- State defaults to `${XDG_STATE_HOME:-$HOME/.local/state}/personal-feed`.
- MCP authorization and the OpenAI-compatible model use separate secrets. Secrets never belong in Git, URLs, or logs.

The five raw tool names are `request`, `observe_context`, `process_feedback`, `record_feedback`, and `list_saved`. A client configured with `serverName: personal_feed` exposes them to an Agent as `mcp__personal_feed__<raw-name>`.

The V0 candidate removes the discovery profile gate and preserves trusted partial source material. Individual unreadable items or judgment failures no longer discard later usable recommendations. `one_link` can include `limitations`; show these alongside the original link. Historical processed records no longer permanently exclude candidates, so links may recur across calls. V0 does not yet explore unfamiliar directions: a finished interest pass without a recommendation reports that exploration is not ready, rather than claiming a normal empty discovery.

The exact input schemas, closed result categories, and error boundary are documented in [`docs/MCP.md`](docs/MCP.md).

## Development

```sh
nix develop
pnpm install --frozen-lockfile
pnpm check
nix flake check
```

The pinned shell provides Node.js, pnpm, Python, and `websocket-client`. Tests use fake browser/model adapters and temporary state. Do not point tests at a real account, model credential, DSH home, or user systemd instance.

## Service configuration

Set these variables in the shell only for `--check` or `--apply`; the installer writes the service copy to a mode-`0600` EnvironmentFile.

```sh
export PERSONAL_FEED_MCP_TOKEN='<high-entropy-service-token>'
export PERSONAL_FEED_MODEL_BASE_URL='https://model.example/v1'
export PERSONAL_FEED_MODEL='model-name'
export PERSONAL_FEED_MODEL_API_KEY='<separate-model-key>'
export PERSONAL_FEED_MODEL_TIMEOUT_MS='30000' # optional
```

Optional `PERSONAL_FEED_MODEL_RESPONSE_FORMAT=strict_tool` requires an endpoint supporting strict Function JSON Schema. The default `json_content` preserves the existing JSON-text interface. Strict mode accepts one fixed result function as data and retains all existing validation; it does not execute model tools, retry, fall back to free text, or change thinking settings. The installer preserves this explicit choice. DeepSeek currently requires its [Beta endpoint](https://api-docs.deepseek.com/guides/tool_calls/#strict-mode-beta), so explicitly configure `https://api.deepseek.com/beta` as the base URL. The service never rewrites provider addresses. Schema conformance does not establish semantic correctness.

Review the exact plan from a clean commit:

```sh
nix run . -- service install --check
```

Only after separately authorizing a local user-service installation:

```sh
nix run . -- service install --apply
```

`--apply` builds the exact clean Git commit through Nix, installs one user systemd unit plus private configuration, creates the independent state directory, and starts that service. It prints a backup directory and an explicit rollback command. It does not configure or restart DSH.

## Agent integration

After the service is running, configure the Agent's generic MCP client:

| Setting | Value |
|---|---|
| Transport | Streamable HTTP |
| MCP endpoint | `http://127.0.0.1:43180/mcp` |
| Request header | `Authorization: Bearer <service MCP token>` |
| Server name | `personal_feed` |
| Fixed mode header | `Personal-Feed-Mode: interactive` for user interaction; omitted or `background` for read-only Feed requests |
| Client tool timeout | 360 seconds (service default: 300 seconds, including answering time) |

Load this repository's [`skills/personal-feed`](skills/personal-feed/SKILL.md) through the Agent's own Skill installation mechanism. Users can then request Personal Feed in normal conversation. Configuration field names and credential storage depend on the client; its tool timeout should exceed the service's `PERSONAL_FEED_TOOL_TIMEOUT_MS`. Interactive clients that need clarification for voluntary updates or feedback must support MCP form elicitation and allow it in the task permission policy; ordinary discovery does not require it. The calling program sets the mode header; the model does not select it. Necessary answers return through the pending MCP call, without a second tool call or continuation token. Ordinary `request` uses the current stored facts, including an empty or uncertain context, and immediately observes candidates. It never runs a profile sufficiency interview, stores request text as facts, or waits for answers. Voluntary context updates remain separate `observe_context` calls.

Personal Feed installs only its own service. The former `dsh install` and `dsh rollback` commands have been removed; the host manages its MCP configuration and Skills. Existing integrations remain installed. To undo changes made by the old installer, use the version that produced the backup.

Service installation is idempotent and prints a backup path and rollback command when it makes changes:

```sh
nix run . -- service rollback --apply '<backup-directory>'
```

Service rollback restores the unit and configuration and preserves the independent state directory.

## Logs and data

Tool logs contain an operation name, a server-generated anonymous request ID, a result category, and duration. Model failures emit `model_failure` with fixed failure categories, optional fixed schema locations, and an HTTP status when relevant. Application validation emits `application_failure` for invalid changes, missing clarification, failed assessment, conflicts, or cancellation. Logs exclude user messages, model response text, X text, full URLs, continuation tokens, and credentials. Diagnostics neither change tool results nor trigger retries. JSONL writes are synced before success is returned; snapshots use same-directory temporary files and atomic replacement.
