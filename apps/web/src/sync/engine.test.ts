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
  flushOutbox: vi.fn(async () => undefined),
  socketConnect: vi.fn(),
  socketClose: vi.fn(),
  socketHandlers: null as {
    onState: (state: string) => void;
    onMessage: (data: unknown) => void;
  } | null,
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
      private readonly handlers: {
        onState: (state: string) => void;
        onMessage: (data: unknown) => void;
      },
    ) {
      mocks.socketHandlers = handlers;
    }

    connect(): void {
      mocks.socketConnect();
      this.handlers.onState("connecting");
    }

    reconnect(): void {}

    close(): void {
      mocks.socketClose();
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
let visibilityListener: (() => void) | null = null;

function setVisibility(state: "visible" | "hidden"): void {
  (document as { visibilityState: string }).visibilityState = state;
  visibilityListener?.();
}

beforeAll(async () => {
  vi.stubGlobal("navigator", { onLine: true });
  vi.stubGlobal("location", { protocol: "https:", host: "aurora.test" });
  vi.stubGlobal("window", {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal("document", {
    visibilityState: "visible",
    addEventListener: vi.fn(
      (_type: string, listener: () => void) => (visibilityListener = listener),
    ),
    removeEventListener: vi.fn(),
  });
  ({ syncEngine } = await import("./engine.js"));
});

beforeEach(async () => {
  vi.useFakeTimers();
  mocks.flushOutbox.mockResolvedValue(undefined);
  syncEngine.start();
  await vi.advanceTimersByTimeAsync(0);
  mocks.flushOutbox.mockClear();
  mocks.socketConnect.mockClear();
  mocks.socketClose.mockClear();
});

afterEach(() => {
  (document as { visibilityState: string }).visibilityState = "visible";
  syncEngine.stop();
  vi.useRealTimers();
});

describe("library broadcasts", () => {
  it("notifies library listeners when metadata changes", async () => {
    const listener = vi.fn();
    const unsubscribe = syncEngine.onLibraryChange(listener);

    mocks.socketHandlers?.onMessage({
      type: "library-changed",
      serverTimestamp: new Date().toISOString(),
    });
    await Promise.resolve();

    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
  });
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
          finishFirstFlush = () => resolve(undefined);
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

describe("background pause", () => {
  it("sends pending edits once, then goes quiet while hidden", async () => {
    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.flushOutbox).toHaveBeenCalledTimes(1);
    expect(mocks.socketClose).toHaveBeenCalledOnce();

    syncEngine.requestFlush(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.flushOutbox).toHaveBeenCalledTimes(1);
  });

  it("reconnects and syncs when Aurora is shown again", async () => {
    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(0);
    mocks.flushOutbox.mockClear();

    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.socketConnect).toHaveBeenCalledOnce();
    expect(mocks.flushOutbox).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(mocks.flushOutbox).toHaveBeenCalledTimes(2);
  });
});
