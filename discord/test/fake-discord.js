import http from 'node:http';
import { WebSocketServer } from 'ws';

export const BOT = '111111111111111111';

/**
 * Just enough of Discord for the adapter's own tests: `GET /gateway/bot`,
 * message (post, edit, delete), typing and thread routes over REST, and a gateway that says
 * hello, answers heartbeats, identifies and resumes. Records what it was
 * sent. `closeOnIdentify` makes it refuse the identify with a close code;
 * `gatewayDelayMs` slows `GET /gateway/bot` and `gatewayUrl` replaces the
 * gateway it names; `port` picks where it listens.
 */
export const fakeDiscord = async ({ closeOnIdentify, gatewayDelayMs = 0, gatewayUrl, port: listenPort = 0 } = {}) => {
  // `channels` (id -> channel object) and `history` (channel id -> its
  // messages, any order) are the test's to fill; GETs read them.
  const state = { identifies: [], resumes: [], posts: [], patches: [], deletes: [], callbacks: [], typing: [], threads: [], sockets: [], gets: [], channels: {}, history: {}, files: {}, downloads: [], seq: 0 };
  let nextId = 900000000000000000n;
  const id = () => String((nextId += 1n));
  const server = http.createServer((req, res) => {
    const parts = [];
    req.on('data', (part) => {
      parts.push(part);
    });
    req.on('end', async () => {
      const raw = Buffer.concat(parts);
      let json;
      // A post with files is multipart: `payload_json` is the body and each
      // `files[n]` part is recorded as { name, bytes }.
      let uploads;
      if (/^multipart\/form-data/.test(req.headers['content-type'] ?? '')) {
        const form = await new Request('http://fake/', { method: 'POST', headers: { 'content-type': req.headers['content-type'] }, body: raw }).formData();
        json = JSON.parse(form.get('payload_json') ?? '{}');
        uploads = [];
        for (const [key, value] of form.entries()) {
          if (key.startsWith('files[')) uploads.push({ name: value.name, bytes: Buffer.from(await value.arrayBuffer()) });
        }
      } else {
        json = raw.length ? JSON.parse(raw.toString('utf8')) : undefined;
      }
      const send = (status, value) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      // The CDN: `files` (name -> Buffer) is the test's to fill.
      if (req.method === 'GET' && req.url.startsWith('/cdn/')) {
        const name = req.url.slice('/cdn/'.length);
        state.downloads.push({ name, authorization: req.headers.authorization });
        const file = state.files[name];
        if (!file) {
          res.writeHead(404);
          return res.end();
        }
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        // `fileDelayMs` holds the body back, for a slow download.
        return state.fileDelayMs ? void setTimeout(() => res.end(file), state.fileDelayMs).unref() : res.end(file);
      }
      const url = req.url.replace(/^\/api\/v10/, '');
      if (req.method === 'GET' && url === '/gateway/bot') {
        const answer = () => send(200, { url: gatewayUrl ?? `ws://127.0.0.1:${port}/gw`, shards: 1, session_start_limit: { total: 1000, remaining: 1000, reset_after: 0, max_concurrency: 1 } });
        return gatewayDelayMs ? void setTimeout(answer, gatewayDelayMs) : answer();
      }
      let match;
      if (req.method === 'GET') {
        state.gets.push(url);
      }
      if (req.method === 'GET' && (match = url.match(/^\/channels\/(\d+)$/))) {
        const channel = state.channels[match[1]];
        return channel ? send(200, channel) : send(404, { message: 'Unknown Channel', code: 10003 });
      }
      if (req.method === 'GET' && (match = url.match(/^\/channels\/(\d+)\/messages\/(\d+)$/))) {
        const found = (state.history[match[1]] ?? []).find((m) => m.id === match[2]);
        return found ? send(200, found) : send(404, { message: 'Unknown Message', code: 10008 });
      }
      if (req.method === 'GET' && (match = url.match(/^\/channels\/(\d+)\/messages(?:\?(.*))?$/))) {
        if (!state.channels[match[1]]) {
          return send(404, { message: 'Unknown Channel', code: 10003 });
        }
        // Discord's paging: newest first always; `after` takes the
        // messages just after the id, `before` (or nothing) those just
        // before it.
        const query = new URLSearchParams(match[2] ?? '');
        const limit = Number(query.get('limit') ?? 50);
        const all = [...(state.history[match[1]] ?? [])].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
        let page;
        if (query.has('after')) {
          page = all.filter((m) => BigInt(m.id) > BigInt(query.get('after'))).slice(0, limit);
        } else {
          const before = query.has('before') ? BigInt(query.get('before')) : undefined;
          page = all.filter((m) => before === undefined || BigInt(m.id) < before).slice(-limit);
        }
        return send(200, page.reverse());
      }
      if (req.method === 'POST' && (match = url.match(/^\/channels\/(\d+)\/messages$/))) {
        state.posts.push({ channelId: match[1], body: json, authorization: req.headers.authorization, ...(uploads ? { files: uploads } : {}) });
        return send(200, { id: id(), channel_id: match[1] });
      }
      if (req.method === 'PATCH' && (match = url.match(/^\/channels\/(\d+)\/messages\/(\d+)$/))) {
        state.patches.push({ channelId: match[1], messageId: match[2], body: json });
        return send(200, { id: match[2] });
      }
      if (req.method === 'POST' && (match = url.match(/^\/interactions\/(\d+)\/([^/]+)\/callback$/))) {
        state.callbacks.push({ id: match[1], token: match[2], body: json, authorization: req.headers.authorization });
        res.writeHead(204);
        return res.end();
      }
      if (req.method === 'DELETE' && (match = url.match(/^\/channels\/(\d+)\/messages\/(\d+)$/))) {
        state.deletes.push({ channelId: match[1], messageId: match[2] });
        res.writeHead(204);
        return res.end();
      }
      if (req.method === 'POST' && (match = url.match(/^\/channels\/(\d+)\/typing$/))) {
        state.typing.push(match[1]);
        res.writeHead(204);
        return res.end();
      }
      if (req.method === 'POST' && (match = url.match(/^\/channels\/(\d+)\/messages\/(\d+)\/threads$/))) {
        const thread = id();
        state.threads.push({ channelId: match[1], messageId: match[2], body: json, id: thread });
        return send(201, { id: thread, type: 11, parent_id: match[1] });
      }
      send(404, { message: 'Unknown', code: 0 });
    });
  });
  const wss = new WebSocketServer({ server });
  let current;
  wss.on('connection', (socket, req) => {
    current = socket;
    state.sockets.push(req.url);
    const out = (payload) => socket.send(JSON.stringify(payload));
    out({ op: 10, d: { heartbeat_interval: 45000 } });
    socket.on('message', (raw) => {
      const { op, d } = JSON.parse(String(raw));
      if (op === 1) {
        out({ op: 11 });
      } else if (op === 2) {
        state.identifies.push({ token: d.token, intents: d.intents });
        if (closeOnIdentify) {
          socket.close(closeOnIdentify, 'refused');
          return;
        }
        state.seq += 1;
        out({
          op: 0, t: 'READY', s: state.seq,
          d: { v: 10, user: { id: BOT, username: 'ava', discriminator: '0', bot: true }, guilds: [], session_id: 'session-1', resume_gateway_url: `ws://127.0.0.1:${port}/resume`, shard: [0, 1], application: { id: BOT, flags: 0 } },
        });
      } else if (op === 6) {
        state.resumes.push({ token: d.token, sessionId: d.session_id, seq: d.seq });
        state.seq += 1;
        out({ op: 0, t: 'RESUMED', s: state.seq, d: {} });
      }
    });
  });
  await new Promise((resolve) => server.listen(listenPort, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    api: `http://127.0.0.1:${port}/api`,
    /** Its CDN's origin, for `cdnHosts`; files are at `${cdn}/cdn/<name>`. */
    cdn: `http://127.0.0.1:${port}`,
    state,
    dispatch(t, d) {
      state.seq += 1;
      current.send(JSON.stringify({ op: 0, t, s: state.seq, d }));
    },
    /** End the session the way Discord does after a long outage: not resumable, so the bot identifies again. */
    invalidate() {
      current.send(JSON.stringify({ op: 9, d: false }));
    },
    /** Drop the connection the way a network blip does: a resumable close. */
    drop() {
      current.close(4000, 'blip');
    },
    async close() {
      for (const client of wss.clients) client.terminate();
      await new Promise((resolve) => wss.close(resolve));
      // Keep-alive REST connections would hold the close open.
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
};
