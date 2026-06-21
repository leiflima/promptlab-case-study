/**
 * Scheduling Engine — simplified concept
 * --------------------------------------
 * A didactic, self-contained version of the availability algorithm used in
 * PromptLab. The production engine adds team distribution, per-member
 * schedule fallbacks, absences, Google Calendar sync and realtime cache
 * invalidation — but the core ideas are all here:
 *
 *   1. Generate candidate slots from working hours
 *   2. Reject slots that collide with existing appointments
 *   3. Apply buffer time ONLY between confirmed bookings
 *      (never against blocked time or opening/closing hours)
 *   4. Suggest the nearest valid slot when the requested time is taken
 *
 * Run: node scheduling-engine-concept.js
 */

const SLOT_STEP = 10; // minutes between candidate start times

// --- Example business configuration -------------------------------------

const config = {
  workingHours: { start: '09:00', end: '18:00' },
  serviceDuration: 30, // minutes
  bufferTime: 15,      // minutes, between confirmed bookings only
};

// Existing agenda for the day. Two kinds of occupancy:
//  - 'booked'  → a confirmed appointment (buffer applies around it)
//  - 'blocked' → owner marked time as unavailable (NO buffer applies)
const agenda = [
  { start: '10:00', end: '10:30', type: 'booked' },
  { start: '11:20', end: '11:50', type: 'blocked' },
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

function isSlotAvailable(startMin, { workingHours, serviceDuration, bufferTime }, agenda) {
  const endMin = startMin + serviceDuration;

  // 1. Must fit inside working hours.
  //    No buffer against opening or closing time: the first service may
  //    start exactly at opening, the last may end exactly at closing.
  if (startMin < toMin(workingHours.start)) return false;
  if (endMin > toMin(workingHours.end)) return false;

  for (const item of agenda) {
    const itemStart = toMin(item.start);
    const itemEnd = toMin(item.end);

    // 2. Buffer applies only between confirmed bookings.
    //    A service may start or end flush against a blocked period.
    const gap = item.type === 'booked' ? bufferTime : 0;

    // 3. Overlap test with the (possibly zero) buffer applied.
    const overlaps = startMin < itemEnd + gap && endMin > itemStart - gap;
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
// "14:00 is taken — but I have 13:00 or 15:00. Does either work?"

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

// --- Exports --------------------------------------------------------------
// Exported so the rule-exceptions can be covered by automated tests
// (see scheduling-engine-concept.test.js).

module.exports = {
  SLOT_STEP,
  config,
  agenda,
  toMin,
  toHHMM,
  isSlotAvailable,
  getAvailableSlots,
  findNearestSlot,
};

// --- Demo -----------------------------------------------------------------
// Only runs when the file is executed directly (`node scheduling-engine-concept.js`),
// not when it is imported by the test suite.

if (require.main === module) {
  console.log('Available slots:', getAvailableSlots(config, agenda).join(', '));

  // Buffer behaviour: 10:30–10:45 is buffered (after a booking)…
  console.log('\n10:40 valid?', isSlotAvailable(toMin('10:40'), config, agenda)); // false — inside buffer
  console.log('10:50 valid?', isSlotAvailable(toMin('10:50'), config, agenda));   // true — buffer cleared, ends flush against the 11:20 block

  // …but a service may start exactly when a blocked period ends (no buffer):
  console.log('11:50 valid?', isSlotAvailable(toMin('11:50'), config, agenda));   // true

  // Nearest-slot suggestion for a taken time:
  console.log('\nCustomer asks for 14:00 →', findNearestSlot('14:00', config, agenda));
}
