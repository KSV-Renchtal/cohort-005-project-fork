import { data } from "react-router";
import { z } from "zod";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "~/db";
import { findEnrollment } from "~/lib/enrollments.server";
import { getCourseProgress } from "~/lib/course-progress.server";
import {
  countClaimedSeats,
  hasClaimedSeat,
  teamIdOfTeamLicence,
} from "~/lib/seats.server";
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

/** A learner who watched this much of a course cannot ask for their own purchase back. */
export const MAX_WATCHED_SECONDS = 2 * 60 * 60;

/** Whether the learner watched too much of the course to ask for their own purchase back. */
export function watchedPastRefundLimit(watchedSeconds: number) {
  return watchedSeconds >= MAX_WATCHED_SECONDS;
}

/** The reason box on every Refund Request form. */
export const refundReasonSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(10, "Tell us a little more about why you want a refund.")
    .max(1000, "Please keep your reason under 1000 characters."),
});

// The fourteen-day window is counted in whole calendar days, not hours: the
// purchase day is day 0 and a purchase at 23:00 still gets the whole of day 14.
function startOfCalendarDay(when: Date) {
  return new Date(when.getFullYear(), when.getMonth(), when.getDate());
}

function formatCalendarDay(when: Date): string {
  const month = String(when.getMonth() + 1).padStart(2, "0");
  const day = String(when.getDate()).padStart(2, "0");
  return `${when.getFullYear()}-${month}-${day}`;
}

/** Which day of the refund window `at` falls on (the purchase day is day 0). */
export function dayOfRefundWindow(purchasedAtIso: string, at: Date): number {
  const ms =
    startOfCalendarDay(at).getTime() -
    startOfCalendarDay(new Date(purchasedAtIso)).getTime();
  return Math.round(ms / (24 * 60 * 60 * 1000));
}

function isWithinRefundWindow(purchasedAtIso: string, at: Date) {
  const day = dayOfRefundWindow(purchasedAtIso, at);
  return day >= 0 && day <= REFUND_WINDOW_DAYS;
}

/** The last calendar day (YYYY-MM-DD) on which a Refund Request can be raised. */
export function lastDayOfRefundWindow(purchasedAtIso: string): string {
  const deadline = startOfCalendarDay(new Date(purchasedAtIso));
  deadline.setDate(deadline.getDate() + REFUND_WINDOW_DAYS);
  return formatCalendarDay(deadline);
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
  if (!isWithinRefundWindow(purchase.createdAt, now)) {
    return {
      message: `The ${REFUND_WINDOW_DAYS}-day window has closed.`,
      status: 403,
    };
  }
  return null;
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
  const teamId = teamIdOfTeamLicence(db, input.purchaseId);
  if (teamId === undefined) {
    throw data("Team Licence not found.", { status: 404 });
  }
  if (!isTeamAdmin(db, input.userId, teamId)) {
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
      claimedSeats: countClaimedSeats,
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

/**
 * The learner's own purchase of the course: the one their Enrollment came
 * from. A Team Licence never gives its buyer an Enrollment, and a Claimed
 * Seat belongs to the team, so neither is ever found here.
 */
function findOwnPurchase(db: Db, userId: number, courseId: number) {
  const purchaseId = findEnrollment(db, userId, courseId)?.purchaseId;
  if (purchaseId == null) return undefined;
  return db.select().from(purchases).where(eq(purchases.id, purchaseId)).get();
}

/**
 * Why the learner cannot ask for their own purchase back, or null. Old
 * learning progress counts: watch time is per learner and lesson, so a
 * learner who bought again after a refund starts from where they left off.
 */
function ownPurchaseRefundBlocker(
  db: Db,
  userId: number,
  purchase: { id: number; courseId: number; createdAt: string },
  now: Date
): RefundBlocker | null {
  const blocker = purchaseRefundBlocker(db, purchase, now);
  if (blocker) return blocker;
  const { watchedSeconds } = getCourseProgress(db, userId, purchase.courseId);
  if (watchedPastRefundLimit(watchedSeconds)) {
    return {
      message: "You have watched too much of this course to request a refund.",
      status: 403,
    };
  }
  return null;
}

/**
 * What the course page offers the learner if they want the money for their
 * own purchase back, or null if no Refund Request can be raised on it.
 */
export function ownPurchaseRefundOffer(
  db: Db,
  userId: number,
  courseId: number,
  now: Date = new Date()
) {
  const purchase = findOwnPurchase(db, userId, courseId);
  if (!purchase) return null;
  if (ownPurchaseRefundBlocker(db, userId, purchase, now)) return null;
  return {
    amount: purchase.amountPaid,
    lastDayInWindow: lastDayOfRefundWindow(purchase.createdAt),
  };
}

/** A learner asks for the money for their own purchase of a course back. */
export function requestOwnPurchaseRefund(
  db: Db,
  input: { userId: number; courseId: number; reason: string },
  now: Date = new Date()
) {
  const purchase = findOwnPurchase(db, input.userId, input.courseId);
  if (!purchase) {
    throw data("You have not bought this course.", { status: 403 });
  }
  const blocker = ownPurchaseRefundBlocker(db, input.userId, purchase, now);
  if (blocker) {
    throw data(blocker.message, { status: blocker.status });
  }

  const request = db
    .insert(refunds)
    .values({
      purchaseId: purchase.id,
      status: RefundStatus.Open,
      reason: input.reason,
      requestedAt: now.toISOString(),
    })
    .returning()
    .get();
  return { request, purchase };
}
