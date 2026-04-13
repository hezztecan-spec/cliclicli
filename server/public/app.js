const REFRESH_INTERVAL_MS = 5000;
const TERMINAL_STORAGE_KEY = "dashboard_terminal_state_v2";
const TERMINAL_TYPES = {
  cmd: { label: "CMD" },
  powershell: { label: "PowerShell" },
  bash: { label: "Bash" },
  sh: { label: "Sh" }
};

const refreshButton = document.getElementById("refresh-button");
const statusNode = document.getElementById("status");
const clientsCountNode = document.getElementById("clients-count");
const archivedBadgeNode = document.getElementById("archived-badge");
const totalCountNode = document.getElementById("total-count");
const onlineCountNode = document.getElementById("online-count");
const activeCountNode = document.getElementById("active-count");
const archivedCountNode = document.getElementById("archived-count");
const clientsListNode = document.getElementById("clients-list");
const archivedListNode = document.getElementById("archived-list");
const reportsListNode = document.getElementById("reports-list");
const clientDetailsNode = document.getElementById("client-details");

const dashboardState = {
  clients: [],
  reports: []
};

const uiState = loadUiState();

function setStatus(message, isError = false) {
  statusNode.textContent = message;
  statusNode.dataset.error = isError ? "true" : "false";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatDate(value) {
  if (!value) {
    return "—";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString();
}

function safeStorageRead(key) {
  try {
    return localStorage.getItem(key);
  } catch (_error) {
    return null;
  }
}

function safeStorageWrite(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (_error) {
    // ignore quota/storage issues
  }
}

function loadUiState() {
  const fallback = {
    selectedClientId: "",
    selectedTab: "specs",
    terminalsByClient: {},
    activeSessionByClient: {}
  };

  const raw = safeStorageRead(TERMINAL_STORAGE_KEY);
  if (!raw) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(raw);
    return {
      selectedClientId: typeof parsed.selectedClientId === "string" ? parsed.selectedClientId : "",
      selectedTab: parsed.selectedTab === "terminal" ? "terminal" : "specs",
      terminalsByClient:
        parsed.terminalsByClient && typeof parsed.terminalsByClient === "object"
          ? parsed.terminalsByClient
          : {},
      activeSessionByClient:
        parsed.activeSessionByClient && typeof parsed.activeSessionByClient === "object"
          ? parsed.activeSessionByClient
          : {}
    };
  } catch (_error) {
    return fallback;
  }
}

function persistUiState() {
  safeStorageWrite(TERMINAL_STORAGE_KEY, JSON.stringify(uiState));
}

function generateId(prefix) {
  if (window.crypto?.randomUUID) {
    return `${prefix}-${window.crypto.randomUUID()}`;
  }

  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getTerminalLabel(type) {
  return TERMINAL_TYPES[type]?.label || type;
}

function createSessionTitle(clientId, type) {
  const sessions = Array.isArray(uiState.terminalsByClient[clientId]) ? uiState.terminalsByClient[clientId] : [];
  const existingCount = sessions.filter((session) => session.terminalType === type).length + 1;
  return `${getTerminalLabel(type)} ${existingCount}`;
}

function normalizeSession(session, clientId) {
  return {
    id: typeof session?.id === "string" ? session.id : generateId("session"),
    title:
      typeof session?.title === "string" && session.title.trim()
        ? session.title.trim().slice(0, 120)
        : createSessionTitle(clientId, session?.terminalType || "cmd"),
    terminalType: TERMINAL_TYPES[session?.terminalType] ? session.terminalType : "cmd",
    createdAt: typeof session?.createdAt === "string" ? session.createdAt : new Date().toISOString(),
    history: Array.isArray(session?.history)
      ? session.history.map((entry) => ({
          id: typeof entry?.id === "string" ? entry.id : generateId("entry"),
          kind: entry?.kind === "result" ? "result" : "command",
          text: typeof entry?.text === "string" ? entry.text : "",
          createdAt: typeof entry?.createdAt === "string" ? entry.createdAt : new Date().toISOString(),
          commandId: typeof entry?.commandId === "string" ? entry.commandId : "",
          status:
            entry?.status === "done" || entry?.status === "error" || entry?.status === "pending"
              ? entry.status
              : "done"
        }))
      : [],
    appliedReportIds: Array.isArray(session?.appliedReportIds)
      ? session.appliedReportIds.filter((item) => typeof item === "string")
      : []
  };
}

function getClientSessions(clientId) {
  const sessions = Array.isArray(uiState.terminalsByClient[clientId]) ? uiState.terminalsByClient[clientId] : [];
  const normalized = sessions.map((session) => normalizeSession(session, clientId));
  uiState.terminalsByClient[clientId] = normalized;
  return normalized;
}

function syncActiveSession(clientId) {
  const sessions = getClientSessions(clientId);
  if (sessions.length) {
    const activeId = uiState.activeSessionByClient[clientId];
    const activeExists = sessions.some((session) => session.id === activeId);
    if (!activeExists) {
      uiState.activeSessionByClient[clientId] = sessions[0].id;
      persistUiState();
    }
    return sessions;
  }

  delete uiState.activeSessionByClient[clientId];
  persistUiState();
  return sessions;
}

function getActiveSession(clientId) {
  const sessions = getClientSessions(clientId);
  const activeId = uiState.activeSessionByClient[clientId];
  return sessions.find((session) => session.id === activeId) || sessions[0] || null;
}

function selectClient(clientId) {
  uiState.selectedClientId = clientId;
  persistUiState();
  renderDetails();
  renderClientLists();
}

function selectTab(tab) {
  uiState.selectedTab = tab === "terminal" ? "terminal" : "specs";
  persistUiState();
  renderDetails();
}

function getSelectedClient() {
  return dashboardState.clients.find((client) => client.client_id === uiState.selectedClientId) || null;
}

function syncSelectedClient() {
  const selectedClient = getSelectedClient();
  if (selectedClient) {
    return;
  }

  const activeClients = dashboardState.clients.filter((client) => !client.archived);
  const fallbackClient = activeClients[0] || dashboardState.clients[0] || null;
  uiState.selectedClientId = fallbackClient?.client_id || "";
  persistUiState();
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.error || "Request failed");
  }

  return result;
}

function buildClientButton(client) {
  return `
    <button
      type="button"
      class="client-pill ${client.client_id === uiState.selectedClientId ? "active" : ""}"
      data-select-client="${escapeHtml(client.client_id)}"
    >
      ${escapeHtml(client.display_name)}
    </button>
  `;
}

function renderClientList(clients, container, emptyText) {
  if (!clients.length) {
    container.className = "client-button-list empty";
    container.textContent = emptyText;
    return;
  }

  container.className = "client-button-list";
  container.innerHTML = clients.map(buildClientButton).join("");
}

function attachClientButtonListeners() {
  document.querySelectorAll("[data-select-client]").forEach((button) => {
    button.addEventListener("click", () => {
      const clientId = button.dataset.selectClient || "";
      if (clientId) {
        selectClient(clientId);
      }
    });
  });
}

function renderClientLists() {
  const activeClients = dashboardState.clients.filter((client) => !client.archived);
  const archivedClients = dashboardState.clients.filter((client) => client.archived);

  renderClientList(activeClients, clientsListNode, "Активных клиентов пока нет.");
  renderClientList(archivedClients, archivedListNode, "В архиве пока ничего нет.");

  clientsCountNode.textContent = String(activeClients.length);
  archivedBadgeNode.textContent = String(archivedClients.length);
  attachClientButtonListeners();
}

function buildSpecItem(label, value) {
  return `
    <div class="spec-item">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value || "—")}</strong>
    </div>
  `;
}

function buildQueueMarkup(client) {
  const queue = client.queued_commands || [];
  if (!queue.length) {
    return '<p class="muted">Очередь пуста.</p>';
  }

  return `
    <ul class="queue-list">
      ${queue
        .map(
          (item) => `
            <li>
              <code>${escapeHtml(item.display_command || item.command)}</code>
              <span>${formatDate(item.created_at)}</span>
            </li>
          `
        )
        .join("")}
    </ul>
  `;
}

function buildSpecsTab(client) {
  const info = client.system_info || {};
  const specs = [
    ["Процессор", info.cpu_name],
    ["Архитектура", info.architecture],
    ["Потоки CPU", info.cpu_logical_cores],
    ["RAM всего", info.ram_total],
    ["RAM занято", info.ram_used],
    ["Заполненность RAM", info.ram_usage_percent],
    ["Диск всего", info.disk_total],
    ["Диск занято", info.disk_used],
    ["Заполненность диска", info.disk_usage_percent],
    ["Хост", info.hostname],
    ["Пользователь", info.username],
    ["OS", info.os],
    ["Версия OS", info.platform_release],
    ["IP", info.local_ips],
    ["Клиент", info.client_version],
    ["Python", info.python_version]
  ];

  const latestReport = client.latest_report
    ? `<pre>${escapeHtml(client.latest_report.result)}</pre>`
    : '<p class="muted">Отчетов пока нет.</p>';

  return `
    <div class="detail-stack">
      <section class="subpanel">
        <div class="subpanel-header">
          <h3>Полные характеристики</h3>
          <span class="muted">от процессора до памяти</span>
        </div>
        <div class="spec-grid">
          ${specs.map(([label, value]) => buildSpecItem(label, value)).join("")}
        </div>
      </section>

      <section class="subpanel">
        <div class="subpanel-header">
          <h3>Очередь команд</h3>
          <span class="muted">${client.pending_commands} в очереди</span>
        </div>
        ${buildQueueMarkup(client)}
      </section>

      <section class="subpanel">
        <div class="subpanel-header">
          <h3>Последний отчет</h3>
          <span class="muted">${formatDate(client.latest_report?.received_at)}</span>
        </div>
        ${latestReport}
      </section>
    </div>
  `;
}

function buildTerminalTypeOptions(selectedType) {
  return Object.entries(TERMINAL_TYPES)
    .map(
      ([type, meta]) => `
        <option value="${escapeHtml(type)}" ${type === selectedType ? "selected" : ""}>
          ${escapeHtml(meta.label)}
        </option>
      `
    )
    .join("");
}

function buildHistoryEntry(entry, sessionType) {
  if (entry.kind === "result") {
    return `
      <article class="terminal-entry terminal-entry-result ${entry.status === "error" ? "error" : ""}">
        <div class="terminal-entry-head">
          <span>Output</span>
          <time>${formatDate(entry.createdAt)}</time>
        </div>
        <pre>${escapeHtml(entry.text || "")}</pre>
      </article>
    `;
  }

  return `
    <article class="terminal-entry terminal-entry-command ${entry.status}">
      <div class="terminal-entry-head">
        <span>${escapeHtml(getTerminalLabel(sessionType))}</span>
        <time>${formatDate(entry.createdAt)}</time>
      </div>
      <pre>${escapeHtml(entry.text || "")}</pre>
      <p class="terminal-state">
        ${
          entry.status === "pending"
            ? "Ожидает ответ клиента"
            : entry.status === "error"
              ? "Завершено с ошибкой"
              : "Выполнено"
        }
      </p>
    </article>
  `;
}

function buildTerminalTab(client) {
  const sessions = syncActiveSession(client.client_id);
  const activeSession = getActiveSession(client.client_id);

  return `
    <div class="terminal-layout">
      <aside class="terminal-sidebar">
        <div class="terminal-create-box">
          <label>
            Новый терминал
            <select id="new-terminal-type">
              ${buildTerminalTypeOptions("cmd")}
            </select>
          </label>
          <button type="button" class="small-button" data-create-session="${escapeHtml(client.client_id)}">
            Создать
          </button>
        </div>

        <div class="terminal-session-list">
          ${sessions
            .map(
              (session) => `
                <button
                  type="button"
                  class="terminal-session-button ${session.id === activeSession?.id ? "active" : ""}"
                  data-select-session="${escapeHtml(session.id)}"
                >
                  <span>${escapeHtml(session.title)}</span>
                  <small>${escapeHtml(getTerminalLabel(session.terminalType))}</small>
                </button>
              `
            )
            .join("")}
        </div>
      </aside>

      <div class="terminal-main">
        ${
          activeSession
            ? `
              <div class="terminal-toolbar">
                <label>
                  Название
                  <input
                    type="text"
                    value="${escapeHtml(activeSession.title)}"
                    maxlength="120"
                    data-session-title-input="${escapeHtml(activeSession.id)}"
                  />
                </label>
                <label>
                  Тип
                  <select data-session-type="${escapeHtml(activeSession.id)}">
                    ${buildTerminalTypeOptions(activeSession.terminalType)}
                  </select>
                </label>
                <button
                  type="button"
                  class="small-button danger-button"
                  data-delete-session="${escapeHtml(activeSession.id)}"
                >
                  Удалить
                </button>
              </div>

              <div class="terminal-log">
                ${
                  activeSession.history.length
                    ? activeSession.history.map((entry) => buildHistoryEntry(entry, activeSession.terminalType)).join("")
                    : '<p class="muted terminal-empty">История пустая. Отправьте первую команду.</p>'
                }
              </div>

              <form class="terminal-form" data-terminal-form="${escapeHtml(activeSession.id)}">
                <label>
                  Команда
                  <textarea
                    name="command"
                    rows="4"
                    placeholder="Введите команду для выбранного терминала"
                    required
                  ></textarea>
                </label>
                <button type="submit">Отправить в терминал</button>
              </form>
              <p class="hint">Сессии сохраняются локально и не удаляются автоматически, пока вы не удалите их сами.</p>
            `
            : '<p class="muted">Создайте терминал для этого клиента.</p>'
        }
      </div>
    </div>
  `;
}

function buildClientHeader(client) {
  return `
    <div class="detail-header">
      <div>
        <p class="eyebrow detail-eyebrow">Клиент</p>
        <h2>${escapeHtml(client.display_name)}</h2>
        <p class="mono muted">${escapeHtml(client.client_id)}</p>
      </div>
      <div class="detail-header-right">
        <div class="title-row">
          <span class="status-pill ${client.is_online ? "online" : "offline"}">
            ${client.is_online ? "online" : "offline"}
          </span>
          ${client.archived ? '<span class="status-pill archived">archived</span>' : ""}
        </div>
        <p class="muted">Последний контакт: ${formatDate(client.last_seen_at)}</p>
      </div>
    </div>
  `;
}

function renderDetails() {
  const client = getSelectedClient();
  if (!client) {
    clientDetailsNode.className = "client-details-empty";
    clientDetailsNode.textContent =
      "Выберите клиента в списке слева, чтобы открыть характеристики и терминал.";
    return;
  }

  clientDetailsNode.className = "client-details";
  clientDetailsNode.innerHTML = `
    ${buildClientHeader(client)}

    <form class="rename-form" data-rename-form="${escapeHtml(client.client_id)}">
      <label>
        Имя клиента
        <input
          type="text"
          name="name"
          value="${escapeHtml(client.name || "")}"
          placeholder="Введите имя клиента"
        />
      </label>
      <button type="submit" class="small-button">Сохранить имя</button>
    </form>

    <div class="actions-row">
      <button type="button" class="small-button" data-restart-client="${escapeHtml(client.client_id)}">
        Restart
      </button>
      <button
        type="button"
        class="small-button secondary-button"
        data-archive-client="${escapeHtml(client.client_id)}"
        data-archived-state="${client.archived ? "true" : "false"}"
      >
        ${client.archived ? "Вернуть" : "В архив"}
      </button>
      <button
        type="button"
        class="small-button danger-button"
        data-delete-client="${escapeHtml(client.client_id)}"
      >
        Удалить клиента
      </button>
    </div>

    <div class="tab-row">
      <button type="button" class="tab-button ${uiState.selectedTab === "specs" ? "active" : ""}" data-client-tab="specs">
        Характеристики
      </button>
      <button
        type="button"
        class="tab-button ${uiState.selectedTab === "terminal" ? "active" : ""}"
        data-client-tab="terminal"
      >
        Терминал
      </button>
    </div>

    <div class="tab-panel">
      ${uiState.selectedTab === "specs" ? buildSpecsTab(client) : buildTerminalTab(client)}
    </div>
  `;

  attachDetailListeners(client);
}

function attachDetailListeners(client) {
  clientDetailsNode.querySelectorAll("[data-client-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      selectTab(button.dataset.clientTab || "specs");
    });
  });

  const renameForm = clientDetailsNode.querySelector("[data-rename-form]");
  if (renameForm) {
    renameForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const name = renameForm.elements.name.value.trim();

      if (!name) {
        setStatus("Имя клиента не должно быть пустым.", true);
        return;
      }

      setStatus(`Переименование клиента ${client.client_id}...`);
      try {
        await postJson("/rename-client", {
          client_id: client.client_id,
          name
        });
        setStatus("Имя клиента сохранено.");
        await loadDashboard();
      } catch (error) {
        setStatus(error.message, true);
      }
    });
  }

  const restartButton = clientDetailsNode.querySelector("[data-restart-client]");
  if (restartButton) {
    restartButton.addEventListener("click", async () => {
      setStatus(`Перезапуск клиента ${client.client_id}...`);
      try {
        await postJson("/restart-client", { client_id: client.client_id });
        setStatus(`Команда restart поставлена для ${client.client_id}.`);
        await loadDashboard();
      } catch (error) {
        setStatus(error.message, true);
      }
    });
  }

  const archiveButton = clientDetailsNode.querySelector("[data-archive-client]");
  if (archiveButton) {
    archiveButton.addEventListener("click", async () => {
      const archived = archiveButton.dataset.archivedState === "true";

      setStatus(`${archived ? "Возврат" : "Архивация"} клиента ${client.client_id}...`);
      try {
        await postJson("/archive-client", {
          client_id: client.client_id,
          archived: !archived
        });
        setStatus(archived ? "Клиент возвращен из архива." : "Клиент отправлен в архив.");
        await loadDashboard();
      } catch (error) {
        setStatus(error.message, true);
      }
    });
  }

  const deleteButton = clientDetailsNode.querySelector("[data-delete-client]");
  if (deleteButton) {
    deleteButton.addEventListener("click", async () => {
      if (!window.confirm(`Удалить клиента ${client.client_id} со всеми отчетами и очередью команд?`)) {
        return;
      }

      setStatus(`Удаление клиента ${client.client_id}...`);
      try {
        await postJson("/delete-client", { client_id: client.client_id });
        setStatus("Клиент удален.");
        await loadDashboard();
      } catch (error) {
        setStatus(error.message, true);
      }
    });
  }

  const createSessionButton = clientDetailsNode.querySelector("[data-create-session]");
  if (createSessionButton) {
    createSessionButton.addEventListener("click", () => {
      const typeSelect = clientDetailsNode.querySelector("#new-terminal-type");
      const terminalType = TERMINAL_TYPES[typeSelect?.value] ? typeSelect.value : "cmd";
      const session = {
        id: generateId("session"),
        title: createSessionTitle(client.client_id, terminalType),
        terminalType,
        createdAt: new Date().toISOString(),
        history: [],
        appliedReportIds: []
      };

      const sessions = getClientSessions(client.client_id);
      sessions.push(session);
      uiState.terminalsByClient[client.client_id] = sessions;
      uiState.activeSessionByClient[client.client_id] = session.id;
      persistUiState();
      renderDetails();
    });
  }

  clientDetailsNode.querySelectorAll("[data-select-session]").forEach((button) => {
    button.addEventListener("click", () => {
      uiState.activeSessionByClient[client.client_id] = button.dataset.selectSession || "";
      persistUiState();
      renderDetails();
    });
  });

  const sessionTitleInput = clientDetailsNode.querySelector("[data-session-title-input]");
  if (sessionTitleInput) {
    sessionTitleInput.addEventListener("change", () => {
      const session = getActiveSession(client.client_id);
      if (!session) {
        return;
      }

      session.title = sessionTitleInput.value.trim().slice(0, 120) || createSessionTitle(client.client_id, session.terminalType);
      persistUiState();
      renderDetails();
    });
  }

  const sessionTypeSelect = clientDetailsNode.querySelector("[data-session-type]");
  if (sessionTypeSelect) {
    sessionTypeSelect.addEventListener("change", () => {
      const session = getActiveSession(client.client_id);
      if (!session) {
        return;
      }

      session.terminalType = TERMINAL_TYPES[sessionTypeSelect.value] ? sessionTypeSelect.value : "cmd";
      persistUiState();
      renderDetails();
    });
  }

  const deleteSessionButton = clientDetailsNode.querySelector("[data-delete-session]");
  if (deleteSessionButton) {
    deleteSessionButton.addEventListener("click", () => {
      const sessionId = deleteSessionButton.dataset.deleteSession || "";
      const sessions = getClientSessions(client.client_id).filter((session) => session.id !== sessionId);

      if (!sessions.length) {
        uiState.terminalsByClient[client.client_id] = [];
        delete uiState.activeSessionByClient[client.client_id];
      } else {
        uiState.terminalsByClient[client.client_id] = sessions;
        uiState.activeSessionByClient[client.client_id] = sessions[0].id;
      }

      persistUiState();
      renderDetails();
    });
  }

  const terminalForm = clientDetailsNode.querySelector("[data-terminal-form]");
  if (terminalForm) {
    terminalForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const session = getActiveSession(client.client_id);
      const rawCommand = terminalForm.elements.command.value.trim();

      if (!session || !rawCommand) {
        setStatus("Введите команду для терминала.", true);
        return;
      }

      const command = buildTerminalCommand(session.terminalType, rawCommand);
      setStatus(`Команда отправляется в ${session.title}...`);

      try {
        const result = await postJson("/add-command", {
          client_id: client.client_id,
          command,
          command_kind: "terminal",
          terminal_session_id: session.id,
          terminal_type: session.terminalType,
          terminal_title: session.title,
          display_command: rawCommand
        });

        session.history.push({
          id: generateId("entry"),
          kind: "command",
          text: rawCommand,
          createdAt: new Date().toISOString(),
          commandId: result.command_id || "",
          status: "pending"
        });
        persistUiState();
        terminalForm.reset();
        renderDetails();
        setStatus("Команда поставлена в очередь терминала.");
        await loadDashboard();
      } catch (error) {
        setStatus(error.message, true);
      }
    });
  }
}

function buildTerminalCommand(type, rawCommand) {
  const command = rawCommand.trim();
  switch (type) {
    case "powershell":
      return `shell:powershell -NoProfile -ExecutionPolicy Bypass -Command '${command.replaceAll("'", "''")}'`;
    case "bash":
      return `shell:bash -lc ${JSON.stringify(command)}`;
    case "sh":
      return `shell:sh -lc ${JSON.stringify(command)}`;
    case "cmd":
    default:
      return `shell:${command}`;
  }
}

function syncTerminalReports(reports) {
  let changed = false;

  reports.forEach((report) => {
    if (report.command_kind !== "terminal" || !report.client_id || !report.terminal_session_id || !report.report_id) {
      return;
    }

    const sessions = getClientSessions(report.client_id);
    const session = sessions.find((item) => item.id === report.terminal_session_id);
    if (!session) {
      return;
    }

    if (session.appliedReportIds.includes(report.report_id)) {
      return;
    }

    const commandEntry = session.history.find(
      (entry) => entry.kind === "command" && entry.commandId && entry.commandId === report.command_id
    );
    if (commandEntry) {
      commandEntry.status = report.result.startsWith("error=") ? "error" : "done";
    }

    session.history.push({
      id: generateId("entry"),
      kind: "result",
      text: report.result,
      createdAt: report.received_at,
      commandId: report.command_id || "",
      status: report.result.startsWith("error=") ? "error" : "done"
    });
    session.appliedReportIds.push(report.report_id);
    changed = true;
  });

  if (changed) {
    persistUiState();
  }
}

function renderReports(reports) {
  if (!reports.length) {
    reportsListNode.className = "list empty";
    reportsListNode.textContent = "Отчетов пока нет.";
    return;
  }

  reportsListNode.className = "list";
  reportsListNode.innerHTML = reports
    .map(
      (report) => `
        <section class="card">
          <div class="card-header">
            <div>
              <h3>${escapeHtml(report.display_name || report.client_id)}</h3>
              <p class="muted mono">${escapeHtml(report.client_id)}</p>
            </div>
            <span>${formatDate(report.received_at)}</span>
          </div>
          ${
            report.command_kind === "terminal"
              ? `
                <div class="report-line">
                  <span class="muted">Сессия:</span>
                  <strong>${escapeHtml(report.terminal_title || report.terminal_session_id || "терминал")}</strong>
                </div>
                <div class="report-line">
                  <span class="muted">Команда:</span>
                  <code>${escapeHtml(report.display_command || "—")}</code>
                </div>
              `
              : ""
          }
          <pre>${escapeHtml(report.result)}</pre>
        </section>
      `
    )
    .join("");
}

function renderDashboard(payload) {
  dashboardState.clients = payload.clients || [];
  dashboardState.reports = payload.reports || [];

  syncSelectedClient();
  syncTerminalReports(dashboardState.reports);
  renderClientLists();
  renderDetails();
  renderReports(dashboardState.reports);

  totalCountNode.textContent = String(payload.total_clients || 0);
  onlineCountNode.textContent = String(payload.online_clients || 0);
  activeCountNode.textContent = String(payload.active_clients || 0);
  archivedCountNode.textContent = String(payload.archived_clients || 0);
}

async function loadDashboard() {
  setStatus("Загрузка данных...");

  try {
    const response = await fetch("/api/dashboard");
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || "Не удалось загрузить панель");
    }

    renderDashboard(payload);
    setStatus(`Данные обновлены: ${new Date().toLocaleTimeString()}`);
  } catch (error) {
    setStatus(error.message, true);
  }
}

function initialize() {
  refreshButton.addEventListener("click", loadDashboard);
  loadDashboard();
  window.setInterval(loadDashboard, REFRESH_INTERVAL_MS);
}

initialize();
