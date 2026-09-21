# DevLab

DevLab is a native developer control plane built with **Tauri 2, Rust, React, TypeScript, Vite, Tailwind CSS, and Monaco Editor**. Its AI tools use a **bring-your-own-key (BYOK)** connection to Google Gemini, so DevLab itself does not require a paid subscription.

> **Start here:** the DevLab application is in [`devlab/`](./devlab). The repository's `medbook-queue/` directory is a separate sample project and is not required to run DevLab.

## Native migration status

Phases 1 through 4, Docker, SQLite, and the PostgreSQL connectivity checkpoint of Phase 5 are implemented: DevLab has a Tauri desktop shell, typed Rust-to-React IPC, restricted capabilities, a real scoped workspace service connected to Monaco, a cross-platform PTY terminal connected to xterm.js, native source control, bounded access to a real Docker CLI and engine, workspace-scoped SQLite connections, and real PostgreSQL sessions with explicit TLS policy.

A workspace can be granted only through the native folder picker. The Rust backend holds its canonical root in memory, rejects absolute paths and parent traversal, blocks symlink access, limits text I/O, watches native filesystem changes, and uses content revisions to prevent silent overwrites.

A terminal starts only after an explicit click and launches the operating system’s real default shell in the selected workspace. Rust streams raw PTY bytes, validates session IDs, bounds retained history, handles resize and termination, and reports the real process exit status. Shell commands are intentionally not confined to the workspace and have the same authority as the user running DevLab.

Source Control discovers only a repository whose canonical root exactly matches the selected workspace. Fixed Rust commands read real porcelain status, diffs, history, branches and remotes; stage and unstage paths; create commits; and run confirmed fetch, fast-forward pull and non-force push operations with time and output limits. Git hooks and fsmonitor helpers are disabled for DevLab-owned commands. GitHub, GitLab and Bitbucket tokens are stored by the operating system credential store and are never returned to the renderer.

Containers detects the real Docker CLI and daemon, then reads actual containers, one-shot resource statistics, images and bounded logs. It can pull a validated image reference and create a stopped container with a validated name and optional loopback-only port mappings. Start, stop, restart and non-force removal use validated full container IDs; disruptive actions require confirmation. Arbitrary Docker arguments, custom container commands, environment values, host mounts, privileged mode, builds, image/volume deletion and Compose deployment are not exposed by this step.

Database opens an existing SQLite file only through the native picker and only when its canonical path remains inside the selected workspace. The bundled Rust-owned SQLite engine exposes the real user schema and one statement at a time with a five-second timeout, 1,000 displayed rows, 200 columns, bounded cells and a 2 MiB encoded-result budget. Connections default to operating-system-enforced read-only mode. Users can explicitly enable writes per in-memory connection, but every mutating statement still requires separate confirmation. Database attachment, configuration PRAGMAs, explicit transactions, temporary/virtual-table DDL and filesystem-capable SQL functions are blocked.

PostgreSQL connectivity is now native: DevLab opens a real process-memory session with a five-second per-address connection timeout, an explicit `verify-full` or `disable` TLS policy, server-enforced session timeouts, read-only-by-default configuration, and optional password storage in the operating-system credential store. PostgreSQL schema browsing and SQL execution remain explicitly disabled until their bounded backend increment is complete; no sample server or result is substituted. Deployment, CI, toolchain, API-client and test-runner results also remain disabled. The normal Vite server remains available strictly as a UI preview.

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
- Real PostgreSQL connectivity with verified TLS by default, explicit plaintext opt-in and optional OS-protected passwords
- Project template and command references
- BroadcastChannel/WebRTC collaboration primitives
- Embedded web preview
- WebView-local non-secret preferences; the Gemini BYOK key remains in its existing renderer flow

The remaining Phase 5 backends are bounded PostgreSQL schema/query execution and native HTTP. Agent tool execution and signed distribution follow afterward. Until a backend exists, DevLab reports that the feature is unavailable instead of fabricating data or success.

## Requirements

Install these before starting:

1. [Git](https://git-scm.com/downloads)
2. [Node.js](https://nodejs.org/) `20.19+` or `22.12+`
3. npm, which is included with Node.js
4. The current stable [Rust toolchain](https://www.rust-lang.org/tools/install)
5. Your operating system's [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)
6. [Docker Engine or Docker Desktop](https://docs.docker.com/get-docker/) for the optional Containers panel
7. Access to a PostgreSQL server for the optional server-database connectivity checkpoint
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
6. Use **Forget password** to remove a saved credential while keeping the live session open, and **Disconnect** to close the native session. Disconnecting does not silently delete a credential the user chose to store.

This is deliberately a connectivity checkpoint. The connection is real and already configures server-side statement, lock and idle-transaction timeouts, but PostgreSQL schema browsing and SQL execution remain disabled until the next increment adds bounded streaming output, per-operation read-only transactions and separate confirmation for every write. DevLab does not fabricate tables or query results while those operations are unavailable.

## 11. Verify the complete build

Run both frontend and native checks before packaging:

```bash
npm run check
npm run native:check
npm run native:test
```

The first command type-checks React and creates `devlab/dist/`; the second compiles the Rust backend; the third exercises native path-boundary, revision, terminal-dimension, bounded-output, Git parser/path validation, Docker validation, SQLite access-mode/confirmation rules, SQL restrictions and result truncation, plus PostgreSQL connection-field and credential-identity validation.

Build the native application and this operating system's installer formats:

```bash
npm run desktop:build
```

For an interface-only production preview, run `npm run preview -- --host 0.0.0.0`. Native capabilities intentionally remain unavailable in that browser preview.

## 12. Deploy the optional web preview

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
- [ ] Verified TLS rejects an untrusted or hostname-mismatched certificate; disabling TLS shows an explicit plaintext warning
- [ ] A PostgreSQL password is transient by default, can be stored only by explicit choice, can be reused after restart and can be removed with **Forget password**
- [ ] Gemini key test says **Key valid**
- [ ] AI Agent streams a response
- [ ] API-client, deployment and test-runner panels explicitly say **Simulation removed**; Database clearly marks PostgreSQL schema/query execution as unavailable after establishing a real session
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

### PostgreSQL schema or query execution is unavailable

This is intentional during the connectivity checkpoint—not an installation failure. The live session and reported server version are real, but schema and SQL controls stay disabled until bounded output, transactional read-only enforcement and per-write confirmation are implemented. DevLab never substitutes sample tables or successful query results.

### API client or test runner says “Simulation removed”

This is intentional—not an installation failure. The previous fabricated results remain disabled until each real backend is implemented and tested. Native HTTP is the remaining Phase 5 backend after PostgreSQL schema/query execution.

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
    │   ├── database.ts     # typed SQLite operations and PostgreSQL connectivity IPC client
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
- Keep PostgreSQL passwords transient unless the user explicitly chooses the OS credential store; never return stored passwords to the renderer, and provide an explicit removal action.
- Remember that the current Gemini key is still renderer-managed and separate from Rust-owned Git credentials.
- Review generated commands and code before executing or deploying them.
