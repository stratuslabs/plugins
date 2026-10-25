// Run as a child process by gateway.test.js: connect, lose Discord, wait
// `delay` ms, close the bot; or, with `connecting`, give up after `delay` ms
// a connect whose gateway refuses. The process must then exit by itself.
import { connectBot } from '../../lib/gateway.js';
import { fakeDiscord } from '../fake-discord.js';

const delay = Number(process.argv[2] ?? 0);
if (process.argv[3] === 'connecting') {
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
