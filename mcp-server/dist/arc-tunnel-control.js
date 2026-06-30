"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/broker-launcher.ts
var import_child_process = require("child_process");
var import_fs = __toESM(require("fs"));
var import_http = __toESM(require("http"));
var import_os = __toESM(require("os"));
var import_path = __toESM(require("path"));

// src/protocol.ts
var PROTOCOL_VERSION = 2;
var ArcTunnelError = class extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
    this.name = "ArcTunnelError";
  }
};

// src/broker-launcher.ts
function createBrokerLauncher(options = {}) {
  const homeDir = options.homeDir ?? import_os.default.homedir();
  const arcDir = import_path.default.join(homeDir, ".arc-tunnel");
  const lockPath = import_path.default.join(arcDir, "broker.lock");
  const brokerEntry = options.brokerEntry ?? import_path.default.resolve(__dirname, "../dist/arc-tunnel-broker.js");
  const brokerArgs = options.brokerArgs ?? ((config) => ["--port", String(config.port)]);
  const startupTimeout = options.startupTimeout ?? 5e3;
  const spawnProcess = options.spawnProcess ?? import_child_process.spawn;
  const starting = /* @__PURE__ */ new Map();
  async function probe(config, deadline = Date.now() + Math.min(250, startupTimeout)) {
    return new Promise((resolve) => {
      let settled = false;
      let connected = false;
      let response;
      let timer;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        response?.destroy();
        request.destroy();
        resolve(result);
      };
      const request = import_http.default.get({ hostname: "127.0.0.1", port: config.port, path: "/health" }, (incoming) => {
        response = incoming;
        connected = true;
        let body = "";
        incoming.setEncoding("utf8");
        incoming.on("data", (chunk) => {
          body += chunk;
        });
        incoming.once("aborted", () => finish({ kind: "foreign", transient: true }));
        incoming.once("error", () => finish({ kind: "foreign", transient: true }));
        incoming.on("end", () => {
          if (incoming.statusCode !== 200) return finish({ kind: "foreign" });
          try {
            const health = JSON.parse(body);
            if (health.name === "arc-tunnel" && health.protocolVersion === PROTOCOL_VERSION && typeof health.pid === "number" && health.port === config.port) {
              finish({ kind: "arc", health });
            } else finish({ kind: "foreign" });
          } catch {
            finish({ kind: "foreign" });
          }
        });
      });
      request.once("socket", (socket) => socket.once("connect", () => {
        connected = true;
      }));
      request.once("error", (error) => {
        if (error.code === "ECONNRESET") {
          finish({ kind: "foreign", transient: true });
          return;
        }
        const absent = ["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH"];
        finish({ kind: !connected && absent.includes(error.code || "") ? "absent" : "foreign" });
      });
      const remaining = Math.max(0, deadline - Date.now());
      timer = setTimeout(() => finish({ kind: "foreign" }), remaining);
    });
  }
  function pidAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
  function readLockSnapshot() {
    try {
      const raw = import_fs.default.readFileSync(lockPath, "utf8");
      let value = null;
      try {
        value = JSON.parse(raw);
      } catch {
      }
      const lock = value && typeof value.pid === "number" && typeof value.port === "number" && typeof value.protocolVersion === "number" ? value : null;
      return { raw, lock };
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }
  function removeLock(expectedRaw) {
    if (expectedRaw !== void 0 && readLockSnapshot()?.raw !== expectedRaw) return false;
    try {
      import_fs.default.unlinkSync(lockPath);
      return true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return false;
    }
  }
  async function waitForBroker(config, deadline) {
    while (Date.now() < deadline) {
      const result = await probe(config, deadline);
      if (result.kind === "arc") return;
      if (result.kind === "foreign") throw new ArcTunnelError("PORT_IN_USE" /* PORT_IN_USE */, `Port ${config.port} is not Arc Tunnel`);
      const delay = Math.min(50, Math.max(0, deadline - Date.now()));
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    }
    throw new ArcTunnelError("CONNECTION_LOST" /* CONNECTION_LOST */, `Broker did not become healthy within ${startupTimeout}ms`);
  }
  async function waitForLockOwner(config, deadline) {
    while (Date.now() < deadline) {
      const current = await probe(config, deadline);
      if (current.kind === "arc") return;
      if (current.kind === "foreign") {
        throw new ArcTunnelError("PORT_IN_USE" /* PORT_IN_USE */, `Port ${config.port} is not Arc Tunnel`);
      }
      const snapshot = readLockSnapshot();
      const lock = snapshot?.lock;
      if (lock && snapshot) {
        const lockProbe = lock.port === config.port ? current : await probe({ host: "127.0.0.1", port: lock.port }, deadline);
        if (lockProbe.kind === "arc") {
          if (lock.port === config.port) return;
          throw new ArcTunnelError("PORT_IN_USE" /* PORT_IN_USE */, `Arc Tunnel Broker is already running on port ${lock.port}`);
        }
        if (!pidAlive(lock.pid)) {
          if (!removeLock(snapshot.raw)) continue;
          return launch(config, deadline);
        }
      }
      const delay = Math.min(25, Math.max(0, deadline - Date.now()));
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    }
    throw new ArcTunnelError("CONNECTION_LOST" /* CONNECTION_LOST */, `Broker lock did not become healthy within ${startupTimeout}ms`);
  }
  async function launch(config, deadline = Date.now() + startupTimeout) {
    while (true) {
      const current = await probe(config, deadline);
      if (current.kind === "arc") return;
      if (current.kind === "foreign") throw new ArcTunnelError("PORT_IN_USE" /* PORT_IN_USE */, `Port ${config.port} is already in use`);
      import_fs.default.mkdirSync(arcDir, { recursive: true });
      let fd;
      try {
        fd = import_fs.default.openSync(lockPath, "wx");
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        await waitForLockOwner(config, deadline);
        return;
      }
      let child;
      let ownedLockRaw;
      try {
        ownedLockRaw = JSON.stringify({ pid: process.pid, port: config.port, protocolVersion: PROTOCOL_VERSION });
        import_fs.default.writeFileSync(fd, ownedLockRaw);
        import_fs.default.closeSync(fd);
        child = spawnProcess(process.execPath, [brokerEntry, ...brokerArgs(config)], {
          detached: true,
          stdio: "ignore",
          windowsHide: true
        });
        child.unref();
        if (typeof child.pid !== "number") throw new Error("Broker process did not provide a pid");
        ownedLockRaw = JSON.stringify({ pid: child.pid, port: config.port, protocolVersion: PROTOCOL_VERSION });
        import_fs.default.writeFileSync(lockPath, ownedLockRaw);
        await waitForBroker(config, deadline);
        return;
      } catch (error) {
        if (child?.pid) try {
          process.kill(child.pid);
        } catch {
        }
        if (ownedLockRaw !== void 0) removeLock(ownedLockRaw);
        throw error;
      }
    }
  }
  async function ensureBroker2(config) {
    const existing = starting.get(config.port);
    if (existing) return existing;
    const promise = launch(config).finally(() => starting.delete(config.port));
    starting.set(config.port, promise);
    return promise;
  }
  async function getBrokerStatus2(config) {
    const result = await probe(config);
    if (result.kind !== "arc") return { running: false, port: config.port };
    return { running: true, port: config.port, protocolVersion: result.health.protocolVersion, pid: result.health.pid };
  }
  async function stopBroker2(config) {
    const deadline = Date.now() + startupTimeout;
    let result = await probe(config, deadline);
    while (result.kind === "foreign" && result.transient && Date.now() < deadline) {
      const delay = Math.min(25, Math.max(0, deadline - Date.now()));
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      result = await probe(config, deadline);
    }
    if (result.kind === "foreign" && result.transient) {
      throw new ArcTunnelError("CONNECTION_LOST" /* CONNECTION_LOST */, `Broker state on port ${config.port} did not settle within ${startupTimeout}ms`);
    }
    if (result.kind === "foreign") throw new ArcTunnelError("PORT_IN_USE" /* PORT_IN_USE */, `Port ${config.port} is not Arc Tunnel`);
    if (result.kind === "arc") {
      try {
        process.kill(result.health.pid, "SIGTERM");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
      let stillRunning = true;
      while (Date.now() < deadline) {
        const stopped = await probe(config, deadline);
        if (stopped.kind === "absent") {
          stillRunning = false;
          break;
        }
        if (stopped.kind === "foreign" && !stopped.transient) {
          throw new ArcTunnelError("PORT_IN_USE" /* PORT_IN_USE */, `Port ${config.port} is not Arc Tunnel`);
        }
        const delay = Math.min(50, Math.max(0, deadline - Date.now()));
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      }
      if (stillRunning) {
        throw new ArcTunnelError("CONNECTION_LOST" /* CONNECTION_LOST */, `Broker on port ${config.port} did not stop within ${startupTimeout}ms`);
      }
      await removeStoppedLock(config, deadline, true);
      return;
    }
    await removeStoppedLock(config, deadline, false);
  }
  async function removeStoppedLock(config, deadline, waitForProcess) {
    const snapshot = readLockSnapshot();
    if (!snapshot) return;
    if (!snapshot.lock) {
      throw new ArcTunnelError("CONNECTION_LOST" /* CONNECTION_LOST */, "Broker startup lock is still in progress");
    }
    if (snapshot.lock.port !== config.port) return;
    if (waitForProcess) {
      while (pidAlive(snapshot.lock.pid) && Date.now() < deadline) {
        const delay = Math.min(25, Math.max(0, deadline - Date.now()));
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    if (pidAlive(snapshot.lock.pid)) {
      throw new ArcTunnelError("CONNECTION_LOST" /* CONNECTION_LOST */, `Broker process ${snapshot.lock.pid} is still starting or stopping`);
    }
    if (Date.now() >= deadline) {
      throw new ArcTunnelError("CONNECTION_LOST" /* CONNECTION_LOST */, "Broker cleanup deadline expired before ownership could be verified");
    }
    const health = await probe(config, deadline);
    if (health.kind !== "absent") {
      throw new ArcTunnelError("CONNECTION_LOST" /* CONNECTION_LOST */, `Broker health on port ${config.port} is not absent`);
    }
    if (!removeLock(snapshot.raw)) {
      throw new ArcTunnelError("CONNECTION_LOST" /* CONNECTION_LOST */, "Broker lock ownership changed during cleanup");
    }
  }
  return { ensureBroker: ensureBroker2, getBrokerStatus: getBrokerStatus2, stopBroker: stopBroker2 };
}
var defaultLauncher = createBrokerLauncher();
var ensureBroker = defaultLauncher.ensureBroker;
var getBrokerStatus = defaultLauncher.getBrokerStatus;
var stopBroker = defaultLauncher.stopBroker;

// src/config.ts
var import_fs2 = __toESM(require("fs"));
var import_os2 = __toESM(require("os"));
var import_path2 = __toESM(require("path"));
function parsePort(value) {
  const text = String(value);
  if (!/^\d+$/.test(text)) {
    throw new Error(`Invalid Arc Tunnel port: ${text}`);
  }
  const port = Number(text);
  if (port < 1 || port > 65535) {
    throw new Error(`Invalid Arc Tunnel port: ${text}`);
  }
  return port;
}
function resolveBrokerConfig(options) {
  const index = options.argv.indexOf("--port");
  const raw = index >= 0 ? options.argv[index + 1] : options.env.WS_PORT ?? options.fileConfig?.port ?? 8765;
  return {
    host: "127.0.0.1",
    port: parsePort(raw)
  };
}
function loadBrokerConfig(argv, env, homeDir = import_os2.default.homedir()) {
  const configPath = import_path2.default.join(homeDir, ".arc-tunnel", "config.json");
  let fileConfig = null;
  try {
    const raw = import_fs2.default.readFileSync(configPath, "utf8");
    fileConfig = JSON.parse(raw);
  } catch (error) {
    const nodeError = error;
    if (nodeError.code !== "ENOENT") {
      throw new Error(`Invalid Arc Tunnel config: ${configPath}`);
    }
  }
  return resolveBrokerConfig({ argv, env, fileConfig });
}

// src/broker-control.ts
async function main() {
  const action = process.argv[2] ?? "start";
  const config = loadBrokerConfig(process.argv.slice(3), process.env);
  if (action === "start") {
    await ensureBroker(config);
    console.log(JSON.stringify(await getBrokerStatus(config)));
  } else if (action === "status") {
    console.log(JSON.stringify(await getBrokerStatus(config)));
  } else if (action === "stop") {
    await stopBroker(config);
    console.log(JSON.stringify({ running: false, port: config.port }));
  } else {
    throw new Error(`Unknown broker action: ${action}`);
  }
}
void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
//# sourceMappingURL=arc-tunnel-control.js.map
