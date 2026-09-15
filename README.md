# DevLab

DevLab is a browser-based developer control plane built with React, TypeScript, Vite, Tailwind CSS, and Monaco Editor. Its AI tools use a **bring-your-own-key (BYOK)** connection to the Google Gemini API, so DevLab itself does not require a paid subscription or an application backend.

> **Start here:** the DevLab application is in [`devlab/`](./devlab). The repository's `medbook-queue/` directory is a separate sample project and is not required to run DevLab.

## What works in the web build

- Streaming Gemini chat
- AI project planning and file generation
- Architecture-canvas-to-code generation
- Screenshot and URL analysis
- Migration generation and AI-assisted test repair
- Monaco editing with browser-local workspace persistence
- Browser-based API requests and GitHub repository checks
- Browser-local settings and credentials

A browser cannot directly run operating-system commands, Docker, local databases, or Git processes. Those panels are currently control surfaces, simulations, or configuration helpers in the web build. The native Eclipse Theia material under **Local Setup → Native Blueprint** is an optional blueprint, not a prebuilt desktop release.

## Requirements

Install these before starting:

1. [Git](https://git-scm.com/downloads)
2. [Node.js](https://nodejs.org/) `20.19+` or `22.12+`
3. npm, which is included with Node.js
4. A current version of Chrome, Edge, Firefox, or Safari
5. A [Google AI Studio API key](https://aistudio.google.com/app/apikey) for AI features

Node.js 22 is recommended. If you use [nvm](https://github.com/nvm-sh/nvm), the included `.nvmrc` selects the correct major version.

## 1. Download the project

Open a terminal and run:

```bash
git clone https://github.com/Talean414/devlab.git
cd devlab/devlab
```

The repeated name is intentional: the first `devlab` is the repository and the second is the web application directory.

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

## 3. Install dependencies

From the directory containing DevLab's `package.json`, run:

```bash
npm ci
```

Use `npm ci` for a reproducible installation from `package-lock.json`. If it completes, you should now have a local `node_modules/` directory. That directory is intentionally excluded from Git.

## 4. Start DevLab

```bash
npm run dev
```

Vite prints a local address, normally:

```text
http://localhost:5173/
```

Open that address in your browser. Keep the terminal running while using the development app. Stop it later with `Ctrl+C`.

## 5. Create and connect a Gemini API key

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

The key is stored in this browser's `localStorage` under `devlab.gemini.key`. It is sent only from the browser to Google's official Gemini endpoint. It is not written to this repository and no `.env` file is needed.

Do not hardcode a shared key or add a `VITE_GEMINI_API_KEY` variable when deploying the public web app. Every user should enter their own key. A `VITE_` secret is bundled into public JavaScript and is not secret.

To remove the key, use **Settings → Providers → Clear**. To erase every locally stored setting and workspace, use **Settings → Advanced → Erase all local data**.

## 6. Verify the complete build

Run the project checks before deploying:

```bash
npm run check
```

This performs both:

```bash
npm run typecheck
npm run build
```

A successful production build is written to `devlab/dist/`. DevLab uses a single-file build, so the generated application is primarily `dist/index.html`.

Test the production build locally:

```bash
npm run preview -- --host 0.0.0.0
```

Open the URL printed by Vite and repeat the AI Agent smoke test.

## 7. Deploy the web app

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
- [ ] `npm run check` passes
- [ ] DevLab opens without a blank page
- [ ] Gemini key test says **Key valid**
- [ ] AI Agent streams a response
- [ ] Project Builder creates a plan
- [ ] Code Editor opens a generated file
- [ ] Refreshing the page preserves settings and workspace data
- [ ] Production preview opens and passes the same smoke test
- [ ] Hosted deployment uses HTTPS and asks each user for their own key

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

### Generated work disappeared

The current web workspace is browser-local. Clearing site data, changing domains, or using another browser profile creates a separate workspace. Export important generated files rather than treating browser storage as a permanent repository.

### Local terminal or Docker command does not execute

That is expected in the current browser build. Web pages do not have permission to launch arbitrary OS commands. The integrated Terminal panel simulates common workflows; native execution requires a trusted desktop/backend runtime that is not included in the current Vite application.

## Available scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Start the development server |
| `npm run typecheck` | Run TypeScript validation without emitting files |
| `npm run build` | Create the optimized static build |
| `npm run check` | Type-check and build |
| `npm run preview` | Preview the production build locally |

## Project structure

```text
devlab/
├── index.html
├── package.json
├── vite.config.ts
└── src/
    ├── App.tsx
    ├── components/
    ├── data/
    ├── lib/
    │   ├── gemini.ts       # BYOK Gemini client, retry, quota, fallback
    │   ├── settings.ts     # browser-local application settings
    │   └── sync.ts         # collaboration helpers
    └── panels/             # DevLab feature panels
```

## Security notes

- Never commit API keys or tokens.
- Never use one shared Gemini key in a public frontend.
- Use HTTPS in production.
- Rotate a key immediately if it is pasted into source code, an issue, a commit, or a public chat.
- Treat browser-local credentials as accessible to anyone who can use that browser profile.
- Review generated commands and code before executing or deploying them.
