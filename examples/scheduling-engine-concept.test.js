/**
 * Tests for the scheduling-engine concept.
 * --------------------------------------------------------------------------
 * The README lists "automated test coverage for the scheduling engine" as a
 * known gap, noting that the engine's rule-exceptions "are exactly where
 * regressions hide". This suite pins down those exceptions.
 *
 * Zero dependencies — uses Node's built-in test runner.
 * Run: node --test   (or: node --test examples/)
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  config,
  agenda,
  toMin,
  toHHMM,
  isSlotAvailable,
  getAvailableSlots,
  findNearestSlot,
} = require('./scheduling-engine-concept');

// --- Time helpers ---------------------------------------------------------

test('toMin converts HH:MM to minutes since midnight', () => {
  assert.equal(toMin('00:00'), 0);
  assert.equal(toMin('09:00'), 540);
  assert.equal(toMin('18:30'), 1110);
});

test('toHHMM is the inverse of toMin', () => {
  assert.equal(toHHMM(0), '00:00');
  assert.equal(toHHMM(540), '09:00');
  assert.equal(toHHMM(1110), '18:30');
  for (const hhmm of ['09:00', '11:50', '14:45', '17:30']) {
    assert.equal(toHHMM(toMin(hhmm)), hhmm);
  }
});

// --- Working-hours edges (no buffer against opening/closing) --------------

test('a service may start exactly at opening time', () => {
  assert.equal(isSlotAvailable(toMin('09:00'), config, agenda), true);
});

test('a service may end exactly at closing time', () => {
  // 17:30 + 30min service = 18:00 closing, flush against close.
  assert.equal(isSlotAvailable(toMin('17:30'), config, agenda), true);
});

test('a service may not start before opening time', () => {
  assert.equal(isSlotAvailable(toMin('08:50'), config, agenda), false);
});

test('a service may not end after closing time', () => {
  // 17:40 + 30min = 18:10, past 18:00 close.
  assert.equal(isSlotAvailable(toMin('17:40'), config, agenda), false);
});

// --- Buffer applies only between confirmed bookings -----------------------

test('a slot overlapping a booking is rejected', () => {
  // 10:00–10:30 is booked.
  assert.equal(isSlotAvailable(toMin('10:00'), config, agenda), false);
});

test('a slot inside a booking buffer is rejected', () => {
  // 10:40 ends 11:10; the 10:00–10:30 booking buffers to 10:45.
  assert.equal(isSlotAvailable(toMin('10:40'), config, agenda), false);
});

test('a slot is valid once the booking buffer has cleared', () => {
  // 10:50 clears the 10:45 buffer and ends 11:20, flush against the block.
  assert.equal(isSlotAvailable(toMin('10:50'), config, agenda), true);
});

test('no buffer is applied against a blocked period', () => {
  // 11:20–11:50 is blocked; a service may start exactly when it ends.
  assert.equal(isSlotAvailable(toMin('11:50'), config, agenda), true);
});

test('a service may end flush against a blocked period (no buffer)', () => {
  // 10:50 + 30min = 11:20, exactly when the block starts — allowed.
  assert.equal(isSlotAvailable(toMin('10:50'), config, agenda), true);
});

test('a slot overlapping a blocked period is still rejected', () => {
  // 11:30 ends 12:00, overlapping the 11:20–11:50 block.
  assert.equal(isSlotAvailable(toMin('11:30'), config, agenda), false);
});

// --- getAvailableSlots ----------------------------------------------------

test('available slots respect every rule', () => {
  const slots = getAvailableSlots(config, agenda);

  // Sanity: known-good and known-bad members.
  assert.ok(slots.includes('09:00'), 'opening slot should be available');
  assert.ok(slots.includes('10:50'), 'post-buffer slot should be available');
  assert.ok(slots.includes('11:50'), 'flush-against-block slot should be available');
  assert.ok(slots.includes('17:30'), 'closing-edge slot should be available');

  assert.ok(!slots.includes('10:00'), 'booked time must not appear');
  assert.ok(!slots.includes('10:40'), 'buffered time must not appear');
  assert.ok(!slots.includes('11:30'), 'blocked time must not appear');
});

test('every returned slot is independently valid and within hours', () => {
  const open = toMin(config.workingHours.start);
  const close = toMin(config.workingHours.end);

  for (const slot of getAvailableSlots(config, agenda)) {
    const t = toMin(slot);
    assert.ok(isSlotAvailable(t, config, agenda), `${slot} should be valid`);
    assert.ok(t >= open, `${slot} should not start before opening`);
    assert.ok(t + config.serviceDuration <= close, `${slot} should end by closing`);
  }
});

// --- Nearest-slot suggestion ----------------------------------------------

test('an available requested time returns itself as an exact match', () => {
  const result = findNearestSlot('09:00', config, agenda);
  assert.deepEqual(result, { found: true, slot: '09:00', exact: true });
});

test('a taken requested time returns the nearest valid alternative', () => {
  // 14:00–14:45 is booked, buffered 13:45–15:00.
  const result = findNearestSlot('14:00', config, agenda);
  assert.equal(result.found, true);
  assert.equal(result.exact, false);
  assert.ok(['before', 'after'].includes(result.direction));
  assert.ok(result.distanceMin > 0);

  // The suggestion itself must be a genuinely valid slot.
  assert.equal(isSlotAvailable(toMin(result.slot), config, agenda), true);

  // And it must be the closest one — no available slot is nearer.
  const requested = toMin('14:00');
  for (const slot of getAvailableSlots(config, agenda)) {
    const d = Math.abs(toMin(slot) - requested);
    assert.ok(d >= result.distanceMin, `${slot} is closer than the suggestion`);
  }
});

test('reports failure when the day has no available slots', () => {
  // Block the entire working day.
  const fullDay = [{ start: '09:00', end: '18:00', type: 'blocked' }];
  assert.deepEqual(findNearestSlot('12:00', config, fullDay), { found: false });
});
