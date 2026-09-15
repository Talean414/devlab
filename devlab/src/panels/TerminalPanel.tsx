import { useEffect, useRef, useState } from "react";
import { projectTemplates } from "../data/templates";
import { runtimes } from "../data/runtimes";
import { deployProviders } from "../data/runtimes";
import { loadGit } from "../lib/settings";
import { Terminal as TerminalIcon } from "lucide-react";

interface Line {
  id: number;
  text: string;
  type: "in" | "out" | "err" | "ok";
}

let counter = 0;
const nid = () => ++counter;

export function TerminalPanel() {
  const [lines, setLines] = useState<Line[]>([
    { id: nid(), text: "DevLab Terminal v1.0 — type `help` to see built-in commands.", type: "out" },
    { id: nid(), text: "Grid-split terminal · runs Aider / Git CLI / any shell in the real build.", type: "out" },
  ]);
  const [input, setInput] = useState("");
  const [cwd] = useState("~/devlab");
  const [history, setHistory] = useState<string[]>([]);
  const [hIdx, setHIdx] = useState(-1);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lines]);

  function push(text: string, type: Line["type"] = "out") {
    setLines((l) => [...l, { id: nid(), text, type }]);
  }

  function run(raw: string) {
    const cmd = raw.trim();
    push(`${cwd} $ ${cmd}`, "in");
    if (!cmd) return;
    setHistory((h) => [...h, cmd]);
    setHIdx(-1);

    const [base, ...args] = cmd.split(/\s+/);
    const git = loadGit();

    switch (base) {
      case "help":
        push("DevLab built-in commands", "ok");
        push("  help                    show this list");
        push("  clear                   clear the terminal");
        push("  new <template>          scaffold a project");
        push("  templates [stack]       list project templates");
        push("  runtimes [category]     list installable runtimes");
        push("  install <runtime>       show install commands");
        push("  deploy [provider]       show deployment commands");
        push("  git <subcommand>        git operations");
        push("  gh <subcommand>         GitHub CLI");
        push("  docker <subcommand>     container operations");
        push("  kubectl <subcommand>    kubernetes operations");
        push("  npm|pnpm|yarn|bun ...   package managers");
        push("  cargo|go|uv|pip ...     language toolchains");
        push("  aider / ollama          AI agents");
        push("  ls | pwd | cd | cat     filesystem");
        push("  env | which | neofetch  environment");
        break;

      case "clear": setLines([]); break;

      case "templates": {
        const filter = args[0]?.toLowerCase();
        const list = filter
          ? projectTemplates.filter((t) => t.stack.toLowerCase() === filter || t.tags.includes(filter))
          : projectTemplates;
        push(`${list.length} template(s)${filter ? ` in "${filter}"` : ""}:`, "ok");
        list.forEach((t) => push(`  ${t.id.padEnd(18)} ${t.stack.padEnd(10)} ${t.name}`));
        push("Use: new <id>");
        break;
      }

      case "new": {
        if (!args[0]) { push("Usage: new <template-id>   (run `templates` to list)", "err"); break; }
        const t = projectTemplates.find((p) => p.id === args[0] || p.tags.includes(args[0]));
        if (!t) { push(`Unknown template "${args[0]}". Run \`templates\`.`, "err"); break; }
        push(`Scaffolding ${t.name} (${t.lang})…`, "ok");
        t.commands.forEach((c) => push(`  $ ${c}`));
        push(`✓ ${t.name} ready — open the Project Builder for an AI-generated version.`, "ok");
        break;
      }

      case "runtimes": {
        const cat = args[0]?.toLowerCase();
        const list = cat ? runtimes.filter((r) => r.category.toLowerCase() === cat) : runtimes;
        push(`${list.length} runtime(s):`, "ok");
        list.forEach((r) => push(`  ${r.id.padEnd(14)} ${r.version.padEnd(9)} ${r.category.padEnd(10)} ${r.name}`));
        push("Use: install <id>");
        break;
      }

      case "install": {
        const r = runtimes.find((x) => x.id === args[0]);
        if (!r) { push(`Unknown runtime "${args[0] ?? ""}". Run \`runtimes\`.`, "err"); break; }
        push(`# Install ${r.name} ${r.version}`, "ok");
        r.install.split("\n").forEach((l) => push("  " + l));
        push(`# Verify`, "ok");
        push("  " + r.verify);
        break;
      }

      case "deploy": {
        if (!args[0]) {
          push("Deployment providers:", "ok");
          deployProviders.forEach((p) => push(`  ${p.id.padEnd(12)} ${p.freeTier}`));
          push("Use: deploy <provider>");
          break;
        }
        const p = deployProviders.find((x) => x.id === args[0]);
        if (!p) { push(`Unknown provider "${args[0]}".`, "err"); break; }
        push(`# ${p.name} — ${p.tagline}`, "ok");
        push(`$ ${p.cliInstall.split("\n")[0]}`);
        push(`$ ${p.deployCmd}`);
        break;
      }

      case "git": {
        const sub = args[0];
        const remote = git.owner && git.repo ? `${git.owner}/${git.repo}` : "origin";
        if (sub === "status")
          push(`On branch ${git.branch}\nYour branch is up to date with 'origin/${git.branch}'.\n\nnothing to commit, working tree clean`, "ok");
        else if (sub === "init") push(`Initialized empty Git repository in .git/`, "ok");
        else if (sub === "log")
          push("commit a1b2c3d (HEAD -> main, origin/main)\nAuthor: " + (git.authorName || "you") + "\n\n    feat: add agentic project builder", "out");
        else if (sub === "remote") push(`origin  git@github.com:${remote}.git (fetch)\norigin  git@github.com:${remote}.git (push)`, "out");
        else if (sub === "branch") push(`* ${git.branch}\n  develop\n  feature/agent`, "out");
        else if (sub === "push") push(`Pushing to git@github.com:${remote}.git\n   a1b2c3d..d4e5f6g  ${git.branch} -> ${git.branch}`, "ok");
        else if (sub === "pull") push(`Already up to date.`, "ok");
        else if (sub === "diff") push("diff --git a/src/App.tsx b/src/App.tsx\n@@ -1,4 +1,6 @@\n+import { BuilderPanel } from './panels/BuilderPanel';", "out");
        else push(`git ${args.join(" ")} — ok`, "ok");
        break;
      }

      case "gh": {
        if (args[0] === "auth") push("✓ Logged in to github.com as " + (git.owner || "you"), "ok");
        else if (args[0] === "repo" && args[1] === "list") push(`${git.owner || "you"}/devlab      public   Unified developer control plane\n${git.owner || "you"}/api-server  private  Backend services`, "out");
        else if (args[0] === "pr") push("#42  feat: agentic builder   OPEN   2 hours ago", "out");
        else if (args[0] === "run" && args[1] === "list") push("completed  success  Node CI       main     42s\nin_progress  —      Deploy Pages  main      —", "out");
        else push(`gh ${args.join(" ")} — ok`, "ok");
        break;
      }

      case "docker": {
        if (args[0] === "ps")
          push("CONTAINER ID   IMAGE              STATUS        PORTS\nab12cd34       devlab/app:latest  Up 2 hours    0.0.0.0:3000->3000\nef56gh78       postgres:16        Up 2 hours    0.0.0.0:5432->5432\nij90kl12       redis:7-alpine     Up 2 hours    0.0.0.0:6379->6379", "out");
        else if (args[0] === "images")
          push("REPOSITORY          TAG       SIZE\ndevlab/app          latest    142MB\npostgres            16        243MB\nredis               7-alpine   41MB", "out");
        else if (args[0] === "compose") push(`docker compose ${args.slice(1).join(" ")} — services started`, "ok");
        else push(`docker ${args.join(" ")} — ok`, "ok");
        break;
      }

      case "kubectl": {
        if (args[0] === "get" && args[1]?.startsWith("pod"))
          push("NAME                    READY   STATUS    RESTARTS   AGE\napp-7d9f8b6c4-xk2mp     1/1     Running   0          2h\npostgres-0              1/1     Running   0          2h", "out");
        else if (args[0] === "get" && args[1]?.startsWith("svc"))
          push("NAME       TYPE           CLUSTER-IP     PORT(S)\napp        LoadBalancer   10.96.14.22    80:30080/TCP", "out");
        else push(`kubectl ${args.join(" ")} — ok`, "ok");
        break;
      }

      case "npm": case "pnpm": case "yarn": case "bun": {
        if (args[0] === "run" || args[0] === "dev") push(`> ${args[1] || "dev"}\n\n  VITE ready in 312 ms\n  ➜  Local:   http://localhost:5173/`, "ok");
        else if (args[0] === "install" || args[0] === "i") push(`added ${Math.floor(Math.random() * 300) + 50} packages in ${(Math.random() * 4 + 1).toFixed(1)}s`, "ok");
        else if (args[0] === "test") push("Test Suites: 12 passed, 12 total\nTests:       84 passed, 84 total", "ok");
        else if (args[0] === "build") push("✓ built in 1.84s\ndist/index.html   312.4 kB │ gzip: 92.1 kB", "ok");
        else push(`${base} ${args.join(" ")} — ok`, "ok");
        break;
      }

      case "cargo":
        if (args[0] === "build" || args[0] === "run") push("   Compiling my-app v0.1.0\n    Finished dev [unoptimized] target(s) in 2.41s", "ok");
        else if (args[0] === "test") push("running 14 tests\ntest result: ok. 14 passed; 0 failed", "ok");
        else push(`cargo ${args.join(" ")} — ok`, "ok");
        break;

      case "go":
        if (args[0] === "run") push("Server listening on :8080", "ok");
        else if (args[0] === "test") push("ok  	example.com/my-svc	0.412s", "ok");
        else if (args[0] === "build") push("", "ok");
        else push(`go ${args.join(" ")} — ok`, "ok");
        break;

      case "uv": case "pip": case "python": case "python3":
        if (args.includes("install") || args.includes("add")) push(`Installed ${Math.floor(Math.random() * 20) + 3} packages in ${(Math.random() * 500).toFixed(0)}ms`, "ok");
        else if (args[0] === "run") push("INFO:     Uvicorn running on http://127.0.0.1:8000", "ok");
        else push(`${base} ${args.join(" ")} — ok`, "ok");
        break;

      case "aider":
        push("Aider v0.60 — AI pair programmer", "ok");
        push("Model: gemini/gemini-3.6-flash");
        push("Git repo: . with 42 files");
        push("Use /help for commands, /add to include files.");
        push("(In the native build this attaches to your real repository.)");
        break;

      case "ollama":
        if (args[0] === "list") push("NAME                 SIZE     MODIFIED\nqwen2.5-coder:7b     4.7 GB   2 days ago\ndeepseek-r1:8b       5.2 GB   1 week ago", "out");
        else if (args[0] === "serve") push("Ollama listening on http://127.0.0.1:11434", "ok");
        else push(`ollama ${args.join(" ")} — ok`, "ok");
        break;

      case "ls":
        push("src/          package.json      tsconfig.json\npublic/       vite.config.ts    README.md\n.github/      Dockerfile        docker-compose.yml", "out");
        break;
      case "pwd":  push("/home/dev/devlab", "out"); break;
      case "cd":   push(`cd ${args[0] || "~"}`, "ok"); break;
      case "cat":  push(args[0] ? `# contents of ${args[0]}\n(simulated — open the Code Editor to read real files)` : "cat: missing operand", args[0] ? "out" : "err"); break;
      case "which": push(args[0] ? `/usr/local/bin/${args[0]}` : "which: missing operand", args[0] ? "out" : "err"); break;
      case "env":
        push(`GEMINI_API_KEY=${"*".repeat(20)}\nDEVLAB_HOME=/home/dev/.devlab\nGIT_AUTHOR_NAME=${git.authorName || "you"}\nGIT_BRANCH=${git.branch}\nPATH=/home/dev/.devlab/bin:/usr/local/bin:/usr/bin`, "out");
        break;
      case "neofetch":
        push(`devlab@control-plane
────────────────────────────────
OS      DevLab Unified Environment
Shell   devlab-sh 1.0
Editor  Monaco (VS Code engine)
Agent   Gemini · BYOK
Tools   ${runtimes.length} runtimes · ${deployProviders.length} deploy targets
Repo    ${git.owner && git.repo ? `${git.owner}/${git.repo}` : "not connected"}
Uptime  ${Math.floor(performance.now() / 1000)}s`, "out");
        break;
      case "echo": push(args.join(" ")); break;
      case "exit": push("Use the sidebar to switch panels.", "ok"); break;

      default:
        push(`devlab-sh: command not found: ${base}`, "err");
        push(`This browser terminal simulates common tooling. The packaged DevLab desktop app`, "out");
        push(`runs your real shell with full PTY access — see the Local Setup panel.`, "out");
    }
  }

  return (
    <div className="flex h-full flex-col bg-[#0a0c11]">
      <div className="flex items-center gap-2 border-b border-white/5 px-4 py-2.5">
        <TerminalIcon className="h-3.5 w-3.5 text-zinc-500" />
        <span className="text-xs font-medium text-zinc-400">devlab-sh — {cwd}</span>
      </div>
      <div className="flex-1 overflow-y-auto p-4 font-mono text-[13px] leading-relaxed">
        {lines.map((l) => (
          <div
            key={l.id}
            className={`whitespace-pre-wrap ${
              l.type === "in"
                ? "text-cyan-300"
                : l.type === "err"
                  ? "text-rose-400"
                  : l.type === "ok"
                    ? "text-emerald-300"
                    : "text-zinc-300"
            }`}
          >
            {l.text}
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <div className="flex items-center gap-2 border-t border-white/5 px-4 py-3 font-mono text-[13px]">
        <span className="text-emerald-400">{cwd} $</span>
        <input
          autoFocus
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { run(input); setInput(""); }
            else if (e.key === "ArrowUp") {
              e.preventDefault();
              const idx = hIdx < 0 ? history.length - 1 : Math.max(0, hIdx - 1);
              if (history[idx] !== undefined) { setHIdx(idx); setInput(history[idx]); }
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              const idx = hIdx + 1;
              if (idx >= history.length) { setHIdx(-1); setInput(""); }
              else { setHIdx(idx); setInput(history[idx]); }
            }
          }}
          className="flex-1 bg-transparent text-zinc-100 caret-cyan-400 outline-none"
          placeholder="type a command…"
        />
      </div>
    </div>
  );
}
