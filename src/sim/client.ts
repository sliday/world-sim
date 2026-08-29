import { advanceWorld, createInitialWorld, publicSnapshot } from "./engine";
import type { PublicWorldSnapshot, WorldState } from "./types";

type SnapshotListener = (snapshot: PublicWorldSnapshot) => void;

export class WorldClient {
  private snapshotValue: PublicWorldSnapshot = publicSnapshot(createInitialWorld(), false);
  private listeners = new Set<SnapshotListener>();
  private socket?: WebSocket;
  private fallbackState?: WorldState;
  private fallbackTimer?: number;
  private pollTimer?: number;
  private hasPublishedSnapshot = false;

  get snapshot(): PublicWorldSnapshot {
    return this.snapshotValue;
  }

  subscribe(listener: SnapshotListener): () => void {
    this.listeners.add(listener);
    if (this.hasPublishedSnapshot) listener(this.snapshotValue);
    return () => this.listeners.delete(listener);
  }

  async connect(): Promise<void> {
    try {
      this.publish(await this.fetchSnapshot());
      this.connectSocket();
      this.pollTimer = window.setInterval(() => void this.refresh(), 15_000);
    } catch {
      this.startFallback();
    }
  }

  dispose(): void {
    this.socket?.close();
    if (this.fallbackTimer) window.clearInterval(this.fallbackTimer);
    if (this.pollTimer) window.clearInterval(this.pollTimer);
  }

  private publish(snapshot: PublicWorldSnapshot): void {
    this.snapshotValue = snapshot;
    this.hasPublishedSnapshot = true;
    for (const listener of this.listeners) listener(snapshot);
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

  private async refresh(): Promise<void> {
    try {
      this.publish(await this.fetchSnapshot());
    } catch {
      // The last authoritative snapshot remains useful while the edge reconnects.
    }
  }

  private connectSocket(): void {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    this.socket = new WebSocket(`${protocol}//${location.host}/api/ws`);
    this.socket.addEventListener("message", (event) => {
      try {
        this.publish(JSON.parse(String(event.data)) as PublicWorldSnapshot);
      } catch {
        // Ignore malformed frames and let polling recover.
      }
    });
    this.socket.addEventListener("close", () => {
      window.setTimeout(() => this.connectSocket(), 4_000);
    });
  }

  private startFallback(): void {
    if (this.fallbackTimer) return;
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
