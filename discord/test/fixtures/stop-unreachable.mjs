// Run as a child process by gateway.test.js: connect, lose Discord, wait
// `delay` ms, close the bot. The process must then exit by itself.
import { connectBot } from '../../lib/gateway.js';
import { fakeDiscord } from '../fake-discord.js';

const delay = Number(process.argv[2] ?? 0);
const discord = await fakeDiscord();
const bot = await connectBot({ token: 'bot-token-a', api: discord.api, onMessage: () => {} });
await discord.close();
await new Promise((resolve) => setTimeout(resolve, delay));
await bot.close();
process.stdout.write('closed\n');
