// SPIKE (Post-V1 #36): a thin AG-UI 1.0 emitter as a Stratus channel.
//
// An AG-UI client POSTs a RunAgentInput; this answers with a Server-Sent
// Events stream of AG-UI events for one Stratus turn. Stratus keeps the
// conversation itself, so only the newest user message is sent on: the
// AG-UI thread maps to one durable Stratus session.
//
// Not for production: no interrupts (approvals) yet, loopback only, and an
// optional static token is the only gate. See README.md.

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

export const AGUI_PROTOCOL_VERSION = '1.0';
const MAX_BODY_BYTES = 1_000_000;

const sse = (res, event) => {
  res.write(`data: ${JSON.stringify({ ...event, timestamp: Date.now() })}\n\n`);
};

/** The text of an AG-UI message's content: a string, or the text parts of a list. */
const textOf = (content) => {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('\n');
  }
  return '';
};

const readBody = (req) => new Promise((resolve, reject) => {
  let size = 0;
  const chunks = [];
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      reject(Object.assign(new Error('request body too large'), { status: 413 }));
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  req.on('error', reject);
});

/**
 * Validates the parts of a RunAgentInput this emitter uses. Returns the
 * fields, or throws with a message fit for the client.
 */
export const readRunInput = (raw) => {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    throw Object.assign(new Error('body is not JSON'), { status: 400 });
  }
  const threadId = typeof input?.threadId === 'string' ? input.threadId : '';
  const runId = typeof input?.runId === 'string' ? input.runId : '';
  if (!threadId || !runId || !/^[A-Za-z0-9._:-]{1,128}$/.test(threadId)) {
    throw Object.assign(new Error('threadId and runId are required; threadId is letters, digits, and ._:- (at most 128)'), { status: 400 });
  }
  const messages = Array.isArray(input.messages) ? input.messages : [];
  const lastUser = [...messages].reverse().find((message) => message?.role === 'user');
  const text = lastUser ? textOf(lastUser.content).trim() : '';
  if (!text) {
    throw Object.assign(new Error('messages must end with a user message that has text'), { status: 400 });
  }
  return { threadId, runId, text };
};

/**
 * Maps the Stratus events of one session to AG-UI events, as they happen.
 * Returns the unsubscribe and a `finish` that closes an open message.
 */
export const streamSession = (bus, sessionId, emit) => {
  let open; // the id of the text message being streamed, if any
  let streamedThisResponse = false;
  const startText = () => {
    open = randomUUID();
    emit({ type: 'TEXT_MESSAGE_START', messageId: open, role: 'assistant' });
  };
  const endText = () => {
    if (open) {
      emit({ type: 'TEXT_MESSAGE_END', messageId: open });
      open = undefined;
    }
  };
  const unsubscribe = bus.subscribe((event) => {
    if (event.sessionId !== sessionId) {
      return;
    }
    if (event.type === 'provider.delta' && event.delta?.type === 'text' && event.delta.text) {
      if (!open) {
        startText();
      }
      streamedThisResponse = true;
      emit({ type: 'TEXT_MESSAGE_CONTENT', messageId: open, delta: event.delta.text });
      return;
    }
    if (event.type === 'provider.response') {
      // A provider that does not stream says it all here.
      if (!streamedThisResponse) {
        const text = (event.parts ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('');
        if (text) {
          startText();
          emit({ type: 'TEXT_MESSAGE_CONTENT', messageId: open, delta: text });
        }
      }
      endText();
      streamedThisResponse = false;
      return;
    }
    if (event.type === 'tool.called') {
      endText();
      emit({ type: 'TOOL_CALL_START', toolCallId: event.call.id, toolCallName: event.call.toolName });
      emit({ type: 'TOOL_CALL_ARGS', toolCallId: event.call.id, delta: JSON.stringify(event.call.input ?? {}) });
      emit({ type: 'TOOL_CALL_END', toolCallId: event.call.id });
      return;
    }
    if (event.type === 'tool.completed') {
      const result = event.result;
      emit({
        type: 'TOOL_CALL_RESULT',
        messageId: randomUUID(),
        toolCallId: result.callId,
        role: 'tool',
        content: result.ok ? JSON.stringify(result.output ?? null) : JSON.stringify({ error: result.error ?? 'failed' }),
      });
    }
  });
  return { unsubscribe, finish: endText };
};

export const createAguiAdapter = (config) => {
  const agentId = config.agent;
  const port = config.port ?? 4319;
  const token = config.token;
  let server;

  const handle = async (gateway, req, res) => {
    if (req.method !== 'POST' || (req.url ?? '/').split('?')[0] !== '/') {
      res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'POST / with a RunAgentInput' }));
      return;
    }
    if (token && req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    let run;
    try {
      run = readRunInput(await readBody(req));
    } catch (error) {
      res.writeHead(error.status ?? 400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: error.message }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const emit = (event) => sse(res, event);
    const sessionId = `agui:${agentId}:${run.threadId}`;
    const controller = new AbortController();
    // A client that hangs up cancels the turn, as Stop does elsewhere.
    res.on('close', () => {
      if (!res.writableFinished) {
        controller.abort(new Error('the AG-UI client disconnected'));
      }
    });
    emit({ type: 'RUN_STARTED', threadId: run.threadId, runId: run.runId, protocolVersion: AGUI_PROTOCOL_VERSION });
    const stream = streamSession(gateway.bus, sessionId, emit);
    try {
      const session = await gateway.dispatch({
        sessionId,
        agentId,
        userMessage: run.text,
        metadata: { channel: 'agui' },
        signal: controller.signal,
      });
      stream.finish();
      if (session.status === 'failed') {
        emit({ type: 'RUN_ERROR', message: session.lastError ?? 'The turn failed.' });
      } else {
        emit({ type: 'RUN_FINISHED', threadId: run.threadId, runId: run.runId, outcome: { type: 'success' } });
      }
    } catch (error) {
      stream.finish();
      emit({ type: 'RUN_ERROR', message: error instanceof Error ? error.message : String(error) });
    } finally {
      stream.unsubscribe();
      res.end();
    }
  };

  return {
    name: 'agui',
    get port() {
      return server?.address()?.port;
    },
    async start(gateway) {
      server = createServer((req, res) => {
        handle(gateway, req, res).catch((error) => {
          if (!res.headersSent) {
            res.writeHead(500).end();
          } else {
            res.end();
          }
          gateway.warn?.(`agui: ${error instanceof Error ? error.message : String(error)}`);
        });
      });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        // Loopback only: this spike has no real authentication.
        server.listen(port, '127.0.0.1', () => resolve());
      });
    },
    async stop() {
      if (server) {
        await new Promise((resolve) => server.close(() => resolve()));
        server = undefined;
      }
    },
  };
};

export const createPlugin = (config = {}) => ({
  name: 'agui',
  setup(context) {
    if (typeof config.agent !== 'string' || !config.agent) {
      throw new Error('stratus-plugin-agui needs "agent": the id of the agent AG-UI clients talk to.');
    }
    if (config.port !== undefined && (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535)) {
      throw new Error('stratus-plugin-agui: "port" must be a TCP port number.');
    }
    if (!context.channels) {
      throw new Error('stratus-plugin-agui needs a host that registers channels (PluginContext.channels).');
    }
    context.channels.register({ adapter: createAguiAdapter(config), agents: [config.agent] });
  },
});
