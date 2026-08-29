import { identityHash32 } from "./names";

const palettes = [
  ["#7de1db", "#dbf45c", "#ff8c73", "#18292b"],
  ["#ffd272", "#f493d1", "#72d8c4", "#231f2c"],
  ["#9cc7ff", "#ff9e73", "#e8f18a", "#172532"],
  ["#a8dc78", "#7fc9e8", "#f4b56a", "#1e2a24"],
  ["#f0a7cf", "#8de4df", "#efe58a", "#2b2130"],
  ["#ff8c73", "#8ca9ff", "#c8ef7f", "#2d2323"],
  ["#b8a2ff", "#63dfc7", "#ffc96e", "#201f31"],
  ["#78d5ff", "#f5df72", "#e889b7", "#152932"],
  ["#d9ef87", "#ee8d67", "#79cbd4", "#273022"],
  ["#f2d9a0", "#72c7b9", "#d987ae", "#2c2924"],
  ["#8ed7a6", "#f6a86d", "#97a9ed", "#1c2c28"],
  ["#e9a778", "#8de0e1", "#d3e77d", "#2e261f"],
] as const;

export type BotShell = "square" | "round" | "diamond" | "hex" | "tall";
export type BotEyes = "pair" | "cyclops" | "bar" | "triad" | "split";
export type BotAntenna = "pin" | "fork" | "dish" | "ears" | "none";

export interface BotAppearance {
  primary: string;
  secondary: string;
  highlight: string;
  shadow: string;
  shell: BotShell;
  eyes: BotEyes;
  antenna: BotAntenna;
  podSide: -1 | 1;
  panel: number;
  layers: Array<{ x: number; y: number; radius: number; color: string }>;
}

const shells: BotShell[] = ["square", "round", "diamond", "hex", "tall"];
const eyes: BotEyes[] = ["pair", "cyclops", "bar", "triad", "split"];
const antennas: BotAntenna[] = ["pin", "fork", "dish", "ears", "none"];
const cache = new Map<string, BotAppearance>();

function hashPart(identity: string, namespace: string): number {
  return identityHash32(`${namespace}:${identity}`);
}

export function generateBotAppearance(identity: string): BotAppearance {
  const cached = cache.get(identity);
  if (cached) return cached;
  const palette = palettes[hashPart(identity, "palette") % palettes.length]!;
  const rotation = hashPart(identity, "rotation") % 3;
  const appearance: BotAppearance = {
    primary: palette[rotation]!,
    secondary: palette[(rotation + 1) % 3]!,
    highlight: palette[(rotation + 2) % 3]!,
    shadow: palette[3],
    shell: shells[hashPart(identity, "shell") % shells.length]!,
    eyes: eyes[hashPart(identity, "eyes") % eyes.length]!,
    antenna: antennas[hashPart(identity, "antenna") % antennas.length]!,
    podSide: hashPart(identity, "pod") % 2 === 0 ? -1 : 1,
    panel: hashPart(identity, "panel") % 6,
    layers: Array.from({ length: 4 }, (_, index) => {
      const layerHash = hashPart(identity, `layer-${index}`);
      return {
        x: 18 + (layerHash % 29),
        y: 18 + ((layerHash >>> 7) % 29),
        radius: 17 + ((layerHash >>> 13) % 19),
        color: palette[index % 3]!,
      };
    }),
  };
  cache.set(identity, appearance);
  return appearance;
}

function svgShell(appearance: BotAppearance): string {
  const fill = appearance.primary;
  const stroke = appearance.highlight;
  if (appearance.shell === "round")
    return `<rect x="19" y="23" width="26" height="25" rx="9" fill="${fill}" stroke="${stroke}" stroke-width="2"/>`;
  if (appearance.shell === "diamond")
    return `<path d="M32 19 47 33 32 50 17 33Z" fill="${fill}" stroke="${stroke}" stroke-width="2"/>`;
  if (appearance.shell === "hex")
    return `<path d="M23 20h18l8 13-8 16H23l-8-16Z" fill="${fill}" stroke="${stroke}" stroke-width="2"/>`;
  if (appearance.shell === "tall")
    return `<rect x="22" y="17" width="20" height="34" rx="3" fill="${fill}" stroke="${stroke}" stroke-width="2"/>`;
  return `<rect x="18" y="21" width="28" height="28" rx="2" fill="${fill}" stroke="${stroke}" stroke-width="2"/>`;
}

function svgAntenna(appearance: BotAppearance): string {
  const color = appearance.secondary;
  if (appearance.antenna === "pin")
    return `<path d="M32 21V13" stroke="${color}" stroke-width="2"/><rect x="30" y="10" width="4" height="4" fill="${appearance.highlight}"/>`;
  if (appearance.antenna === "fork")
    return `<path d="M28 22V14l-4-4M36 22V14l4-4" stroke="${color}" stroke-width="2" fill="none"/>`;
  if (appearance.antenna === "dish")
    return `<path d="M32 22v-6M25 11q7 8 14 0" stroke="${color}" stroke-width="2" fill="none"/>`;
  if (appearance.antenna === "ears")
    return `<path d="m21 24-5-8v12M43 24l5-8v12" stroke="${color}" stroke-width="3" fill="none"/>`;
  return "";
}

function svgEyes(appearance: BotAppearance): string {
  const color = appearance.shadow;
  const glow = appearance.highlight;
  if (appearance.eyes === "cyclops")
    return `<rect x="27" y="29" width="10" height="8" rx="4" fill="${color}"/><rect x="30" y="31" width="4" height="4" fill="${glow}"/>`;
  if (appearance.eyes === "bar")
    return `<rect x="23" y="30" width="18" height="6" rx="2" fill="${color}"/><rect x="25" y="32" width="14" height="2" fill="${glow}"/>`;
  if (appearance.eyes === "triad")
    return `<rect x="23" y="29" width="5" height="5" fill="${color}"/><rect x="30" y="29" width="5" height="5" fill="${color}"/><rect x="37" y="29" width="5" height="5" fill="${color}"/>`;
  if (appearance.eyes === "split")
    return `<path d="m23 29 7 3-7 4Zm18 0-7 3 7 4Z" fill="${color}"/>`;
  return `<rect x="23" y="29" width="7" height="7" rx="2" fill="${color}"/><rect x="35" y="29" width="7" height="7" rx="2" fill="${color}"/><rect x="25" y="31" width="3" height="3" fill="${glow}"/><rect x="37" y="31" width="3" height="3" fill="${glow}"/>`;
}

export function botPortraitSvg(identity: string): string {
  const appearance = generateBotAppearance(identity);
  const safeId = identityHash32(identity).toString(16);
  const gradients = appearance.layers
    .map(
      (layer, index) =>
        `<radialGradient id="bot-${safeId}-${index}" cx="${layer.x}%" cy="${layer.y}%" r="${layer.radius}%" spreadMethod="${index % 2 === 0 ? "reflect" : "pad"}"><stop offset="0" stop-color="${layer.color}" stop-opacity=".92"/><stop offset=".62" stop-color="${appearance.secondary}" stop-opacity=".44"/><stop offset="1" stop-color="${appearance.shadow}" stop-opacity="0"/></radialGradient>`,
    )
    .join("");
  const fields = appearance.layers
    .map(
      (_, index) =>
        `<rect x="${4 + index * 2}" y="${5 + ((index * 7) % 9)}" width="${56 - index * 3}" height="${51 - index * 2}" rx="${8 + ((appearance.panel + index) % 14)}" fill="url(#bot-${safeId}-${index})" transform="rotate(${(appearance.panel - 2) * (index + 1)} 32 32)"/>`,
    )
    .join("");
  const podX = appearance.podSide < 0 ? 12 : 47;
  return `<svg viewBox="0 0 64 64" role="img" aria-label="Unique generated robot portrait" shape-rendering="crispEdges"><defs>${gradients}<filter id="grain-${safeId}"><feTurbulence type="fractalNoise" baseFrequency=".12" numOctaves="2"/><feBlend in="SourceGraphic" mode="overlay"/></filter></defs><rect width="64" height="64" rx="9" fill="${appearance.shadow}"/>${fields}<g filter="url(#grain-${safeId})" opacity=".18"><rect width="64" height="64" fill="#fff"/></g><g>${svgAntenna(appearance)}<rect x="${podX}" y="31" width="5" height="13" fill="${appearance.secondary}"/>${svgShell(appearance)}<rect x="25" y="40" width="14" height="5" fill="${appearance.secondary}" opacity=".75"/>${svgEyes(appearance)}<rect x="${appearance.podSide < 0 ? 21 : 39}" y="39" width="4" height="4" fill="${appearance.highlight}"/></g></svg>`;
}
