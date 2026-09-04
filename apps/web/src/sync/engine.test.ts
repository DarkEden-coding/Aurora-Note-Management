// These checks cover the sync engine's low-latency flush scheduling without IndexedDB or network access.
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const mocks = vi.hoisted(() => ({
  flushOutbox: vi.fn(async () => ({ sent: 0, remaining: 0, changes: [] })),
}));

vi.mock("../lib/http.js", () => ({
  api: vi.fn(async () => {
    throw new Error("offline");
  }),
}));
vi.mock("../lib/websocket.js", () => ({
  ReconnectingWebSocket: class {
    constructor(
      _url: string,
      private readonly handlers: { onState: (state: string) => void },
    ) {}

    connect(): void {
      this.handlers.onState("connecting");
    }

    reconnect(): void {}

    close(): void {
      this.handlers.onState("closed");
    }
  },
}));
vi.mock("./db.js", () => ({
  db: {
    outbox: { count: vi.fn(async () => 0) },
    conflicts: { count: vi.fn(async () => 0) },
  },
}));
vi.mock("./hydrate.js", () => ({
  hydrateRegion: vi.fn(),
}));
vi.mock("./outbox.js", () => ({
  flushOutbox: mocks.flushOutbox,
}));

let syncEngine: (typeof import("./engine.js"))["syncEngine"];

beforeAll(async () => {
  vi.stubGlobal("navigator", { onLine: true });
  vi.stubGlobal("location", { protocol: "https:", host: "aurora.test" });
  vi.stubGlobal("window", {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal("document", {
    visibilityState: "visible",
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  ({ syncEngine } = await import("./engine.js"));
});

beforeEach(async () => {
  vi.useFakeTimers();
  mocks.flushOutbox.mockResolvedValue({ sent: 0, remaining: 0, changes: [] });
  syncEngine.start();
  await vi.advanceTimersByTimeAsync(0);
  mocks.flushOutbox.mockClear();
});

afterEach(() => {
  syncEngine.stop();
  vi.useRealTimers();
});

describe("requestFlush", () => {
  it("coalesces a burst and syncs 100 ms after its last edit", async () => {
    syncEngine.requestFlush();
    await vi.advanceTimersByTimeAsync(75);
    syncEngine.requestFlush();

    await vi.advanceTimersByTimeAsync(99);
    expect(mocks.flushOutbox).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.flushOutbox).toHaveBeenCalledTimes(1);
  });

  it("runs again when an operation arrives during a flush", async () => {
    let finishFirstFlush: (() => void) | undefined;
    mocks.flushOutbox.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFirstFlush = () =>
            resolve({ sent: 1, remaining: 0, changes: [] });
        }),
    );

    syncEngine.requestFlush(0);
    await vi.advanceTimersByTimeAsync(0);
    syncEngine.requestFlush();
    finishFirstFlush?.();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.flushOutbox).toHaveBeenCalledTimes(2);
  });
});
