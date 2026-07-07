import fs from 'fs';
import path from 'path';

const filePath = path.resolve('node_modules/@opentui/ssh/index.js');
if (fs.existsSync(filePath)) {
  let content = fs.readFileSync(filePath, 'utf8');
  let dirty = false;

  // 1. Patch SSH exec requests for terminal compatibility
  if (content.includes('sshSession.on("exec", (accept, reject) => { reject?.(); });')) {
    console.log('Patching @opentui/ssh/index.js to handle custom "exec" terminal compatibility...');
    content = content.replace(
      'sshSession.on("exec", (accept, reject) => { reject?.(); });',
      `sshSession.on("exec", (accept, reject, info) => {
          const cmd = info?.command || "";
          const isTerminfo = cmd.includes("tic") || cmd.includes("terminfo") || cmd.includes("mkdir");
          if (isTerminfo) {
            const stream = accept?.();
            stream?.exit?.(0);
            stream?.end?.();
          } else {
            reject?.();
          }
        });`
    );
    dirty = true;
  } else if (!content.includes('const isTerminfo =')) {
    console.log('Updating existing exec handler to terminal compatibility version...');
    content = content.replace(
      /sshSession\.on\(\s*["']exec["'][\s\S]*?\);\n\s*sshSession\.on\(\s*["']shell["']/g,
      `sshSession.on("exec", (accept, reject, info) => {
          const cmd = info?.command || "";
          const isTerminfo = cmd.includes("tic") || cmd.includes("terminfo") || cmd.includes("mkdir");
          if (isTerminfo) {
            const stream = accept?.();
            stream?.exit?.(0);
            stream?.end?.();
          } else {
            reject?.();
          }
        });
        sshSession.on("shell"`
    );
    dirty = true;
  } else {
    console.log('SSH exec requests are already patched.');
  }

  // 2. Patch resolveAuth validation for auth.none
  if (content.includes('auth.none is invalid')) {
    console.log('Patching @opentui/ssh/index.js to allow auth.none...');
    content = content.replace(
      /if\s*\(\s*"none"\s*in\s*auth\s*\)\s*throw\s*new\s*ConfigError\(\s*['"]auth\.none\s+is\s+invalid[\s\S]*?['"]\s*\);?/i,
      '/* none check disabled */'
    );
    dirty = true;
  } else {
    console.log('auth.none check is already patched/disabled.');
  }

  // 3. Patch Session to expose raw channel
  if (!content.includes('channel, // Expose raw channel')) {
    console.log('Patching @opentui/ssh/index.js to expose raw SSH channel on session...');
    content = content.replace(
      'const session = {',
      'const session = {\n    channel, // Expose raw channel'
    );
    dirty = true;
  } else {
    console.log('Raw channel is already exposed on session.');
  }

  // 4. Patch createSessionStreams to prevent input freezing and buffer split OSC sequences
  if (content.includes('let inputPaused = false;')) {
    console.log('Patching @opentui/ssh/index.js to fix input freezing and buffer split OSC sequences...');
    content = content.replace(
      `  let inputPaused = false;
  const stdin = new Readable({
    read() {
      if (!inputPaused)
        return;
      inputPaused = false;
      channel.resume();
    }
  });
  const onData = (chunk) => {
    onActivity?.();
    if (!stdin.push(chunk) && !inputPaused) {
      inputPaused = true;
      channel.pause();
    }
  };`,
      `  const stdin = new Readable({
    read() {}
  });
  stdin.setRawMode = function(mode) { return this; };
  stdin.isRaw = true;
  let oscAccumulator = "";
  let oscTimeout = null;
  const onData = (chunk) => {
    onActivity?.();
    const str = chunk.toString("utf8");
    if (oscAccumulator || str.includes("\\x1b]")) {
      oscAccumulator += str;
      const belIdx = oscAccumulator.indexOf("\\x07");
      const stIdx = oscAccumulator.indexOf("\\x1b\\\\");
      if (belIdx !== -1 || stIdx !== -1) {
        const endIdx = belIdx !== -1 ? belIdx + 1 : stIdx + 2;
        const oscSeq = oscAccumulator.substring(0, endIdx);
        const remainder = oscAccumulator.substring(endIdx);
        if (oscTimeout) {
          clearTimeout(oscTimeout);
          oscTimeout = null;
        }
        stdin.push(Buffer.from(oscSeq, "utf8"));
        oscAccumulator = "";
        if (remainder) {
          onData(Buffer.from(remainder, "utf8"));
        }
      } else {
        if (!oscTimeout) {
          oscTimeout = setTimeout(() => {
            if (oscAccumulator) {
              stdin.push(Buffer.from(oscAccumulator, "utf8"));
              oscAccumulator = "";
            }
            oscTimeout = null;
          }, 100);
        }
      }
    } else {
      stdin.push(chunk);
    }
  };`
    );
    dirty = true;
  } else if (!content.includes('oscAccumulator')) {
    console.log('Updating input freezing patch to add OSC accumulator...');
    content = content.replace(
      `  const stdin = new Readable({
    read() {}
  });
  stdin.setRawMode = function(mode) { return this; };
  stdin.isRaw = true;
  const onData = (chunk) => {
    onActivity?.();
    stdin.push(chunk);
  };`,
      `  const stdin = new Readable({
    read() {}
  });
  stdin.setRawMode = function(mode) { return this; };
  stdin.isRaw = true;
  let oscAccumulator = "";
  let oscTimeout = null;
  const onData = (chunk) => {
    onActivity?.();
    const str = chunk.toString("utf8");
    if (oscAccumulator || str.includes("\\x1b]")) {
      oscAccumulator += str;
      const belIdx = oscAccumulator.indexOf("\\x07");
      const stIdx = oscAccumulator.indexOf("\\x1b\\\\");
      if (belIdx !== -1 || stIdx !== -1) {
        const endIdx = belIdx !== -1 ? belIdx + 1 : stIdx + 2;
        const oscSeq = oscAccumulator.substring(0, endIdx);
        const remainder = oscAccumulator.substring(endIdx);
        if (oscTimeout) {
          clearTimeout(oscTimeout);
          oscTimeout = null;
        }
        stdin.push(Buffer.from(oscSeq, "utf8"));
        oscAccumulator = "";
        if (remainder) {
          onData(Buffer.from(remainder, "utf8"));
        }
      } else {
        if (!oscTimeout) {
          oscTimeout = setTimeout(() => {
            if (oscAccumulator) {
              stdin.push(Buffer.from(oscAccumulator, "utf8"));
              oscAccumulator = "";
            }
            oscTimeout = null;
          }, 100);
        }
      }
    } else {
      stdin.push(chunk);
    }
  };`
    );
    dirty = true;
  } else {
    console.log('Input freezing patch is already up to date.');
  }

  // 5. Patch onConnection to disable Nagle's algorithm (setNoDelay)
  if (!content.includes('setNoDelay(true)')) {
    console.log('Patching @opentui/ssh/index.js to disable Nagle\'s algorithm (setNoDelay)...');
    content = content.replace(
      'const onConnection = (client, info) => {\n    clients.add(client);',
      'const onConnection = (client, info) => {\n    try { client._sock?.setNoDelay?.(true); } catch (e) {}\n    clients.add(client);'
    );
    dirty = true;
  } else {
    console.log('Nagle\'s algorithm patch (setNoDelay) is already applied.');
  }

  if (dirty) {
    fs.writeFileSync(filePath, content, 'utf8');
    console.log('Successfully applied all patches to @opentui/ssh/index.js!');
  } else {
    console.log('@opentui/ssh/index.js is already fully patched.');
  }
} else {
  console.error('Could not find node_modules/@opentui/ssh/index.js');
}

// Ensure a default config.json exists with the correct non-conflicting default ports
const configPath = path.resolve('config.json');
if (!fs.existsSync(configPath)) {
  const defaultConfig = {
    gamePort: 10022,
    adminPort: 10023,
    webPort: 13000,
    databasePath: "game.db",
    adminFingerprints: [],
    gameTitle: "TuiEngine",
    gameDescription: "Multiplayer SSH Terminal Game Framework"
  };
  fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2), 'utf8');
  console.log('Created default config.json with non-conflicting ports (10022, 10023, 13000).');
}
