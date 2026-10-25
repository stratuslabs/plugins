// SPIKE (Post-V1 #36): a thin AG-UI 1.0 emitter as a Stratus channel.
//
// An AG-UI client POSTs a RunAgentInput; this answers with a Server-Sent
// Events stream of AG-UI events for one Stratus turn. Stratus keeps the
// conversation itself, so only the newest user message is sent on: the
// AG-UI thread maps to one durable Stratus session.
//
// A gated call parks the turn: the run ends with an AG-UI interrupt outcome,
// the turn keeps waiting in the gateway, and a later run on the same thread
// whose `resume` entries answer it continues streaming the same turn.
//
// Not for production: loopback only, and an optional static token is the
// only gate, so whoever holds it is an approver. See README.md.

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
  const all = Array.isArray(input.messages) ? input.messages : [];
  // Kept as the client sent them, for a snapshot that has to list them.
  const messages = all.filter((message) => typeof message?.id === 'string');
  if (input.resume !== undefined) {
    return { threadId, runId, messages, resume: readResume(input.resume) };
  }
  const lastUser = [...all].reverse().find((message) => message?.role === 'user');
  const text = lastUser ? textOf(lastUser.content).trim() : '';
  if (!text) {
    throw Object.assign(new Error('messages must end with a user message that has text'), { status: 400 });
  }
  return { threadId, runId, messages, text };
};

const ANSWERS = new Set(['once', 'always', 'deny']);

/**
 * Reads AG-UI resume entries as Stratus approval answers. `cancelled` is a
 * denial; `resolved` needs `payload.answer` (once, always, deny) or
 * `payload.approved` (true is once, false is deny). Nothing is guessed: an
 * entry that says neither is refused rather than read as a yes.
 */
const readResume = (raw) => {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw Object.assign(new Error('resume must be a non-empty list of resume entries'), { status: 400 });
  }
  return raw.map((entry) => {
    const interruptId = typeof entry?.interruptId === 'string' ? entry.interruptId : '';
    if (!interruptId) {
      throw Object.assign(new Error('each resume entry needs an interruptId'), { status: 400 });
    }
    if (entry.status === 'cancelled') {
      return { interruptId, answer: 'deny' };
    }
    if (entry.status !== 'resolved') {
      throw Object.assign(new Error('resume status is "resolved" or "cancelled"'), { status: 400 });
    }
    const payload = entry.payload ?? {};
    if (ANSWERS.has(payload.answer)) {
      return { interruptId, answer: payload.answer };
    }
    if (typeof payload.approved === 'boolean') {
      return { interruptId, answer: payload.approved ? 'once' : 'deny' };
    }
    throw Object.assign(new Error('a resolved entry needs payload.answer (once, always, deny) or payload.approved'), { status: 400 });
  });
};

/** The AG-UI interrupt for one Stratus approval request. */
export const interruptFor = (event) => ({
  id: event.requestId,
  reason: 'tool_approval',
  message: `Allow ${event.call.toolName}${event.origin ? ` on ${event.origin}` : ''}?`,
  toolCallId: event.call.id,
  responseSchema: {
    type: 'object',
    properties: { answer: { enum: event.oneShot ? ['once', 'deny'] : ['once', 'always', 'deny'] } },
    required: ['answer'],
  },
  ...(event.expiresAt ? { expiresAt: event.expiresAt } : {}),
  metadata: { risk: event.risk, ...(event.always ? { always: event.always } : {}) },
});

/**
 * Maps the Stratus events of one session to AG-UI events, as they happen.
 * Returns the unsubscribe and a `finish` that closes an open message.
 */
export const streamSession = (bus, sessionId, emit, hooks = {}) => {
  let open; // the id of the text message being streamed, if any
  let openText = '';
  let streamedThisResponse = false;
  // What this run has added to the thread, in AG-UI form, the way
  // @ag-ui/client builds it from the events: what a snapshot must keep.
  let added = [];
  // Calls already shown: a gated call is shown when it is asked about,
  // because Stratus emits `tool.called` only after the answer.
  const shown = new Set();
  const showCall = (call) => {
    if (shown.has(call.id)) {
      return;
    }
    shown.add(call.id);
    emit({ type: 'TOOL_CALL_START', toolCallId: call.id, toolCallName: call.toolName });
    emit({ type: 'TOOL_CALL_ARGS', toolCallId: call.id, delta: JSON.stringify(call.input ?? {}) });
    emit({ type: 'TOOL_CALL_END', toolCallId: call.id });
    // With no parentMessageId, the client carries the call in an assistant
    // message of its own whose id is the call's.
    added.push({ id: call.id, role: 'assistant', toolCalls: [{ id: call.id, type: 'function', function: { name: call.toolName, arguments: JSON.stringify(call.input ?? {}) } }] });
  };
  const showResult = (toolCallId, content) => {
    const messageId = randomUUID();
    emit({ type: 'TOOL_CALL_RESULT', messageId, toolCallId, role: 'tool', content });
    added.push({ id: messageId, role: 'tool', toolCallId, content });
  };
  const startText = () => {
    open = randomUUID();
    openText = '';
    emit({ type: 'TEXT_MESSAGE_START', messageId: open, role: 'assistant' });
  };
  const addText = (text) => {
    openText += text;
    emit({ type: 'TEXT_MESSAGE_CONTENT', messageId: open, delta: text });
  };
  const endText = () => {
    if (open) {
      emit({ type: 'TEXT_MESSAGE_END', messageId: open });
      added.push({ id: open, role: 'assistant', content: openText });
      open = undefined;
    }
  };
  /**
   * The provider abandoned this response (a fallback took over, or it is
   * starting again). The client keeps what it was sent, so the partial is
   * closed and then retracted: a MESSAGES_SNAPSHOT drops every message
   * whose id it does not list. The snapshot is the run's input messages
   * plus what this run has completed, without the partial.
   */
  const retract = () => {
    streamedThisResponse = false;
    if (!open) {
      return;
    }
    emit({ type: 'TEXT_MESSAGE_END', messageId: open });
    open = undefined;
    const base = hooks.snapshotBase?.() ?? [];
    const ids = new Set(base.map((message) => message.id));
    emit({ type: 'MESSAGES_SNAPSHOT', messages: [...base, ...added.filter((message) => !ids.has(message.id))] });
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
      addText(event.delta.text);
      return;
    }
    if (event.type === 'provider.delta' && event.delta?.type === 'reset') {
      retract();
      return;
    }
    if (event.type === 'provider.response') {
      // A provider that does not stream says it all here: one message per
      // text part, the way Stratus stores them in the session.
      if (!streamedThisResponse) {
        for (const part of event.parts ?? []) {
          if (part.type === 'text' && part.text) {
            endText();
            startText();
            addText(part.text);
          }
        }
      }
      endText();
      streamedThisResponse = false;
      return;
    }
    if (event.type === 'tool.called') {
      endText();
      showCall(event.call);
      return;
    }
    if (event.type === 'tool.approval-requested') {
      endText();
      showCall(event.call);
      hooks.onApprovalRequested?.(event);
      return;
    }
    if (event.type === 'tool.approval-resolved') {
      hooks.onApprovalResolved?.(event);
      return;
    }
    if (event.type === 'tool.denied' && shown.has(event.call.id)) {
      showResult(event.call.id, JSON.stringify({ error: 'denied' }));
      return;
    }
    if (event.type === 'tool.completed') {
      const result = event.result;
      showResult(result.callId, result.ok ? JSON.stringify(result.output ?? null) : JSON.stringify({ error: result.error ?? 'failed' }));
    }
  });
  return {
    unsubscribe,
    finish: endText,
    /** A new run is attached: what earlier runs added is in its input. */
    newRun() {
      added = [];
    },
  };
};

export const createAguiAdapter = (config) => {
  const agentId = config.agent;
  const port = config.port ?? 4319;
  const token = config.token;
  let server;
  /**
   * Turns still alive, by AG-UI thread: the one being streamed, or one
   * parked on approvals after its run ended with an interrupt. At most one
   * per thread, since a thread is one Stratus session.
   */
  const live = new Map();

  const json = (res, status, body) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));

  /** Points a live turn's events at a new run's response. */
  const attach = (turn, res, run) => {
    const { runId } = run;
    turn.res = res;
    turn.runId = runId;
    turn.inputMessages = run.messages;
    turn.stream.newRun();
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    // A client that hangs up mid-run cancels the turn, as Stop does
    // elsewhere. One whose run ended in an interrupt has not hung up.
    res.on('close', () => {
      if (!res.writableFinished && turn.res === res) {
        turn.controller.abort(new Error('the AG-UI client disconnected'));
      }
    });
    sse(res, { type: 'RUN_STARTED', threadId: turn.threadId, runId, protocolVersion: AGUI_PROTOCOL_VERSION });
  };

  /** Ends the current run, if one is attached, with this final event. */
  const endRun = (turn, event) => {
    const res = turn.res;
    if (!res) {
      return;
    }
    turn.stream.finish();
    sse(res, event);
    turn.res = undefined;
    res.end();
  };

  const start = (gateway, run, res) => {
    const sessionId = `agui:${agentId}:${run.threadId}`;
    const turn = { threadId: run.threadId, sessionId, controller: new AbortController(), waiting: new Map(), res: undefined, runId: run.runId };
    live.set(run.threadId, turn);
    const emit = (event) => {
      if (turn.res) {
        sse(turn.res, event);
      }
    };
    let flush;
    turn.stream = streamSession(gateway.bus, sessionId, emit, {
      snapshotBase: () => turn.inputMessages,
      onApprovalRequested(event) {
        turn.waiting.set(event.requestId, interruptFor(event));
        // Gathered for a tick, so calls asked about together end the run
        // as one interrupt outcome.
        flush ??= setImmediate(() => {
          flush = undefined;
          if (turn.waiting.size > 0) {
            endRun(turn, { type: 'RUN_FINISHED', threadId: turn.threadId, runId: turn.runId, outcome: { type: 'interrupt', interrupts: [...turn.waiting.values()] } });
          }
        });
      },
      onApprovalResolved(event) {
        // Answered here, elsewhere (Slack, the dashboard), timed out or
        // cancelled: either way it is no longer something to resume.
        turn.waiting.delete(event.requestId);
      },
    });
    attach(turn, res, run);
    void (async () => {
      let final;
      try {
        const session = await gateway.dispatch({
          sessionId,
          agentId,
          userMessage: run.text,
          metadata: { channel: 'agui' },
          signal: turn.controller.signal,
        });
        final = session.status === 'failed'
          ? { type: 'RUN_ERROR', message: session.lastError ?? 'The turn failed.' }
          : { type: 'RUN_FINISHED', threadId: run.threadId, runId: turn.runId, outcome: { type: 'success' } };
      } catch (error) {
        final = { type: 'RUN_ERROR', message: error instanceof Error ? error.message : String(error) };
      } finally {
        turn.stream.unsubscribe();
        live.delete(run.threadId);
      }
      // A turn that ends with no run attached (an approval timed out after
      // its interrupt) has nobody to tell; the next run starts fresh.
      endRun(turn, final);
    })();
  };

  const resume = (gateway, run, res) => {
    const turn = live.get(run.threadId);
    if (!turn || turn.res) {
      json(res, 409, { error: turn ? 'this thread has a run in progress' : 'nothing on this thread is waiting to be resumed' });
      return;
    }
    const stale = run.resume.filter((entry) => !turn.waiting.has(entry.interruptId)).map((entry) => entry.interruptId);
    if (stale.length > 0) {
      json(res, 409, { error: 'not pending (answered elsewhere, expired, or never asked here)', interruptIds: stale });
      return;
    }
    attach(turn, res, run);
    for (const entry of run.resume) {
      // The gateway owns the request; a false here is one that settled
      // between the check above and now, and the turn goes on either way.
      gateway.resolveApproval({ requestId: entry.interruptId, answer: entry.answer, actor: 'agui' });
    }
  };

  const handle = async (gateway, req, res) => {
    if (req.method !== 'POST' || (req.url ?? '/').split('?')[0] !== '/') {
      json(res, 404, { error: 'POST / with a RunAgentInput' });
      return;
    }
    if (token && req.headers.authorization !== `Bearer ${token}`) {
      json(res, 401, { error: 'unauthorized' });
      return;
    }
    let run;
    try {
      run = readRunInput(await readBody(req));
    } catch (error) {
      json(res, error.status ?? 400, { error: error.message });
      return;
    }
    if (run.resume) {
      resume(gateway, run, res);
      return;
    }
    if (live.has(run.threadId)) {
      json(res, 409, { error: 'this thread has a run in progress or interrupts to resume' });
      return;
    }
    start(gateway, run, res);
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
      throw new Error('@stratusagent/plugin-agui needs "agent": the id of the agent AG-UI clients talk to.');
    }
    if (config.port !== undefined && (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535)) {
      throw new Error('@stratusagent/plugin-agui: "port" must be a TCP port number.');
    }
    if (!context.channels) {
      throw new Error('@stratusagent/plugin-agui needs a host that registers channels (PluginContext.channels).');
    }
    context.channels.register({ adapter: createAguiAdapter(config), agents: [config.agent] });
  },
});
