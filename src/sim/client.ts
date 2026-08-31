import { advanceWorld, createInitialWorld, publicSnapshot } from "./engine";
import type { PublicWorldSnapshot, WorldState } from "./types";

export type WorldClientStatus = "loading" | "authoritative" | "stale" | "fallback";

type SnapshotListener = (snapshot: PublicWorldSnapshot) => void;
type StatusListener = (status: WorldClientStatus) => void;

export class WorldClient {
  private snapshotValue: PublicWorldSnapshot = publicSnapshot(createInitialWorld(), false);
  private statusValue: WorldClientStatus = "loading";
  private listeners = new Set<SnapshotListener>();
  private statusListeners = new Set<StatusListener>();
  private socket?: WebSocket;
  private fallbackState?: WorldState;
  private fallbackTimer?: number;
  private pollTimer?: number;
  private hasPublishedSnapshot = false;
  private disposed = false;

  get snapshot(): PublicWorldSnapshot {
    return this.snapshotValue;
  }

  get status(): WorldClientStatus {
    return this.statusValue;
  }

  subscribe(listener: SnapshotListener): () => void {
    this.listeners.add(listener);
    if (this.hasPublishedSnapshot) listener(this.snapshotValue);
    return () => this.listeners.delete(listener);
  }

  subscribeStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    listener(this.statusValue);
    return () => this.statusListeners.delete(listener);
  }

  async connect(): Promise<void> {
    this.disposed = false;
    this.ensurePolling();
    try {
      await this.loadAuthoritativeSnapshot();
    } catch {
      this.startFallback();
    }
  }

  async retry(): Promise<void> {
    this.setStatus("loading");
    try {
      await this.loadAuthoritativeSnapshot();
    } catch {
      this.startFallback();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.socket?.close();
    if (this.fallbackTimer) window.clearInterval(this.fallbackTimer);
    if (this.pollTimer) window.clearInterval(this.pollTimer);
  }

  private publish(snapshot: PublicWorldSnapshot): void {
    this.snapshotValue = snapshot;
    this.hasPublishedSnapshot = true;
    for (const listener of this.listeners) listener(snapshot);
  }

  private setStatus(status: WorldClientStatus): void {
    if (status === this.statusValue) return;
    this.statusValue = status;
    for (const listener of this.statusListeners) listener(status);
  }

  private async loadAuthoritativeSnapshot(): Promise<void> {
    const snapshot = await this.fetchSnapshot();
    this.stopFallback();
    this.publish(snapshot);
    this.setStatus("authoritative");
    this.connectSocket();
  }

  private async fetchSnapshot(): Promise<PublicWorldSnapshot> {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await fetch("/api/snapshot", {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok || !response.headers.get("content-type")?.includes("application/json"))
        throw new Error("API unavailable");
      return (await response.json()) as PublicWorldSnapshot;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  private ensurePolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = window.setInterval(() => void this.refresh(), 15_000);
  }

  private async refresh(): Promise<void> {
    try {
      await this.loadAuthoritativeSnapshot();
    } catch {
      if (this.statusValue === "authoritative") this.setStatus("stale");
    }
  }

  private connectSocket(): void {
    if (this.disposed) return;
    if (
      this.socket?.readyState === WebSocket.OPEN ||
      this.socket?.readyState === WebSocket.CONNECTING
    )
      return;
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    this.socket = new WebSocket(`${protocol}//${location.host}/api/ws`);
    this.socket.addEventListener("message", (event) => {
      try {
        this.publish(JSON.parse(String(event.data)) as PublicWorldSnapshot);
        this.setStatus("authoritative");
      } catch {
        // Ignore malformed frames and let polling recover.
      }
    });
    this.socket.addEventListener("close", () => {
      this.socket = undefined;
      if (this.disposed) return;
      if (this.statusValue === "authoritative") this.setStatus("stale");
      window.setTimeout(() => this.connectSocket(), 4_000);
    });
  }

  private stopFallback(): void {
    if (this.fallbackTimer) window.clearInterval(this.fallbackTimer);
    this.fallbackTimer = undefined;
    this.fallbackState = undefined;
  }

  private startFallback(): void {
    if (this.fallbackTimer) {
      this.setStatus("fallback");
      return;
    }
    this.setStatus("fallback");
    this.fallbackState = createInitialWorld(260826081);
    advanceWorld(this.fallbackState, 360);
    this.publish(publicSnapshot(this.fallbackState, false, "openrouter/free", true));
    this.fallbackTimer = window.setInterval(() => {
      if (!this.fallbackState) return;
      advanceWorld(this.fallbackState, 2);
      this.publish(publicSnapshot(this.fallbackState, false, "openrouter/free", true));
    }, 160);
  }
}
