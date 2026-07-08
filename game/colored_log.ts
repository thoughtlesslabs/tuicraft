import { 
  BoxOptions,
  BoxRenderable, 
  TextRenderable, 
  t, 
  green, 
  red, 
  yellow, 
  magenta, 
  cyan, 
  blue, 
  bold, 
  StyledText, 
  type TextChunk, 
  type RenderContext 
} from "@opentui/core";
import { getTheme, createThemeStyles, type ChatLogMessage } from "../src/index";

export class ColoredChatLogComponent extends BoxRenderable {
  private textRenderable: TextRenderable;
  public scrollOffset = 0;

  constructor(ctx: RenderContext, options: BoxOptions) {
    super(ctx, {
      ...options,
      border: true,
      title: " Chat Log ",
      titleAlignment: "left"
    });

    this.textRenderable = new TextRenderable(ctx, {
      width: "100%",
      height: "100%",
      paddingLeft: 1
    });
    this.add(this.textRenderable);
  }

  public scrollUp() {
    this.scrollOffset += 3;
  }

  public scrollDown() {
    this.scrollOffset = Math.max(0, this.scrollOffset - 3);
  }

  public resetScroll() {
    this.scrollOffset = 0;
  }

  updateLogs(
    chats: ChatLogMessage[],
    playerName: string,
    cols: number,
    themeName: string,
    themeMode?: "light" | "dark" | null
  ) {
    const theme = getTheme(themeName, themeMode);
    this.textRenderable.fg = theme.defaultFg;

    const filteredChats = chats.filter(c => {
      if (c.scope === "whisper") {
        return c.sender === playerName || c.recipient === playerName;
      }
      return true;
    });

    const chatChunks: TextChunk[] = [];
    const colWidth = Math.max(20, Math.floor(cols / 2) - 4);
    const visibleLines = Math.max(3, (typeof this.height === "number" ? this.height : 15) - 4);

    const maxScroll = Math.max(0, filteredChats.length - 1);
    if (this.scrollOffset > maxScroll) {
      this.scrollOffset = maxScroll;
    }

    const end = Math.max(0, filteredChats.length - this.scrollOffset);
    let start = end;
    let lineCount = 0;

    for (let i = end - 1; i >= 0; i--) {
      const c = filteredChats[i]!;
      const tagLen = c.scope === "whisper" ? (c.sender === playerName ? 10 + (c.recipient?.length || 0) : 12 + c.sender.length) : 8 + c.sender.length + 2;
      const msgLen = 10 + tagLen + c.text.length;
      const lines = Math.ceil(msgLen / colWidth);

      if (lineCount + lines > visibleLines) {
        if (start === end) {
          start = i;
        }
        break;
      }
      lineCount += lines;
      start = i;
    }

    const hasMoreAbove = start > 0;
    const hasMoreBelow = this.scrollOffset > 0;

    if (hasMoreAbove && hasMoreBelow) {
      this.title = ` Chat Log [▲/▼ Scrolled: ${this.scrollOffset}] `;
    } else if (hasMoreAbove) {
      this.title = ` Chat Log [▲ Scroll Up: '['] `;
    } else if (hasMoreBelow) {
      this.title = ` Chat Log [▼ Scroll Down: ']'] `;
    } else {
      this.title = " Chat Log ";
    }

    const formatText = (txt: string): TextChunk[] => {
      const parts = txt.split(/(@[a-zA-Z0-9_]+)/g);
      const chunks: TextChunk[] = [];
      for (const part of parts) {
        if (part.startsWith("@")) {
          const mentionedUser = part.slice(1).toLowerCase();
          if (mentionedUser === playerName.toLowerCase()) {
            // Self mentions stand out in bold green
            chunks.push(green(bold(part)));
          } else {
            // Other mentions stand out in bold cyan
            chunks.push(cyan(bold(part)));
          }
        } else {
          chunks.push({ __isChunk: true, text: part });
        }
      }
      return chunks;
    };

    filteredChats.slice(start, end).forEach(c => {
      if (c.scope === "whisper") {
        if (c.sender === playerName) {
          chatChunks.push(...t`[${c.time}] ${magenta(bold("To " + c.recipient))}: `.chunks);
          chatChunks.push(...formatText(c.text));
          chatChunks.push({ __isChunk: true, text: "\n" });
        } else {
          chatChunks.push(...t`[${c.time}] ${magenta(bold("From " + c.sender))}: `.chunks);
          chatChunks.push(...formatText(c.text));
          chatChunks.push({ __isChunk: true, text: "\n" });
        }
      } else {
        const scopeTag = c.scope === "global" ? blue("[Global]") : green("[Local]");
        if (c.sender === "System" || c.sender === "[SYSTEM]" || c.sender === "SERVER") {
          chatChunks.push(...t`[${c.time}] ${scopeTag} ${red(bold(c.sender))}: `.chunks);
          chatChunks.push(yellow(bold(c.text)));
          chatChunks.push({ __isChunk: true, text: "\n" });
        } else {
          chatChunks.push(...t`[${c.time}] ${scopeTag} ${cyan(c.sender)}: `.chunks);
          chatChunks.push(...formatText(c.text));
          chatChunks.push({ __isChunk: true, text: "\n" });
        }
      }
    });

    this.textRenderable.content = new StyledText(chatChunks);
    this.requestRender();
  }
}
