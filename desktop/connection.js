/** Main-process connection lifecycle. Device credentials never enter the renderer. */
function createAutoConnection(options) {
  let revision = 0;
  let inFlight = null;
  let repeat = false;
  let authorized = null;
  const current = (context, version) => version === revision && options.context()?.origin === context.origin && options.context()?.session === context.session && !options.quitting();
  async function account(context) {
    const response = await context.session.fetch(context.origin + "/api/auth/me", {
      credentials: "include", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error("Could not check your sign-in. Connection will retry automatically.");
    const body = await response.json();
    if (body.user === null) return null;
    if (typeof body.user?.id !== "string" || !body.user.id) throw new Error("Invalid account response.");
    return body.user.id;
  }
  async function run() {
    const context = options.context(), version = revision;
    if (!context || options.quitting() || options.pairing() || options.disabled()) return;
    const userId = await account(context);
    if (!current(context, version)) return;
    if (!userId) { authorized = null; options.stop(); options.report("Sign in to connect this computer automatically."); return; }
    let config = options.readConfig();
    if (config && (config.server !== context.origin || (config.userId && config.userId !== userId))) {
      authorized = null;
      if (options.running()) { options.stop(); return; }
      config = options.readSaved(context.origin, userId);
    }
    if (!config) config = options.readSaved(context.origin, userId);
    const checkedTokens = new Set();
    while (config) {
      if (checkedTokens.has(config.token)) throw new Error("Saved computer connection does not match this account. Reconnect it from Your computers.");
      checkedTokens.add(config.token);
      const response = await options.fetch(context.origin + "/api/runner/me", {
        headers: { authorization: `Bearer ${config.token}` }, redirect: "error", signal: AbortSignal.timeout(15000),
      });
      if (!current(context, version)) return;
      if (response.status === 401) {
        authorized = null; options.stop();
        options.report("This computer's connection was revoked. Reconnect it from Your computers when you want to enable it again.");
        return;
      }
      if (!response.ok) throw new Error("Could not verify this computer. Connection will retry automatically.");
      const { device } = await response.json();
      if (!current(context, version)) return;
      if (typeof device?.userId !== "string" || typeof device?.id !== "string") throw new Error("Invalid device identity.");
      if (device?.userId !== userId) {
        authorized = null;
        // Preserve a legacy connection under its actual owner before switching.
        if (options.running()) { options.stop(); return; }
        options.remember({ ...config, userId: device.userId, deviceId: device.id });
        config = options.readSaved(context.origin, userId);
      } else {
        const saved = { ...config, userId, deviceId: device.id };
        if (!options.running()) options.saveConfig(saved);
        authorized = { server: context.origin, token: config.token, userId };
        if (options.enabled()) options.start();
        return;
      }
    }
    if (!options.enabled() || options.running()) return;
    const codeResponse = await context.session.fetch(context.origin + "/api/runner/pairing", {
      method: "POST", credentials: "include", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15000),
    });
    if (!current(context, version)) return;
    if (!codeResponse.ok) throw new Error("Could not connect this computer. Retrying automatically.");
    const { code } = await codeResponse.json();
    if (!/^RN-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) throw new Error("Invalid pairing response.");
    const response = await options.fetch(context.origin + "/api/runner/pair", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, ...options.deviceInfo() }), redirect: "error", signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error("Could not connect this computer. Retrying automatically.");
    const data = await response.json();
    if (!current(context, version)) return;
    if (data.device?.userId !== userId || typeof data.device?.id !== "string" || typeof data.token !== "string" || !data.token || data.token.length > 4096) throw new Error("Device pairing did not match your signed-in account.");
    // Recheck the account after the handshake, including cookie changes missed
    // by a window that was closed while the request was in flight.
    const confirmed = await account(context);
    if (!current(context, version) || confirmed !== userId) return;
    const saved = options.newConfig(context.origin, userId, data.device.id, data.token);
    options.saveConfig(saved);
    authorized = { server: context.origin, token: data.token, userId };
    options.report("This computer is connected. Your AI tools are available while the desktop app is running.");
    if (options.enabled()) options.start();
  }
  function sync() {
    if (inFlight) return inFlight;
    if (!options.enabled() && !options.running()) return Promise.resolve();
    inFlight = run().catch(error => options.report(error.message)).finally(() => {
      inFlight = null;
      if (repeat) { repeat = false; void sync(); }
    });
    return inFlight;
  }
  return {
    sync,
    busy: () => !!inFlight,
    invalidate() { revision++; authorized = null; options.stop(); if (inFlight) repeat = true; else void sync(); },
    canStart(config) { return !!authorized && config?.server === authorized.server && config?.token === authorized.token; },
    // An explicitly requested, native-confirmed legacy pairing remains supported.
    approveManual(config) { authorized = { server: config.server, token: config.token, userId: config.userId }; },
  };
}
module.exports = { createAutoConnection };
