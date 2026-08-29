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

  get snapshot(): PublicWorldSnapshot {
    return this.snapshotValue;
  }

  subscribe(listener: SnapshotListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async connect(): Promise<void> {
    try {
      const response = await fetch("/api/snapshot", { headers: { Accept: "application/json" } });
      if (!response.ok || !response.headers.get("content-type")?.includes("application/json"))
        throw new Error("API unavailable");
      this.publish((await response.json()) as PublicWorldSnapshot);
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
    for (const listener of this.listeners) listener(snapshot);
  }

  private async refresh(): Promise<void> {
    try {
      const response = await fetch("/api/snapshot");
      if (response.ok) this.publish((await response.json()) as PublicWorldSnapshot);
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
