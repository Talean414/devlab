# DevLab

DevLab is a native developer control plane built with **Tauri 2, Rust, React, TypeScript, Vite, Tailwind CSS, and Monaco Editor**. Its AI tools use a **bring-your-own-key (BYOK)** connection to Google Gemini, so DevLab itself does not require a paid subscription.

> **Start here:** the DevLab application is in [`devlab/`](./devlab). The repository's `medbook-queue/` directory is a separate sample project and is not required to run DevLab.

## Native migration status

Phases 1 and 2 are implemented: DevLab has a Tauri desktop shell, typed Rust-to-React IPC, restricted capabilities, and a real scoped workspace service connected to Monaco.

A workspace can be granted only through the native folder picker. The Rust backend holds its canonical root in memory, rejects absolute paths and parent traversal, blocks symlink access, limits text I/O, watches native filesystem changes, and uses content revisions to prevent silent overwrites.

Simulated terminal, Git, Docker, database, deployment, CI, toolchain, API-client and test-runner results remain disabled. Those panels are re-enabled only after their real native backend is completed. The normal Vite server remains available strictly as a UI preview.

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
- Project template and command references
- BroadcastChannel/WebRTC collaboration primitives
- Embedded web preview
- WebView-local settings and credentials until secure native storage lands

The remaining native backends are being delivered in explicit phases: PTY terminal next, then Git and secure secrets, Docker/databases/native HTTP, agent tool execution, and signed distribution. Until a backend exists, DevLab reports that the feature is unavailable instead of fabricating data or success.

## Requirements

Install these before starting:

1. [Git](https://git-scm.com/downloads)
2. [Node.js](https://nodejs.org/) `20.19+` or `22.12+`
3. npm, which is included with Node.js
4. The current stable [Rust toolchain](https://www.rust-lang.org/tools/install)
5. Your operating system's [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)
6. A [Google AI Studio API key](https://aistudio.google.com/app/apikey) for cloud AI features

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
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
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

The key is temporarily stored in the application WebView's `localStorage` under `devlab.gemini.key`. It is sent only to Google's official Gemini endpoint. It is not written to this repository and no `.env` file is needed. Encrypted native secret storage is scheduled for the Git/credentials phase.

Do not hardcode a shared key or add a `VITE_GEMINI_API_KEY` variable when deploying the public web app. Every user should enter their own key. A `VITE_` secret is bundled into public JavaScript and is not secret.

To remove the key, use **Settings → Providers → Clear**. To erase every locally stored setting and workspace, use **Settings → Advanced → Erase all local data**.

## 7. Verify the complete build

Run both frontend and native checks before packaging:

```bash
npm run check
npm run native:check
npm run native:test
```

The first command type-checks React and creates `devlab/dist/`; the second compiles the Rust backend; the third exercises native path-boundary and revision tests.

Build the native application and this operating system's installer formats:

```bash
npm run desktop:build
```

For an interface-only production preview, run `npm run preview -- --host 0.0.0.0`. Native capabilities intentionally remain unavailable in that browser preview.

## 8. Deploy the optional web preview

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
- [ ] Gemini key test says **Key valid**
- [ ] AI Agent streams a response
- [ ] Unimplemented native panels explicitly say **Simulation removed**
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

### Terminal, Git, Docker, database or test runner says “Simulation removed”

This is intentional—not an installation failure. The previous fabricated results have been disabled. Each panel will be re-enabled only when its real native milestone is implemented and tested. The next milestone is the scoped workspace filesystem.

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
│   ├── src/                # trusted Rust core and scoped workspace service
│   └── tauri.conf.json
└── src/
    ├── App.tsx
    ├── components/
    ├── data/
    ├── lib/
    │   ├── gemini.ts       # BYOK Gemini client, retry, quota, fallback
    │   ├── native.ts       # typed native runtime bridge
    │   ├── workspace.ts    # typed scoped-filesystem IPC client
    │   ├── settings.ts     # application settings
    │   └── sync.ts         # collaboration helpers
    └── panels/             # DevLab feature panels
```

## Security notes

- Never commit API keys or tokens.
- Never use one shared Gemini key in a public frontend.
- Keep the Tauri capability manifest default-deny and allow each custom command explicitly.
- Do not expose shell or filesystem primitives directly to the renderer.
- Validate and canonicalize every path against the user-selected workspace.
- Reject traversal and symbolic links at the native boundary; never rely on renderer validation.
- Require revision matches before overwriting an existing file.
- Rotate a key immediately if it is pasted into source code, an issue, a commit, or a public chat.
- Treat WebView-local credentials as temporary until encrypted native storage is implemented.
- Review generated commands and code before executing or deploying them.
