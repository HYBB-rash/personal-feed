# Personal Feed

Personal Feed is a standalone, single-user MCP service. It observes an already-open, already-authenticated X page, applies private preference and feedback state, and exposes a small channel-neutral tool API. Telegram, Web, or any other interface may reach it only through an MCP-capable Agent.

```text
Telegram / Web -> Agent -> generic MCP client -> 127.0.0.1 Personal Feed service
```

The repository is the source of truth. It is MIT-licensed, intentionally `private: true` in npm metadata, and is not published as an npm package.

## Runtime boundary

- The service binds only to `127.0.0.1:43180` in v1.
- `POST /mcp` is stateless Streamable HTTP MCP and requires `Authorization: Bearer ...`.
- `GET /healthz` proves only that the process is alive.
- `GET /readyz` checks loaded configuration, the writable state directory, and readable Python observer assets. It does not contact X or the model endpoint.
- The existing X browser must expose CDP at `127.0.0.1:9222`. Personal Feed never starts a browser, signs into an account, or exposes CDP.
- State defaults to `${XDG_STATE_HOME:-$HOME/.local/state}/personal-feed`.
- MCP authorization and the OpenAI-compatible model use separate secrets. Secrets never belong in Git, URLs, or logs.

The five raw tool names are `request`, `observe_context`, `process_feedback`, `record_feedback`, and `list_saved`. A client configured with `serverName: personal_feed` exposes them to an Agent as `mcp__personal_feed__<raw-name>`.

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

Review the exact plan from a clean commit:

```sh
nix run . -- service install --check
```

Only after separately authorizing a local user-service installation:

```sh
nix run . -- service install --apply
```

`--apply` builds the exact clean Git commit through Nix, installs one user systemd unit plus private configuration, creates the independent state directory, and starts that service. It prints a backup directory and an explicit rollback command. It does not configure or restart DSH.

## Optional DSH integration

After the Personal Feed service is running, export its MCP endpoint and the same MCP token:

```sh
export PERSONAL_FEED_MCP_URL='http://127.0.0.1:43180/mcp'
export PERSONAL_FEED_MCP_TOKEN='<high-entropy-service-token>'
export DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
```

Review without changing DSH:

```sh
nix run . -- dsh install --check
```

Apply only after separately authorizing the machine-local integration:

```sh
nix run . -- dsh install --apply
```

The DSH installer first requires `readyz.status=ready` and exactly the five known MCP tools. It then atomically installs this repository's instruction-only Skill, one installer-owned generic `@deepseek-ai/dsh-mcp-client` row, and URL/token variables in a mode-`0600` `.env`. It fixes `serverName: personal_feed`, `failOnStartupError: false`, and a 120-second tool timeout. It refuses to overwrite user-owned rows or Skills and never restarts, releases, or switches DSH.

Both installers are idempotent. Every applied change has a private backup and a printed command of the form:

```sh
nix run . -- service rollback --apply '<backup-directory>'
nix run . -- dsh rollback --apply '<backup-directory>'
```

Service rollback removes the installed unit and configuration but preserves the independent state directory. Data created during a trial remains available for a separate migration or deletion decision.

Review the backup path before rollback. DSH restart, production cutover, real Web/Telegram validation, acceptance, publishing, merging, and pushing are deliberately separate operator decisions.

## Logs and data

Service logs contain only an operation name, a server-generated anonymous request ID, a result category, and duration. They do not contain user messages, X text, full URLs, continuation tokens, or credentials. JSONL writes are synced before success is returned; snapshots use same-directory temporary files and atomic replacement.
