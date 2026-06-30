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
  async function probe(config) {
    return new Promise((resolve) => {
      const request = import_http.default.get({ hostname: "127.0.0.1", port: config.port, path: "/health", timeout: 250 }, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          if (response.statusCode !== 200) return resolve({ kind: "foreign" });
          try {
            const health = JSON.parse(body);
            if (health.name === "arc-tunnel" && health.protocolVersion === PROTOCOL_VERSION && typeof health.pid === "number" && health.port === config.port) {
              resolve({ kind: "arc", health });
            } else resolve({ kind: "foreign" });
          } catch {
            resolve({ kind: "foreign" });
          }
        });
      });
      request.once("timeout", () => request.destroy());
      request.once("error", (error) => {
        const absent = ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH"];
        resolve({ kind: absent.includes(error.code || "") ? "absent" : "foreign" });
      });
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
  function readLock() {
    try {
      const lock = JSON.parse(import_fs.default.readFileSync(lockPath, "utf8"));
      return typeof lock.pid === "number" && typeof lock.port === "number" && typeof lock.protocolVersion === "number" ? lock : null;
    } catch {
      return null;
    }
  }
  function removeLock() {
    try {
      import_fs.default.unlinkSync(lockPath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  async function waitForBroker(config, deadline) {
    while (Date.now() <= deadline) {
      const result = await probe(config);
      if (result.kind === "arc") return;
      if (result.kind === "foreign") throw new ArcTunnelError("PORT_IN_USE" /* PORT_IN_USE */, `Port ${config.port} is not Arc Tunnel`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new ArcTunnelError("CONNECTION_LOST" /* CONNECTION_LOST */, `Broker did not become healthy within ${startupTimeout}ms`);
  }
  async function launch(config) {
    const deadline = Date.now() + startupTimeout;
    while (true) {
      const current = await probe(config);
      if (current.kind === "arc") return;
      if (current.kind === "foreign") throw new ArcTunnelError("PORT_IN_USE" /* PORT_IN_USE */, `Port ${config.port} is already in use`);
      import_fs.default.mkdirSync(arcDir, { recursive: true });
      let fd;
      try {
        fd = import_fs.default.openSync(lockPath, "wx");
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const lock = readLock();
        const lockProbe = lock ? await probe({ host: "127.0.0.1", port: lock.port }) : { kind: "absent" };
        if (lockProbe.kind === "arc") {
          if (lock?.port === config.port) return;
          throw new ArcTunnelError("PORT_IN_USE" /* PORT_IN_USE */, `Arc Tunnel Broker is already running on port ${lock?.port}`);
        }
        if (!lock || !pidAlive(lock.pid)) {
          removeLock();
          continue;
        }
        await waitForBroker(config, deadline);
        return;
      }
      let child;
      try {
        import_fs.default.writeFileSync(fd, JSON.stringify({ pid: process.pid, port: config.port, protocolVersion: PROTOCOL_VERSION }));
        import_fs.default.closeSync(fd);
        child = spawnProcess(process.execPath, [brokerEntry, ...brokerArgs(config)], {
          detached: true,
          stdio: "ignore",
          windowsHide: true
        });
        child.unref();
        if (typeof child.pid !== "number") throw new Error("Broker process did not provide a pid");
        import_fs.default.writeFileSync(lockPath, JSON.stringify({ pid: child.pid, port: config.port, protocolVersion: PROTOCOL_VERSION }));
        await waitForBroker(config, deadline);
        return;
      } catch (error) {
        if (child?.pid) try {
          process.kill(child.pid);
        } catch {
        }
        removeLock();
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
    const result = await probe(config);
    if (result.kind === "foreign") throw new ArcTunnelError("PORT_IN_USE" /* PORT_IN_USE */, `Port ${config.port} is not Arc Tunnel`);
    if (result.kind === "arc") {
      try {
        process.kill(result.health.pid, "SIGTERM");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
      const deadline = Date.now() + startupTimeout;
      while (Date.now() <= deadline && (await probe(config)).kind === "arc") {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    const lock = readLock();
    if (!lock || lock.port === config.port) removeLock();
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
