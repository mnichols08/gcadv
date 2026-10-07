const { spawn } = require("node:child_process");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const viteBin = path.join(ROOT, "node_modules", "vite", "bin", "vite.js");
const children = [];
let stopping = false;

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) {
    if (child.exitCode === null) child.kill();
  }
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`)));
  });
}

async function start() {
  await run("wasm-pack", ["build", "rust", "--target", "web", "--out-dir", "pkg"]);

  const servers = [
    ["localhost", undefined],
    ["127.0.0.1", path.join(ROOT, "node_modules", ".vite-ipv4")],
  ];
  for (const [host, cacheDir] of servers) {
    const child = spawn(process.execPath, [viteBin, "--host", host, "--port", "3000", "--strictPort"], {
      cwd: ROOT,
      stdio: "inherit",
      env: cacheDir ? { ...process.env, CHINGU_VITE_CACHE_DIR: cacheDir } : process.env,
    });
    children.push(child);
    child.once("error", (error) => {
      console.error(`Could not start Vite on ${host}: ${error.message}`);
      stop(1);
    });
    child.once("exit", (code) => {
      if (!stopping) {
        console.error(`Vite on ${host} stopped${code === 0 ? "" : ` with code ${code}`}.`);
        stop(code || 1);
      }
    });
  }
}

process.on("SIGINT", () => stop(130));
process.on("SIGTERM", () => stop(143));
start().catch((error) => {
  console.error(error.message);
  stop(1);
});
