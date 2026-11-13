"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.applyConnectTimeoutPatch = applyConnectTimeoutPatch;
/**
 * Default connection attempt timeout, in milliseconds.
 *
 * Matches the value of `MIN_CONNECT_TIMEOUT` — the shortest deadline a
 * connection attempt may be given — from the gRPC connection backoff spec:
 * https://github.com/grpc/grpc/blob/master/doc/connection-backoff.md
 */
const defaultConnectTimeoutMs = 20000;
/**
 * Channel option that overrides the connection attempt timeout, in
 * milliseconds. Set to `0` to disable the timeout.
 *
 * This is the channel argument that other gRPC implementations use for
 * `MIN_CONNECT_TIMEOUT`, despite what its name suggests. C-core documents
 * `GRPC_ARG_MIN_RECONNECT_BACKOFF_MS` as "the minimum time between subsequent
 * connection attempts" referring to `MIN_CONNECT_TIMEOUT`, and parses it into
 * the deadline it gives a connection attempt; the Objective-C wrapper maps its
 * `connectMinTimeout` option onto it; grpc-go has the equivalent
 * `MinConnectTimeout` in `ConnectParams`. grpc-js accepts the option but never
 * reads it.
 */
const connectTimeoutOption = 'grpc.min_reconnect_backoff_ms';
const patchedFlag = Symbol.for('nice-grpc.connectTimeoutPatch');
const pendingSockets = new WeakMap();
/**
 * Enforces a timeout on connection attempts made by grpc-js.
 *
 * grpc-js has no timeout on establishing a connection: its connector awaits the
 * server's HTTP/2 SETTINGS frame with no timer. If a peer accepts the TCP
 * connection but never sends SETTINGS — a half-open network path, e.g. a broken
 * middlebox flow — the connection attempt never settles. The subchannel stays in
 * CONNECTING forever, and since backoff is only armed when an attempt *fails*,
 * no retry is ever scheduled: the channel is dead until it is recreated. Calls
 * without a deadline hang indefinitely, and keepalive does not help because it
 * only applies to an established transport.
 *
 * The gRPC spec has connection attempts bounded by a deadline, of at least
 * `MIN_CONNECT_TIMEOUT` (20 seconds), after which the attempt fails and backoff
 * retries it. This patch adds such a deadline, covering the whole attempt: TCP
 * connect, TLS handshake and waiting for SETTINGS.
 *
 * Reported upstream: https://github.com/grpc/grpc-node/issues/2785
 *
 * The patch reaches into grpc-js internals, so it is applied defensively: if the
 * internals are not shaped as expected (e.g. after an upgrade), it silently does
 * nothing rather than breaking the library.
 *
 * @returns whether the patch was applied.
 */
function applyConnectTimeoutPatch() {
    let connectorPrototype;
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const transport = require('@grpc/grpc-js/build/src/transport');
        connectorPrototype = transport?.Http2SubchannelConnector?.prototype;
    }
    catch {
        return false;
    }
    if (connectorPrototype == null ||
        typeof connectorPrototype.connect !== 'function' ||
        typeof connectorPrototype.tcpConnect !== 'function') {
        return false;
    }
    const flagged = connectorPrototype;
    if (flagged[patchedFlag]) {
        return true;
    }
    const originalConnect = connectorPrototype.connect;
    const originalTcpConnect = connectorPrototype.tcpConnect;
    // Track the sockets opened by an attempt, so that a timed out attempt can be
    // torn down instead of being left dangling.
    connectorPrototype.tcpConnect = function tcpConnect(address, options) {
        return originalTcpConnect.call(this, address, options).then(socket => {
            let sockets = pendingSockets.get(this);
            if (sockets == null) {
                sockets = new Set();
                pendingSockets.set(this, sockets);
            }
            sockets.add(socket);
            socket.once('close', () => sockets.delete(socket));
            return socket;
        });
    };
    connectorPrototype.connect = function connect(address, secureConnector, options) {
        const timeoutMs = options?.[connectTimeoutOption] ?? defaultConnectTimeoutMs;
        const attempt = originalConnect.call(this, address, secureConnector, options);
        if (!(timeoutMs > 0)) {
            return attempt;
        }
        let timedOut = false;
        // If the transport arrives after we gave up on it, shut it down: nothing is
        // going to use it.
        attempt.then(transport => {
            if (timedOut) {
                transport?.shutdown?.();
            }
        }, () => { });
        let timer;
        const timeout = new Promise((resolve, reject) => {
            timer = setTimeout(() => {
                timedOut = true;
                const sockets = pendingSockets.get(this);
                if (sockets != null) {
                    for (const socket of sockets) {
                        socket.destroy();
                    }
                    sockets.clear();
                }
                reject(new Error(`Connection attempt timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            timer.unref?.();
        });
        return Promise.race([attempt, timeout]).finally(() => {
            clearTimeout(timer);
        });
    };
    flagged[patchedFlag] = true;
    return true;
}
//# sourceMappingURL=connectTimeoutPatch.js.map