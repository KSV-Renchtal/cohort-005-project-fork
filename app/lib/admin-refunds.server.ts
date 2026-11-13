import { data } from "react-router";
import { and, asc, eq, not } from "drizzle-orm";
import type { Db } from "~/db";
import {
  RefundStatus,
  coupons,
  enrollments,
  courses,
  purchases,
  refunds,
  users,
} from "~/db/schema";
import { getCourseProgress } from "~/lib/course-progress.server";
import { dayOfRefundWindow, watchedPastRefundLimit } from "~/lib/refunds.server";
import {
  claimedSeatCondition,
  countSeats,
  isTeamLicence,
} from "~/lib/seats.server";

/** Every Open Refund Request, oldest first, for a Platform Admin to decide. */
export function listOpenRefundRequests(db: Db) {
  const rows = db
    .select({
      id: refunds.id,
      reason: refunds.reason,
      requestedAt: refunds.requestedAt,
      purchaseId: purchases.id,
      amountPaid: purchases.amountPaid,
      purchasedAt: purchases.createdAt,
      requesterId: users.id,
      requesterName: users.name,
      courseId: courses.id,
      courseTitle: courses.title,
    })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .innerJoin(users, eq(purchases.userId, users.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(eq(refunds.status, RefundStatus.Open))
    .orderBy(asc(refunds.requestedAt), asc(refunds.id))
    .all();

  return rows.map((row) => ({
    ...row,
    dayOfWindow: dayOfRefundWindow(row.purchasedAt, new Date(row.requestedAt)),
    progress: progressFor(db, row.purchaseId, row.requesterId, row.courseId),
  }));
}

function progressFor(
  db: Db,
  purchaseId: number,
  requesterId: number,
  courseId: number
) {
  // A purchase with seats is a Team Licence; the buyer's own watch time says
  // nothing about it.
  if (isTeamLicence(db, purchaseId)) {
    const seats = countSeats(db, purchaseId);
    return {
      kind: "teamLicence" as const,
      claimedSeats: seats.claimedSeats,
      totalSeats: seats.totalSeats,
    };
  }

  const progress = getCourseProgress(db, requesterId, courseId);
  return {
    kind: "own" as const,
    ...progress,
    overWatchLimit: watchedPastRefundLimit(progress.watchedSeconds),
  };
}

/**
 * A Platform Admin approves or declines an Open Refund Request. Decisions are
 * final.
 */
export function decideRefundRequest(
  db: Db,
  input: {
    refundId: number;
    decision: RefundStatus.Approved | RefundStatus.Declined;
    platformAdminUserId: number;
  },
  now: Date = new Date()
) {
  const resolvedAt = now.toISOString();
  return db.transaction((tx) => {
    const request = tx
      .select({ purchaseId: refunds.purchaseId, amountPaid: purchases.amountPaid })
      .from(refunds)
      .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
      .where(eq(refunds.id, input.refundId))
      .get();
    if (!request) {
      throw data("Refund Request not found.", { status: 404 });
    }

    // First decision wins: the update only matches while the request is
    // still Open, so a second Platform Admin's decision changes nothing.
    const approve = input.decision === RefundStatus.Approved;
    const decided = tx
      .update(refunds)
      .set({
        status: input.decision,
        amountRefunded: approve ? request.amountPaid : null,
        resolvedAt,
        resolvedByUserId: input.platformAdminUserId,
      })
      .where(
        and(eq(refunds.id, input.refundId), eq(refunds.status, RefundStatus.Open))
      )
      .returning()
      .get();
    if (!decided) {
      throw data("This Refund Request was already decided.", { status: 409 });
    }

    if (approve) {
      // Access ends at approval (ADR 0001): only the Enrollment that came
      // from this purchase. Learning progress is per user and lesson, so it
      // stays.
      tx.delete(enrollments)
        .where(eq(enrollments.purchaseId, request.purchaseId))
        .run();
      tx.update(coupons)
        .set({ voidedAt: resolvedAt })
        .where(
          and(
            eq(coupons.purchaseId, request.purchaseId),
            not(claimedSeatCondition)
          )
        )
        .run();
    }
    return decided;
  });
}
