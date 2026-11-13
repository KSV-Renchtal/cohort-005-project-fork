import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import type { Db } from "~/db";
import { coupons, courses, refunds, users, RefundStatus } from "~/db/schema";

// Seats of a Team Licence are stored as rows in `coupons`. A seat is a
// Claimed Seat once a learner is recorded on it (`redeemedByUserId`); this is
// the one definition of "claimed" everywhere.

/** Whether this seat is a Claimed Seat. */
export function isClaimedSeat(seat: { redeemedByUserId: number | null }) {
  return seat.redeemedByUserId !== null;
}

/** SQL condition: the seat row is a Claimed Seat. */
export const claimedSeatCondition = isNotNull(coupons.redeemedByUserId);

/** SQL aggregate: how many of the grouped seat rows are Claimed Seats. */
export const countClaimedSeats = sql<number>`count(${coupons.redeemedByUserId})`;

/** How many seats a purchase has, and how many of them are claimed. */
export function countSeats(db: Db, purchaseId: number) {
  const counts = db
    .select({
      totalSeats: sql<number>`count(*)`,
      claimedSeats: countClaimedSeats,
    })
    .from(coupons)
    .where(eq(coupons.purchaseId, purchaseId))
    .get();
  return {
    totalSeats: counts?.totalSeats ?? 0,
    claimedSeats: counts?.claimedSeats ?? 0,
  };
}

/** The team a Team Licence belongs to, or undefined if the purchase has no seats. */
export function teamIdOfTeamLicence(db: Db, purchaseId: number) {
  return db
    .select({ teamId: coupons.teamId })
    .from(coupons)
    .where(eq(coupons.purchaseId, purchaseId))
    .get()?.teamId;
}

/** A purchase is a Team Licence when it has seats. */
export function isTeamLicence(db: Db, purchaseId: number) {
  return teamIdOfTeamLicence(db, purchaseId) !== undefined;
}

/** A Team Licence with any Claimed Seat cannot be refunded, in part or whole. */
export function hasClaimedSeat(db: Db, purchaseId: number) {
  const claimed = db
    .select({ id: coupons.id })
    .from(coupons)
    .where(and(eq(coupons.purchaseId, purchaseId), claimedSeatCondition))
    .get();
  return claimed !== undefined;
}

export const VOIDED_SEAT_MESSAGE =
  "This place was refunded and is no longer valid";

export const FROZEN_SEAT_MESSAGE =
  "This place is currently locked while a refund request is reviewed.";

/**
 * Why nobody can claim this Unclaimed Seat, or null: it was voided when its
 * Team Licence was refunded, or it is frozen while that Team Licence has an
 * Open Refund Request.
 */
export function seatLockMessage(
  db: Db,
  seat: { purchaseId: number; voidedAt: string | null }
): string | null {
  if (seat.voidedAt !== null) return VOIDED_SEAT_MESSAGE;
  const openRequest = db
    .select({ id: refunds.id })
    .from(refunds)
    .where(
      and(
        eq(refunds.purchaseId, seat.purchaseId),
        eq(refunds.status, RefundStatus.Open)
      )
    )
    .get();
  if (openRequest) return FROZEN_SEAT_MESSAGE;
  return null;
}

export type SeatStatus = "claimed" | "unclaimed" | "locked" | "void";

function seatStatus(
  db: Db,
  seat: {
    purchaseId: number;
    redeemedByUserId: number | null;
    voidedAt: string | null;
  }
): SeatStatus {
  if (isClaimedSeat(seat)) return "claimed";
  if (seat.voidedAt !== null) return "void";
  if (seatLockMessage(db, seat)) return "locked";
  return "unclaimed";
}

/**
 * Every seat of the team's Team Licences with its status, and per course how
 * many seats the team holds and how many are claimed. Void seats (from a
 * refunded Team Licence) are listed but not counted.
 */
export function listTeamSeats(db: Db, teamId: number) {
  const rows = db
    .select({
      seat: coupons,
      courseTitle: courses.title,
      courseSlug: courses.slug,
      claimedByEmail: users.email,
    })
    .from(coupons)
    .innerJoin(courses, eq(coupons.courseId, courses.id))
    .leftJoin(users, eq(coupons.redeemedByUserId, users.id))
    .where(eq(coupons.teamId, teamId))
    .orderBy(asc(coupons.id))
    .all();

  type CourseStats = {
    courseId: number;
    courseTitle: string;
    courseSlug: string;
    totalSeats: number;
    claimedSeats: number;
  };
  const courseStats = new Map<number, CourseStats>();
  const seats = rows.map((row) => {
    const status = seatStatus(db, row.seat);
    const stats = courseStats.get(row.seat.courseId) ?? {
      courseId: row.seat.courseId,
      courseTitle: row.courseTitle,
      courseSlug: row.courseSlug,
      totalSeats: 0,
      claimedSeats: 0,
    };
    courseStats.set(row.seat.courseId, stats);
    if (status !== "void") stats.totalSeats++;
    if (status === "claimed") stats.claimedSeats++;

    return {
      id: row.seat.id,
      code: row.seat.code,
      courseId: row.seat.courseId,
      courseTitle: row.courseTitle,
      status,
      claimedByEmail: row.claimedByEmail,
    };
  });

  return { courseStats: Array.from(courseStats.values()), seats };
}
