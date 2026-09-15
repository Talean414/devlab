import type { ProjectTemplate, ToolItem, CiTemplate } from "../types";

export const projectTemplates: ProjectTemplate[] = [
  {
    id: "vite-react-ts",
    name: "React + Vite + TS",
    stack: "Frontend",
    icon: "react",
    description: "Lightning-fast SPA scaffold with TypeScript, ESLint & Tailwind.",
    commands: [
      "npm create vite@latest my-app -- --template react-ts",
      "cd my-app && npm i",
      "npm i -D tailwindcss @tailwindcss/vite",
      "npm run dev",
    ],
    tags: ["react", "vite", "typescript"],
  },
  {
    id: "next-app",
    name: "Next.js App Router",
    stack: "Fullstack",
    icon: "next",
    description: "Production React framework with SSR, RSC & API routes.",
    commands: [
      "npx create-next-app@latest my-app --ts --tailwind --app",
      "cd my-app",
      "npm run dev",
    ],
    tags: ["next", "ssr", "fullstack"],
  },
  {
    id: "node-api",
    name: "Node + Express API",
    stack: "Backend",
    icon: "node",
    description: "REST API boilerplate with Express, dotenv & nodemon.",
    commands: [
      "mkdir my-api && cd my-api && npm init -y",
      "npm i express dotenv cors",
      "npm i -D nodemon typescript @types/express",
      "npm run dev",
    ],
    tags: ["node", "express", "api"],
  },
  {
    id: "python-fastapi",
    name: "Python FastAPI",
    stack: "Backend",
    icon: "python",
    description: "Async Python API with FastAPI, Uvicorn & Pydantic.",
    commands: [
      "python -m venv .venv && source .venv/bin/activate",
      "pip install fastapi 'uvicorn[standard]'",
      "uvicorn main:app --reload",
    ],
    tags: ["python", "fastapi", "async"],
  },
  {
    id: "rust-cli",
    name: "Rust CLI",
    stack: "Systems",
    icon: "rust",
    description: "Blazing CLI tool scaffold with Cargo & Clap.",
    commands: ["cargo new my-cli", "cd my-cli", "cargo add clap --features derive", "cargo run"],
    tags: ["rust", "cli", "systems"],
  },
  {
    id: "flutter-app",
    name: "Flutter Mobile",
    stack: "Mobile",
    icon: "flutter",
    description: "Cross-platform mobile app — replaces Android Studio setup.",
    commands: ["flutter create my_app", "cd my_app", "flutter run"],
    tags: ["flutter", "mobile", "dart"],
  },
  {
    id: "tauri-desktop",
    name: "Tauri Desktop",
    stack: "Desktop",
    icon: "tauri",
    description: "Native desktop app with Rust core + web frontend.",
    commands: ["npm create tauri-app@latest", "cd my-tauri-app && npm i", "npm run tauri dev"],
    tags: ["tauri", "desktop", "rust"],
  },
  {
    id: "docker-compose",
    name: "Dockerized Stack",
    stack: "Infra",
    icon: "docker",
    description: "Full compose stack: app + Postgres + Redis + nginx.",
    commands: ["docker compose up -d", "docker compose logs -f"],
    tags: ["docker", "infra", "compose"],
  },
];

export const tools: ToolItem[] = [
  {
    id: "roo-code",
    name: "Roo Code (AI Agent)",
    category: "AI Agent Hub",
    replaces: "ChatGPT / Cursor / Antigravity",
    description: "Autonomous coding agent wired to your Gemini key.",
    icon: "bot",
    vsix: "https://open-vsx.org/api/RooVeterinaryInc/roo-cline/latest/file/RooVeterinaryInc.roo-cline-latest.vsix",
    status: "baked-in",
  },
  {
    id: "continue",
    name: "Continue",
    category: "AI Agent Hub",
    replaces: "Copilot Chat",
    description: "Inline AI autocomplete & chat, BYOK model support.",
    icon: "arrow",
    vsix: "https://open-vsx.org/api/Continue/continue/latest/file/Continue.continue-latest.vsix",
    status: "baked-in",
  },
  {
    id: "rest-client",
    name: "REST Client",
    category: "API Testing",
    replaces: "Postman / Insomnia",
    description: "Send HTTP requests from .http files in-editor.",
    icon: "plug",
    vsix: "https://open-vsx.org/api/humao/rest-client/latest/file/humao.rest-client-latest.vsix",
    status: "baked-in",
  },
  {
    id: "thunder",
    name: "Thunder Client",
    category: "API Testing",
    replaces: "Postman",
    description: "Lightweight GUI REST client.",
    icon: "plug",
    vsix: "https://open-vsx.org/api/rangav/vscode-thunder-client/latest/file/rangav.vscode-thunder-client-latest.vsix",
    status: "one-click",
  },
  {
    id: "database-client",
    name: "Database Client",
    category: "Database GUI",
    replaces: "DBeaver / pgAdmin",
    description: "Postgres, MySQL, Redis, MongoDB in one panel.",
    icon: "db",
    vsix: "https://open-vsx.org/api/cweijan/vscode-database-client2/latest/file/cweijan.vscode-database-client2-latest.vsix",
    status: "baked-in",
  },
  {
    id: "docker",
    name: "Docker & Containers",
    category: "Infrastructure",
    replaces: "Docker Desktop GUI",
    description: "Build, run & inspect containers and images.",
    icon: "container",
    vsix: "https://open-vsx.org/api/ms-azuretools/vscode-docker/latest/file/ms-azuretools.vscode-docker-latest.vsix",
    status: "baked-in",
  },
  {
    id: "gitlens",
    name: "GitLens",
    category: "Source Control",
    replaces: "GitKraken / SourceTree",
    description: "Supercharged Git blame, history & visual graph.",
    icon: "git",
    vsix: "https://open-vsx.org/api/eamodio/gitlens/latest/file/eamodio.gitlens-latest.vsix",
    status: "baked-in",
  },
  {
    id: "preview",
    name: "Live Preview",
    category: "Runtime Preview",
    replaces: "Browser tabs",
    description: "Embedded webview for local dev servers.",
    icon: "eye",
    status: "baked-in",
  },
  {
    id: "k8s",
    name: "Kubernetes",
    category: "Infrastructure",
    replaces: "Lens / k9s",
    description: "Manage clusters, pods & manifests.",
    icon: "cloud",
    vsix: "https://open-vsx.org/api/ms-kubernetes-tools/vscode-kubernetes-tools/latest/file/ms-kubernetes-tools.vscode-kubernetes-tools-latest.vsix",
    status: "one-click",
  },
  {
    id: "gha",
    name: "GitHub Actions",
    category: "CI/CD",
    replaces: "CI dashboards",
    description: "Author & monitor workflows without leaving the lab.",
    icon: "rocket",
    vsix: "https://open-vsx.org/api/github/vscode-github-actions/latest/file/github.vscode-github-actions-latest.vsix",
    status: "baked-in",
  },
  {
    id: "prettier",
    name: "Prettier",
    category: "Quality",
    replaces: "manual formatting",
    description: "Opinionated code formatter for every language.",
    icon: "wand",
    vsix: "https://open-vsx.org/api/esbenp/prettier-vscode/latest/file/esbenp.prettier-vscode-latest.vsix",
    status: "baked-in",
  },
  {
    id: "eslint",
    name: "ESLint",
    category: "Quality",
    replaces: "external linters",
    description: "Real-time JS/TS linting & auto-fix.",
    icon: "brush",
    vsix: "https://open-vsx.org/api/dbaeumer/vscode-eslint/latest/file/dbaeumer.vscode-eslint-latest.vsix",
    status: "baked-in",
  },
  {
    id: "remote-ssh",
    name: "Remote — SSH",
    category: "Infrastructure",
    replaces: "PuTTY / terminal SSH",
    description: "Edit code on remote servers seamlessly.",
    icon: "server",
    status: "one-click",
  },
];

export const ciTemplates: CiTemplate[] = [
  {
    id: "node-ci",
    name: "Node.js CI",
    provider: "GitHub Actions",
    description: "Install, lint, test & build on push/PR.",
    filename: ".github/workflows/node-ci.yml",
    yaml: `name: Node CI
on:
  push: { branches: [main] }
  pull_request: { branches: [main] }
jobs:
  build:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [18, 20, 22]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: \${{ matrix.node }}
          cache: npm
      - run: npm ci
      - run: npm run lint --if-present
      - run: npm test --if-present
      - run: npm run build --if-present`,
  },
  {
    id: "docker-deploy",
    name: "Docker Build & Push",
    provider: "GitHub Actions",
    description: "Build image and push to GHCR on release.",
    filename: ".github/workflows/docker.yml",
    yaml: `name: Docker
on:
  push: { tags: ['v*'] }
jobs:
  docker:
    runs-on: ubuntu-latest
    permissions: { contents: read, packages: write }
    steps:
      - uses: actions/checkout@v4
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: \${{ github.actor }}
          password: \${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@v6
        with:
          push: true
          tags: ghcr.io/\${{ github.repository }}:latest`,
  },
  {
    id: "deploy-pages",
    name: "Deploy to Pages",
    provider: "GitHub Actions",
    description: "Static site build & deploy to GitHub Pages.",
    filename: ".github/workflows/pages.yml",
    yaml: `name: Deploy Pages
on:
  push: { branches: [main] }
permissions: { contents: read, pages: write, id-token: write }
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: github-pages
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci && npm run build
      - uses: actions/upload-pages-artifact@v3
        with: { path: dist }
      - uses: actions/deploy-pages@v4`,
  },
  {
    id: "python-ci",
    name: "Python CI",
    provider: "GitHub Actions",
    description: "Ruff lint + pytest across Python versions.",
    filename: ".github/workflows/python.yml",
    yaml: `name: Python CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix: { python: ['3.10', '3.11', '3.12'] }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: \${{ matrix.python }} }
      - run: pip install ruff pytest -r requirements.txt
      - run: ruff check .
      - run: pytest`,
  },
];

export const dockerfileTemplate = `# Multi-stage production Dockerfile
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]`;

export const composeTemplate = `services:
  app:
    build: .
    ports: ["3000:3000"]
    depends_on: [db, cache]
    environment:
      DATABASE_URL: postgres://dev:dev@db:5432/app
      REDIS_URL: redis://cache:6379
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: dev
      POSTGRES_PASSWORD: dev
      POSTGRES_DB: app
    ports: ["5432:5432"]
    volumes: [pgdata:/var/lib/postgresql/data]
  cache:
    image: redis:7-alpine
    ports: ["6379:6379"]
volumes:
  pgdata:`;
