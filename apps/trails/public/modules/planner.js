// A short list for someone staying in one town. Pure. Distances are straight lines, because driving
// routes aren't known offline, and the app says so wherever they appear.
import { ACTIVITIES, activityById, matchesActivity } from './activities.js';
import { distanceMiles } from './geo.js';

export const TRAILS_PER_ACTIVITY = 3;
export const NEARBY_MILES = 40;
const MIN_TRAIL_MILES = 0.5; // Stubs and connectors aren't a reason to drive somewhere.

const SNOW_ACTIVITIES = new Set(['ski', 'snowshoe', 'snowmobile']);
const SNOW_MONTHS = new Set([11, 0, 1, 2]); // December through March.

export const isSnowSeason = month => SNOW_MONTHS.has(month);

// Puts what's likely in season first. It says nothing about actual snow or trail conditions.
export function seasonalActivities(month) {
  const snowFirst = isSnowSeason(month);
  const rank = ({ id }) => (SNOW_ACTIVITIES.has(id) === snowFirst ? 0 : 1);
  return [...ACTIVITIES].sort((a, b) => rank(a) - rank(b));
}

export function nearestFirst(entries, place, pointOf = entry => entry) {
  return entries
    .map(entry => ({ entry, miles: distanceMiles(place, pointOf(entry)) }))
    .sort((a, b) => a.miles - b.miles);
}

// Listed under an activity only if the entry names it. An entry naming nothing is general information.
const coversActivity = (entry, id) => (entry.activities || []).includes(id);

export function nearbyDirectory(entries, place, id = null, limit = 3, withinMiles = NEARBY_MILES) {
  const wanted = id ? entries.filter(entry => coversActivity(entry, id)) : entries;
  return nearestFirst(wanted, place).filter(({ miles }) => miles <= withinMiles).slice(0, limit);
}

export function planTrip({ stay, activityIds, routes, outfitters = [], official = [], guides = [] }) {
  const sections = activityIds.map(activityById).filter(Boolean).map(activity => {
    const matching = routes.filter(route => matchesActivity(route.activities, activity));
    const substantial = matching.filter(route => route.miles >= MIN_TRAIL_MILES);
    return {
      activity,
      trails: nearestFirst(substantial.length ? substantial : matching, stay, route => route.center)
        .filter(({ miles }) => miles <= NEARBY_MILES)
        .slice(0, TRAILS_PER_ACTIVITY),
      outfitters: nearbyDirectory(outfitters, stay, activity.id),
      official: nearbyDirectory(official, stay, activity.id),
    };
  });
  return {
    sections,
    general: nearbyDirectory(official.filter(entry => !entry.activities?.length), stay, null, 3),
    guides: guides.filter(guide => guide.counties.includes(stay.county)),
  };
}
