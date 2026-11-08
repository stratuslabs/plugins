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
export declare function applyConnectTimeoutPatch(): boolean;
