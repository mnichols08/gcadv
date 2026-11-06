// Turns the noisy stream of GPS fixes into a recorded route. No DOM or storage here: stats
// are always derivable by replaying saved points, so a killed browser loses nothing.
import { distanceFeet, FEET_PER_MILE } from './geo.js';

export const RULES = {
  worstAccuracyFeet: 165, // Coarser fixes still move the dot but never join the route.
  sameSpotFeet: 3, // Closer than this to the last fix adds nothing to the record.
  minStepFeet: 10, // Distance only grows past this, so jitter can't inflate the miles.
  accuracyStepShare: 0.6, // A step must beat this share of the fix's error circle.
  fastestMph: 20, // Faster than this is a GPS spike until proven otherwise.
  spikeConfirmations: 3,
  spikeAgreeFeet: 200,
  gapSeconds: 120, // No fixes at all for this long means the phone stopped reporting.
  movingMph: 0.3,
  worstAltitudeAccuracyFeet: 100,
  climbStepFeet: 30, // Hysteresis: GPS altitude wanders, so small swings are not climbing.
};

export const emptyStats = () => ({
  miles: 0,
  movingSeconds: 0,
  gainFeet: 0,
  lossFeet: 0,
  highFeet: null,
  lowFeet: null,
  untrackedSeconds: 0,
  gaps: 0,
  anchorFeet: null,
  last: null,
  distanceAnchor: null,
});

export function addToStats(stats, point) {
  const anchor = stats.distanceAnchor;
  if (!anchor || anchor.seg !== point.seg) {
    stats.distanceAnchor = point;
  } else {
    const feet = distanceFeet(anchor, point);
    if (feet >= Math.max(RULES.minStepFeet, (point.accFeet || 0) * RULES.accuracyStepShare)) {
      const seconds = (point.t - anchor.t) / 1000;
      stats.miles += feet / FEET_PER_MILE;
      if (seconds > 0 && feet / FEET_PER_MILE / (seconds / 3600) >= RULES.movingMph) stats.movingSeconds += seconds;
      stats.distanceAnchor = point;
    }
  }
  if (point.gapSeconds) {
    stats.untrackedSeconds += point.gapSeconds;
    stats.gaps += 1;
  }
  if (point.altFeet !== null && point.altFeet !== undefined) {
    stats.highFeet = stats.highFeet === null ? point.altFeet : Math.max(stats.highFeet, point.altFeet);
    stats.lowFeet = stats.lowFeet === null ? point.altFeet : Math.min(stats.lowFeet, point.altFeet);
    if (stats.anchorFeet === null) {
      stats.anchorFeet = point.altFeet;
    } else if (point.altFeet - stats.anchorFeet >= RULES.climbStepFeet) {
      stats.gainFeet += point.altFeet - stats.anchorFeet;
      stats.anchorFeet = point.altFeet;
    } else if (stats.anchorFeet - point.altFeet >= RULES.climbStepFeet) {
      stats.lossFeet += stats.anchorFeet - point.altFeet;
      stats.anchorFeet = point.altFeet;
    }
  }
  stats.last = point;
  return stats;
}

export function summarize(points) {
  return points.reduce(addToStats, emptyStats());
}

// The points worth drawing: the same jitter-free path the distance is measured along.
export function routeLine(points) {
  const stats = emptyStats();
  const line = [];
  for (const point of points) {
    addToStats(stats, point);
    if (stats.distanceAnchor === point) line.push(point);
  }
  return line;
}

// One spot from many readings, trusting the sharper ones more. Readings that wander far from
// the first belong to someone who has started walking again.
export function averagePosition(readings, agreeFeet = 30) {
  const usable = readings.filter(reading => reading.accFeet <= RULES.worstAccuracyFeet);
  if (!usable.length) return null;
  const first = usable[0];
  const near = usable.filter(reading => distanceFeet(first, reading) <= agreeFeet);
  let weight = 0;
  let lat = 0;
  let lon = 0;
  for (const reading of near) {
    const share = 1 / Math.max(1, reading.accFeet) ** 2;
    weight += share;
    lat += reading.lat * share;
    lon += reading.lon * share;
  }
  const altitudes = near.map(reading => reading.altFeet).filter(Number.isFinite);
  return {
    lat: lat / weight,
    lon: lon / weight,
    count: near.length,
    bestFeet: Math.min(...near.map(reading => reading.accFeet)),
    altFeet: altitudes.length ? altitudes.reduce((sum, value) => sum + value, 0) / altitudes.length : null,
  };
}

export function createRecorder(saved = []) {
  const points = [...saved];
  const line = routeLine(points);
  const stats = summarize(points);
  let last = points.at(-1) || null;
  let seg = last ? last.seg : 0;
  let lastFixAt = last ? last.t : null;
  let breakPending = false;
  let pendingGap = 0;
  let spikes = [];

  function record(fix, altFeet, startNewSegment) {
    if (startNewSegment) seg += last ? 1 : 0;
    const point = { seq: points.length, seg, lat: fix.lat, lon: fix.lon, t: fix.t, accFeet: Math.round(fix.accFeet), altFeet };
    if (pendingGap) point.gapSeconds = pendingGap;
    pendingGap = 0;
    breakPending = false;
    spikes = [];
    points.push(point);
    addToStats(stats, point);
    if (stats.distanceAnchor === point) line.push(point);
    last = point;
    return { status: 'recorded', point };
  }

  return {
    points,
    line,
    stats,
    // Fixes are { lat, lon, t, accFeet, altFeet, altAccFeet }.
    offer(fix) {
      if (lastFixAt !== null && fix.t - lastFixAt > RULES.gapSeconds * 1000) {
        pendingGap += Math.round((fix.t - lastFixAt) / 1000);
        breakPending = true;
      }
      lastFixAt = fix.t;
      if (fix.accFeet > RULES.worstAccuracyFeet) return { status: 'inaccurate' };
      const altitudeUsable = Number.isFinite(fix.altFeet) && (!Number.isFinite(fix.altAccFeet) || fix.altAccFeet <= RULES.worstAltitudeAccuracyFeet);
      const altFeet = altitudeUsable ? Math.round(fix.altFeet) : null;
      if (!last || breakPending) return record(fix, altFeet, true);

      const feet = distanceFeet(last, fix);
      const seconds = (fix.t - last.t) / 1000;
      if (seconds <= 0) return { status: 'still' };
      const mph = feet / FEET_PER_MILE / (seconds / 3600);
      if (mph > RULES.fastestMph && feet > 2 * fix.accFeet) {
        spikes.push(fix);
        const agreed = spikes.length >= RULES.spikeConfirmations && spikes.every(spike => distanceFeet(spike, fix) <= RULES.spikeAgreeFeet);
        if (agreed) return record(fix, altFeet, true);
        if (spikes.length >= RULES.spikeConfirmations) spikes = spikes.slice(1);
        return { status: 'jump' };
      }
      spikes = [];
      if (feet < RULES.sameSpotFeet) return { status: 'still' };
      return record(fix, altFeet, false);
    },
    // The route does not connect across a pause.
    pause() {
      breakPending = true;
      lastFixAt = null;
    },
    resume() {
      breakPending = true;
      lastFixAt = null;
    },
  };
}

export function elapsedSeconds(hike, now) {
  const end = hike.endedAt || (hike.pausedAt ?? now);
  return Math.max(0, (end - hike.startedAt) / 1000 - (hike.pausedSeconds || 0));
}
