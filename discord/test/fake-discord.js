import http from 'node:http';
import { WebSocketServer } from 'ws';

export const BOT = '111111111111111111';

/**
 * Just enough of Discord for the adapter's own tests: `GET /gateway/bot`,
 * message (post, edit, delete), typing and thread routes over REST, and a gateway that says
 * hello, answers heartbeats, identifies and resumes. Records what it was
 * sent. `closeOnIdentify` makes it refuse the identify with a close code.
 */
export const fakeDiscord = async ({ closeOnIdentify } = {}) => {
  const state = { identifies: [], resumes: [], posts: [], patches: [], deletes: [], callbacks: [], typing: [], threads: [], sockets: [], seq: 0 };
  let nextId = 900000000000000000n;
  const id = () => String((nextId += 1n));
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (part) => {
      body += part;
    });
    req.on('end', () => {
      const json = body ? JSON.parse(body) : undefined;
      const send = (status, value) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      const url = req.url.replace(/^\/api\/v10/, '');
      if (req.method === 'GET' && url === '/gateway/bot') {
        return send(200, { url: `ws://127.0.0.1:${port}/gw`, shards: 1, session_start_limit: { total: 1000, remaining: 1000, reset_after: 0, max_concurrency: 1 } });
      }
      let match;
      if (req.method === 'POST' && (match = url.match(/^\/channels\/(\d+)\/messages$/))) {
        state.posts.push({ channelId: match[1], body: json, authorization: req.headers.authorization });
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
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    api: `http://127.0.0.1:${port}/api`,
    state,
    dispatch(t, d) {
      state.seq += 1;
      current.send(JSON.stringify({ op: 0, t, s: state.seq, d }));
    },
    /** Drop the connection the way a network blip does: a resumable close. */
    drop() {
      current.close(4000, 'blip');
    },
    async close() {
      for (const client of wss.clients) client.terminate();
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    },
  };
};
