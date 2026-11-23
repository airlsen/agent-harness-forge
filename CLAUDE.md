# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.


# 在仓库根目录执行（你现在就在根目录）
npm --prefix frontend ci

npm ci 会先删掉 frontend/node_modules 再按 package-lock.json 完整重装，正好治这种「装残」的情况。

装完再 build：

npm --prefix frontend run build

每次改完代码，在回复末尾用一两句话说明改动内容，中文描述，方便直接拿去 commit。

## What this is

AgentHarness Forge — an enterprise agent platform built on the **DeepSeek Harness (`dsh`) plugin architecture**. It is a single-workspace / single-admin control plane (multi-tenant OIDC/RBAC is explicitly *not* implemented) that executes against a **real user-configured model** — there is no fake model or canned-script execution in the business path. All UI copy, comments, and docstrings are Chinese.

Three independently-run processes:

```text
browser :5173 ── Vue SPA + same-origin /api (FastAPI)
                    │ internal Bearer token (never in browser)
                    ▼
               Runner :9000  ── one dsh sdk-minimal child process per session
                    │
                    ▼
        forge-runtime plugin (model adapter / tools / gating)
                    │
                    ▼
        user-configured OpenAI-compatible model service
```

`dsh` is **pinned, not forked**: `@deepseek-ai/dsh@0.2.2-rc.5`.

## Layout

- `backend/` — FastAPI control plane (Python ≥3.12): auth, scenarios, sessions, approval, audit, model connection, governance, MCP registry.
- `runner/` — execution kernel (Node ≥24.9, TypeScript, Fastify): engine-agnostic session kernel + `dsh` adapter (`src/kernel/dsh/`) + platform plugins.
- `frontend/` — Vue 3 SPA (Vite, Pinia, vue-router, `marked`+`dompurify`).
- `scripts/` — sandbox setup, start scripts, isolation integration, Playwright browser regressions.
- `docs/` — design (01–04), M0 report (05), deployment (06), business acceptance (07), enterprise frontend plan/acceptance (08–09), MCP phase 1 (10). Authoritative for "what is implemented vs. deliberately not".
- `data/` — **gitignored runtime state**: `auth.json`, `encryption.key`, `admin-login.txt`, `business.env`, SQLite DB. Never commit or force-add.

## Setup & run

Requires **Node ≥24.9.0** and **Python ≥3.12**.

```bash
python3 -m venv .venv && . .venv/bin/activate
python3 -m pip install -e 'backend[dev]'
npm --prefix runner ci
npm --prefix frontend ci
python3 scripts/setup-sandbox.py   # creates data/auth.json + data/business.env + admin-login.txt (idempotent)
make build

# production (same-origin :5173 serving frontend/dist)
bash scripts/start-runner.sh       # terminal 1, Runner :9000
bash scripts/start-api.sh          # terminal 2, FastAPI + built SPA :5173
```

The `make` targets are the canonical entry points (see `Makefile`):

```bash
make dev-runner      # tsx watch, Runner :9000
make dev-backend     # uvicorn --reload, control plane :8000 (needs data/business.env)
make dev-frontend    # Vite :5173, proxies /api → :8000

make typecheck       # compileall + tsc --noEmit (runner) + vue-tsc (frontend)
make lint            # ruff (F,E9) + ruff format --check + prettier + icon check
make test            # contract + isolated Runner/API tests; never calls a real model
```

`make test` runs: frontend draft test → runner `contract` → runner business/workspace checks → `check-preview-auth.py` → `check-business-api.py`. It does **not** run pytest; the single pytest suite is separate.

Run a single test:

```bash
python3 -m pytest backend/tests/test_mcp_config.py       # only pytest test (MCP import validation)
npm --prefix runner run contract                          # dsh extension-point contract check (incl. config keys written to dsh plugins)
npm --prefix runner run test:workspace                    # workspace tool checks only
node --import tsx runner/scripts/check-business.mjs       # isolated business-kernel fixture (fake gateway)
npm --prefix frontend test                                # conversation-draft checks
```

Optional browser regressions (need `python3 -m playwright install --with-deps chromium` first): `scripts/check-business-api.py --browser`, `scripts/check-business-ui.py`, `scripts/check-iframe-auth.py`. These create/destroy temporary scenarios and are for human verification, not CI gates beyond `checks.yml`.

## Architecture

### Request / execution flow

The control plane (`backend/src/api`) is the only thing the browser talks to, same-origin. It authenticates the request, then calls the Runner over HTTP with an internal `Bearer FORGE_RUNNER_TOKEN` (`backend/src/api/services/runner_client.py`). The Runner (`runner/src/server.ts`) is a Fastify app that is **never exposed to the browser**; it spawns one `dsh sdk-minimal` subprocess per session via `DshProcess` (`runner/src/kernel/dsh-process.ts`), speaking newline-delimited JSON-RPC.

### Bundle vs. SessionManifest (scenario → execution contract)

A `Scenario` (场景) is compiled by `ScenarioAssembler.compile()` (`backend/src/api/services/scenario_assembler.py`) into a `Bundle` — the control plane's frozen record: `profile_patch` (system prompt), `plugin_mounts`, `policy_ref`, and `meta` (fields documented by the `BundleMeta` TypedDict). Every session stores a `bundle_snapshot` and `bundle_hash` (sha256) at creation, so later changes to a scenario/policy/model do **not** affect existing sessions. Old snapshots may still carry the removed fields `skill_files` / `mcp` / `model_route` / `input_schema`; always load them with `Bundle.from_dict()`.

The Runner never sees the Bundle. `runner_client` sends its projection, the versioned **`SessionManifest`** (`backend/src/api/core/manifest.py`): system prompt, plugins, tools, plugin bindings, runtime policy, `policyRef` and the Skill-authoring draft — no control-plane bookkeeping (scenario name, prices, `isTest`…). The Pydantic model is the single source: `make contracts` exports `contracts/session-manifest.schema.json` and generates `runner/src/kernel/manifest.generated.ts`; `make test` / `npm test` fail when either artifact is stale. The Runner validates the manifest at the door (`parseManifest`, 422 on unknown `version`). Incompatible changes must bump `MANIFEST_VERSION`.

`contracts/platform.json` is the other shared contract: the builtin tool catalogue (name/group/provider) and capability limits, read by both `core/contracts.py` and `runner/src/kernel/platform-contract.ts`. `provider` is either a dsh package (checked by `npm run contract`) or a Forge plugin name (checked by `scripts/check-wiring.mjs`, which loads the plugin and asserts it registers exactly the tools the contract assigns to it). A tool with `follows` (e.g. `workspace_present` follows `workspace_write`) opens together with its leader and is not a separately managed policy tool; the backend excludes it from the policy list but still reserves its name.

### Session kernel + DSH adapter

`runner/src/kernel/session-kernel.ts` (`SessionKernel`) owns sessions, turns, the event journal, approvals and capacity; it is engine-agnostic and only builds a `RuntimePlan`. **Everything dsh-specific lives in `runner/src/kernel/dsh/`**: `process.ts` (newline JSON-RPC child process), `protocol.ts` (dsh notifications → Forge events, `SDK_METHODS`), `runtime-config.ts` (`RuntimePlan` → dsh runtime patch, `DSH_PACKAGES`, `ENGINE_TOOL_PROVIDERS`) and `engine.ts` (`DshEngine`), plus `engine-tools.js` — dsh native tool names and the shape of their path arguments, written in plain JS so the kernel (via `engine-tools.d.ts`) and the forge-runtime plugin share one copy. A dsh protocol or packaging change should only touch that directory; a change to the dsh *plugin API* also touches the Forge plugins. `npm run contract` (`scripts/contract-check.mjs`) derives its expectations from those declarations and asserts the dsh extension points still exist — run it before/after any dsh upgrade.

### Forge plugins

Forge's own dsh plugins are registered in one place, `runner/src/kernel/forge-plugins.ts` (`FORGE_PLUGINS`: plugin name and whether a session manifest may request it). Plugins live in `runner/internal-plugins/<name>/` — the directory name *is* the plugin name, and `internal-plugins/shared/` holds libraries shared by plugins (not plugins); `check-wiring` asserts the table and the directories match one to one. The kernel builds plugin rows only through `forgePlugin(name, config)`, and manifest validation uses `MANIFEST_PLUGINS`; dsh packages are not in this table (they belong to `dsh/runtime-config.ts`). Plugins report events to the Runner with `notify()` from `runner/internal-plugins/shared/events.js`, whose `FORGE_EVENTS` table is also what `dsh/protocol.ts` translates; unregistered `forge.*` events are logged as warnings, and `check-wiring` asserts every `forge.*` used in plugin sources is registered and translatable.

`runner/internal-plugins/forge-runtime/` (`inject: ['llm','tools','approval']`) is loaded into every dsh process. `index.js` only composes:
- `gateway.js` — the `forge-gateway` `LlmAdapter`, streaming from an OpenAI-compatible `/chat/completions` endpoint with the model config from `FORGE_MODEL_SECRET_CONFIG`. It is the only real model exit.
- `workspace-tools.js` — `current_time`, `workspace_list/read/write/present`, with quotas from `limits.js`.
- `policy-hooks.js` — `restrict` + allowlist `guard`, path narrowing for dsh `glob/grep/read` (`path-guard.js`, driven by `PATH_TOOLS`), secret filtering of search results, `bash` gating and output sanitizing (`bash-rules.js`), and per-call `ask` for admin-flagged MCP tools.

The `bash` tool itself is dsh's persistent shell from the `sdk-minimal` profile (`@deepseek-ai/dsh-tool-bash-persistent`); forge-runtime only gates and sanitizes it.

The historical M0 POC (fake model + `forge_probe` security probe, `scripts/poc.mjs`) has been removed; it is in git history up to commit `1ca7e8e`, and `docs/05` keeps its report.

### Event stream & persistence

Turns are owned by the Runner. `POST /v1/sessions/:id/turns` returns `{turnId, after}` and the turn keeps running even if the control plane goes away. Every durable `KernelEvent` (`{seq, source, kind, payload, ts}`) is appended to an on-disk journal per session (`runner/src/kernel/journal.ts`). The journal is kept until the control plane acks it (`POST /events/ack`), and can be read with `GET /v1/sessions/:id/events?after=seq` (SSE). Streaming deltas are `transient: true`: they are pushed live and never journaled.

The backend's `SessionService` (`backend/src/api/services/session_service.py`) consumes that stream per session:
- It persists messages to `SessionMessage` and an append-only index to `SessionEventIndex`, accumulates token/cost from `cost_tick`, and re-publishes a normalized SSE at `GET /api/agent/sessions/{id}/events`.
- The Runner journal seq is **not** `SessionEventIndex.seq`. The consumed position is stored in `agent_session.runner_event_seq`, updated in the same transaction as each event, so persistence is idempotent: events at or below it are skipped. The next turn reads from there, so missed events are backfilled.
- On shutdown the pumps detach without finishing the turn.
- On startup `SessionService.reconcile()` asks the Runner about each running session. Still running → reattach. Finished or lost → backfill the journal and settle. Unreachable → `interrupted`, and pending approvals are `cancelled`.

Approvals create `ApprovalTicket` rows that resolve via `POST /api/agent/approvals/{id}/resolve`, which forwards the decision to the Runner.

### Auth & security model

Single admin account; scrypt-hashed password + HMAC-signed cookie `forge_session` (HttpOnly, SameSite, CSRF via `X-Forge-CSRF` header) — see `backend/src/api/core/security.py`. A **preview-header** fallback (`X-Forge-Session`, 1h, server stores only a hash) exists for sandboxes that block cookies. Model API keys are Fernet-encrypted (key in `data/encryption.key`) and stored in a per-session `PlatformSetting`, never in the exportable Bundle. All `/api/*` responses use a `{code, message, data}` envelope (`ResponseUtil.ok`); the frontend `api()` rejects when `code !== 0`.

### Config & secrets

`backend/src/api/core/config.py` reads pydantic-settings with `FORGE_` env prefix. `data/business.env` holds `FORGE_RUNNER_TOKEN` (≥24 chars — both backend and Runner refuse to start without it) and `RUNNER_MAX_SESSIONS`. Default storage is SQLite (WAL); `FORGE_DATABASE_URL` can point at PostgreSQL.

## Constraints & gotchas

- **No shell / network tools.** Only the four workspace tools are whitelisted. `Runner :9000` must stay internal.
- **No fork, no replay-as-execution.** There is no fork API. After a Runner restart a session is re-assembled from its snapshot and continues from the engine's on-disk session log (`/restore`); 404/410 mean the log is missing/unrecoverable and a new session is required.
- **Real models only.** With no model configured, sessions fail with "模型未配置" rather than falling back to a fake.
- **Immutable snapshots.** Policy/model/price changes affect only new sessions; existing sessions keep their `bundle_snapshot`.
- **Node >= 24.9 for the Runner.** dsh's `bin.js` self-starts via `import.meta.main`, so the old `dsh-launch.mjs` wrapper is gone; `dsh/process.ts` spawns `bin.js` directly.
- **Deliberately unimplemented** (do not silently add or fake these): real employee identity/OIDC, enterprise RBAC, per-employee session isolation, Skill/MCP/project/knowledge mounting into execution, AI Creative scenario generation, structured input forms, native fork, container-grade isolation, Redis/S3/WORM/SIEM.
