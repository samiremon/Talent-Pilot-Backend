/**
 * The team's meeting hours, and which hours are still free.
 *
 *   Working days:  Sunday to Thursday (Friday and Saturday are the weekend in Bangladesh)
 *   Working hours: 9 AM to 6 PM Dhaka time, in 1-hour slots: 09:00, 10:00, ... 17:00
 *                  (the last call is 17:00-18:00)
 *
 * An hour is FREE when it's a working hour, it isn't blocked as busy (BusySlot), nobody has
 * booked it (Meeting with status "booked"), and it's at least NOTICE_HOURS away.
 * The candidate's booking page offers the free hours of the next BOOKING_DAYS days.
 *
 * Dhaka is UTC+6 all year (no daylight saving), so plain arithmetic is enough here.
 */
import { BusySlotModel } from '../models/busySlot.js';
import { MeetingModel } from '../models/reply.js';

export const WORK_DAYS = [0, 1, 2, 3, 4]; // Sun, Mon, Tue, Wed, Thu
export const START_HOUR = 9;
export const END_HOUR = 18; // the day ends at 18:00, so the last slot starts at 17:00
export const SLOT_MINUTES = 60;
/** Nobody can book a call starting sooner than this. */
export const NOTICE_HOURS = 2;
/** The booking page shows this many days ahead. */
export const BOOKING_DAYS = 14;

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const DHAKA_OFFSET = 6 * HOUR;

/** Midnight (Dhaka time) of the day `date` falls on, as a real moment in time. */
export function dhakaMidnight(date: Date): Date {
  const local = date.getTime() + DHAKA_OFFSET; // the clock time in Dhaka
  return new Date(Math.floor(local / DAY) * DAY - DHAKA_OFFSET);
}

/** The weekday in Dhaka (0 = Sunday ... 6 = Saturday). */
export function dhakaWeekday(date: Date): number {
  return new Date(date.getTime() + DHAKA_OFFSET).getUTCDay();
}

/** The Sunday that starts the week `date` is in (midnight, Dhaka time). */
export function weekStart(date: Date): Date {
  const midnight = dhakaMidnight(date);
  return new Date(midnight.getTime() - dhakaWeekday(midnight) * DAY);
}

/**
 * The working week to show for `date`: its own week Sunday-Thursday, but on the weekend
 * (Friday / Saturday) the work week is over, so the COMING week.
 */
export function workWeekStart(date: Date): Date {
  const start = weekStart(date);
  return WORK_DAYS.includes(dhakaWeekday(date)) ? start : new Date(start.getTime() + 7 * DAY);
}

/** "2026-11-15": the day in Dhaka. */
export function dhakaDateKey(date: Date): string {
  return new Date(date.getTime() + DHAKA_OFFSET).toISOString().slice(0, 10);
}

/** The slot start times (09:00 ... 17:00) of one day, or none on Friday / Saturday. */
export function daySlots(day: Date): Date[] {
  const midnight = dhakaMidnight(day);
  if (!WORK_DAYS.includes(dhakaWeekday(midnight))) return [];
  const slots: Date[] = [];
  for (let minutes = START_HOUR * 60; minutes + SLOT_MINUTES <= END_HOUR * 60; minutes += SLOT_MINUTES) {
    slots.push(new Date(midnight.getTime() + minutes * 60_000));
  }
  return slots;
}

/** True if `date` is exactly the start of a working slot (e.g. Sunday 10:00, not 10:15 or Friday). */
export function isWorkSlot(date: Date): boolean {
  return daySlots(date).some((s) => s.getTime() === date.getTime());
}

/** All working slots from `from` (inclusive) to `to` (exclusive). */
export function slotsBetween(from: Date, to: Date): Date[] {
  const slots: Date[] = [];
  for (let day = dhakaMidnight(from); day < to; day = new Date(day.getTime() + DAY)) {
    for (const s of daySlots(day)) if (s >= from && s < to) slots.push(s);
  }
  return slots;
}

/** What's in the calendar between two moments: busy hours and booked meetings, by start time. */
export async function takenSlots(from: Date, to: Date) {
  const [busy, booked] = await Promise.all([
    BusySlotModel.find({ start: { $gte: from, $lt: to } }).lean(),
    MeetingModel.find({ status: 'booked', slot: { $gte: from, $lt: to } }).lean(),
  ]);
  return {
    busy: new Map(busy.map((b) => [b.start.getTime(), b])),
    booked: new Map(booked.map((m) => [new Date(m.slot!).getTime(), m])),
  };
}

/** The earliest moment a call can start (now + the notice period). */
export function earliestBookable(now = new Date()): Date {
  return new Date(now.getTime() + NOTICE_HOURS * HOUR);
}

/** The hours a candidate can still pick: the next BOOKING_DAYS days, minus busy and booked hours. */
export async function freeSlots(now = new Date()): Promise<Date[]> {
  const from = earliestBookable(now);
  const to = new Date(dhakaMidnight(now).getTime() + (BOOKING_DAYS + 1) * DAY);
  const { busy, booked } = await takenSlots(from, to);
  return slotsBetween(from, to).filter((s) => !busy.has(s.getTime()) && !booked.has(s.getTime()));
}

/** Can a candidate book this exact time right now? (null = yes, otherwise the reason) */
export async function whyNotBookable(slot: Date, now = new Date()): Promise<string | null> {
  if (Number.isNaN(slot.getTime()) || !isWorkSlot(slot)) return 'That is not one of the offered times.';
  if (slot < earliestBookable(now)) return 'That time is too soon or has passed.';
  if (slot.getTime() >= dhakaMidnight(now).getTime() + (BOOKING_DAYS + 1) * DAY) return 'That time is too far ahead.';
  const { busy, booked } = await takenSlots(slot, new Date(slot.getTime() + 1));
  if (busy.size || booked.size) return 'Sorry, that time was just taken.';
  return null;
}
