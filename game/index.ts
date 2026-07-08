import { 
  TuiEngine, 
  LayoutSizer, 
  ChatInputComponent, 
  ChatLogComponent, 
  LogComponent,
  activeSessions, 
  activeAccounts, 
  recentChats,
  logChatMessage,
  loadConfig,
  getDB,
  createAccount,
  getRecentChatLogs,
  getStringVisualWidth
} from "../src/index";
import { AuthWizard } from "./auth";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { recordScore, getLocalLeaderboard, getGlobalLeaderboard } from "./leaderboard_helpers";
import { registerMcpTools } from "./mcp_helpers";
import { ColoredChatLogComponent } from "./colored_log";
import { getTheme, createThemeStyles } from "../src/tui/theme";
import { 
  BoxRenderable, 
  TextRenderable, 
  t, 
  green, 
  blue, 
  cyan, 
  magenta, 
  yellow, 
  bold, 
  dim, 
  StyledText,
  FrameBufferRenderable,
  RGBA
} from "@opentui/core";

// Define a simple 15x8 map for movement
const MAP_W = 15;
const MAP_H = 8;

interface DemoPlayer {
  accountId: string;
  username: string;
  x: number;
  y: number;
}

// 1. Custom DB initialization hook
function onDatabaseInit(db: any) {
  db.run(`
    CREATE TABLE IF NOT EXISTS game_players (
      account_id TEXT PRIMARY KEY,
      x INTEGER NOT NULL DEFAULT 5,
      y INTEGER NOT NULL DEFAULT 3,
      theme TEXT NOT NULL DEFAULT 'default'
    );
  `);
  try {
    db.run("ALTER TABLE game_players ADD COLUMN theme TEXT NOT NULL DEFAULT 'default'");
  } catch (e) {}

  // Leaderboards table
  db.run(`
    CREATE TABLE IF NOT EXISTS leaderboards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id TEXT NOT NULL,
      username TEXT NOT NULL,
      game_id TEXT NOT NULL,
      metric TEXT NOT NULL,
      value REAL NOT NULL,
      is_agent INTEGER DEFAULT 0,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
    );
  `);

  // Agent tokens table
  db.run(`
    CREATE TABLE IF NOT EXISTS agent_tokens (
      token TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
    );
  `);
}

// 2. Custom Admin commands hook
function customAdminCommands(cmd: string, arg: string, print: (msg: string) => void) {
  if (cmd === "reset-players") {
    const db = getDB();
    db.run("UPDATE game_players SET x = 5, y = 3");
    print("\x1b[32mReset all player positions to (5,3) in database.\x1b[0m");
    
    // Update online players in memory
    for (const p of activeAccounts.values()) {
      p.x = 5;
      p.y = 3;
    }
    for (const s of activeSessions.values()) {
      s.onStateUpdate?.();
    }
  } else {
    print(`\x1b[31mAdmin: Unknown command /${cmd}\x1b[0m`);
  }
}

// Global in-memory score tracking and agent sessions
const playerScores = new Map<string, number>();
const activeAgentSessions = new Map<string, { accountId: string; username: string; lastActionTime: number }>();

// Start master TuiEngine
const engine = new TuiEngine({
  databasePath: "data/demo.db",
  onDatabaseInit,
  customAdminCommands,
  tickRateMs: 200, // Fast ticks for smooth movement!
  onPlayerSession: handlePlayerSession,
  customRoutes: {
    "/agent-playground": (req) => {
      const htmlPath = join(process.cwd(), "game", "agent_playground.html");
      try {
        const html = readFileSync(htmlPath, "utf-8");
        return new Response(html, { headers: { "Content-Type": "text/html" } });
      } catch (err) {
        return new Response("Agent Playground file not found.", { status: 404 });
      }
    },
    "/api/mcp/authenticate": async (req) => {
      if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
      try {
        const body = (await req.json()) as any;
        const token = body.token;
        const db = getDB();
        let tokenRow = db.query(
          "SELECT t.account_id, a.username FROM agent_tokens t JOIN accounts a ON t.account_id = a.id WHERE t.token = $token"
        ).get({ $token: token }) as { account_id: string; username: string } | null;

        const HUB_API_URL = process.env.HUB_API_URL || "https://play.tuicraft.com";

        // Verification fallback with central Hub
        if (!tokenRow) {
          try {
            const verifyRes = await fetch(`${HUB_API_URL}/api/publish/tokens/verify`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ token })
            });
            if (verifyRes.ok) {
              const verifyData = await verifyRes.json() as { accountId: string; username: string };
              if (verifyData && verifyData.accountId) {
                const accountId = verifyData.accountId;
                const username = verifyData.username;
                
                // Ensure account exists locally
                const localAcc = db.query("SELECT id FROM accounts WHERE id = $id").get({ $id: accountId });
                if (!localAcc) {
                  db.query("INSERT INTO accounts (id, username, created_at) VALUES ($id, $u, $time)").run({
                    $id: accountId,
                    $u: username,
                    $time: new Date().toISOString()
                  });
                }
                
                // Save locally
                db.query("INSERT OR REPLACE INTO agent_tokens (token, account_id, created_at) VALUES ($t, $id, $time)").run({
                  $t: token,
                  $id: accountId,
                  $time: new Date().toISOString()
                });
                
                tokenRow = { account_id: accountId, username };
              }
            }
          } catch (e) {
            console.error("[Index Auth Hub Verify Error]", e);
          }
        }

        if (!tokenRow) {
          return new Response(JSON.stringify({ success: false, error: "Invalid agent token" }), {
            status: 401,
            headers: { "Content-Type": "application/json" }
          });
        }

        const sessionId = crypto.randomUUID();
        activeAgentSessions.set(sessionId, {
          accountId: tokenRow.account_id,
          username: tokenRow.username,
          lastActionTime: Date.now()
        });

        // Make agent active in arena
        if (!activeAccounts.has(tokenRow.username)) {
          let pos = db.query("SELECT x, y FROM game_players WHERE account_id = $id").get({ $id: tokenRow.account_id }) as { x: number; y: number } | null;
          if (!pos) {
            db.query("INSERT INTO game_players (account_id, x, y, theme) VALUES ($id, 5, 3, 'default')").run({ $id: tokenRow.account_id });
            pos = { x: 5, y: 3 };
          }
          activeAccounts.set(tokenRow.username, {
            accountId: tokenRow.account_id,
            username: tokenRow.username,
            x: pos.x,
            y: pos.y,
            isAgent: true
          });
          // Trigger redraws for visual players
          for (const s of activeSessions.values()) {
            s.onStateUpdate?.();
          }
        }

        return new Response(JSON.stringify({ success: true, sessionId, username: tokenRow.username }), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (err: any) {
        return new Response(JSON.stringify({ success: false, error: err.message }), {
          status: 500,
          headers: { "Content-Type": "application/json" }
        });
      }
    },
    "/api/mcp/state": async (req) => {
      const url = new URL(req.url);
      const sessionId = url.searchParams.get("sessionId");
      if (!sessionId || !activeAgentSessions.has(sessionId)) {
        return new Response("Unauthorized", { status: 401 });
      }

      const session = activeAgentSessions.get(sessionId)!;
      const db = getDB();

      const players = Array.from(activeAccounts.values()).map((p: any) => ({
        username: p.username,
        x: p.x,
        y: p.y,
        is_agent: !!p.isAgent
      }));

      const humanLeaderboard = getLocalLeaderboard("arena", "ticks_survived", false, 5);
      const agentLeaderboard = getLocalLeaderboard("arena", "ticks_survived", true, 5);

      return new Response(JSON.stringify({
        gameTitle: "TuiCraft Movement Arena",
        arenaWidth: MAP_W,
        arenaHeight: MAP_H,
        myPosition: activeAccounts.get(session.username) || null,
        activePlayers: players,
        recentChats: recentChats.slice(-15),
        leaderboards: {
          humans: humanLeaderboard,
          agents: agentLeaderboard
        }
      }), {
        headers: { "Content-Type": "application/json" }
      });
    },
    "/api/mcp/action": async (req) => {
      if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
      try {
        const body = (await req.json()) as any;
        const sessionId = body.sessionId;
        const actionType = body.actionType;
        const payload = body.payload;

        if (!sessionId || !activeAgentSessions.has(sessionId)) {
          return new Response("Unauthorized", { status: 401 });
        }

        const session = activeAgentSessions.get(sessionId)!;
        const now = Date.now();
        if (now - session.lastActionTime < 180) {
          return new Response(JSON.stringify({ success: false, error: "Rate limit exceeded" }), {
            status: 429,
            headers: { "Content-Type": "application/json" }
          });
        }
        session.lastActionTime = now;

        // Enqueue action
        engine.loopManager.queueAction(session.accountId, actionType, payload);

        return new Response(JSON.stringify({ success: true }), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (err: any) {
        return new Response(JSON.stringify({ success: false, error: err.message }), {
          status: 500,
          headers: { "Content-Type": "application/json" }
        });
      }
    },
    "/api/leaderboards": async (req) => {
      const url = new URL(req.url);
      const gameId = url.searchParams.get("game_id") || "arena";
      const metric = url.searchParams.get("metric") || "ticks_survived";
      const isAgent = url.searchParams.get("is_agent") === "true";
      const limit = Number(url.searchParams.get("limit") || "5");

      const rankings = getLocalLeaderboard(gameId, metric, isAgent, limit);
      return new Response(JSON.stringify(rankings), {
        headers: { "Content-Type": "application/json" }
      });
    }
  }
});

// Register MCP game tools
registerMcpTools(engine);

// Tick Handler for score updates and agent session cleaning
engine.loopManager.registerTickHandler((tickCount) => {
  // 1. Survived ticks activity tracking
  for (const p of activeAccounts.values()) {
    const currentScore = playerScores.get(p.accountId) || 0;
    playerScores.set(p.accountId, currentScore + 1);
  }

  // 2. Cleanup idle agent sessions (timeout 25 seconds)
  const now = Date.now();
  for (const [sessionId, session] of activeAgentSessions.entries()) {
    if (now - session.lastActionTime > 25000) {
      console.log(`[MCP Agent] @${session.username} idle timeout, removing from active arena.`);
      const score = playerScores.get(session.accountId) || 0;
      if (score > 0) {
        recordScore(session.accountId, session.username, "arena", "ticks_survived", score, true).catch(() => {});
      }
      playerScores.delete(session.accountId);
      activeAccounts.delete(session.username);
      activeAgentSessions.delete(sessionId);
      
      // Redraw other sessions
      for (const s of activeSessions.values()) {
        s.onStateUpdate?.();
      }
    }
  }
});

// Periodic DB autosave for scores (every 100 ticks)
engine.loopManager.registerAutosaveHandler(async () => {
  for (const p of activeAccounts.values()) {
    const score = playerScores.get(p.accountId) || 0;
    if (score > 0) {
      const isAgent = !!p.isAgent;
      await recordScore(p.accountId, p.username, "arena", "ticks_survived", score, isAgent);
    }
  }
});

// Register generic movement action
engine.loopManager.registerActionHandler("move", (action) => {
  const p = activeAccounts.get(action.playerId);
  if (!p) return;

  const { dx, dy } = action.payload;
  const newX = p.x + dx;
  const newY = p.y + dy;

  // Collision with boundaries
  if (newX >= 0 && newX < MAP_W && newY >= 0 && newY < MAP_H) {
    p.x = newX;
    p.y = newY;

    // Persist position
    const db = getDB();
    db.query("UPDATE game_players SET x = $x, y = $y WHERE account_id = $id").run({
      $x: newX,
      $y: newY,
      $id: p.accountId
    });
  }
});

// Register generic chat action
engine.loopManager.registerActionHandler("chat", (action) => {
  const p = activeAccounts.get(action.playerId);
  if (!p) return;

  const { text } = action.payload;
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  
  const msg = {
    sender: p.username,
    text,
    scope: "global" as const,
    time
  };

  recentChats.push(msg);
  if (recentChats.length > 50) recentChats.shift();

  // Save to DB log
  logChatMessage(p.accountId, p.username, text, "global", null);

  // Parse mentions to ring terminal bells for online users
  const mentionRegex = /@([a-zA-Z0-9_]+)/g;
  let match;
  const mentionedNames = new Set<string>();
  while ((match = mentionRegex.exec(text)) !== null) {
    if (match[1]) {
      mentionedNames.add(match[1].toLowerCase());
    }
  }

  // Redraw all active sessions and ring bells for mentioned users
  for (const s of activeSessions.values()) {
    s.onStateUpdate?.();
    if (s.username && mentionedNames.has(s.username.toLowerCase())) {
      // Exclude sender
      if (s.username.toLowerCase() !== p.username.toLowerCase()) {
        try {
          s.renderer.root.ctx.write("\x07");
        } catch (e) {}
      }
    }
  }
});

engine.loopManager.registerActionHandler("whisper", (action) => {
  const p = activeAccounts.get(action.playerId);
  if (!p) return;

  const { targetUsername, text } = action.payload;
  const recipient = activeAccounts.get(targetUsername);
  if (!recipient) return;

  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  const msg = {
    sender: p.username,
    recipient: recipient.username,
    text,
    scope: "whisper" as const,
    time
  };

  recentChats.push(msg);
  if (recentChats.length > 50) recentChats.shift();

  // Save to DB log
  logChatMessage(p.accountId, p.username, text, `whisper:${recipient.username}`, null);

  for (const s of activeSessions.values()) {
    s.onStateUpdate?.();
    // Ring bell for the direct recipient of the whisper
    if (s.username && s.username.toLowerCase() === recipient.username.toLowerCase()) {
      try {
        s.renderer.root.ctx.write("\x07");
      } catch (e) {}
    }
  }
});

// Handle player connection and rendering
function handlePlayerSession(session: any) {
  const { renderer, identity } = session;

  // Set dynamic FPS configurations from config
  try {
    const config = loadConfig() as any;
    renderer.targetFps = config.targetFps || 60;
    renderer.maxFps = config.maxFps || 120;
  } catch (e) {
    renderer.targetFps = 60;
    renderer.maxFps = 120;
  }

  const ctx = renderer.root.ctx;
  const sessionId = crypto.randomUUID();

  let currentAccountId = "";
  let currentUsername = "";
  let sizer = new LayoutSizer(80, 24); // 80x24 min footprint for retro layout

  let screenState: "size-check" | "auth" | "game" = "size-check";
  let playerTheme = "default";

  // Login elements
  let authWizard: AuthWizard | null = null;

  // Game UI elements
  let rootPanel: BoxRenderable | null = null;
  let mapBox: BoxRenderable | null = null;
  let mapFB: FrameBufferRenderable | null = null;
  
  let sidebarBox: BoxRenderable | null = null;
  let sidebarText: TextRenderable | null = null;

  let chatLogBox: ColoredChatLogComponent | null = null;
  let chatInputBox: ChatInputComponent | null = null;

  let helpPopup: any = null;
  let helpText: any = null;

  let leaderboardPopup: BoxRenderable | null = null;
  let leaderboardText: TextRenderable | null = null;
  let leaderboardPopupCallback: ((key: any) => void) | null = null;
  let isGlobalView = false;
  let helpPopupActive = false;
  let leaderboardPopupActive = false;

  let autocompleteState: {
    prefix: string;
    originalText: string;
    matches: string[];
    index: number;
  } | null = null;

  const sessionObj = {
    sessionId,
    accountId: "",
    username: "",
    renderer,
    cols: session.cols || 100,
    rows: session.rows || 30,
    onStateUpdate: () => {
      if (screenState === "game" && currentUsername) {
        drawGameScreen();
      }
    },
    end: () => session.end()
  };

  activeSessions.set(sessionId, sessionObj);

  // Query terminal background theme mode asynchronously
  renderer.waitForThemeMode(1000).then((mode: any) => {
    if (screenState === "auth" && authWizard) {
      authWizard.updateColors("default", mode);
      authWizard.updateWizardText();
    } else if (screenState === "game") {
      applyThemeColors();
      drawGameScreen();
    }
    renderer.requestRender();
  }).catch(() => {});

  // Initialize Help Popup Overlay
  helpPopup = new BoxRenderable(ctx, {
    position: "absolute",
    width: 62,
    height: 16,
    top: 4,
    left: Math.max(1, Math.floor((sessionObj.cols - 62) / 2)),
    border: true,
    borderColor: "#ec4899", // Magenta border
    backgroundColor: "#0b0f19",
    title: " Help & Guide ",
    titleColor: "#ec4899",
    titleAlignment: "center",
    zIndex: 1000,
    visible: false
  });

  helpText = new TextRenderable(ctx, {
    width: "100%",
    height: "100%",
    paddingLeft: 2,
    paddingRight: 2,
    paddingTop: 1
  });
  helpPopup.add(helpText);

  helpText.content = t`
  ${dim("[Use Up/Down Arrow keys to scroll. Press any other key to close]")}

  ${cyan(bold("=== TuiCraft Help & Guide ==="))}

  ${yellow("Movement & Navigation:")}
  - Use ${bold("W/A/S/D")} or ${bold("Arrow Keys")} to steer.

  ${yellow("Chat Autocomplete:")}
  - Type ${bold("@")} followed by prefix and press ${bold("Tab")} to cycle players.

  ${yellow("Useful Commands:")}
  - ${bold("/w @[player] [msg]")} : Private whisper to an online player.
  - ${bold("/whispers")}         : View recent whisper inbox logs.
  - ${bold("/theme [name]")}     : Change UI theme (Tokyo Night, Classic, Light...).
  - ${bold("/stuck")}            : Reset player position to spawn.
  - ${bold("/logout")}           : Safely disconnect from the session.
  `;

  let helpPopupCallback: ((key: any) => void) | null = null;

  // Register dynamic help show emitter on the renderer
  renderer.on("show-help", () => {
    if (helpPopup && helpText) {
      helpPopupActive = true;
      if (helpPopupCallback) {
        renderer.keyInput.off("keypress", helpPopupCallback);
        helpPopupCallback = null;
      }

      try { renderer.root.remove(helpPopup); } catch (e) {}
      renderer.root.add(helpPopup);
      helpPopup.visible = true;
      helpText.scrollY = 0; // reset scroll on open
      renderer.requestRender();

      // Temporary close callback with scrolling support
      helpPopupCallback = (key: any) => {
        key.preventDefault();

        if (key.name === "up" || key.name === "w") {
          helpText.scrollY = Math.max(0, helpText.scrollY - 1);
          renderer.requestRender();
          return;
        }
        if (key.name === "down" || key.name === "s") {
          helpText.scrollY = Math.min(helpText.maxScrollY, helpText.scrollY + 1);
          renderer.requestRender();
          return;
        }

        helpPopupActive = false;
        if (helpPopup) {
          helpPopup.visible = false;
          try { renderer.root.remove(helpPopup); } catch (e) {}
        }
        if (helpPopupCallback) {
          renderer.keyInput.off("keypress", helpPopupCallback);
          helpPopupCallback = null;
        }
        renderer.requestRender();
      };

      renderer.keyInput.on("keypress", helpPopupCallback);
    }
  });

  // Listeners
  const removeResize = session.onResize((cols: number, rows: number) => {
    sessionObj.cols = cols || 100;
    sessionObj.rows = rows || 30;
    checkLayout();
  });

  const removeClose = session.onClose(() => {
    removeResize();
    if (helpPopupCallback) {
      renderer.keyInput.off("keypress", helpPopupCallback);
    }
    if (leaderboardPopupCallback) {
      renderer.keyInput.off("keypress", leaderboardPopupCallback);
    }
    renderer.removeAllListeners("show-help");
    renderer.removeAllListeners("show-leaderboard");
    activeSessions.delete(sessionId);
    if (currentUsername) {
      const score = playerScores.get(currentAccountId) || 0;
      if (score > 0) {
        recordScore(currentAccountId, currentUsername, "arena", "ticks_survived", score, false).catch(() => {});
      }
      playerScores.delete(currentAccountId);
      activeAccounts.delete(currentUsername);
      console.log(`Player @${currentUsername} logged out.`);
    }
  });

  // Initialize Leaderboard Popup Overlay
  leaderboardPopup = new BoxRenderable(ctx, {
    position: "absolute",
    width: 62,
    height: 16,
    top: 4,
    left: Math.max(1, Math.floor((sessionObj.cols - 62) / 2)),
    border: true,
    borderColor: "#eab308", // Yellow border
    backgroundColor: "#0b0f19",
    title: " Leaderboards ",
    titleColor: "#eab308",
    titleAlignment: "center",
    zIndex: 1000,
    visible: false
  });

  leaderboardText = new TextRenderable(ctx, {
    width: "100%",
    height: "100%",
    paddingLeft: 4,
    paddingRight: 2,
    paddingTop: 1
  });
  leaderboardPopup.add(leaderboardText);

  // Register leaderboard show listener
  renderer.on("show-leaderboard", () => {
    if (leaderboardPopup && leaderboardText) {
      leaderboardPopupActive = true;
      if (leaderboardPopupCallback) {
        renderer.keyInput.off("keypress", leaderboardPopupCallback);
        leaderboardPopupCallback = null;
      }

      try { renderer.root.remove(leaderboardPopup); } catch (e) {}
      renderer.root.add(leaderboardPopup);
      leaderboardPopup.visible = true;
      leaderboardText.scrollY = 0;

      const renderPopupContent = async () => {
        const title = isGlobalView ? "🏆 Global Rankings 🏆" : "📍 Local Rankings 📍";
        
        let humans: any[] = [];
        let agents: any[] = [];

        if (isGlobalView) {
          humans = await getGlobalLeaderboard("arena", "ticks_survived", false, 5);
          agents = await getGlobalLeaderboard("arena", "ticks_survived", true, 5);
        } else {
          humans = getLocalLeaderboard("arena", "ticks_survived", false, 5);
          agents = getLocalLeaderboard("arena", "ticks_survived", true, 5);
        }

        const padUser = (name: string, len: number) => {
          const visualWidth = getStringVisualWidth(name);
          const diff = len - visualWidth;
          return diff > 0 ? name + " ".repeat(diff) : name;
        };

        const renderRow = (rank: number, name: string, score: number, isAgent: boolean) => {
          const nameStr = isAgent ? `🤖 ${name}` : `@${name}`;
          const paddedName = padUser(nameStr, 18);
          return `${rank}. ${paddedName} [${score.toString().padStart(4, " ")} pts]`;
        };

        const humanLines: string[] = [];
        for (let i = 0; i < 5; i++) {
          const item = humans[i];
          if (item) {
            humanLines.push(renderRow(i + 1, item.username, item.value, false));
          } else {
            humanLines.push(`${i + 1}. ───────────────────────`);
          }
        }

        const agentLines: string[] = [];
        for (let i = 0; i < 5; i++) {
          const item = agents[i];
          if (item) {
            agentLines.push(renderRow(i + 1, item.username, item.value, true));
          } else {
            agentLines.push(`${i + 1}. ───────────────────────`);
          }
        }

        const theme = getTheme(playerTheme, renderer.themeMode);
        const { cyan: themeCyan, magenta: themeMagenta, green: themeGreen } = createThemeStyles(playerTheme, renderer.themeMode);

        leaderboardText.content = t`
  ${bold(themeCyan("=== " + title + " ==="))}
  
  ${bold(themeGreen("👤 Human Players"))}           ${bold(themeMagenta("🤖 AI Agents"))}
  ───────────────────────   ───────────────────────
  ${humanLines[0]!}   ${agentLines[0]!}
  ${humanLines[1]!}   ${agentLines[1]!}
  ${humanLines[2]!}   ${agentLines[2]!}
  ${humanLines[3]!}   ${agentLines[3]!}
  ${humanLines[4]!}   ${agentLines[4]!}
  ───────────────────────   ───────────────────────

  ${dim("[Tab: Toggle Local/Global | Any other key to close]")}
        `;
        renderer.requestRender();
      };

      renderPopupContent();

      leaderboardPopupCallback = (key: any) => {
        key.preventDefault();

        if (key.name === "tab") {
          isGlobalView = !isGlobalView;
          renderPopupContent();
          return;
        }

        leaderboardPopupActive = false;
        if (leaderboardPopup) {
          leaderboardPopup.visible = false;
          try { renderer.root.remove(leaderboardPopup); } catch (e) {}
        }
        if (leaderboardPopupCallback) {
          renderer.keyInput.off("keypress", leaderboardPopupCallback);
          leaderboardPopupCallback = null;
        }
        renderer.requestRender();
      };

      renderer.keyInput.on("keypress", leaderboardPopupCallback);
    }
  });

  function checkLayout() {
    const root = renderer.root;
    const ok = sizer.checkSize(ctx, root, sessionObj.cols, sessionObj.rows);

    // Reposition help popup
    if (helpPopup) {
      helpPopup.left = Math.max(1, Math.floor((sessionObj.cols - 60) / 2));
    }
    if (leaderboardPopup) {
      leaderboardPopup.left = Math.max(1, Math.floor((sessionObj.cols - 60) / 2));
    }

    if (!ok) {
      screenState = "size-check";
      renderer.requestRender();
      return;
    }

    if (screenState === "size-check") {
      // Transition out of error page
      root.getChildren().forEach((child: any) => {
        if (child !== helpPopup) {
          root.remove(child);
        }
      });
      
      if (currentAccountId) {
        initGameScreen();
      } else {
        initLoginScreen();
      }
    }
  }

  function handleAuthSuccess(accountId: string, username: string) {
    currentAccountId = accountId;
    currentUsername = username;
    sessionObj.accountId = accountId;
    sessionObj.username = username;

    // Expose token for web resumption
    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
    const db = getDB();
    db.query("INSERT INTO session_tokens (token, account_id, expires_at) VALUES ($t, $id, $exp)").run({
      $t: token,
      $id: accountId,
      $exp: expiresAt
    });
    session.write(`\x1b]999;${token}\x07`);

    // Load player position or create
    let pos = db.query("SELECT x, y, theme FROM game_players WHERE account_id = $id").get({ $id: accountId }) as { x: number, y: number, theme?: string } | null;
    if (!pos) {
      db.query("INSERT INTO game_players (account_id, x, y, theme) VALUES ($id, 5, 3, 'default')").run({ $id: accountId });
      pos = { x: 5, y: 3, theme: "default" };
    }

    playerTheme = pos.theme || "default";

    activeAccounts.set(username, {
      accountId,
      username,
      x: pos.x,
      y: pos.y
    });

    console.log(`Player @${username} authenticated.`);
    
    // Cleanup login widgets
    renderer.root.getChildren().forEach((child: any) => renderer.root.remove(child));
    authWizard = null;

    // Start Game UI
    initGameScreen();
  }

  function initLoginScreen() {
    // SSO Intercept: Check if connecting via central Hub credentials
    const userStr = session.identity?.username || "";
    if (userStr.startsWith("hub-user:") && !userStr.startsWith("hub-user:guest-")) {
      const targetUser = userStr.substring(9);
      setTimeout(async () => {
        try {
          const db = getDB();
          let acc = db.query("SELECT id FROM accounts WHERE username = $u").get({ $u: targetUser }) as { id: string } | null;
          if (!acc) {
            // Auto-register in container local DB
            const newAcc = await createAccount(targetUser, crypto.randomUUID());
            acc = { id: newAcc.id };
          }
          handleAuthSuccess(acc.id, targetUser);
        } catch (err) {
          console.error("[SSO] Auto-registration failed in game container:", err);
          // Fall back to manual login
          screenState = "auth";
          authWizard = new AuthWizard(ctx, sessionObj.cols, sessionObj.rows, handleAuthSuccess, () => session.end());
          authWizard.updateColors("default", renderer.themeMode);
          renderer.root.add(authWizard.box);
          authWizard.getInputField().focusInput();
          renderer.requestRender();
        }
      }, 0);
      return;
    }

    screenState = "auth";
    authWizard = new AuthWizard(ctx, sessionObj.cols, sessionObj.rows, handleAuthSuccess, () => session.end());
    authWizard.updateColors("default", renderer.themeMode);
    renderer.root.add(authWizard.box);
    authWizard.getInputField().focusInput();
    renderer.requestRender();
  }

  function applyThemeColors() {
    const theme = getTheme(playerTheme, renderer.themeMode);
    const borderCol = theme.cyan; // Dynamic accent color
    
    if (mapBox) {
      mapBox.borderColor = borderCol;
      mapBox.focusedBorderColor = borderCol;
      mapBox.titleColor = theme.defaultFg;
    }
    if (sidebarBox) {
      sidebarBox.borderColor = borderCol;
      sidebarBox.focusedBorderColor = borderCol;
      sidebarBox.titleColor = theme.defaultFg;
    }
    if (chatLogBox) {
      chatLogBox.borderColor = borderCol;
      chatLogBox.focusedBorderColor = borderCol;
      chatLogBox.titleColor = theme.defaultFg;
    }
    if (chatInputBox) {
      chatInputBox.borderColor = borderCol;
      chatInputBox.focusedBorderColor = borderCol;
      chatInputBox.titleColor = theme.defaultFg;
      chatInputBox.updateColors(playerTheme, renderer.themeMode);
    }
    if (helpPopup && helpText) {
      helpPopup.borderColor = theme.magenta;
      helpPopup.focusedBorderColor = theme.magenta;
      helpPopup.titleColor = theme.defaultFg;
      helpText.fg = theme.defaultFg;
    }
  }

  function initGameScreen() {
    screenState = "game";

    // 1. Root Grid Panel
    rootPanel = new BoxRenderable(ctx, {
      width: "100%",
      height: "100%",
      flexDirection: "column"
    });

    // 2. Middle section (Map & Stats Side-by-Side)
    const midRow = new BoxRenderable(ctx, {
      width: "100%",
      flexGrow: 1,
      flexDirection: "row"
    });

    mapBox = new BoxRenderable(ctx, {
      flexGrow: 1,
      height: "100%",
      border: true,
      borderColor: "#00FFFF",
      title: " Movement Arena "
    });

    mapFB = new FrameBufferRenderable(ctx, {
      width: MAP_W * 2,
      height: MAP_H,
      paddingLeft: 2,
      paddingTop: 1
    });
    mapBox.add(mapFB);

    sidebarBox = new BoxRenderable(ctx, {
      width: 25,
      height: "100%",
      border: true,
      borderColor: "#00FFFF",
      title: " Realm Stats "
    });

    sidebarText = new TextRenderable(ctx, {
      width: "100%",
      height: "100%",
      paddingLeft: 1,
      paddingTop: 1
    });
    sidebarBox.add(sidebarText);

    midRow.add(mapBox);
    midRow.add(sidebarBox);

    // 3. Chat Log
    chatLogBox = new ColoredChatLogComponent(ctx, {
      width: "100%",
      height: 9,
      borderColor: "#00FFFF"
    });

    // 4. Input Field
    chatInputBox = new ChatInputComponent(ctx, {
      width: "100%",
      height: 3,
      borderColor: "#00FFFF"
    }, (text) => {
      chatInputBox?.blurInput();
      session.write("\x1b[?25l");
      if (text.startsWith("/")) {
        const parts = text.slice(1).trim().split(/\s+/);
        const cmd = (parts[0] || "").toLowerCase();
        if (cmd === "logout" || cmd === "exit") {
          session.end();
        } else if (cmd === "stuck") {
          const db = getDB();
          db.query("UPDATE game_players SET x = 5, y = 3 WHERE account_id = $id").run({ $id: currentAccountId });
          const p = activeAccounts.get(currentUsername);
          if (p) { p.x = 5; p.y = 3; }
          drawGameScreen();
        } else if (cmd === "help") {
          renderer.emit("show-help");
        } else if (cmd === "leaderboards" || cmd === "leaderboard" || cmd === "top") {
          renderer.emit("show-leaderboard");
        } else if (cmd === "w" || cmd === "whisper") {
          const rawTarget = parts[1] || "";
          const msgText = parts.slice(2).join(" ").trim();
          if (!rawTarget || !msgText) {
            recentChats.push({
              sender: "System",
              text: "⚠️ Usage: /w @[player_name] [message]",
              scope: "global",
              time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            });
            drawGameScreen();
            return;
          }
          const cleanTarget = rawTarget.startsWith("@") ? rawTarget.slice(1) : rawTarget;
          const targetPlayer = activeAccounts.get(cleanTarget);
          if (!targetPlayer) {
            recentChats.push({
              sender: "System",
              text: `❌ Error: Player '${cleanTarget}' is not online.`,
              scope: "global",
              time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            });
            drawGameScreen();
            return;
          }
          engine.loopManager.queueAction(currentUsername, "whisper", { targetUsername: cleanTarget, text: msgText });
        } else if (cmd === "whispers") {
          const db = getDB();
          const rows = db.query(`
            SELECT sender_name, message, scope, created_at FROM chat_log 
            WHERE (sender_name = $user AND scope LIKE 'whisper:%')
               OR scope = 'whisper:' || $user
            ORDER BY id DESC LIMIT 20
          `).all({ $user: currentUsername }) as any[];
          
          recentChats.push({
            sender: "System",
            text: "--- Recent Private Whispers ---",
            scope: "global",
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          });
          
          if (rows.length === 0) {
            recentChats.push({
              sender: "System",
              text: "No recent whispers found.",
              scope: "global",
              time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            });
          } else {
            rows.reverse().forEach(row => {
              const timeStr = new Date(row.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
              if (row.sender_name === currentUsername) {
                const target = row.scope.split(":")[1] || "";
                recentChats.push({
                  sender: currentUsername,
                  recipient: target,
                  text: row.message,
                  scope: "whisper",
                  time: timeStr
                });
              } else {
                recentChats.push({
                  sender: row.sender_name,
                  recipient: currentUsername,
                  text: row.message,
                  scope: "whisper",
                  time: timeStr
                });
              }
            });
          }
          drawGameScreen();
        } else if (cmd === "theme") {
          const themeChoice = parts.slice(1).join(" ").trim().toLowerCase();
          const themeKeys = ["default", "tokyonight", "dracula", "cyberpunk", "monokai", "classic", "light"];
          if (!themeChoice) {
            recentChats.push({
              sender: "System",
              text: `🎨 Current theme: '${playerTheme}'. Available: ${themeKeys.join(", ")}. Type /theme [name] to change.`,
              scope: "global",
              time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            });
            drawGameScreen();
            return;
          }
          if (!themeKeys.includes(themeChoice)) {
            recentChats.push({
              sender: "System",
              text: `❌ Unknown theme '${themeChoice}'. Available: ${themeKeys.join(", ")}`,
              scope: "global",
              time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            });
            drawGameScreen();
            return;
          }
          playerTheme = themeChoice;
          const db = getDB();
          db.query("UPDATE game_players SET theme = $theme WHERE account_id = $id").run({
            $theme: themeChoice,
            $id: currentAccountId
          });
          applyThemeColors();
          recentChats.push({
            sender: "System",
            text: `🎨 Theme successfully changed to: ${themeChoice}`,
            scope: "global",
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          });
          drawGameScreen();
        } else {
          // Send system warning
          const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          recentChats.push({
            sender: "System",
            text: `Unknown command: /${cmd}. Try /help, /stuck or /logout.`,
            scope: "global",
            time
          });
          drawGameScreen();
        }
      } else {
        engine.loopManager.queueAction(currentUsername, "chat", { text });
      }
    });

    rootPanel.add(midRow);
    rootPanel.add(chatLogBox);
    rootPanel.add(chatInputBox);

    applyThemeColors();

    renderer.root.add(rootPanel);

    function handleAutocomplete() {
      if (!chatInputBox) return;
      const inputVal = chatInputBox.inputValue;

      if (!autocompleteState) {
        const words = inputVal.split(" ");
        const lastWord = words[words.length - 1] || "";
        if (!lastWord || !lastWord.startsWith("@")) return;

        const prefix = lastWord.slice(1);
        const allNames = Array.from(activeAccounts.keys());
        const prefixLower = prefix.toLowerCase();
        const matches = allNames.filter(name => name.toLowerCase().startsWith(prefixLower));

        if (matches.length === 0) return;

        const originalText = words.slice(0, words.length - 1).join(" ");
        autocompleteState = {
          prefix,
          originalText,
          matches,
          index: 0
        };
      } else {
        autocompleteState.index = (autocompleteState.index + 1) % autocompleteState.matches.length;
      }

      const matchedName = autocompleteState.matches[autocompleteState.index];
      const completedWord = `@${matchedName}`;
      const newVal = autocompleteState.originalText
        ? `${autocompleteState.originalText} ${completedWord} `
        : `${completedWord} `;

      chatInputBox.inputValue = newVal;
      try {
        const underlying = (chatInputBox as any).inputField;
        if (underlying) {
          underlying.cursorOffset = newVal.length;
        }
      } catch (e) {}
      renderer.requestRender();
    }

    // Key bindings (WASD for movement, / to focus chat, ESC to blur)
    renderer.keyInput.on("keypress", (key: any) => {
      if (screenState !== "game" || helpPopupActive || leaderboardPopupActive) return;

      const inputFocused = chatInputBox?.isInputFocused || false;

      if (inputFocused) {
        if (key.name === "tab") {
          key.preventDefault();
          handleAutocomplete();
          return;
        } else if (key.name !== "escape") {
          autocompleteState = null;
        }
      }

      if (key.name === "?" && !inputFocused) {
        key.preventDefault();
        renderer.emit("show-help");
        return;
      }

      if (key.name === "/" && !inputFocused) {
        key.preventDefault();
        chatInputBox?.focusInput("/");
        return;
      }

      if (key.name === "l" && !inputFocused) {
        key.preventDefault();
        renderer.emit("show-leaderboard");
        return;
      }

      if (key.name === "escape") {
        chatInputBox?.blurInput();
        session.write("\x1b[?25l"); // Hide cursor during movement
        return;
      }

      if (!inputFocused) {
        let dx = 0, dy = 0, moved = false;
        if (key.name === "w" || key.name === "up") { dy = -1; moved = true; }
        else if (key.name === "s" || key.name === "down") { dy = 1; moved = true; }
        else if (key.name === "a" || key.name === "left") { dx = -1; moved = true; }
        else if (key.name === "d" || key.name === "right") { dx = 1; moved = true; }

        if (moved) {
          key.preventDefault();
          engine.loopManager.queueAction(currentUsername, "move", { dx, dy });
        }
      }
    });

    session.write("\x1b[?25l"); // Hide cursor initially
    drawGameScreen();
  }

  function drawGameScreen() {
    const selfPlayer = activeAccounts.get(currentUsername);
    if (!selfPlayer || !mapFB || !sidebarText || !chatLogBox) return;

    // 1. Draw Grid Arena Map
    const grid: string[][] = [];
    for (let y = 0; y < MAP_H; y++) {
      grid.push(new Array(MAP_W).fill("."));
    }

    // Place all active player positions on grid
    for (const p of activeAccounts.values()) {
      if (p.x >= 0 && p.x < MAP_W && p.y >= 0 && p.y < MAP_H) {
        if (p.username === currentUsername) {
          grid[p.y]![p.x] = "@";
        } else {
          grid[p.y]![p.x] = (p as any).isAgent ? "A" : "P";
        }
      }
    }

    const fb = mapFB.frameBuffer;
    fb.clear();

    const theme = getTheme(playerTheme, renderer.themeMode);
    const GREEN_COLOR = RGBA.fromHex(theme.green);
    const CYAN_COLOR = RGBA.fromHex(theme.cyan);
    const MAGENTA_COLOR = RGBA.fromHex(theme.magenta);
    const DIM_COLOR = RGBA.fromHex(theme.defaultFg);
    const DEFAULT_BG = RGBA.defaultBackground();

    for (let y = 0; y < MAP_H; y++) {
      for (let x = 0; x < MAP_W; x++) {
        const char = grid[y]![x]!;
        const xPos = x * 2;
        if (char === "@") {
          fb.setCell(xPos, y, "@", GREEN_COLOR, DEFAULT_BG);
        } else if (char === "P") {
          fb.setCell(xPos, y, "P", CYAN_COLOR, DEFAULT_BG);
        } else if (char === "A") {
          fb.setCell(xPos, y, "A", MAGENTA_COLOR, DEFAULT_BG);
        } else {
          fb.setCell(xPos, y, ".", DIM_COLOR, DEFAULT_BG);
        }
      }
    }

    // 2. Draw Sidebar Stats
    const { cyan: themeCyan, magenta: themeMagenta, yellow: themeYellow } = createThemeStyles(playerTheme, renderer.themeMode);
    const statsChunks = t`
${themeCyan(bold("@" + currentUsername))}
Pos: (${selfPlayer.x.toString()}, ${selfPlayer.y.toString()})

${themeMagenta("Online Realm:")}
Total sessions: ${activeSessions.size.toString()}
Active players : ${activeAccounts.size.toString()}

${themeYellow("Movement Tips:")}
Use ${bold("W/A/S/D")} to move
Press ${bold("/")} to chat
Press ${bold("ESC")} to steer
Press ${bold("L")} for rankings
Type ${bold("/logout")} to exit
`;
    sidebarText.content = statsChunks;

    // 3. Draw Chat Box logs
    chatLogBox.updateLogs(recentChats, currentUsername, sessionObj.cols, playerTheme, renderer.themeMode);
    renderer.requestRender();
  }

  checkLayout();
}

// Seed recentChats from the database chat logs on boot
try {
  const dbLogs = getRecentChatLogs(50);
  const orderedLogs = dbLogs.reverse();
  for (const log of orderedLogs) {
    const d = new Date(log.created_at + "Z");
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    recentChats.push({
      sender: log.sender_name || "Unknown",
      text: log.message,
      scope: "global",
      time
    });
  }
} catch (e) {}

// Start Engine
engine.start().catch(err => {
  console.error("Fatal engine failure:", err);
  process.exit(1);
});
