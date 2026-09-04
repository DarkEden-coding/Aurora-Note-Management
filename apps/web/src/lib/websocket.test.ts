// These checks cover immediate WebSocket recovery without opening a real network connection.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReconnectingWebSocket } from "./websocket.js";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  close(): void {
    this.onclose?.();
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("ReconnectingWebSocket", () => {
  it("bypasses a pending backoff when reconnect is requested", async () => {
    const socket = new ReconnectingWebSocket("wss://aurora.test/sync/ws", {
      onMessage: vi.fn(),
      onState: vi.fn(),
    });
    socket.connect();
    FakeWebSocket.instances[0]!.onclose?.();

    socket.reconnect();
    expect(FakeWebSocket.instances).toHaveLength(2);

    await vi.runAllTimersAsync();
    expect(FakeWebSocket.instances).toHaveLength(2);
    socket.close();
  });

  it("replaces an apparently open connection after device wake", () => {
    const socket = new ReconnectingWebSocket("wss://aurora.test/sync/ws", {
      onMessage: vi.fn(),
      onState: vi.fn(),
    });
    socket.connect();

    socket.reconnect();

    expect(FakeWebSocket.instances).toHaveLength(2);
    socket.close();
  });
});
