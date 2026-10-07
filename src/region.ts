export const REGION_BOUNDS: [[number, number], [number, number]] = [
  [-79.48696767001076, 39.202068911240104],
  [-79.08637004392415, 39.722221540464716],
];

export const REGION_BBOX = [
  REGION_BOUNDS[0][1], REGION_BOUNDS[0][0], REGION_BOUNDS[1][1], REGION_BOUNDS[1][0],
].join(",");

export function regionMinZoom(width: number, height: number): number {
  const mercatorY = (latitude: number): number =>
    (1 - Math.log(Math.tan(Math.PI / 4 + latitude * Math.PI / 360)) / Math.PI) / 2;
  const worldWidth = (REGION_BOUNDS[1][0] - REGION_BOUNDS[0][0]) / 360 * 512;
  const worldHeight = (mercatorY(REGION_BOUNDS[0][1]) - mercatorY(REGION_BOUNDS[1][1])) * 512;
  return Math.max(0, Math.log2(Math.max(1, width) / worldWidth), Math.log2(Math.max(1, height) / worldHeight));
}

type Coordinate = [number, number];

export function inRegion([longitude, latitude]: Coordinate): boolean {
  return longitude >= REGION_BOUNDS[0][0] && longitude <= REGION_BOUNDS[1][0] &&
    latitude >= REGION_BOUNDS[0][1] && latitude <= REGION_BOUNDS[1][1];
}

// Clip edges as well as points: crossing trails must not vanish or join across excursions outside the region.
export function clipSegments(segments: Coordinate[][]): Coordinate[][] {
  const result: Coordinate[][] = [];
  for (const segment of segments) {
    let current: Coordinate[] = [];
    for (let i = 1; i < segment.length; i++) {
      const a = segment[i - 1];
      const b = segment[i];
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const p = [-dx, dx, -dy, dy];
      const q = [a[0] - REGION_BOUNDS[0][0], REGION_BOUNDS[1][0] - a[0],
        a[1] - REGION_BOUNDS[0][1], REGION_BOUNDS[1][1] - a[1]];
      let start = 0;
      let end = 1;
      let visible = true;
      for (let edge = 0; edge < 4; edge++) {
        if (p[edge] === 0) {
          if (q[edge] < 0) visible = false;
        } else {
          const ratio = q[edge] / p[edge];
          if (p[edge] < 0) start = Math.max(start, ratio);
          else end = Math.min(end, ratio);
        }
      }
      if (!visible || start > end) {
        if (current.length > 1) result.push(current);
        current = [];
        continue;
      }
      const clamp = ([x, y]: Coordinate): Coordinate => [
        Math.max(REGION_BOUNDS[0][0], Math.min(REGION_BOUNDS[1][0], x)),
        Math.max(REGION_BOUNDS[0][1], Math.min(REGION_BOUNDS[1][1], y)),
      ];
      const first = clamp([a[0] + start * dx, a[1] + start * dy]);
      const last = clamp([a[0] + end * dx, a[1] + end * dy]);
      const previous = current[current.length - 1];
      if (!previous || previous[0] !== first[0] || previous[1] !== first[1] || !inRegion(a)) {
        if (current.length > 1) result.push(current);
        current = [first];
      }
      current.push(last);
      if (!inRegion(b)) {
        if (current.length > 1) result.push(current);
        current = [];
      }
    }
    if (current.length > 1) result.push(current);
  }
  return result;
}
