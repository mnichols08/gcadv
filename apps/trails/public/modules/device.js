// Thin wrappers over the phone's sensors. Metres become feet here and go no further.
import { FEET_PER_METER } from './geo.js';

export function fixFromPosition({ coords, timestamp }) {
  const feet = value => (value === null || value === undefined ? null : value * FEET_PER_METER);
  return {
    lat: coords.latitude,
    lon: coords.longitude,
    t: timestamp,
    accFeet: feet(coords.accuracy),
    altFeet: feet(coords.altitude),
    altAccFeet: feet(coords.altitudeAccuracy),
    courseDegrees: coords.heading ?? null,
    mph: coords.speed === null || coords.speed === undefined ? null : coords.speed * 2.23694,
  };
}

export function watchGps(onFix, onError) {
  const id = navigator.geolocation.watchPosition(
    position => onFix(fixFromPosition(position)),
    onError,
    { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 },
  );
  return () => navigator.geolocation.clearWatch(id);
}

// Without this the screen sleeps, and browsers stop reporting location soon after.
export function createScreenLock(onChange) {
  let sentinel = null;
  let wanted = false;
  async function acquire() {
    if (!wanted || sentinel || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
    try {
      sentinel = await navigator.wakeLock.request('screen');
      onChange(true);
      sentinel.addEventListener('release', () => {
        sentinel = null;
        onChange(false);
      });
    } catch {
      onChange(false);
    }
  }
  document.addEventListener('visibilitychange', acquire);
  return {
    supported: 'wakeLock' in navigator,
    hold() {
      wanted = true;
      return acquire();
    },
    release() {
      wanted = false;
      sentinel?.release();
    },
  };
}

// Roughly right for western Maryland and the Potomac basin in 2026. Phones report magnetic
// north; map bearings are true north. A wider release needs the World Magnetic Model.
export const REGION_DECLINATION_DEGREES = -9.5;

export const trueHeading = magneticDegrees => (magneticDegrees + REGION_DECLINATION_DEGREES + 360) % 360;

export const compassNeedsPermission = () => typeof DeviceOrientationEvent?.requestPermission === 'function';

export async function startCompass(onHeading) {
  if (typeof DeviceOrientationEvent === 'undefined') return false;
  if (compassNeedsPermission()) {
    try {
      if ((await DeviceOrientationEvent.requestPermission()) !== 'granted') return false;
    } catch {
      return false;
    }
  }
  const listener = event => {
    if (Number.isFinite(event.webkitCompassHeading)) onHeading(trueHeading(event.webkitCompassHeading));
    else if (event.absolute && Number.isFinite(event.alpha)) onHeading(trueHeading(360 - event.alpha));
  };
  window.addEventListener('deviceorientationabsolute', listener);
  window.addEventListener('deviceorientation', listener);
  return true;
}
