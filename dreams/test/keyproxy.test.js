import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import test from 'node:test';
import { startKeyProxy } from '../lib/keyproxy.js';

// A stand-in for api.anthropic.com that records what reached it.
const upstream = async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: one\n\n');
      setTimeout(() => res.end('event: two\n\n'), 5);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { seen, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
};

const call = (url, { method = 'POST', headers = {}, body = '' } = {}) => new Promise((resolve, reject) => {
  const req = http.request(url, { method, headers }, (res) => {
    let text = '';
    res.on('data', (chunk) => {
      text += chunk;
    });
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
  });
  req.on('error', reject);
  req.end(body);
});

test('the proxy swaps its run token for the real key, and only the token gets through', async () => {
  const api = await upstream();
  const proxy = await startKeyProxy({ apiKey: 'sk-real', upstream: api.url });
  try {
    assert.match(proxy.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/, 'loopback only');
    assert.notEqual(proxy.token, 'sk-real');
    assert.ok(proxy.token.length >= 32);

    const ok = await call(`${proxy.baseUrl}/v1/messages?beta=true`, {
      headers: { 'x-api-key': proxy.token, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: '{"model":"m"}',
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.text, 'event: one\n\nevent: two\n\n', 'the stream is passed through');
    assert.equal(api.seen.length, 1);
    assert.equal(api.seen[0].url, '/v1/messages?beta=true');
    assert.equal(api.seen[0].headers['x-api-key'], 'sk-real');
    assert.equal(api.seen[0].headers['anthropic-version'], '2023-06-01');
    assert.equal(api.seen[0].body, '{"model":"m"}');

    const bearer = await call(`${proxy.baseUrl}/v1/messages`, { headers: { authorization: `Bearer ${proxy.token}` } });
    assert.equal(bearer.status, 200);
    assert.equal(api.seen[1].headers['x-api-key'], 'sk-real');
    assert.equal(api.seen[1].headers.authorization, undefined, 'the token never goes upstream');

    for (const headers of [{}, { 'x-api-key': 'sk-guess' }, { authorization: 'Bearer nope' }, { 'x-api-key': `${proxy.token}x` }]) {
      const denied = await call(`${proxy.baseUrl}/v1/messages`, { headers });
      assert.equal(denied.status, 401);
      assert.ok(!denied.text.includes('sk-real'));
    }
    assert.equal(api.seen.length, 2, 'nothing without the token reaches the API');
  } finally {
    await proxy.close();
    await api.close();
  }
});

test('the proxy only forwards to its upstream, and closing it ends open connections', async () => {
  const api = await upstream();
  const proxy = await startKeyProxy({ apiKey: 'sk-real', upstream: api.url });
  const { port } = new URL(proxy.baseUrl);
  // An absolute-form request line, as a forward proxy would get.
  const reply = await new Promise((resolve) => {
    const socket = net.connect(Number(port), '127.0.0.1', () => {
      socket.write(`GET http://example.com/steal HTTP/1.1\r\nHost: example.com\r\nx-api-key: ${proxy.token}\r\nConnection: close\r\n\r\n`);
    });
    let text = '';
    socket.on('data', (chunk) => {
      text += chunk;
    });
    socket.on('close', () => resolve(text));
  });
  assert.match(reply, /^HTTP\/1\.1 400/);
  assert.equal(api.seen.length, 0);

  const idle = net.connect(Number(port), '127.0.0.1');
  idle.on('error', () => {});
  await new Promise((resolve) => idle.once('connect', resolve));
  const closedAt = Date.now();
  await proxy.close();
  assert.ok(Date.now() - closedAt < 1000, 'an idle keep-alive socket does not hold close open');
  await assert.rejects(call(`${proxy.baseUrl}/v1/messages`, { headers: { 'x-api-key': proxy.token } }));
  idle.destroy();
  await api.close();
});
