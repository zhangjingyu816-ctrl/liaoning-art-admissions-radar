import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceUrl = 'https://geo.datav.aliyun.com/areas_v3/bound/100000_full.json';
const scriptDir = dirname(fileURLToPath(import.meta.url));
const outputPath = resolve(scriptDir, '..', 'dist', 'data', 'china-provinces.json');
const cityOutputPath = resolve(scriptDir, '..', 'dist', 'data', 'china-cities.json');

// Only bundle the province-level children that are relevant to the monitored
// schools. This keeps the city-boundary payload small enough for a static site.
const monitoredProvinceNames = new Set([
  '北京市', '天津市', '上海市', '重庆市', '辽宁省', '吉林省', '黑龙江省',
  '河北省', '山西省', '山东省', '浙江省', '江苏省', '福建省', '广东省',
  '广西壮族自治区', '湖南省', '湖北省', '河南省', '四川省', '陕西省',
  '甘肃省', '宁夏回族自治区', '新疆维吾尔自治区', '云南省', '海南省', '江西省'
]);

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

function simplifyGeometry(geometry, tolerance = 0.045) {
  if (geometry?.type === 'Polygon') {
    return { type: 'Polygon', coordinates: geometry.coordinates.map((ring) => simplifyRing(ring, tolerance)) };
  }
  if (geometry?.type === 'MultiPolygon') {
    return { type: 'MultiPolygon', coordinates: geometry.coordinates.map((polygon) => polygon.map((ring) => simplifyRing(ring, tolerance))) };
  }
  return geometry;
}

function compactProperties(properties = {}, parentName = '') {
  return {
    name: properties.name || '',
    adcode: properties.adcode || null,
    center: properties.center || null,
    centroid: properties.centroid || null,
    level: properties.level || '',
    parentName
  };
}

const compact = {
  type: 'FeatureCollection',
  features: data.features.map((feature) => ({
    type: 'Feature',
    properties: compactProperties(feature?.properties),
    geometry: simplifyGeometry(feature.geometry)
  }))
};

async function fetchProvinceChildren(province) {
  const { adcode, name } = province.properties;
  const response = await fetch(`https://geo.datav.aliyun.com/areas_v3/bound/${adcode}_full.json`);
  if (!response.ok) throw new Error(`${name} city map download failed: HTTP ${response.status}`);
  const provinceData = await response.json();
  if (provinceData?.type !== 'FeatureCollection' || !Array.isArray(provinceData.features)) {
    throw new Error(`${name} city map data failed validation`);
  }
  return provinceData.features.map((feature) => ({
    type: 'Feature',
    properties: compactProperties(feature?.properties, name),
    geometry: simplifyGeometry(feature.geometry, 0.065)
  }));
}

const targetProvinces = data.features.filter((feature) => monitoredProvinceNames.has(feature?.properties?.name));
const cityFeatures = [];
for (const province of targetProvinces) {
  const children = await fetchProvinceChildren(province);
  cityFeatures.push(...children);
  console.log(`Downloaded ${province.properties.name}: ${children.length} boundaries`);
}

const compactCities = { type: 'FeatureCollection', features: cityFeatures };

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(compact)}\n`, 'utf8');
await writeFile(cityOutputPath, `${JSON.stringify(compactCities)}\n`, 'utf8');
console.log(`Saved ${compact.features.length} provincial features to ${outputPath}`);
console.log(`Saved ${compactCities.features.length} city/district features to ${cityOutputPath}`);
