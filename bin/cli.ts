#!/usr/bin/env bun
import { mkdirSync, existsSync, readdirSync, statSync, writeFileSync, readFileSync } from "fs";
import { join, dirname, relative } from "path";

// ANSI Styling Helpers
const cyan = (text: string) => `\x1b[36m${text}\x1b[0m`;
const green = (text: string) => `\x1b[32m${text}\x1b[0m`;
const yellow = (text: string) => `\x1b[33m${text}\x1b[0m`;
const red = (text: string) => `\x1b[31m${text}\x1b[0m`;
const bold = (text: string) => `\x1b[1m${text}\x1b[0m`;
const magenta = (text: string) => `\x1b[35m${text}\x1b[0m`;
const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;

console.log(magenta(bold(`
████████╗██╗   ██╗██╗███████╗███╗   ██╗ ██████╗ ██╗███╗   ██╗███████╗
╚══██╪══╝██║   ██║██║██╔════╝████╗  ██║██╔════╝ ██║████╗  ██║██╔════╝
   ██║   ██║   ██║██║█████╗  ██╔██╗ ██║██║  ███╗██║██╔██╗ ██║█████╗  
   ██║   ██║   ██║██║██╔══╝  ██║╚██╗██║██║   ██║██║██║╚██╗██║██╔══╝  
   ██║   ╚██████╔╝██║███████╗██║ ╚████║╚██████╔╝██║██║ ╚████║███████╗
   ╚═╝    ╚═════╝ ╚═╝╚══════╝╚═╝  ╚═══╝ ╚═════╝ ╚═╝╚═╝  ╚═══╝╚══════╝
`)));

const isPublish = process.argv.includes("publish");

if (isPublish) {
  await publish();
} else {
  await scaffold();
}

async function publish() {
  console.log(cyan(bold("📡 Tuicraft Publishing Wizard\n")));

  const configPath = join(process.cwd(), "config.json");
  if (!existsSync(configPath)) {
    console.error(red("❌ Error: config.json not found in the current directory. Are you in a Tuicraft project root?"));
    process.exit(1);
  }

  let config;
  try {
    config = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch (err) {
    console.error(red("❌ Error: Failed to parse config.json"));
    process.exit(1);
  }

  const gameTitle = config.gameTitle || "Unnamed TUI Game";
  const gameDescription = config.gameDescription || "";
  const gameSlug = gameTitle.toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/-+/g, "-");
  if (!gameSlug || gameSlug.length < 3) {
    console.error(red(`❌ Error: Invalid game title '${gameTitle}'. Title must contain alphanumeric characters.`));
    process.exit(1);
  }

  const hubUrl = process.env.TUICRAFT_HUB_URL || "https://play.tuicraft.com";

  console.log(`Publishing: ${green(gameTitle)} (${cyan(gameSlug)})`);
  console.log(`Target Hub: ${yellow(hubUrl)}\n`);

  const usernameInput = prompt(cyan(bold("? play.tuicraft.com Username:")), "");
  const username = usernameInput ? usernameInput.trim() : "";
  if (!username) {
    console.error(red("❌ Error: Username is required."));
    process.exit(1);
  }

  const passwordInput = prompt(cyan(bold("? play.tuicraft.com Password:")), "");
  const password = passwordInput || "";
  if (!password) {
    console.error(red("❌ Error: Password is required."));
    process.exit(1);
  }

  console.log(dim("\nAuthenticating..."));
  
  let token = "";
  try {
    const res = await fetch(`${hubUrl}/api/publish/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password })
    });

    if (res.status === 404) {
      const registerInput = prompt(yellow(bold(`! Account '${username}' not found. Would you like to register? (y/N):`)), "n");
      if (registerInput?.toLowerCase() === "y") {
        console.log(dim("Registering new account..."));
        const regRes = await fetch(`${hubUrl}/api/publish/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, password })
        });
        const regData: any = await regRes.json();
        if (!regRes.ok) {
          throw new Error(regData.message || "Registration failed.");
        }
        console.log(green("🎉 Account registered successfully!"));
        token = regData.token;
      } else {
        console.log(red("\nPublishing aborted."));
        process.exit(0);
      }
    } else {
      const authData: any = await res.json();
      if (!res.ok) {
        throw new Error(authData.message || "Authentication failed.");
      }
      token = authData.token;
    }
  } catch (err: any) {
    console.error(red(`\n❌ Auth Error: ${err.message}`));
    process.exit(1);
  }

  console.log(dim("Packing game files..."));

  const files: Record<string, string> = {};
  const gameDir = join(process.cwd(), "game");
  if (!existsSync(gameDir)) {
    console.error(red("❌ Error: 'game' directory not found. Nothing to publish."));
    process.exit(1);
  }

  function walk(dir: string) {
    for (const child of readdirSync(dir)) {
      const fullPath = join(dir, child);
      const stat = statSync(fullPath);
      const relPath = relative(process.cwd(), fullPath);
      
      if (stat.isDirectory()) {
        walk(fullPath);
      } else {
        if (child.endsWith(".db") || child.endsWith(".db-wal") || child.endsWith(".db-shm") || child.endsWith(".db-journal") || child.endsWith(".log") || child === ".DS_Store") {
          continue;
        }
        const content = readFileSync(fullPath);
        files[relPath] = content.toString("base64");
      }
    }
  }
  walk(gameDir);

  const pkgPath = join(process.cwd(), "package.json");
  if (existsSync(pkgPath)) {
    files["package.json"] = readFileSync(pkgPath).toString("base64");
  }

  files["config.json"] = readFileSync(configPath).toString("base64");

  const fileCount = Object.keys(files).length;
  console.log(dim(`Packed ${fileCount} files.`));

  console.log(dim("Uploading game to Tuicraft Hub..."));

  try {
    const uploadRes = await fetch(`${hubUrl}/api/publish/upload`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
      },
      body: JSON.stringify({
        gameTitle,
        gameDescription,
        gameSlug,
        files
      })
    });

    const uploadData: any = await uploadRes.json();
    if (!uploadRes.ok) {
      throw new Error(uploadData.message || "Upload failed.");
    }

    console.log(green(bold("\n🎉 Game published successfully!")));
    console.log(`Play via SSH:  ${cyan(`ssh play.tuicraft.com`)} (and select ${bold(gameTitle)})`);
    console.log(`Play via Web:  ${cyan(`${hubUrl}/${gameSlug}`)}\n`);
  } catch (err: any) {
    console.error(red(`\n❌ Upload Error: ${err.message}`));
    process.exit(1);
  }
}

async function scaffold() {
  console.log(cyan(bold("      --- Multiplayer SSH & Web TUI Game Scaffolder --- \n")));

  const projectNameInput = prompt(cyan(bold("? Project name (default: my-tui-game):")), "my-tui-game");
  const projectName = (projectNameInput ? projectNameInput.trim() : "my-tui-game") || "my-tui-game";

  const targetPath = join(process.cwd(), projectName);

  if (existsSync(targetPath)) {
    const overwrite = prompt(yellow(bold(`! Directory '${projectName}' already exists. Overwrite? (y/N):`)), "n");
    if (overwrite?.toLowerCase() !== "y") {
      console.log(red("\nScaffolding aborted."));
      process.exit(0);
    }
  }

  console.log(`\nScaffolding project in ${green(targetPath)}...\n`);

  const templateDir = join(import.meta.dir, "..");

  function copyRecursive(src: string, dest: string) {
    const stats = statSync(src);
    if (stats.isDirectory()) {
      const baseName = basename(src);
      if (baseName === "node_modules" || baseName === ".git" || baseName === "data" || baseName === ".gemini" || baseName === "bin" || src === targetPath) {
        return;
      }
      
      mkdirSync(dest, { recursive: true });
      for (const child of readdirSync(src)) {
        copyRecursive(join(src, child), join(dest, child));
      }
    } else {
      const baseName = basename(src);
      if (baseName === "bun.lock" || baseName === "game.db" || baseName === "config.json" || src.endsWith(".db")) {
        return;
      }

      mkdirSync(dirname(dest), { recursive: true });
      
      if (baseName === "package.json") {
        try {
          const pkgData = JSON.parse(readFileSync(src, "utf-8"));
          pkgData.name = projectName;
          pkgData.private = undefined;
          writeFileSync(dest, JSON.stringify(pkgData, null, 2), "utf-8");
        } catch (err) {
          writeFileSync(dest, readFileSync(src));
        }
      } else {
        writeFileSync(dest, readFileSync(src));
      }
      console.log(`  Created: ${green(dest.replace(process.cwd() + "/", ""))}`);
    }
  }

  function basename(path: string): string {
    return path.split(/[\\/]/).pop() || "";
  }

  try {
    copyRecursive(templateDir, targetPath);

    const defaultConfig = {
      gamePort: 10022,
      adminPort: 10023,
      webPort: 13000,
      databasePath: "game.db",
      adminFingerprints: [],
      gameTitle: "TuiEngine",
      gameDescription: "Multiplayer SSH Terminal Game Framework"
    };
    writeFileSync(join(targetPath, "config.json"), JSON.stringify(defaultConfig, null, 2), "utf-8");

    console.log(green(bold("\n🎉 Project successfully scaffolded!\n")));
    console.log("To run your TUI game dev server:");
    console.log(cyan(`  cd ${projectName}`));
    console.log(cyan("  bun install"));
    console.log(cyan("  bun run dev\n"));
  } catch (err) {
    console.error(red("\nFatal scaffolding error:"), err);
    process.exit(1);
  }
}
