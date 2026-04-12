# Remote Control System

Система состоит из:

- Node.js сервера на Express
- Python-клиента, который регистрируется на сервере и выполняет текстовые команды

## Структура проекта

```text
.
├── README.md
├── .gitignore
├── .github
│   └── workflows
│       └── build-windows-client.yml
├── package.json
├── client
│   ├── client.py
│   ├── requirements.txt
│   └── windows
│       ├── build_exe.bat
│       ├── install_client.bat
│       ├── start_client.bat
│       └── uninstall_client.bat
└── server
    ├── index.js
    ├── package.json
    └── public
        ├── app.js
        ├── index.html
        └── styles.css
```

## Фиксированные настройки

- Token: `a9K2xP8mZ7QwL1vB`
- Server URL: `https://client-status-server.onrender.com`

## Формат команд

Сервер принимает команды только как текстовую строку.

- `shell:<команда>`
- `download:<url> [имя_файла]`
- `update:<url>`
- `restart`

Примеры:

```text
shell:whoami
download:https://example.com/file.txt report.txt
update:https://example.com/client.py
restart
```

## API сервера

Главная страница сервера теперь отдает веб-интерфейс панели управления.

### `GET /`

Открывает браузерную панель, в которой можно:

- смотреть зарегистрированных клиентов
- смотреть последние отчеты
- отправлять команды конкретному клиенту

### `GET /health`

Служебный JSON endpoint для проверки, что сервер запущен.

### `POST /register`

Тело:

```json
{
  "client_id": "uuid",
  "token": "a9K2xP8mZ7QwL1vB"
}
```

### `GET /get-command`

Query params:

```text
client_id=<uuid>&token=a9K2xP8mZ7QwL1vB
```

Ответ:

```json
{
  "command": "shell:whoami"
}
```

или

```json
{
  "command": null
}
```

### `POST /report`

Тело:

```json
{
  "client_id": "uuid",
  "token": "a9K2xP8mZ7QwL1vB",
  "result": "exit_code=0\n\nstdout:\nmansur"
}
```

### `POST /add-command`

Тело:

```json
{
  "client_id": "uuid",
  "token": "a9K2xP8mZ7QwL1vB",
  "command": "shell:whoami"
}
```

### `GET /api/dashboard`

Защищенный endpoint для веб-интерфейса. Возвращает:

- список клиентов
- очереди команд
- последние отчеты
- общее число клиентов

### `POST /rename-client`

Тело:

```json
{
  "client_id": "uuid",
  "token": "a9K2xP8mZ7QwL1vB",
  "name": "Office-PC"
}
```

### `POST /archive-client`

Тело:

```json
{
  "client_id": "uuid",
  "token": "a9K2xP8mZ7QwL1vB",
  "archived": true
}
```

### `POST /restart-client`

Тело:

```json
{
  "client_id": "uuid",
  "token": "a9K2xP8mZ7QwL1vB"
}
```

### `POST /delete-client`

Тело:

```json
{
  "client_id": "uuid",
  "token": "a9K2xP8mZ7QwL1vB"
}
```

## Логика сервера

- На каждом защищенном endpoint проверяется `token`
- Если токен неверный, сервер возвращает `401`
- Клиенты и очереди команд сохраняются в `server/data/storage.json`
- Все действия логируются в `server/logs/server.log`
- Сервер принимает только команды `restart`, `shell:`, `download:` и `update:`
- Веб-интерфейс сервера доступен по корневому адресу `/`
- В панели есть переименование клиентов, архив и быстрый `restart client`
- Для каждого клиента рассчитывается статус `online/offline` по времени последнего контакта
- В панели показывается `hostname`, `username`, `OS`, `IP`, версия клиента
- Можно полностью удалить клиента вместе с его отчетами и очередью команд

## Запуск сервера

1. Перейти в корень проекта:

```bash
cd /Users/mansur/Documents/my\ derk
```

2. Установить зависимости:

```bash
npm install
```

3. Запустить:

```bash
npm start
```

Альтернативно можно запускать напрямую из каталога сервера:

```bash
cd /Users/mansur/Documents/my\ derk/server
npm install
npm start
```

Локально сервер будет доступен на:

```text
http://localhost:3000
```

Веб-интерфейс откроется по адресу:

```text
http://localhost:3000/
```

## Деплой на Render

В проект уже добавлен файл [render.yaml](/Users/mansur/Documents/my derk/render.yaml), поэтому самый простой вариант такой:

1. Залить проект в GitHub
2. Открыть Render
3. Нажать `New` -> `Blueprint`
4. Подключить репозиторий
5. Подтвердить создание сервиса `client-status-server`

Что будет использовать Render:

- `buildCommand`: `npm install`
- `startCommand`: `npm start`
- `healthCheckPath`: `/health`

Если хочешь создать сервис вручную через `Web Service`, укажи:

- Root Directory: оставить пустым или указать корень репозитория
- Environment: `Node`
- Build Command: `npm install`
- Start Command: `npm start`

После деплоя Render сам выдаст публичный адрес вида:

```text
https://client-status-server.onrender.com
```

Для Render можно использовать команду запуска:

```text
npm start
```

## Запуск клиента

1. Перейти в каталог клиента:

```bash
cd /Users/mansur/Documents/my\ derk/client
```

2. Установить зависимости:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

3. Запустить:

```bash
python3 client.py
```

При первом запуске клиент:

- генерирует `client_id`
- сохраняет его в `client/state/client_id.txt`
- регистрируется через `/register`
- затем каждые 5 секунд запрашивает `/get-command`

## Установка клиента на Windows

Скопируй папку `client` на Windows-машину, например в:

```text
C:\remote-client\client
```

Дальше открой `cmd` от имени пользователя, под которым должен работать клиент, и выполни:

```bat
cd C:\remote-client\client\windows
install_client.bat
```

Что делает установщик:

- создает `.venv`
- ставит `requests`
- создает задачу `rclient` в `Task Scheduler`
- включает автозапуск при входе пользователя в Windows

Для ручного запуска:

```bat
cd C:\remote-client\client\windows
start_client.bat
```

Для удаления автозапуска:

```bat
cd C:\remote-client\client\windows
uninstall_client.bat
```

Файлы состояния и логов клиента будут лежать в:

```text
client\state\
```

## EXE для Windows

Можно собрать один файл `rclient.exe`, чтобы на клиентской машине не ставить Python вручную.

Сборку нужно делать именно на Windows, не на macOS.

### Без Windows ПК

В проект уже добавлен workflow GitHub Actions:

- [.github/workflows/build-windows-client.yml](/Users/mansur/Documents/my derk/.github/workflows/build-windows-client.yml)

Теперь можно собирать `rclient.exe` вообще без своего Windows-ПК.

Как это работает:

1. Меняешь версию в [client.py](/Users/mansur/Documents/my derk/client/client.py), например:

```python
APP_VERSION = "1.0.1"
```

2. Коммитишь изменения и пушишь в GitHub
3. Создаешь git tag, например:

```bash
git tag v1.0.1
git push origin main
git push origin v1.0.1
```

4. GitHub Actions сам:

- поднимет Windows runner
- соберет `rclient.exe`
- прикрепит его к Release `v1.0.1`

После этого новый `exe` можно скачать прямо из `GitHub Releases`.

### Сборка EXE

На Windows-машине с исходниками проекта выполни:

```bat
cd C:\remote-client\client\windows
build_exe.bat
```

После этого появится файл:

```text
client\dist\rclient.exe
```

### Установка EXE на клиенте

Скопируй `rclient.exe` на клиентский Windows-ПК и просто запусти его.

При обычном запуске EXE сам:

- копирует себя в `%APPDATA%\rclient\rclient.exe`
- создает автозапуск в `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`
- сразу запускает установленную копию
- работает в фоне без консольного окна

Можно также явно запустить:

```bat
rclient.exe --install
```

Что сделает EXE:

- скопирует себя в `%APPDATA%\rclient\rclient.exe`
- создаст автозапуск в реестре текущего пользователя Windows
- сразу запустит установленную копию клиента
- будет запускаться при входе пользователя в Windows
- будет работать в фоновом режиме без окна
- будет работать без установленного Python

Для удаления:

```bat
rclient.exe --uninstall
```

## Как теперь работает обновление

Клиент сам проверяет обновление:

- при запуске
- потом каждые 10 минут

Проверка идет через `GitHub Releases` репозитория:

```text
https://github.com/hezztecan-spec/licilicl
```

Чтобы обновление сработало:

1. Подними версию в [client.py](/Users/mansur/Documents/my derk/client/client.py) в поле `APP_VERSION`
2. Собери новый `rclient.exe`
3. Загрузи его в `GitHub Release`
4. Название файла должно быть ровно:

```text
rclient.exe
```

5. Tag релиза должен быть больше текущей версии, например:

```text
v1.0.1
```

После этого клиент:

- увидит новый релиз
- скачает новый `exe`
- заменит старую версию
- сам перезапустится

## Важное замечание

Если клиент на Windows уже установлен старой сборкой, у него может не быть последних исправлений установки и обновления.

Поэтому один раз нужно:

1. получить свежий `rclient.exe` из нового GitHub Release
2. запустить его на клиентском ПК вручную

После этого дальше обновления уже должны идти автоматически через GitHub Releases.

## Пример добавления команды

После того как клиент зарегистрировался, можно поставить команду в очередь:

```bash
curl -X POST http://localhost:3000/add-command \
  -H "Content-Type: application/json" \
  -d '{
    "client_id": "ВАШ_CLIENT_ID",
    "token": "a9K2xP8mZ7QwL1vB",
    "command": "shell:whoami"
  }'
```

## Замечания по безопасности

- Токен общий для всех клиентов, поэтому это базовая схема авторизации, а не безопасная многоуровневая система
- Команды принимаются только в виде текста, объекты и вложенные структуры отклоняются
- Выполнение `shell:` команд потенциально опасно и должно использоваться только в доверенной среде
