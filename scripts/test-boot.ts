import { spawn } from "bun";
import { join } from "path";
import { existsSync, readFileSync } from "fs";

// ANSI Color helpers
const green = (text: string) => `\x1b[32m${text}\x1b[0m`;
const red = (text: string) => `\x1b[31m${text}\x1b[0m`;
const bold = (text: string) => `\x1b[1m${text}\x1b[0m`;
const cyan = (text: string) => `\x1b[36m${text}\x1b[0m`;

const CONFIG_PATH = join(process.cwd(), "config.json");
let gamePort = 10022;
let webPort = 13000;

if (existsSync(CONFIG_PATH)) {
  try {
    const config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    if (config.gamePort) gamePort = config.gamePort;
    if (config.webPort) webPort = config.webPort;
  } catch (e) {}
}

// Determine target entry file
let targetFile = process.env.TEST_TARGET || "";
if (!targetFile) {
  if (existsSync(join(process.cwd(), "game", "index.ts"))) {
    targetFile = "game/index.ts";
  } else if (existsSync(join(process.cwd(), "src", "index.ts"))) {
    targetFile = "src/index.ts";
  } else {
    console.error(red("Could not find a valid entry file to test (game/index.ts or src/index.ts)."));
    process.exit(1);
  }
}

console.log(cyan(`Starting boot liveness check for target: ${bold(targetFile)}`));
console.log(cyan(`Checking Game SSH port: ${bold(gamePort.toString())} and Web port: ${bold(webPort.toString())}`));

// Spawn the process
const proc = spawn(["bun", targetFile], {
  stdout: "inherit",
  stderr: "pipe", // Keep stderr piped to analyze crash details
});

let stderrData = "";

// Read stderr in background
const readStderr = async () => {
  const reader = proc.stderr.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      stderrData += decoder.decode(value);
    }
  } catch (e) {}
};
readStderr();

// Helper to poll TCP port
async function pollPort(port: number, timeoutMs = 8000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (proc.exitCode !== null) return false; // Process exited early
    try {
      const socket = await Bun.connect({
        hostname: "127.0.0.1",
        port,
        socket: {
          data() {},
          open() {},
          close() {},
          error() {}
        }
      });
      socket.end();
      return true;
    } catch (e) {
      await new Promise(r => setTimeout(r, 150));
    }
  }
  return false;
}

// Perform validation
const testLiveness = async () => {
  // Wait for both gamePort and webPort to be listening
  const gamePortReady = await pollPort(gamePort);
  const webPortReady = await pollPort(webPort);

  if (gamePortReady && webPortReady) {
    console.log(green(bold("\n[Liveness Success] Game server booted successfully and is listening on both ports!")));
    // Terminate cleanly
    proc.kill("SIGTERM");
    await proc.exited;
    process.exit(0);
  } else {
    console.error(red(bold("\n[Liveness Failure] Game server failed to boot or bind to ports within the timeout period.")));
    if (proc.exitCode !== null) {
      console.error(red(`Process exited early with code: ${proc.exitCode}`));
    }
    if (stderrData) {
      console.error(red("\n--- Runtime Error Logs (stderr) ---"));
      console.error(stderrData);
      console.error(red("-----------------------------------"));
    }
    proc.kill("SIGKILL");
    process.exit(1);
  }
};

testLiveness();
