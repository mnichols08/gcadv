// Virtual checkpoints: real places you check in at by GPS, with nothing placed on the ground.
// Pure, so the arrival rules can be tested without walking to a waterfall.
import { distanceMiles, FEET_PER_MILE } from './geo.js';

export const WORST_ACCURACY_FEET = 165; // Matches what the tracker trusts.
const MAX_ERROR_ALLOWANCE_FEET = 50; // Tree cover and canyons blur GPS, so give some benefit of the doubt.
export const STALE_SECONDS = 30;

export function arrivalCheck(checkpoint, fix, ageSeconds = 0) {
  if (!fix) return { status: 'no-fix', feet: null };
  const feet = distanceMiles(fix, checkpoint) * FEET_PER_MILE;
  if (ageSeconds > STALE_SECONDS) return { status: 'stale', feet };
  if (fix.accFeet > WORST_ACCURACY_FEET) return { status: 'weak', feet };
  const reach = checkpoint.radiusFeet + Math.min(fix.accFeet, MAX_ERROR_ALLOWANCE_FEET);
  return { status: feet <= reach ? 'here' : 'far', feet };
}

// The unreached checkpoint the hiker has just arrived at, if any.
export function arrivedAt(checkpoints, checkins, fix, ageSeconds = 0) {
  const reached = new Set(checkins.map(checkin => checkin.id));
  let best = null;
  for (const checkpoint of checkpoints) {
    if (reached.has(checkpoint.id)) continue;
    const { status, feet } = arrivalCheck(checkpoint, fix, ageSeconds);
    if (status === 'here' && (!best || feet < best.feet)) best = { checkpoint, feet };
  }
  return best?.checkpoint || null;
}

export function progress(checkpoints, checkins) {
  const known = new Set(checkpoints.map(checkpoint => checkpoint.id));
  const reached = new Set(checkins.map(checkin => checkin.id).filter(id => known.has(id))).size;
  return { reached, total: checkpoints.length, complete: checkpoints.length > 0 && reached === checkpoints.length };
}

export function groupCheckpoints(checkpoints) {
  const groups = new Map();
  for (const checkpoint of checkpoints) {
    if (!groups.has(checkpoint.group)) groups.set(checkpoint.group, []);
    groups.get(checkpoint.group).push(checkpoint);
  }
  return [...groups].map(([name, list]) => ({ name, checkpoints: list }));
}

export const progressText = ({ reached, total, complete }) => (complete ? `All ${total} reached. Nicely done.` : `${reached} of ${total} reached.`);
