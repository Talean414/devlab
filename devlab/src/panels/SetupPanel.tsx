import { useState } from "react";
import { PanelHeader } from "./AgentPanel";
import { CodeBlock } from "../components/CodeBlock";
import { runtimes } from "../data/runtimes";
import { Terminal, Package, Cpu, Rocket, Shield, BookOpen } from "lucide-react";

const TABS = [
  { id: "quick",    label: "Start Here",       Icon: Rocket },
  { id: "theia",    label: "Native Blueprint", Icon: Package },
  { id: "runtimes", label: "Native Runtimes",     Icon: Cpu },
  { id: "agents",   label: "External AI CLIs",    Icon: Terminal },
  { id: "dist",     label: "Native Distribution", Icon: Shield },
] as const;

const LOCAL_SETUP = `# 1. Clone the repository
git clone https://github.com/Talean414/devlab.git
cd devlab/devlab

# 2. Use Node.js 22 (with nvm)
nvm install
nvm use

# 3. Install exactly what is in package-lock.json
npm ci

# 4. Start the development app
npm run dev
# Open http://localhost:5173`;


const THEIA_PKG = `{
  "private": true,
  "name": "devlab",
  "version": "1.0.0",
  "license": "MIT",
  "theia": {
    "frontend": {
      "config": {
        "applicationName": "DevLab",
        "preferences": {
          "files.enableTrash": false,
          "workbench.colorTheme": "Dark+ (default dark)",
          "editor.fontSize": 14,
          "terminal.integrated.fontSize": 13
        }
      }
    },
    "backend": { "config": { "startupTimeout": -1 } }
  },
  "dependencies": {
    "@theia/core":              "latest",
    "@theia/editor":            "latest",
    "@theia/filesystem":        "latest",
    "@theia/workspace":         "latest",
    "@theia/terminal":          "latest",
    "@theia/preview":           "latest",
    "@theia/markers":           "latest",
    "@theia/messages":          "latest",
    "@theia/navigator":         "latest",
    "@theia/outline-view":      "latest",
    "@theia/preferences":       "latest",
    "@theia/process":           "latest",
    "@theia/scm":               "latest",
    "@theia/search-in-workspace":"latest",
    "@theia/task":              "latest",
    "@theia/debug":             "latest",
    "@theia/git":               "latest",
    "@theia/mini-browser":      "latest",
    "@theia/plugin-ext":        "latest",
    "@theia/plugin-ext-vscode": "latest",
    "@theia/vsx-registry":      "latest",
    "@theia/electron":          "latest"
  },
  "devDependencies": {
    "@theia/cli": "latest",
    "electron": "^31.0.0",
    "electron-builder": "^24.13.3"
  },
  "scripts": {
    "prepare":  "theia build --mode development && theia download:plugins",
    "start":    "theia start --plugins=local-dir:plugins",
    "build":    "theia build --mode production",
    "package":  "electron-builder -c.mac.identity=null",
    "package:all": "electron-builder -mwl"
  },
  "theiaPluginsDir": "plugins",
  "theiaPlugins": {
    "roo-code":        "https://open-vsx.org/api/RooVeterinaryInc/roo-cline/latest/file/RooVeterinaryInc.roo-cline-latest.vsix",
    "continue":        "https://open-vsx.org/api/Continue/continue/latest/file/Continue.continue-latest.vsix",
    "docker":          "https://open-vsx.org/api/ms-azuretools/vscode-docker/latest/file/ms-azuretools.vscode-docker-latest.vsix",
    "database-client": "https://open-vsx.org/api/cweijan/vscode-database-client2/latest/file/cweijan.vscode-database-client2-latest.vsix",
    "rest-client":     "https://open-vsx.org/api/humao/rest-client/latest/file/humao.rest-client-latest.vsix",
    "thunder-client":  "https://open-vsx.org/api/rangav/vscode-thunder-client/latest/file/rangav.vscode-thunder-client-latest.vsix",
    "gitlens":         "https://open-vsx.org/api/eamodio/gitlens/latest/file/eamodio.gitlens-latest.vsix",
    "github-actions":  "https://open-vsx.org/api/github/vscode-github-actions/latest/file/github.vscode-github-actions-latest.vsix",
    "prettier":        "https://open-vsx.org/api/esbenp/prettier-vscode/latest/file/esbenp.prettier-vscode-latest.vsix",
    "eslint":          "https://open-vsx.org/api/dbaeumer/vscode-eslint/latest/file/dbaeumer.vscode-eslint-latest.vsix",
    "python":          "https://open-vsx.org/api/ms-python/python/latest/file/ms-python.python-latest.vsix",
    "rust-analyzer":   "https://open-vsx.org/api/rust-lang/rust-analyzer/latest/file/rust-lang.rust-analyzer-latest.vsix",
    "golang":          "https://open-vsx.org/api/golang/Go/latest/file/golang.Go-latest.vsix",
    "java":            "https://open-vsx.org/api/redhat/java/latest/file/redhat.java-latest.vsix",
    "kubernetes":      "https://open-vsx.org/api/ms-kubernetes-tools/vscode-kubernetes-tools/latest/file/ms-kubernetes-tools.vscode-kubernetes-tools-latest.vsix",
    "yaml":            "https://open-vsx.org/api/redhat/vscode-yaml/latest/file/redhat.vscode-yaml-latest.vsix",
    "tailwindcss":     "https://open-vsx.org/api/bradlc/vscode-tailwindcss/latest/file/bradlc.vscode-tailwindcss-latest.vsix"
  }
}`;

const BUILDER_YML = `# electron-builder.yml
appId: io.devlab.app
productName: DevLab
copyright: MIT
directories:
  buildResources: resources
  output: dist
files:
  - "lib/**/*"
  - "src-gen/**/*"
  - "plugins/**/*"
  - "package.json"
mac:
  target: [dmg, zip]
  category: public.app-category.developer-tools
  icon: resources/icon.icns
win:
  target: [nsis, portable]
  icon: resources/icon.ico
linux:
  target: [AppImage, deb]
  category: Development
  icon: resources/icon.png
nsis:
  oneClick: false
  allowToChangeInstallationDirectory: true
  createDesktopShortcut: always`;

const MAIN_PATCH = `// src-gen/backend/main.js  — inject DevLab env before Theia boots
// Add this at the very top of the generated backend entry, or keep it in
// a small wrapper module that you require first.

const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG = path.join(os.homedir(), '.devlab', 'config.json');

if (fs.existsSync(CONFIG)) {
  const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  // Make the key available to every agent extension + terminal session
  if (cfg.geminiApiKey) {
    process.env.GEMINI_API_KEY  = cfg.geminiApiKey;
    process.env.GOOGLE_API_KEY  = cfg.geminiApiKey;
  }
  if (cfg.githubToken)  process.env.GITHUB_TOKEN  = cfg.githubToken;
  if (cfg.vercelToken)  process.env.VERCEL_TOKEN  = cfg.vercelToken;
  if (cfg.railwayToken) process.env.RAILWAY_TOKEN = cfg.railwayToken;
  if (cfg.flyToken)     process.env.FLY_API_TOKEN = cfg.flyToken;
}`;

export function SetupPanel() {
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("quick");
  const byCat = runtimes.reduce<Record<string, typeof runtimes>>((acc, r) => {
    (acc[r.category] ||= []).push(r);
    return acc;
  }, {});

  return (
    <div className="flex h-full flex-col">
      <PanelHeader
        title="Local Setup"
        subtitle="Run the current web app locally, connect Gemini, and verify a production build"
      />
      <div className="flex gap-5 border-b border-white/5 bg-[#0d1017]/40 px-6 text-xs">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`-mb-px inline-flex items-center gap-1.5 border-b-2 px-1 py-3 font-medium ${
              tab === t.id ? "border-cyan-400 text-white" : "border-transparent text-zinc-500 hover:text-zinc-300"
            }`}
          >
            <t.Icon className="h-3.5 w-3.5" /> {t.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl px-7 py-8">
          {tab === "quick" && (
            <>
              <Head icon={Rocket} title="1 · Run the current DevLab web app"
                sub="You need Git, Node.js 20.19+ or 22.12+, npm, and a modern browser." />
              <CodeBlock code={LOCAL_SETUP} lang="bash" />

              <Head icon={Terminal} title="2 · Connect Gemini" className="mt-8"
                sub="Each user supplies their own Google AI Studio key; no server environment variable is needed." />
              <ol className="list-decimal space-y-2 rounded-xl border border-white/10 bg-white/[0.02] py-4 pl-10 pr-5 text-[13px] leading-relaxed text-zinc-300">
                <li>Create a key at <a className="text-cyan-400 hover:underline" href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer">Google AI Studio</a>.</li>
                <li>Paste it into the first-run <strong className="text-white">Bring Your Own Key</strong> window.</li>
                <li>Open <strong className="text-white">Settings → Providers</strong>, click <strong className="text-white">Test</strong>, and choose a stable Flash-Lite model.</li>
                <li>Open <strong className="text-white">AI Agent</strong> and send a small test prompt.</li>
              </ol>

              <Head icon={Shield} title="3 · Verify the production build" className="mt-8"
                sub="Type-check, build the single-file app, then serve the result locally." />
              <CodeBlock code={"npm run check\nnpm run preview -- --host 0.0.0.0\n# Open the URL printed by Vite"} lang="bash" />

              <Note>
                The current repository is a browser app. Its integrated terminal simulates common
                commands because a web page cannot execute arbitrary processes on your machine.
                The <strong>Native Blueprint</strong> tab is optional architecture guidance; this
                repository does not currently publish a ready-made <code>.exe</code>, <code>.dmg</code>,
                or <code>.AppImage</code>.
              </Note>
            </>
          )}

          {tab === "theia" && (
            <>
              <Note>
                This is an advanced blueprint for a separate native implementation, not a build
                target already wired into the current Vite application. Complete and test the
                desktop integration before advertising downloadable binaries.
              </Note>
              <Head icon={Package} title="1 · Scaffold the Theia app" className="mt-8"
                sub="Creates a separate shell that can become a native DevLab binary." />
              <CodeBlock lang="bash" code={`npm i -g yo generator-theia-extension
mkdir devlab && cd devlab
yo theia-extension --standalone
# choose: "Empty" template, name it "devlab"`} />

              <Head icon={Package} title="2 · Replace package.json" className="mt-8"
                sub="Every tool is pre-baked here, so users never visit a marketplace." />
              <CodeBlock code={THEIA_PKG} lang="json" />

              <Head icon={Package} title="3 · electron-builder config" className="mt-8"
                sub="Produces .exe, .dmg and .AppImage from one command." />
              <CodeBlock code={BUILDER_YML} lang="yaml" />

              <Head icon={Shield} title="4 · Inject BYOK env vars at boot" className="mt-8"
                sub="So every agent extension and terminal picks up your key automatically." />
              <CodeBlock code={MAIN_PATCH} lang="javascript" />

              <Head icon={Rocket} title="5 · Build and package" className="mt-8" sub="" />
              <CodeBlock lang="bash" code={`npm install
npm run prepare        # compiles + downloads all pre-baked plugins
npm run build          # production bundle
npm run package        # binary for your current OS
npm run package:all    # .exe + .dmg + .AppImage together

# output lands in ./dist`} />
              <Note>
                First build takes 10–20 minutes because it downloads every VSIX. Subsequent
                builds are cached and take about a minute.
              </Note>
            </>
          )}

          {tab === "runtimes" && (
            <>
              <Head icon={Cpu} title="Native runtimes & toolchains"
                sub="Reference list for a future native build; the current browser app cannot detect local runtimes." />
              {Object.entries(byCat).map(([cat, list]) => (
                <div key={cat} className="mt-7">
                  <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-cyan-400">{cat}</h3>
                  <div className="space-y-3">
                    {list.map((r) => (
                      <details key={r.id} className="group rounded-xl border border-white/10 bg-white/[0.02] ring-soft">
                        <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3">
                          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-cyan-500/15 to-violet-600/15 ring-1 ring-white/10">
                            <Cpu className="h-4 w-4 text-cyan-200" />
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="text-[13.5px] font-medium text-zinc-100">{r.name}</span>
                              <span className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400">{r.version}</span>
                            </div>
                            <div className="truncate text-[12px] text-zinc-500">{r.description}</div>
                          </div>
                          <span className="shrink-0 text-[11px] text-zinc-600 group-open:hidden">Show install</span>
                        </summary>
                        <div className="space-y-3 border-t border-white/5 p-4">
                          <div>
                            <div className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500">Install</div>
                            <CodeBlock code={r.install} lang="bash" />
                          </div>
                          <div>
                            <div className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500">Verify</div>
                            <CodeBlock code={r.verify} lang="bash" />
                          </div>
                        </div>
                      </details>
                    ))}
                  </div>
                </div>
              ))}
            </>
          )}

          {tab === "agents" && (
            <>
              <Head icon={Terminal} title="External terminal AI agents"
                sub="Run these in your operating-system terminal; DevLab's browser terminal is a simulation." />
              <h3 className="mb-2 mt-6 text-sm font-semibold text-white">Aider — AI pair programmer</h3>
              <CodeBlock lang="bash" code={`uv tool install aider-chat
export GEMINI_API_KEY="your_key_here"

# start it inside any git repo
aider --model gemini/gemini-3.6-flash

# common flows
aider src/app.py --message "add retry logic with exponential backoff"
aider --architect            # plan-then-edit mode
aider --auto-commits         # let it commit each change`} />

              <h3 className="mb-2 mt-7 text-sm font-semibold text-white">Gemini CLI</h3>
              <CodeBlock lang="bash" code={`npm i -g @google/gemini-cli
gemini auth login            # or: export GEMINI_API_KEY=...
gemini "refactor this module for testability" --file src/service.ts`} />

              <h3 className="mb-2 mt-7 text-sm font-semibold text-white">Offline models with Ollama</h3>
              <CodeBlock lang="bash" code={`curl -fsSL https://ollama.com/install.sh | sh
ollama pull qwen2.5-coder:7b       # great free coding model
ollama pull deepseek-r1:8b         # reasoning model
ollama serve                       # http://localhost:11434

# point Continue / Roo Code at it — zero API cost, fully private`} />

              <h3 className="mb-2 mt-7 text-sm font-semibold text-white">Persist your keys</h3>
              <CodeBlock lang="bash" code={`mkdir -p ~/.devlab
cat > ~/.devlab/config.json <<'EOF'
{
  "geminiApiKey": "YOUR_KEY",
  "githubToken":  "ghp_...",
  "vercelToken":  "...",
  "railwayToken": "..."
}
EOF
chmod 600 ~/.devlab/config.json   # readable only by you`} />
              <Note>
                Never commit <code>~/.devlab/config.json</code>. Add it to your global gitignore:
                <code> git config --global core.excludesfile ~/.gitignore_global</code>
              </Note>
            </>
          )}

          {tab === "dist" && (
            <>
              <Note>
                These examples apply only after the separate native blueprint has been implemented.
                There are no desktop binaries to publish from the current Vite project.
              </Note>
              <Head icon={Shield} title="Publish a completed native build" className="mt-8"
                sub="Example GitHub Releases pipeline for the future desktop implementation." />
              <CodeBlock lang="yaml" code={`# .github/workflows/release.yml
name: Release DevLab
on:
  push: { tags: ['v*'] }
jobs:
  build:
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
    runs-on: \${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - run: npm run prepare && npm run build
      - run: npx electron-builder --publish always
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}`} />

              <Head icon={BookOpen} title="Homebrew tap (macOS / Linux)" className="mt-8" sub="" />
              <CodeBlock lang="ruby" code={`# Formula/devlab.rb in your homebrew-tap repo
cask "devlab" do
  version "1.0.0"
  sha256 "REPLACE_WITH_SHA"
  url "https://github.com/your-org/devlab/releases/download/v#{version}/DevLab-macos-arm64.dmg"
  name "DevLab"
  desc "Unified developer control plane"
  homepage "https://github.com/your-org/devlab"
  app "DevLab.app"
end

# users then run:
#   brew tap your-org/tap && brew install --cask devlab`} />

              <Head icon={BookOpen} title="Winget (Windows)" className="mt-8" sub="" />
              <CodeBlock lang="yaml" code={`# manifests/y/your-org/DevLab/1.0.0/your-org.DevLab.installer.yaml
PackageIdentifier: your-org.DevLab
PackageVersion: 1.0.0
Installers:
  - Architecture: x64
    InstallerType: nullsoft
    InstallerUrl: https://github.com/your-org/devlab/releases/download/v1.0.0/DevLab-Setup.exe
    InstallerSha256: REPLACE_WITH_SHA
ManifestType: installer
ManifestVersion: 1.6.0

# users then run:  winget install your-org.DevLab`} />
              <Note>
                Add a <code>LICENSE</code> (MIT), a <code>SECURITY.md</code>, and enable
                Dependabot so your pre-baked VSIX URLs stay current.
              </Note>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Head({
  icon: Icon, title, sub, className = "",
}: { icon: typeof Rocket; title: string; sub: string; className?: string }) {
  return (
    <div className={`mb-3 flex items-start gap-3 ${className}`}>
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-cyan-500/20 to-violet-600/20 ring-1 ring-white/10">
        <Icon className="h-4 w-4 text-cyan-200" />
      </span>
      <div>
        <h2 className="text-[15px] font-semibold text-white">{title}</h2>
        {sub && <p className="mt-0.5 text-[12.5px] text-zinc-500">{sub}</p>}
      </div>
    </div>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-5 rounded-xl border border-amber-500/20 bg-amber-500/[0.06] p-4 text-[13px] leading-relaxed text-amber-100/90 [&_code]:rounded [&_code]:bg-black/30 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[12px]">
      {children}
    </div>
  );
}
