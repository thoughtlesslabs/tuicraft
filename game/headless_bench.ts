import { Writable, Readable } from "node:stream";
import { 
  createCliRenderer, 
  BoxRenderable, 
  FrameBufferRenderable, 
  TextRenderable, 
  RGBA, 
  StyledText,
  t,
  green,
  cyan,
  bold
} from "@opentui/core";

// Define a simulated grid map
const MAP_W = 15;
const MAP_H = 8;

interface BenchPlayer {
  id: string;
  x: number;
  y: number;
}

async function runBenchmark() {
  console.log("=== Starting Headless TUI Rendering Benchmark ===");
  console.log("Objective: Test max FPS and observation extraction speed for PufferLib benchmark.");

  // Mock standard input & output streams to prevent writing to real stdout/stderr
  const mockStdin = new Readable({
    read() {}
  }) as any;
  mockStdin.setRawMode = function() { return this; };
  mockStdin.isRaw = true;

  const mockStdout = new Writable({
    write(chunk, encoding, callback) {
      callback(); // do nothing, drop output bytes
    }
  }) as any;
  mockStdout.columns = 80;
  mockStdout.rows = 24;

  // Initialize headless renderer in memory
  const renderer = await createCliRenderer({
    stdin: mockStdin,
    stdout: mockStdout,
    width: 80,
    height: 24,
    bufferedOutput: "memory",
    useThread: false,
    consoleMode: "disabled"
  });

  const ctx = renderer.root.ctx;

  // Build the identical layout structure from game/index.ts
  const rootPanel = new BoxRenderable(ctx, {
    width: "100%",
    height: "100%",
    flexDirection: "column"
  });

  const midRow = new BoxRenderable(ctx, {
    width: "100%",
    flexGrow: 1,
    flexDirection: "row"
  });

  const mapBox = new BoxRenderable(ctx, {
    flexGrow: 1,
    height: "100%",
    border: true,
    borderColor: "#00FFFF",
    title: " Movement Arena "
  });

  const mapFB = new FrameBufferRenderable(ctx, {
    width: MAP_W * 2,
    height: MAP_H,
    paddingLeft: 2,
    paddingTop: 1
  });
  mapBox.add(mapFB);

  const sidebarBox = new BoxRenderable(ctx, {
    width: 25,
    height: "100%",
    border: true,
    borderColor: "#00FFFF",
    title: " Realm Stats "
  });

  const sidebarText = new TextRenderable(ctx, {
    width: "100%",
    height: "100%",
    paddingLeft: 1,
    paddingTop: 1
  });
  sidebarBox.add(sidebarText);

  midRow.add(mapBox);
  midRow.add(sidebarBox);
  rootPanel.add(midRow);
  renderer.root.add(rootPanel);

  // Setup simulated players
  const players: BenchPlayer[] = [];
  for (let i = 0; i < 20; i++) {
    players.push({
      id: `player-${i}`,
      x: Math.floor(Math.random() * MAP_W),
      y: Math.floor(Math.random() * MAP_H)
    });
  }

  // Pre-instantiated RGBA color references to avoid allocation in the loop
  const GREEN_COLOR = RGBA.fromHex("#22c55e");
  const CYAN_COLOR = RGBA.fromHex("#06b6d4");
  const DIM_COLOR = RGBA.fromHex("#475569");
  const DEFAULT_BG = RGBA.defaultBackground();

  // Run benchmark loop
  const ITERATIONS = 2000;
  const start = Date.now();

  let totalObservationsCopied = 0;
  let totalBytesCopied = 0;

  for (let step = 0; step < ITERATIONS; step++) {
    // 1. Update Game Physics (Steer / Move players randomly)
    for (const p of players) {
      const dx = Math.floor(Math.random() * 3) - 1; // -1, 0, 1
      const dy = Math.floor(Math.random() * 3) - 1;
      p.x = Math.max(0, Math.min(MAP_W - 1, p.x + dx));
      p.y = Math.max(0, Math.min(MAP_H - 1, p.y + dy));
    }

    // 2. Render Step: Draw arena map onto FrameBuffer directly
    const grid: string[][] = [];
    for (let y = 0; y < MAP_H; y++) {
      grid.push(new Array(MAP_W).fill("."));
    }
    for (const p of players) {
      grid[p.y]![p.x] = "P";
    }
    grid[players[0]!.y]![players[0]!.x] = "@"; // Local player

    const fb = mapFB.frameBuffer;
    fb.clear();

    for (let y = 0; y < MAP_H; y++) {
      for (let x = 0; x < MAP_W; x++) {
        const char = grid[y]![x]!;
        const xPos = x * 2;
        if (char === "@") {
          fb.setCell(xPos, y, "@", GREEN_COLOR, DEFAULT_BG);
        } else if (char === "P") {
          fb.setCell(xPos, y, "P", CYAN_COLOR, DEFAULT_BG);
        } else {
          fb.setCell(xPos, y, ".", DIM_COLOR, DEFAULT_BG);
        }
      }
    }

    // 3. Render Step: Draw stats
    sidebarText.content = t`
${cyan(bold("@bench-user"))}
Pos: (${players[0]!.x.toString()}, ${players[0]!.y.toString()})

${green("Online Realm:")}
Total sessions: 1
Active players : ${players.length.toString()}
`;

    // Trigger synchronous render pass
    renderer.intermediateRender();

    // 4. Extract Observation: Copy terminal buffer memory directly
    const buffers = renderer.nextRenderBuffer.buffers;
    const charArray = buffers.char;
    const observationCopy = new Uint32Array(charArray.length);
    observationCopy.set(charArray);

    totalObservationsCopied++;
    totalBytesCopied += observationCopy.byteLength;
  }

  const durationMs = Date.now() - start;
  const seconds = durationMs / 1000;
  const fps = ITERATIONS / seconds;
  const avgFrameTime = durationMs / ITERATIONS;
  const throughputMb = (totalBytesCopied / (1024 * 1024)) / seconds;

  console.log("\n=== Benchmark Results ===");
  console.log(`Render Mode:           Headless FrameBuffer (In-Memory)`);
  console.log(`Total Steps Executed:  ${ITERATIONS}`);
  console.log(`Total Time Elapsed:    ${seconds.toFixed(2)}s`);
  console.log(`Average Step Time:     ${avgFrameTime.toFixed(2)}ms`);
  console.log(`Rendering Throughput:  ${fps.toFixed(2)} FPS`);
  console.log(`Observations Copied:   ${totalObservationsCopied} frames`);
  console.log(`Buffer Copy Speed:     ${throughputMb.toFixed(2)} MB/s`);
  console.log("=========================");

  // Cleanup renderer
  renderer.destroy();
  process.exit(0);
}

runBenchmark().catch(err => {
  console.error("Benchmark error:", err);
  process.exit(1);
});
