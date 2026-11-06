// What a trail is like to walk or ride. Pure. Climb comes from elevation samples about 145 ft apart,
// so it's an estimate, and everything else is only what a source says.
import { distanceMiles, FEET_PER_MILE, formatFeet } from './geo.js';
import { HIKE } from './activities.js';

const SAMPLE_FEET = 150;
const NOISE_FEET = 20; // Smaller wiggles are mostly the elevation data, not the trail.
const PROFILE_POINTS = 24;
const MIN_TAG_SHARE = 0.1;
const MOST_SHARE = 0.5;
const NEARLY_ALL_SHARE = 0.8;

const toPoint = ([lon, lat]) => ({ lat, lon });
export const lineMiles = coords => coords.slice(1).reduce((total, coord, index) => total + distanceMiles(toPoint(coords[index]), toPoint(coord)), 0);

// Evenly spaced points along a line, so long straight segments still get sampled.
export function resample(coords, stepFeet = SAMPLE_FEET) {
  const points = [coords[0]];
  let carried = 0;
  for (let index = 1; index < coords.length; index += 1) {
    const [lonA, latA] = coords[index - 1];
    const [lonB, latB] = coords[index];
    const feet = distanceMiles({ lat: latA, lon: lonA }, { lat: latB, lon: lonB }) * FEET_PER_MILE;
    let along = stepFeet - carried;
    while (along < feet) {
      const t = along / feet;
      points.push([lonA + (lonB - lonA) * t, latA + (latB - latA) * t]);
      along += stepFeet;
    }
    carried = (carried + feet) % stepFeet;
  }
  const last = coords[coords.length - 1];
  if (points[points.length - 1] !== last) points.push(last);
  return points;
}

// Counts a change only once it has gone far enough to be more than noise.
export function climbAndDescent(elevations, noiseFeet = NOISE_FEET) {
  let up = 0;
  let down = 0;
  let anchor = elevations[0];
  for (const elevation of elevations) {
    const change = elevation - anchor;
    if (Math.abs(change) >= noiseFeet) {
      if (change > 0) up += change;
      else down -= change;
      anchor = elevation;
    }
  }
  return { up, down };
}

// National Park Service, Shenandoah: the square root of gain times 2 times miles. The park calls it
// approximate, since it misses short steep trails.
export function effortRating(climbFeet, miles) {
  const score = Math.sqrt(climbFeet * 2 * miles);
  if (score < 50) return 'Easiest';
  if (score < 100) return 'Moderate';
  if (score < 150) return 'Moderately strenuous';
  if (score <= 200) return 'Strenuous';
  return 'Very strenuous';
}

function thin(values, count = PROFILE_POINTS) {
  if (values.length <= count) return values.map(Math.round);
  return Array.from({ length: count }, (_, index) => Math.round(values[Math.round((index * (values.length - 1)) / (count - 1))]));
}

const SAC_LABELS = { hiking: 1, mountain_hiking: 2, demanding_mountain_hiking: 3, alpine_hiking: 4 };
const SAC_TEXT = { 1: 'Mapped as ordinary hiking terrain', 2: 'Mapped as mountain hiking, with rougher footing', 3: 'Mapped as demanding mountain hiking', 4: 'Mapped as alpine hiking' };
const IMBA_TEXT = ['Mapped bike difficulty: easiest', 'Mapped bike difficulty: easy', 'Mapped bike difficulty: intermediate', 'Mapped bike difficulty: difficult', 'Mapped bike difficulty: very difficult'];

// The highest rating covering a real share of the trail, so one rough spot doesn't label all of it.
function hardest(lines, total, rank) {
  const miles = new Map();
  for (const line of lines) {
    const value = rank(line);
    if (value !== null && value !== undefined) miles.set(value, (miles.get(value) || 0) + line.miles);
  }
  const qualifying = [...miles].filter(([, length]) => length / total >= MIN_TAG_SHARE).map(([value]) => value);
  return qualifying.length ? Math.max(...qualifying) : null;
}

const shareWhere = (lines, total, accepts) => lines.reduce((sum, line) => sum + (accepts(line) ? line.miles : 0), 0) / total;

// lines: [{ coords, tags }]. groundAt returns feet at [lon, lat], or null outside the elevation data.
export function trailDetails(rawLines, groundAt, activities = 0) {
  const lines = rawLines.map(line => ({ ...line, miles: lineMiles(line.coords) }));
  const total = lines.reduce((sum, { miles }) => sum + miles, 0);
  if (!total) return {};
  const details = {};
  let climbing = 0;
  let measured = true;
  let longest = null;
  for (const line of lines) {
    const elevations = resample(line.coords).map(groundAt);
    if (elevations.some(value => value === null || value === undefined)) {
      measured = false;
      continue;
    }
    // Which way a mapped line was drawn is arbitrary, so this takes the harder direction. Better to
    // overstate a climb than to send someone up a mountain expecting half of it.
    const { up, down } = climbAndDescent(elevations);
    climbing += Math.max(up, down);
    if (!longest || line.miles > longest.miles) longest = { miles: line.miles, elevations };
  }
  if (measured) {
    details.climbFeet = Math.round(climbing / 10) * 10;
    if (activities & HIKE) details.effort = effortRating(climbing, total);
    if (longest.miles / total >= MOST_SHARE) {
      details.profile = thin(longest.elevations);
      details.profileMiles = Math.round(longest.miles * 100) / 100;
    }
  }
  const sac = hardest(lines, total, ({ tags }) => SAC_LABELS[tags?.sac]);
  if (sac) details.sac = sac;
  const imba = hardest(lines, total, ({ tags }) => (tags?.imba === undefined ? null : Number(tags.imba)));
  if (imba !== null && IMBA_TEXT[imba]) details.imba = imba;
  if (shareWhere(lines, total, ({ tags }) => ['leashed', 'yes'].includes(tags?.dog)) >= MOST_SHARE) details.dogs = shareWhere(lines, total, ({ tags }) => tags?.dog === 'yes') >= MOST_SHARE ? 'yes' : 'leashed';
  if (shareWhere(lines, total, ({ tags }) => tags?.wheelchair === 'yes') >= NEARLY_ALL_SHARE) details.wheelchair = 'yes';
  else if (shareWhere(lines, total, ({ tags }) => tags?.wheelchair === 'no') >= MOST_SHARE) details.wheelchair = 'no';
  if (shareWhere(lines, total, ({ tags }) => ['bad', 'horrible', 'no'].includes(tags?.visibility)) >= 0.25) details.hardToSee = true;
  return details;
}

// A long route is many short mapped pieces, and rail and canal grades run through cuts and over
// bridges that the elevation data doesn't see. Either way every piece adds noise to the climb, so
// the Great Allegheny Passage would otherwise read as 20,000 ft and very strenuous.
const LONGEST_MEASURED_MILES = 25;
const GENTLE_GRADE = /\b(rail|railroad|canal|towpath|passage|deckers creek|allegheny highlands|indian creek valley|blackwater canyon|coal (and |& )?coke|mon river|west virginia northern)\b/i;
export const climbIsReliable = ({ miles, name = '' }) => !(miles >= LONGEST_MEASURED_MILES) && !GENTLE_GRADE.test(name);

export function detailFacts(item) {
  const facts = [];
  if (!climbIsReliable(item)) {
    facts.push(...detailFacts({ ...item, miles: 0, name: '', climbFeet: undefined, effort: undefined }));
    return facts;
  }
  if (Number.isFinite(item.climbFeet)) facts.push(item.climbFeet < 50 ? 'Nearly flat' : `About ${formatFeet(item.climbFeet)} of climbing, going the harder way`);
  if (item.effort) facts.push(`Estimated effort: ${item.effort}, from length and climb only`);
  if (item.sac) facts.push(SAC_TEXT[item.sac]);
  if (item.imba !== undefined) facts.push(IMBA_TEXT[item.imba]);
  if (item.hardToSee) facts.push('Mapped as hard to see in places');
  if (item.dogs) facts.push(item.dogs === 'yes' ? 'Mapped as open to dogs' : 'Mapped as open to leashed dogs');
  if (item.wheelchair === 'yes') facts.push('Mapped as wheelchair accessible');
  if (item.wheelchair === 'no') facts.push('Mapped as not wheelchair accessible');
  return facts;
}

// An SVG path for the elevation sparkline, in a box of the given size.
export function profilePath(values, width, height) {
  const low = Math.min(...values);
  const span = Math.max(Math.max(...values) - low, 1);
  return values.map((value, index) => {
    const x = values.length > 1 ? (index * width) / (values.length - 1) : 0;
    const y = height - ((value - low) / span) * height;
    return `${index ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(' ');
}
