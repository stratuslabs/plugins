// Run as a child process by gateway.test.js: connect, lose Discord, wait
// `delay` ms, close the bot; or, with `connecting`, give up after `delay` ms
// a connect whose gateway refuses; or, with `held`, give up a connect whose
// gateway socket is still opening and only fails afterwards. The process
// must then exit by itself, with code 0.
import net from 'node:net';
import { connectBot } from '../../lib/gateway.js';
import { fakeDiscord } from '../fake-discord.js';

const delay = Number(process.argv[2] ?? 0);
if (process.argv[3] === 'held') {
  // The gateway takes the TCP connection and never answers the upgrade, so
  // the shard is still opening when connect() is given up. The socket fails
  // only afterwards, the way a connection to an unreachable Discord times out.
  const held = [];
  const hold = net.createServer((socket) => held.push(socket));
  await new Promise((resolve) => hold.listen(0, '127.0.0.1', resolve));
  const opening = new Promise((resolve) => hold.once('connection', resolve));
  const discord = await fakeDiscord({ gatewayUrl: `ws://127.0.0.1:${hold.address().port}/gw` });
  const controller = new AbortController();
  const attempt = connectBot({ token: 'bot-token-a', api: discord.api, onMessage: () => {}, signal: controller.signal })
    .catch((error) => process.stdout.write(`${error.message}\n`));
  await opening;
  controller.abort(new Error('given up'));
  await attempt;
  await new Promise((resolve) => setTimeout(resolve, delay));
  for (const socket of held) socket.destroy();
  hold.close();
  await discord.close();
} else if (process.argv[3] === 'connecting') {
  // REST answers, the gateway it names refuses: connect() never gets READY.
  const discord = await fakeDiscord({ gatewayUrl: 'ws://127.0.0.1:9/gw' });
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error('given up')), delay);
  await connectBot({ token: 'bot-token-a', api: discord.api, onMessage: () => {}, signal: controller.signal }).catch((error) => process.stdout.write(`${error.message}\n`));
  await discord.close();
} else {
  const discord = await fakeDiscord();
  const bot = await connectBot({ token: 'bot-token-a', api: discord.api, onMessage: () => {} });
  await discord.close();
  await new Promise((resolve) => setTimeout(resolve, delay));
  await bot.close();
  process.stdout.write('closed\n');
}
