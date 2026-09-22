# DevLab

DevLab is a native developer control plane built with **Tauri 2, Rust, React, TypeScript, Vite, Tailwind CSS, and Monaco Editor**. Its AI tools use a **bring-your-own-key (BYOK)** connection to Google Gemini, so DevLab itself does not require a paid subscription.

> **Start here:** the DevLab application is in [`devlab/`](./devlab). The repository's `medbook-queue/` directory is a separate sample project and is not required to run DevLab.

## Native migration status

Phases 1 through 4, Docker, SQLite, PostgreSQL, native HTTP, and the first Phase 6 test/repair slices are implemented: DevLab has a Tauri desktop shell, typed Rust-to-React IPC, restricted capabilities, a real scoped workspace service connected to Monaco, a cross-platform PTY terminal connected to xterm.js, native source control, bounded access to a real Docker CLI and engine, workspace-scoped SQLite connections, real PostgreSQL sessions with explicit TLS policy, a native API client, backend-owned test execution profiles, reviewed repair drafts, explicit native application of approved drafts, a bounded native audit trail for test/repair actions, permission-gated multi-file draft staging, bounded reviewed-draft diff inspection, unified native staging for generated drafts, AI Agent reviewed-draft extraction, bounded read-only workspace context for the Agent, audited context metadata, explicit context refresh, a native Agent context browser, Agent-panel audit activity visibility, Agent audit filtering/search, expandable Agent audit metadata details, shared audit rendering, and copyable metadata summaries.

A workspace can be granted only through the native folder picker. The Rust backend holds its canonical root in memory, rejects absolute paths and parent traversal, blocks symlink access, limits text I/O, watches native filesystem changes, and uses content revisions to prevent silent overwrites.

A terminal starts only after an explicit click and launches the operating system’s real default shell in the selected workspace. Rust streams raw PTY bytes, validates session IDs, bounds retained history, handles resize and termination, and reports the real process exit status. Shell commands are intentionally not confined to the workspace and have the same authority as the user running DevLab.

Source Control discovers only a repository whose canonical root exactly matches the selected workspace. Fixed Rust commands read real porcelain status, diffs, history, branches and remotes; stage and unstage paths; create commits; and run confirmed fetch, fast-forward pull and non-force push operations with time and output limits. Git hooks and fsmonitor helpers are disabled for DevLab-owned commands. GitHub, GitLab and Bitbucket tokens are stored by the operating system credential store and are never returned to the renderer.

Containers detects the real Docker CLI and daemon, then reads actual containers, one-shot resource statistics, images and bounded logs. It can pull a validated image reference and create a stopped container with a validated name and optional loopback-only port mappings. Start, stop, restart and non-force removal use validated full container IDs; disruptive actions require confirmation. Arbitrary Docker arguments, custom container commands, environment values, host mounts, privileged mode, builds, image/volume deletion and Compose deployment are not exposed by this step.

Database opens an existing SQLite file only through the native picker and only when its canonical path remains inside the selected workspace. The bundled Rust-owned SQLite engine exposes the real user schema and one statement at a time with a five-second timeout, 1,000 displayed rows, 200 columns, bounded cells and a 2 MiB encoded-result budget. Connections default to operating-system-enforced read-only mode. Users can explicitly enable writes per in-memory connection, but every mutating statement still requires separate confirmation. Database attachment, configuration PRAGMAs, explicit transactions, temporary/virtual-table DDL and filesystem-capable SQL functions are blocked.

PostgreSQL connectivity, schema inspection, bounded reads and separately confirmed writes are now native: DevLab opens a real process-memory session with a five-second per-address connection timeout, an explicit `verify-full` or `disable` TLS policy, server-enforced session timeouts, read-only-by-default configuration, and optional password storage in the operating-system credential store. A fixed Rust-owned catalog query returns genuine schema metadata. Every statement runs as exactly one parameter-free statement, and the server rather than a string parser classifies it: DevLab first attempts the statement inside a read-only transaction, where PostgreSQL rejects any mutation with SQLSTATE 25006 before it can change data. Reads return directly from that transaction, so a read is never executed twice. A mutation re-runs in a bounded write transaction only when writes are enabled for that in-memory session and the user confirms that exact statement. Accepted classes are `SELECT`, `WITH`, `VALUES`, `TABLE`, `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `CREATE`, `ALTER`, `DROP`, `TRUNCATE`, `CALL` and `REFRESH`; `CALL` and `MERGE` are accepted when they do not return a result set. Writes can be turned off again at any time, which sends `SET default_transaction_read_only = on` for the session. Time, row, column, cell and encoded-output bounds apply to reads and to `RETURNING` results alike, while statements without a result set report the server's real affected-row count. Identifiers, bound parameters and stacked statements remain rejected. Two statement classes are refused before they run when they would return a result set: PostgreSQL allows neither `CALL` nor `MERGE` inside a `FROM` sub-query or a `WITH` body, so DevLab has no way to apply its server-side cell bounds to their rows, and reports `postgres_result_set_unbounded` instead of running them with weaker bounds. Both work normally when they return no result set, which is the usual case. No sample server, schema or result is substituted. Native HTTP is also implemented: the API Client sends real `http://` and verified `https://` HTTP/1.1 requests from Rust instead of browser `fetch`, so browser CORS does not apply. The client accepts structured method, URL, header, body and timeout fields; rejects non-HTTP schemes, embedded URL credentials, raw spaces/control characters, hop-by-hop framing headers and unsupported methods; forces `Connection: close` and `Accept-Encoding: identity`; and bounds custom headers to 32 KiB, response headers to 64 KiB, request bodies to 2 MiB and response bodies to 5 MiB. Redirects are reported honestly with their status and `Location` header and are not followed automatically in this checkpoint. Native test execution is also implemented as the first Phase 6 slice: Rust discovers package.json test scripts, Cargo, Go and pytest profiles from the selected workspace, exposes only those backend-owned profile IDs to React, runs the chosen command without a shell, captures bounded output, and kills the process after 60 seconds. Phase 6B adds a reviewed repair-draft loop on top: after a real failing test run, the user chooses one existing workspace file, React reads it through the native workspace boundary, Gemini receives bounded test-output excerpts plus that file, and DevLab opens the complete patched file as an in-memory editor draft. Phase 6C adds an explicit reviewed-draft application button in the editor: new files are created only after the user clicks Apply, existing files are read first and overwritten only after a second confirmation with the native revision check. Phase 6D adds a bounded native in-memory audit trail for test runs and reviewed-draft writes; file contents and captured output are not stored in that log. Phase 6E enables the Project Builder as a permission-gated multi-file draft staging tool: generated files remain in memory, Rust validates bounded draft metadata before editor review, and writes still require the existing explicit reviewed-draft apply path. Phase 6F adds bounded reviewed-draft diff inspection in the editor before each explicit per-file apply click. Phase 6G routes generated drafts from Project Builder, Architecture Canvas, migrations, reverse engineering and self-healing repairs through the same native agent-tools staging/audit gate before editor review. Phase 6H lets the AI Agent surface explicitly labeled complete file blocks as reviewed drafts through that same staging path. Phase 6I lets the AI Agent attach bounded existing workspace files as read-only context through the native workspace read path; this context is memory-scoped and not included in localStorage recovery. Phase 6J records bounded metadata for those read-only context attachments in the native audit log without storing file contents. Phase 6K adds an explicit refresh action so attached context can be re-read through the native workspace boundary, re-bounded, re-audited and updated to latest revisions before the next prompt. Phase 6L replaces manual Agent context paths with a native workspace browser backed by bounded `workspace_list` and `workspace_read` calls. Phase 6M surfaces recent metadata-only Agent audit activity inside the Agent panel. Phase 6N adds Agent-side audit filtering and metadata search for context, draft staging and reviewed-write records. Phase 6O adds expandable metadata-only event details for those Agent audit records. Phase 6P batches the audit polish: shared metadata-only audit rendering across Agent and Self-Healing surfaces, refresh/count status and explicit copy of visible metadata summaries. Deployment, CI, toolchain and autonomous patch application remain disabled. The normal Vite server remains available strictly as a UI preview.

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
- Permission-gated multi-file draft staging for Project Builder, with no automatic workspace writes
- Project template and command references
- BroadcastChannel/WebRTC collaboration primitives
- Embedded web preview
- WebView-local non-secret preferences; the Gemini BYOK key remains in its existing renderer flow
- Optional local session recovery prompt for Agent and Project Builder progress, stored in WebView localStorage until continued or cleared

Phase 5 is complete through Docker, SQLite, PostgreSQL and native HTTP. Phase 6 now includes bounded native test execution, reviewed one-file repair drafts, explicit approved-draft application, native audit metadata, permission-gated multi-file draft staging, reviewed-draft diff inspection, unified generated-draft staging, AI Agent reviewed-draft extraction, read-only workspace context, audited context metadata, explicit context refresh, a native Agent context browser, Agent-panel audit activity, Agent audit filtering/search, expandable audit metadata details, shared audit rendering and copyable metadata summaries; broader agent patch tools and signed distribution follow afterward. Until a backend exists, DevLab reports that the feature is unavailable instead of fabricating data or success.

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
4. Click **Open reviewed drafts**. Rust validates the staged draft metadata, bounds it to 12 files and 512 KiB of total text metadata, records a metadata-only audit event, then opens the generated files in the existing editor review flow.
5. In **Code Editor**, inspect every file. Persist files only with the explicit **Apply reviewed draft** button; existing files still require the revision-checked overwrite confirmation.

Project Builder staging is not autonomous patch application. Shell commands are displayed for manual review only, file contents are not stored in the native audit log, and the only write path remains the reviewed-draft apply command. The editor compares each generated draft with the selected workspace when possible, shows whether it creates a file, updates a file, or makes no line changes, and keeps each file behind its own explicit Apply click. In desktop mode, Project Builder, Architecture Canvas, Natural-Language Migrations, URL/Screenshot Reverse Engineer, Self-Healing Tests and labeled AI Agent file blocks all route generated drafts through the native agent-tools staging/audit command before this review opens. The AI Agent can also attach up to four bounded existing workspace files as read-only context through the native workspace read command; attached context is kept in process memory and is not written by chat. Each context attachment or refresh records only bounded metadata in the native audit log; file contents are not recorded there. The Agent context browser lists the selected workspace through native scoped directory reads and still attaches only explicit files. The Agent panel can show recent metadata-only audit events for context and draft activity, then filter by activity type, search bounded metadata fields, expand metadata-only event details or explicitly copy visible metadata summaries.

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
