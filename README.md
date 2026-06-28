# 🤖 Claude-Lens — A Production Backend Written Entirely by AI

> **Zero lines written by a human.** Every file in this repository was authored by **Claude Code** across live sessions. I directed the work and watched it happen — I never typed a single line of code.

[![Human-written lines](https://img.shields.io/badge/human_written_lines-0-ff5252.svg)](#-built-entirely-by-ai)
[![Built with](https://img.shields.io/badge/built_with-Claude_Code-8a3ffc.svg)](https://claude.com/claude-code)
[![TypeScript](https://img.shields.io/badge/typescript-6.0-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/node.js-18.x+-green.svg)](https://nodejs.org/)
[![Express](https://img.shields.io/badge/express-5.2.1-black.svg)](https://expressjs.com/)
[![MongoDB](https://img.shields.io/badge/mongodb-mongoose_9-47A248.svg)](https://www.mongodb.com/)
[![WebSocket](https://img.shields.io/badge/transport-WebSocket-orange.svg)](https://github.com/websockets/ws)
[![License](https://img.shields.io/badge/license-MIT-yellow.svg)](LICENSE)

**Claude-Lens** is a local WebSocket server that runs on your Mac, spawns the **Claude CLI**, and streams live coding sessions to a web UI — so you can use Claude Code from any browser or phone, on your own subscription, with full access to your local files and MCP servers. Every completed session auto-syncs to MongoDB.

And the whole thing — the streaming engine, the cross-machine resume, the browser-based tool approval, the IDE bridge — was **built start to finish by AI**.

---

## 🤖 Built Entirely by AI

This is the part worth pausing on.

I did not write this code. I opened fresh **Claude Code** sessions, described what I wanted, reviewed what came back, and asked for the next thing. Claude Code wrote **every controller, service, model, WebSocket handler, and utility** in this repo — including the genuinely hard parts:

- A persistent `claude` process driven over `stream-json` with token-by-token streaming.
- Cross-machine session resume with path remapping, R2 backup restore, and lossless JSONL reconstruction.
- A browser-based tool-approval flow wired through a `PreToolUse` hook.
- A live IntelliJ IDE bridge over the MCP protocol.

My role was **direction and review**, not authorship. I was in the room — I just never touched the keyboard for the code.

If you're curious what an AI agent can ship when pointed at a real, multi-week project: **this repository is the answer.**

---

## ✨ Why Claude-Lens

The Claude CLI is fantastic — but it lives in your terminal, on one machine. Claude-Lens lifts it into the browser:

- 🌍 **Use Claude Code from anywhere** — laptop, phone, tablet — while it runs on your Mac.
- 🔑 **Your subscription, your machine** — uses your local `claude` CLI login, your files, your MCP servers.
- 💬 **A real chat UI** — streaming responses, attachments, voice, and a full session history.
- 🗄️ **Nothing is lost** — every session is synced to MongoDB and (optionally) backed up to Cloudflare R2.

> This repo is the **backend**. It pairs with a Next.js frontend (deployed on Vercel) that connects directly over WebSocket. Frontend repo: **[Claude-Lens-Next.js](https://github.com/chayan-1906/Claude-Lens-Next.js)**.

---

## 🚀 Key Features

### 💬 Live Chat Engine
- **Token-by-token streaming** from the `claude` CLI via `--output-format stream-json --include-partial-messages`.
- **Persistent process** — follow-up messages are written to the same process's stdin as NDJSON; no re-spawn per turn.
- **Multimodal input** — images, PDFs, and text/code files attached to any message.

### 🛡️ Browser-Based Tool Approval
- A `PreToolUse` hook routes every `Edit` / `Write` / `Bash` / MCP call back to the backend, which asks **you** — in the browser — to approve or deny, with a diff view.
- **"Allow All"** persists a tool into the project's `settings.local.json` so future sessions skip the prompt.
- Falls back to the native terminal prompt when the backend isn't reachable.

### 🔁 Cross-Machine Resume (the hard one)
- Resume a session started on a **different machine**. Claude-Lens resolves path aliases (`/Users` ↔ `/Volumes`), restores the JSONL from **R2 backup** or **reconstructs it losslessly from MongoDB**, and **repairs** orphaned tool-call history so the Anthropic API accepts it.

### 🧠 IntelliJ IDE Bridge
- Connects to the JetBrains Claude Code plugin over MCP, opens diffs **in your IDE** in sync with the browser approval prompt, and mirrors your IDE edits back into the conversation.

### 🎙️ Voice In & Out
- **Speech-to-text** via Groq Whisper, cleaned up by LLaMA for natural phrasing.
- **Text-to-speech** via Microsoft Edge Neural voices.

### 📦 Everything Else
- 📄 **PDF export** of any session (Puppeteer + Markdown + syntax highlighting).
- 🔍 **Full-text search** across messages, sessions, tasks, and memories.
- 🗜️ **ZIP export / import** of whole projects (sessions, memories, tasks, manifest).
- 🧩 **Memory & task sync** from `~/.claude/` into MongoDB.
- ☁️ **Cloudflare R2 attachments** with automatic HEIC → JPEG conversion.
- 🔧 **Multi-database & multi-account** — switch MongoDB configs and Claude accounts from a Setup UI.

---

## 🏗️ Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                  FRONTEND  (Next.js • Vercel)                │
│                     Browser / Phone / Tablet                 │
└───────────────────────────────┬──────────────────────────────┘
                                │  WebSocket  (ws://…/ws) 
                                │  via Cloudflare Tunnel 
                                ▼ 
┌──────────────────────────────────────────────────────────────┐
│        CLAUDE-LENS BACKEND  —  your Mac, port 20261          │
│        (Express 5 + ws · this repository)                    │
├──────────────────────────────────────────────────────────────┤
│  • WebSocketHandler  — session lifecycle, streaming, backups │
│  • claudeSpawner     — spawns CLI, line-buffers stream-json  │
│  • Tool-Approval hook — PreToolUse → browser approve/deny    │
│  • REST API          — sessions, tasks, memories, search…    │
└───────┬───────────────────────────┬──────────────────────────┘
        │ child_process.spawn       │  Mongoose  
        ▼                           ▼
   ┌──────────┐               ┌───────────────┐     ┌──────────┐
   │  claude  │               │  MongoDB Atlas│     │Cloudflare│
   │   CLI    │  reads local  │  sessions •   │     │   R2     │
   │          │  files + MCP  │  messages •   │     │ backups +│
   └──────────┘               │  tasks · mem  │     │ uploads  │
                              └───────────────┘     └──────────┘
```

---

## 🧬 How It Works

1. The frontend opens a WebSocket and sends `new_session` / `resume_session`.
2. The backend spawns `claude -p --verbose --output-format stream-json --input-format stream-json …` as a **persistent** process.
3. `stdout` arrives in chunks → a **line buffer** splits it into JSON events → forwarded to the browser in real time. Follow-up turns are written to `stdin` as NDJSON (no re-spawn).
4. As messages stream, they're **direct-written to MongoDB**; on completion the JSONL file is **synced** to backfill the lossless record.
5. When the CLI wants to run a tool, the global `PreToolUse` hook `curl`s the backend, which forwards the request to your browser and **blocks** until you approve or deny.
6. On exit, the session is synced and (optionally) the JSONL is backed up to R2.

---

## 🛠️ Tech Stack

- 🟦 **TypeScript** — type-safe throughout
- 🚀 **Express 5** — REST API + HTTP server
- 🔌 **ws** — WebSocket server attached at `/ws`
- 🧠 **child_process.spawn** — drives the `claude` CLI
- 🍃 **MongoDB + Mongoose 9** — session / message / task / memory store
- ☁️ **Cloudflare R2 (`@aws-sdk/client-s3`)** — attachments + JSONL backups
- 🎙️ **Groq SDK** — Whisper STT + LLaMA rephrase
- 🔊 **msedge-tts** — neural text-to-speech
- 📄 **Puppeteer + marked + highlight.js** — PDF export
- 🖼️ **sharp + heic-convert** — image processing
- 🗜️ **archiver + adm-zip + multer** — ZIP export / import

---

## ⚙️ Quick Start

### Prerequisites

- **Node.js** 18+
- **Claude CLI** installed and logged in — `claude` must be on your `PATH` ([install guide](https://docs.claude.com/en/docs/claude-code/overview))
- **MongoDB** — a free [Atlas](https://www.mongodb.com/cloud/atlas/register) cluster or a local instance

### Installation

```bash
# 1. Clone
git clone https://github.com/chayan-1906/Claude-Lens-Node.js.git
cd Claude-Lens-Node.js

# 2. Install
npm install

# 3. Configure environment
cp .env.example .env
#   then edit .env  (see "Environment Variables" below)

# 4. Run (registers the PreToolUse hook, then starts with hot reload)
npm run dev
```

You should see:

```
Server started on 20261
    - Local:        http://localhost:20261
    - Network:      http://<your-ip>:20261
    - WebSocket:    ws://localhost:20261/ws
```

The frontend connects directly to `ws://localhost:20261/ws`. To reach it from your phone, expose the port with a **Cloudflare Tunnel**.

---

## 🔧 Environment Variables

Copy `.env.example` → `.env` and fill in what you need. Most secrets are **optional at the file level** — you can configure MongoDB, R2, and Groq at runtime from the **Setup UI** (`/api/v1/setup/*`), in which case they're stored in `~/.claude-lens/config.json`.

| Variable                       | Required | Example / Format                                                                 | How to get it |
|--------------------------------|----------|----------------------------------------------------------------------------------|---------------|
| `NODE_ENV`                     | ✅        | `development`                                                                     | — |
| `PORT`                         | ✅        | `20261`                                                                           | Any free port; frontend connects to `ws://localhost:<PORT>/ws` |
| `MONGO_URI`                    | recommended | `mongodb+srv://user:pass@cluster.mongodb.net/claude-lens`                     | Free cluster at [MongoDB Atlas](https://www.mongodb.com/cloud/atlas/register), or `mongodb://localhost:27017/claude-lens`. Can be set via the Setup UI instead. |
| `BACKEND_URL`                  | ✅        | `http://localhost:20261`                                                          | Your backend's base URL |
| `FRONTEND_URL`                 | ✅        | `http://localhost:3000`                                                           | Your Next.js app's origin (used for CORS) |
| `APP_VERSION`                  | ✅        | `1.0.0`                                                                           | — |
| `GROQ_API_KEY`                 | optional | `gsk_…`                                                                           | Free key at [console.groq.com](https://console.groq.com) → API Keys. Enables voice input. |
| `CLOUDFLARE_ACCESS_KEY_ID`     | optional | `58a2f8…`                                                                         | [Cloudflare R2](https://dash.cloudflare.com) → Manage R2 API Tokens |
| `CLOUDFLARE_SECRET_ACCESS_KEY` | optional | `4501213…`                                                                        | Same token as above |
| `CLOUDFLARE_R2_ENDPOINT`       | optional | `https://<account-id>.r2.cloudflarestorage.com`                                   | R2 dashboard → bucket settings |
| `CLOUDFLARE_R2_PUBLIC_URL`     | optional | `https://<public-bucket-id>.r2.dev`                                               | R2 → bucket → Public access |
| `CLOUDFLARE_R2_BUCKET_NAME`    | optional | `claude-lens`                                                                     | The bucket you created |

> 💡 **No secrets in git.** `.env` is gitignored — only `.env.example` (placeholders) is tracked.

---

## 🔌 The Tool-Approval Hook

`npm run dev` automatically registers a `PreToolUse` hook in `~/.claude/settings.json` (see `scripts/register-hook.mjs`). When the CLI is about to run a tool, the hook (`hooks/pretooluse-approval.sh`) POSTs the request to `http://localhost:20261/api/v1/tool-approval`. The backend forwards it to your browser over WebSocket and **waits** for your decision — approve, deny, or "Allow All".

If the backend isn't running, the hook cleanly falls back to Claude Code's native terminal prompt, so your normal CLI usage is never blocked.

---

## 🗂️ Project Structure

```
project/
├── src/
│   ├── server.ts                 # Express + WebSocket entry point
│   ├── config/                   # env config + MongoDB connection
│   ├── controllers/              # REST request handlers (14)
│   ├── services/                 # business logic (11)
│   ├── models/                   # Mongoose schemas (Session, Message, Task, …)
│   ├── routes/                   # API route definitions
│   ├── ws/
│   │   ├── WebSocketHandler.ts   # session lifecycle, streaming, backups
│   │   ├── claudeSpawner.ts      # spawns CLI, parses stream-json
│   │   ├── IdeService.ts         # IntelliJ MCP bridge
│   │   └── toolApprovalStore.ts  # pending approvals registry
│   ├── permissions/              # settings.local.json allow-list writer
│   ├── utils/                    # R2, JSONL parsing, PDF, search, …
│   └── types/                    # TypeScript interfaces
├── hooks/pretooluse-approval.sh  # PreToolUse approval hook
├── scripts/                      # hook registration + packaging
├── .env.example                  # environment template
└── package.json
```

---

## 📦 NPM Scripts

```bash
npm run dev        # register hook + start with hot reload (nodemon + ts-node)
npm run build      # compile TypeScript → dist/
npm start          # run compiled server
npm run package    # build a standalone executable (ncc + pkg)
```

---

## 🔭 Companion Frontend

The browser UI is a separate Next.js app deployed on Vercel. It connects straight to this backend over WebSocket — no tunnel needed for local use.

➡️ **[github.com/chayan-1906/Claude-Lens-Next.js](https://github.com/chayan-1906/Claude-Lens-Next.js)**

---

## 🤝 Contributing

Contributions are welcome! (Yes — even to a repo written by AI.)

1. Fork the project
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

---

## 👨‍💻 Author

**Padmanabha Das**

- 📧 Email: [padmanabhadas9647@gmail.com](mailto:padmanabhadas9647@gmail.com)
- 💼 LinkedIn: [linkedin.com/in/padmanabha-das-59bb2019b](https://www.linkedin.com/in/padmanabha-das-59bb2019b/)
- 🐙 GitHub: [github.com/chayan-1906](https://github.com/chayan-1906)
- 📝 Medium: [chayan-1906.medium.com](https://chayan-1906.medium.com/)
- 💻 Dev.to: [dev.to/chayan-1906](https://dev.to/chayan-1906)

---

## 🙏 Acknowledgments

- **Claude Code** — which wrote every line of this project.
- **Anthropic** — for the Claude CLI and the agentic tooling that made this possible.
- **MongoDB**, **Cloudflare R2**, **Groq**, and the **open-source community** for the building blocks.

---

## 🌟 Show Your Support

If a 100%-AI-built backend made you do a double-take, give it a ⭐️!

## 📱 Connect With Me

[![LinkedIn](https://img.shields.io/badge/LinkedIn-Connect-blue)](https://www.linkedin.com/in/padmanabha-das-59bb2019b/)
[![GitHub](https://img.shields.io/badge/GitHub-Follow-black)](https://github.com/chayan-1906)

## 🔗 License

This project is licensed under the **MIT License** — see the [LICENSE](LICENSE) file for details.

---

<div align="center">
  <p>Made with ❤️ — but written entirely by 🤖 <strong>Claude Code</strong>.</p>
  <p>Directed (never typed) by <a href="https://github.com/chayan-1906">Padmanabha Das</a>.</p>
  <p>⭐ Star this repo if an AI-built project impressed you!</p>
</div>
