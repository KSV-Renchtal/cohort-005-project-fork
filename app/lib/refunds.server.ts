import { data } from "react-router";
import { z } from "zod";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import type { Db } from "~/db";
import {
  coupons,
  courses,
  purchases,
  refunds,
  teamMembers,
  RefundStatus,
  TeamMemberRole,
} from "~/db/schema";

function isTeamAdmin(db: Db, userId: number, teamId: number) {
  const membership = db
    .select({ id: teamMembers.id })
    .from(teamMembers)
    .where(
      and(
        eq(teamMembers.teamId, teamId),
        eq(teamMembers.userId, userId),
        eq(teamMembers.role, TeamMemberRole.Admin)
      )
    )
    .get();
  return membership !== undefined;
}

export const REFUND_WINDOW_DAYS = 14;

/** The reason box on every Refund Request form. */
export const refundReasonSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(10, "Tell us a little more about why you want a refund.")
    .max(1000, "Please keep your reason under 1000 characters."),
});

// The fourteen-day window is counted in whole calendar days, not hours: a
// purchase at 23:00 still gets the whole of its fourteenth day.
function calendarDay(when: Date): string {
  const month = String(when.getMonth() + 1).padStart(2, "0");
  const day = String(when.getDate()).padStart(2, "0");
  return `${when.getFullYear()}-${month}-${day}`;
}

/** The last calendar day (YYYY-MM-DD) on which a Refund Request can be raised. */
export function lastDayOfRefundWindow(purchasedAtIso: string): string {
  const deadline = new Date(purchasedAtIso);
  deadline.setDate(deadline.getDate() + REFUND_WINDOW_DAYS);
  return calendarDay(deadline);
}

export type RefundBlocker = { message: string; status: 403 | 409 };

/**
 * The rules every Refund Request follows, for own purchases and Team
 * Licences alike: none after an approval, one Open Refund Request at a time,
 * and only within the fourteen-day window. Null if none of them blocks.
 */
export function purchaseRefundBlocker(
  db: Db,
  purchase: { id: number; createdAt: string },
  now: Date = new Date()
): RefundBlocker | null {
  const decided = db
    .select({ status: refunds.status })
    .from(refunds)
    .where(eq(refunds.purchaseId, purchase.id))
    .all();

  if (decided.some((r) => r.status === RefundStatus.Approved)) {
    return { message: "This purchase has already been refunded.", status: 403 };
  }
  if (decided.some((r) => r.status === RefundStatus.Open)) {
    return {
      message: "There is already an open refund request on this purchase.",
      status: 409,
    };
  }
  const today = calendarDay(now);
  if (
    today < calendarDay(new Date(purchase.createdAt)) ||
    today > lastDayOfRefundWindow(purchase.createdAt)
  ) {
    return {
      message: `The ${REFUND_WINDOW_DAYS}-day window has closed.`,
      status: 403,
    };
  }
  return null;
}

/** A Team Licence with any Claimed Seat cannot be refunded, in part or whole. */
export function hasClaimedSeat(db: Db, purchaseId: number) {
  const claimed = db
    .select({ id: coupons.id })
    .from(coupons)
    .where(and(eq(coupons.purchaseId, purchaseId), isNotNull(coupons.redeemedAt)))
    .get();
  return claimed !== undefined;
}

/** Why a Refund Request cannot be raised on this Team Licence, or null. */
function teamLicenceRefundBlocker(
  db: Db,
  purchase: { id: number; createdAt: string },
  now: Date
): RefundBlocker | null {
  if (hasClaimedSeat(db, purchase.id)) {
    return {
      message: "A Team Licence with a claimed seat cannot be refunded.",
      status: 403,
    };
  }
  return purchaseRefundBlocker(db, purchase, now);
}

function latestRefundRequest(db: Db, purchaseId: number) {
  return db
    .select()
    .from(refunds)
    .where(eq(refunds.purchaseId, purchaseId))
    .orderBy(desc(refunds.requestedAt), desc(refunds.id))
    .get();
}

/** A Team Admin asks for a Team Licence's money back. */
export function requestTeamLicenceRefund(
  db: Db,
  input: { userId: number; purchaseId: number; reason: string },
  now: Date = new Date()
) {
  const seat = db
    .select({ teamId: coupons.teamId })
    .from(coupons)
    .where(eq(coupons.purchaseId, input.purchaseId))
    .get();
  if (!seat) {
    throw data("Team Licence not found.", { status: 404 });
  }
  if (!isTeamAdmin(db, input.userId, seat.teamId)) {
    throw data("Only a Team Admin of this team can ask for a refund.", {
      status: 403,
    });
  }

  const purchase = db
    .select()
    .from(purchases)
    .where(eq(purchases.id, input.purchaseId))
    .get();
  if (!purchase) {
    throw data("Team Licence not found.", { status: 404 });
  }
  const blocker = teamLicenceRefundBlocker(db, purchase, now);
  if (blocker) {
    throw data(blocker.message, { status: blocker.status });
  }

  return db
    .insert(refunds)
    .values({
      purchaseId: input.purchaseId,
      status: RefundStatus.Open,
      reason: input.reason,
      requestedAt: now.toISOString(),
    })
    .returning()
    .get();
}

/**
 * The team's Team Licences, one per purchase, with what the team page offers
 * a Team Admin: a refund (and until when), or why there is none.
 */
export function listTeamLicences(db: Db, teamId: number, now: Date = new Date()) {
  const rows = db
    .select({
      purchase: purchases,
      courseTitle: courses.title,
      totalSeats: sql<number>`count(${coupons.id})`,
      claimedSeats: sql<number>`count(${coupons.redeemedAt})`,
    })
    .from(coupons)
    .innerJoin(purchases, eq(coupons.purchaseId, purchases.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(eq(coupons.teamId, teamId))
    .groupBy(purchases.id)
    .orderBy(desc(purchases.createdAt))
    .all();

  return rows.map((row) => {
    const blocker = teamLicenceRefundBlocker(db, row.purchase, now);
    return {
      purchaseId: row.purchase.id,
      courseTitle: row.courseTitle,
      amountPaid: row.purchase.amountPaid,
      purchasedAt: row.purchase.createdAt,
      totalSeats: row.totalSeats,
      claimedSeats: row.claimedSeats,
      latestRefundRequest: latestRefundRequest(db, row.purchase.id) ?? null,
      refundOffer: blocker
        ? null
        : { lastDayInWindow: lastDayOfRefundWindow(row.purchase.createdAt) },
      refundBlockedBecause: blocker?.message ?? null,
    };
  });
}
