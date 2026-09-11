const { app, utilityProcess } = require("electron");
const path = require("node:path");

app.whenReady().then(() => {
  const child = utilityProcess.fork(process.env.RUNNER_SMOKE_ENTRY, ["start"], {
    cwd: path.dirname(process.env.RUNNER_SMOKE_CONFIG),
    env: { PATH: "", HOME: path.dirname(process.env.RUNNER_SMOKE_CONFIG), RUNNER_CONFIG: process.env.RUNNER_SMOKE_CONFIG, SystemRoot: process.env.SystemRoot || "" },
    stdio: "pipe",
  });
  let online = false;
  child.stdout.on("data", chunk => {
    if (chunk.toString().includes("online as")) {
      online = true;
      child.postMessage({ type: "shutdown" });
    }
  });
  child.stderr.on("data", chunk => process.stderr.write(chunk));
  child.on("exit", code => {
    if (online && code === 0) console.log("Bundled runner drained and stopped");
    app.exit(online && code === 0 ? 0 : 1);
  });
});
