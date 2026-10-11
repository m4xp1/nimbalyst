export interface CoverageMeta { label: string; color: string }

export const COVERAGE_META: Record<string, CoverageMeta> = {
  docs: { label: 'docs', color: '#4ade80' },
  design: { label: 'design', color: '#3b82f6' },
  plans: { label: 'plans', color: '#a78bfa' },
  facts: { label: 'voice-memory facts', color: '#f472b6' },
  sessions: { label: 'sessions', color: '#38bdf8' },
  trackers: { label: 'trackers', color: '#fb923c' },
  claude: { label: 'CLAUDE.md', color: '#fbbf24' },
  rules: { label: 'rules', color: '#f87171' },
  'harness-memory': { label: 'harness-memory', color: '#2dd4bf' },
  custom: { label: 'custom', color: '#808080' },
};

function hash(name: string): number {
  let value = 2166136261;
  for (const char of name.normalize('NFC')) value = Math.imul(value ^ char.codePointAt(0)!, 16777619);
  return value >>> 0;
}

function shade(hue: number, saturation: number, lightness: number): string {
  const a = saturation * Math.min(lightness, 1 - lightness);
  const channel = (n: number) => {
    const k = (n + hue / 30) % 12;
    return Math.round(255 * (lightness - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))))
      .toString(16).padStart(2, '0');
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}

function distance(a: string, b: string): number {
  return Math.sqrt([1, 3, 5].reduce((sum, pos) => sum +
    (parseInt(a.slice(pos, pos + 2), 16) - parseInt(b.slice(pos, pos + 2), 16)) ** 2, 0));
}

/** Resolve collisions in name order, independently of segment order/counts. */
export function coveragePalette(classes: string[]): Record<string, CoverageMeta> {
  const result: Record<string, CoverageMeta> = Object.create(null);
  const used = new Set(Object.values(COVERAGE_META).map(meta => meta.color));
  for (const name of [...new Set(classes)].sort()) {
    if (Object.hasOwn(COVERAGE_META, name)) { result[name] = COVERAGE_META[name]; continue; }
    const seed = hash(name);
    let color: string;
    let attempt = 0;
    do {
      color = shade((seed % 360 + attempt * 137.508) % 360,
        0.56 + ((seed + attempt) % 22) / 100, 0.45 + ((seed + attempt * 7) % 22) / 100);
      attempt++;
    } while (used.has(color) || (attempt < 500 && [...used].some(value => distance(color, value) < 55)));
    used.add(color);
    result[name] = { label: name, color };
  }
  return result;
}
