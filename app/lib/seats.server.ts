import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { Db } from "~/db";
import { coupons } from "~/db/schema";

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
