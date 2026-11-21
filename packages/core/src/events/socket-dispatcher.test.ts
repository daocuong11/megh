import "reflect-metadata";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Container } from "../di";
import { SocketIoServer } from "../realtime/websocket";
import { SocketEventDispatcher } from "./socket-dispatcher";

function fakeIo() {
  const emit = vi.fn();
  const io = { emit, to: vi.fn(() => ({ emit })) };
  vi.spyOn(Container, "get").mockImplementation(((token: unknown) =>
    token === SocketIoServer ? io : { getSocket: () => undefined }) as any);
  return { io, emit };
}

describe("SocketEventDispatcher transports", () => {
  afterEach(() => vi.restoreAllMocks());

  it("emits over Socket.IO by default", async () => {
    const { emit } = fakeIo();
    await new SocketEventDispatcher().dispatch("chat", { text: "hi" });
    expect(emit).toHaveBeenCalledWith("chat", { text: "hi" });
  });

  it.each(["kafka", "rabbitmq"])(
    "throws for the unimplemented %s transport instead of ignoring it",
    async (transport) => {
      const { emit } = fakeIo();
      await expect(
        new SocketEventDispatcher().dispatch(
          "chat",
          {},
          {
            transports: ["socket", transport as any],
            retry: 3,
            retryDelay: 10_000,
          },
        ),
      ).rejects.toThrow(`Transport "${transport}" is not implemented`);
      // Nothing is emitted, and the error is not retried (it would time out).
      expect(emit).not.toHaveBeenCalled();
    },
  );
});
