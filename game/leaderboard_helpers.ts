import { getDB } from "../src/index";

export interface LeaderboardEntry {
  username: string;
  value: number;
  is_agent: boolean;
  updated_at: string;
}

const HUB_API_URL = process.env.HUB_API_URL || "http://localhost:3000";

/**
 * Updates a player's score in the local SQLite database.
 * If the score is higher than their previous high score, it updates it.
 */
export async function recordScore(
  accountId: string,
  username: string,
  gameId: string,
  metric: string,
  value: number,
  isAgent: boolean
): Promise<boolean> {
  const db = getDB();
  try {
    // Check for existing score
    const existing = db.query(
      "SELECT value FROM leaderboards WHERE account_id = $accId AND game_id = $gameId AND metric = $metric"
    ).get({
      $accId: accountId,
      $gameId: gameId,
      $metric: metric
    }) as { value: number } | null;

    let shouldUpdate = false;
    if (!existing) {
      db.query(
        "INSERT INTO leaderboards (account_id, username, game_id, metric, value, is_agent, updated_at) VALUES ($accId, $user, $gameId, $metric, $val, $isAgent, $time)"
      ).run({
        $accId: accountId,
        $user: username,
        $gameId: gameId,
        $metric: metric,
        $val: value,
        $isAgent: isAgent ? 1 : 0,
        $time: new Date().toISOString()
      });
      shouldUpdate = true;
    } else if (value > existing.value) {
      db.query(
        "UPDATE leaderboards SET value = $val, updated_at = $time WHERE account_id = $accId AND game_id = $gameId AND metric = $metric"
      ).run({
        $accId: accountId,
        $gameId: gameId,
        $metric: metric,
        $val: value,
        $time: new Date().toISOString()
      });
      shouldUpdate = true;
    }

    if (shouldUpdate) {
      // Async background push to central Hub
      submitScoreToHub(username, gameId, metric, value, isAgent).catch((err) => {
        console.error("[Leaderboard Webhook] Failed to submit score to central Hub:", err.message);
      });
    }

    return shouldUpdate;
  } catch (err: any) {
    console.error("[Leaderboard Helpers] Failed to record score:", err);
    return false;
  }
}

/**
 * Retrieves rankings from the local database.
 */
export function getLocalLeaderboard(
  gameId: string,
  metric: string,
  isAgent: boolean,
  limit = 5
): LeaderboardEntry[] {
  const db = getDB();
  try {
    const rows = db.query(
      "SELECT username, value, is_agent, updated_at FROM leaderboards WHERE game_id = $gameId AND metric = $metric AND is_agent = $isAgent ORDER BY value DESC LIMIT $limit"
    ).all({
      $gameId: gameId,
      $metric: metric,
      $isAgent: isAgent ? 1 : 0,
      $limit: limit
    }) as any[];

    return rows.map((row) => ({
      username: row.username,
      value: row.value,
      is_agent: row.is_agent === 1,
      updated_at: row.updated_at
    }));
  } catch (err) {
    console.error("[Leaderboard Helpers] Failed to read local rankings:", err);
    return [];
  }
}

/**
 * Submits score asynchronously to the central Hub API.
 */
export async function submitScoreToHub(
  username: string,
  gameId: string,
  metric: string,
  value: number,
  isAgent: boolean
): Promise<void> {
  // Read publish secret or game token from env if available
  const gameToken = process.env.GAME_PUBLISH_TOKEN || "local-demo-token";

  try {
    const res = await fetch(`${HUB_API_URL}/api/leaderboards/submit`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${gameToken}`
      },
      body: JSON.stringify({
        username,
        game_id: gameId,
        metric,
        value,
        is_agent: isAgent
      })
    });

    if (!res.ok) {
      const txt = await res.text();
      console.warn(`[Hub API] Submit returned status ${res.status}: ${txt}`);
    }
  } catch (err: any) {
    // Silently log error, do not block game thread
    console.debug(`[Hub API Connection Debug] Could not report score to central server: ${err.message}`);
  }
}

/**
 * Fetches rankings from the central Hub API.
 */
export async function getGlobalLeaderboard(
  gameId: string,
  metric: string,
  isAgent: boolean,
  limit = 5
): Promise<LeaderboardEntry[]> {
  try {
    const url = `${HUB_API_URL}/api/leaderboards?game_id=${gameId}&metric=${metric}&is_agent=${isAgent ? "true" : "false"}&limit=${limit}`;
    const res = await fetch(url, {
      headers: { "Accept": "application/json" }
    });

    if (res.ok) {
      const data = await res.json() as any[];
      return data.map((item) => ({
        username: item.username,
        value: Number(item.value),
        is_agent: Boolean(item.is_agent),
        updated_at: item.updated_at || ""
      }));
    }
  } catch (err: any) {
    console.debug(`[Hub API Connection Debug] Could not fetch global scores: ${err.message}`);
  }
  return [];
}
