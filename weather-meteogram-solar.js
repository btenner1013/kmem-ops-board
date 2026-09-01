const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTES_PER_DAY = 24 * 60;
const RAD = Math.PI / 180;
const JULIAN_UNIX_EPOCH = 2440587.5;
const JULIAN_2000 = 2451545;
const STANDARD_SUNRISE_ZENITH_DEG = 90.833;

export const KMEM_SOLAR_LOCATION = Object.freeze({
  station: "KMEM",
  latitude: 35.0424,
  longitude: -89.9767,
  timeZone: "America/Chicago",
});

function validDate(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function stationLocation(station) {
  return String(station || "KMEM").trim().toUpperCase() === KMEM_SOLAR_LOCATION.station
    ? KMEM_SOLAR_LOCATION
    : null;
}

function normalizeDegrees(value) {
  return ((value % 360) + 360) % 360;
}

function julianCentury(julianDay) {
  return (julianDay - JULIAN_2000) / 36525;
}

function geometricMeanLongitude(century) {
  return normalizeDegrees(280.46646 + century * (36000.76983 + century * 0.0003032));
}

function geometricMeanAnomaly(century) {
  return 357.52911 + century * (35999.05029 - 0.0001537 * century);
}

function earthOrbitEccentricity(century) {
  return 0.016708634 - century * (0.000042037 + 0.0000001267 * century);
}

function sunEquationOfCenter(century) {
  const anomalyRad = geometricMeanAnomaly(century) * RAD;
  return Math.sin(anomalyRad) * (1.914602 - century * (0.004817 + 0.000014 * century))
    + Math.sin(2 * anomalyRad) * (0.019993 - 0.000101 * century)
    + Math.sin(3 * anomalyRad) * 0.000289;
}

function sunApparentLongitude(century) {
  const trueLongitude = geometricMeanLongitude(century) + sunEquationOfCenter(century);
  const omega = 125.04 - 1934.136 * century;
  return trueLongitude - 0.00569 - 0.00478 * Math.sin(omega * RAD);
}

function meanObliquityOfEcliptic(century) {
  const seconds = 21.448 - century * (46.815 + century * (0.00059 - century * 0.001813));
  return 23 + (26 + seconds / 60) / 60;
}

function correctedObliquity(century) {
  const omega = 125.04 - 1934.136 * century;
  return meanObliquityOfEcliptic(century) + 0.00256 * Math.cos(omega * RAD);
}

function solarDeclination(century) {
  const obliquityRad = correctedObliquity(century) * RAD;
  const longitudeRad = sunApparentLongitude(century) * RAD;
  return Math.asin(Math.sin(obliquityRad) * Math.sin(longitudeRad)) / RAD;
}

function equationOfTimeMinutes(century) {
  const obliquityRad = correctedObliquity(century) * RAD;
  const longitudeRad = geometricMeanLongitude(century) * RAD;
  const anomalyRad = geometricMeanAnomaly(century) * RAD;
  const eccentricity = earthOrbitEccentricity(century);
  const y = Math.tan(obliquityRad / 2) ** 2;
  const equation = y * Math.sin(2 * longitudeRad)
    - 2 * eccentricity * Math.sin(anomalyRad)
    + 4 * eccentricity * y * Math.sin(anomalyRad) * Math.cos(2 * longitudeRad)
    - 0.5 * y * y * Math.sin(4 * longitudeRad)
    - 1.25 * eccentricity * eccentricity * Math.sin(2 * anomalyRad);
  return 4 * equation / RAD;
}

function sunriseHourAngleDeg(latitude, declination) {
  const latitudeRad = latitude * RAD;
  const declinationRad = declination * RAD;
  const cosine = (
    Math.cos(STANDARD_SUNRISE_ZENITH_DEG * RAD)
    / (Math.cos(latitudeRad) * Math.cos(declinationRad))
  ) - Math.tan(latitudeRad) * Math.tan(declinationRad);
  if (cosine < -1 || cosine > 1) return null;
  return Math.acos(cosine) / RAD;
}

function eventMinutesUtc(julianDay, location, type) {
  let minutes = 720 - 4 * location.longitude;
  for (let pass = 0; pass < 3; pass += 1) {
    const century = julianCentury(julianDay + minutes / MINUTES_PER_DAY);
    const hourAngle = sunriseHourAngleDeg(location.latitude, solarDeclination(century));
    if (hourAngle === null) return null;
    const signedHourAngle = type === "sunrise" ? hourAngle : -hourAngle;
    minutes = 720 - 4 * (location.longitude + signedHourAngle) - equationOfTimeMinutes(century);
  }
  return minutes;
}

function utcCalendarDateParts(date) {
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function localCalendarDateParts(date, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
  };
}

function calendarDateKey({ year, month, day }) {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function solarTimesForCalendarDate(parts, location) {
  const utcMidnightMs = Date.UTC(parts.year, parts.month - 1, parts.day);
  const julianDay = utcMidnightMs / DAY_MS + JULIAN_UNIX_EPOCH;
  const sunriseMinutes = eventMinutesUtc(julianDay, location, "sunrise");
  const sunsetMinutes = eventMinutesUtc(julianDay, location, "sunset");
  if (sunriseMinutes === null || sunsetMinutes === null) return null;
  const sunriseMs = Math.round((utcMidnightMs + sunriseMinutes * 60 * 1000) / 1000) * 1000;
  const sunsetMs = Math.round((utcMidnightMs + sunsetMinutes * 60 * 1000) / 1000) * 1000;
  return {
    localDate: calendarDateKey(parts),
    sunrise: new Date(sunriseMs),
    sunset: new Date(sunsetMs),
  };
}

function calendarDatesAroundRange(start, end, timeZone) {
  const startLocal = localCalendarDateParts(start, timeZone);
  const endLocal = localCalendarDateParts(end, timeZone);
  const firstDayMs = Date.UTC(startLocal.year, startLocal.month - 1, startLocal.day - 1);
  const lastDayMs = Date.UTC(endLocal.year, endLocal.month - 1, endLocal.day + 1);
  const dates = [];
  for (let dayMs = firstDayMs; dayMs <= lastDayMs; dayMs += DAY_MS) {
    dates.push(utcCalendarDateParts(new Date(dayMs)));
  }
  return dates;
}

export function meteogramSolarPhase(value, { station = "KMEM" } = {}) {
  const date = validDate(value);
  const location = stationLocation(station);
  if (!date || !location) return null;
  const localDate = localCalendarDateParts(date, location.timeZone);
  const times = solarTimesForCalendarDate(localDate, location);
  if (!times) return null;
  const timestamp = date.getTime();
  return timestamp >= times.sunrise.getTime() && timestamp < times.sunset.getTime() ? "day" : "night";
}

export function meteogramSolarEvents(startValue, endValue, { station = "KMEM" } = {}) {
  const start = validDate(startValue);
  const end = validDate(endValue);
  const location = stationLocation(station);
  if (!start || !end || !location || end.getTime() < start.getTime()) return [];

  const startMs = start.getTime();
  const endMs = end.getTime();
  const events = [];
  const seen = new Set();
  for (const calendarDate of calendarDatesAroundRange(start, end, location.timeZone)) {
    const times = solarTimesForCalendarDate(calendarDate, location);
    if (!times) continue;
    for (const type of ["sunrise", "sunset"]) {
      const epochMs = times[type].getTime();
      if (epochMs < startMs || epochMs > endMs) continue;
      const key = `${type}:${epochMs}`;
      if (seen.has(key)) continue;
      seen.add(key);
      events.push({
        type,
        timestamp: times[type].toISOString(),
        epochMs,
        localDate: times.localDate,
      });
    }
  }
  return events.sort((left, right) => left.epochMs - right.epochMs);
}
