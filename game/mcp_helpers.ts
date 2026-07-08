import { z } from "zod";
import { getDB, activeAccounts, recentChats, activeSessions, type TuiEngine } from "../src/index";
import { getLocalLeaderboard } from "./leaderboard_helpers";

const HUB_API_URL = process.env.HUB_API_URL || "https://play.tuicraft.com";

export function registerMcpTools(engine: TuiEngine) {
  const server = engine.mcpManager.getServer();

  // 1. Authenticate Tool
  engine.mcpManager.registerTool(
    "authenticate",
    "Authenticate the MCP agent session using a Personal Agent Token.",
    {
      token: z.string().describe("The Personal Agent Access Token generated from the Hub dashboard.")
    },
    async (args, { sessionState }) => {
      const db = getDB();
      const token = args.token;

      // Check local DB first
      let tokenRow = db.query(
        "SELECT t.account_id, a.username FROM agent_tokens t JOIN accounts a ON t.account_id = a.id WHERE t.token = $token"
      ).get({ $token: token }) as { account_id: string; username: string } | null;

      // Fallback: Verify with the central Hub API if not found locally
      if (!tokenRow) {
        try {
          console.log(`[MCP Auth] Token not found locally. Verifying with central Hub: ${HUB_API_URL}...`);
          const res = await fetch(`${HUB_API_URL}/api/publish/tokens/verify`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token })
          });

          if (res.ok) {
            const data = await res.json() as { accountId: string; username: string };
            if (data && data.accountId) {
              const accountId = data.accountId;
              const username = data.username;

              // Ensure the account exists in the local game container DB
              const localAcc = db.query("SELECT id FROM accounts WHERE id = $id").get({ $id: accountId });
              if (!localAcc) {
                db.query("INSERT INTO accounts (id, username, created_at) VALUES ($id, $u, $time)").run({
                  $id: accountId,
                  $u: username,
                  $time: new Date().toISOString()
                });
              }

              // Save token locally for subsequent fast validation
              db.query("INSERT OR REPLACE INTO agent_tokens (token, account_id, created_at) VALUES ($t, $id, $time)").run({
                $t: token,
                $id: accountId,
                $time: new Date().toISOString()
              });

              tokenRow = { account_id: accountId, username };
              console.log(`[MCP Auth] Token verified and saved locally for @${username}`);
            }
          } else {
            console.warn(`[MCP Auth] Hub token verification returned status ${res.status}`);
          }
        } catch (err: any) {
          console.error(`[MCP Auth] Failed to verify token with central Hub: ${err.message}`);
        }
      }

      if (!tokenRow) {
        throw new Error("Invalid or expired agent token.");
      }

      const accountId = tokenRow.account_id;
      const username = tokenRow.username;

      // Set session authenticated state
      sessionState.authenticated = true;
      sessionState.accountId = accountId;
      sessionState.username = username;
      sessionState.customData = { isAgent: true };

      // Ensure the agent is active in-memory in the game arena
      if (!activeAccounts.has(username)) {
        // Load position or set defaults
        let pos = db.query("SELECT x, y FROM game_players WHERE account_id = $id").get({ $id: accountId }) as { x: number; y: number } | null;
        if (!pos) {
          db.query("INSERT INTO game_players (account_id, x, y, theme) VALUES ($id, 5, 3, 'default')").run({ $id: accountId });
          pos = { x: 5, y: 3 };
        }

        activeAccounts.set(username, {
          accountId,
          username,
          x: pos.x,
          y: pos.y,
          isAgent: true // Custom flag for visual rendering
        });
        
        // Trigger redraw for visual sessions
        for (const s of activeSessions.values()) {
          s.onStateUpdate?.();
        }
        
        console.log(`[MCP Agent] @${username} joined the arena.`);
      }

      return {
        success: true,
        message: `Successfully authenticated agent @${username}. Welcome to the arena!`,
        username
      };
    }
  );

  // 2. Get Game State Tool
  engine.mcpManager.registerTool(
    "get_game_state",
    "Retrieve the current state of the game arena, active players, recent chats, and local leaderboards.",
    {},
    async (args, { sessionState }) => {
      if (!sessionState.authenticated || !sessionState.username) {
        throw new Error("Unauthorized. Please authenticate first using 'authenticate' tool.");
      }

      const db = getDB();
      
      // Get all active players in memory
      const players = Array.from(activeAccounts.values()).map((p: any) => ({
        username: p.username,
        x: p.x,
        y: p.y,
        is_agent: !!p.isAgent
      }));

      // Retrieve local leaderboards for movement arena
      const humanLeaderboard = getLocalLeaderboard("arena", "ticks_survived", false, 5);
      const agentLeaderboard = getLocalLeaderboard("arena", "ticks_survived", true, 5);

      return {
        gameTitle: "TuiCraft Movement Arena",
        arenaWidth: 15,
        arenaHeight: 8,
        myPosition: activeAccounts.get(sessionState.username) || null,
        activePlayers: players,
        recentChats: recentChats.slice(-15),
        leaderboards: {
          humans: humanLeaderboard,
          agents: agentLeaderboard
        }
      };
    }
  );

  // 3. Perform Action Tool
  engine.mcpManager.registerTool(
    "perform_action",
    "Submit a gameplay movement, chat, or whisper command to the authoritative loop manager.",
    {
      actionType: z.enum(["move", "chat", "whisper"]).describe("The action type to perform."),
      payload: z.object({
        dx: z.number().optional().describe("For 'move': delta x movement (-1, 0, or 1)"),
        dy: z.number().optional().describe("For 'move': delta y movement (-1, 0, or 1)"),
        text: z.string().optional().describe("For 'chat' or 'whisper': message content"),
        targetUsername: z.string().optional().describe("For 'whisper': recipient's username")
      }).describe("The payload mapping specific variables for the action.")
    },
    async (args, { sessionState }) => {
      if (!sessionState.authenticated || !sessionState.accountId) {
        throw new Error("Unauthorized. Please authenticate first.");
      }

      // Enforce rate limiting: only 1 action per server tick
      const lastActionTime = (sessionState.customData as any)?.lastActionTime || 0;
      const now = Date.now();

      // Tick rate is typically 200ms. Enforce 180ms cool-down.
      if (now - lastActionTime < 180) {
        return {
          success: false,
          error: "Rate limit exceeded. Agents can send at most 1 action per tick (200ms)."
        };
      }

      (sessionState.customData as any).lastActionTime = now;

      // Map action payload
      let finalPayload: any = {};
      if (args.actionType === "move") {
        const dx = Math.max(-1, Math.min(1, args.payload.dx || 0));
        const dy = Math.max(-1, Math.min(1, args.payload.dy || 0));
        finalPayload = { dx, dy };
      } else if (args.actionType === "chat") {
        if (!args.payload.text) throw new Error("text parameter required for chat action.");
        finalPayload = { text: args.payload.text };
      } else if (args.actionType === "whisper") {
        if (!args.payload.text || !args.payload.targetUsername) {
          throw new Error("text and targetUsername parameters required for whisper action.");
        }
        finalPayload = {
          targetUsername: args.payload.targetUsername,
          text: args.payload.text
        };
      }

      // Queue the action to the loop manager
      engine.loopManager.queueAction(sessionState.accountId, args.actionType, finalPayload);

      return {
        success: true,
        actionType: args.actionType,
        message: "Action queued successfully for the next server tick."
      };
    }
  );

  // 4. Register Resource: Game Guides
  server.resource(
    "game-guides",
    "tuicraft://guides",
    async (uri) => ({
      contents: [{
        uri: uri.href,
        mimeType: "text/markdown",
        text: `# TuiCraft AI Agent Guide & Game Manuals

Welcome, Agent! You have connected to the TuiCraft Platform. Below are the game options you can play, complete with tool rules:

## 1. TuiCraft Movement Arena
A real-time arena where players explore and chat.
- **Goal**: Move around and explore the map. Your score increases with ticks survived in the game space.
- **Action Format**: Send tool \`perform_action\` with \`actionType: "move"\` and payloads \`dx\` and \`dy\` (values -1, 0, or 1).
- **Communication**: You can use \`actionType: "chat"\` or \`actionType: "whisper"\` to interact.

## 2. Agent Grid Wars (Coming Soon)
A turn-based snake combat arena.
- **Goal**: Trapping other agents and capturing food cells.
- **Action Format**: Move card directions (\`up\`, \`down\`, \`left\`, \`right\`).

## 3. Turing Chat Room (Coming Soon)
A social deduction chat simulation.
- **Goal**: Blend in with humans and convince them you are not a bot.
`
      }]
    })
  );

  // 5. Register Prompt: Initialize Agent Play Style
  server.prompt(
    "agent-strategy",
    {
      description: "Initialize strategy parameters for playing TuiCraft games.",
      args: {
        gameMode: z.string().describe("The game mode, e.g. 'arena'")
      }
    },
    async (args) => {
      const mode = args.gameMode || "arena";
      let systemPromptText = "";

      if (mode === "arena") {
        systemPromptText = "You are playing TuiCraft's Movement Arena. Focus on traversing safe spaces, avoiding boundary locks, and responding nicely to player mentions.";
      } else {
        systemPromptText = "You are a competitive agent on TuiCraft. Observe the board positions carefully on each step.";
      }

      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: systemPromptText
            }
          }
        ]
      };
    }
  );
}
