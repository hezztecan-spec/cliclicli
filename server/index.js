const crypto = require("crypto");
const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const FIXED_TOKEN = "a9K2xP8mZ7QwL1vB";
const DASHBOARD_PASSWORD = "77057090A";
const DASHBOARD_COOKIE_NAME = "dashboard_auth";
const DASHBOARD_SESSION_VALUE = crypto.randomBytes(32).toString("hex");
const ONLINE_THRESHOLD_MS = 30 * 1000;
const DATA_DIR = path.join(__dirname, "data");
const LOGS_DIR = path.join(__dirname, "logs");
const STORAGE_PATH = path.join(DATA_DIR, "storage.json");
const LOG_PATH = path.join(LOGS_DIR, "server.log");
const PUBLIC_DIR = path.join(__dirname, "public");

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

ensureDirectories();

app.use(express.json({ limit: "1mb" }));
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && "body" in err) {
    logAction("json_parse_error", {
      message: err.message,
      ip: req.ip
    });
    return res.status(400).json({ error: "Invalid JSON in request body" });
  }
  next(err);
});
app.use(express.static(PUBLIC_DIR, { index: false }));

function readStorage() {
  ensureDirectories();
  return JSON.parse(fs.readFileSync(STORAGE_PATH, "utf8"));
}

function writeStorage(data) {
  fs.writeFileSync(STORAGE_PATH, JSON.stringify(data, null, 2), "utf8");
}

function getToken(req) {
  if (req.method === "GET") {
    return req.query.token;
  }
  return req.body?.token;
}

function parseCookies(req) {
  const cookies = {};
  const cookieHeader = req.headers.cookie || "";

  for (const item of cookieHeader.split(";")) {
    const [name, ...rest] = item.trim().split("=");
    if (!name) {
      continue;
    }

    cookies[name] = decodeURIComponent(rest.join("="));
  }

  return cookies;
}

function isSecureRequest(req) {
  return req.secure || req.get("x-forwarded-proto") === "https";
}

function hasDashboardAccess(req) {
  return parseCookies(req)[DASHBOARD_COOKIE_NAME] === DASHBOARD_SESSION_VALUE;
}

function setDashboardCookie(res, req) {
  const parts = [
    `${DASHBOARD_COOKIE_NAME}=${encodeURIComponent(DASHBOARD_SESSION_VALUE)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax"
  ];

  if (isSecureRequest(req)) {
    parts.push("Secure");
  }

  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearDashboardCookie(res, req) {
  const parts = [
    `${DASHBOARD_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0"
  ];

  if (isSecureRequest(req)) {
    parts.push("Secure");
  }

  res.setHeader("Set-Cookie", parts.join("; "));
}

function normalizeClientId(value) {
  return typeof value === "string" ? value.trim() : "";
}

function clientAuthMiddleware(req, res, next) {
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

function dashboardAuthMiddleware(req, res, next) {
  if (!hasDashboardAccess(req)) {
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

function normalizeSystemInfo(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const normalized = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      normalized[key] = entry.trim().slice(0, 300);
    }
  }

  return normalized;
}

function isSupportedCommand(command) {
  return (
    command === "restart" ||
    command.startsWith("shell:") ||
    command.startsWith("download:") ||
    command.startsWith("update:")
  );
}

function isClientOnline(client) {
  if (!client?.last_seen_at) {
    return false;
  }

  const lastSeenTimestamp = new Date(client.last_seen_at).getTime();
  return Date.now() - lastSeenTimestamp <= ONLINE_THRESHOLD_MS;
}

function getClientDisplayName(client) {
  return client.name || client.client_id;
}

function ensureClientDefaults(client) {
  return {
    ...client,
    name: client.name || "",
    archived: Boolean(client.archived),
    system_info: normalizeSystemInfo(client.system_info) || {}
  };
}

function queueCommandForClient(storage, clientId, command) {
  storage.commands[clientId] = storage.commands[clientId] || [];
  storage.commands[clientId].push({
    command,
    created_at: new Date().toISOString()
  });
}

function buildDashboardData(storage) {
  const clients = Object.values(storage.clients)
    .map((client) => {
      const normalizedClient = ensureClientDefaults(client);
      const queue = storage.commands[client.client_id] || [];
      const latestReport = [...storage.reports]
        .reverse()
        .find((report) => report.client_id === normalizedClient.client_id) || null;

      return {
        ...normalizedClient,
        display_name: getClientDisplayName(normalizedClient),
        is_online: isClientOnline(normalizedClient),
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

  const reports = [...storage.reports]
    .reverse()
    .slice(0, 50)
    .map((report) => {
      const client = ensureClientDefaults(storage.clients[report.client_id] || {
        client_id: report.client_id
      });

      return {
        ...report,
        display_name: getClientDisplayName(client),
        archived: Boolean(client.archived)
      };
    });

  const activeClients = clients.filter((client) => !client.archived);
  const archivedClients = clients.filter((client) => client.archived);
  const onlineClients = clients.filter((client) => client.is_online);

  return {
    clients,
    reports,
    total_clients: clients.length,
    active_clients: activeClients.length,
    archived_clients: archivedClients.length,
    online_clients: onlineClients.length
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
      "POST /rename-client",
      "POST /archive-client",
      "POST /restart-client",
      "POST /delete-client",
      "POST /auth/login",
      "POST /auth/logout",
      "GET /api/dashboard"
    ]
  });
});

app.get("/", (req, res) => {
  if (hasDashboardAccess(req)) {
    return res.redirect("/dashboard");
  }

  return res.redirect("/login");
});

app.get("/login", (req, res) => {
  if (hasDashboardAccess(req)) {
    return res.redirect("/dashboard");
  }

  return res.sendFile(path.join(PUBLIC_DIR, "login.html"));
});

app.get("/dashboard", (req, res) => {
  if (!hasDashboardAccess(req)) {
    return res.redirect("/login");
  }

  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.post("/auth/login", requireTextField("password"), (req, res) => {
  if (req.password !== DASHBOARD_PASSWORD) {
    logAction("dashboard_login_failed", { ip: req.ip });
    return res.status(401).json({ error: "Invalid password" });
  }

  setDashboardCookie(res, req);
  logAction("dashboard_login_success", { ip: req.ip });
  return res.json({ success: true });
});

app.post("/auth/logout", (req, res) => {
  clearDashboardCookie(res, req);
  logAction("dashboard_logout", { ip: req.ip });
  return res.json({ success: true });
});

app.post("/register", clientAuthMiddleware, requireClientId, (req, res) => {
  const storage = readStorage();
  const now = new Date().toISOString();
  const existing = storage.clients[req.clientId] || {};

  storage.clients[req.clientId] = {
    client_id: req.clientId,
    name: existing.name || "",
    archived: Boolean(existing.archived),
    registered_at: existing.registered_at || now,
    last_seen_at: now,
    system_info: normalizeSystemInfo(req.body?.system_info) || existing.system_info || {}
  };
  storage.commands[req.clientId] = storage.commands[req.clientId] || [];
  writeStorage(storage);

  logAction("client_registered", { client_id: req.clientId });
  res.json({ success: true, client_id: req.clientId });
});

app.get("/get-command", clientAuthMiddleware, requireClientId, (req, res) => {
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

app.post("/report", clientAuthMiddleware, requireClientId, requireTextField("result"), (req, res) => {
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
  dashboardAuthMiddleware,
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

app.post("/rename-client", dashboardAuthMiddleware, requireClientId, requireTextField("name"), (req, res) => {
  const storage = readStorage();
  const client = storage.clients[req.clientId];

  if (!client) {
    return res.status(404).json({ error: "Client is not registered" });
  }

  client.name = req.name;
  writeStorage(storage);

  logAction("client_renamed", {
    client_id: req.clientId,
    name: req.name
  });

  return res.json({ success: true, name: req.name });
});

app.post("/archive-client", dashboardAuthMiddleware, requireClientId, (req, res) => {
  const storage = readStorage();
  const client = storage.clients[req.clientId];

  if (!client) {
    return res.status(404).json({ error: "Client is not registered" });
  }

  if (typeof req.body?.archived !== "boolean") {
    return res.status(400).json({ error: "archived must be a boolean" });
  }

  client.archived = req.body.archived;
  writeStorage(storage);

  logAction("client_archive_changed", {
    client_id: req.clientId,
    archived: client.archived
  });

  return res.json({ success: true, archived: client.archived });
});

app.post("/restart-client", dashboardAuthMiddleware, requireClientId, (req, res) => {
  const storage = readStorage();
  const client = storage.clients[req.clientId];

  if (!client) {
    return res.status(404).json({ error: "Client is not registered" });
  }

  queueCommandForClient(storage, req.clientId, "restart");
  writeStorage(storage);

  logAction("client_restart_queued", {
    client_id: req.clientId
  });

  return res.json({ success: true, queued: true });
});

app.post("/delete-client", dashboardAuthMiddleware, requireClientId, (req, res) => {
  const storage = readStorage();
  const client = storage.clients[req.clientId];

  if (!client) {
    return res.status(404).json({ error: "Client is not registered" });
  }

  delete storage.clients[req.clientId];
  delete storage.commands[req.clientId];
  storage.reports = storage.reports.filter((report) => report.client_id !== req.clientId);
  writeStorage(storage);

  logAction("client_deleted", {
    client_id: req.clientId
  });

  return res.json({ success: true, deleted: true });
});

app.get("/api/dashboard", dashboardAuthMiddleware, (_req, res) => {
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
