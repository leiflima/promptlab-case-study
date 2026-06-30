/**
 * Scheduling Engine — simplified concept
 * --------------------------------------
 * A didactic, self-contained version of the availability algorithm used in
 * PromptLab. The production engine adds team distribution, per-member
 * schedule fallback, absences, Google Calendar sync and realtime cache
 * invalidation — but the core ideas are all here:
 *
 *   1. Generate candidate start times on a fixed grid, inside working hours
 *   2. Reject any start that collides with an occupied interval
 *   3. Bookings are back-to-back: a service may start or end FLUSH against
 *      another booking, a blocked period, or the opening/closing edge
 *   4. The last bookable start depends on the duration of the requested service
 *   5. Suggest the nearest valid slot when the requested time is taken
 *
 * Run: node scheduling-engine-concept.js
 */

const SLOT_STEP = 30; // minutes — the booking grid

// --- Example business configuration -------------------------------------

const config = {
  workingHours: { start: '09:00', end: '18:00' },
  serviceDuration: 30, // minutes (comes from the requested service in production)
};

// The day's occupancy. Confirmed bookings and manually-blocked time are
// treated identically for collision — bookings sit back-to-back on the grid.
const agenda = [
  { start: '10:00', end: '10:30', type: 'booked' },
  { start: '11:00', end: '12:00', type: 'blocked' }, // e.g. the lunch block
  { start: '14:00', end: '14:45', type: 'booked' },
];

// --- Time helpers --------------------------------------------------------

const toMin = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

const toHHMM = (min) =>
  `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

// --- Core: is a given start time valid? ----------------------------------

function isSlotAvailable(startMin, { workingHours, serviceDuration }, agenda) {
  const endMin = startMin + serviceDuration;

  // 1. Must fit inside working hours. A service may end exactly at closing,
  //    or start exactly at opening — the edges are inclusive.
  if (startMin < toMin(workingHours.start)) return false;
  if (endMin > toMin(workingHours.end)) return false;

  // 2. No overlap with any occupied interval. Touching edges is allowed:
  //    a service may start the moment a booking or a block ends.
  for (const item of agenda) {
    const overlaps = startMin < toMin(item.end) && endMin > toMin(item.start);
    if (overlaps) return false;
  }

  return true;
}

// --- Generate all available slots for the day ----------------------------

function getAvailableSlots(config, agenda) {
  const open = toMin(config.workingHours.start);
  const close = toMin(config.workingHours.end);
  const slots = [];

  for (let t = open; t + config.serviceDuration <= close; t += SLOT_STEP) {
    if (isSlotAvailable(t, config, agenda)) slots.push(toHHMM(t));
  }
  return slots;
}

// --- Nearest-slot suggestion ---------------------------------------------
// When a customer asks for a taken time, a flat "no" kills the booking.
// Instead, find the closest valid alternative so the AI can counter-offer:
// "14:00 is taken — but I have 13:30 or 15:00. Does either work?"

function findNearestSlot(requestedHHMM, config, agenda) {
  const requested = toMin(requestedHHMM);

  if (isSlotAvailable(requested, config, agenda)) {
    return { found: true, slot: requestedHHMM, exact: true };
  }

  const available = getAvailableSlots(config, agenda).map(toMin);
  if (available.length === 0) return { found: false };

  const nearest = available.reduce((best, t) =>
    Math.abs(t - requested) < Math.abs(best - requested) ? t : best
  );

  return {
    found: true,
    slot: toHHMM(nearest),
    exact: false,
    direction: nearest < requested ? 'before' : 'after',
    distanceMin: Math.abs(nearest - requested),
  };
}

// --- Demo -----------------------------------------------------------------

console.log('Available slots:', getAvailableSlots(config, agenda).join(', '));

// Back-to-back: a service may start the moment another ends.
console.log('\n10:30 valid?', isSlotAvailable(toMin('10:30'), config, agenda)); // true — flush against the 10:00–10:30 booking
console.log('12:00 valid?', isSlotAvailable(toMin('12:00'), config, agenda));   // true — starts exactly when the block ends

// A start that would overlap an occupied interval is rejected:
console.log('11:30 valid?', isSlotAvailable(toMin('11:30'), config, agenda));   // false — inside the 11:00–12:00 block

// Nearest-slot suggestion for a taken time:
console.log('\nCustomer asks for 14:00 →', findNearestSlot('14:00', config, agenda));
