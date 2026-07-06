import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

// global Bun mock for Node compat (especially password hashing)
if (typeof (globalThis as any).Bun === "undefined") {
  const crypto = require("node:crypto");
  (globalThis as any).Bun = {
    password: {
      hash: async (password: string) => {
        return new Promise<string>((resolve, reject) => {
          const salt = crypto.randomBytes(16).toString("hex");
          crypto.scrypt(password, salt, 64, (err: Error | null, derivedKey: Buffer) => {
            if (err) reject(err);
            resolve(`scrypt:${salt}:${derivedKey.toString("hex")}`);
          });
        });
      },
      verify: async (password: string, hash: string) => {
        if (hash.startsWith("scrypt:")) {
          const [, salt, key] = hash.split(":");
          if (!salt || !key) return false;
          return new Promise<boolean>((resolve, reject) => {
            crypto.scrypt(password, salt, 64, (err: Error | null, derivedKey: Buffer) => {
              if (err) reject(err);
              resolve(crypto.timingSafeEqual(Buffer.from(key, "hex"), derivedKey));
            });
          });
        }
        // Fallback to bcryptjs for legacy Bun/bcrypt hashes
        try {
          const bcrypt = require("bcryptjs");
          return bcrypt.compareSync(password, hash);
        } catch (e) {
          console.error("[Auth Shim] bcryptjs missing; cannot verify bcrypt hash.");
          return false;
        }
      }
    }
  };
}

// Database & Network Module exports
export { setDatabasePath, getDB, getServerState, setServerState } from "./db/client";
export { initializeDatabase } from "./db/schema";
export { activeSshSessions } from "./network/ssh";
export { 
  getAccountByUsername, 
  getAccountByFingerprint, 
  createAccount, 
  linkSSHKey, 
  isAccountBanned, 
  banAccount, 
  unbanAccount,
  type Account,
  type SSHKey
} from "./db/accounts";
export { logAdminAction, logChatMessage, getRecentChatLogs } from "./db/audit";

// Configuration Module exports
export { loadConfig, saveConfig, type AppConfig } from "./config";

// Network Module exports
export { startSshServers } from "./network/ssh";
export { startWebServer } from "./network/web";
export { McpManager } from "./network/mcp";

// Engine Module exports
export { GameLoopManager, type PlayerAction, type ActionHandler, type TickHandler } from "./engine/loop";
export { 
  activeSessions, 
  activeAccounts, 
  recentChats, 
  activeAdminSessions, 
  globalAdminHistory, 
  logAdminWorldEvent, 
  loadRecentAdminConsoleLogs,
  type PlayerSession,
  type ChatMessage
} from "./engine/state";

// TUI Components & Screens exports
export { THEMES, getTheme, createThemeStyles, type GameTheme } from "./tui/theme";
export { ChatInputComponent } from "./tui/components/input";
export { LogComponent, ChatLogComponent, type ChatLogMessage } from "./tui/components/log";
export { AuthWizard, type AuthWizardState } from "./tui/auth";
export { TuiBillingWizard } from "./tui/components/billing";
export { LayoutSizer } from "./tui/layout";
export { handleAdminSession, maintenanceTimeLeft } from "./tui/admin";
export { getCharWidth, getStringVisualWidth, padEndVisual, padStartVisual } from "./tui/string";

// Master TuiEngine bootstrapper class
import { initializeDatabase } from "./db/schema";
import { setDatabasePath } from "./db/client";
import { startSshServers } from "./network/ssh";
import { startWebServer } from "./network/web";
import { loadConfig } from "./config";
import { GameLoopManager } from "./engine/loop";
import { McpManager } from "./network/mcp";
import { Database } from "bun:sqlite";
import { handleAdminSession } from "./tui/admin";
import { activeSessions } from "./engine/state";

export interface TuiEngineOptions {
  databasePath?: string;
  onDatabaseInit?: (db: Database) => void;
  onPlayerSession: (session: any) => void;
  customAdminCommands?: (cmd: string, args: string, print: (msg: string) => void) => void;
  customRoutes?: Record<string, (req: Request) => Promise<Response> | Response>;
  tickRateMs?: number;
}

export class TuiEngine {
  private options: TuiEngineOptions;
  public loopManager: GameLoopManager;
  public mcpManager: McpManager;
  private sshServers: any = null;

  constructor(options: TuiEngineOptions) {
    this.options = options;
    const config = loadConfig();

    // 1. Database Configuration
    if (options.databasePath) {
      setDatabasePath(options.databasePath);
    } else if (config.databasePath) {
      setDatabasePath(config.databasePath);
    }

    // 2. Engine loop setup
    this.loopManager = new GameLoopManager(options.tickRateMs || 300);

    // 3. MCP Manager setup
    this.mcpManager = new McpManager(config.gameTitle, "1.0.0");
  }

  /**
   * Boots the engine database, tick loops, SSH listeners, and Web/WebSocket routers.
   */
  public async start() {
    const config = loadConfig();
    const mode = process.env.START_MODE || "both";
    console.log(`[TuiEngine] Booting in mode: ${mode}...`);

    // 1. Initialize DB
    try {
      initializeDatabase(this.options.onDatabaseInit);
    } catch (err) {
      console.error("[TuiEngine] Critical database initialization failure:", err);
      process.exit(1);
    }

    if (mode === "web") {
      // Start web server only
      try {
        startWebServer({
          onMcpRequest: (req) => this.mcpManager.handleSseRequest(req),
          customRoutes: this.options.customRoutes
        });
      } catch (err) {
        console.error("[TuiEngine] Critical Web server startup failure:", err);
        process.exit(1);
      }
      return;
    }

    // Start authoritative loop
    this.loopManager.start();

    // Start SSH listeners
    try {
      this.sshServers = await startSshServers(
        (session) => this.options.onPlayerSession(session),
        (session) => handleAdminSession(session, this.options.customAdminCommands)
      );
    } catch (err) {
      console.error("[TuiEngine] Critical SSH servers startup failure:", err);
      this.loopManager.stop();
      process.exit(1);
    }

    // Start Web Server / Websocket SSH Bridge
    if (mode === "both") {
      try {
        startWebServer({
          onMcpRequest: (req) => this.mcpManager.handleSseRequest(req),
          customRoutes: this.options.customRoutes
        });
      } catch (err) {
        console.error("[TuiEngine] Critical Web server startup failure:", err);
        this.loopManager.stop();
        if (this.sshServers) {
          await this.sshServers.gameServer.close();
          await this.sshServers.adminServer.close();
        }
        process.exit(1);
      }
    }

    // Graceful Shutdown listeners
    process.on("SIGINT", () => this.shutdown("SIGINT"));
    process.on("SIGTERM", () => this.shutdown("SIGTERM"));
  }

  private async shutdown(signal: string) {
    console.log(`\n[TuiEngine] Received ${signal}. Starting shutdown...`);
    
    // Stop loops
    this.loopManager.stop();

    // Close SSH Servers
    if (this.sshServers) {
      console.log("[TuiEngine] Closing SSH listener sockets...");
      try {
        await this.sshServers.gameServer.close();
        await this.sshServers.adminServer.close();
      } catch (e) {}
    }

    // Disconnect active sessions
    for (const session of activeSessions.values()) {
      try {
        session.end();
      } catch (e) {}
    }

    // Close Database
    try {
      const { getDB } = await import("./db/client");
      getDB().close();
      console.log("[TuiEngine] Database connections closed.");
    } catch (e) {}

    console.log("[TuiEngine] Shutdown complete.");
    process.exit(0);
  }
}
