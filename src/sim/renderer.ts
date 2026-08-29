import p5 from "p5";
import { generateBotAppearance, type BotAppearance } from "./bot-appearance";
import {
  clampOverlayAnchor,
  easeToward,
  fitOverlayText,
  normalizeSettled,
  wrappedTarget,
} from "./motion";
import type {
  Agent,
  Artifact,
  PublicWorldSnapshot,
  Station,
  TerrainKind,
  Tile,
  Vec2,
} from "./types";
import { WORLD_HEIGHT, WORLD_WIDTH } from "./types";

const CELL = 16;
const MAP_WIDTH = WORLD_WIDTH * CELL;
const MAP_HEIGHT = WORLD_HEIGHT * CELL;

const palette: Record<TerrainKind, string> = {
  "deep-water": "#112f3f",
  tidal: "#2d6870",
  plain: "#b6c68a",
  fungus: "#7d9671",
  mineral: "#8d7a6c",
  cellulose: "#c4ad70",
  chitin: "#b77b66",
};

const materialColor: Record<Artifact["material"], string> = {
  water: "#7de1db",
  fungus: "#a8dc78",
  mineral: "#ffd272",
  cellulose: "#f1e09f",
  chitin: "#ff8c73",
};

const hackerNoonGlyph = {
  rain: "\uf198",
  cog: "\uf19c",
  grid: "\uf1cf",
  search: "\uf215",
  shapes: "\uf217",
  fork: "\uf1ca",
} as const;

const materialRune: Record<Artifact["material"], string> = {
  water: "≈",
  fungus: "♣",
  mineral: "◆",
  cellulose: "╫",
  chitin: "⌬",
};

const terrainRune: Partial<Record<TerrainKind, string>> = {
  tidal: materialRune.water,
  fungus: materialRune.fungus,
  mineral: materialRune.mineral,
  cellulose: materialRune.cellulose,
  chitin: materialRune.chitin,
};

interface Camera {
  x: number;
  y: number;
  zoom: number;
  targetX: number;
  targetY: number;
  lastFocusTick: number;
  manualUntil: number;
}

interface VisualAgentPosition extends Vec2 {
  targetX: number;
  targetY: number;
}

function wrappedDelta(from: number, to: number, size: number): number {
  const direct = to - from;
  if (Math.abs(direct) <= size / 2) return direct;
  return direct > 0 ? direct - size : direct + size;
}

export function createWorldSketch(
  host: HTMLElement,
  initial: PublicWorldSnapshot,
  onAgentSelect?: (agentId: string | null) => void,
): {
  update: (snapshot: PublicWorldSnapshot) => void;
  selectAgent: (agentId: string | null) => void;
  remove: () => void;
} {
  let world = initial;
  let terrainLayer: p5.Graphics | undefined;
  let worldCanvas: HTMLCanvasElement | undefined;
  let selectedAgentId: string | null = null;
  const visualAgentPositions = new Map<string, VisualAgentPosition>();
  const camera: Camera = {
    x: MAP_WIDTH * 0.52,
    y: MAP_HEIGHT * 0.48,
    zoom: 1,
    targetX: MAP_WIDTH * 0.52,
    targetY: MAP_HEIGHT * 0.48,
    lastFocusTick: -1,
    manualUntil: 0,
  };
  syncVisualAgentTargets(initial, visualAgentPositions, true);

  const sketch = new p5((p) => {
    p.setup = () => {
      const canvas = p.createCanvas(host.clientWidth, host.clientHeight);
      canvas.parent(host);
      worldCanvas = canvas.elt as HTMLCanvasElement;
      worldCanvas.addEventListener("click", (event) => {
        const bounds = worldCanvas?.getBoundingClientRect();
        if (!bounds) return;
        const screenX = (event.clientX - bounds.left) * (p.width / bounds.width);
        const screenY = (event.clientY - bounds.top) * (p.height / bounds.height);
        const agent = hitTestAgent(
          world,
          camera,
          visualAgentPositions,
          screenX,
          screenY,
          p.width,
          p.height,
        );
        selectedAgentId = agent?.id ?? null;
        onAgentSelect?.(selectedAgentId);
      });
      p.pixelDensity(Math.min(2, window.devicePixelRatio || 1));
      void p.noSmooth();
      terrainLayer = buildTerrainLayer(p, world.terrain, world.seed);
    };

    p.windowResized = () => {
      p.resizeCanvas(host.clientWidth, host.clientHeight);
    };

    p.draw = () => {
      if (!terrainLayer) return;
      p.background("#101e20");
      advanceVisualAgents(visualAgentPositions, p.deltaTime);
      updateCamera(p, world, camera, selectedAgentId, visualAgentPositions);
      p.push();
      p.translate(p.width / 2, p.height / 2);
      p.scale(camera.zoom);
      p.translate(-camera.x, -camera.y);
      drawInfiniteMap(p, terrainLayer, camera);
      drawWorldEntities(p, world, camera, selectedAgentId, visualAgentPositions);
      p.pop();
      drawAtmosphere(p);
    };

    p.mouseDragged = () => {
      camera.x -= p.movedX / camera.zoom;
      camera.y -= p.movedY / camera.zoom;
      camera.targetX = camera.x;
      camera.targetY = camera.y;
      camera.manualUntil = p.millis() + 8_000;
    };

    p.mouseWheel = (event) => {
      // p5 installs this callback on the window. Only consume wheel input
      // that actually targets the world canvas; overlays such as About must
      // retain their native scrolling behavior.
      if (event?.target !== worldCanvas) return true;
      const scale = (event?.deltaY ?? 0) > 0 ? 0.91 : 1.1;
      camera.zoom = p.constrain(camera.zoom * scale, 0.58, 2.15);
      camera.manualUntil = p.millis() + 8_000;
      return false;
    };
  }, host);

  return {
    update(snapshot) {
      if (snapshot.seed !== world.seed || snapshot.terrain.length !== world.terrain.length) {
        terrainLayer?.remove();
        terrainLayer = buildTerrainLayer(sketch, snapshot.terrain, snapshot.seed);
      }
      syncVisualAgentTargets(snapshot, visualAgentPositions);
      world = snapshot;
    },
    selectAgent(agentId) {
      selectedAgentId = agentId;
    },
    remove() {
      terrainLayer?.remove();
      sketch.remove();
    },
  };
}

function hitTestAgent(
  world: PublicWorldSnapshot,
  camera: Camera,
  visualAgentPositions: ReadonlyMap<string, VisualAgentPosition>,
  screenX: number,
  screenY: number,
  viewportWidth: number,
  viewportHeight: number,
): Agent | undefined {
  const worldX = camera.x + (screenX - viewportWidth / 2) / camera.zoom;
  const worldY = camera.y + (screenY - viewportHeight / 2) / camera.zoom;
  const normalizedX = ((worldX % MAP_WIDTH) + MAP_WIDTH) % MAP_WIDTH;
  const normalizedY = ((worldY % MAP_HEIGHT) + MAP_HEIGHT) % MAP_HEIGHT;
  const hitRadius = 18 / camera.zoom;
  let closest: { agent: Agent; distance: number } | undefined;
  for (const agent of world.agents) {
    const visual = visualAgentPositions.get(agent.id) ?? agent;
    const x = (((visual.x % WORLD_WIDTH) + WORLD_WIDTH) % WORLD_WIDTH) * CELL + CELL / 2;
    const y = (((visual.y % WORLD_HEIGHT) + WORLD_HEIGHT) % WORLD_HEIGHT) * CELL + CELL / 2;
    const dx = wrappedDelta(normalizedX, x, MAP_WIDTH);
    const dy = wrappedDelta(normalizedY, y, MAP_HEIGHT);
    const distance = Math.hypot(dx, dy);
    if (distance <= hitRadius && (!closest || distance < closest.distance))
      closest = { agent, distance };
  }
  return closest?.agent;
}

function syncVisualAgentTargets(
  world: PublicWorldSnapshot,
  positions: Map<string, VisualAgentPosition>,
  snap = false,
): void {
  const liveIds = new Set<string>();
  for (const agent of world.agents) {
    liveIds.add(agent.id);
    const current = positions.get(agent.id);
    if (!current || snap) {
      positions.set(agent.id, {
        x: agent.x,
        y: agent.y,
        targetX: agent.x,
        targetY: agent.y,
      });
      continue;
    }
    current.targetX = wrappedTarget(current.x, agent.x, WORLD_WIDTH);
    current.targetY = wrappedTarget(current.y, agent.y, WORLD_HEIGHT);
  }
  for (const id of positions.keys()) if (!liveIds.has(id)) positions.delete(id);
}

function advanceVisualAgents(positions: Map<string, VisualAgentPosition>, elapsedMs: number): void {
  for (const position of positions.values()) {
    position.x = easeToward(position.x, position.targetX, elapsedMs);
    position.y = easeToward(position.y, position.targetY, elapsedMs);
    [position.x, position.targetX] = normalizeSettled(position.x, position.targetX, WORLD_WIDTH);
    [position.y, position.targetY] = normalizeSettled(position.y, position.targetY, WORLD_HEIGHT);
  }
}

function buildTerrainLayer(p: p5, terrain: Tile[], seed: number): p5.Graphics {
  const layer = p.createGraphics(MAP_WIDTH, MAP_HEIGHT);
  layer.pixelDensity(1);
  void layer.noSmooth();
  layer.background("#173739");
  for (let y = 0; y < WORLD_HEIGHT; y += 1) {
    for (let x = 0; x < WORLD_WIDTH; x += 1) {
      const tile = terrain[y * WORLD_WIDTH + x];
      if (!tile) continue;
      layer.noStroke();
      layer.fill(palette[tile.terrain]);
      layer.rect(x * CELL, y * CELL, CELL + 1, CELL + 1);
      const light = Math.floor(tile.richness * 42);
      layer.fill(255, 246, 207, light);
      layer.rect(x * CELL + ((x * 7 + y * 3 + seed) % 11), y * CELL + ((x * 3 + y * 5) % 11), 2, 2);
      if (tile.terrain === "deep-water" || tile.terrain === "tidal") {
        layer.fill(163, 239, 226, tile.terrain === "tidal" ? 34 : 18);
        layer.rect(x * CELL + ((x + y) % 5), y * CELL + 7, 8, 1);
      }
      const rune = terrainRune[tile.terrain];
      if (rune && tile.richness > 0.58 && (x * 17 + y * 23 + seed) % 13 === 0) {
        layer.fill(12, 27, 29, 115);
        layer.textFont("monospace");
        layer.textAlign(layer.CENTER, layer.CENTER);
        layer.textSize(7);
        layer.text(rune, x * CELL + CELL / 2, y * CELL + CELL / 2 + 1);
      }
    }
  }

  layer.noStroke();
  const blobs = [
    ["#e9d277", 0.21, 0.32, 0.24],
    ["#74b89a", 0.66, 0.24, 0.3],
    ["#d26c62", 0.78, 0.72, 0.25],
    ["#7691c4", 0.34, 0.78, 0.28],
  ] as const;
  for (const [color, cx, cy, radius] of blobs) {
    for (let ring = 8; ring >= 1; ring -= 1) {
      const size = radius * MAP_WIDTH * (ring / 8);
      layer.fill(
        `${color}${Math.floor(7 + ring * 2)
          .toString(16)
          .padStart(2, "0")}`,
      );
      layer.ellipse(cx * MAP_WIDTH, cy * MAP_HEIGHT, size, size * 0.72);
    }
  }

  layer.stroke(12, 27, 29, 18);
  layer.strokeWeight(1);
  for (let y = 0; y < MAP_HEIGHT; y += CELL * 3) layer.line(0, y, MAP_WIDTH, y);
  for (let x = 0; x < MAP_WIDTH; x += CELL * 3) layer.line(x, 0, x, MAP_HEIGHT);

  layer.noStroke();
  for (let index = 0; index < 9_000; index += 1) {
    const x = (index * 71 + seed * 13) % MAP_WIDTH;
    const y = (index * 43 + seed * 19) % MAP_HEIGHT;
    const dark = (index * 17) % 3 === 0;
    layer.fill(dark ? 12 : 255, dark ? 24 : 245, dark ? 26 : 215, 10 + (index % 13));
    layer.rect(x, y, 1, 1);
  }
  return layer;
}

function updateCamera(
  p: p5,
  world: PublicWorldSnapshot,
  camera: Camera,
  selectedAgentId: string | null,
  visualAgentPositions: ReadonlyMap<string, VisualAgentPosition>,
): void {
  const selectedAgent = selectedAgentId
    ? world.agents.find((agent) => agent.id === selectedAgentId)
    : undefined;
  if (selectedAgent) {
    const position = visualAgentPositions.get(selectedAgent.id) ?? selectedAgent;
    camera.targetX += wrappedDelta(camera.targetX, position.x * CELL + CELL / 2, MAP_WIDTH);
    camera.targetY += wrappedDelta(camera.targetY, position.y * CELL + CELL / 2, MAP_HEIGHT);
  } else {
    const focusEvent = world.events[0];
    if (focusEvent && focusEvent.tick !== camera.lastFocusTick && p.millis() > camera.manualUntil) {
      camera.targetX += wrappedDelta(camera.targetX, focusEvent.x * CELL + CELL / 2, MAP_WIDTH);
      camera.targetY += wrappedDelta(camera.targetY, focusEvent.y * CELL + CELL / 2, MAP_HEIGHT);
      camera.lastFocusTick = focusEvent.tick;
    }
  }
  if (!selectedAgent && p.millis() > camera.manualUntil) {
    camera.targetX += Math.sin(p.frameCount * 0.0017) * 0.08;
    camera.targetY += Math.cos(p.frameCount * 0.0013) * 0.07;
  }
  camera.x += (camera.targetX - camera.x) * 0.018;
  camera.y += (camera.targetY - camera.y) * 0.018;
}

function drawInfiniteMap(p: p5, layer: p5.Graphics, camera: Camera): void {
  const viewWidth = p.width / camera.zoom;
  const viewHeight = p.height / camera.zoom;
  const startX = Math.floor((camera.x - viewWidth / 2) / MAP_WIDTH) - 1;
  const endX = Math.ceil((camera.x + viewWidth / 2) / MAP_WIDTH) + 1;
  const startY = Math.floor((camera.y - viewHeight / 2) / MAP_HEIGHT) - 1;
  const endY = Math.ceil((camera.y + viewHeight / 2) / MAP_HEIGHT) + 1;
  for (let tileY = startY; tileY <= endY; tileY += 1) {
    for (let tileX = startX; tileX <= endX; tileX += 1) {
      p.image(layer, tileX * MAP_WIDTH, tileY * MAP_HEIGHT);
    }
  }
}

function visibleCopies(
  p: p5,
  point: Vec2,
  camera: Camera,
  draw: (x: number, y: number) => void,
): void {
  const baseX = point.x * CELL + CELL / 2;
  const baseY = point.y * CELL + CELL / 2;
  const centerTileX = Math.round((camera.x - baseX) / MAP_WIDTH);
  const centerTileY = Math.round((camera.y - baseY) / MAP_HEIGHT);
  for (let oy = -1; oy <= 1; oy += 1) {
    for (let ox = -1; ox <= 1; ox += 1) {
      const x = baseX + (centerTileX + ox) * MAP_WIDTH;
      const y = baseY + (centerTileY + oy) * MAP_HEIGHT;
      if (
        Math.abs(x - camera.x) < p.width / camera.zoom &&
        Math.abs(y - camera.y) < p.height / camera.zoom
      )
        draw(x, y);
    }
  }
}

function drawWorldEntities(
  p: p5,
  world: PublicWorldSnapshot,
  camera: Camera,
  selectedAgentId: string | null,
  visualAgentPositions: ReadonlyMap<string, VisualAgentPosition>,
): void {
  for (const station of world.stations)
    visibleCopies(p, station, camera, (x, y) => drawStation(p, station, x, y));
  for (const artifact of world.artifacts)
    visibleCopies(p, artifact, camera, (x, y) => drawArtifact(p, artifact, x, y, world.tick));
  drawAgentTrails(p, world, camera, selectedAgentId, visualAgentPositions);
  for (const agent of world.agents)
    visibleCopies(p, visualAgentPositions.get(agent.id) ?? agent, camera, (x, y) =>
      drawAgent(p, agent, x, y, agent.id === selectedAgentId, world.seed, camera.zoom),
    );
  drawSpeech(p, world, camera, visualAgentPositions);
  const current = world.events[0];
  if (current) {
    visibleCopies(p, current, camera, (x, y) => {
      const radius = 18 + ((p.frameCount * 0.8) % 28);
      p.noFill();
      p.stroke(255, 244, 190, Math.max(0, 120 - radius * 2));
      p.strokeWeight(1);
      p.circle(x, y, radius);
    });
  }
}

function drawAgentTrails(
  p: p5,
  world: PublicWorldSnapshot,
  camera: Camera,
  selectedAgentId: string | null,
  visualAgentPositions: ReadonlyMap<string, VisualAgentPosition>,
): void {
  for (const agent of world.agents) {
    const selected = agent.id === selectedAgentId;
    // Like the paper's trajectory figures, show a deterministic subset to preserve legibility.
    if (!selected && Number(agent.id.slice(1)) % 4 !== 0) continue;
    const points = agent.trail.map((point) => ({ ...point }));
    const visual = visualAgentPositions.get(agent.id);
    if (visual && points.length) points[points.length - 1] = { x: visual.x, y: visual.y };
    if (points.length < 2) continue;
    for (let index = 1; index < points.length; index += 1) {
      const from = points[index - 1]!;
      const to = points[index]!;
      const age = index / points.length;
      visibleCopies(p, from, camera, (x, y) => {
        p.stroke(
          `hsla(${agent.color}, 72%, 72%, ${selected ? 0.25 + age * 0.65 : 0.05 + age * 0.2})`,
        );
        p.strokeWeight(selected ? 1.6 : 0.75);
        p.line(
          x,
          y,
          x + wrappedDelta(from.x, to.x, WORLD_WIDTH) * CELL,
          y + wrappedDelta(from.y, to.y, WORLD_HEIGHT) * CELL,
        );
      });
    }
    if (selected) {
      const start = points[0]!;
      visibleCopies(p, start, camera, (x, y) => {
        p.noFill();
        p.stroke(242, 237, 207, 150);
        p.strokeWeight(1);
        p.circle(x, y, 5);
      });
    }
  }
}

function drawSpeech(
  p: p5,
  world: PublicWorldSnapshot,
  camera: Camera,
  visualAgentPositions: ReadonlyMap<string, VisualAgentPosition>,
): void {
  const active = world.messages.filter((message) => world.tick - message.tick <= 20).slice(0, 5);
  active.forEach((message, index) => {
    const senderAgent = world.agents.find((agent) => agent.id === message.fromId);
    const recipientAgent = world.agents.find((agent) => agent.id === message.toId);
    if (!senderAgent || !recipientAgent) return;
    const sender = visualAgentPositions.get(senderAgent.id) ?? senderAgent;
    const recipient = visualAgentPositions.get(recipientAgent.id) ?? recipientAgent;
    const age = world.tick - message.tick;
    const alpha = Math.max(0.22, 1 - age / 22);
    visibleCopies(p, sender, camera, (x, y) => {
      const targetX = x + wrappedDelta(sender.x, recipient.x, WORLD_WIDTH) * CELL;
      const targetY = y + wrappedDelta(sender.y, recipient.y, WORLD_HEIGHT) * CELL;
      p.push();
      p.stroke(219, 244, 92, 95 * alpha);
      p.strokeWeight(0.7);
      const context = p.drawingContext as CanvasRenderingContext2D;
      context.setLineDash([2, 3]);
      p.line(x, y - 6, targetX, targetY - 6);
      context.setLineDash([]);
      p.textFont("Pixelify Sans");
      p.textSize(10);
      const width = Math.min(166, p.textWidth(message.text) + 16);
      const displayText = fitOverlayText(message.text, width - 12, (text) => p.textWidth(text));
      const screenX = (x - camera.x) * camera.zoom + p.width / 2;
      const screenY = (y - camera.y) * camera.zoom + p.height / 2;
      const botOverlayClearance = 7 * camera.zoom + 25;
      const [anchorX, anchorY] = clampOverlayAnchor(
        screenX,
        screenY - botOverlayClearance - (index % 3) * 21,
        width,
        p.width,
        p.height,
      );
      p.translate(x + (anchorX - screenX) / camera.zoom, y + (anchorY - screenY) / camera.zoom);
      p.scale(1 / camera.zoom);
      p.noStroke();
      p.fill(7, 19, 20, 225 * alpha);
      p.rect(-width / 2, -9, width, 18, 3);
      p.fill(239, 243, 207, 255 * alpha);
      p.textAlign(p.CENTER, p.CENTER);
      p.text(displayText, 0, 0);
      p.pop();
    });
  });
}

function drawStation(p: p5, station: Station, x: number, y: number): void {
  const glyph: Record<Station["kind"], string> = {
    wash: hackerNoonGlyph.rain,
    grind: hackerNoonGlyph.cog,
    weave: hackerNoonGlyph.grid,
    foundry: hackerNoonGlyph.shapes,
    assay: hackerNoonGlyph.search,
  };
  p.push();
  p.translate(Math.round(x), Math.round(y));
  p.noStroke();
  p.fill(18, 31, 30, 185);
  p.rect(-8, -8, 16, 16);
  p.fill(238, 222, 155);
  p.textFont("iconfont");
  p.textAlign(p.CENTER, p.CENTER);
  p.textSize(11);
  p.text(glyph[station.kind], 0, 1);
  p.pop();
}

function drawArtifact(p: p5, artifact: Artifact, x: number, y: number, tick: number): void {
  const pulse = 0.8 + Math.sin((tick + artifact.builtAt) * 0.08) * 0.2;
  p.push();
  p.translate(Math.round(x), Math.round(y));
  p.noStroke();
  p.fill(12, 24, 25, 115);
  p.quad(0, -9, 9, 0, 0, 9, -9, 0);
  p.fill(materialColor[artifact.material]);
  p.textFont("iconfont");
  p.textAlign(p.CENTER, p.CENTER);
  p.textSize(artifact.validated ? 10 * pulse : 8);
  p.text(hackerNoonGlyph.shapes, 0, 1);
  p.fill(255, 239, 183, 210);
  p.textFont("monospace");
  p.textSize(7);
  p.text(materialRune[artifact.material], 8, 6);
  if (artifact.generation > 1) {
    p.fill(255, 239, 183, 190);
    p.textFont("iconfont");
    p.textSize(7);
    p.text(hackerNoonGlyph.fork, -8, 6);
  }
  p.pop();
}

function drawGeneratedBot(p: p5, appearance: BotAppearance): void {
  p.noStroke();
  for (const layer of appearance.layers.slice(0, 3)) {
    p.fill(`${layer.color}24`);
    p.circle((layer.x - 32) * 0.16, (layer.y - 32) * 0.16, 9 + (layer.radius - 17) * 0.18);
  }

  p.stroke(appearance.secondary);
  p.strokeWeight(1);
  p.noFill();
  if (appearance.antenna === "pin") {
    p.line(0, -6, 0, -9);
    p.point(0, -10);
  } else if (appearance.antenna === "fork") {
    p.line(-2, -5, -4, -9);
    p.line(2, -5, 4, -9);
  } else if (appearance.antenna === "dish") {
    p.line(0, -5, 0, -8);
    p.arc(0, -8, 6, 4, 0, p.PI);
  } else if (appearance.antenna === "ears") {
    p.line(-4, -4, -7, -8);
    p.line(4, -4, 7, -8);
  }

  p.noStroke();
  p.fill(appearance.secondary);
  p.rect(appearance.podSide < 0 ? -8 : 6, -2, 2, 7);
  p.rect(-4, 5, 3, 2);
  p.rect(1, 5, 3, 2);
  p.fill(appearance.primary);
  if (appearance.shell === "round") p.rect(-6, -6, 12, 12, 4);
  else if (appearance.shell === "diamond") p.quad(0, -8, 7, 0, 0, 8, -7, 0);
  else if (appearance.shell === "hex") {
    p.beginShape();
    p.vertex(-5, -7);
    p.vertex(5, -7);
    p.vertex(8, 0);
    p.vertex(5, 7);
    p.vertex(-5, 7);
    p.vertex(-8, 0);
    p.endShape(p.CLOSE);
  } else if (appearance.shell === "tall") p.rect(-5, -8, 10, 15, 2);
  else p.rect(-6, -6, 12, 12, 1);

  p.fill(appearance.shadow);
  if (appearance.eyes === "cyclops") {
    p.rect(-3, -3, 6, 4, 2);
    p.fill(appearance.highlight);
    p.rect(-1, -2, 2, 2);
  } else if (appearance.eyes === "bar") {
    p.rect(-4, -3, 8, 3, 1);
    p.fill(appearance.highlight);
    p.rect(-3, -2, 6, 1);
  } else if (appearance.eyes === "triad") {
    p.rect(-4, -3, 2, 2);
    p.rect(-1, -3, 2, 2);
    p.rect(2, -3, 2, 2);
  } else if (appearance.eyes === "split") {
    p.triangle(-5, -3, -1, -2, -5, 0);
    p.triangle(5, -3, 1, -2, 5, 0);
  } else {
    p.rect(-4, -3, 3, 3, 1);
    p.rect(1, -3, 3, 3, 1);
  }
  p.fill(appearance.secondary);
  p.rect(-3, 2, 6, 2);
  p.fill(appearance.highlight);
  p.rect(appearance.podSide < 0 ? -5 : 3, 3, 2, 2);
}

function drawAgent(
  p: p5,
  agent: Agent,
  x: number,
  y: number,
  selected: boolean,
  worldSeed: number,
  cameraZoom: number,
): void {
  const modeColor: Record<Agent["mode"], string> = {
    surveying: "#eff3cf",
    harvesting: "#7de1db",
    fabricating: "#ffd272",
    maintaining: "#a8dc78",
    forking: "#f493d1",
  };
  p.push();
  p.translate(Math.round(x), Math.round(y));
  if (selected) {
    const pulse = 11 + Math.sin(p.frameCount * 0.12) * 2;
    p.noFill();
    p.stroke("#dbf45c");
    p.strokeWeight(1);
    p.circle(0, 0, pulse * 2);
  }
  drawGeneratedBot(p, generateBotAppearance(`${worldSeed}:${agent.id}`));

  // The bounded action sandbox supplies a bot-selected Unicode action mark.
  p.push();
  p.translate(0, -7 - 8 / cameraZoom);
  p.scale(1 / cameraZoom);
  p.fill(8, 18, 19, 220);
  p.stroke(239, 243, 207, 110);
  p.strokeWeight(0.75);
  p.rect(-5, -5, 10, 10);
  p.noStroke();
  p.fill(modeColor[agent.mode]);
  p.textFont("Pixelify Sans");
  p.textAlign(p.CENTER, p.CENTER);
  p.textSize(8);
  p.text(agent.icon, 0, 0.5);
  p.pop();
  p.pop();
}

function drawAtmosphere(p: p5): void {
  const context = p.drawingContext as CanvasRenderingContext2D;
  const vignette = context.createRadialGradient(
    p.width / 2,
    p.height / 2,
    p.width * 0.12,
    p.width / 2,
    p.height / 2,
    p.width * 0.76,
  );
  vignette.addColorStop(0, "rgba(8, 20, 21, 0)");
  vignette.addColorStop(1, "rgba(8, 20, 21, 0.48)");
  context.fillStyle = vignette;
  context.fillRect(0, 0, p.width, p.height);
  p.noStroke();
  p.fill(242, 225, 171, 8);
  for (let index = 0; index < 70; index += 1) {
    const x = (index * 97 + p.frameCount * 0.07) % p.width;
    const y = (index * 53 + Math.sin(index + p.frameCount * 0.004) * 20 + p.height) % p.height;
    p.rect(x, y, 1, 1);
  }
}
