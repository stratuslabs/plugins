import { randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';

/**
 * Keeps the Anthropic key out of the sandbox. evaluate.sh runs model-written
 * code with the experimenter's environment and network access, so a key in
 * that environment could leave the host. Instead each run gets this loopback
 * proxy, in the daemon and outside the sandbox: the run's `claude` is pointed
 * at it with a random per-run token as its "API key", and the proxy swaps the
 * token for the real key on the way to the API. Code in the run can spend
 * tokens while the run lasts; it cannot take the key, and the token is
 * worthless once the run's proxy closes.
 */

export const ANTHROPIC_API = 'https://api.anthropic.com';

// Hop-by-hop headers (RFC 9110 7.6.1), plus the credentials this proxy owns.
const DROP = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'te', 'trailer', 'upgrade', 'host', 'authorization', 'x-api-key']);

const same = (presented, token) => {
  if (typeof presented !== 'string') {
    return false;
  }
  const a = Buffer.from(presented);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
};

const presentedToken = (headers) => {
  const auth = headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return auth.slice('Bearer '.length);
  }
  return headers['x-api-key'];
};

export const startKeyProxy = async ({ apiKey, upstream = ANTHROPIC_API }) => {
  const target = new URL(upstream);
  const client = target.protocol === 'https:' ? https : http;
  const base = target.pathname.replace(/\/$/, '');
  const token = randomBytes(32).toString('hex');
  const sockets = new Set();

  const server = http.createServer((req, res) => {
    // Origin-form only: this forwards to the API, never to a URL it is handed.
    if (!req.url?.startsWith('/') || req.url.startsWith('//')) {
      res.writeHead(400, { 'content-type': 'text/plain' }).end('bad request\n');
      return;
    }
    if (!same(presentedToken(req.headers), token)) {
      res.writeHead(401, { 'content-type': 'application/json' })
        .end('{"type":"error","error":{"type":"authentication_error","message":"not this run\'s token"}}\n');
      return;
    }
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([name]) => !DROP.has(name)));
    headers.host = target.host;
    headers['x-api-key'] = apiKey;
    const out = client.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      method: req.method,
      path: base + req.url,
      headers,
    }, (upstreamRes) => {
      const back = Object.fromEntries(Object.entries(upstreamRes.headers).filter(([name]) => !DROP.has(name)));
      res.writeHead(upstreamRes.statusCode ?? 502, back);
      upstreamRes.pipe(res);
    });
    out.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain' });
      }
      res.end();
    });
    req.on('aborted', () => out.destroy());
    req.pipe(out);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    token,
    close: () => new Promise((resolve) => {
      server.close(() => resolve());
      for (const socket of sockets) {
        socket.destroy();
      }
    }),
  };
};
