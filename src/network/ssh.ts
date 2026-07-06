import { createServer } from "@opentui/ssh";
import { loadConfig, saveConfig } from "../config";
import { dirname } from "path";
import { mkdirSync } from "fs";

export const activeSshSessions = new Set<any>();

export async function startSshServers(
  onPlayerSession: (session: any) => void,
  onAdminSession: (session: any) => void
) {
  const config = loadConfig();

  const hostKeyPath = process.env.HOST_KEY_PATH || "./host_key";
  const adminHostKeyPath = process.env.ADMIN_HOST_KEY_PATH || "./admin_host_key";

  // Ensure host key parent directories exist
  const hostKeyDir = dirname(hostKeyPath);
  if (hostKeyDir && hostKeyDir !== ".") {
    mkdirSync(hostKeyDir, { recursive: true });
  }
  const adminHostKeyDir = dirname(adminHostKeyPath);
  if (adminHostKeyDir && adminHostKeyDir !== ".") {
    mkdirSync(adminHostKeyDir, { recursive: true });
  }

  // 1. GAME SSH SERVER (Port 2222 by default)
  const gameServer = createServer({
    hostKey: { path: hostKeyPath },
    auth: {
      publicKey: "any",
      none: true
    } as any,
    idleTimeout: "30m",
    startupBanner: true
  }).serve((session) => {
    activeSshSessions.add(session);
    session.onClose(() => {
      activeSshSessions.delete(session);
    });
    onPlayerSession(session);
  });

  await gameServer.listen(config.gamePort, "0.0.0.0");
  console.log(`Game SSH Server listening on port ${config.gamePort}...`);

  // 2. ADMIN SSH SERVER (Port 2223 by default)
  const adminServer = createServer({
    hostKey: { path: adminHostKeyPath },
    auth: {
      publicKey: {
        allow: ({ fingerprint }) => {
          const cfg = loadConfig();
          
          // Admin fingerprints may also be seeded out-of-band via the environment.
          const envFingerprints = (process.env.ADMIN_FINGERPRINTS || "")
            .split(",")
            .map(s => s.trim())
            .filter(Boolean);
          const allowed = new Set([...cfg.adminFingerprints, ...envFingerprints]);

          if (allowed.size === 0) {
            // Auto TOFU is enabled in non-production, OR if explicitly enabled via ALLOW_ADMIN_TOFU
            const isLocal = process.env.NODE_ENV !== "production";
            const allowTofu = isLocal || process.env.ALLOW_ADMIN_TOFU === "true";

            if (allowTofu) {
              console.log(`[Admin Security] TOFU triggered. Registering first admin fingerprint: ${fingerprint}`);
              cfg.adminFingerprints.push(fingerprint);
              saveConfig(cfg);
              return true;
            }
            
            console.warn("[Admin Security] No admin fingerprints configured and ALLOW_ADMIN_TOFU is not set. Rejecting admin connection. Set ADMIN_FINGERPRINTS or ALLOW_ADMIN_TOFU=true to bootstrap.");
            return false;
          }

          const match = allowed.has(fingerprint);
          if (!match) {
            console.warn(`[Admin Security] Blocked unauthorized connection from key fingerprint: ${fingerprint}`);
          }
          return match;
        }
      }
    },
    idleTimeout: "15m",
    startupBanner: true
  }).serve((session) => {
    onAdminSession(session);
  });

  await adminServer.listen(config.adminPort, "0.0.0.0");
  console.log(`Admin SSH Server listening on port ${config.adminPort}...`);

  return { gameServer, adminServer };
}
