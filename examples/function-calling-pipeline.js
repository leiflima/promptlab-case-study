/**
 * Function-calling pipeline — simplified concept
 * ----------------------------------------------
 * A didactic, self-contained version of how PromptLab's WhatsApp assistant
 * turns a conversation into a *validated* booking. The production pipeline
 * supports two provider formats — DeepSeek's `tool_calls` and Claude's
 * `tool_use` blocks — plus multimodal routing, kill switches and graceful
 * provider fallback. The core idea is all here:
 *
 *   The AI never writes to the database. It only *calls tools*.
 *   The server executes each tool, RE-VALIDATES at write time, and is the
 *   single source of truth for identity (phone/user) and for what is real.
 *
 * Run: node function-calling-pipeline.js
 */

// --- 1. The tools the model is allowed to call ---------------------------
// Typed schemas are handed to the LLM. The model fills the arguments; it
// never executes anything itself — it can only *request* a tool.
const TOOLS = [
  {
    name: 'check_availability',
    description: 'Is a date/time free, and which staff are free?',
    parameters: { date: 'YYYY-MM-DD', time: 'HH:MM', service: 'string?' },
  },
  {
    name: 'book_appointment',
    description: 'Create a confirmed appointment (only after the customer confirms).',
    parameters: { date: 'YYYY-MM-DD', time: 'HH:MM', service: 'string?', collaborator: 'string?' },
  },
  {
    name: 'cancel_appointment',
    description: "Cancel one of THIS customer's upcoming appointments.",
    parameters: { date: 'YYYY-MM-DD', time: 'HH:MM' },
  },
  // …reschedule_appointment, find_slots, list_client_appointments omitted for brevity.
];

// --- 2. The server-side executors (the authority) ------------------------
// Note what the model does NOT control: the customer's identity. `ctx` comes
// from the authenticated WhatsApp connection, never from tool arguments.

const db = []; // stands in for the appointments table

const checkAvailability = (date, time) =>
  !db.some((a) => a.date === date && a.time === time);

function executeTool(name, args, ctx) {
  switch (name) {
    case 'check_availability':
      return { available: checkAvailability(args.date, args.time) };

    case 'book_appointment': {
      // SAFETY GUARD: re-validate at write time, even though the model probably
      // called check_availability a moment ago. The slot may have filled in the
      // meantime (a concurrent booking) — the write must still be safe.
      if (!checkAvailability(args.date, args.time))
        return { success: false, reason: 'slot_unavailable' };

      // Duplicate guard: same customer, same slot.
      if (db.some((a) => a.phone === ctx.phone && a.date === args.date && a.time === args.time))
        return { success: false, reason: 'duplicate' };

      // Identity comes from `ctx` — NEVER from `args`. A model cannot book or
      // cancel on behalf of a phone number it places in its own arguments.
      const row = { phone: ctx.phone, date: args.date, time: args.time, service: args.service || null };
      db.push(row);
      return { success: true, appointment: row };
    }

    case 'cancel_appointment': {
      const i = db.findIndex((a) => a.phone === ctx.phone && a.date === args.date && a.time === args.time);
      if (i === -1) return { success: false, reason: 'not_found' };
      db.splice(i, 1);
      return { success: true };
    }

    default:
      return { error: 'unknown_tool' };
  }
}

// --- 3. The agent loop ---------------------------------------------------
// Send the conversation + tools to the model. While the model returns
// tool_calls, execute them server-side and feed the results back. Stop when
// the model returns a plain-text reply for the customer.

async function runConversation(callModel, ctx, userMessage) {
  const messages = [{ role: 'user', content: userMessage }];

  for (let turn = 0; turn < 6; turn++) {            // bounded: never loop forever
    const reply = await callModel(messages, TOOLS);

    if (!reply.toolCalls || reply.toolCalls.length === 0) {
      return reply.text;                            // model is done → answer the customer
    }

    messages.push({ role: 'assistant', toolCalls: reply.toolCalls });
    for (const call of reply.toolCalls) {
      const result = executeTool(call.name, call.args, ctx); // the server decides
      messages.push({ role: 'tool', name: call.name, content: JSON.stringify(result) });
    }
  }
  return 'Sorry — I could not complete that. Could you try again?';
}

// --- 4. Demo with a scripted "model" -------------------------------------
// A fake model that checks then books 2026-07-01 at 15:00, to show the loop
// end to end. In production this is DeepSeek V4 Flash or Claude, via their
// real tool-use APIs.

async function fakeModel(messages) {
  const toolResults = messages.filter((m) => m.role === 'tool').length;
  if (toolResults === 0)
    return { toolCalls: [{ name: 'check_availability', args: { date: '2026-07-01', time: '15:00' } }] };
  if (toolResults === 1)
    return { toolCalls: [{ name: 'book_appointment', args: { date: '2026-07-01', time: '15:00', service: 'Haircut' } }] };
  return { text: "All set — you're booked for 1 July at 15:00. See you then!" };
}

(async () => {
  const ctx = { phone: '+351912345678' };           // from the authenticated connection

  const answer = await runConversation(fakeModel, ctx, 'Can I get a haircut tomorrow at 3pm?');
  console.log('Assistant →', answer);
  console.log('Database  →', db);

  // A model that *claims* to have booked, without calling the tool, changes nothing:
  const liar = async () => ({ text: 'Done — you are booked!' });
  await runConversation(liar, ctx, 'just book me anything');
  console.log('After a model that only *claims* to book →', db.length, 'appointment(s) — unchanged');
})();
