/**
 * A BUSY hour in the team calendar: the recruiter marked it on the Calendar page
 * ("I have another meeting then"), so candidates can't book it on the booking page.
 *
 * One row per blocked hour; `start` is the hour's start time (unique, so an hour can't be
 * blocked twice). Booked meetings are NOT stored here: they live in Meeting.slot.
 */
import { Schema, Types, model, type InferSchemaType } from 'mongoose';

const busySlotSchema = new Schema(
  {
    start: { type: Date, required: true, unique: true },
    // Who blocked it (shown on the calendar as "Blocked by Rina").
    userId: { type: Types.ObjectId, ref: 'User', default: null },
    note: { type: String, default: '', maxlength: 120 },
  },
  { timestamps: true },
);

export type BusySlot = InferSchemaType<typeof busySlotSchema>;
export const BusySlotModel = model('BusySlot', busySlotSchema);
