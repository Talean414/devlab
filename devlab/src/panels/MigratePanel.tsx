import { useState } from "react";
import { PanelHeader } from "./AgentPanel";
import { CodeBlock } from "../components/CodeBlock";
import { getApiKey, streamChat } from "../lib/gemini";
import type { OpenGeneratedDrafts, VFile } from "../types";
import { Database, Wand2, Loader2, ArrowRight, FileDiff, ScrollText, Plug, ListChecks } from "lucide-react";

type Orm = "prisma" | "drizzle" | "sql";
interface Result {
  summary: string;
  prisma: string;
  sql: string;
  routes: string;
  checklist: string[];
}

const EXAMPLES = [
  "Add a multi-vendor table with Stripe subscription IDs",
  "Soft-delete users and add an audit log for logins",
  "Track inventory per warehouse with optimistic locking",
  "Add comments and reactions to the posts table",
];

export function MigratePanel({ onOpenFiles }: { onOpenFiles: OpenGeneratedDrafts }) {
  const [orm, setOrm] = useState<Orm>("prisma");
  const [req, setReq] = useState("");
  const [schema, setSchema] = useState(DEFAULT_SCHEMA);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [tab, setTab] = useState<"orm" | "sql" | "routes">("orm");
  const [error, setError] = useState("");

  async function generate(text: string) {
    if (!getApiKey() || !text.trim() || busy) return;
    setBusy(true); setError(""); setResult(null);
    try {
      let acc = "";
      const prompt = `You are DevLab's database architect. The developer has this CURRENT Prisma schema:

\`\`\`prisma
${schema}
\`\`\`

Their request: "${text}"

Respond with ONLY valid JSON (no fences):
{
  "summary": "one sentence describing the data-model change",
  "prisma": "the COMPLETE updated Prisma schema file",
  "sql": "the full SQL migration with -- comments, ALTER/CREATE tables, indexes and FKs (PostgreSQL dialect)",
  "routes": "complete TypeScript API route handlers for the new models (Hono or Express style with zod validation), one file",
  "checklist": ["step 1 to deploy this safely", "..."]
}
Keep to the existing schema's conventions. Use snake_case columns in SQL. Escape newlines properly in JSON strings.`;
      for await (const ch of streamChat([{ role: "user", text: prompt }])) acc += ch;
      const clean = acc.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
      setResult(JSON.parse(clean.slice(clean.indexOf("{"), clean.lastIndexOf("}") + 1)));
    } catch (e) {
      setError((e as Error).message.includes("JSON")
        ? "Model returned invalid JSON — try rephrasing the request."
        : (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function applyAll() {
    if (!result) return;
    const files: VFile[] = [];
    if (orm === "prisma") files.push({ path: "prisma/schema.prisma", content: result.prisma, language: "prisma" });
    files.push({ path: `prisma/migrations/${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "").slice(0, 12)}_devlab/migration.sql`, content: result.sql, language: "sql" });
    files.push({ path: "src/routes/generated.ts", content: result.routes, language: "typescript" });
    const opened = await onOpenFiles(files, `Natural-language migration draft: ${result.summary}`);
    if (!opened) setError("Migration drafts were not staged for editor review. Nothing was written.");
  }

  return (
    <div className="flex h-full flex-col">
      <PanelHeader
        title="Natural-Language Migrations"
        subtitle="English → Prisma schema + SQL migration + API routes"
      />
      <div className="flex min-h-0 flex-1">
        <div className="flex w-[44%] shrink-0 flex-col border-r border-white/5">
          <div className="flex items-center justify-between border-b border-white/5 px-4 py-2.5">
            <span className="flex items-center gap-2 text-[12.5px] font-medium text-zinc-200">
              <Database className="h-4 w-4 text-emerald-400" /> Current schema
            </span>
            <select value={orm} onChange={(e) => setOrm(e.target.value as Orm)}
              className="rounded-md border border-white/10 bg-[#0d1017] px-2 py-1 text-[11px] text-zinc-300 outline-none">
              <option value="prisma" className="text-zinc-900">Prisma</option>
              <option value="drizzle" className="text-zinc-900">Drizzle</option>
              <option value="sql" className="text-zinc-900">Raw SQL</option>
            </select>
          </div>
          <textarea value={schema} onChange={(e) => setSchema(e.target.value)} spellCheck={false}
            className="min-h-0 flex-1 resize-none bg-[#0a0c11] p-4 font-mono text-[11.5px] leading-relaxed text-emerald-100/90 outline-none" />
          <div className="border-t border-white/5 p-3">
            <textarea value={req} onChange={(e) => setReq(e.target.value)} rows={3}
              placeholder='Describe the change… e.g. "Add a vendors table linked to users, with Stripe subscription IDs and a status enum"'
              className="w-full resize-none rounded-lg border border-white/10 bg-[#0d1017] p-3 text-[13px] text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-cyan-500/50" />
            <div className="mt-2 flex items-center gap-2">
              <button onClick={() => generate(req)} disabled={busy || !req.trim() || !getApiKey()}
                className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-br from-cyan-500 to-blue-600 px-4 py-2 text-[12.5px] font-semibold text-white hover:from-cyan-400 hover:to-blue-500 disabled:opacity-40">
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />}
                Migrate
              </button>
              {result && (
                <button onClick={() => { void applyAll(); }}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-2 text-[12.5px] font-semibold text-emerald-200 hover:bg-emerald-500/20">
                  <ArrowRight className="h-3.5 w-3.5" /> Review drafts
                </button>
              )}
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {EXAMPLES.map((ex) => (
                <button key={ex} onClick={() => { setReq(ex); generate(ex); }}
                  className="rounded-full border border-white/10 bg-white/[0.02] px-2.5 py-1 text-[11px] text-zinc-400 hover:border-cyan-500/40 hover:text-zinc-200">
                  {ex}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          {!result && !busy && !error && (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-zinc-600">
              <FileDiff className="h-10 w-10" />
              <p className="max-w-xs text-[13px]">
                Describe a schema change in plain English and DevLab drafts a Prisma schema,
                a production SQL migration and the API routes for you to review.
              </p>
            </div>
          )}
          {busy && (
            <div className="flex h-full items-center justify-center gap-3 text-sm text-zinc-400">
              <Loader2 className="h-4 w-4 animate-spin text-cyan-400" /> Architecting migration…
            </div>
          )}
          {error && <div className="m-6 rounded-lg border border-rose-500/30 bg-rose-500/10 p-4 text-[13px] text-rose-200">{error}</div>}

          {result && (
            <>
              <div className="border-b border-white/5 px-5 py-3">
                <p className="text-[13px] leading-relaxed text-zinc-300">{result.summary}</p>
              </div>
              <div className="flex gap-4 border-b border-white/5 px-5 text-xs">
                {([
                  ["orm", "Prisma schema", FileDiff],
                  ["sql", "SQL migration", ScrollText],
                  ["routes", "API routes", Plug],
                ] as const).map(([id, label, Icon]) => (
                  <button key={id} onClick={() => setTab(id)} className={`-mb-px inline-flex items-center gap-1.5 border-b-2 px-1 py-2.5 font-medium ${tab === id ? "border-cyan-400 text-white" : "border-transparent text-zinc-500"}`}>
                    <Icon className="h-3.5 w-3.5" /> {label}
                  </button>
                ))}
                {result.checklist?.length > 0 && (
                  <div className="ml-auto flex items-center gap-1.5 py-2.5 text-[11px] text-emerald-300">
                    <ListChecks className="h-3.5 w-3.5" /> Deploy checklist below
                  </div>
                )}
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-5 pb-8">
                {tab === "orm" && <CodeBlock code={result.prisma} lang="prisma" />}
                {tab === "sql" && <CodeBlock code={result.sql} lang="sql" />}
                {tab === "routes" && <CodeBlock code={result.routes} lang="typescript" />}
                {result.checklist?.length > 0 && (
                  <div className="mt-5 rounded-xl border border-emerald-500/20 bg-emerald-500/[0.05] p-4">
                    <h4 className="mb-2 flex items-center gap-1.5 text-[12.5px] font-semibold text-emerald-300">
                      <ListChecks className="h-4 w-4" /> Safe deploy checklist
                    </h4>
                    <ol className="list-decimal space-y-1 pl-5 text-[12.5px] text-emerald-100/80">
                      {result.checklist.map((c, i) => <li key={i}>{c}</li>)}
                    </ol>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

const DEFAULT_SCHEMA = `datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "prisma-client-js"
}

model User {
  id        String   @id @default(uuid())
  email     String   @unique
  name      String?
  createdAt DateTime @default(now())
  posts     Post[]
}

model Post {
  id        String   @id @default(uuid())
  title     String
  body      String
  published Boolean  @default(false)
  author    User     @relation(fields: [authorId], references: [id])
  authorId  String
  createdAt DateTime @default(now())
}`;
