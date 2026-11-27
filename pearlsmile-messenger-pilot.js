const { randomUUID } = require("node:crypto");

const cebuClock = new Intl.DateTimeFormat("en-PH", {
  timeZone: "Asia/Manila", weekday: "long", month: "long", day: "numeric",
  hour: "numeric", minute: "2-digit"
});
const cebuDate = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Manila", dateStyle: "short" });
const cebuTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Manila", hourCycle: "h23", hour: "2-digit", minute: "2-digit"
});
const confirmation = /^(?:yes(?:[, ]+(?:please|book it|confirm|please do))?|confirm(?: booking)?|please do|book it|go ahead)[.!\s]*$/i;
const decline = /^(?:no(?:,? thanks)?|cancel|start over|not now)[.!\s]*$/i;
const label = start => cebuClock.format(new Date(start));

function draft(reply, state = {}) {
  return { intent: "answer", reply, calendarPilot: state };
}

function requestConfirmation(start) {
  return draft(`I can do ${label(start)}, Cebu time. Shall I book the 30-minute test consultation? Reply Yes to book.`,
    { pending: start, requestId: randomUUID() });
}

function createPearlSmileMessengerPilot({ pageId, target, calendar }) {
  function matches(page, route) {
    return Boolean(calendar?.enabled && pageId && page === pageId &&
      route.account_id === target.accountId && route.location_id === target.locationId);
  }

  async function respond({ text, preference, previous, previousSent }) {
    const { pending, requestId, confirmed, offers = [], retry } = previous || {};
    if (confirmed) {
      return draft(`Your test consultation is confirmed for ${label(confirmed)}, Cebu time.`, { confirmed });
    }
    if (pending && (retry || confirmation.test(text))) {
      if (!confirmation.test(text) || !previousSent) {
        return draft(`Reply Yes to check the reservation for ${label(pending)}, Cebu time.`, previous);
      }
      try {
        const result = await calendar.book(pending, requestId, "facebook_messenger");
        if (result.status !== "CONFIRMED" || result.start !== pending) throw Error("Unconfirmed reservation");
        return draft(`Confirmed! Your 30-minute test consultation is on ${label(pending)}, Cebu time.`,
          { confirmed: pending });
      } catch (error) {
        if (error.status !== 409) {
          return draft("I couldn’t confirm that reservation yet. Reply Yes to retry the same time.",
            { pending, requestId, retry: true });
        }
        return alternatives({ date: cebuDate.format(new Date(pending)), unavailable: true });
      }
    }
    if (decline.test(text)) return draft("Of course. No appointment has been requested. Message me when you’d like to check times.");
    const { date, time, invalid } = preference;
    if (invalid) return draft("Which single date works for you? You can send the date and time together.");
    const option = /^(?:(?:i(?:'ll|’ll| will) (?:take|choose) (?:the )?)|(?:option ))?(first|second|one|two|1|2)(?: option)?[.!\s]*$/i.exec(text)?.[1]?.toLowerCase();
    if (option && offers.length && previousSent) {
      const start = offers[/^(first|one|1)$/.test(option) ? 0 : 1];
      if (start) return requestConfirmation(start);
      return draft("Only the first option was offered. Would you like that time? Reply ‘first’ to choose it.", { offers });
    }
    if (!date && !time && !/\b(book|booking|available|availability|consultation|appointment|days|times|slots)\b/i.test(text)) {
      return draft("Hi po, I can help you book a fictional initial consultation. What day would work for you?", { offers });
    }
    if (!date && time && offers.length && previousSent) {
      const matching = offers.filter(start => cebuTime.format(new Date(start)) === time);
      if (matching.length === 1) return requestConfirmation(matching[0]);
      if (matching.length > 1) return draft("That time is available on more than one day. Which date works for you?", { offers });
    }
    return alternatives({ date, time });
  }

  async function alternatives({ date, time, unavailable = false }) {
    try {
      let { slots } = await calendar.availability(date);
      if (date && time && !unavailable) {
        const start = slots.find(slot => cebuTime.format(new Date(slot)) === time);
        if (start) return requestConfirmation(start);
      }
      if (!slots.length && date) ({ slots } = await calendar.availability());
      const offers = slots.slice(0, 2);
      const intro = unavailable || (date && time) ? "That time isn’t available." : "";
      if (!offers.length) return draft(`${intro ? intro + " " : ""}I couldn’t find an open test consultation in the coming week.`);
      const options = offers.map((start, i) => `${i + 1}. ${label(start)}`).join("\n");
      return draft(`${intro ? intro + " " : ""}Here are the available times in Cebu time:\n${options}\nWhich works for you? You can reply with the option number.`, { offers });
    } catch {
      return draft("I can’t check the test calendar right now. Please try again shortly.");
    }
  }

  return { matches, respond };
}

module.exports = { createPearlSmileMessengerPilot };
