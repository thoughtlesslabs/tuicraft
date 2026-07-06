#!/usr/bin/env bun
import { mkdirSync, existsSync, readdirSync, statSync, writeFileSync, readFileSync, unlinkSync, rmSync } from "fs";
import { join, dirname, relative } from "path";
import { homedir } from "os";
import { execSync } from "child_process";

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

const isBillingInit = process.argv.includes("billing-init");
const isPublish = process.argv.includes("publish");

if (isBillingInit) {
  await initBilling();
} else if (isPublish) {
  await publish();
} else {
  await scaffold();
}

async function initBilling() {
  console.log(cyan(bold("💳 Tuicraft Billing Initialization Wizard\n")));
  const envPath = join(process.cwd(), ".env");
  
  if (existsSync(envPath)) {
    console.log(yellow("⚠️  A .env file already exists in the current directory."));
    const confirm = prompt("Would you like to overwrite it? (y/N): ", "n");
    if (confirm?.toLowerCase() !== "y") {
      console.log(red("Aborted."));
      return;
    }
  }

  const envTemplate = `# Tuicraft Stripe Monetization Key Pairs
STRIPE_SECRET_KEY=sk_test_placeholder_key
STRIPE_PRICE_ID=price_placeholder_id
# Set to true to test container resource scaling without Stripe charges
ADMIN_BYPASS_BILLING=false
`;

  writeFileSync(envPath, envTemplate, "utf-8");
  console.log(green("🎉 Successfully created template .env file!"));
  console.log(dim("Configure your Stripe private secret key and product Price ID to get started.\n"));
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

  let gameTitle = config.gameTitle || "Unnamed TUI Game";
  let gameDescription = config.gameDescription || "";

  // Catch default template names and guide the developer into renaming their game
  if (gameTitle === "TuiEngine" || gameTitle === "Unnamed TUI Game" || !config.gameTitle) {
    console.log(yellow("⚠️  Placeholder detected: Your game title is currently set to the default 'TuiEngine'."));
    const renameInput = prompt(cyan(bold("Would you like to change your game's title now? (Y/n):")), "y");
    if (renameInput?.toLowerCase() === "y" || renameInput === "") {
      const newTitle = prompt(cyan(bold("Enter your game's title:")), "");
      if (newTitle && newTitle.trim()) {
        gameTitle = newTitle.trim();
        const newDesc = prompt(cyan(bold("Enter a short description for your game (optional):")), gameDescription);
        gameDescription = newDesc ? newDesc.trim() : "";

        // Write the changes back to the local config.json file
        config.gameTitle = gameTitle;
        config.gameDescription = gameDescription;
        try {
          writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
          console.log(green("🎉 Successfully updated config.json with your new game title!\n"));
        } catch (e: any) {
          console.error(yellow(`⚠️  Failed to save config.json: ${e.message}`));
        }
      } else {
        console.log(yellow("No title entered. Proceeding with default names.\n"));
      }
    }
  }

  const gameSlug = gameTitle.toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/-+/g, "-");
  if (gameSlug === "tuiengine") {
    console.error(red("❌ Error: You cannot publish a game with the reserved name 'TuiEngine'. Please change the gameTitle in config.json."));
    process.exit(1);
  }
  if (!gameSlug || gameSlug.length < 3) {
    console.error(red(`❌ Error: Invalid game title '${gameTitle}'. Title must contain alphanumeric characters.`));
    process.exit(1);
  }

  const hubUrl = process.env.TUICRAFT_HUB_URL || "http://play.tuicraft.com";

  // Check engine compatibility with target Hub
  let localEngineVersion = "1.0.0";
  try {
    const localPkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf-8"));
    localEngineVersion = localPkg.tuiengineVersion || "1.0.0";
  } catch (e) {}

  console.log(dim("Checking engine compatibility with target Hub..."));
  let hubVersion = "1.0.0";
  try {
    const vRes = await fetch(`${hubUrl}/api/version`);
    if (vRes.ok) {
      const vData: any = await vRes.json();
      hubVersion = vData.tuiengineVersion || "1.0.0";
    }
  } catch (e) {
    console.log(yellow("⚠️  Could not retrieve Hub engine version. Proceeding with caution.\n"));
  }

  const uParts = localEngineVersion.split(".").map(Number);
  const hParts = hubVersion.split(".").map(Number);
  const uMajor = uParts[0] ?? 0;
  const uMinor = uParts[1] ?? 0;
  const uPatch = uParts[2] ?? 0;
  const hMajor = hParts[0] ?? 0;
  const hMinor = hParts[1] ?? 0;
  const hPatch = hParts[2] ?? 0;

  if (uMajor !== hMajor) {
    console.error(red(`❌ Error: Incompatible engine major version!`));
    console.error(red(`Your project requires TuiEngine v${localEngineVersion} but the target Hub runs v${hubVersion}.`));
    console.error(red(`Please align major versions before publishing.`));
    process.exit(1);
  }

  if (uMinor > hMinor || (uMinor === hMinor && uPatch > hPatch)) {
    console.error(red(`❌ Error: Incompatible engine version!`));
    console.error(red(`Your local engine (v${localEngineVersion}) is newer than the Hub version (v${hubVersion}).`));
    console.error(red(`You cannot publish a game built on a newer engine version until the Hub is updated.`));
    process.exit(1);
  }

  if (uMinor < hMinor || (uMinor === hMinor && uPatch < hPatch)) {
    console.log(yellow(`⚠️  Your local engine version (v${localEngineVersion}) is older than the Hub (v${hubVersion}).`));
    const confirmUpdate = prompt(cyan(bold(`Would you like to auto-update your local engine files to v${hubVersion} now? (Y/n): `)), "y");
    if (confirmUpdate?.toLowerCase() === "y" || confirmUpdate === "") {
      await autoUpdateEngineFiles(hubVersion);
    }
  }

  console.log(`Publishing: ${green(gameTitle)} (${cyan(gameSlug)})`);
  console.log(`Target Hub: ${yellow(hubUrl)}\n`);

  let token = process.env.TUICRAFT_TOKEN || process.env.TUICRAFT_PAT || "";
  const tokenDir = join(homedir(), ".tuicraft");
  const tokenPath = join(tokenDir, "token");

  if (!token && existsSync(tokenPath)) {
    try {
      token = readFileSync(tokenPath, "utf-8").trim();
    } catch (e) {}
  }

  let usingCachedToken = token !== "";

  async function getNewCredentials() {
    usingCachedToken = false;
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

    if (password.startsWith("tc_pat_")) {
      console.log(green("🔑 Personal Access Token (PAT) detected. Using it directly for authentication."));
      token = password;
      return;
    }

    console.log(dim("\nAuthenticating..."));
    
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

      // Save token back to config cache
      try {
        if (!existsSync(tokenDir)) {
          mkdirSync(tokenDir, { recursive: true });
        }
        writeFileSync(tokenPath, token, "utf-8");
      } catch (e: any) {
        console.error(yellow(`⚠️  Failed to save token to cache: ${e.message}`));
      }
    } catch (err: any) {
      console.error(red(`\n❌ Auth Error: ${err.message}`));
      process.exit(1);
    }
  }

  if (!token) {
    await getNewCredentials();
  }

  console.log(cyan("🔍 Running TypeScript validation checks (tsc --noEmit)..."));
  try {
    execSync("bun x tsc --noEmit", { stdio: "inherit" });
    console.log(green("✅ TypeScript validation successful!\n"));
  } catch (err) {
    console.error(red("\n❌ TypeScript validation failed!"));
    console.error(yellow("Tip: If you are importing interfaces or types across files, you must use type-only imports, e.g.:"));
    console.error(bold("     import { type MyInterface } from './types';\n"));
    
    const answer = prompt(yellow("Warning: This game might crash on the production server due to these errors. Proceed anyway? (y/N): "));
    if (answer?.toLowerCase() !== 'y') {
      process.exit(1);
    }
    console.log(yellow("⚠️ Proceeding with publish despite validation warnings...\n"));
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

  let screenshot = "";
  const pngPath = join(process.cwd(), "screenshot.png");
  const jpgPath = join(process.cwd(), "screenshot.jpg");
  if (existsSync(pngPath)) {
    screenshot = readFileSync(pngPath).toString("base64");
    console.log(dim("Found screenshot.png. Packing for upload..."));
  } else if (existsSync(jpgPath)) {
    screenshot = readFileSync(jpgPath).toString("base64");
    console.log(dim("Found screenshot.jpg. Packing for upload..."));
  }

  let uploadSuccess = false;
  let attempts = 0;

  while (!uploadSuccess && attempts < 2) {
    attempts++;
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
          files,
          screenshot
        })
      });

      const uploadData: any = await uploadRes.json();
      if (!uploadRes.ok) {
        if (uploadRes.status === 401 && usingCachedToken) {
          console.log(yellow("⚠️  Cached token expired or invalid. Re-authenticating..."));
          try {
            if (existsSync(tokenPath)) {
              unlinkSync(tokenPath);
            }
          } catch (e) {}
          await getNewCredentials();
          continue;
        }
        throw new Error(uploadData.message || "Upload failed.");
      }

      const finalSlug = uploadData.slug || gameSlug;
      console.log(green(bold("\n🎉 Game published successfully!")));
      console.log(`Play via SSH:  ${cyan(`ssh play.tuicraft.com`)} (and select ${bold(gameTitle)})`);
      console.log(`Play via Web:  ${cyan(`${hubUrl}/${finalSlug}`)}\n`);
      uploadSuccess = true;
    } catch (err: any) {
      console.error(red(`\n❌ Upload Error: ${err.message}`));
      process.exit(1);
    }
  }
}

async function autoUpdateEngineFiles(targetVersion: string) {
  console.log(cyan("\n🔄 Auto-updating local engine files..."));
  const tmpZip = join(process.cwd(), "tmp_engine_update.zip");
  const tmpDir = join(process.cwd(), "tmp_engine_update_dir");

  try {
    console.log(dim("Downloading latest engine codebase from GitHub..."));
    const response = await fetch("https://github.com/thoughtlesslabs/tuicraft/archive/refs/heads/main.zip");
    if (!response.ok) {
      throw new Error(`Failed to download repository: ${response.statusText}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    writeFileSync(tmpZip, Buffer.from(arrayBuffer));

    console.log(dim("Extracting archive..."));
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
    mkdirSync(tmpDir, { recursive: true });

    execSync(`unzip -o "${tmpZip}" -d "${tmpDir}"`, { stdio: "ignore" });

    console.log(dim("Overwriting local src/ and bin/ directories..."));
    const srcSource = join(tmpDir, "tuicraft-main", "src");
    const binSource = join(tmpDir, "tuicraft-main", "bin");

    if (existsSync(srcSource)) {
      const localSrc = join(process.cwd(), "src");
      if (existsSync(localSrc)) {
        rmSync(localSrc, { recursive: true, force: true });
      }
      mkdirSync(localSrc, { recursive: true });
      copyRecursiveSync(srcSource, localSrc);
    }

    if (existsSync(binSource)) {
      const localBin = join(process.cwd(), "bin");
      if (existsSync(localBin)) {
        rmSync(localBin, { recursive: true, force: true });
      }
      mkdirSync(localBin, { recursive: true });
      copyRecursiveSync(binSource, localBin);
    }

    const pkgPath = join(process.cwd(), "package.json");
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      pkg.tuiengineVersion = targetVersion;
      writeFileSync(pkgPath, JSON.stringify(pkg, null, 2), "utf-8");
    }

    console.log(green("🎉 Local engine files updated successfully to v" + targetVersion + "!\n"));
  } catch (err: any) {
    console.error(red(`❌ Auto-update failed: ${err.message}`));
    console.log(yellow("Continuing with publishing using existing local files...\n"));
  } finally {
    try {
      if (existsSync(tmpZip)) unlinkSync(tmpZip);
      if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
    } catch (e) {}
  }
}

function copyRecursiveSync(src: string, dest: string) {
  const stats = statSync(src);
  if (stats.isDirectory()) {
    if (!existsSync(dest)) {
      mkdirSync(dest, { recursive: true });
    }
    for (const child of readdirSync(src)) {
      copyRecursiveSync(join(src, child), join(dest, child));
    }
  } else {
    writeFileSync(dest, readFileSync(src));
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
      if (baseName === "node_modules" || baseName === ".git" || baseName === "data" || baseName === ".gemini" || src === targetPath) {
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
