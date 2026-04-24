/**
 * Realtime client wrapper.
 *
 * Uses PieSocket's free public WebSocket broker as a hosted alternative to a
 * self-hosted Socket.IO server. The API surface intentionally mirrors a
 * minimal Socket.IO client: connect / on / emit / disconnect, with an event
 * envelope { event, payload, from, id }.
 *
 * Override the endpoint by setting VITE_WS_URL in your environment.
 * Default channel is a demo channel — change VITE_WS_CHANNEL for a private room.
 */

type Listener = (payload: any, from?: string) => void;

export interface ChatMessage {
  id: string;
  user: string;
  text: string;
  ts: number;
}

export interface RealtimeUser {
  id: string;
  name: string;
}

const DEFAULT_KEY = "VCXCEuvhGcBDP7XXXXXXXXXXXXXXXXXXXXXXXXXX"; // public demo key
const WS_BASE =
  (import.meta.env.VITE_WS_URL as string | undefined) ||
  "wss://free.blr2.piesocket.com/v3/";
const CHANNEL =
  (import.meta.env.VITE_WS_CHANNEL as string | undefined) || "lovable-chat-demo";
const API_KEY = (import.meta.env.VITE_WS_KEY as string | undefined) || DEFAULT_KEY;

function buildUrl() {
  // PieSocket URL pattern: wss://<region>/v3/<channel>?api_key=<key>&notify_self=1
  return `${WS_BASE}${encodeURIComponent(CHANNEL)}?api_key=${encodeURIComponent(
    API_KEY,
  )}&notify_self=0`;
}

export class RealtimeClient {
  private ws: WebSocket | null = null;
  private listeners = new Map<string, Set<Listener>>();
  private statusListeners = new Set<(s: "connecting" | "open" | "closed") => void>();
  private queue: string[] = [];
  public id: string;
  public name: string;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect = true;

  constructor(name: string) {
    this.name = name;
    this.id =
      (typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2)) as string;
  }

  connect() {
    this.shouldReconnect = true;
    this.openSocket();
  }

  private openSocket() {
    this.notifyStatus("connecting");
    try {
      this.ws = new WebSocket(buildUrl());
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.notifyStatus("open");
      // Flush queued messages
      while (this.queue.length && this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(this.queue.shift()!);
      }
      // Announce presence
      this.emit("hello", { id: this.id, name: this.name });
      this.emit("who", {});
    };

    this.ws.onmessage = (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.data);
      } catch {
        return;
      }
      if (!msg || typeof msg !== "object" || !msg.event) return;
      // Ignore our own echoes (we set notify_self=0, but be defensive)
      if (msg.from === this.id) return;
      const set = this.listeners.get(msg.event);
      if (set) set.forEach((fn) => fn(msg.payload, msg.from));
    };

    this.ws.onclose = () => {
      this.notifyStatus("closed");
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      try {
        this.ws?.close();
      } catch {
        /* noop */
      }
    };
  }

  private scheduleReconnect() {
    if (!this.shouldReconnect) return;
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, 2000);
  }

  emit(event: string, payload: any) {
    const data = JSON.stringify({ event, payload, from: this.id, name: this.name });
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    } else {
      this.queue.push(data);
    }
  }

  on(event: string, fn: Listener) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(fn);
    return () => this.off(event, fn);
  }

  off(event: string, fn: Listener) {
    this.listeners.get(event)?.delete(fn);
  }

  onStatus(fn: (s: "connecting" | "open" | "closed") => void) {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  private notifyStatus(s: "connecting" | "open" | "closed") {
    this.statusListeners.forEach((fn) => fn(s));
  }

  disconnect() {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      this.emit("bye", { id: this.id, name: this.name });
      this.ws?.close();
    } catch {
      /* noop */
    }
    this.ws = null;
  }
}