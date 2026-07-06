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
  loadConfig
} from "../src/index";
import { AuthWizard } from "./auth";
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
  StyledText 
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
      y INTEGER NOT NULL DEFAULT 3
    );
  `);
}

// 2. Custom Admin commands hook
function customAdminCommands(cmd: string, arg: string, print: (msg: string) => void) {
  if (cmd === "reset-players") {
    const db = require("../src/db/client").getDB();
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

// Start master TuiEngine
const engine = new TuiEngine({
  databasePath: "data/demo.db",
  onDatabaseInit,
  customAdminCommands,
  tickRateMs: 200, // Fast ticks for smooth movement!
  onPlayerSession: handlePlayerSession
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
    const db = require("../src/db/client").getDB();
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

  // Redraw all active sessions
  for (const s of activeSessions.values()) {
    s.onStateUpdate?.();
  }
});

// Handle player connection and rendering
function handlePlayerSession(session: any) {
  const { renderer, identity } = session;
  const ctx = renderer.root.ctx;
  const sessionId = crypto.randomUUID();

  let currentAccountId = "";
  let currentUsername = "";
  let sizer = new LayoutSizer(80, 24); // 80x24 min footprint for retro layout

  let screenState: "size-check" | "auth" | "game" = "size-check";

  // Login elements
  let authWizard: AuthWizard | null = null;

  // Game UI elements
  let rootPanel: BoxRenderable | null = null;
  let mapBox: BoxRenderable | null = null;
  let mapText: TextRenderable | null = null;
  
  let sidebarBox: BoxRenderable | null = null;
  let sidebarText: TextRenderable | null = null;

  let chatLogBox: ChatLogComponent | null = null;
  let chatInputBox: ChatInputComponent | null = null;

  const sessionObj = {
    sessionId,
    accountId: "",
    username: "",
    renderer,
    cols: session.cols,
    rows: session.rows,
    onStateUpdate: () => {
      if (screenState === "game" && currentUsername) {
        drawGameScreen();
      }
    },
    end: () => session.end()
  };

  activeSessions.set(sessionId, sessionObj);

  // Listeners
  const removeResize = session.onResize((cols: number, rows: number) => {
    sessionObj.cols = cols;
    sessionObj.rows = rows;
    checkLayout();
  });

  const removeClose = session.onClose(() => {
    removeResize();
    activeSessions.delete(sessionId);
    if (currentUsername) {
      activeAccounts.delete(currentUsername);
      console.log(`Player @${currentUsername} logged out.`);
    }
  });

  function checkLayout() {
    const root = renderer.root;
    const ok = sizer.checkSize(ctx, root, sessionObj.cols, sessionObj.rows);
    if (!ok) {
      screenState = "size-check";
      renderer.requestRender();
      return;
    }

    if (screenState === "size-check") {
      // Transition out of error page
      root.getChildren().forEach((child: any) => root.remove(child.id));
      
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
    const db = require("../src/db/client").getDB();
    db.query("INSERT INTO session_tokens (token, account_id, expires_at) VALUES ($t, $id, $exp)").run({
      $t: token,
      $id: accountId,
      $exp: expiresAt
    });
    session.write(`\x1b]999;${token}\x07`);

    // Load player position or create
    let pos = db.query("SELECT x, y FROM game_players WHERE account_id = $id").get({ $id: accountId }) as { x: number, y: number } | null;
    if (!pos) {
      db.query("INSERT INTO game_players (account_id, x, y) VALUES ($id, 5, 3)").run({ $id: accountId });
      pos = { x: 5, y: 3 };
    }

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
          const db = require("../src/db/client").getDB();
          let acc = db.query("SELECT id FROM accounts WHERE username = $u").get({ $u: targetUser }) as { id: string } | null;
          if (!acc) {
            // Auto-register in container local DB
            const { createAccount } = require("../src/index");
            const newAcc = await createAccount(targetUser, crypto.randomUUID());
            acc = { id: newAcc.id };
          }
          handleAuthSuccess(acc.id, targetUser);
        } catch (err) {
          console.error("[SSO] Auto-registration failed in game container:", err);
          // Fall back to manual login
          screenState = "auth";
          authWizard = new AuthWizard(ctx, sessionObj.cols, sessionObj.rows, handleAuthSuccess, () => session.end());
          renderer.root.add(authWizard.box);
          authWizard.getInputField().focusInput();
          renderer.requestRender();
        }
      }, 0);
      return;
    }

    screenState = "auth";
    authWizard = new AuthWizard(ctx, sessionObj.cols, sessionObj.rows, handleAuthSuccess, () => session.end());
    renderer.root.add(authWizard.box);
    authWizard.getInputField().focusInput();
    renderer.requestRender();
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

    mapText = new TextRenderable(ctx, {
      width: "100%",
      height: "100%",
      paddingLeft: 2,
      paddingTop: 1
    });
    mapBox.add(mapText);

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
    chatLogBox = new ChatLogComponent(ctx, {
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
      if (text.startsWith("/")) {
        const cmd = text.slice(1).trim();
        if (cmd === "logout" || cmd === "exit") {
          session.end();
        } else if (cmd === "stuck") {
          const db = require("../src/db/client").getDB();
          db.query("UPDATE game_players SET x = 5, y = 3 WHERE account_id = $id").run({ $id: currentAccountId });
          const p = activeAccounts.get(currentUsername);
          if (p) { p.x = 5; p.y = 3; }
          drawGameScreen();
        } else {
          // Send system warning
          const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          recentChats.push({
            sender: "System",
            text: `Unknown command: /${cmd}. Try /stuck or /logout.`,
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

    renderer.root.add(rootPanel);

    // Key bindings (WASD for movement, / to focus chat, ESC to blur)
    renderer.keyInput.on("keypress", (key: any) => {
      if (screenState !== "game") return;

      const inputFocused = chatInputBox?.isInputFocused || false;

      if (key.name === "/" && !inputFocused) {
        key.preventDefault();
        chatInputBox?.focusInput("");
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
    if (!selfPlayer || !mapText || !sidebarText || !chatLogBox) return;

    // 1. Draw Grid Arena Map
    const grid: string[][] = [];
    for (let y = 0; y < MAP_H; y++) {
      grid.push(new Array(MAP_W).fill("."));
    }

    // Place all active player positions on grid
    for (const p of activeAccounts.values()) {
      if (p.x >= 0 && p.x < MAP_W && p.y >= 0 && p.y < MAP_H) {
        grid[p.y]![p.x] = p.username === currentUsername ? "@" : "P";
      }
    }

    const mapChunks: any[] = [];
    for (let y = 0; y < MAP_H; y++) {
      const row = grid[y]!;
      for (let x = 0; x < MAP_W; x++) {
        const char = row[x]!;
        if (char === "@") {
          mapChunks.push(green(bold("@ ")));
        } else if (char === "P") {
          mapChunks.push(cyan(bold("P ")));
        } else {
          mapChunks.push(dim(". "));
        }
      }
      mapChunks.push({ __isChunk: true, text: "\n" });
    }
    mapText.content = new StyledText(mapChunks);

    // 2. Draw Sidebar Stats
    const statsChunks = t`
${cyan(bold("@" + currentUsername))}
Pos: (${selfPlayer.x.toString()}, ${selfPlayer.y.toString()})

${magenta("Online Realm:")}
Total sessions: ${activeSessions.size.toString()}
Active players : ${activeAccounts.size.toString()}

${yellow("Movement Tips:")}
Use ${bold("W/A/S/D")} to move
Press ${bold("/")} to chat
Press ${bold("ESC")} to steer
Type ${bold("/logout")} to exit
`;
    sidebarText.content = statsChunks;

    // 3. Draw Chat Box logs
    chatLogBox.updateLogs(recentChats, currentUsername, sessionObj.cols, "default", renderer.themeMode);
    renderer.requestRender();
  }

  checkLayout();
}

// Start Engine
engine.start().catch(err => {
  console.error("Fatal engine failure:", err);
  process.exit(1);
});
