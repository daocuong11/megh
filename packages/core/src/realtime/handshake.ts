/**
 * Socket.IO handshake authentication: the app's `useAuthentication` handler
 * runs once per connection and its result becomes `socket.data.user`, which
 * `@PrivateChannel` listeners require.
 */
import { internalLogger } from "../observability/internal-logger";

/**
 * A request-shaped view of a Socket.IO handshake, so an authentication
 * handler written for HTTP requests works unchanged. Browsers can't set
 * headers on a WebSocket, so a token sent as `io({ auth: { token } })`
 * becomes `authorization: Bearer <token>` when no such header was sent.
 */
export function handshakeRequest(socket: any): Record<string, any> {
  const handshake = socket.handshake ?? {};
  const headers: Record<string, unknown> = { ...(handshake.headers ?? {}) };
  const token = handshake.auth?.token;
  if (!headers.authorization && typeof token === "string" && token !== "") {
    headers.authorization = /^bearer /i.test(token) ? token : `Bearer ${token}`;
  }
  return {
    method: "GET",
    url: handshake.url,
    headers,
    query: handshake.query ?? {},
    auth: handshake.auth ?? {},
    ip: handshake.address,
    socket,
  };
}

/**
 * Socket.IO middleware for `io.use()`. A handler that returns a user sets
 * `socket.data.user`; one that returns nothing lets the connection in as a
 * guest; one that throws refuses the connection, and the client gets a
 * `connect_error` with the message "Unauthorized".
 */
export function handshakeAuthentication(handler: {
  authenticate(request: any): unknown;
}) {
  return async (socket: any, next: (err?: Error) => void) => {
    try {
      const request = handshakeRequest(socket);
      const user = await handler.authenticate(request);
      if (user !== null && user !== undefined) {
        socket.data ??= {};
        socket.data.user = user;
      }
      next();
    } catch (err) {
      internalLogger("realtime").warn(
        { err },
        "Socket.IO handshake authentication failed",
      );
      next(new Error("Unauthorized"));
    }
  };
}
