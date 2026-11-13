import test from 'node:test';
import assert from 'node:assert/strict';

import { readUpkeepConfig } from '../lib/config.js';
import { nightIn, parseWindow } from '../lib/window.js';

const read = (config) => readUpkeepConfig(config, { defaultTimeZone: 'UTC' });

test('only the agents listed under "agents" are enrolled, and none listed means none', () => {
  assert.equal(read({}).size, 0);
  assert.equal(read({ agents: {} }).size, 0);
  assert.deepEqual([...read({ agents: { atlas: {}, blair: {} } }).keys()], ['atlas', 'blair']);
});

test('an enrolled agent with no settings saves in shadow mode after 30 quiet minutes, on its own model, with no tidy', () => {
  const atlas = read({ agents: { atlas: {} } }).get('atlas');
  assert.deepEqual(atlas, { mode: 'shadow', save: { quietMinutes: 30, scheduled: false } });
});

test('top-level settings are defaults; an agent block overrides them key by key, inside save and tidy too', () => {
  const agents = read({
    model: 'claude-haiku-4-5',
    save: { quietMinutes: 20, from: ['public'] },
    tidy: { window: '03:00-05:00', timeZone: 'America/New_York' },
    agents: {
      atlas: { mode: 'write', save: { quietMinutes: 45 } },
      blair: { model: 'claude-sonnet-4-5', tidy: { maxGroupsPerNight: 0 } },
    },
  });
  assert.deepEqual(agents.get('atlas'), {
    model: 'claude-haiku-4-5',
    mode: 'write',
    save: { quietMinutes: 45, from: ['public'], scheduled: false },
    tidy: { window: { start: 180, end: 300, text: '03:00-05:00' }, timeZone: 'America/New_York', maxGroupsPerNight: 10 },
  });
  // maxGroupsPerNight 0 turns tidy off for that agent alone.
  assert.deepEqual(agents.get('blair'), {
    model: 'claude-sonnet-4-5',
    mode: 'shadow',
    save: { quietMinutes: 20, from: ['public'], scheduled: false },
  });
});

test('save.from may be empty: then only the operator\'s own sessions, which have no channel, are read', () => {
  assert.deepEqual(read({ agents: { atlas: { save: { from: [] } } } }).get('atlas').save.from, []);
});

test('a tidy window with no time zone uses the host\'s', () => {
  const agents = readUpkeepConfig({ agents: { atlas: { tidy: { window: '23:30-01:00' } } } }, { defaultTimeZone: 'Europe/Berlin' });
  assert.equal(agents.get('atlas').tidy.timeZone, 'Europe/Berlin');
});

test('settings the loader cannot check are refused, naming the agent and the setting', () => {
  const cases = [
    [{ agents: { atlas: { mode: 'loud' } } }, /agents\.atlas\.mode/],
    [{ agents: { atlas: { model: '  ' } } }, /agents\.atlas\.model/],
    [{ agents: { atlas: { save: { quietMinutes: 0 } } } }, /agents\.atlas\.save\.quietMinutes/],
    [{ agents: { atlas: { save: { quietMinutes: Number.NaN } } } }, /agents\.atlas\.save\.quietMinutes/],
    [{ agents: { atlas: { save: { from: ['public', 'everywhere'] } } } }, /agents\.atlas\.save\.from/],
    [{ agents: { atlas: { save: { scheduled: 'yes' } } } }, /agents\.atlas\.save\.scheduled/],
    [{ agents: { atlas: { tidy: { window: '3am-5am' } } } }, /agents\.atlas\.tidy\.window/],
    [{ agents: { atlas: { tidy: { window: '03:00-03:00' } } } }, /agents\.atlas\.tidy\.window/],
    [{ agents: { atlas: { tidy: { window: '03:00-05:00', timeZone: 'Mars/Olympus' } } } }, /agents\.atlas\.tidy\.timeZone/],
    [{ agents: { atlas: { tidy: { window: '03:00-05:00', maxGroupsPerNight: 2.5 } } } }, /agents\.atlas\.tidy\.maxGroupsPerNight/],
    [{ agents: { atlas: { tidy: { maxGroupsPerNight: 3 } } } }, /agents\.atlas\.tidy\.window/],
    [{ agents: ['atlas'] }, /"agents"/],
    [{ agents: { atlas: 'on' } }, /agents\.atlas/],
  ];
  for (const [config, pattern] of cases) {
    assert.throws(() => read(config), pattern, JSON.stringify(config));
  }
});

test('parseWindow reads HH:MM-HH:MM as minutes after midnight', () => {
  assert.deepEqual(parseWindow('03:00-05:30'), { start: 180, end: 330, text: '03:00-05:30' });
  assert.deepEqual(parseWindow('23:00-01:00'), { start: 1380, end: 60, text: '23:00-01:00' });
  assert.equal(parseWindow('24:00-01:00'), undefined);
  assert.equal(parseWindow('3:00-5:00'), undefined);
  assert.equal(parseWindow('03:00-03:00'), undefined);
});

test('a night is named by the date, in the window\'s time zone, that its window opened on', () => {
  const sameDay = parseWindow('03:00-05:00');
  const zone = 'America/New_York';
  // 07:30Z on Nov 3 is 02:30 EST: before the window.
  assert.equal(nightIn(sameDay, zone, new Date('2026-11-03T07:30:00Z')), undefined);
  // 08:10Z is 03:10 EST: inside, the night of Nov 3.
  assert.equal(nightIn(sameDay, zone, new Date('2026-11-03T08:10:00Z')), '2026-11-03');
  // 10:00Z is 05:00 EST: the end is outside.
  assert.equal(nightIn(sameDay, zone, new Date('2026-11-03T10:00:00Z')), undefined);

  const acrossMidnight = parseWindow('23:00-01:00');
  // 04:30Z Nov 3 is 23:30 EST Nov 2: the night of Nov 2.
  assert.equal(nightIn(acrossMidnight, zone, new Date('2026-11-03T04:30:00Z')), '2026-11-02');
  // 05:30Z Nov 3 is 00:30 EST Nov 3: still the night that opened Nov 2.
  assert.equal(nightIn(acrossMidnight, zone, new Date('2026-11-03T05:30:00Z')), '2026-11-02');
  // A night that opened on the last day of a month.
  assert.equal(nightIn(acrossMidnight, zone, new Date('2026-12-01T05:30:00Z')), '2026-11-30');
  // 06:30Z is 01:30 EST: past the end.
  assert.equal(nightIn(acrossMidnight, zone, new Date('2026-11-03T06:30:00Z')), undefined);
  // The same instant in UTC is a different wall clock.
  assert.equal(nightIn(sameDay, 'UTC', new Date('2026-11-03T03:10:00Z')), '2026-11-03');
});
