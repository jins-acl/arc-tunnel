"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
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
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/broker-control.ts
var broker_control_exports = {};
__export(broker_control_exports, {
  runControl: () => runControl
});
module.exports = __toCommonJS(broker_control_exports);

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
var MAX_RESPONSE_BYTES = 64 * 1024;
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
        child = spawnProcess(process.execPath, [brokerEntry, ...brokerArgs({ host: config.host, port: config.port })], {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
          env: { ...process.env, ARC_TUNNEL_TOKEN: config.token }
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
  function requestJson(config, requestPath) {
    return new Promise((resolve) => {
      let settled = false;
      let response;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        response?.destroy();
        request.destroy();
        resolve(result);
      };
      const request = import_http.default.get({ hostname: "127.0.0.1", port: config.port, path: requestPath }, (incoming) => {
        response = incoming;
        const chunks = [];
        let bytes = 0;
        incoming.on("data", (chunk) => {
          bytes += Buffer.byteLength(chunk);
          if (bytes > MAX_RESPONSE_BYTES) return finish({ kind: "too-large" });
          chunks.push(chunk);
        });
        incoming.once("aborted", () => finish({ kind: "failed" }));
        incoming.once("error", () => finish({ kind: "failed" }));
        incoming.on("end", () => {
          if (incoming.statusCode !== 200) return finish({ kind: "failed" });
          try {
            finish({ kind: "ok", value: JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")) });
          } catch {
            finish({ kind: "failed" });
          }
        });
      });
      request.once("error", (error) => {
        finish({ kind: error.code === "ECONNREFUSED" ? "absent" : "failed" });
      });
      const timer = setTimeout(() => finish({ kind: "failed" }), Math.min(250, startupTimeout));
    });
  }
  function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function isNonNegativeInteger(value) {
    return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
  }
  function isPositiveInteger(value) {
    return isNonNegativeInteger(value) && value > 0;
  }
  function isRecoveryPhase(value) {
    return value === "idle" || value === "running" || value === "failed";
  }
  function isDiagnosticsSnapshot(value) {
    if (!isRecord(value) || !isRecord(value.broker) || !isRecord(value.extension) || !isRecord(value.agents) || !isRecord(value.workload) || !isRecord(value.recovery)) return false;
    const recentError = value.recentError;
    const validRecentError = recentError === null || isRecord(recentError) && isNonNegativeInteger(recentError.timestamp) && typeof recentError.code === "string" && typeof recentError.summary === "string";
    return isPositiveInteger(value.broker.pid) && isPositiveInteger(value.broker.port) && isPositiveInteger(value.broker.protocolVersion) && isNonNegativeInteger(value.broker.uptimeMs) && typeof value.extension.connected === "boolean" && isNonNegativeInteger(value.extension.generation) && isRecoveryPhase(value.extension.reconnectPhase) && (value.extension.lastSyncAt === null || isNonNegativeInteger(value.extension.lastSyncAt)) && isNonNegativeInteger(value.agents.connected) && isNonNegativeInteger(value.agents.grace) && isNonNegativeInteger(value.workload.claimedTabs) && isNonNegativeInteger(value.workload.pendingCommands) && isRecoveryPhase(value.recovery.inventorySync) && isRecoveryPhase(value.recovery.recordingCleanup) && validRecentError;
  }
  async function inspectBroker2(config) {
    const healthResult = await requestJson(config, "/health");
    if (healthResult.kind === "absent") return { kind: "absent", port: config.port };
    if (healthResult.kind !== "ok" || !isRecord(healthResult.value)) {
      return { kind: "foreign", port: config.port };
    }
    const health = healthResult.value;
    if (health.name !== "arc-tunnel" || !isPositiveInteger(health.protocolVersion) || !isPositiveInteger(health.pid) || health.port !== config.port) {
      return { kind: "foreign", port: config.port };
    }
    if (health.protocolVersion !== PROTOCOL_VERSION) {
      return {
        kind: "incompatible",
        port: config.port,
        pid: health.pid,
        protocolVersion: health.protocolVersion,
        expectedProtocolVersion: PROTOCOL_VERSION
      };
    }
    const status = await requestJson(config, "/api/status");
    if (status.kind !== "ok" || !isDiagnosticsSnapshot(status.value)) {
      return {
        kind: "diagnostics-unavailable",
        port: config.port,
        pid: health.pid,
        protocolVersion: health.protocolVersion
      };
    }
    return {
      kind: "healthy",
      port: config.port,
      pid: health.pid,
      protocolVersion: health.protocolVersion,
      diagnostics: status.value
    };
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
  return { ensureBroker: ensureBroker2, getBrokerStatus: getBrokerStatus2, stopBroker: stopBroker2, inspectBroker: inspectBroker2 };
}
var defaultLauncher = createBrokerLauncher();
var ensureBroker = defaultLauncher.ensureBroker;
var getBrokerStatus = defaultLauncher.getBrokerStatus;
var stopBroker = defaultLauncher.stopBroker;
var inspectBroker = defaultLauncher.inspectBroker;

// src/config.ts
var import_fs2 = __toESM(require("fs"));
var import_os2 = __toESM(require("os"));
var import_path2 = __toESM(require("path"));

// src/auth-token.ts
var AUTH_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
function isValidAuthToken(value) {
  return typeof value === "string" && AUTH_TOKEN_PATTERN.test(value) && Buffer.from(value, "base64url").toString("base64url") === value;
}

// src/config.ts
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
function loadFileConfig(homeDir) {
  const configPath = import_path2.default.join(homeDir, ".arc-tunnel", "config.json");
  try {
    const raw = import_fs2.default.readFileSync(configPath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    const nodeError = error;
    if (nodeError.code !== "ENOENT") {
      throw new Error(`Invalid Arc Tunnel config: ${configPath}`);
    }
    return null;
  }
}
function loadBrokerEndpointConfig(argv, env, homeDir = import_os2.default.homedir()) {
  return resolveBrokerConfig({ argv, env, fileConfig: loadFileConfig(homeDir) });
}
function loadBrokerConfig(argv, env, homeDir = import_os2.default.homedir()) {
  const fileConfig = loadFileConfig(homeDir);
  const endpoint = resolveBrokerConfig({ argv, env, fileConfig });
  const token = env.ARC_TUNNEL_TOKEN ?? fileConfig?.token;
  if (!isValidAuthToken(token)) {
    throw new Error("Arc Tunnel authentication token is missing or invalid. Run node scripts/install.js to configure it.");
  }
  return { ...endpoint, token };
}

// src/broker-control.ts
var defaultLauncher2 = {
  ensureBroker,
  getBrokerStatus,
  stopBroker,
  inspectBroker
};
var EXIT_CODE = {
  healthy: 0,
  absent: 2,
  foreign: 3,
  incompatible: 4,
  "diagnostics-unavailable": 5
};
function diagnoseJson(inspection) {
  return inspection.kind === "healthy" ? { running: true, ...inspection, dashboardUrl: `http://127.0.0.1:${inspection.port}/dashboard` } : { running: false, ...inspection };
}
function humanDiagnose(inspection) {
  const dashboard = `http://127.0.0.1:${inspection.port}/dashboard`;
  const lines = ["Arc Tunnel \u8FD0\u7EF4\u63A7\u5236\u4E2D\u5FC3", "========================"];
  if (inspection.kind === "healthy") {
    const d = inspection.diagnostics;
    lines.push(`Broker: \u6B63\u5E38\uFF08PID ${inspection.pid}\uFF0C\u7AEF\u53E3 ${inspection.port}\uFF0C\u534F\u8BAE ${inspection.protocolVersion}\uFF0C\u8FD0\u884C ${d.broker.uptimeMs} ms\uFF09`);
    lines.push(`Extension: ${d.extension.connected ? "\u5DF2\u8FDE\u63A5" : "\u672A\u8FDE\u63A5"}`);
    lines.push(`Agent: \u5DF2\u8FDE\u63A5 ${d.agents.connected}\uFF0C\u5BBD\u9650\u671F ${d.agents.grace}`);
    lines.push(`\u5DE5\u4F5C\u8D1F\u8F7D: \u5DF2\u8BA4\u9886\u6807\u7B7E\u9875 ${d.workload.claimedTabs}\uFF0C\u5F85\u5904\u7406\u547D\u4EE4 ${d.workload.pendingCommands}`);
    lines.push(`\u6062\u590D\u9636\u6BB5: \u6E05\u5355\u540C\u6B65 ${d.recovery.inventorySync}\uFF0C\u5F55\u5236\u6E05\u7406 ${d.recovery.recordingCleanup}`);
    lines.push(`\u6700\u8FD1\u9519\u8BEF: ${d.recentError ? `${d.recentError.code} ${d.recentError.summary}` : "\u65E0"}`);
    lines.push(`Dashboard: ${dashboard}`);
    lines.push("\u5EFA\u8BAE: \u82E5\u6D4F\u89C8\u5668\u672A\u8FDE\u63A5\uFF0C\u8BF7\u68C0\u67E5\u6269\u5C55\u5F39\u7A97\u4E2D\u7684 Broker \u7AEF\u53E3\u3002");
  } else {
    let messages;
    if (inspection.kind === "absent") messages = [`Broker: \u672A\u8FD0\u884C\uFF08\u7AEF\u53E3 ${inspection.port}\uFF09`, "\u5EFA\u8BAE: \u8FD0\u884C start \u542F\u52A8 Broker\u3002"];
    else if (inspection.kind === "foreign") messages = [`Broker: \u7AEF\u53E3 ${inspection.port} \u88AB\u5176\u4ED6\u670D\u52A1\u5360\u7528`, "\u5EFA\u8BAE: \u9009\u62E9\u7A7A\u95F2\u7AEF\u53E3\uFF0C\u4E14\u4E0D\u8981\u505C\u6B62\u672A\u77E5\u8FDB\u7A0B\u3002"];
    else if (inspection.kind === "incompatible") messages = [
      `Broker: \u534F\u8BAE\u4E0D\u517C\u5BB9\uFF08\u5F53\u524D ${inspection.protocolVersion}\uFF0C\u9700\u8981 ${inspection.expectedProtocolVersion}\uFF09`,
      "\u5EFA\u8BAE: \u91CD\u65B0\u6784\u5EFA\u5E76\u7EDF\u4E00\u66F4\u65B0 Broker\u3001\u5BA2\u6237\u7AEF\u548C\u6269\u5C55\u3002"
    ];
    else messages = [`Broker: \u6B63\u5E38\uFF0C\u4F46\u8BCA\u65AD\u63A5\u53E3\u4E0D\u53EF\u7528\uFF08PID ${inspection.pid}\uFF09`, "\u5EFA\u8BAE: \u68C0\u67E5\u7248\u672C\u5E76\u91CD\u65B0\u6784\u5EFA Broker bundle\u3002"];
    lines.push(...messages, `Dashboard: ${dashboard}`);
  }
  return `${lines.join("\n")}
`;
}
async function runControl(argv, env, output, launcher = defaultLauncher2) {
  const action = argv[0] ?? "start";
  if (action === "start") {
    const config = loadBrokerConfig(argv.slice(1), env, launcher.homeDir);
    await launcher.ensureBroker(config);
    output.stdout(`${JSON.stringify(await launcher.getBrokerStatus(config))}
`);
  } else if (action === "status") {
    const config = loadBrokerEndpointConfig(argv.slice(1), env, launcher.homeDir);
    output.stdout(`${JSON.stringify(await launcher.getBrokerStatus(config))}
`);
  } else if (action === "stop") {
    const config = loadBrokerEndpointConfig(argv.slice(1), env, launcher.homeDir);
    await launcher.stopBroker(config);
    output.stdout(`${JSON.stringify({ running: false, port: config.port })}
`);
  } else if (action === "diagnose") {
    const config = loadBrokerEndpointConfig(argv.slice(1), env, launcher.homeDir);
    const inspection = await launcher.inspectBroker(config);
    output.stdout(argv.includes("--json") ? `${JSON.stringify(diagnoseJson(inspection))}
` : humanDiagnose(inspection));
    return EXIT_CODE[inspection.kind];
  } else {
    throw new Error(`Unknown broker action: ${action}`);
  }
  return 0;
}
async function main() {
  process.exitCode = await runControl(process.argv.slice(2), process.env, {
    stdout: (value) => process.stdout.write(value),
    stderr: (value) => process.stderr.write(value)
  });
}
if (require.main === module) void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  runControl
});
//# sourceMappingURL=arc-tunnel-control.js.map
