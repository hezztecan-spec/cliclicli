const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const TOKEN = process.env.TOKEN || 'change-me';
const CLIENT_TTL_MS = Number(process.env.CLIENT_TTL_MS) || 120000;

const clients = new Map();

app.set('trust proxy', true);
app.use(cors());
app.use(express.json({ limit: '256kb' }));

app.use((req, res, next) => {
  console.log(
    `[${new Date().toISOString()}] ${req.method} ${req.url} from ${req.ip}`
  );
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

function isClientOnline(client) {
  return Date.now() - client.lastSeenAt <= CLIENT_TTL_MS;
}

function sanitizeString(value, maxLength = 200) {
  if (typeof value !== 'string') {
    return '';
  }

  return value.trim().slice(0, maxLength);
}

function serializeClient(client) {
  return {
    clientId: client.clientId,
    name: client.name,
    version: client.version,
    group: client.group,
    status: client.status,
    meta: client.meta,
    ip: client.ip,
    firstSeenAt: new Date(client.firstSeenAt).toISOString(),
    lastSeenAt: new Date(client.lastSeenAt).toISOString(),
    online: isClientOnline(client)
  };
}

function authMiddleware(req, res, next) {
  const authHeader = req.header('Authorization');
  const isValid =
    authHeader === TOKEN || authHeader === `Bearer ${TOKEN}`;

  if (!isValid) {
    console.log('Forbidden: invalid token');
    return res.status(403).json({ error: 'Forbidden' });
  }

  next();
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/health', (req, res) => {
  const allClients = [...clients.values()];
  const onlineClients = allClients.filter(isClientOnline).length;

  res.json({
    ok: true,
    uptimeSec: Math.round(process.uptime()),
    totalClients: allClients.length,
    onlineClients,
    serverTime: new Date().toISOString()
  });
});

app.use('/api', authMiddleware);

app.post('/api/heartbeat', (req, res) => {
  try {
    const clientId = sanitizeString(req.body.clientId, 100);
    const name = sanitizeString(req.body.name, 120);
    const version = sanitizeString(req.body.version, 60);
    const group = sanitizeString(req.body.group, 80);
    const status = sanitizeString(req.body.status, 120) || 'online';
    const meta =
      req.body.meta && typeof req.body.meta === 'object' && !Array.isArray(req.body.meta)
        ? req.body.meta
        : {};

    if (!clientId) {
      return res.status(400).json({ error: 'Field "clientId" is required' });
    }

    const now = Date.now();
    const existing = clients.get(clientId);
    const client = {
      clientId,
      name: name || existing?.name || clientId,
      version: version || existing?.version || '',
      group: group || existing?.group || '',
      status,
      meta,
      ip: req.ip,
      firstSeenAt: existing?.firstSeenAt || now,
      lastSeenAt: now
    };

    clients.set(clientId, client);
    console.log(`Heartbeat saved: ${clientId}`);

    res.json({
      ok: true,
      client: serializeClient(client)
    });
  } catch (error) {
    console.error('Error in POST /api/heartbeat:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/clients', (req, res) => {
  try {
    const groupFilter = sanitizeString(req.query.group || '', 80);
    const list = [...clients.values()]
      .filter((client) => !groupFilter || client.group === groupFilter)
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .map(serializeClient);

    res.json({
      clients: list,
      total: list.length,
      online: list.filter((client) => client.online).length,
      ttlMs: CLIENT_TTL_MS
    });
  } catch (error) {
    console.error('Error in GET /api/clients:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/clients/:clientId', (req, res) => {
  try {
    const clientId = sanitizeString(req.params.clientId, 100);
    const client = clients.get(clientId);

    if (!client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    res.json({ client: serializeClient(client) });
  } catch (error) {
    console.error('Error in GET /api/clients/:clientId:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/clients/:clientId', (req, res) => {
  try {
    const clientId = sanitizeString(req.params.clientId, 100);
    const deleted = clients.delete(clientId);

    if (!deleted) {
      return res.status(404).json({ error: 'Client not found' });
    }

    console.log(`Client deleted: ${clientId}`);
    res.json({ ok: true });
  } catch (error) {
    console.error('Error in DELETE /api/clients/:clientId:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err, req, res, next) => {
  console.error('Unhandled Express error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

setInterval(() => {
  const cutoff = Date.now() - CLIENT_TTL_MS * 10;

  for (const [clientId, client] of clients.entries()) {
    if (client.lastSeenAt < cutoff) {
      clients.delete(clientId);
    }
  }
}, 30000).unref();

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
