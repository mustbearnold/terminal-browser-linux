import { unlinkSync } from "node:fs";

const width = positiveInteger(Bun.argv[2], 1617);
const height = positiveInteger(Bun.argv[3], 825);
const frames = positiveInteger(Bun.argv[4], 120);
const warmup = Math.min(20, Math.max(3, Math.floor(frames / 10)));
const gpu = Bun.argv.includes("--gpu");
const sharedMemory = Bun.argv.includes("--shmem");

const view = new Bun.WebView({
  width,
  height,
  backend: {
    type: "chrome",
    path: process.env.BUN_CHROME_PATH || "/usr/bin/chromium",
    url: false,
    argv: gpu ? ["--enable-gpu", "--enable-features=VaapiVideoDecoder"] : [],
  },
});

try {
  await view.navigate(benchmarkPage());
  await view.evaluate("document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))");

  for (let index = 0; index < warmup; index++) {
    await capture(view, sharedMemory);
  }

  const samples: number[] = [];
  let bytes = 0;
  const started = performance.now();
  for (let index = 0; index < frames; index++) {
    const before = performance.now();
    const imageBytes = await capture(view, sharedMemory);
    samples.push(performance.now() - before);
    bytes += imageBytes;
  }
  const elapsed = performance.now() - started;
  samples.sort((left, right) => left - right);

  console.log(JSON.stringify({
    runtime: `bun ${Bun.version}`,
    browser: await view.evaluate("navigator.userAgent"),
    viewport: `${width}x${height}`,
    gpuRequested: gpu,
    transport: sharedMemory ? "shmem" : "buffer",
    frames,
    fps: round(frames * 1000 / elapsed),
    frameMs: {
      median: round(percentile(samples, 0.5)),
      p95: round(percentile(samples, 0.95)),
      worst: round(samples.at(-1) ?? 0),
    },
    averagePngBytes: Math.round(bytes / frames),
    elapsedMs: round(elapsed),
    rssMiB: round(process.memoryUsage.rss() / 1024 / 1024),
  }, null, 2));
} finally {
  await view.close();
}

function benchmarkPage() {
  const html = `<!doctype html>
    <meta charset="utf-8">
    <style>
      * { box-sizing: border-box }
      html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: #f7f8fa; color: #17181a; font: 16px system-ui, sans-serif }
      body { display: grid; grid-template-rows: 72px 1fr }
      header { display: flex; align-items: center; gap: 24px; padding: 0 36px; background: #fff; border-bottom: 1px solid #dfe3e8 }
      strong { font-size: 22px; letter-spacing: -.4px }
      main { display: grid; grid-template-columns: 1.6fr 1fr; gap: 28px; padding: 32px }
      section { padding: 28px; border: 1px solid #dfe3e8; border-radius: 16px; background: #fff; box-shadow: 0 12px 32px #1d26330d }
      h1 { margin: 0 0 12px; font-size: 42px; letter-spacing: -1.5px }
      p { color: #596170; line-height: 1.55 }
      .cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; margin-top: 28px }
      .card { height: 150px; padding: 18px; border-radius: 12px; background: linear-gradient(135deg, #eef3ff, #f8edff) }
      .orb { width: 180px; height: 180px; margin: 60px auto; border-radius: 50%; background: conic-gradient(from var(--turn), #635bff, #16c7a3, #ffb347, #635bff); box-shadow: 0 24px 64px #635bff55; animation: spin 2s linear infinite }
      @property --turn { syntax: '<angle>'; initial-value: 0deg; inherits: false }
      @keyframes spin { to { --turn: 360deg; transform: rotate(360deg) } }
    </style>
    <header><strong>Terminal Browser</strong><span>Rendering benchmark</span></header>
    <main><section><h1>Chrome-quality pixels.</h1><p>This page mixes subpixel text, borders, shadows, gradients and continuous animation so every captured frame does real rendering work.</p><div class="cards"><div class="card">Sharp typography<br>at fractional scale</div><div class="card">CSS gradients<br>and shadows</div><div class="card">Dense layout<br>with fine borders</div></div></section><section><div class="orb"></div></section></main>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

async function capture(view: Bun.WebView, sharedMemory: boolean) {
  if (!sharedMemory) {
    return (await view.screenshot({ format: "png", encoding: "buffer" })).byteLength;
  }
  const image = await view.screenshot({ format: "png", encoding: "shmem" });
  unlinkSync(`/dev/shm/${image.name.replace(/^\//, "")}`);
  return image.size;
}

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function percentile(sorted: number[], point: number) {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * point))] ?? 0;
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}
