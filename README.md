# TuiEngine 🛠️

A high-performance, authoritative multiplayer **SSH & Web TUI Game Engine** powered by **Bun** and **OpenTUI**. 

TuiEngine provides a blank-slate starter kit that handles all the complex infrastructure—real-time sockets, client sizing, multi-protocol routing (SSH & WebSockets), SQLite schemas, admin dashboard control panels, and Docker orchestration—allowing you to focus entirely on writing your game mechanics and drawing ANSI graphics.

---

## Key Features Out-of-the-Box

1. **Dual Network Server**:
   * **Native SSH Game Server (Port 10022)**: Playable directly from standard command-line terminals (`ssh localhost -p 10022`).
   * **Web Client & WebSocket Bridge (Port 13000)**: Serves a premium, glassmorphic browser shell containing an `xterm.js` viewport that proxies keystrokes to the SSH server. Includes rate-limiting (max 5 connections per IP) and local storage session tokens.
2. **Authoritative Engine Loop**:
   * Centrally managed client input action queue to prevent race conditions.
   * Adjustable tick rate (default 300ms) with automated ticks.
   * Auto-saving and garbage collection sweeps for empty game instances.
3. **Modular SQLite Layer (`bun:sqlite`)**:
   * Pre-packaged tables for Account Management, SSH Keys (for passwordless authentication), Bans, Admin logs, Chat histories, and resumption tokens.
   * Schema extension hook (`onDatabaseInit`) to declare your own custom tables (e.g., inventories, scores, maps).
1. **Customizable Admin Console (Port 10023)**:
   * A beautiful 3-column admin console terminal.
   * Trust On First Use (TOFU) key fingerprint security.
   * Commands to `/broadcast` server announcements, `/kick` or `/ban` players, schedule `/maintenance` restarts, and register custom administration commands.
5. **Programmatic AI Gateway (MCP)**:
   * Built-in Model Context Protocol (MCP) Server.
   * Exposes tools allowing AI agents or bots to authenticate, query views, and trigger custom game actions programmatically.
6. **Docker & VPS Orchestration**:
   * Multi-stage slim Docker image with performance tweaks (curve25519 patch for Bun ARM64 Linux).
   * Docker Compose setups to launch isolated TUI and Web containers.

---

## Directory Structure

```
tuiengine/
├── package.json               # dependencies (opentui, mcp-sdk, ssh2)
├── tsconfig.json              # bun and strictly checked ts configs
├── Dockerfile                 # multi-stage slim container
├── docker-compose.yml         # game-server & web-server compose layout
├── README.md                  # this developer guide
├── scripts/
│   └── patch-opentui.js       # patches for opentui-ssh exec/auth logic
├── src/
│   ├── index.ts               # main module exports & master TuiEngine bootstrapper
│   ├── config.ts              # port / title config manager (config.json)
│   ├── db/
│   │   ├── client.ts          # generic DB connection + server state key-value helpers
│   │   ├── schema.ts          # database schema and custom tables hook callback
│   │   ├── accounts.ts        # accounts, bans, and public keys manager
│   │   └── audit.ts           # admin audits and chat logs database writer
│   ├── network/
│   │   ├── ssh.ts             # openTUI SSH server sockets (ports 10022 / 10023)
│   │   ├── web.ts             # Bun HTTP server + WebSocket proxy bridge + index/guide HTML pages
│   │   └── mcp.ts             # Model Context Protocol SSE handler and tool registration
│   ├── engine/
│   │   ├── loop.ts            # action queue processors and central loop ticking
│   │   └── state.ts           # active session tables and admin logs in-memory history
│   └── tui/
│       ├── theme.ts           # generic game color palette switcher (tokyonight, cyberpunk, dracula, etc.)
│       ├── layout.ts          # grid layout sizer and min dimensions validation box
│       ├── auth.ts            # modular account login/register screen wizard flow
│       ├── admin.ts           # default administrator control panel layout
│       └── components/        # base TUI wrappers (input field, chat log, scrolling log view)
└── game/
    └── index.ts               # a simple real-time multiplayer movement arena & chat room demo
```

---

## Getting Started: Bootstrap a New Game

For a totally new user, there are two primary ways to download and use TuiEngine:

### Method 1: Direct Scaffolding via GitHub (Recommended)
You don't need to manually clone the repository. If you have **Bun** installed, you can bootstrap a fresh multiplayer game project directly using:
```bash
bun create github.com/thoughtlesslabs/tuicraft my-tui-game
```
This automatically downloads the template workspace, installs dependencies, and runs the required OpenTUI compatibility patches.

### Method 2: Local CLI Scaffolder
If you already have this repository cloned locally and want to spin up a new, clean game folder on your machine:
1. Make sure you are in the root directory of the engine.
2. Run the CLI tool:
   ```bash
   bun run create
   ```
3. Enter your desired project name when prompted. The tool will duplicate the necessary configurations and codebase.

---

## How to Run the Example Game

### 1. Install Dependencies
```bash
bun install
```
*(This automatically runs the postinstall patcher script to override `@opentui/ssh` exec/auth validations).*

### 2. Start the Development Server
```bash
bun run dev
```

### 3. Connect as a Player
* **Web Browser**: Open [http://localhost:13000](http://localhost:13000).
* **Native Terminal**: Run `ssh localhost -p 10022` (password can be anything if registering, or matches your password on login).

### 4. Connect as an Administrator
Open your console and run:
```bash
ssh localhost -p 10023
```
*Note: The first public key that successfully connects is registered as the trusted Admin key via TOFU. Subsequent keys will be blocked.*

---

## Docker Deployment

To launch your game stack in a production environment (such as a VPS or dedicated server) using Docker:

### 1. Build and Run the Stack
Run Docker Compose in detached mode:
```bash
docker compose up -d --build
```
This builds your TUI and Web containers, binds the ports, and starts the game loop automatically.

### 2. Connection Settings (Production Defaults)
* **Web Client**: Open `http://your-server-ip:13000` (can be reverse-proxied using Nginx or Caddy).
* **Game SSH Terminal**: Run `ssh your-server-ip` (mapped to port 22 inside the container for convenience).
* **Admin Dashboard SSH**: Run `ssh localhost -p 10023` on the host server. (Port 10023 is bound strictly to `127.0.0.1` for security).

### 3. Data Persistence
All persistent assets—SQLite databases, log audit trails, server settings (`config.json`), and SSH host keys—are stored inside the host `./data` directory (which maps to `/app/data` inside the containers) and will persist across container updates.

---

## ⚠️ Critical Development & Deployment Rules

To prevent issues when running games in local development (under Bun) versus production (under Node 26 + TSX on the Hub VPS), adhere strictly to these rules:

1. **Codebase Isolation**:
   * All custom game code, screens, databases, maps, and logic must reside strictly inside the `game/` folder.
   * Treat `src/` as a read-only engine library. Do not create or modify files inside `src/`.

2. **ESM Type-Only Imports**:
   * Bun natively allows importing types/interfaces as regular imports. However, Node's production runner strips types strictly, causing dynamic syntax errors if a type or interface is imported without the `type` keyword.
   * Always import interfaces/types from other files using type-only import syntax:
     ```typescript
     import { type MyInterface } from "./types";
     ```

3. **Autosave Handlers (No Synchronous Loop Writes)**:
   * Never execute blocking SQL queries inside the game tick loop or on rapid key movements.
   * Hold coordinate/state updates in-memory, and register a periodic save handler:
     ```typescript
     engine.loopManager.registerAutosaveHandler(async () => {
       // Save in-memory states to DB asynchronously
     });
     ```

---

## Developer Quickstart: Building Your Own Game

To start writing your own game, import `TuiEngine` and configure it in your entry file (e.g. `index.ts`):

```typescript
import { TuiEngine, BoxRenderable, TextRenderable } from "tuiengine";

// 1. Declare custom SQLite tables
function onDatabaseInit(db) {
  db.run(`
    CREATE TABLE IF NOT EXISTS player_scores (
      account_id TEXT PRIMARY KEY,
      score INTEGER NOT NULL DEFAULT 0
    );
  `);
}

// 2. Define custom admin commands
function customAdminCommands(cmd, arg, print) {
  if (cmd === "reset-scores") {
    // custom reset scores logic...
    print("Reset all scores!");
  }
}

// 3. Instantiate Engine
const engine = new TuiEngine({
  databasePath: "data/mygame.db",
  onDatabaseInit,
  customAdminCommands,
  tickRateMs: 300,
  onPlayerSession: handlePlayerSession
});

// 4. Register actions processed during ticks
engine.loopManager.registerActionHandler("ping", (action) => {
  console.log(`Received ping from player account: ${action.playerId}`);
});

// 5. Handle player rendering loop
function handlePlayerSession(session) {
  const { renderer } = session;
  
  // Design your TUI screens using OpenTUI components!
  const box = new BoxRenderable(renderer.root.ctx, {
    width: "100%",
    height: "100%",
    border: true,
    title: " Hello Game World! "
  });
  
  renderer.root.add(box);
  renderer.requestRender();
}

// 6. Boot the servers!
engine.start();
```

Enjoy building retro console multiplayer worlds! 🚀
