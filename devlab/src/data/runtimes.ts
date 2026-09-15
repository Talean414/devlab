import type { Runtime, DeployProvider } from "../types";

export const runtimes: Runtime[] = [
  // ── Languages ──
  { id: "node",    name: "Node.js",       version: "22 LTS", category: "Language", description: "JavaScript/TypeScript runtime with npm, pnpm, yarn, bun.", install: "# via fnm (fast node manager)\ncurl -fsSL https://fnm.vercel.app/install | bash\nfnm install 22 && fnm default 22", verify: "node -v && npm -v" },
  { id: "python",  name: "Python",        version: "3.12",   category: "Language", description: "CPython with pip, venv, poetry and uv package managers.", install: "# via uv (fastest installer)\ncurl -LsSf https://astral.sh/uv/install.sh | sh\nuv python install 3.12", verify: "python3 --version && uv --version" },
  { id: "rust",    name: "Rust",          version: "stable", category: "Language", description: "Cargo, rustc, clippy, rustfmt and rust-analyzer LSP.", install: "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh\nrustup component add clippy rustfmt rust-analyzer", verify: "rustc --version && cargo --version" },
  { id: "go",      name: "Go",            version: "1.23",   category: "Language", description: "Go toolchain with gopls language server and delve debugger.", install: "# Linux/macOS\ncurl -LO https://go.dev/dl/go1.23.0.linux-amd64.tar.gz\nsudo tar -C /usr/local -xzf go1.23.0.linux-amd64.tar.gz\necho 'export PATH=$PATH:/usr/local/go/bin' >> ~/.bashrc", verify: "go version" },
  { id: "java",    name: "Java (JDK)",    version: "21 LTS", category: "Language", description: "OpenJDK with Maven, Gradle and JDTLS language server.", install: "# via SDKMAN\ncurl -s https://get.sdkman.io | bash\nsdk install java 21.0.4-tem\nsdk install maven && sdk install gradle", verify: "java -version && mvn -v" },
  { id: "dotnet",  name: ".NET",          version: "9.0",    category: "Language", description: "C# / F# SDK with OmniSharp and dotnet CLI.", install: "curl -sSL https://dot.net/v1/dotnet-install.sh | bash /dev/stdin --channel 9.0", verify: "dotnet --version" },
  { id: "php",     name: "PHP",           version: "8.3",    category: "Language", description: "PHP with Composer and Laravel/Symfony support.", install: "# Debian/Ubuntu\nsudo add-apt-repository ppa:ondrej/php -y\nsudo apt install php8.3-cli php8.3-xml php8.3-mbstring -y\ncurl -sS https://getcomposer.org/installer | php", verify: "php -v && composer -V" },
  { id: "ruby",    name: "Ruby",          version: "3.3",    category: "Language", description: "Ruby with Bundler, Rails and Solargraph LSP.", install: "# via rbenv\ncurl -fsSL https://rbenv.org/install.sh | bash\nrbenv install 3.3.5 && rbenv global 3.3.5\ngem install bundler rails", verify: "ruby -v && gem -v" },
  { id: "elixir",  name: "Elixir",        version: "1.17",   category: "Language", description: "Erlang/OTP + Elixir with Phoenix and Mix.", install: "# via asdf\nasdf plugin add erlang && asdf plugin add elixir\nasdf install erlang 27.0 && asdf install elixir 1.17.2", verify: "elixir -v" },
  { id: "deno",    name: "Deno",          version: "2.x",    category: "Language", description: "Secure TypeScript-first runtime with built-in tooling.", install: "curl -fsSL https://deno.land/install.sh | sh", verify: "deno --version" },
  { id: "bun",     name: "Bun",           version: "1.x",    category: "Language", description: "All-in-one JS runtime, bundler, test runner and package manager.", install: "curl -fsSL https://bun.sh/install | bash", verify: "bun --version" },
  { id: "zig",     name: "Zig",           version: "0.13",   category: "Language", description: "Low-level systems language and C/C++ cross-compiler.", install: "# via zvm\ncurl https://raw.githubusercontent.com/tristanisham/zvm/master/install.sh | bash\nzvm i 0.13.0", verify: "zig version" },

  // ── Mobile ──
  { id: "flutter", name: "Flutter",       version: "3.x",    category: "Mobile",   description: "Cross-platform mobile/desktop/web from one Dart codebase.", install: "git clone https://github.com/flutter/flutter.git -b stable ~/flutter\necho 'export PATH=$PATH:$HOME/flutter/bin' >> ~/.bashrc\nflutter doctor", verify: "flutter --version" },
  { id: "android", name: "Android SDK",   version: "34",     category: "Mobile",   description: "Headless Android SDK + emulator — no Android Studio needed.", install: "# cmdline-tools only (no IDE)\nmkdir -p ~/Android/cmdline-tools && cd ~/Android/cmdline-tools\ncurl -LO https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip\nunzip commandlinetools-*.zip && mv cmdline-tools latest\nyes | ~/Android/cmdline-tools/latest/bin/sdkmanager --licenses\nsdkmanager 'platform-tools' 'platforms;android-34' 'build-tools;34.0.0'", verify: "adb --version" },
  { id: "reactnative", name: "React Native", version: "0.76", category: "Mobile", description: "Native mobile apps with React + Expo tooling.", install: "npm i -g expo-cli eas-cli\nnpx create-expo-app@latest my-app", verify: "npx expo --version" },

  // ── Infra ──
  { id: "docker",  name: "Docker Engine", version: "27.x",   category: "Infra",    description: "Container runtime, compose v2 and buildx.", install: "curl -fsSL https://get.docker.com | sh\nsudo usermod -aG docker $USER && newgrp docker", verify: "docker --version && docker compose version" },
  { id: "k8s",     name: "Kubernetes CLI",version: "1.31",   category: "Infra",    description: "kubectl, k9s, helm and kind for local clusters.", install: "curl -LO \"https://dl.k8s.io/release/$(curl -Ls https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl\"\nsudo install kubectl /usr/local/bin/\ncurl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash\ngo install sigs.k8s.io/kind@latest", verify: "kubectl version --client && helm version" },
  { id: "terraform", name: "Terraform / OpenTofu", version: "1.8", category: "Infra", description: "Declarative infrastructure as code for any cloud.", install: "curl --proto '=https' --tlsv1.2 -fsSL https://get.opentofu.org/install-opentofu.sh | sh -s -- --install-method standalone", verify: "tofu version" },
  { id: "ansible", name: "Ansible",       version: "10.x",   category: "Infra",    description: "Agentless configuration management and orchestration.", install: "uv tool install ansible-core\n# or: pipx install ansible-core", verify: "ansible --version" },

  // ── Databases ──
  { id: "postgres", name: "PostgreSQL",   version: "16",     category: "Database", description: "Advanced open-source relational database + psql client.", install: "docker run -d --name pg -e POSTGRES_PASSWORD=dev -p 5432:5432 postgres:16-alpine\n# native: sudo apt install postgresql-16 postgresql-client-16", verify: "psql --version" },
  { id: "mysql",   name: "MySQL / MariaDB", version: "8.4",  category: "Database", description: "Popular relational database with mysql CLI.", install: "docker run -d --name mysql -e MYSQL_ROOT_PASSWORD=dev -p 3306:3306 mysql:8.4", verify: "mysql --version" },
  { id: "redis",   name: "Redis",         version: "7.4",    category: "Database", description: "In-memory key-value store, cache and message broker.", install: "docker run -d --name redis -p 6379:6379 redis:7-alpine", verify: "redis-cli --version" },
  { id: "mongo",   name: "MongoDB",       version: "8.0",    category: "Database", description: "Document-oriented NoSQL database with mongosh.", install: "docker run -d --name mongo -p 27017:27017 mongo:8", verify: "mongosh --version" },
  { id: "sqlite",  name: "SQLite",        version: "3.46",   category: "Database", description: "Zero-config embedded SQL database engine.", install: "sudo apt install sqlite3 -y  # or: brew install sqlite", verify: "sqlite3 --version" },

  // ── CLI tooling ──
  { id: "git",     name: "Git",           version: "2.46",   category: "CLI",      description: "Distributed version control with LFS and delta diffs.", install: "sudo apt install git git-lfs -y\ncargo install git-delta", verify: "git --version" },
  { id: "gh",      name: "GitHub CLI",    version: "2.x",    category: "CLI",      description: "Manage repos, PRs, issues, releases and Actions from the shell.", install: "curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg\nsudo apt update && sudo apt install gh -y\ngh auth login", verify: "gh --version" },
  { id: "aider",   name: "Aider",         version: "latest", category: "AI CLI",   description: "Terminal-based AI pair programmer that edits your git repo.", install: "uv tool install aider-chat\nexport GEMINI_API_KEY=your_key\naider --model gemini/gemini-3.6-flash", verify: "aider --version" },
  { id: "ollama",  name: "Ollama",        version: "latest", category: "AI CLI",   description: "Run Llama, Mistral, Qwen and DeepSeek models fully offline.", install: "curl -fsSL https://ollama.com/install.sh | sh\nollama pull qwen2.5-coder:7b", verify: "ollama --version" },
  { id: "modern",  name: "Modern CLI Kit",version: "—",      category: "CLI",      description: "ripgrep, fd, bat, eza, fzf, zoxide, jq, yq, httpie, lazygit.", install: "cargo install ripgrep fd-find bat eza zoxide\nsudo apt install fzf jq httpie -y\ngo install github.com/mikefarah/yq/v4@latest\n# lazygit\ngo install github.com/jesseduffield/lazygit@latest", verify: "rg --version && bat --version && lazygit --version" },
];

export const deployProviders: DeployProvider[] = [
  {
    id: "vercel", name: "Vercel", tagline: "Frontend cloud with edge functions and instant previews.",
    freeTier: "Hobby: 100 GB bandwidth, unlimited sites", color: "#ffffff",
    cliInstall: "npm i -g vercel", deployCmd: "vercel --prod",
    docs: "https://vercel.com/docs/cli", tokenLabel: "Vercel Token",
    supports: ["Next.js", "React", "Vue", "SvelteKit", "Astro", "Static", "Serverless"],
  },
  {
    id: "netlify", name: "Netlify", tagline: "Git-driven static hosting with serverless functions.",
    freeTier: "Starter: 100 GB bandwidth, 300 build min/mo", color: "#32e6e2",
    cliInstall: "npm i -g netlify-cli", deployCmd: "netlify deploy --prod",
    docs: "https://docs.netlify.com/cli/get-started/", tokenLabel: "Netlify Auth Token",
    supports: ["Static", "React", "Vue", "Astro", "Edge Functions", "Forms"],
  },
  {
    id: "render", name: "Render", tagline: "Full-stack cloud: web services, workers, Postgres, cron.",
    freeTier: "Free web services + Postgres (90 days)", color: "#46e3b7",
    cliInstall: "brew install render  # or use render.yaml Blueprint",
    deployCmd: "git push render main   # auto-deploy on push",
    docs: "https://render.com/docs", tokenLabel: "Render API Key",
    supports: ["Docker", "Node", "Python", "Go", "Rust", "Postgres", "Redis", "Cron"],
  },
  {
    id: "railway", name: "Railway", tagline: "Instant infra: deploy apps, DBs and services from a repo.",
    freeTier: "$5 trial credit / mo on hobby plan", color: "#a77dff",
    cliInstall: "npm i -g @railway/cli", deployCmd: "railway up",
    docs: "https://docs.railway.app/develop/cli", tokenLabel: "Railway Token",
    supports: ["Docker", "Node", "Python", "Go", "Postgres", "MySQL", "Redis", "Mongo"],
  },
  {
    id: "fly", name: "Fly.io", tagline: "Run containers close to users on a global edge network.",
    freeTier: "Pay-as-you-go with generous free allowances", color: "#8b5cf6",
    cliInstall: "curl -L https://fly.io/install.sh | sh", deployCmd: "fly launch && fly deploy",
    docs: "https://fly.io/docs/flyctl/", tokenLabel: "Fly API Token",
    supports: ["Docker", "Any language", "Postgres", "Volumes", "Global regions"],
  },
  {
    id: "cloudflare", name: "Cloudflare Pages / Workers", tagline: "Edge compute and static hosting on 300+ POPs.",
    freeTier: "Unlimited static requests, 100k Worker req/day", color: "#f6821f",
    cliInstall: "npm i -g wrangler", deployCmd: "wrangler deploy   # or: wrangler pages deploy ./dist",
    docs: "https://developers.cloudflare.com/workers/wrangler/", tokenLabel: "Cloudflare API Token",
    supports: ["Static", "Workers", "D1", "R2", "KV", "Durable Objects"],
  },
  {
    id: "supabase", name: "Supabase", tagline: "Open-source Firebase: Postgres, auth, storage, realtime.",
    freeTier: "2 free projects, 500 MB DB, 1 GB storage", color: "#3ecf8e",
    cliInstall: "npm i -g supabase", deployCmd: "supabase link --project-ref <ref> && supabase db push",
    docs: "https://supabase.com/docs/guides/cli", tokenLabel: "Supabase Access Token",
    supports: ["Postgres", "Auth", "Storage", "Edge Functions", "Realtime"],
  },
  {
    id: "ghpages", name: "GitHub Pages", tagline: "Free static hosting straight from your repository.",
    freeTier: "Unlimited public sites, 1 GB each", color: "#e5e7eb",
    cliInstall: "# uses GitHub Actions - no CLI needed",
    deployCmd: "git push origin main   # triggers pages.yml workflow",
    docs: "https://docs.github.com/pages", tokenLabel: "GitHub Token (repo scope)",
    supports: ["Static", "Jekyll", "Docs", "SPA"],
  },
];
