import { BoxRenderable, TextRenderable, t, bold, dim, green, yellow, magenta, cyan, red, StyledText, type TextChunk, type RenderContext } from "@opentui/core";
import type { Session } from "@opentui/ssh";
import { getDB } from "../db/client";
import { logAdminAction, logChatMessage } from "../db/audit";
import { ChatInputComponent } from "./components/input";
import { activeSessions, activeAccounts, globalAdminHistory, activeAdminSessions } from "../engine/state";
import { banAccount, unbanAccount } from "../db/accounts";
import { getStringVisualWidth } from "./string";

// Shared state for scheduled maintenance
export let maintenanceTimeLeft: number | null = null;
let maintenanceInterval: Timer | null = null;

export function handleAdminSession(
  session: Session<any, any>,
  customCommandCallback?: (cmd: string, args: string, print: (msg: string) => void) => void
) {
  const { renderer, identity } = session;
  const ctx = renderer.root.ctx;

  let auditLines: string[] = [...globalAdminHistory];
  const cleanupListeners: Array<() => void> = [];

  const adminLogListener = (msg: string) => {
    const lines = msg.split("\n");
    for (const l of lines) {
      auditLines.push(l);
    }
    while (auditLines.length > 50) {
      auditLines.shift();
    }
    refreshDashboard();
  };
  activeAdminSessions.add(adminLogListener);
  cleanupListeners.push(() => {
    activeAdminSessions.delete(adminLogListener);
  });

  // Layout elements
  const root = new BoxRenderable(ctx, {
    width: "100%",
    height: "100%",
    flexDirection: "column"
  });

  const header = new BoxRenderable(ctx, {
    width: "100%",
    height: 3,
    border: true,
    borderColor: "#FF00FF",
    title: " Admin Console Dashboard ",
    titleAlignment: "center"
  });

  const bodyRow = new BoxRenderable(ctx, {
    width: "100%",
    flexGrow: 1,
    flexDirection: "row"
  });

  const metricsBox = new BoxRenderable(ctx, {
    width: 40,
    height: "100%",
    border: true,
    borderColor: "#FF00FF",
    title: " Server Metrics "
  });

  const metricsText = new TextRenderable(ctx, {
    width: "100%",
    height: "100%",
    paddingLeft: 1,
    paddingTop: 1
  });
  metricsBox.add(metricsText);

  const consoleBox = new BoxRenderable(ctx, {
    flexGrow: 1,
    height: "100%",
    border: true,
    borderColor: "#FF00FF",
    title: " Action Output & Audit Trail "
  });

  const consoleText = new TextRenderable(ctx, {
    width: "100%",
    height: "100%",
    paddingLeft: 1,
    paddingTop: 1,
    wrapMode: "none"
  });
  consoleBox.add(consoleText);

  const playersBox = new BoxRenderable(ctx, {
    width: 32,
    height: "100%",
    border: true,
    borderColor: "#FF00FF",
    title: " Online Directories "
  });

  const playersText = new TextRenderable(ctx, {
    width: "100%",
    height: "100%",
    paddingLeft: 1,
    paddingTop: 1
  });
  playersBox.add(playersText);

  bodyRow.add(metricsBox);
  bodyRow.add(consoleBox);
  bodyRow.add(playersBox);

  const commandInput = new ChatInputComponent(ctx, {
    width: "100%",
    height: 3,
    title: " Console Commander "
  }, handleCommand);

  root.add(header);
  root.add(bodyRow);
  root.add(commandInput);

  let isRootAdded = false;
  let screenState: "dashboard" | "size-check" = "dashboard";
  let sizeErrorBox: BoxRenderable | null = null;
  let sizeErrorText: TextRenderable | null = null;

  function checkLayout(cols: number, rows: number) {
    const isSmall = cols < 100 || rows < 25;

    if (isSmall) {
      if (screenState !== "size-check") {
        if (isRootAdded) {
          renderer.root.remove(root.id);
          isRootAdded = false;
        }
        sizeErrorBox = new BoxRenderable(ctx, {
          width: "100%",
          height: "100%",
          border: true,
          borderColor: "#FF0000",
          title: " Error: Window Too Small ",
          titleAlignment: "center"
        });
        sizeErrorText = new TextRenderable(ctx, {
          width: "100%",
          height: "100%",
          paddingLeft: 2,
          paddingTop: 2
        });
        sizeErrorText.fg = "#FFFFFF";
        sizeErrorBox.add(sizeErrorText);
        renderer.root.add(sizeErrorBox);
        screenState = "size-check";
      }
      if (sizeErrorText) {
        sizeErrorText.content = `
Your terminal window is too small to display the admin dashboard.
Please resize your terminal window.

Minimum Size Required: 100 columns x 25 rows
Current Window Size  : ${cols} columns x ${rows} rows
        `;
      }
    } else {
      if (screenState === "size-check") {
        if (sizeErrorBox) {
          renderer.root.remove(sizeErrorBox.id);
          sizeErrorBox = null;
          sizeErrorText = null;
        }
        renderer.root.add(root);
        isRootAdded = true;
        screenState = "dashboard";
        commandInput.focusInput();
      } else if (!isRootAdded) {
        renderer.root.add(root);
        isRootAdded = true;
        commandInput.focusInput();
      }
      refreshDashboard();
    }
    renderer.requestRender();
  }

  checkLayout(session.cols || 120, session.rows || 40);

  const removeResize = session.onResize((cols, rows) => {
    checkLayout(cols, rows);
  });

  const removeClose = session.onClose(() => {
    removeResize();
    cleanupListeners.forEach(fn => fn());
    console.log(`Admin session closed: ${identity.username}`);
  });

  function getMetrics() {
    const db = getDB();
    const accCount = db.query("SELECT COUNT(*) as count FROM accounts").get() as { count: number };
    const mem = process.memoryUsage();
    return {
      rss: Math.round(mem.rss / 1024 / 1024),
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
      totalAccounts: accCount.count
    };
  }

  function refreshDashboard() {
    const m = getMetrics();
    metricsText.content = t`
${magenta("[Sessions/Online]")}  : ${activeSessions.size.toString()}/${activeAccounts.size.toString()}
${magenta("[Total Accounts]")}  : ${m.totalAccounts.toString()}
${magenta("[RAM/Heap Used]")}   : ${m.rss.toString()}MB / ${m.heapUsed.toString()}MB

${cyan("--- Commands Reference ---")}
 ${yellow("/broadcast [msg]")}  : Global chat alert
 ${yellow("/kick @[player]")}   : Terminate player
 ${yellow("/ban @[player]")}    : Ban account
 ${yellow("/unban @[player]")}  : Revoke ban
 ${yellow("/maintenance [s]")}  : Shutdown server
 ${yellow("/maintenance cancel")}: Cancel restart
 ${yellow("/logout")}           : Exit console
`;

    const maxRows = Math.max(5, (session.rows || 24) - 7);
    const contentWidth = Math.max(20, (session.cols || 100) - 78);
    const recentLines = auditLines.slice(-maxRows);

    const paddedLines = recentLines.map(line => {
      const visibleLength = getStringVisualWidth(line);
      const padAmount = Math.max(0, contentWidth - visibleLength);
      return line + " ".repeat(padAmount);
    });

    while (paddedLines.length < maxRows) {
      paddedLines.push(" ".repeat(contentWidth));
    }

    consoleText.content = paddedLines.join("\n");

    // Online players list
    const directoryChunks: TextChunk[] = [];
    directoryChunks.push(...t`${bold("Online Players:")}\n`.chunks);
    if (activeAccounts.size === 0) {
      directoryChunks.push(...t`  ${dim("None")}\n`.chunks);
    } else {
      for (const username of activeAccounts.keys()) {
        directoryChunks.push(...t` \u2022 ${green(bold("@" + username))}\n`.chunks);
      }
    }

    playersText.content = new StyledText(directoryChunks);
    renderer.requestRender();
  }

  function printToConsole(msg: string) {
    const time = new Date().toLocaleTimeString();
    adminLogListener(`[${time}] ${msg}`);
  }

  function handleCommand(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (!trimmed.startsWith("/")) {
      printToConsole(`\x1b[31mError: Commands must start with / (e.g. /broadcast Hello)\x1b[0m`);
      return;
    }

    const parts = text.slice(1).split(" ");
    const cmd = parts[0]?.toLowerCase() || "";
    const arg = parts.slice(1).join(" ");
    const fingerprint = identity.fingerprint || "unknown";

    switch (cmd) {
      case "broadcast":
        if (!arg) {
          printToConsole("\x1b[31mUsage: /broadcast [message]\x1b[0m");
          break;
        }
        // Broadcast globally
        for (const s of activeSessions.values()) {
          try {
            s.renderer.root.ctx.write("\x07"); // ring bell on players terminal
          } catch (e) {}
        }
        // Log chat
        const createdAt = new Date().toISOString();
        getDB().query(`
          INSERT INTO chat_log (sender_name, message, scope, created_at)
          VALUES ('[SYSTEM]', $message, 'global', $createdAt)
        `).run({ $message: arg, $createdAt: createdAt });

        logAdminAction(fingerprint, "broadcast", null, { text: arg });
        // Trigger re-renders
        for (const s of activeSessions.values()) {
          s.onStateUpdate?.();
        }
        printToConsole(`\x1b[32mBroadcast sent: "${arg}"\x1b[0m`);
        break;

      case "kick": {
        if (!arg || !arg.startsWith("@")) {
          printToConsole("\x1b[31mUsage: /kick @[player]\x1b[0m");
          break;
        }
        const cleanName = arg.slice(1).toLowerCase();
        let kicked = false;

        for (const s of activeSessions.values()) {
          if (s.username.toLowerCase() === cleanName) {
            logAdminAction(fingerprint, "kick", s.accountId, {});
            s.end();
            kicked = true;
            break;
          }
        }

        if (kicked) {
          printToConsole(`\x1b[32mKicked player @${cleanName}\x1b[0m`);
        } else {
          printToConsole(`\x1b[31mPlayer @${cleanName} is not online.\x1b[0m`);
        }
        break;
      }

      case "ban": {
        const banParts = arg.split(" ");
        const name = banParts[0];
        const reason = banParts.slice(1).join(" ") || "Admin decision";
        if (!name || !name.startsWith("@")) {
          printToConsole("\x1b[31mUsage: /ban @[player] [reason]\x1b[0m");
          break;
        }
        const cleanName = name.slice(1).toLowerCase();
        const db = getDB();
        const res = db.query("SELECT id FROM accounts WHERE LOWER(username) = $name").get({
          $name: cleanName
        }) as { id: string } | null;

        if (!res) {
          printToConsole(`\x1b[31mAccount @${cleanName} not found in database.\x1b[0m`);
          break;
        }

        banAccount(res.id, reason);
        logAdminAction(fingerprint, "ban", res.id, { reason });
        
        // Kick session if active
        for (const s of activeSessions.values()) {
          if (s.accountId === res.id) {
            s.end();
          }
        }
        printToConsole(`\x1b[32mBanned player @${cleanName} (Reason: ${reason})\x1b[0m`);
        break;
      }

      case "unban": {
        if (!arg || !arg.startsWith("@")) {
          printToConsole("\x1b[31mUsage: /unban @[player]\x1b[0m");
          break;
        }
        const cleanName = arg.slice(1).toLowerCase();
        const db = getDB();
        const res = db.query("SELECT id FROM accounts WHERE LOWER(username) = $name").get({
          $name: cleanName
        }) as { id: string } | null;

        if (!res) {
          printToConsole(`\x1b[31mAccount @${cleanName} not found.\x1b[0m`);
          break;
        }

        unbanAccount(res.id);
        logAdminAction(fingerprint, "unban", res.id, {});
        printToConsole(`\x1b[32mUnbanned player @${cleanName}\x1b[0m`);
        break;
      }

      case "maintenance": {
        const sub = arg.trim().toLowerCase();
        if (sub === "cancel") {
          if (!maintenanceInterval) {
            printToConsole("\x1b[31mNo maintenance is currently active.\x1b[0m");
            break;
          }
          clearInterval(maintenanceInterval);
          maintenanceInterval = null;
          maintenanceTimeLeft = null;
          printToConsole("\x1b[32mMaintenance countdown cancelled.\x1b[0m");
        } else {
          if (maintenanceInterval) {
            printToConsole("\x1b[31mMaintenance is already counting down!\x1b[0m");
            break;
          }
          const secs = parseInt(sub) || 30;
          maintenanceTimeLeft = secs;
          printToConsole(`\x1b[32mMaintenance countdown started: ${secs} seconds.\x1b[0m`);

          maintenanceInterval = setInterval(() => {
            if (maintenanceTimeLeft !== null) {
              maintenanceTimeLeft--;
            }

            if (maintenanceTimeLeft === null || maintenanceTimeLeft <= 0) {
              clearInterval(maintenanceInterval!);
              maintenanceInterval = null;
              maintenanceTimeLeft = null;

              // Shutdown
              setTimeout(() => {
                process.env.IMMEDIATE_SHUTDOWN = "true";
                process.emit("SIGTERM");
              }, 1000);
              return;
            }
          }, 1000);
        }
        break;
      }

      case "logout":
        session.end();
        break;

      default:
        // Fallback to custom command callback if provided
        if (customCommandCallback) {
          customCommandCallback(cmd, arg, printToConsole);
        } else {
          printToConsole(`\x1b[31mUnknown command: /${cmd}\x1b[0m`);
        }
        break;
    }
  }
}
