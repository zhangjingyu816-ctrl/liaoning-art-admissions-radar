import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceUrl = 'https://geo.datav.aliyun.com/areas_v3/bound/100000_full.json';
const scriptDir = dirname(fileURLToPath(import.meta.url));
const outputPath = resolve(scriptDir, '..', 'dist', 'data', 'china-provinces.json');

const response = await fetch(sourceUrl);
if (!response.ok) throw new Error(`China map download failed: HTTP ${response.status}`);

const data = await response.json();
if (data?.type !== 'FeatureCollection' || !Array.isArray(data.features) || data.features.length < 30) {
  throw new Error('China map data failed validation');
}

function squaredSegmentDistance(point, start, end) {
  let x = start[0];
  let y = start[1];
  let dx = end[0] - x;
  let dy = end[1] - y;
  if (dx || dy) {
    const t = ((point[0] - x) * dx + (point[1] - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) {
      x = end[0];
      y = end[1];
    } else if (t > 0) {
      x += dx * t;
      y += dy * t;
    }
  }
  dx = point[0] - x;
  dy = point[1] - y;
  return dx * dx + dy * dy;
}

function simplifySection(points, first, last, toleranceSquared, kept) {
  let maxDistance = toleranceSquared;
  let index = 0;
  for (let i = first + 1; i < last; i += 1) {
    const distance = squaredSegmentDistance(points[i], points[first], points[last]);
    if (distance > maxDistance) {
      index = i;
      maxDistance = distance;
    }
  }
  if (!index) return;
  if (index - first > 1) simplifySection(points, first, index, toleranceSquared, kept);
  kept.push(points[index]);
  if (last - index > 1) simplifySection(points, index, last, toleranceSquared, kept);
}

function simplifyRing(ring, tolerance = 0.045) {
  if (!Array.isArray(ring) || ring.length < 7) return ring;
  const isClosed = ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1];
  const points = isClosed ? ring.slice(0, -1) : [...ring];
  const kept = [points[0]];
  simplifySection(points, 0, points.length - 1, tolerance * tolerance, kept);
  kept.push(points.at(-1));
  const rounded = kept.map(([lng, lat]) => [Number(lng.toFixed(3)), Number(lat.toFixed(3))]);
  if (isClosed) rounded.push([...rounded[0]]);
  return rounded.length >= 4 ? rounded : ring;
}

function simplifyGeometry(geometry) {
  if (geometry?.type === 'Polygon') {
    return { type: 'Polygon', coordinates: geometry.coordinates.map((ring) => simplifyRing(ring)) };
  }
  if (geometry?.type === 'MultiPolygon') {
    return { type: 'MultiPolygon', coordinates: geometry.coordinates.map((polygon) => polygon.map((ring) => simplifyRing(ring))) };
  }
  return geometry;
}

const compact = {
  type: 'FeatureCollection',
  features: data.features.map((feature) => ({
    type: 'Feature',
    properties: { name: feature?.properties?.name || '' },
    geometry: simplifyGeometry(feature.geometry)
  }))
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(compact)}\n`, 'utf8');
console.log(`Saved ${compact.features.length} provincial features to ${outputPath}`);

