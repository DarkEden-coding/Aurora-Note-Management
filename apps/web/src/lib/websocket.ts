// This module is Aurora's reconnecting WebSocket client: it maintains the /sync/ws subscription across drops with capped exponential backoff and emits parsed JSON messages plus connection state.
export type SocketState = "connecting" | "open" | "closed";

export interface ReconnectingSocketHandlers {
  onMessage: (data: unknown) => void;
  onState: (state: SocketState) => void;
}

export class ReconnectingWebSocket {
  private socket: WebSocket | null = null;
  private attempt = 0;
  private closedByUser = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly url: string,
    private readonly handlers: ReconnectingSocketHandlers,
    private readonly maxBackoffMs = 30_000,
  ) {}

  connect(): void {
    this.closedByUser = false;
    this.open();
  }

  /** Replace the current connection immediately, bypassing reconnect backoff. */
  reconnect(): void {
    if (this.closedByUser) return;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.socket) {
      this.socket.onclose = null;
      this.socket.close();
      this.socket = null;
    }
    this.open();
  }

  close(): void {
    this.closedByUser = true;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.socket?.close();
    this.socket = null;
    this.handlers.onState("closed");
  }

  private open(): void {
    if (this.closedByUser) return;
    this.handlers.onState("connecting");
    const socket = new WebSocket(this.url);
    this.socket = socket;

    socket.onopen = () => {
      this.attempt = 0;
      this.handlers.onState("open");
    };

    socket.onmessage = (event) => {
      try {
        this.handlers.onMessage(JSON.parse(String(event.data)));
      } catch {
        // Malformed frame: drop it rather than killing the connection.
      }
    };

    socket.onclose = () => {
      this.socket = null;
      if (this.closedByUser) {
        this.handlers.onState("closed");
        return;
      }
      this.scheduleReconnect();
    };

    socket.onerror = () => {
      socket.close();
    };
  }

  private scheduleReconnect(): void {
    this.attempt += 1;
    // Capped exponential backoff with jitter so a server restart does not thundering-herd clients.
    const base = Math.min(
      1000 * 2 ** Math.min(this.attempt - 1, 10),
      this.maxBackoffMs,
    );
    const delay = base / 2 + Math.random() * (base / 2);
    this.retryTimer = setTimeout(() => this.open(), delay);
  }
}
