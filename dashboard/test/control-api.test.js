import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createControlApi } from '@stratusagent/control-api';
import { createGateway } from '@stratusagent/gateway';

import { createDashboardAssets } from '../index.js';

// The dashboard and the control API now ship from different repositories,
// so nothing keeps them in step but this: the control API as published on
// npm, serving this package through its `ui` option, the way `stratus serve`
// wires the two together. The nightly run repeats it against agent main.

const UI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');

/** A gateway on the offline demo model and an API serving this package. */
const start = async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'stratus-dashboard-'));
  const env = { homeDir: home, cwd: home, processEnv: { STRATUS_PROVIDER: 'demo' } };
  const gateway = createGateway({ env, idleTimeoutMs: 0, log: () => {}, warn: () => {} });
  const api = createControlApi({ env, port: 0, ui: createDashboardAssets(), log: () => {}, warn: () => {} });
  await gateway.start();
  await api.start(gateway);
  assert.ok(api.url && api.token, 'the API reports where it bound and what it accepts');
  return {
    url: api.url,
    token: api.token,
    async stop() {
      await api.stop();
      await gateway.stop();
      await rm(home, { recursive: true, force: true });
    },
  };
};

/** Sign in the way `stratus dashboard` does: a one-time link, traded for a cookie. */
const signIn = async (host) => {
  const minted = await fetch(`${host.url}/api/v1/auth/ott`, {
    method: 'POST',
    headers: { authorization: `Bearer ${host.token}` },
  });
  assert.equal(minted.status, 200);
  const { url } = await minted.json();
  const exchanged = await fetch(url, { redirect: 'manual' });
  assert.equal(exchanged.status, 302);
  const cookie = exchanged.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie, 'the exchange sets a session cookie');
  return cookie;
};

test('a signed-in browser gets this package\'s shell and modules from the published control API', async () => {
  const host = await start();
  try {
    const cookie = await signIn(host);

    const shell = await fetch(`${host.url}/`, { headers: { cookie } });
    assert.equal(shell.status, 200);
    assert.match(shell.headers.get('content-type') ?? '', /^text\/html/);
    assert.match(shell.headers.get('content-security-policy') ?? '', /default-src 'self'/);
    assert.equal(await shell.text(), await readFile(path.join(UI, 'index.html'), 'utf8'));

    const app = await fetch(`${host.url}/app.js`, { headers: { cookie } });
    assert.equal(app.status, 200);
    assert.match(app.headers.get('content-type') ?? '', /^text\/javascript/);
    assert.equal(await app.text(), await readFile(path.join(UI, 'app.js'), 'utf8'));

    // A route the page renders itself still gets the shell.
    const route = await fetch(`${host.url}/agents/ava`, { headers: { cookie } });
    assert.equal(route.status, 200);
    assert.equal(await route.text(), await readFile(path.join(UI, 'index.html'), 'utf8'));
  } finally {
    await host.stop();
  }
});

test('a browser that is not signed in never gets the shell', async () => {
  const host = await start();
  try {
    const response = await fetch(`${host.url}/`);
    const body = await response.text();
    assert.notEqual(response.status, 200);
    assert.notEqual(body, await readFile(path.join(UI, 'index.html'), 'utf8'));
    assert.match(body, /stratus dashboard/);
  } finally {
    await host.stop();
  }
});
