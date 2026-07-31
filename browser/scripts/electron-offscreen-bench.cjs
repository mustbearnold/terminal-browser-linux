const { app, BrowserWindow } = require("electron");

const arguments = process.argv.slice(2).filter((value) => value !== "--");
const width = positiveInteger(arguments[0], 1617);
const height = positiveInteger(arguments[1], 825);
const frames = positiveInteger(arguments[2], 120);
const samples = [];
let bytes = 0;
let lastPaint = 0;
let started = 0;

app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.on("window-all-closed", () => {});

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width,
    height,
    useContentSize: true,
    show: false,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      offscreen: { useSharedTexture: false, deviceScaleFactor: 1 },
      backgroundThrottling: false,
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  window.webContents.setFrameRate(100);
  window.webContents.on("paint", (_event, _dirtyRect, image) => {
    const now = performance.now();
    if (lastPaint) samples.push(now - lastPaint);
    lastPaint = now;
    if (!started) started = now;
    bytes += image.toBitmap().byteLength;
    if (samples.length < frames) return;

    const elapsed = now - started;
    samples.sort((left, right) => left - right);
    console.log(JSON.stringify({
      runtime: `electron ${process.versions.electron}`,
      browser: `Chrome ${process.versions.chrome}`,
      viewport: `${width}x${height}`,
      transport: "bitmap",
      frames,
      fps: round(frames * 1000 / elapsed),
      frameMs: {
        median: round(percentile(samples, 0.5)),
        p95: round(percentile(samples, 0.95)),
        worst: round(samples.at(-1) || 0),
      },
      averageBgraBytes: Math.round(bytes / (frames + 1)),
      elapsedMs: round(elapsed),
      rssMiB: round(process.memoryUsage().rss / 1024 / 1024),
    }, null, 2));
    window.destroy();
    app.quit();
  });
  await window.loadURL(benchmarkPage());
});

function benchmarkPage() {
  const html = `<!doctype html><style>
    html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#f7f8fa;font:16px system-ui,sans-serif}
    body{display:grid;grid-template-columns:1.6fr 1fr;gap:28px;padding:32px;box-sizing:border-box}
    section{padding:28px;border:1px solid #dfe3e8;border-radius:16px;background:#fff;box-shadow:0 12px 32px #1d26330d}
    h1{font-size:42px;letter-spacing:-1.5px}.orb{width:180px;height:180px;margin:60px auto;border-radius:50%;background:conic-gradient(#635bff,#16c7a3,#ffb347,#635bff);box-shadow:0 24px 64px #635bff55;animation:spin 2s linear infinite}
    @keyframes spin{to{transform:rotate(360deg)}}
  </style><section><h1>Chrome-quality pixels.</h1><p>Subpixel text, borders, shadows, gradients and continuous animation.</p></section><section><div class="orb"></div></section>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function percentile(sorted, point) {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * point))] || 0;
}

function round(value) {
  return Math.round(value * 100) / 100;
}
