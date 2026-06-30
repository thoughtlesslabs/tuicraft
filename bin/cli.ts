#!/usr/bin/env bun
import { mkdirSync, existsSync, readdirSync, statSync, writeFileSync, readFileSync } from "fs";
import { join, dirname } from "path";

// ANSI Styling Helpers
const cyan = (text: string) => `\x1b[36m${text}\x1b[0m`;
const green = (text: string) => `\x1b[32m${text}\x1b[0m`;
const yellow = (text: string) => `\x1b[33m${text}\x1b[0m`;
const red = (text: string) => `\x1b[31m${text}\x1b[0m`;
const bold = (text: string) => `\x1b[1m${text}\x1b[0m`;
const magenta = (text: string) => `\x1b[35m${text}\x1b[0m`;

console.log(magenta(bold(`
████████╗██╗   ██╗██╗███████╗███╗   ██╗ ██████╗ ██╗███╗   ██╗███████╗
╚══██╪══╝██║   ██║██║██╔════╝████╗  ██║██╔════╝ ██║████╗  ██║██╔════╝
   ██║   ██║   ██║██║█████╗  ██╔██╗ ██║██║  ███╗██║██╔██╗ ██║█████╗  
   ██║   ██║   ██║██║██╔══╝  ██║╚██╗██║██║   ██║██║██║╚██╗██║██╔══╝  
   ██║   ╚██████╔╝██║███████╗██║ ╚████║╚██████╔╝██║██║ ╚████║███████╗
   ╚═╝    ╚═════╝ ╚═╝╚══════╝╚═╝  ╚═══╝ ╚═════╝ ╚═╝╚═╝  ╚═══╝╚══════╝
`)));
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
    // Skip dev/node files and the target path itself to prevent infinite loop
    if (baseName === "node_modules" || baseName === ".git" || baseName === "data" || baseName === ".gemini" || baseName === "bin" || src === targetPath) {
      return;
    }
    
    mkdirSync(dest, { recursive: true });
    for (const child of readdirSync(src)) {
      copyRecursive(join(src, child), join(dest, child));
    }
  } else {
    const baseName = basename(src);
    // Skip locks and local databases
    if (baseName === "bun.lock" || baseName === "game.db" || baseName === "config.json" || src.endsWith(".db")) {
      return;
    }

    mkdirSync(dirname(dest), { recursive: true });
    
    if (baseName === "package.json") {
      // Modify package.json to match new name
      try {
        const pkgData = JSON.parse(readFileSync(src, "utf-8"));
        pkgData.name = projectName;
        pkgData.private = undefined; // Make publishable if desired
        writeFileSync(dest, JSON.stringify(pkgData, null, 2), "utf-8");
      } catch (err) {
        // Fallback to direct write
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

  // Write default config.json to the scaffolded project
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
