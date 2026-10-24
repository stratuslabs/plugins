process.env.TZ = 'America/New_York';

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createClaimStore } from '../lib/claims.js';
import { parseDreamsConfig, parseDuration, parseWindow } from '../lib/config.js';
import { summarizeFile, summarizeLog } from '../lib/summary.js';
import { clampBudget, nightAt } from '../lib/window.js';
import { homeSecretPaths } from '../lib/sandbox.js';

const local = (y, mo, d, h, mi = 0) => new Date(y, mo - 1, d, h, mi);
const W = parseWindow('23:00-07:00', 'window');

test('a window across midnight is one night, named by the date it opened', () => {
  assert.equal(nightAt(W, local(2026, 10, 23, 23, 30)).night, '2026-10-23');
  assert.equal(nightAt(W, local(2026, 10, 24, 6, 59)).night, '2026-10-23');
  assert.equal(nightAt(W, local(2026, 10, 24, 7, 0)), undefined);
  assert.equal(nightAt(W, local(2026, 10, 24, 12, 0)), undefined);
  assert.equal(nightAt(W, local(2026, 10, 24, 22, 59)), undefined);
  // Across a month boundary.
  assert.equal(nightAt(W, local(2026, 11, 1, 2, 0)).night, '2026-10-31');
});

test('a same-day window opens and closes on one date', () => {
  const day = parseWindow('01:00-05:00', 'window');
  assert.equal(nightAt(day, local(2026, 10, 24, 0, 59)), undefined);
  const inside = nightAt(day, local(2026, 10, 24, 3, 0));
  assert.equal(inside.night, '2026-10-24');
  assert.equal(inside.end.getTime() - inside.start.getTime(), 4 * 3600_000);
});

test('a window is as long as the wall clock says across a DST change', () => {
  // US clocks go back at 02:00 on 2026-11-01 and forward on 2027-03-14.
  const fallBack = nightAt(W, local(2026, 10, 31, 23, 30));
  assert.equal(fallBack.end.getTime() - fallBack.start.getTime(), 8 * 3600_000 + 3600_000);
  const springForward = nightAt(W, local(2027, 3, 13, 23, 30));
  assert.equal(springForward.end.getTime() - springForward.start.getTime(), 8 * 3600_000 - 3600_000);
});

test('the budget is cut to the window less the overrun margin, and not started under the floor', () => {
  const end = local(2026, 10, 24, 7, 0);
  assert.equal(clampBudget(6 * 3600, end, local(2026, 10, 23, 23, 0)), 6 * 3600);
  assert.equal(clampBudget(6 * 3600, end, local(2026, 10, 24, 3, 0)), 4 * 3600 - 15 * 60);
  assert.equal(clampBudget(6 * 3600, end, local(2026, 10, 24, 6, 40)), undefined);
  assert.equal(clampBudget(5 * 60, end, local(2026, 10, 23, 23, 0)), undefined);
});

test('config: codex, relative paths, bad windows and prompt dreams are refused at load', () => {
  const ok = { agents: { ava: { window: '23:00-07:00', experiments: [{ path: '/x/exp', budget: '2h30m', direction: 'minimize', maxExperiments: 5 }] } } };
  const parsed = parseDreamsConfig(ok);
  assert.deepEqual(parsed.agents.get('ava').experiments[0], { path: '/x/exp', budgetSeconds: 9000, direction: 'minimize', maxExperiments: 5 });
  assert.equal(parsed.agents.get('ava').maxPerNight, 1);
  const bad = (patch, pattern) => assert.throws(
    () => parseDreamsConfig({ agents: { ava: { ...ok.agents.ava, ...patch } } }),
    pattern,
  );
  bad({ experiments: [{ path: '/x/exp', agent: 'codex' }] }, /only be "claude"/);
  bad({ experiments: [{ path: 'exp' }] }, /absolute path/);
  bad({ window: '23:00' }, /HH:MM-HH:MM/);
  bad({ window: '07:00-07:00' }, /same time/);
  bad({ window: '25:00-07:00' }, /HH:MM-HH:MM/);
  bad({ maxPerNight: 0 }, /maxPerNight/);
  bad({ experiments: [] }, /at least one/);
  bad({ prompts: ['x'] }, /prompt dreams are not in this version/);
  bad({ experiments: [{ path: '/x/exp', direction: 'up' }] }, /direction/);
  assert.throws(() => parseDreamsConfig({ agents: { '../x': ok.agents.ava } }), /not an agent id/);
  assert.equal(parseDuration('90s', 'b'), 90);
  assert.throws(() => parseDuration('8 hours', 'b'), /duration/);
  assert.deepEqual(parseDreamsConfig({ readPaths: ['~/.pyenv'] }, { home: '/Users/me' }).readPaths, ['/Users/me/.pyenv']);
});

const line = (record) => `${JSON.stringify(record)}\n`;

test('the summary reads only what was appended after the claimed offset', () => {
  const before = line({ experiment_id: 0, description: 'baseline', score: 2.0, best_score: 2.0, improved: true })
    + line({ experiment_id: 1, description: 'old night', score: 1.5, best_score: 1.5, improved: true });
  const tonight = line({ experiment_id: 2, description: 'memoize', score: 1.2, best_score: 1.2, improved: true })
    + line({ experiment_id: 3, description: 'worse', score: 1.9, best_score: 1.2, improved: false })
    + line({ experiment_id: 4, description: 'broke it', score: null, best_score: 1.2, improved: false, error: 'x' })
    + 'not json\n';
  const buffer = Buffer.from(before + tonight);
  const summary = summarizeLog(buffer, Buffer.byteLength(before));
  assert.equal(summary.attempts, 3);
  assert.equal(summary.kept, 1);
  assert.equal(summary.notKept, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.startBest, 1.5);
  assert.equal(summary.endBest, 1.2);
  assert.deepEqual(summary.keptChanges, [{ experiment: 2, score: 1.2, description: 'memoize' }]);
});

test('a first night counts the baseline as the start, not as an attempt; long descriptions are capped', () => {
  const text = line({ experiment_id: 0, description: 'baseline', score: 3, best_score: 3, improved: true })
    + line({ experiment_id: 1, description: 'y'.repeat(500), score: 4, best_score: 4, improved: true });
  const summary = summarizeLog(Buffer.from(text), 0);
  assert.equal(summary.attempts, 1);
  assert.equal(summary.startBest, 3);
  assert.equal(summary.endBest, 4);
  assert.equal(summary.keptChanges[0].description.length, 201);
});

test('a log shortened during the night is read whole and says so; a missing one reports nothing recorded', () => {
  const summary = summarizeLog(Buffer.from(line({ experiment_id: 5, description: 'a', score: 1, best_score: 1, improved: false })), 10_000);
  assert.equal(summary.attempts, 1);
  assert.match(summary.notes[0], /shorter/);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dreams-'));
  assert.equal(summarizeFile(path.join(dir, 'experiments.jsonl'), 0).attempts, 0);
});

test('claims survive a reload, keep two weeks, and refuse to read a corrupt file as nothing spent', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dreams-'));
  const claims = createClaimStore(() => dir);
  for (let day = 1; day <= 16; day += 1) {
    claims.claim('ava', `2026-10-${String(day).padStart(2, '0')}`, { index: 0, path: '/x', offset: 0 });
  }
  claims.finish('ava', '2026-10-16', 0, { status: 'finished' });
  const again = createClaimStore(() => dir);
  assert.equal(Object.keys(again.nights('ava')).length, 14);
  assert.deepEqual(again.night('ava', '2026-10-16'), [{ index: 0, path: '/x', offset: 0, result: { status: 'finished' } }]);
  assert.deepEqual(again.night('ava', '2026-10-01'), []);
  writeFileSync(path.join(dir, 'claims', 'ava.json'), '{oops');
  assert.throws(() => again.night('ava', '2026-10-16'), /cannot read its claims/);
  assert.match(readFileSync(path.join(dir, 'claims', 'ava.json'), 'utf8'), /oops/);
});

test('claudePath must be named claude: the experimenter runs the literal command claude', () => {
  assert.throws(() => parseDreamsConfig({ claudePath: '/opt/wrap/claude-wrapper' }), /claudePath must name an executable called "claude"/);
  assert.equal(parseDreamsConfig({ claudePath: '/opt/homebrew/bin/claude' }).claudePath, '/opt/homebrew/bin/claude');
});

test('config: one experiment directory belongs to one agent, once', () => {
  const one = { window: '23:00-07:00', experiments: [{ path: '/x/exp' }] };
  assert.throws(
    () => parseDreamsConfig({ agents: { ava: one, bo: { window: '01:00-05:00', experiments: [{ path: '/x/other/../exp/' }] } } }),
    /\/x\/exp is listed for both ava and bo/,
  );
  assert.throws(
    () => parseDreamsConfig({ agents: { ava: { window: '23:00-07:00', experiments: [{ path: '/x/exp' }, { path: '/x/exp' }] } } }),
    /\/x\/exp is listed twice for ava/,
  );
});

test('the summary reads a bounded amount of a log the model can grow without limit', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dreams-'));
  const file = path.join(dir, 'experiments.jsonl');
  const old = line({ experiment_id: 1, description: 'old night', score: 1.5, best_score: 1.5, improved: true });
  const before = 'x'.repeat(5000) + '\n' + old;
  const tonight = Array.from({ length: 50 }, (_, i) => line({ experiment_id: i + 2, description: 'try', score: 1, best_score: 1, improved: true })).join('');
  writeFileSync(file, before + tonight);
  const one = Buffer.byteLength(line({ experiment_id: 2, description: 'try', score: 1, best_score: 1, improved: true }));
  const summary = summarizeFile(file, Buffer.byteLength(before), { limit: one * 10 + 5, tail: Buffer.byteLength(old) + 3 });
  assert.equal(summary.attempts, 10, 'only whole lines inside the limit count');
  assert.equal(summary.startBest, 1.5, 'the best before tonight still comes from the tail before the offset');
  assert.match(summary.notes.join(' '), /larger than/);

  const shrunk = summarizeFile(file, 10 * 1024 * 1024, { limit: one * 3 + 5 });
  assert.equal(shrunk.attempts, 3, 'a shortened log is read from its end, bounded too');
  assert.match(shrunk.notes.join(' '), /shorter/);
});

test('a home secret that is a link is denied at its target too, since the sandbox checks resolved paths', () => {
  const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'dreams-home-')));
  const elsewhere = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'dreams-keys-')));
  symlinkSync(elsewhere, path.join(home, '.ssh'));
  const denied = homeSecretPaths(home);
  assert.ok(denied.includes(path.join(home, '.ssh')), 'the link as named');
  assert.ok(denied.includes(elsewhere), 'and where it points');
  assert.ok(denied.includes(path.join(home, '.aws')), 'missing entries stay denied by name');
});
