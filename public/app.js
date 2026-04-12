const DEFAULT_TOKEN = "a9K2xP8mZ7QwL1vB";
const REFRESH_INTERVAL_MS = 5000;

const tokenInput = document.getElementById("token");
const refreshButton = document.getElementById("refresh-button");
const statusNode = document.getElementById("status");
const clientsCountNode = document.getElementById("clients-count");
const clientsListNode = document.getElementById("clients-list");
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

async function loadDashboard() {
  const token = readToken();
  setStatus("Загрузка данных...");

  try {
    const response = await fetch(`/api/dashboard?token=${encodeURIComponent(token)}`);
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || "Не удалось загрузить панель");
    }

    renderClients(payload.clients || []);
    renderReports(payload.reports || []);
    clientsCountNode.textContent = String(payload.total_clients || 0);
    setStatus(`Данные обновлены: ${new Date().toLocaleTimeString()}`);
  } catch (error) {
    setStatus(error.message, true);
  }
}

function renderClients(clients) {
  if (!clients.length) {
    clientsListNode.className = "list empty";
    clientsListNode.textContent = "Клиенты пока не зарегистрированы.";
    return;
  }

  clientsListNode.className = "list";
  clientsListNode.innerHTML = clients
    .map((client) => {
      const queue = client.queued_commands || [];
      const queueHtml = queue.length
        ? queue
            .map(
              (item) =>
                `<li><code>${escapeHtml(item.command)}</code><span>${formatDate(
                  item.created_at
                )}</span></li>`
            )
            .join("")
        : "<li>Очередь пуста</li>";

      const latestReport = client.latest_report
        ? `<pre>${escapeHtml(client.latest_report.result)}</pre>`
        : "<p class=\"muted\">Отчетов пока нет</p>";

      return `
        <section class="card">
          <div class="card-header">
            <div>
              <h3>${escapeHtml(client.client_id)}</h3>
              <p>Последний контакт: ${formatDate(client.last_seen_at)}</p>
            </div>
            <button type="button" class="small-button" data-client-id="${escapeHtml(client.client_id)}">
              Выбрать
            </button>
          </div>
          <p>Регистрация: ${formatDate(client.registered_at)}</p>
          <p>Команд в очереди: ${client.pending_commands}</p>
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
    })
    .join("");

  document.querySelectorAll("[data-client-id]").forEach((button) => {
    button.addEventListener("click", () => {
      clientIdInput.value = button.dataset.clientId || "";
      clientIdInput.focus();
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
            <h3>${escapeHtml(report.client_id)}</h3>
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
    const response = await fetch("/add-command", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        client_id: clientId,
        token,
        command
      })
    });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || "Не удалось отправить команду");
    }

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

