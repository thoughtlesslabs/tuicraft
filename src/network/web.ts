import { serve } from "bun";
import { Client } from "ssh2";
import { loadConfig } from "../config";

interface WebServerOptions {
  onMcpRequest?: (req: Request) => Promise<Response> | Response;
  customRoutes?: Record<string, (req: Request) => Promise<Response> | Response>;
}

function getWebPageHTML(title: string, description: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <title>${title} - Web Client</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover" />
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;800&family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/mshaugh/nerdfont-webfonts@v3.0.0/build/firacode-nerd-font.css" />
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.css" />
  <script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.js"></script>
  <style>
    :root {
      --bg: #090e1a;
      --panel: rgba(15, 23, 42, 0.65);
      --border: rgba(56, 189, 248, 0.25);
      --border-hover: rgba(56, 189, 248, 0.5);
      --primary: #38bdf8;
      --accent: #ec4899;
      --success: #22c55e;
      --warning: #eab308;
      --text: #f1f5f9;
      --text-muted: #94a3b8;
    }
    body {
      background-color: #0b0f19;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: flex-start;
      height: 100vh;
      width: 100vw;
      overflow: hidden;
      font-family: 'Outfit', sans-serif;
      position: relative;
    }
    header {
      width: 100%;
      max-width: 900px;
      padding: 15px 20px 5px 20px;
      box-sizing: border-box;
      text-align: center;
      z-index: 10;
    }
    .logo-container {
      font-family: 'JetBrains Mono', monospace;
      color: var(--primary);
      font-size: 1.8rem;
      font-weight: 700;
      text-shadow: 0 0 20px rgba(56, 189, 248, 0.4);
      margin-bottom: 4px;
      letter-spacing: -1px;
    }
    .nav-links {
      display: flex;
      justify-content: center;
      gap: 20px;
      margin-bottom: 5px;
    }
    .nav-links a {
      color: var(--text-muted);
      text-decoration: none;
      font-weight: 600;
      font-size: 1rem;
      padding: 8px 16px;
      border-radius: 8px;
      border: 1px solid transparent;
      transition: all 0.2s;
    }
    .nav-links a:hover, .nav-links a.active {
      color: var(--primary);
      background: var(--panel);
      border-color: var(--border);
      box-shadow: 0 4px 12px rgba(56, 189, 248, 0.05);
    }
    #terminal-container {
      width: 96vw;
      height: calc(100vh - 120px);
      border: 3px solid #1e293b;
      box-shadow: 0 0 30px rgba(56, 189, 248, 0.15);
      border-radius: 8px;
      padding: 8px;
      background-color: #000000;
      box-sizing: border-box;
    }
    .xterm {
      padding: 4px;
    }
    /* Mobile Overlay Container */
    #mobile-controls {
      display: none;
      position: absolute;
      width: 100vw;
      height: 100vh;
      top: 0;
      left: 0;
      pointer-events: none;
      z-index: 1000;
    }
    @media (max-width: 768px), (pointer: coarse) {
      #mobile-controls {
        display: block;
      }
    }
    .mobile-btn {
      pointer-events: auto;
      background: rgba(15, 23, 42, 0.7);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      border: 1px solid rgba(56, 189, 248, 0.35);
      color: #38bdf8;
      border-radius: 50%;
      display: flex;
      justify-content: center;
      align-items: center;
      font-weight: bold;
      user-select: none;
      -webkit-user-select: none;
      touch-action: manipulation;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5), 0 0 10px rgba(56, 189, 248, 0.1);
      transition: background 0.1s, transform 0.05s, border-color 0.1s;
      font-family: system-ui, -apple-system, sans-serif;
    }
    .mobile-btn:active {
      background: rgba(56, 189, 248, 0.35);
      transform: scale(0.9);
      border-color: #38bdf8;
      box-shadow: 0 0 15px rgba(56, 189, 248, 0.5);
    }
    /* D-Pad Placement */
    #dpad-container {
      position: absolute;
      bottom: 24px;
      left: 24px;
      width: 150px;
      height: 150px;
      pointer-events: none;
    }
    #btn-up { position: absolute; top: 0; left: 50px; width: 50px; height: 50px; border-radius: 12px 12px 0 0; }
    #btn-left { position: absolute; top: 50px; left: 0; width: 50px; height: 50px; border-radius: 12px 0 0 12px; }
    #btn-down { position: absolute; top: 100px; left: 50px; width: 50px; height: 50px; border-radius: 0 0 12px 12px; }
    #btn-right { position: absolute; top: 50px; left: 100px; width: 50px; height: 50px; border-radius: 0 12px 12px 0; }
    #dpad-center {
      position: absolute;
      top: 50px;
      left: 50px;
      width: 50px;
      height: 50px;
      background: rgba(15, 23, 42, 0.85);
      border: 1px solid rgba(56, 189, 248, 0.15);
    }
    /* Actions Deck Placement */
    #actions-container {
      position: absolute;
      bottom: 24px;
      right: 24px;
      width: 180px;
      height: 150px;
      display: grid;
      grid-template-areas:
        "inv option lobby"
        "chat action action";
      grid-gap: 12px;
      pointer-events: none;
    }
    #btn-inv { grid-area: inv; width: 48px; height: 48px; font-size: 13px; }
    #btn-opt { grid-area: option; width: 48px; height: 48px; font-size: 13px; border-color: rgba(244, 63, 94, 0.5); color: #f43f5e; }
    #btn-lobby { grid-area: lobby; width: 48px; height: 48px; font-size: 11px; border-color: rgba(168, 85, 247, 0.5); color: #a855f7; }
    #btn-chat { grid-area: chat; width: 48px; height: 48px; font-size: 18px; border-color: rgba(34, 197, 94, 0.5); color: #22c55e; }
    #btn-action { grid-area: action; height: 48px; border-radius: 24px; font-size: 15px; width: 108px; letter-spacing: 1px; }

    /* Floating Chat Typing Overlay */
    #mobile-chat-bar {
      display: none;
      position: absolute;
      bottom: 190px;
      left: 5%;
      width: 90%;
      background: rgba(15, 23, 42, 0.95);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 2px solid #38bdf8;
      border-radius: 12px;
      padding: 10px 14px;
      box-shadow: 0 4px 25px rgba(0, 0, 0, 0.6), 0 0 20px rgba(56, 189, 248, 0.25);
      z-index: 1010;
      pointer-events: auto;
      align-items: center;
      justify-content: space-between;
      box-sizing: border-box;
    }
    #mobile-chat-input {
      flex-grow: 1;
      background: transparent;
      border: none;
      color: #fff;
      font-size: 16px;
      outline: none;
      font-family: monospace;
      margin-right: 12px;
    }
    #mobile-chat-send {
      background: #38bdf8;
      color: #0b0f19;
      border: none;
      border-radius: 6px;
      padding: 8px 16px;
      font-weight: bold;
      font-size: 14px;
      cursor: pointer;
      font-family: system-ui, sans-serif;
      box-shadow: 0 2px 8px rgba(56, 189, 248, 0.3);
    }
  </style>
</head>
<body>
  <header>
    <div class="logo-container">${title.toUpperCase()}</div>
    <div class="nav-links">
      <a href="/" class="active">Terminal</a>
      <a href="/guide">Guide</a>
    </div>
  </header>
  <div id="terminal-container"></div>

  <!-- Mobile Controls Overlay -->
  <div id="mobile-controls">
    <!-- D-Pad -->
    <div id="dpad-container">
      <div id="btn-up" class="mobile-btn" data-key="w">▲</div>
      <div id="btn-left" class="mobile-btn" data-key="a">◀</div>
      <div id="dpad-center"></div>
      <div id="btn-down" class="mobile-btn" data-key="s">▼</div>
      <div id="btn-right" class="mobile-btn" data-key="d">▶</div>
    </div>

    <!-- Action Deck -->
    <div id="actions-container">
      <div id="btn-inv" class="mobile-btn" data-key="i">Menu</div>
      <div id="btn-opt" class="mobile-btn" data-key="f">Action 2</div>
      <div id="btn-lobby" class="mobile-btn" data-lobby="true">Exit</div>
      <div id="btn-chat" class="mobile-btn" data-chat="true">💬</div>
      <div id="btn-action" class="mobile-btn" data-key=" ">ACTION</div>
    </div>
  </div>

  <!-- Mobile Chat bar -->
  <div id="mobile-chat-bar">
    <input type="text" id="mobile-chat-input" placeholder="Type message or command..." autocomplete="off" />
    <button id="mobile-chat-send">Send</button>
  </div>

  <script>
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: '"FiraCode Nerd Font", "Courier New", Courier, monospace',
      fontSize: 16,
      theme: {
        background: '#000000',
        foreground: '#cbd5e1',
        cursor: '#38bdf8'
      }
    });

    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(document.getElementById('terminal-container'));

    function adjustScale() {
      const container = document.getElementById('terminal-container');
      const isMobile = window.innerWidth <= 768 || ('ontouchstart' in window);
      
      if (isMobile) {
        const targetWidth = 800;
        const targetHeight = 480;
        
        container.style.width = targetWidth + 'px';
        container.style.height = targetHeight + 'px';
        
        fitAddon.fit();
        
        const scaleX = (window.innerWidth * 0.96) / targetWidth;
        const availableHeight = window.innerHeight - 310;
        const scaleY = availableHeight / targetHeight;
        const scale = Math.min(scaleX, scaleY, 1);
        
        container.style.transform = 'scale(' + scale + ')';
        container.style.transformOrigin = 'top center';
        container.style.position = 'absolute';
        container.style.top = '110px';
      } else {
        container.style.width = '96vw';
        container.style.height = 'calc(100vh - 120px)';
        container.style.transform = 'none';
        container.style.position = 'static';
        fitAddon.fit();
      }
    }

    adjustScale();
    term.focus();

    term.parser.registerOscHandler(999, token => {
      if (token === "clear") {
        localStorage.removeItem("game_session_token");
      } else {
        localStorage.setItem("game_session_token", token);
      }
      return true;
    });

    let ws = null;
    let reconnectTimeout = null;
    let overlay = null;

    function showOverlay() {
      if (overlay) return;
      overlay = document.createElement("div");
      overlay.style.position = "absolute";
      overlay.style.top = "0";
      overlay.style.left = "0";
      overlay.style.width = "100vw";
      overlay.style.height = "100vh";
      overlay.style.backgroundColor = "rgba(11, 15, 25, 0.85)";
      overlay.style.backdropFilter = "blur(5px)";
      overlay.style.display = "flex";
      overlay.style.flexDirection = "column";
      overlay.style.justifyContent = "center";
      overlay.style.alignItems = "center";
      overlay.style.color = "#38bdf8";
      overlay.style.fontSize = "20px";
      overlay.style.zIndex = "9999";
      
      const spinner = document.createElement("div");
      spinner.style.border = "4px solid rgba(56, 189, 248, 0.1)";
      spinner.style.width = "40px";
      spinner.style.height = "40px";
      spinner.style.borderRadius = "50%";
      spinner.style.borderLeftColor = "#38bdf8";
      spinner.style.animation = "spin 1s linear infinite";
      spinner.style.marginBottom = "20px";
      
      const style = document.createElement("style");
      style.textContent = "@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }";
      document.head.appendChild(style);
      
      const text = document.createElement("div");
      text.innerText = "Connection lost. Reconnecting...";
      
      overlay.appendChild(spinner);
      overlay.appendChild(text);
      document.body.appendChild(overlay);
    }

    function removeOverlay() {
      if (overlay) {
        overlay.remove();
        overlay = null;
      }
    }

    function connect() {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = protocol + '//' + window.location.host + '/ws';
      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        removeOverlay();
        const token = localStorage.getItem("game_session_token");
        if (token) {
          ws.send(JSON.stringify(["resume", token, term.cols, term.rows]));
        } else {
          ws.send(JSON.stringify(["resize", term.cols, term.rows]));
        }
      };

      ws.onmessage = (event) => {
        if (event.data instanceof Blob) {
          event.data.arrayBuffer().then(buf => {
            term.write(new Uint8Array(buf));
          });
        } else {
          term.write(event.data);
        }
      };

      ws.onclose = () => {
        showOverlay();
        if (reconnectTimeout) clearTimeout(reconnectTimeout);
        reconnectTimeout = setTimeout(connect, 2000);
      };
    }

    term.onData(data => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });

    window.addEventListener('resize', () => {
      adjustScale();
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(["resize", term.cols, term.rows]));
      }
    });

    document.querySelectorAll('.mobile-btn').forEach(btn => {
      const handler = (e) => {
        e.preventDefault();
        
        const key = btn.getAttribute('data-key');
        const isChat = btn.getAttribute('data-chat');
        const isLobby = btn.getAttribute('data-lobby');
        
        if (key && ws && ws.readyState === WebSocket.OPEN) {
          ws.send(key);
        } else if (isChat) {
          const chatBar = document.getElementById('mobile-chat-bar');
          const chatInput = document.getElementById('mobile-chat-input');
          chatBar.style.display = 'flex';
          chatInput.focus();
        } else if (isLobby && ws && ws.readyState === WebSocket.OPEN) {
          ws.send('/lobby\\r');
        }
      };
      
      btn.addEventListener('touchstart', handler, { passive: false });
      btn.addEventListener('mousedown', handler);
    });

    const sendChat = () => {
      const chatBar = document.getElementById('mobile-chat-bar');
      const chatInput = document.getElementById('mobile-chat-input');
      const text = chatInput.value.trim();
      if (text && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(text + '\\r');
      }
      chatInput.value = '';
      chatBar.style.display = 'none';
      term.focus();
    };

    document.getElementById('mobile-chat-send').addEventListener('click', sendChat);
    document.getElementById('mobile-chat-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        sendChat();
      }
    });

    document.addEventListener('touchstart', (e) => {
      const chatBar = document.getElementById('mobile-chat-bar');
      const btnChat = document.getElementById('btn-chat');
      if (chatBar.style.display === 'flex' && !chatBar.contains(e.target) && e.target !== btnChat) {
        chatBar.style.display = 'none';
        term.focus();
      }
    }, { passive: true });

    connect();
  </script>
</body>
</html>`;
}

function getGuidePageHTML(title: string, description: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <title>${title} - Adventurer's Guide</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;800&family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #090e1a;
      --panel: rgba(15, 23, 42, 0.65);
      --border: rgba(56, 189, 248, 0.25);
      --border-hover: rgba(56, 189, 248, 0.5);
      --primary: #38bdf8;
      --accent: #ec4899;
      --success: #22c55e;
      --warning: #eab308;
      --text: #f1f5f9;
      --text-muted: #94a3b8;
    }
    body {
      background-color: var(--bg);
      background-image: radial-gradient(circle at top right, rgba(56, 189, 248, 0.08), transparent 450px),
                        radial-gradient(circle at bottom left, rgba(236, 72, 153, 0.05), transparent 400px);
      color: var(--text);
      font-family: 'Outfit', sans-serif;
      margin: 0;
      padding: 0;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
    }
    header {
      width: 100%;
      max-width: 900px;
      padding: 40px 20px 20px 20px;
      box-sizing: border-box;
      text-align: center;
    }
    .logo-container {
      font-family: 'JetBrains Mono', monospace;
      color: var(--primary);
      font-size: 2.2rem;
      font-weight: 700;
      text-shadow: 0 0 20px rgba(56, 189, 248, 0.4);
      margin-bottom: 8px;
      letter-spacing: -1px;
    }
    .subtitle {
      color: var(--text-muted);
      font-size: 1.1rem;
      margin: 0 0 30px 0;
    }
    main {
      width: 100%;
      max-width: 900px;
      padding: 0 20px 60px 20px;
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      gap: 30px;
    }
    .nav-links {
      display: flex;
      justify-content: center;
      gap: 20px;
      margin-bottom: 10px;
    }
    .nav-links a {
      color: var(--text-muted);
      text-decoration: none;
      font-weight: 600;
      font-size: 1rem;
      padding: 8px 16px;
      border-radius: 8px;
      border: 1px solid transparent;
      transition: all 0.2s;
    }
    .nav-links a:hover, .nav-links a.active {
      color: var(--primary);
      background: var(--panel);
      border-color: var(--border);
      box-shadow: 0 4px 12px rgba(56, 189, 248, 0.05);
    }
    .card {
      background: var(--panel);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 30px;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4);
    }
    h2 {
      font-size: 1.5rem;
      color: var(--primary);
      margin-top: 0;
      margin-bottom: 20px;
      border-bottom: 1px solid var(--border);
      padding-bottom: 8px;
      font-family: 'JetBrains Mono', monospace;
    }
    p {
      line-height: 1.6;
      color: var(--text-muted);
    }
    .code-block {
      background: rgba(0, 0, 0, 0.6);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 16px;
      font-family: 'JetBrains Mono', monospace;
      color: var(--success);
    }
  </style>
</head>
<body>
  <header>
    <div class="logo-container">${title.toUpperCase()}</div>
    <div class="subtitle">${description}</div>
    <div class="nav-links">
      <a href="/">Terminal</a>
      <a href="/guide" class="active">Guide</a>
    </div>
  </header>
  <main>
    <div class="card">
      <h2>How to Connect</h2>
      <p>Connect natively from your terminal using standard SSH:</p>
      <div class="code-block">ssh localhost -p 2222</div>
      <p>Alternatively, you can play directly from your web browser using the <strong>Terminal</strong> client tab above.</p>
    </div>
  </main>
</body>
</html>`;
}

const connectionsPerIp = new Map<string, number>();

export function startWebServer(options: WebServerOptions = {}) {
  const config = loadConfig();

  serve({
    port: config.webPort,
    async fetch(req, server) {
      const url = new URL(req.url);

      // Handle custom user-defined routes
      if (options.customRoutes && options.customRoutes[url.pathname]) {
        return options.customRoutes[url.pathname]!(req);
      }

      // Handle WebSocket upgrade
      if (url.pathname === "/ws") {
        const ip = server.requestIP(req)?.address || "unknown";
        const success = (server as any).upgrade(req, { data: { ip } });
        if (success) return undefined;
        return new Response("WebSocket connection failed", { status: 400 });
      }

      // Route MCP SSE requests
      if (url.pathname.startsWith("/mcp") && options.onMcpRequest) {
        return options.onMcpRequest(req);
      }

      // Serve index page
      if (url.pathname === "/" || url.pathname === "/index.html") {
        return new Response(getWebPageHTML(config.gameTitle, config.gameDescription), {
          headers: { "Content-Type": "text/html" }
        });
      }

      // Serve default Guide page
      if (url.pathname === "/guide" || url.pathname === "/guide.html" || url.pathname === "/help") {
        return new Response(getGuidePageHTML(config.gameTitle, config.gameDescription), {
          headers: { "Content-Type": "text/html" }
        });
      }

      return new Response("Not Found", { status: 404 });
    },
    websocket: {
      open(ws: any) {
        const ip = ws.data?.ip || "unknown";
        const currentCount = connectionsPerIp.get(ip) || 0;
        if (currentCount >= 5) {
          console.warn(`[Web Terminal] Rate limit exceeded for IP: ${ip}`);
          ws.send("\r\n\x1b[31;1m[Too many connections from this IP. Max 5.]\x1b[0m\r\n");
          ws.close();
          return;
        }
        connectionsPerIp.set(ip, currentCount + 1);
        console.log(`[Web Terminal] Connected from ${ip}`);
        ws.data = {
          ip,
          counted: true,
          initiated: false,
          stream: null,
          conn: null
        };
      },
      message(ws: any, message) {
        const state = ws.data as { ip: string; counted?: boolean; initiated: boolean; stream: any; conn: any };
        if (!state.initiated) {
          state.initiated = true;
          let token: string | null = null;
          let cols = 80;
          let rows = 24;

          if (typeof message === "string" && message.startsWith("[")) {
            try {
              const parsed = JSON.parse(message);
              if (parsed[0] === "resume") {
                token = parsed[1];
                cols = parsed[2];
                rows = parsed[3];
              } else if (parsed[0] === "resize") {
                cols = parsed[1];
                rows = parsed[2];
              }
            } catch (e) {}
          }

          const conn = new Client();
          state.conn = conn;

          conn.on("ready", () => {
            conn.shell({ term: "xterm-256color", cols, rows }, (err: Error | undefined, stream: any) => {
              if (err) {
                console.error("[Web Terminal] SSH Bridge error:", err);
                ws.close();
                return;
              }
              state.stream = stream;
              stream.on("data", (chunk: Buffer) => {
                ws.send(chunk);
              });
              stream.on("close", () => {
                ws.close();
              });
            });
          });

          conn.on("error", (err: Error) => {
            console.error("[Web Terminal] Connection error:", err);
            ws.close();
          });

          // Authenticate with local SSH server
          const username = token ? `token:${token}` : "web-player";
          conn.connect({
            host: "127.0.0.1",
            port: config.gamePort,
            username,
            password: "web"
          });
          return;
        }

        if (!state.stream) return;

        if (typeof message === "string" && message.startsWith("[")) {
          try {
            const parsed = JSON.parse(message);
            if (parsed[0] === "resize") {
              const [_, cols, rows] = parsed;
              state.stream.setWindow(rows, cols, 0, 0);
              return;
            }
          } catch (e) {}
        }

        state.stream.write(message);
      },
      close(ws: any) {
        const state = ws.data as { ip: string; counted?: boolean; initiated: boolean; stream: any; conn: any } | undefined;
        if (state) {
          if (state.ip && state.counted) {
            const currentCount = connectionsPerIp.get(state.ip) || 0;
            if (currentCount > 1) {
              connectionsPerIp.set(state.ip, currentCount - 1);
            } else {
              connectionsPerIp.delete(state.ip);
            }
          }
          if (state.stream) state.stream.end();
          if (state.conn) state.conn.end();
        }
      }
    }
  });

  console.log(`Web Terminal Server started at http://localhost:${config.webPort}`);
}
