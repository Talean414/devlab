# DevLab

DevLab is a native developer control plane built with **Tauri 2, Rust, React, TypeScript, Vite, Tailwind CSS, and Monaco Editor**. Its AI tools use a **bring-your-own-key (BYOK)** connection to Google Gemini, so DevLab itself does not require a paid subscription.

> **Start here:** the DevLab application is in [`devlab/`](./devlab). The repository's `medbook-queue/` directory is a separate sample project and is not required to run DevLab.

## Native migration status

Phases 1 through 4, Docker, SQLite, PostgreSQL, native HTTP, and the first Phase 6 test/repair slices are implemented: DevLab has a Tauri desktop shell, typed Rust-to-React IPC, restricted capabilities, a real scoped workspace service connected to Monaco, a cross-platform PTY terminal connected to xterm.js, native source control, bounded access to a real Docker CLI and engine, workspace-scoped SQLite connections, real PostgreSQL sessions with explicit TLS policy, a native API client, backend-owned test execution profiles, reviewed repair drafts, explicit native application of approved drafts, a bounded native audit trail for test/repair actions, permission-gated multi-file draft staging, bounded reviewed-draft diff inspection, unified native staging for generated drafts, AI Agent reviewed-draft extraction, bounded read-only workspace context for the Agent, audited context metadata, explicit context refresh, a native Agent context browser, Agent-panel audit activity visibility, Agent audit filtering/search, expandable Agent audit metadata details, shared audit rendering, copyable metadata summaries, AI Agent reviewed-draft manifests, metadata-only draft extraction diagnostics, Editor reviewed-draft summaries, explicit reviewed-draft recompare guidance, a session applied-draft ledger, read-only native toolchain detection, a task-aware model-routing foundation that keeps Gemini as the active runtime provider while clearly marking DeepSeek, Ollama and other providers as future adapters, a bounded metadata-only repository map that can be attached to Agent context, an Agent-side metadata-only repo-map preview/filter/copy inspector with path-based focus hints, a spec-first Project Builder review pack with acceptance/risk/review-gate metadata, a read-only spec metadata preview, and task DAG implementation batches that generate missing drafts only in memory before reviewed Editor apply plus metadata-only task handoff packets for focused step-to-step review context, reviewed-draft verification guidance that discovers backend-owned test profiles without executing them, inline Monaco diff review with change navigation, session-only review annotations, review-queue filters and keyboard shortcuts for generated drafts before apply, and prompt-level UI/architecture guardrails, metadata-only starter blueprint guidance, component/style guidance, design-system prompt guidance, quality checklist prompt guidance and a read-only generation guidance preview for generated outputs.

A workspace can be granted only through the native folder picker. The Rust backend holds its canonical root in memory, rejects absolute paths and parent traversal, blocks symlink access, limits text I/O, watches native filesystem changes, and uses content revisions to prevent silent overwrites.

A terminal starts only after an explicit click and launches the operating system’s real default shell in the selected workspace. Rust streams raw PTY bytes, validates session IDs, bounds retained history, handles resize and termination, and reports the real process exit status. Shell commands are intentionally not confined to the workspace and have the same authority as the user running DevLab.

Source Control discovers only a repository whose canonical root exactly matches the selected workspace. Fixed Rust commands read real porcelain status, diffs, history, branches and remotes; stage and unstage paths; create commits; and run confirmed fetch, fast-forward pull and non-force push operations with time and output limits. Git hooks and fsmonitor helpers are disabled for DevLab-owned commands. GitHub, GitLab and Bitbucket tokens are stored by the operating system credential store and are never returned to the renderer.

Containers detects the real Docker CLI and daemon, then reads actual containers, one-shot resource statistics, images and bounded logs. It can pull a validated image reference and create a stopped container with a validated name and optional loopback-only port mappings. Start, stop, restart and non-force removal use validated full container IDs; disruptive actions require confirmation. Arbitrary Docker arguments, custom container commands, environment values, host mounts, privileged mode, builds, image/volume deletion and Compose deployment are not exposed by this step.

Database opens an existing SQLite file only through the native picker and only when its canonical path remains inside the selected workspace. The bundled Rust-owned SQLite engine exposes the real user schema and one statement at a time with a five-second timeout, 1,000 displayed rows, 200 columns, bounded cells and a 2 MiB encoded-result budget. Connections default to operating-system-enforced read-only mode. Users can explicitly enable writes per in-memory connection, but every mutating statement still requires separate confirmation. Database attachment, configuration PRAGMAs, explicit transactions, temporary/virtual-table DDL and filesystem-capable SQL functions are blocked.

PostgreSQL connectivity, schema inspection, bounded reads and separately confirmed writes are now native: DevLab opens a real process-memory session with a five-second per-address connection timeout, an explicit `verify-full` or `disable` TLS policy, server-enforced session timeouts, read-only-by-default configuration, and optional password storage in the operating-system credential store. A fixed Rust-owned catalog query returns genuine schema metadata. Every statement runs as exactly one parameter-free statement, and the server rather than a string parser classifies it: DevLab first attempts the statement inside a read-only transaction, where PostgreSQL rejects any mutation with SQLSTATE 25006 before it can change data. Reads return directly from that transaction, so a read is never executed twice. A mutation re-runs in a bounded write transaction only when writes are enabled for that in-memory session and the user confirms that exact statement. Accepted classes are `SELECT`, `WITH`, `VALUES`, `TABLE`, `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `CREATE`, `ALTER`, `DROP`, `TRUNCATE`, `CALL` and `REFRESH`; `CALL` and `MERGE` are accepted when they do not return a result set. Writes can be turned off again at any time, which sends `SET default_transaction_read_only = on` for the session. Time, row, column, cell and encoded-output bounds apply to reads and to `RETURNING` results alike, while statements without a result set report the server's real affected-row count. Identifiers, bound parameters and stacked statements remain rejected. Two statement classes are refused before they run when they would return a result set: PostgreSQL allows neither `CALL` nor `MERGE` inside a `FROM` sub-query or a `WITH` body, so DevLab has no way to apply its server-side cell bounds to their rows, and reports `postgres_result_set_unbounded` instead of running them with weaker bounds. Both work normally when they return no result set, which is the usual case. No sample server, schema or result is substituted. Native HTTP is also implemented: the API Client sends real `http://` and verified `https://` HTTP/1.1 requests from Rust instead of browser `fetch`, so browser CORS does not apply. The client accepts structured method, URL, header, body and timeout fields; rejects non-HTTP schemes, embedded URL credentials, raw spaces/control characters, hop-by-hop framing headers and unsupported methods; forces `Connection: close` and `Accept-Encoding: identity`; and bounds custom headers to 32 KiB, response headers to 64 KiB, request bodies to 2 MiB and response bodies to 5 MiB. Redirects are reported honestly with their status and `Location` header and are not followed automatically in this checkpoint. Native test execution is also implemented as the first Phase 6 slice: Rust discovers package.json test scripts, Cargo, Go and pytest profiles from the selected workspace, exposes only those backend-owned profile IDs to React, runs the chosen command without a shell, captures bounded output, and kills the process after 60 seconds. Phase 6B adds a reviewed repair-draft loop on top: after a real failing test run, the user chooses one existing workspace file, React reads it through the native workspace boundary, Gemini receives bounded test-output excerpts plus that file, and DevLab opens the complete patched file as an in-memory editor draft. Phase 6C adds an explicit reviewed-draft application button in the editor: new files are created only after the user clicks Apply, existing files are read first and overwritten only after a second confirmation with the native revision check. Phase 6D adds a bounded native in-memory audit trail for test runs and reviewed-draft writes; file contents and captured output are not stored in that log. Phase 6E enables the Project Builder as a permission-gated multi-file draft staging tool: generated files remain in memory, Rust validates bounded draft metadata before editor review, and writes still require the existing explicit reviewed-draft apply path. Phase 6F adds bounded reviewed-draft diff inspection in the editor before each explicit per-file apply click. Phase 6G routes generated drafts from Project Builder, Architecture Canvas, migrations, reverse engineering and self-healing repairs through the same native agent-tools staging/audit gate before editor review. Phase 6H lets the AI Agent surface explicitly labeled complete file blocks as reviewed drafts through that same staging path. Phase 6I lets the AI Agent attach bounded existing workspace files as read-only context through the native workspace read path; this context is memory-scoped and not included in localStorage recovery. Phase 6J records bounded metadata for those read-only context attachments in the native audit log without storing file contents. Phase 6K adds an explicit refresh action so attached context can be re-read through the native workspace boundary, re-bounded, re-audited and updated to latest revisions before the next prompt. Phase 6L replaces manual Agent context paths with a native workspace browser backed by bounded `workspace_list` and `workspace_read` calls. Phase 6M surfaces recent metadata-only Agent audit activity inside the Agent panel. Phase 6N adds Agent-side audit filtering and metadata search for context, draft staging and reviewed-write records. Phase 6O adds expandable metadata-only event details for those Agent audit records. Phase 6P batches the audit polish: shared metadata-only audit rendering across Agent and Self-Healing surfaces, refresh/count status and explicit copy of visible metadata summaries. Phase 6Q adds metadata-only AI Agent reviewed-draft manifests with file counts, sizes, languages and line counts before staging. Phase 6R adds metadata-only draft extraction diagnostics for ignored duplicate, unsafe or over-limit blocks. Phase 6S adds metadata-only reviewed-draft summaries in the Editor review gate with applied/pending counts and explicit copy support. Phase 6T adds explicit selected-draft recompare, comparison timestamps and apply-button guidance at the final review gate. Phase 6U adds a session-scoped applied-draft ledger with applied action, time, revision and size metadata in Editor summaries. Phase 6V adds read-only native toolchain detection through fixed bounded version probes without a shell. Phase 6W adds a task-aware model-router foundation: Agent, Builder, Canvas, migrations, reverse engineering and repair flows label their generation intent, Gemini fallback ordering can be biased by task class, Settings shows provider/router metadata for Gemini, DeepSeek, Ollama, OpenAI, Anthropic and custom endpoints, and every non-Gemini profile remains explicitly unavailable until native credential storage and bounded transport adapters are implemented. Phase 6X adds a bounded metadata-only repository map for the Agent: it recursively lists the selected workspace through existing scoped native `workspace_list` calls, skips heavy/generated folders, records no file contents, stays memory-scoped, can be refreshed, and can be attached as synthetic read-only context. Phase 8F adds an Agent-side preview/filter/copy inspector over the already-attached map metadata without reading file contents, building an index, persisting state or executing commands. Phase 8G adds metadata-only path-based focus hints inside the rendered repo map for manifests, source/UI folders, backend/service folders, tests and data/schema/migration paths. Per-file Tree-Sitter outlines arrive in Phase 9H and the workspace-wide Tree-Sitter code map in Phase 9I; repo-importance ranking remains future roadmap work. Phase 6Y adds a spec-first Project Builder review pack: approved plans can produce a bounded in-memory `spec.md` with scope, setup-command references, reviewed file targets and a sequential task DAG, then copy it or stage it through the existing reviewed-draft editor flow. Phase 8H enriches that spec draft with metadata-only acceptance criteria, dependency assumptions, risk notes and review gates while keeping it copy/stage-only. Phase 8I adds a read-only Builder preview/copy affordance for that spec metadata before copying or staging `spec.md`. Phase 8J adds Builder task DAG implementation batches: approved plan tasks appear as sequential cards with dependency, acceptance, review-gate and per-target generated/pending status; users can copy a task DAG preview or generate only the missing in-memory drafts for one task; setup commands stay references and writes still require reviewed Editor apply. Phase 6Z adds reviewed-draft verification guidance in the Editor: it discovers backend-owned native test profiles, recommends likely checks for the current draft paths, and exports a metadata-only verification manifest, but it does not run tests or shell commands. Phase 7A replaces text-only review with an inline Monaco diff review in the Editor gate, showing original workspace content beside the reviewed draft while preserving explicit recompare and apply controls. Phase 7B adds read-only change-block counts, previous/next diff navigation and visible per-file apply state in that same review surface. Phase 7C adds session-only reviewed-draft annotations, bounded reviewer notes and annotation counts without changing apply behavior. Phase 7D adds session-only review-queue filters for all, pending, applied, reviewed and needs-changes drafts. Phase 7E adds keyboard shortcuts for moving through read-only diff changes and the filtered in-memory review queue. Phase 8S adds session-only named review views that snapshot and restore the filter, annotations and selection for the current queue without touching apply. Phase 8A adds centralized prompt-level generation guardrails for modern UI, component architecture, dependency honesty, accessibility and review-only output. Phase 8B adds metadata-only starter blueprint guidance sourced from DevLab's existing template catalog for planning/coding/vision routes. Phase 8C adds component/style scaffolding guidance plus a read-only Settings preview of active generation guidance. Phase 8D adds design-system prompt guidance for frontend/UI routes while preserving dependency honesty. Phase 8E adds quality checklist prompt guidance for type-safety, formatting, linting, accessibility, tests and documentation as suggestions only. Phase 8F adds a metadata-only Agent repo-map preview/filter/copy inspector. Phase 8G adds metadata-only repo-map focus hints to help choose which files to attach next. Phase 8H enriches Builder spec review packs with acceptance/risk/review-gate metadata. Phase 8I adds a read-only Builder spec metadata preview and copy affordance. Phase 8J adds renderer-only Builder task DAG batches for copying a task plan and generating missing per-task drafts in memory before reviewed Editor apply. Phase 8K adds metadata-only Builder task handoff packets and a handoff ledger with per-task dependencies, next-task links, generated draft file metadata, pending targets, acceptance notes and apply-boundary reminders. Phase 8L lets each Builder task batch stage only its own generated in-memory drafts through the existing native agent-tools metadata gate into Editor review, and keeps a session-only, metadata-only task staging ledger that is excluded from recovery snapshots. Phase 8M feeds metadata-only outcomes from explicit Editor reviewed-draft applies back into the Builder task DAG as session-only apply progress, per-target applied/changed-since-apply chips, a dependency-aware suggested-next-task hint and apply state inside handoff packets, without re-reading the workspace or claiming verification. Phase 8N adds a discovery-only per-task verification handoff in the Builder: it calls the existing read-only native test-runner snapshot, matches discovered backend-owned profiles to the reviewed file targets already applied in the Editor, and offers copy plus a link to Self-Healing Tests, where profiles still run only on explicit click. Phase 8O closes that loop as a session-only metadata exchange: Builder can send one task batch to Self-Healing Tests, which only pre-selects the top matching discovered profile and still requires the explicit Run click, and after a real run Self-Healing Tests reports status, exit code and timing metadata (never captured output) back to the Builder task ledger, where a later apply or draft change marks the run as superseded. Phase 8P adds a repair handoff for a batch whose current real run failed: the Builder opens Self-Healing Tests in repair mode, the profile must be rerun explicitly there, and after a real failing run the batch's applied targets are offered as one-click repair-target candidates for the existing one-file reviewed repair draft, which still requires Editor reviewed apply. Phase 8R adds a path-only reviewed-draft policy: a built-in, non-removable secret-safe deny list (`.env`, `*.pem`, `*.key`, `id_rsa*`, `.npmrc`, `.git/**`, credential files and similar, with `.env.example`-style exceptions) plus user-editable allow/deny glob patterns in Settings, enforced at the single shared staging gate for every generator before Rust validation and Editor review; refused paths are dropped with a visible reason and never staged. Phase 8Q adds a session-only Builder task run timeline: each task shows its plan → draft → stage → apply → verify → repair phase state derived purely from metadata already in the session (task DAG, in-memory draft paths, staging ledger, Editor apply outcomes, handoff requests and real run outcomes), counts apply→run iterations, marks runs superseded by later applies, and exports a metadata-only loop summary; it reads no files, executes nothing and is excluded from recovery snapshots. Phase 8S adds session-only saved review views in the Editor gate: a named snapshot of the current review-queue filter, per-draft session annotations and selected draft can be saved (up to 12 per queue), previewed, restored with a confirmation when it would replace current annotations, deleted or copied as review-only metadata; views are dropped when the queue is replaced, never persisted and never change apply requirements. Phase 9A is the first native provider slice: a Rust-owned, loopback-only Ollama adapter. The endpoint must be plain `http://` to `localhost`, `127.0.0.0/8` or `::1` (checked literally, never resolved), only the fixed `/api/tags` and `/api/chat` paths are used, prompts/messages/models/replies are bounded, generation is non-streamed with a 120-second bound, and the WebView never calls localhost itself. Settings → Providers can detect installed models and pick one; chat, planning, coding, architecture, migration and repair then run on the local model with no Gemini key and no cloud fallback, while vision stays on Gemini. The adapter advertises the `local-ai` capability only inside the desktop app and is unavailable in the web preview. Phase 9B adds native DeepSeek, OpenAI and Anthropic adapters: API keys are written once through Rust into the operating-system credential store (separate service from Git tokens), are never returned to the WebView, logged or echoed in errors, and are attached by Rust only to HTTPS requests for each provider's fixed compiled-in host and path; prompts, models and replies are bounded, generation is non-streamed with a 120-second bound, provider errors are mapped to honest unauthorized/billing/model-not-found/rate-limited codes without retries, and there is no fallback to Gemini. Vision remains Gemini-only. The `ai-providers` capability is advertised only inside the desktop app. Phase 9C adds a native workspace search index: an explicit, bounded, in-memory SQLite FTS5 (bm25) index over the workspace's UTF-8 text files, exposed in the Agent context picker as a "Search" mode whose hits attach through the same audited read path; nothing is written to disk, secret-pattern files and binaries are never indexed, and the `search-index` capability exists only inside the desktop app. Phase 9D completes hybrid search: an explicit, resumable **Embed** step sends bounded line chunks of the indexed files to the loopback-only Ollama adapter (`/api/embed`), keeps the unit vectors in Rust memory under a budget, and lets the picker rank lexically, semantically (cosine) or hybrid (reciprocal-rank fusion); the `semantic-search` capability is native-only and nothing is embedded automatically. Phase 9E adds the custom OpenAI-compatible endpoint adapter (`custom-endpoint`): a Rust-validated base URL (https:// required unless loopback, no credentials/query/fragment/raw remote IPs, fixed `/chat/completions` suffix), an optional bearer token stored in the OS credential store under an account scoped to the normalized endpoint, and the same bounded transport as the other adapters. Phase 9F adds streamed replies for all native adapters (`ai-streaming`): Rust reads Ollama NDJSON or OpenAI/Anthropic SSE incrementally and forwards bounded text deltas through a Tauri channel, with a Stop button that cancels at the next line; the WebView still never opens the upstream connection and the same host policies, credential handling and reply caps apply. Phase 9G adds per-task provider selection: Settings → Providers → task router lets each task class (chat, planning, coding, architecture, migration, repair, vision) override the global provider and model; the override is non-secret metadata, each provider keeps its own credential, host and bound rules, a task routed to a native adapter stays desktop-only with no Gemini fallback, and vision accepts only Gemini because image input is wired there alone. Phase 9H adds native Tree-Sitter code outlines (`code-outline`): Rust parses one workspace file with a compiled-in TypeScript, TSX, JavaScript, Rust, Python or Go grammar under a 512 KiB, 2-second, 400-symbol bound and returns symbol metadata only (kind, name, one-line signature, line range, nesting, exported flag); the Agent context picker offers an *outline* action beside code files and search hits, the rendered outline is attached as synthetic read-only context like the repository map, and no file body crosses the boundary. Phase 9I adds the workspace-wide Tree-Sitter code map (`code-map`): Rust walks the workspace under the search index's skip rules, parses every supported file with the same grammars and returns depth 0–1 symbols per file under file, byte, symbol and 8-second budgets; the renderer emits a token-bounded markdown map (whole files, omitted-file count instead of mid-entry cuts) as synthetic read-only Agent context. Phase 9J makes Gemini overload handling honest and resilient: a 5xx after the single same-model retry now cools that model briefly (60 s by default, honouring `retry-after` within 15 s–5 min) and fails over to the next candidate, bounded to three models per request; the final message names every model tried and points to the model picker and task router instead of a bare "try again shortly". Phase 9K makes the code map importance-ordered: during the same walk Rust extracts each file's imports (Rust `use`/`mod`, JS/TS `import`/`require`/`export … from`, Python `import`/`from`, Go `import` blocks), resolves them against the mapped files with language-specific rules and scores every file with a damped PageRank over the resulting dependency graph, so the most depended-on modules are emitted first and a tight context budget costs leaf files instead of core ones. Phase 9L adds the workspace dependency graph (`code_graph_build`): a second, cheaper walk extracts imports without parsing symbols, resolves them with the Phase 9K rules and aggregates the file-level edges into directory modules, so DevLab can attach a ranked, token-bounded "how this workspace fits together" summary as Agent context. Phase 9M turns that graph plus the code map into an architecture summary for Agent context: a Mermaid module diagram (emitted as text, never written to the repository), the modules ranked by importance, the most depended-on files and the external packages each module pulls in. Phase 9N adds a read-only dependency inventory: Rust reads the manifests and lockfiles already in the workspace (`package.json`/`package-lock.json`, `Cargo.toml`/`Cargo.lock`, `requirements*.txt`/`pyproject.toml`, `go.mod`) and reports every package with its version or specifier, ecosystem, kind and declaring file, plus per-ecosystem rollups and packages pinned to more than one version — offline, with no advisory lookups and no remediation. Deployment, CI, toolchain install/update management and autonomous patch application remain disabled. The normal Vite server remains available strictly as a UI preview.

## Future phases and next-level roadmap

The following roadmap items are proposed future phases. They are not advertised as current runtime capability until the native command, capability ACL, build manifest, renderer wrapper, UI, documentation and validation are all implemented. Existing safeguards still apply: secrets stay out of React state, file writes remain behind reviewed Editor apply, terminal/command execution requires explicit user action, and CI/deploy/toolchain install or update management remains disabled until a dedicated bounded backend exists.

### Multi-provider BYOK and model routing

Phase 6W implements the first router foundation: task-aware route labels, Gemini task-class fallback bias and non-secret provider-profile metadata in Settings. The deeper items below remain future work.

- Extend the provider-router layer from Gemini-only runtime routing to multiple bring-your-own-key models beyond Gemini, including DeepSeek V3/R1 and other compatible cloud endpoints.
- Phase 9A delivers local Ollama support through a Rust-owned loopback-only adapter with explicit endpoint configuration, bounded timeouts, honest connection errors and no implicit network fallback; Phase 9B delivers DeepSeek, OpenAI and Anthropic adapters with OS-credential-store keys and fixed hosts. Streaming replies, the custom OpenAI-compatible endpoint profile and per-task provider selection remain future work. Phase 9C delivers the lexical half of hybrid search (bundled SQLite FTS5, in memory, explicit build, bounded snippets); Phase 9D delivers the semantic half through local Ollama embeddings with hybrid reciprocal-rank fusion; Phase 9E delivers the custom OpenAI-compatible endpoint adapter with an explicit host policy; Phase 9F delivers streamed replies with cancellation for every native adapter; Phase 9G delivers per-task provider and model selection in the task router; Phase 9H delivers per-file Tree-Sitter symbol outlines as Agent context; Phase 9I delivers the workspace-wide Tree-Sitter code map. Repo-importance ranking remains future work.
- Expand task-aware model routing from current Gemini route metadata into true multi-provider selection: reasoning models for architecture/spec work, fast code models for implementation drafts, and lightweight models for diagnostic repair loops, with pricing-aware usage metadata instead of hard-coded cost assumptions.
- Keep provider credentials scoped to the existing secret-handling policy: API keys and tokens must not be logged, stored in generated files, included in recovery snapshots or returned by native commands.

### Repository-wide context engine

Phase 6X implements the first bounded metadata-only repository map by recursively listing scoped workspace paths without reading file contents. Phase 8F adds a client-side preview/filter/copy inspector over the already-attached metadata-only map. Phase 8G adds path-based focus hints to that rendered map so users can identify likely manifests, source folders, tests and migrations before attaching specific files. The structural/semantic layers below remain future work.

- Phase 9I delivers the Rust-side Tree-Sitter code map (`code_map_build`): classes, types, functions, structs, traits, impls, constants and their one-line signatures across the selected workspace, rendered as a compact token-bounded map for Agent context instead of raw full-file attachment. Imports/exports graphing is not yet extracted.
- Phase 9K delivers the repo-importance layer: import edges extracted during the code-map walk, resolved per language and scored with PageRank, so central modules are prioritized and prompt noise from leaf files is reduced.
- Add local hybrid search over the workspace using lexical search plus locally stored semantic embeddings, with an embedded store such as SQLite VSS or LanceDB when the privacy and storage model is defined.
- Keep indexing scoped to the selected workspace, reject symlink/path traversal, bound file count/bytes, and make index refresh explicit and auditable.

### Spec-driven planning and task decomposition

Phase 6Y implements the first Builder-side spec review pack by deriving a bounded `spec.md` and sequential task DAG from an approved plan, then keeping it in memory until copy or reviewed Editor staging. Phase 8H enriches that generated spec with metadata-only acceptance criteria, dependency assumptions, risk notes and review gates. Phase 8I adds a read-only preview/copy affordance for that spec metadata before `spec.md` is copied or staged. Phase 8J turns the same bounded DAG into renderer-only implementation batches with per-task dependency, acceptance, review-gate and generated/pending draft status plus copy support and missing-draft generation. Phase 8K adds metadata-only handoff packets and a task handoff ledger so generated draft metadata, pending targets and next-task links can move between steps without copying file contents or writing to the workspace. Phase 8L routes each task batch through the existing reviewed-draft staging gate individually, so users can review and apply one task's drafts in the Editor before generating the next, and records a session-only task staging ledger with path/byte metadata only. Phase 8M closes the loop in the other direction: each explicit Editor reviewed-draft apply reports path, action, byte, line and revision metadata back to a session-only ledger, which the Builder uses to show per-task apply progress, flag applied targets whose in-memory draft has since changed, suggest the next dependency-ready task and include apply state in handoff packets. Phase 8N adds a discovery-only verification handoff that pairs each task batch with applied targets to the backend-owned test profiles discovered by the read-only native snapshot, without executing anything from the Builder. Phase 8O lets that handoff pre-select the matching profile in Self-Healing Tests and brings metadata-only run outcomes back per task. Phase 8P routes a failed batch into the existing reviewed repair-draft flow by offering its applied targets as repair candidates after a real failing rerun. Phase 8Q renders the whole plan → draft → stage → apply → verify → repair loop per task as a session-only timeline with a copyable metadata-only loop summary, so a user can see where each batch stands without DevLab inferring or claiming anything it did not observe. The deeper agent-run orchestration below remains future work.

- Expand spec-first workflows for complex features where the Architect Agent drafts richer `spec.md` artifacts before implementation.
- Include deeper architecture breakdown, data flow, API contracts, database changes, changed-file plan, risk notes and out-of-scope boundaries.
- Convert approved specs into richer task DAGs so work can proceed as discrete sub-tasks instead of one large prompt.
- Continue routing sub-tasks through reviewed-draft staging beyond the current per-task batch staging, and preserve the invariant that workspace writes happen only after explicit Editor review/apply.
- Extend task status tracking beyond the current session-only staging and apply-progress metadata, and hand off bounded diffs/metadata between steps so context remains focused as the codebase changes.

### Closed-loop verification and self-healing

Phase 6 ships bounded native test execution and reviewed repair drafts, the Editor shows discovery-only verification guidance for reviewed drafts, Phase 8N adds a discovery-only per-task verification handoff in the Builder that matches already-discovered backend-owned profiles to applied targets without running them, and Phase 8O completes the first bounded loop: sending a batch to Self-Healing Tests only pre-selects a profile, the user still clicks Run, and the real run's status/exit/timing metadata flows back to the Builder task ledger without captured output. Phase 8P connects a failed batch to the existing one-file reviewed repair draft: earlier output is never reused, the profile is rerun explicitly, and the batch's applied targets become repair-target candidates. Automatic multi-iteration repair loops below remain future work.

- Extend the current native test runner into a bounded closed-loop verification system for generated drafts.
- Detect available project checks from trusted profiles such as `tsc --noEmit`, `cargo check`, `biome check`, `eslint`, `pytest`, Go tests or package-manager scripts.
- Run verification only through backend-owned profiles with explicit bounds, timeout/kill behavior and captured-output limits.
- Feed diagnostics and targeted source context back into a repair loop for a small bounded number of attempts, for example up to three repair iterations.
- Surface final drafts, diagnostic metadata and any unresolved failures to the user before reviewed Editor apply rather than silently writing changes.

### Inline Monaco diff and patch review UX

Phase 7A implements the first inline Monaco diff review inside the reviewed-draft Editor gate, with original workspace content on the left and reviewed draft content on the right. Phase 7B adds read-only Monaco change-block counts, Previous/Next navigation and visible per-file apply state in that same review surface. Phase 7C adds session-only review annotations and bounded reviewer notes for each generated draft. Phase 7D adds session-only review-queue filters for all, pending, applied, reviewed and needs-changes drafts. Phase 7E adds keyboard shortcuts for read-only diff navigation and filtered review-queue movement. Phase 8S adds session-only saved review views so a reviewer can name, restore, delete or copy a snapshot of the current filter, annotations and selection for one queue. The deeper polish below remains future work.

- Continue improving side-by-side file comparison with richer inline decorations, saved review views and finer line-level review affordances beyond the current Previous/Next change-block navigation, session-only annotations, review-queue filters and keyboard shortcuts.
- Preserve the existing reviewed-draft apply path, native revision checks, recompare guidance and applied-draft ledger.
- Keep generated content in memory until explicit apply; do not introduce automatic patch writes.

### Modern UI and architecture guardrails

Phase 8A implements the first centralized prompt-level guardrail layer for generation routes: modern responsive UI defaults, component architecture boundaries, accessibility expectations, dependency honesty and explicit review-only output language. Phase 8B adds metadata-only starter blueprint guidance sourced from DevLab's existing template catalog for planning, architecture, coding and vision routes. Phase 8C adds component/style scaffolding guidance and a read-only Settings preview of active generation guidance. Phase 8D adds design-system prompt guidance for frontend/UI routes and exposes it in the same read-only preview. Phase 8E adds quality checklist prompt guidance for type-safety, formatting, linting, accessibility, tests and documentation as suggestions only. The deeper items below remain future work.

- Continue refining design-system prompt injection beyond the current guidance for frontend generation: modern Tailwind CSS, subtle elevation/glass effects, Lucide iconography, Framer Motion micro-interactions and mobile-first responsive layouts when dependencies are present or explicitly planned.
- Continue expanding production-grade starter blueprint metadata and UI affordances beyond the current prompt-only guidance for Next.js App Router, Vite + React + Tailwind, Rust Axum/Actix, Dockerized stacks, Tauri and full-stack API templates.
- Continue refining component-driven scaffolding rules beyond the current prompt guidance for small single-responsibility files, strict TypeScript interfaces, custom hooks and clean state-management patterns such as TanStack Query or Zustand where appropriate.
- Continue refining style-guide and quality defaults beyond the current prompt-only guidance: strict TypeScript, Biome or ESLint/Prettier configs, sensible test setup, accessibility checks and conventional project structure.

### Enterprise agent architecture

- Add a durable Agent run model with explicit phases: plan, approve, execute draft, verify, repair, review and apply.
- Support larger enterprise repositories through repo maps, hybrid search, task DAGs, scoped memory and metadata-only audit trails.
- Extend the Phase 8R path-only draft policy into team policy packs: forbidden actions, required checks, branch/PR naming, dependency rules and review gates.
- Add PR/branch orchestration only after GitHub/GitLab operations, CI status reads and write actions are bounded, audited and confirmation-gated.

### Additional future upgrades

- Extend the Phase 9A "Detect installed models" check into fuller local model health checks for Ollama and other local inference servers, including context window metadata.
- Phase 9N delivers the read-only metadata half: a workspace dependency inventory built offline from the manifests and lockfiles already in the repository (see 13c⁗⁗). Matching those packages against vulnerability advisories or licences, and gating remediation drafts behind reviewed Editor apply, remains future work.
- Add database migration safety planning: dry-run SQL, rollback notes, lock-risk warnings and environment separation before any migration draft is staged.
- Phase 9L delivers the module-level dependency graph behind the planned architecture diagrams (imports resolved per language, aggregated into directory modules with weighted edges and external packages) and Phase 9M renders it as a Mermaid diagram plus a ranked architecture summary for Agent context; drawing that diagram inside the DevLab UI, and combining it with the repository map into one interactive picture, remains future work.
- Add benchmark and performance profiling profiles for projects that opt into them through explicit backend-owned commands.
- Add extension/plugin APIs only after a strict permission model exists for commands, filesystem access, secrets, network access and UI contribution points.

## Current working features

- Streaming Gemini chat
- Architecture-canvas-to-source generation
- Screenshot and URL analysis
- Natural-language migration generation
- Native folder selection and memory-scoped workspace access
- Real directory browsing and UTF-8 file editing with Monaco
- Explicit file and empty-directory create, rename and delete operations
- Review-only in-memory AI drafts that are never written automatically
- Native filesystem change notifications and save-conflict detection
- Real multi-session PTY terminal with raw streaming, resize, bounded replay and exit status
- Real Git detection, status, diffs, staging, unstaging, commits, history, branches and remotes
- Confirmed fetch, fast-forward pull and non-force push operations with bounded native processes
- OS-protected GitHub, GitLab and Bitbucket credentials with presence-only renderer metadata
- Real Docker CLI/daemon detection, container state, one-shot statistics, local images and bounded logs
- Validated image pulls and constrained stopped-container creation with loopback-only port publishing
- Confirmed container stop/restart/removal with validated IDs; explicit start and no force removal
- Workspace-scoped native SQLite connections with real schema inspection and bounded query results
- User-configurable SQLite read-only/write access with backend-enforced confirmation for every mutating statement
- Real PostgreSQL connectivity, bounded schema inspection and single-statement reads with verified TLS by default
- Separately confirmed bounded PostgreSQL writes, classified by the server through a read-only probe transaction
- Backend-enforced read-only PostgreSQL transactions with time, row, column, cell and encoded-output limits
- Native HTTP/HTTPS API client with verified TLS, fixed framing, timeout controls and bounded headers/bodies
- Native test runner with backend-discovered package, Cargo, Go and pytest profiles, 60-second timeout and bounded output
- Reviewed one-file repair drafts generated from real failing test evidence
- Explicit editor-side application of approved drafts through scoped native writes, revision checks and native audit metadata
- Permission-gated multi-file draft staging for Project Builder, including per-task batch staging with session-only staging and apply-progress metadata ledgers, with no automatic workspace writes
- Project template and command references
- BroadcastChannel/WebRTC collaboration primitives
- Embedded web preview
- WebView-local non-secret preferences; the Gemini BYOK key remains in its existing renderer flow
- Optional local session recovery prompt for Agent and Project Builder progress, stored in WebView localStorage until continued or cleared

Phase 5 is complete through Docker, SQLite, PostgreSQL and native HTTP. Phase 6 now includes bounded native test execution, reviewed one-file repair drafts, explicit approved-draft application, native audit metadata, permission-gated multi-file draft staging, reviewed-draft diff inspection, unified generated-draft staging, AI Agent reviewed-draft extraction, read-only workspace context, audited context metadata, explicit context refresh, a native Agent context browser, Agent-panel audit activity, Agent audit filtering/search, expandable audit metadata details, shared audit rendering, copyable metadata summaries, AI Agent reviewed-draft manifests, draft extraction diagnostics, Editor reviewed-draft summaries, explicit draft recompare guidance, a session applied-draft ledger, read-only native toolchain detection, task-aware model-routing metadata, bounded metadata-only Agent repository maps with client-side preview/filter/copy and focus hints, spec-first Builder review packs with acceptance/risk metadata, preview/copy affordances and task DAG implementation batches, metadata-only task handoff packets, reviewed-draft verification guidance, inline Monaco diff review/change navigation, session-only review annotations, review-queue filters, keyboard shortcuts, prompt-level generation guardrails, metadata-only starter blueprint guidance, design-system guidance, quality checklist guidance and read-only guidance previews; broader agent patch tools, future provider adapters, Per-file Tree-Sitter outlines (Phase 9H) and the workspace-wide Tree-Sitter code map (Phase 9I) are native; repo-importance ranking and signed distribution follow afterward. Until a backend exists, DevLab reports that the feature is unavailable instead of fabricating data or success.

## Requirements

Install these before starting:

1. [Git](https://git-scm.com/downloads)
2. [Node.js](https://nodejs.org/) `20.19+` or `22.12+`
3. npm, which is included with Node.js
4. The current stable [Rust toolchain](https://www.rust-lang.org/tools/install)
5. Your operating system's [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)
6. [Docker Engine or Docker Desktop](https://docs.docker.com/get-docker/) for the optional Containers panel
7. Access to a PostgreSQL server for the optional native server-database checkpoints
8. A [Google AI Studio API key](https://aistudio.google.com/app/apikey) for cloud AI features

Node.js 22 is recommended. If you use [nvm](https://github.com/nvm-sh/nvm), the included `.nvmrc` selects the correct major version.

## 1. Download the project

Open a terminal and run:

```bash
git clone https://github.com/Talean414/devlab.git
cd devlab/devlab
```

The repeated name is intentional: the first `devlab` is the repository and the second is the application directory.

If you downloaded a ZIP instead, extract it, open a terminal in the extracted folder, and then enter the application directory:

```bash
cd devlab
```

## 2. Select a supported Node.js version

With nvm:

```bash
nvm install
nvm use
node --version
npm --version
```

The Node command should print `v22.x`, or another version accepted by the requirement above.

Without nvm, install Node.js 22 from [nodejs.org](https://nodejs.org/) and reopen your terminal.

## 3. Install native prerequisites

On Debian or Ubuntu:

```bash
sudo apt update
sudo apt install -y libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libdbus-1-dev pkg-config \
  libayatana-appindicator3-dev librsvg2-dev
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
```

On Windows, install Microsoft C++ Build Tools with the **Desktop development with C++** workload, WebView2 and Rust with its MSVC toolchain. On macOS, run `xcode-select --install` and install Rust. See the official [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for platform-specific details.

## 4. Install dependencies

From the directory containing DevLab's `package.json`, run:

```bash
npm ci
```

Use `npm ci` for a reproducible installation from `package-lock.json`. If it completes, you should now have a local `node_modules/` directory. That directory is intentionally excluded from Git.

## 5. Start native DevLab

```bash
npm run desktop:dev
```

Tauri starts Vite automatically, compiles the Rust core and opens the native DevLab window. The header should report **Native · your-operating-system**. Keep the terminal running while developing and stop it with `Ctrl+C`.

For interface-only work, `npm run dev` opens a browser preview at `http://localhost:5173/`. Native panels remain disabled in that preview and never fall back to simulations.

## 6. Create and connect a Gemini API key

1. Open [Google AI Studio API Keys](https://aistudio.google.com/app/apikey).
2. Sign in and accept Google's terms if prompted.
3. Create or select a Google Cloud project.
4. Click **Create API key** and copy the new key.
5. Return to DevLab. The **Bring Your Own Key** window appears on first launch.
6. Paste the key and click **Save & Continue**.
7. Open **Settings → Providers**.
8. Click **Test**. The result should say **Key valid**.
9. Select a stable **Flash-Lite** model for the best free-tier throughput. DevLab defaults to `gemini-3.5-flash-lite` and automatically uses only models returned by Google's model-list API.
10. Open **AI Agent**, send `Reply with exactly: DevLab is ready`, and confirm that a streamed response appears.

The Test button validates authentication and model-list access without consuming generation quota. The first real prompt is the final generation test.

### Where the key is stored

The Gemini key is stored in the application WebView's `localStorage` under `devlab.gemini.key` because the current Gemini client runs in the renderer. It is sent only to Google's official Gemini endpoint. It is not written to this repository and no `.env` file is needed. Phase 4's OS-protected storage is deliberately limited to Git credentials, which are consumed by Rust and never returned to the renderer.

Do not hardcode a shared key or add a `VITE_GEMINI_API_KEY` variable when deploying the public web app. Every user should enter their own key. A `VITE_` secret is bundled into public JavaScript and is not secret.

To remove the key, use **Settings → Providers → Clear**. To erase WebView preferences and the Gemini key, use **Settings → Advanced → Erase WebView data**. Git credentials are deleted separately in **Source Control → Credentials**.

### When Gemini is overloaded (HTTP 503)

A 503 (`UNAVAILABLE`, "model is overloaded") comes from Google's side: the model you are routed to is shedding load, which happens most often on free-tier keys and on the newest lite/preview models. DevLab handles it as follows (Phase 9J): the same model is retried once after about a second; if it fails again, that model is placed on a short cooldown (60 seconds by default, or Google's `retry-after` bounded to 15 seconds–5 minutes, stored in the WebView under `devlab.gemini.cooldowns` alongside quota cooldowns) and the next candidate model in the routing order is tried, up to three models per request. A response that has already started streaming is never restarted. If every attempted model fails, the error names the models tried and the suggested wait. If it keeps happening, pick a less contended Gemini model in **Settings → Providers**, or route the affected task to Ollama, DeepSeek, OpenAI, Anthropic or a custom endpoint in **Settings → Providers → task router**; native providers never fall back to Gemini and Gemini never falls back to them.

## 7. Use native Source Control

1. Open **Code Editor** and select the canonical root of an existing Git repository. Selecting only a subdirectory is rejected so Git cannot modify a parent outside the granted workspace.
2. Open **Source Control**. DevLab reports the installed Git version, current branch, working-tree status, configured author, history, branches and remotes from the real repository.
3. Open a changed path to inspect its staged and unstaged diff, then explicitly stage or unstage paths.
4. Enter a message and commit staged changes. DevLab uses Git's existing `user.name` and `user.email`; missing identity and configured clean-filter failures are returned as real errors. Repository hooks are disabled for DevLab-owned commands.
5. For HTTPS remotes, optionally open **Credentials** and save a matching provider token. The value goes to Windows Credential Manager, macOS Keychain, or Linux Secret Service/kernel keyring. DevLab exposes only whether it is configured.
6. Choose a configured remote and explicitly confirm Fetch, Pull or Push. Pull is fast-forward only, force push is unavailable, interactive credential prompts are disabled, and each network process has a two-minute limit.
7. SSH remotes use your existing SSH configuration. If no DevLab HTTPS token matches, Git may use an existing system credential helper.

DevLab never initializes a repository, adds a remote, changes Git identity, checks out a branch, merges, rebases or force-pushes on its own. Use the real terminal for those administrative operations.

## 8. Use native Containers

1. Install and start Docker Engine or Docker Desktop.
2. Confirm `docker version` succeeds for the same operating-system account that launches DevLab.
3. Open **Containers**. DevLab reports the real CLI/engine versions, all containers, local images and one-shot resource statistics.
4. Choose **Pull image**, enter an exact registry reference such as `nginx:latest`, and wait for Docker's genuine result. Pulls have a ten-minute limit and expose no additional CLI flags.
5. Choose **Create container**, select a local image, enter a validated name, and optionally add TCP or UDP port mappings. Host ports bind to `127.0.0.1`; the new container remains stopped and uses the image's default entrypoint and command.
6. Start the new container explicitly, then open **Logs** to read at most the latest 500 timestamped lines. Stop and restart require confirmation and use Docker's 10-second grace period.
7. Removal is available only for stopped containers, requires confirmation and never uses force.

DevLab refreshes Docker state every 15 seconds while the panel is open. This step intentionally does not expose arbitrary Docker arguments, custom commands, environment values, host mounts, privileged mode, builds, image or volume deletion, or Compose deployment.

## 9. Use native SQLite

1. Select the canonical workspace that contains an existing SQLite database file.
2. Open **Database** and choose **Open SQLite database**.
3. Leave **Open read-only** selected for inspection, or explicitly choose **Allow confirmed writes** before opening the native file picker.
4. Select an existing regular database file inside the workspace. A file outside the workspace, a symbolic link, a directory or an invalid SQLite file is rejected.
5. Inspect the real tables, views and columns in the left sidebar. Selecting **Query first 100 rows** generates a quoted `SELECT` statement but does not execute it automatically.
6. Run one statement with the **Run** button or `Ctrl/Cmd+Enter`. Results contain genuine SQLite values and clearly report row, output or cell truncation.
7. To change access later, use **Enable writes** or **Disable writes**. Enabling writes reopens that connection in read/write mode; each statement SQLite classifies as mutating still opens a separate confirmation prompt.
8. Disconnect when finished. SQLite connections and write-access choices stay only in Rust process memory and are not restored after restart.

DevLab does not create a database file in this checkpoint. It blocks `ATTACH`, `DETACH`, configuration PRAGMAs, explicit transaction control, temporary or virtual-table DDL, and filesystem-capable functions. A write is a real database operation and may create SQLite journal or WAL files beside the selected database.

## 10. Open a native PostgreSQL session

1. Select a workspace. PostgreSQL sessions are associated with that active workspace and are never restored after DevLab exits.
2. Open **Database**, choose **PostgreSQL**, and enter a hostname or IP address, port, database and username. DevLab accepts structured fields—not a renderer-supplied connection URL.
3. Keep **Verify certificate and hostname** selected for normal remote connections. This uses the operating-system trust store and does not silently downgrade. Choose **Disable TLS** only for a local server or a separately protected trusted network after reading the plaintext warning.
4. Enter a password. It remains transient unless **Store or reuse this password** is selected; stored passwords go to the operating-system credential store and are never returned to React. Leaving the field blank with storage selected reuses an existing entry.
5. Connect. DevLab reports the actual server version or the genuine DNS, network, authentication, TLS or server error. Each socket address has a five-second connection timeout.
6. Select the live connection. DevLab runs one fixed catalog query and displays the real non-system schemas, tables, views, columns, data types and primary keys. The response is limited to 2,000 objects, 20,000 columns and approximately 2 MiB of encoded schema data.
7. Run one read statement. The backend rejects parameters and unsupported statement classes, prepares exactly one statement, wraps its output with server-side text/cell bounds, and executes it in an explicit read-only transaction. Results are limited to five seconds, 1,000 rows, 200 columns, 16,384 displayed characters per value, and approximately 2 MiB encoded rows.
8. To mutate data, choose **Enable writes** for that session and accept the warning. Then run one `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `CREATE`, `ALTER`, `DROP`, `TRUNCATE`, `CALL` or `REFRESH` statement. DevLab attempts it in a read-only transaction first so PostgreSQL itself classifies it, and the statement runs for real only after you confirm that exact statement. DevLab reports the server's real affected-row count, refreshes the schema, and bounds any `RETURNING` output exactly like a read. For a statement with a result set DevLab reports the rows the server actually returned inside those bounds and sets `truncated` when the server produced more. Choose **Disable writes** to send `SET default_transaction_read_only = on` and return the session to enforced read-only mode.
9. Use **Refresh schema** after an external change. Use **Forget password** to remove a saved credential while keeping the live session open, and **Disconnect** to close the session. Disconnecting does not silently delete a credential the user chose to store.

PostgreSQL statements are prepared by the server, parameter-free in this increment, and streamed through a bounded portal. `RETURNING` output is bounded with a `WITH` wrapper because PostgreSQL forbids a data-modifying statement inside a `FROM` sub-query, while other statements use the equivalent sub-query wrapper; a data-modifying `WITH` body executes exactly once. Direct filesystem/configuration, advisory-lock, backend-control, large-object import/export, and `dblink` identifiers are rejected in addition to PostgreSQL's own read-only transaction enforcement. Database roles and server permissions remain an essential boundary because user-defined functions and foreign tables are controlled by the connected server, and enabling writes in DevLab does not bypass them.

## 11. Use the native API Client

1. Open **API Client** in the native desktop app. In the browser preview this panel remains unavailable because the native socket client is not present.
2. Choose `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD` or `OPTIONS`, enter an `http://` or verified `https://` URL and set a timeout between 10 and 30 seconds.
3. Add request headers as `Name: value` lines. DevLab sets `Host`, `Content-Length`, `Connection`, `Transfer-Encoding`, `Accept-Encoding` and other hop-by-hop framing headers itself; those names are rejected if entered manually. Authorization headers may be sent for a request but are not persisted.
4. Enter a text body for `POST`, `PUT`, `PATCH` or `DELETE`. This checkpoint intentionally does not expose binary upload bodies or multipart helpers.
5. Click **Send**. DevLab opens the socket from Rust, verifies HTTPS certificates with the operating-system trust store, sends a bounded HTTP/1.1 request and displays the real status line, response headers, elapsed time and bounded body.
6. Inspect redirects manually. `3xx` responses are shown as returned by the server; DevLab does not automatically follow `Location` in this checkpoint.

Request bodies are limited to 2 MiB, response headers to 64 KiB and response bodies to 5 MiB. Text/JSON/XML/JavaScript responses are displayed as text, binary responses are summarized without dumping raw binary into the UI, compressed responses are not decompressed because the client requests `Accept-Encoding: identity`, and timeouts or protocol errors are returned as native errors rather than fabricated responses.

## 12. Stage and review multi-file project drafts

1. Select a workspace through **Code Editor**. Project Builder requires the native workspace boundary before it stages draft metadata.
2. Open **Project Builder** and describe the project you want. DevLab asks Gemini for a bounded JSON plan and filters generated file paths to workspace-relative paths.
3. Generate individual files or all proposed files. Generated contents stay in React memory; DevLab does not run setup commands and does not write files automatically.
4. Click **Open reviewed drafts**, or click **Stage for Editor review** on one task batch to stage only that task's generated drafts. Either way Rust validates the staged draft metadata, bounds it to 12 files and 512 KiB of total text metadata, records a metadata-only audit event, then opens the generated files in the existing editor review flow. Per-task staging is recorded in a session-only task staging ledger that holds file path and byte metadata only and is never persisted. After each explicit Editor apply, the Editor reports path, action, byte, line and revision metadata back to a session-only apply ledger so the Builder task cards can show apply progress, flag applied targets whose in-memory draft has changed since apply, and suggest the next dependency-ready task; this metadata is not persisted, does not re-read the workspace, and never claims verification passed. A **Verification handoff** section can call the same read-only native profile discovery used by Self-Healing Tests and match the discovered backend-owned profiles to the targets you have applied; it copies metadata only and links to Self-Healing Tests, where a profile runs only when you click Run there. **Send to Self-Healing Tests** opens that panel with the top matching profile pre-selected and shows a dismissible handoff banner; after you click **Run tests**, the run's status, exit code and elapsed time are reported back to the Builder as a per-task "Last real run" line (stdout/stderr stay in Self-Healing Tests), and any later apply or draft change marks that run as superseded. When a batch's current run failed or timed out, **Open repair for task-NN** returns to Self-Healing Tests in repair mode: the earlier output is not reused, you rerun the profile explicitly, and after a real failing run the batch's applied targets appear as one-click repair-target candidates that only fill the path field; **Draft fix** and Editor reviewed apply remain separate explicit steps.
5. In **Code Editor**, inspect every file. Persist files only with the explicit **Apply reviewed draft** button; existing files still require the revision-checked overwrite confirmation.

Before any generator's drafts are staged, DevLab evaluates each draft path against the reviewed-draft path policy (Settings → Agent): a built-in secret-safe deny list that cannot be switched off, plus optional user deny and allow glob patterns. Refused paths are listed with the reason and dropped; if every path is refused nothing is staged. The policy inspects paths only and never relaxes native Rust checks.

Project Builder staging is not autonomous patch application. Shell commands are displayed for manual review only, file contents are not stored in the native audit log, and the only write path remains the reviewed-draft apply command. The editor compares each generated draft with the selected workspace when possible, shows whether it creates a file, updates a file, or makes no line changes, and keeps each file behind its own explicit Apply click. In desktop mode, Project Builder, Architecture Canvas, Natural-Language Migrations, URL/Screenshot Reverse Engineer, Self-Healing Tests and labeled AI Agent file blocks all route generated drafts through the native agent-tools staging/audit command before this review opens. The AI Agent can also attach up to four bounded existing workspace files as read-only context through the native workspace read command; attached context is kept in process memory and is not written by chat. Each context attachment or refresh records only bounded metadata in the native audit log; file contents are not recorded there. The Agent context browser lists the selected workspace through native scoped directory reads and still attaches only explicit files. The Agent panel can show recent metadata-only audit events for context and draft activity, then filter by activity type, search bounded metadata fields, expand metadata-only event details, explicitly copy visible metadata summaries or inspect/copy AI Agent reviewed-draft manifests and extraction diagnostics before Editor review, then copy metadata-only reviewed-draft summaries from the Editor gate, inspect inline Monaco diffs, navigate Monaco change blocks, mark session-only review annotations, filter and keyboard-navigate the review queue by status, receive prompt-level generation guardrails plus metadata-only starter blueprint/component-style/design-system/quality-checklist guidance for modern UI/component architecture, inspect read-only guidance previews in Settings, explicitly recompare a selected draft before applying, inspect the session applied-draft ledger, view read-only local toolchain detection results, see task-aware model routing/provider-profile metadata without enabling future providers prematurely, attach a bounded metadata-only repository map as Agent context without reading or storing file contents, inspect/filter/copy the attached repo-map metadata in memory, use metadata-only focus hints to choose specific files for content evidence, preview/copy spec metadata, inspect/copy task DAG implementation batches, generate only missing per-task drafts in memory, inspect/copy metadata-only task handoff packets, stage a generated `spec.md` from Project Builder through reviewed Editor apply with acceptance/risk/review-gate metadata, and copy reviewed-draft verification guidance without executing tests automatically.

DevLab also keeps a bounded localStorage recovery snapshot for AI Agent and Project Builder progress. On reopen it asks whether to continue, start a new project, open a workspace, or clear saved progress. This is local to the WebView and may include prompts, model replies and generated draft file contents; it never stores passwords or OS credentials.

## 13. Run native workspace tests

1. Select the workspace you want to test through **Code Editor**.
2. Open **Self-Healing Tests / Native Test Runner**. In Phase 6D this panel runs real tests, can draft a one-file repair for review, applies a reviewed draft only after an explicit user click, and shows a native in-memory audit trail for those actions.
3. Click **Refresh profiles**. Rust re-discovers supported profiles from the selected workspace: package.json test-like scripts, `Cargo.toml`, `go.mod`, pytest config files or a `tests/` directory.
4. Choose a profile and click **Run tests**. React sends only the profile ID. Rust recomputes the available profiles, rejects unknown IDs, and runs the backend-owned command from the selected workspace without a shell.
5. Review the real status, exit code, elapsed time, stdout, stderr, timeout and truncation flags.
6. If the run failed, optionally enter the existing source-file path you want to repair and click **Draft fix**. DevLab reads that one file through the native workspace service, sends bounded excerpts of the real test output plus that file to Gemini, and opens the proposed complete file as an in-memory editor draft.
7. Review the draft manually in **Code Editor**. To persist it, click **Apply reviewed draft** only after approving the full file. Creating a new file uses the scoped native write path; replacing an existing file first reads its current revision and asks for an overwrite confirmation before calling the revision-checked native write.

Each run has a 60-second process timeout and captures at most 2 MiB per output stream. Repair prompts include at most 64 KiB of the selected source file and bounded excerpts of stdout/stderr. Applying a reviewed draft is still a real filesystem write, so DevLab requires an explicit click, relies on native workspace scoping and revision-conflict handling, and records bounded metadata in the native in-memory agent audit log. DevLab sets `CI=1`, `NO_COLOR=1` and `TERM=dumb`, uses the selected workspace as the working directory, and kills the owned process tree on timeout. Project test scripts still execute with the operating-system authority of the user running DevLab, so treat them like terminal commands from that repository.

## 13b. Use a local Ollama model (native only)

1. Install Ollama on the same machine and pull a model, for example `ollama pull llama3.1`.
2. In DevLab, open Settings → Providers and choose **Ollama (local)**. Leave the endpoint empty for `http://127.0.0.1:11434` or enter another loopback origin such as `http://localhost:11434`. Non-loopback hosts, `https://` and paths are refused before any request is made.
3. Click **Detect installed models**. Rust calls `GET /api/tags` on the loopback endpoint and lists what is installed; pick one.
4. Chat, planning, coding, architecture, migration and repair now run on that local model with a 120-second non-streamed bound per reply. No Gemini key is needed and there is no fallback to Gemini. Vision still requires Gemini.

## 13c. Use DeepSeek, OpenAI or Anthropic (native only)

1. In Settings → Providers choose the provider and, if needed, adjust the model id (`deepseek-chat`, `gpt-4.1-mini`, `claude-sonnet-4-5`, …).
2. Paste the provider API key and click **Store in OS credential store**. Rust validates it, writes it to the Windows Credential Manager, macOS Keychain or Linux Secret Service under `io.github.talean414.devlab.ai`, and reports only `stored`/`not stored` back to the interface. The key is never shown again, never logged and never included in error messages, localStorage or recovery snapshots.
3. Generation for chat, planning, coding, architecture, migration and repair now goes through Rust to the provider's fixed HTTPS host (`api.deepseek.com`, `api.openai.com`, `api.anthropic.com`) with a 120-second non-streamed bound per reply. Unauthorized, billing, unknown-model, rate-limit and outage responses are reported honestly and never retried automatically. There is no fallback to Gemini; vision still requires Gemini.
4. **Remove** deletes the key from the credential store.

## 13c′. Use a custom OpenAI-compatible endpoint (native only)

1. In Settings → Providers choose **Custom OpenAI-compatible endpoint** and enter the server's base URL — for example `https://llm.example.com/v1`, `https://gateway.example.com/openai/v1` or `http://localhost:1234/v1` for LM Studio/vLLM on this machine. Rust normalizes it (lower-case host, trailing slash and a pasted `/chat/completions` removed) and applies the host policy: `https://` is mandatory unless the host is literally loopback; embedded credentials, query strings, fragments, path traversal, encoded separators and raw non-loopback IP addresses are refused; self-signed certificates are not trusted.
2. Enter the model id the server expects (the OpenAI `model` field).
3. For remote `https://` servers that need authentication, paste a bearer token and click **Store in OS credential store**. It is written under `io.github.talean414.devlab.ai` / `custom-endpoint/<normalized endpoint>`, so a token stored for one endpoint is never attached to another; changing the URL therefore shows *none stored* until you store one for the new profile. Loopback `http://` servers cannot have a token (Rust refuses clear-text bearer tokens). Tokens are never returned to the interface, logged or included in error messages.
4. Generation for chat, planning, coding, architecture, migration and repair now POSTs to `<base>/chat/completions` through the bounded Rust client (120 s, non-streamed, OpenAI response shape with string or text-part content). HTTP 401/403, 404, 429 and 5xx are reported honestly with `ai_provider_*` codes and never retried; there is no fallback to Gemini and vision still requires Gemini.

## 13c″. Streamed replies (native only)

1. Settings → Providers → *Streaming replies* is on by default. With it on, chat/planning/coding/architecture/migration/repair replies from Ollama, DeepSeek, OpenAI, Anthropic and custom endpoints arrive incrementally; off, each request returns one bounded reply as before. Gemini streams as it always did.
2. Rust sends the adapter's request with its streaming switch (`stream: true`; OpenAI-style bodies also ask for `stream_options.include_usage`), reads the response body line by line (chunked or identity, 256 KiB per line, 16 MiB per stream) and parses Ollama NDJSON, OpenAI SSE or Anthropic SSE. Text deltas are coalesced and delivered through a Tauri channel; the command resolves with a summary (finish reason, token counts, characters, truncation, cancellation).
3. **Stop** in the Agent panel aborts the reply: Rust flips a per-stream cancellation flag and drops the connection at the next line (`Connection: close` is always used). At most 8 streams run at once; stream ids are renderer-chosen opaque tokens validated in Rust.
4. Non-2xx responses are buffered (bounded) and mapped through the same `ai_provider_*`/`ollama_*` error codes as the non-streamed commands; the reply-character cap, prompt bounds, host policies and credential scoping are unchanged.

## 13c‴. Route each task to its own provider

1. Settings → Providers → *Task-aware model router* lists every task class (Chat, Planning, Coding, Architecture, Migration, Repair, Vision). Each row has a provider dropdown that defaults to **Global** (whatever Settings → Providers selects). Choosing a provider pins that task to it; an optional model field overrides the provider's configured/default model for that task only. *Reset all to global* clears every override.
2. Overrides are stored with the rest of your preferences as non-secret metadata (`taskProviders`); no key or token is ever part of them. Each provider keeps its own rules: Gemini needs its WebView key, DeepSeek/OpenAI/Anthropic and custom endpoints need a token in the OS credential store (store it once by selecting that provider globally), Ollama needs the loopback endpoint, and the same host policies, prompt bounds and reply caps apply. A per-task Ollama override under a custom global provider uses the default loopback origin rather than the custom URL.
3. A task pinned to a native adapter is desktop-only: in the web preview it reports "desktop only" and sends nothing, and there is no fallback to Gemini or to the global provider. Vision accepts only Gemini; an override to another provider is ignored with a visible reason because image input is wired through Gemini alone.

## 13c⁗. Attach a Tree-Sitter code outline (native only)

1. In the AI Agent, open the context picker (paperclip). Code files with a compiled-in grammar (`.ts .mts .cts .tsx .js .mjs .cjs .jsx .rs .py .pyi .go`) show an **outline** action in Browse and beside Search hits. Clicking it calls `code_outline_file` for that one path.
2. Rust reads the file through the same scoped workspace boundary as `workspace_read` (no symlinks, UTF-8 only, 512 KiB cap for outlines), parses it with the compiled-in Tree-Sitter grammar under a 2-second deadline, and walks the tree for declarations: functions, methods, classes, interfaces, types, enums, namespaces/modules, structs, traits, impls, constants, variables, properties and macros, nested up to four levels and capped at 400 symbols. Each symbol carries its kind, name, first-line signature (≤160 chars), 1-based line range, depth and an exported/public flag.
3. The outline is rendered as a markdown table and attached as synthetic read-only context (`devlab-outline:<path>`), counted against the same four-item / 48 KiB context budget as files and the repository map. It contains no file body, is memory-scoped, is excluded from recovery snapshots and is not recorded as a file-content audit event. Refresh re-parses the current file; syntax errors and truncation are reported in the note rather than hidden.
4. Grammars are compiled into the binary (`tree-sitter` 0.25 with the official grammar crates); nothing is downloaded at runtime and unsupported extensions return `supported: false` with an explanation. The `code-outline` capability is advertised only inside the desktop app.

## 13c⁗′. Attach a workspace-wide Tree-Sitter code map (native only)

1. In the AI Agent composer, click the **code map** button (network icon, beside the repository-map button). Right-click it to toggle between *exported/public symbols only* (default) and *all top-level symbols*; a violet dot marks the latter.
2. Rust (`code_map_build`) walks the workspace root with the search index's skip rules (ignored directories, secret-bearing names, binary extensions, symlinks, non-UTF-8), parses every file with a compiled-in grammar (`.ts .tsx .js .jsx .rs .py .go` and variants) using the Phase 9H walker, and keeps symbols at depth 0–1 only. Budgets: ≤1,500 files, ≤256 KiB per file, ≤24 MiB parsed, ≤60 symbols per file, ≤6,000 symbols, 8-second deadline; whichever trips first is reported as `truncationReason`. An optional `prefix` narrows the walk to one workspace directory (validated, no traversal or symlinks).
3. Each file also carries its PageRank-derived `importance` (1.0× is an average file), how many mapped files import it and how many it imports, and Rust returns them most-important-first (ties broken by path). The header states the ordering and lists the up-to-ten most depended-on modules. The renderer turns the result into markdown — one heading per file with its importance and in/out degree, one line per symbol (`kind *name — signature (Lstart–end)`) — and emits whole files in that order until the context budget would be exceeded, then reports how many of the least central files were omitted instead of cutting mid-entry. It attaches as synthetic read-only context (`devlab-code-map.md`, source `code-map`) within the same four-item / 48 KiB budget as files, outlines and the repository map; Refresh rebuilds it with the same mode. It is memory-scoped, excluded from recovery snapshots and not recorded as a file-content audit event.
4. Nothing is cached or written; each attach or refresh is a fresh bounded build. File bodies never leave Rust — the map carries names, kinds, first-line signatures, line ranges, import degrees and scores only.

### How the ranking works

The scan is lexical and bounded: only the first 64 KiB of each file is read for import syntax and at most 40 distinct specifiers are kept per file, so ranking adds no second parse pass. Specifiers are then resolved against the mapped files:

- **Rust** — `crate::`, `self::` and `super::` paths (with `mod.rs`/`lib.rs`/`main.rs` module-root rules), `mod name;` declarations, brace groups (`use a::{b, c};`) and `as` aliases. Crate-root paths are tried at the workspace root and under `src/`.
- **TypeScript/JavaScript** — `import … from "…"`, bare `import "…"`, `require("…")`, dynamic `import("…")` and `export … from "…"`. Relative paths resolve next to the importing file; bare and alias specifiers (`@/`, `~/`, scoped `@scope/name`) are tried against common roots (`src/`, `app/`, `lib/`, `packages/`) with extension, `index.*` and directory fallbacks.
- **Python** — `import pkg.sub` and `from pkg.sub import name`, including relative levels (`.`, `..`), with `__init__.py` treated as the package file.
- **Go** — single and grouped `import` blocks; module-prefixed paths are matched by their longest suffix, since the module prefix does not exist inside the repository.

Anything that does not resolve is counted as an external reference (packages, standard library, unaliased paths) and reported, never guessed at. The graph is scored with a damped PageRank (damping 0.85, 12 iterations) over in-repo edges; files with no resolved imports share their mass uniformly as dangling nodes. The score is scaled by the file count, so `importance` is directly comparable between maps ("3.4× an average file"). When the walk hits a budget the response says so, because the graph — and therefore the scores — is then incomplete.

## 13c⁗″. Attach a workspace dependency graph (native only)

1. In the AI Agent composer, click the **dependency graph** button (waypoints icon, beside the code-map button).
2. Rust (`code_graph_build`) walks the workspace with the search index's skip rules (ignored directories, secret-bearing names, binary extensions, symlinks, non-UTF-8) and extracts each supported file's imports with the Phase 9K scanner. There is no symbol parse, so the graph covers up to 2,500 files (≤256 KiB each, ≤32 MiB in total, 8-second deadline) instead of the code map's 1,500; non-code files simply are not part of the graph. An optional `prefix` narrows the walk to one workspace directory (validated, no traversal or symlinks).
3. Every specifier is resolved with the Phase 9K rules (Rust `crate`/`self`/`super` and `mod`, web relative and alias paths, Python dotted modules and relative levels, Go path suffixes). File-level edges are aggregated into directory modules: each module reports its file count, summed importance, internal edges, the modules it depends on (heaviest first, up to eight), the modules that depend on it, and up to six external packages it pulls in. Unresolved specifiers are counted as external references and reported, never guessed at. Modules are ordered by summed importance; at most 120 are returned and the rest are reported as omitted.
4. The renderer turns the result into markdown — one heading per module with its file count and importance, then `→` dependencies, `←` dependents and `ext:` lines — and emits whole modules in order until the context budget would be exceeded, then reports how many of the least central modules were omitted instead of cutting mid-module. It attaches as synthetic read-only context (`devlab-code-graph.md`, source `code-graph`) within the same four-item / 48 KiB budget as files, outlines, the repository map and the code map; Refresh rebuilds it. It is memory-scoped, excluded from recovery snapshots and not recorded as a file-content audit event.
5. Nothing is cached or written. The response is a graph, not a drawing: DevLab never writes a diagram into the repository.

## 13c⁗‴. Attach an architecture summary (native only)

1. In the AI Agent composer, click the **architecture** button (boxes icon, beside the dependency-graph button).
2. The renderer asks Rust for the Phase 9L dependency graph and the exported-only Phase 9I code map in one step, then renders a token-bounded markdown summary:
   - a **Mermaid `flowchart LR`** of up to 24 modules and 60 edges (heaviest first, edge labels are the number of file-level imports);
   - **modules by importance**, each with its file count, what it depends on and what depends on it;
   - the **most depended-on files** from the code map's PageRank top list (exported symbols only);
   - the **external packages** each module pulls in.
3. The summary attaches as synthetic read-only context (`devlab-architecture.md`, source `architecture`) within the same four-item / 48 KiB budget; Refresh rebuilds it. It is memory-scoped, excluded from recovery snapshots and not recorded as a file-content audit event.
4. The diagram is text only. DevLab never writes a diagram, image or cache file into the repository, and no charting library is bundled: if the context budget is too small for the diagram, DevLab drops the whole diagram (never a half block) and says so, keeping the ranked lists. If the code map cannot be built, the graph is summarised on its own.

## 13c⁗⁗. Attach a workspace dependency inventory (native only)

1. In the AI Agent composer, click the **dependencies** button (package icon, beside the architecture button).
2. Rust (`dependency_inventory`) walks the workspace with the search index's skip rules (ignored directories, secret-bearing names, symlinks) and reads the files it recognises: `package.json` with `package-lock.json` or `npm-shrinkwrap.json`, `Cargo.toml` with `Cargo.lock`, `requirements*.txt` and `pyproject.toml`, and `go.mod`. Budgets: ≤200 manifests, ≤1 MiB per file, ≤16 MiB in total, 5-second deadline; whichever trips first is reported as `truncationReason`. An optional `prefix` narrows the walk to one workspace directory (validated, no traversal or symlinks).
3. Every entry carries the package name, its version or specifier, the ecosystem (npm, cargo, pypi, go), the kind (runtime, dev, build, optional, peer, workspace or Go indirect), whether that version is an exact pin, whether the package is declared in a manifest or only locked, and the file that declared it. Manifest entries win over lockfile rows for the same package and version, and direct dependencies are listed first.
4. Packages that resolve to more than one pinned version are reported as conflicts, with the versions and how many files mention them — useful for spotting duplicate major versions before reading any code. Per-ecosystem rollups summarise manifests, lockfiles, direct versus transitive, dev and pinned counts.
5. Offline by design: **no network calls, no advisory database, no licence matching and no remediation** — DevLab never modifies a manifest. This is the read-only metadata half of the roadmap's dependency scanning item; matching packages against advisories would need network access and explicit gating.
6. The inventory attaches as synthetic read-only context (`devlab-dependencies.md`, source `dependency-inventory`) within the same four-item / 48 KiB budget; Refresh rebuilds it. It is memory-scoped, excluded from recovery snapshots and not recorded as a file-content audit event. Nothing is cached or written.

## 13d. Search the workspace for Agent context (native only)

1. In the Agent panel open **Attach**, switch the picker to **Search** and click **Build index**. Rust walks the selected workspace only (no symlinks, no `node_modules`/`.git`/build folders, no binary extensions, no `.env*`/key/certificate files, at most 20 000 files, 512 KiB per file, 64 MiB in total) and loads the UTF-8 text into an in-memory SQLite FTS5 table. Nothing is written to disk and the index is dropped when the workspace is closed or switched.
2. Type words and press Enter. Terms are quoted and prefix-matched (`sear` finds `search`), combined with AND, ranked with bm25 and limited to 50 hits; the only file content returned is a short highlighted snippet per hit, capped per hit and per response.
3. Click a hit to attach it: the file is read through the same bounded, audited `workspace_read` path as the browse mode, so search does not add a new read boundary.
4. Watcher events flag the index as possibly stale; it is never rebuilt automatically — click **Rebuild index** when you want fresh results.

## 13e. Semantic and hybrid search with local embeddings (native only)

1. Pull an embedding model into Ollama (`ollama pull nomic-embed-text`) and, if you use a different one, set it under Settings → Providers → Ollama → *Embedding model*. The endpoint is the same loopback-only origin as chat; the WebView never talks to Ollama itself.
2. After **Build index**, click **Embed with Ollama**. The build already stored up to 6 line-aligned chunks (~1 200 characters, ≤4 KiB each) per file, capped at 2 048 chunks per workspace. Each Rust call embeds at most 4 batches of 16 chunks through `/api/embed`, releases the service lock during the network call, and discards results if the index was rebuilt or cleared meanwhile; the interface repeats calls until complete and you can stop at any time. Vectors are unit-normalized `f32` kept only in process memory (48 MiB budget) and dropped with the index.
3. Pick **Hybrid** (reciprocal-rank fusion of bm25 and cosine, k = 60) or **Semantic** (cosine only, best chunk per file, returning the chunk's line range). Query text is embedded with the same model at search time; if the model or endpoint differs from the one used for the vectors the query is refused with `search_semantic_missing` instead of silently mixing spaces.
4. Hits still attach through the audited `workspace_read` path; the only content that crosses the boundary is the bounded snippet or chunk preview. Partial embedding is reported honestly in the result line ("covers N of M chunks").

Continuous integration: `devlab/ci/github-ci.yml` contains a ready-to-use GitHub Actions workflow (renderer `npm run check` plus native `cargo check`, `cargo test --lib` and `cargo clippy -D warnings` on a Linux Tauri toolchain). Copy it to `.github/workflows/ci.yml` from an account that has the `workflows` permission to enable it.

## 14. Verify the complete build

Run both frontend and native checks before packaging:

```bash
npm run check
npm run native:check
npm run native:test
```

The first command type-checks React and creates `devlab/dist/`; the second compiles the Rust backend; the third exercises native path-boundary, revision, terminal-dimension, bounded-output, Git parser/path validation, Docker validation, SQLite access-mode/confirmation rules, SQL restrictions and result truncation, plus PostgreSQL connection-field, credential-identity, schema-size, UTF-8 truncation, read-statement and restricted-function validation, the write guard, native HTTP URL/header/method/request-framing/chunked-body/binary-display validation, and test-runner profile discovery/output sanitization rules. The reviewed repair-draft flow is covered by the frontend build and must also be smoke-tested with a real failing test because it depends on a Gemini key.

Build the native application and this operating system's installer formats:

```bash
npm run desktop:build
```

For an interface-only production preview, run `npm run preview -- --host 0.0.0.0`. Native capabilities intentionally remain unavailable in that browser preview.

## 14. Deploy the optional web preview

DevLab is a static frontend. It does not need a Node server after the build finishes.

### Vercel

Import `Talean414/devlab` and use:

| Setting | Value |
|---|---|
| Root directory | `devlab` |
| Framework | Vite |
| Install command | `npm ci` |
| Build command | `npm run build` |
| Output directory | `dist` |

No Gemini environment variable should be configured for the BYOK web build.

### Netlify

Import the repository and use:

| Setting | Value |
|---|---|
| Base directory | `devlab` |
| Build command | `npm run build` |
| Publish directory | `dist` |

The publish directory is relative to the configured base directory.

### Any static host

Run `npm run build`, then upload the contents of `devlab/dist/` to the host's public directory. Serve it over HTTPS so browser APIs and calls to Gemini work reliably.

## Gemini quota and `429` errors

Google applies rate limits per Cloud project across requests per minute, input tokens per minute, and requests per day. Creating another key in the **same project** does not create another quota pool.

DevLab now handles these cases as follows:

- **Short temporary throttle:** waits for Google's retry delay and retries once.
- **Model-specific throttle:** tries up to three available fallback models.
- **Daily quota exhausted:** cools down that model until midnight Pacific time.
- **Quota limit is `0`:** avoids repeated retries and asks the user to choose a model that has free quota for that project.
- **Partial streamed response fails:** does not restart the generation and duplicate the answer.

If a `429` still appears:

1. Open [Google AI Studio usage and rate limits](https://ai.dev/rate-limit).
2. In DevLab, open **Settings → Providers** and select a stable Flash-Lite model.
3. If the message reports a short retry duration, wait for that duration.
4. If the daily allowance is exhausted, wait until midnight Pacific time.
5. If Google reports a limit of `0`, confirm that the selected model has free quota on that project. Retrying cannot fix a zero allocation.

No client-side implementation can provide unlimited cloud inference after the provider's quota is exhausted. DevLab's retry and fallback logic improves availability, but it cannot bypass Google's project limits.

## First-run acceptance checklist

Use this list before calling an installation complete:

- [ ] `node --version` satisfies the required range
- [ ] `npm ci` finishes successfully
- [ ] `rustc --version` and `cargo --version` work
- [ ] `npm run check` passes
- [ ] `npm run native:check` passes
- [ ] `npm run native:test` passes
- [ ] `npm run desktop:dev` opens a desktop window
- [ ] The header reports **Native**, not **Web preview**
- [ ] Code Editor opens a folder only after the native picker is confirmed
- [ ] A real UTF-8 file can be opened, changed and saved with `Ctrl/Cmd+S`
- [ ] An external file change produces a **Changed on disk** warning
- [ ] Parent traversal, symlinks, binary files and files over 2 MiB are rejected
- [ ] Native Terminal requires a selected workspace and explicit start action
- [ ] `pwd`/`cd`, interactive input, ANSI colors and full-screen terminal programs work
- [ ] Terminal resizing works and a long-running process can be terminated
- [ ] `exit 7` on Unix or `exit /b 7` on Windows is reported as the real exit code, and terminal tabs restore bounded history
- [ ] Source Control reports the selected repository's real branch, status, history, branches and remotes
- [ ] A real path can be staged and unstaged, its diff is displayed, and a commit returns Git's actual result
- [ ] Selecting a repository subdirectory is rejected until the canonical repository root is selected
- [ ] Fetch, fast-forward Pull and Push require confirmation and report actual network/authentication failures
- [ ] Saving a Git token exposes only configured metadata, survives restart in the OS credential store, and can be deleted
- [ ] Containers reports the actual Docker CLI/engine versions, containers, images and current one-shot statistics
- [ ] Pulling an exact disposable image reference adds the real local image or reports the registry's genuine error
- [ ] Creating a named container leaves it stopped, publishes requested ports only on `127.0.0.1`, and rejects invalid or duplicate fields
- [ ] Container logs contain real output, and starting a stopped test container updates its actual Docker state
- [ ] Stop/restart/removal require confirmation, removal refuses running containers, and daemon permission failures are reported honestly
- [ ] Database rejects files outside the selected workspace and opens a real SQLite file read-only by default
- [ ] Database schema, `SELECT` values, NULLs and BLOB sizes come from the actual file and large results report truncation
- [ ] A write fails in read-only mode; after enabling writes it requires confirmation and changes the real database
- [ ] `ATTACH`, configuration PRAGMAs, explicit transactions and virtual-table creation are rejected at the native boundary
- [ ] PostgreSQL connects to a real server and reports its actual version or the genuine DNS, network, authentication or TLS error
- [ ] PostgreSQL schema inspection shows genuine user schemas, tables/views, columns, types and primary keys; refresh reflects an external DDL change
- [ ] A PostgreSQL `SELECT` returns real values/types while NULLs, binary values and large output are represented or truncated honestly
- [ ] A PostgreSQL `INSERT` fails while writes are disabled, requires confirmation once they are enabled, then reports the real affected-row count and refreshes the schema
- [ ] `INSERT`, `UPDATE` and `DELETE` with `RETURNING` show real bounded rows; `CREATE TABLE`, `TRUNCATE`, `DROP`, `CALL` and `REFRESH` run once confirmed
- [ ] `RETURNING` output honours the 16,384-character cell, 1,000-row, BYTEA size-label and 2 MiB encoded bounds and reports truncation honestly
- [ ] PostgreSQL still rejects parameters, stacked statements, `set_config`, filesystem functions and advisory locks at the native boundary
- [ ] **Disable writes** returns the session to enforced read-only mode and a later write requires confirmation again
- [ ] A `CALL` or `MERGE` that returns a result set is refused with `postgres_result_set_unbounded` before it runs, while one without a result set executes normally
- [ ] A long PostgreSQL read times out and generated results stop at the documented row/encoded-output bounds
- [ ] Verified TLS rejects an untrusted or hostname-mismatched certificate; disabling TLS shows an explicit plaintext warning
- [ ] A PostgreSQL password is transient by default, can be stored only by explicit choice, can be reused after restart and can be removed with **Forget password**
- [ ] Gemini key test says **Key valid**
- [ ] AI Agent streams a response
- [ ] API Client sends a real native HTTP request, reports status/headers/body/time honestly, rejects unsupported schemes and hop-by-hop headers, and marks large bodies as truncated
- [ ] Native Test Runner discovers a real workspace test profile, runs it with bounded output, reports pass/fail/timeout honestly, and rejects unknown profile IDs
- [ ] A failed native test run can generate a reviewed one-file repair draft from a selected existing source file; the draft opens in editor review and nothing is written before approval
- [ ] Applying a reviewed draft requires an explicit click, creates new files only through the scoped native write path, and overwrites existing files only after confirmation plus a revision check
- [ ] Deployment panel explicitly says **Simulation removed**; Database clearly marks a read-only PostgreSQL session and shows the write state of every connection
- [ ] `npm run desktop:build` creates the platform bundle

## Common problems

### `vite: not found`

Dependencies were not installed, or the command was run from the wrong directory:

```bash
cd devlab/devlab
npm ci
npm run dev
```

### Unsupported Node.js version

Install or select Node.js 22:

```bash
nvm install 22
nvm use 22
```

### Blank page after deployment

Check the host's build log and verify that the root/base directory is `devlab`, the build command is `npm run build`, and the published output is `dist`.

### Key test fails

- Copy a newly created key from Google AI Studio.
- Make sure the key has no leading or trailing spaces.
- Confirm the Generative Language/Gemini API is available to the selected project.
- Disable privacy extensions temporarily if they block `generativelanguage.googleapis.com`.
- Check the browser developer console for a network or CORS error.

### AI Agent says there is no key after saving

Use the same browser profile and origin where the key was saved. Browser `localStorage` is separate between `localhost`, preview domains, production domains, normal windows, and private/incognito windows.

### Generated source is not written to the workspace

Canvas, migration and vision tools produce source previews but do not automatically write AI output into the selected workspace. Open the native editor and explicitly create or update files after reviewing the generated source. A reviewed multi-file import flow will be added separately.

### PostgreSQL connection fails

Verify the host, port, database, username and server reachability with a trusted PostgreSQL client. **Verify certificate and hostname** requires a certificate chain trusted by the operating system and a hostname match; local development servers commonly need a trusted development certificate or an explicit **Disable TLS** choice. DevLab never retries verified TLS as plaintext. If password storage fails on Linux, unlock the desktop Secret Service or turn off storage and use a transient password.

### PostgreSQL schema inspection fails

The connected role must be able to read PostgreSQL's normal catalog metadata. DevLab's fixed query has a five-second server timeout and hard limits of 2,000 objects, 20,000 columns and approximately 2 MiB encoded output. A timeout, permission denial or limit error is returned honestly instead of showing a partial fabricated schema.

### PostgreSQL query is rejected or times out

This checkpoint accepts one parameter-free `SELECT`, `WITH`, `VALUES`, `TABLE`, `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `CREATE`, `ALTER`, `DROP`, `TRUNCATE`, `CALL` or `REFRESH` statement. It rejects other classes, stacked statements, configuration and filesystem helpers, advisory locks, backend-control functions, large-object import/export and `dblink`. Every statement first runs in an explicit read-only transaction with a five-second total/server timeout and bounded values/output, so a mutation is refused by the server before it changes anything. `postgres_write_disabled` means writes are off for that session, `postgres_write_confirmation_required` means the statement still needs its own confirmation, and `postgres_result_set_unbounded` means a `CALL` or `MERGE` returns rows that PostgreSQL gives DevLab no way to bound. Split work into individual statements.

### API client or test runner is unavailable

The API Client is available only in the native desktop app after the Rust runtime advertises `native-http`; the browser preview cannot open native sockets and does not fall back to browser `fetch`. The Native Test Runner similarly requires the desktop app, a selected workspace, and the `test-runner` runtime capability. If no profile appears, confirm the workspace has a package.json test script, Cargo.toml, go.mod, pytest config file, or tests/ directory. Repair drafts additionally require a Gemini key and an existing source-file path inside the selected workspace.

### Containers says Docker is unavailable

Run `docker version` in a normal terminal. If the CLI is missing, install Docker Engine or Docker Desktop. If only the server section fails, start the daemon or Docker Desktop and make sure your account can access the active Docker context. On Linux, adding a user to the `docker` group grants powerful daemon access and should be treated as a security decision—not an automatic DevLab setup step.

### Pull image reports access denied or manifest unknown

DevLab uses the current Docker CLI context and registry credentials without collecting registry passwords itself. Confirm the reference and tag with `docker image pull IMAGE`, and use `docker login` in a trusted terminal when a private registry requires authentication. DevLab returns the registry or daemon error rather than creating a placeholder image.

### SQLite file is rejected or writes fail

Select the canonical workspace containing the database before opening **Database**. The selected item must be an existing regular file—not a symbolic link—and must remain inside that workspace after canonicalization. For writes, both the database file and its parent directory need appropriate operating-system permissions because SQLite can create journal or WAL files. DevLab never changes filesystem permissions automatically.

### SQLite query is restricted or times out

DevLab accepts one statement and stops it after five seconds. `ATTACH`, `DETACH`, configuration PRAGMAs, explicit transaction control, temporary or virtual-table DDL, and filesystem-capable functions are deliberately unavailable. Split normal SQL work into individual statements; use a trusted terminal or dedicated database administration tool for operations outside this policy.

### Source Control says the repository root does not match

DevLab will not let Git escape the selected workspace. If you selected a folder inside a larger repository, reopen **Code Editor** and select the repository's top-level folder—the path printed by `git rev-parse --show-toplevel`.

### Git credentials are unavailable on Linux

The desktop session must provide an unlocked Secret Service (for example GNOME Keyring or KDE Wallet). The credential backend can fall back to the user's kernel keyring where supported, but availability depends on the Linux desktop session. DevLab reports keyring access errors and never falls back to plaintext files or localStorage.

### Native Terminal says a workspace is required

Open **Code Editor**, choose **Select workspace folder**, and then return to **Terminal**. The selected canonical folder is kept in Rust process memory and becomes the shell’s initial working directory. Selecting a starting folder does not sandbox shell commands; they retain your operating-system account’s normal permissions.

## Available scripts

| Command | Purpose |
|---|---|
| `npm run desktop:dev` | Start Vite and open the native Tauri development app |
| `npm run desktop:build` | Build the native app and platform bundles |
| `npm run native:check` | Compile-check the Rust backend |
| `npm run native:test` | Run native workspace boundary tests |
| `npm run dev` | Start the interface-only browser preview |
| `npm run typecheck` | Run TypeScript validation without emitting files |
| `npm run build` | Create the optimized frontend assets |
| `npm run check` | Type-check and build the frontend |
| `npm run preview` | Preview frontend production assets in a browser |

## Project structure

```text
devlab/
├── index.html
├── package.json
├── vite.config.ts
├── src-tauri/
│   ├── Cargo.toml
│   ├── capabilities/       # default-deny native permission manifests
│   ├── icons/              # generated desktop application icons
│   ├── src/                # trusted Rust core, workspace, PTY, Git, credentials, Docker, SQLite and PostgreSQL
│   └── tauri.conf.json
└── src/
    ├── App.tsx
    ├── components/
    ├── data/
    ├── lib/
    │   ├── gemini.ts       # BYOK Gemini client, retry, quota, fallback
    │   ├── native.ts       # typed native runtime bridge
    │   ├── terminal.ts     # typed PTY lifecycle and event IPC client
    │   ├── git.ts          # typed repository, operation and credential IPC client
    │   ├── docker.ts       # typed Docker state, pull, creation, logs and lifecycle IPC client
    │   ├── database.ts     # typed SQLite and PostgreSQL connectivity/schema/read IPC client
    │   ├── http.ts         # typed native HTTP IPC client
    │   ├── testRunner.ts   # typed native test-runner IPC client
    │   ├── workspace.ts    # typed scoped-filesystem IPC client
    │   ├── settings.ts     # application settings
    │   └── sync.ts         # collaboration helpers
    └── panels/             # DevLab feature panels
```

## Security notes

- Never commit API keys or tokens.
- Never use one shared Gemini key in a public frontend.
- Keep the Tauri capability manifest default-deny and allow each custom command explicitly.
- Do not expose arbitrary process-spawn or filesystem primitives directly to the renderer; PTY operations must target Rust-owned session IDs.
- Treat every terminal session as full user-level shell access: require an explicit start action and never imply that its commands are workspace-sandboxed.
- Bound terminal input, retained output, dimensions and concurrent session counts; terminate owned processes on close.
- Validate and canonicalize every filesystem path against the user-selected workspace.
- Reject traversal and symbolic links at the native boundary; never rely on renderer validation.
- Require revision matches before overwriting an existing file.
- Rotate a key immediately if it is pasted into source code, an issue, a commit, or a public chat.
- Keep Git provider tokens in the OS credential store; expose only presence/backend metadata to the renderer and redact command failures.
- Scope Git operations to a canonical repository root that exactly matches the selected workspace; use fixed argument arrays, output limits and timeouts instead of a shell.
- Require explicit confirmation for every Git network operation; do not expose force push, merge or rebase through this panel.
- Treat Docker daemon access as privileged: validate full IDs, image references, names and ports; use fixed commands and timeouts; bind created ports to loopback; confirm disruptive actions; and never imply workload sandboxing.
- Open SQLite files only through the native picker after canonical workspace authorization; default to read-only, classify statements in SQLite itself, confirm every write, and bound query time and output.
- Deny SQLite database attachment, connection-changing PRAGMAs, explicit transactions, temporary/virtual-table DDL and filesystem-capable functions so SQL cannot escape the selected database policy.
- Require structured PostgreSQL connection fields, explicit TLS policy and bounded connection attempts; verify certificates and hostnames by default and never silently downgrade to plaintext.
- Inspect PostgreSQL metadata only through a fixed Rust-owned catalog query with server timeouts and object, column, value and encoded-response bounds; do not accept renderer SQL through the schema command.
- Prepare exactly one PostgreSQL read statement, reject parameters and non-read classes, run it in an explicit read-only transaction, deny known server-filesystem/configuration/locking helpers, and bound time plus streamed output. Treat the database role as the authority boundary for user-defined functions and foreign tables.
- Keep PostgreSQL passwords transient unless the user explicitly chooses the OS credential store; never return stored passwords to the renderer, and provide an explicit removal action.
- Run API Client requests through the bounded native HTTP command only: accept structured fields, reject non-HTTP schemes and hop-by-hop framing headers, verify HTTPS by default, keep request data transient, and bound time, headers and bodies.
- Run tests only through backend-discovered profiles, never renderer-supplied shell text; use fixed argv arrays, workspace scoping, process timeouts, output caps and process-tree termination.
- Keep repair drafts review-first: base them on real native test output, read one existing workspace file through the native boundary, bound prompt/source size, open the generated file as an in-memory editor draft, and apply it only after explicit user approval through scoped native writes with revision checks.
- Remember that the current Gemini key is still renderer-managed and separate from Rust-owned Git credentials.
- Review generated commands and code before executing or deploying them.
