import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

import { BoxRenderable, TextRenderable, t, green, red, yellow, magenta, cyan, blue, bold, StyledText, type RenderContext } from "@opentui/core";
import { ChatInputComponent } from "./components/input";
import { getAccountByUsername, createAccount } from "../db/accounts";
import { getDB } from "../db/client";

export type AuthWizardState = 
  | "choose-auth"
  | "enter-user-login"
  | "enter-pass-login"
  | "enter-user-reg"
  | "enter-pass-reg"
  | "authenticated";

export class AuthWizard {
  private ctx: RenderContext;
  private cols: number;
  private rows: number;
  private state: AuthWizardState = "choose-auth";
  private tempUsername = "";
  private errorMessage = "";
  private onAuthenticated: (accountId: string, username: string) => void;

  // Renderables
  public box: BoxRenderable;
  private textElement: TextRenderable;
  private inputField: ChatInputComponent;

  constructor(
    ctx: RenderContext,
    cols: number,
    rows: number,
    onAuthenticated: (accountId: string, username: string) => void
  ) {
    this.ctx = ctx;
    this.cols = cols;
    this.rows = rows;
    this.onAuthenticated = onAuthenticated;

    // SSO Intercept: Check if connecting via central Hub credentials
    let ssoUsername: string | null = null;
    try {
      const { activeSshSessions } = require("../network/ssh");
      for (const sess of activeSshSessions) {
        if (sess.renderer === (ctx as any).renderer || (sess.renderer && sess.renderer.root === (ctx as any).root)) {
          const userStr = sess.identity?.username || "";
          if (userStr.startsWith("hub-user:") && !userStr.startsWith("hub-user:guest-")) {
            ssoUsername = userStr.substring(9); // Extract clean username
          }
          break;
        }
      }
    } catch (e) {}

    if (ssoUsername) {
      const targetUser = ssoUsername;
      this.state = "authenticated";
      
      // Execute login synchronously outside the main initialization frame
      setTimeout(async () => {
        try {
          let acc = getAccountByUsername(targetUser);
          if (!acc) {
            // Auto register Hub account in container local DB
            acc = await createAccount(targetUser, crypto.randomUUID());
          }
          this.onAuthenticated(acc.id, acc.username);
        } catch (err) {
          console.error("[SSO] Auto-registration failed in game container:", err);
        }
      }, 0);
    }

    this.box = new BoxRenderable(ctx, {
      width: 60,
      height: 15,
      border: true,
      borderColor: "#00FF00",
      title: " Account Login & Setup ",
      titleAlignment: "center",
      marginTop: 5,
      marginLeft: Math.max(1, Math.floor((cols - 60) / 2))
    });

    this.textElement = new TextRenderable(ctx, {
      width: "100%",
      height: 9,
      paddingLeft: 0,
      paddingTop: 1
    });
    this.box.add(this.textElement);

    this.inputField = new ChatInputComponent(ctx, {
      width: "100%",
      height: 3,
      title: " Input Terminal ",
      placeholder: "Select option or type here..."
    }, (text) => this.handleInput(text));

    this.box.add(this.inputField);
    this.updateWizardText();
  }

  public getInputField(): ChatInputComponent {
    return this.inputField;
  }

  public handleInput(text: string) {
    this.errorMessage = "";
    const clean = text.trim();

    switch (this.state) {
      case "choose-auth":
        if (clean === "1") {
          this.state = "enter-user-login";
        } else if (clean === "2") {
          this.state = "enter-user-reg";
        } else {
          this.errorMessage = "Invalid selection. Please enter 1 or 2.";
        }
        break;

      case "enter-user-login":
        if (!clean) {
          this.errorMessage = "Username cannot be empty.";
        } else {
          this.tempUsername = clean;
          this.state = "enter-pass-login";
        }
        break;

      case "enter-pass-login":
        this.verifyLogin(this.tempUsername, text);
        break;

      case "enter-user-reg":
        if (!/^[a-zA-Z0-9_]{3,16}$/.test(clean)) {
          this.errorMessage = "Username must be 3-16 chars (letters/numbers/underscores).";
        } else {
          const existing = getAccountByUsername(clean);
          if (existing) {
            this.errorMessage = "Username already exists.";
          } else {
            this.tempUsername = clean;
            this.state = "enter-pass-reg";
          }
        }
        break;

      case "enter-pass-reg":
        if (text.length < 4 || text.length > 32) {
          this.errorMessage = "Password must be 4-32 characters.";
        } else {
          this.registerAccount(this.tempUsername, text);
        }
        break;
    }

    this.updateWizardText();
  }

  private async verifyLogin(username: string, pass: string) {
    const acc = getAccountByUsername(username);
    if (!acc) {
      this.errorMessage = "Account not found.";
      this.state = "enter-user-login";
      this.updateWizardText();
      return;
    }

    const ok = acc.password_hash && await Bun.password.verify(pass, acc.password_hash);
    if (!ok) {
      this.errorMessage = "Incorrect password.";
      this.updateWizardText();
      return;
    }

    // Success
    this.state = "authenticated";
    this.onAuthenticated(acc.id, acc.username);
  }

  private async registerAccount(username: string, pass: string) {
    try {
      const acc = await createAccount(username, pass);
      this.state = "authenticated";
      this.onAuthenticated(acc.id, acc.username);
    } catch (err: any) {
      this.errorMessage = err.message || "Registration failed.";
      this.state = "choose-auth";
      this.updateWizardText();
    }
  }

  public updateWizardText() {
    let content: any = t``;
    const errStr: any = this.errorMessage ? t`\n  Error: ${red(bold(this.errorMessage))}` : t``;

    switch (this.state) {
      case "choose-auth":
        content = t`
  Welcome to the SSH Terminal Console Game!

  Please choose an option:
    ${green("1.")} Log into an existing account
    ${green("2.")} Register a new account

  Type ${green("1")} or ${green("2")} in the input box below.
        `;
        break;

      case "enter-user-login":
        content = t`
  [LOGIN WORKFLOW]

  Please enter your account ${cyan("username")} below:
        `;
        break;

      case "enter-pass-login":
        content = t`
  [LOGIN WORKFLOW]

  Logging in as: ${green(this.tempUsername)}
  Please enter your account ${cyan("password")} below:
        `;
        break;

      case "enter-user-reg":
        content = t`
  [REGISTRATION WORKFLOW]

  Please enter your desired ${cyan("username")} below:
  (3-16 characters, letters, numbers, underscores only)
        `;
        break;

      case "enter-pass-reg":
        content = t`
  [REGISTRATION WORKFLOW]

  Creating account: ${green(this.tempUsername)}
  Please enter a secure ${cyan("password")} below:
  (4-32 characters)
        `;
        break;

      case "authenticated":
        content = t`
  Authenticating session...
        `;
        break;
    }

    this.textElement.content = new StyledText([
      ...content.chunks,
      ...errStr.chunks
    ]);
  }
}
