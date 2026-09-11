const api = window.desktopSetup;
const statusElement = document.getElementById("status");
let busy = false;

async function refresh() {
  const state = await api.status();
  const input = document.getElementById("workspace");
  if (!input.value && state.url) input.value = state.url;
  document.getElementById("runner").textContent = `Runner: ${state.runner}`;
  document.getElementById("toggle").textContent = state.enabled ? "Pause after current task" : "Resume runner";
  document.getElementById("toggle").disabled = busy || !state.paired || state.runner === "stopping";
  document.getElementById("version").textContent = `Version ${state.version}`;
  document.getElementById("retry").disabled = busy || !state.url;
  if (!busy) statusElement.textContent = state.message || "";
}

async function run(action) {
  if (busy) return;
  busy = true;
  document.querySelectorAll("button").forEach(button => { button.disabled = true; });
  statusElement.textContent = "Working…";
  try {
    await action();
  } catch {
    statusElement.textContent = "The action failed. Reopen Desktop settings and try again.";
  } finally {
    busy = false;
    document.querySelectorAll("button").forEach(button => { button.disabled = false; });
    await refresh();
  }
}

document.getElementById("connect-form").addEventListener("submit", event => {
  event.preventDefault();
  void run(() => api.connect(document.getElementById("workspace").value.trim()));
});
document.getElementById("retry").addEventListener("click", () => void run(() => api.retry()));
document.getElementById("toggle").addEventListener("click", () => void run(() => api.toggleRunner()));
document.getElementById("updates").addEventListener("click", () => void run(() => api.checkUpdates()));
void refresh();
setInterval(() => { if (!busy) void refresh().catch(() => {}); }, 2000);
