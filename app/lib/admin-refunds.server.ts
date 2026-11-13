import { data } from "react-router";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "~/db";
import {
  LessonProgressStatus,
  RefundStatus,
  coupons,
  enrollments,
  courses,
  lessonProgress,
  lessons,
  modules,
  purchases,
  refunds,
  users,
  videoWatchEvents,
} from "~/db/schema";

export const REFUND_WINDOW_DAYS = 14;
export const MAX_WATCHED_SECONDS = 2 * 60 * 60;

// Calendar days from the purchase to the request, as the refund window counts
// them: the purchase day is day 0 and the last day a request is allowed is
// day 14.
function calendarDaysBetween(fromIso: string, toIso: string) {
  const startOfDay = (iso: string) => {
    const when = new Date(iso);
    return new Date(when.getFullYear(), when.getMonth(), when.getDate());
  };
  const ms = startOfDay(toIso).getTime() - startOfDay(fromIso).getTime();
  return Math.round(ms / (24 * 60 * 60 * 1000));
}

/**
 * A learner's progress in one course right now: watch time is the furthest
 * position reached in each lesson, summed (the same measure as the refund
 * eligibility rule), plus how many of the course's lessons they completed.
 */
export function getCourseProgress(db: Db, userId: number, courseId: number) {
  const lessonIds = db
    .select({ id: lessons.id })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(modules.courseId, courseId))
    .all()
    .map((row) => row.id);

  if (lessonIds.length === 0) {
    return { watchedSeconds: 0, completedLessons: 0, totalLessons: 0 };
  }

  const watchedSeconds = db
    .select({
      furthest: sql<number>`max(${videoWatchEvents.positionSeconds})`,
    })
    .from(videoWatchEvents)
    .where(
      and(
        eq(videoWatchEvents.userId, userId),
        inArray(videoWatchEvents.lessonId, lessonIds)
      )
    )
    .groupBy(videoWatchEvents.lessonId)
    .all()
    .reduce((total, row) => total + row.furthest, 0);

  const completed = db
    .select({ count: sql<number>`count(distinct ${lessonProgress.lessonId})` })
    .from(lessonProgress)
    .where(
      and(
        eq(lessonProgress.userId, userId),
        eq(lessonProgress.status, LessonProgressStatus.Completed),
        inArray(lessonProgress.lessonId, lessonIds)
      )
    )
    .get();

  return {
    watchedSeconds,
    completedLessons: completed?.count ?? 0,
    totalLessons: lessonIds.length,
  };
}

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
    dayOfWindow: calendarDaysBetween(row.purchasedAt, row.requestedAt),
    progress: progressFor(db, row.purchaseId, row.requesterId, row.courseId),
  }));
}

function countSeats(db: Db, purchaseId: number) {
  return db
    .select({
      totalSeats: sql<number>`count(*)`,
      claimedSeats: sql<number>`count(${coupons.redeemedByUserId})`,
    })
    .from(coupons)
    .where(eq(coupons.purchaseId, purchaseId))
    .get();
}

function progressFor(
  db: Db,
  purchaseId: number,
  requesterId: number,
  courseId: number
) {
  // A purchase with seats is a Team Licence; the buyer's own watch time says
  // nothing about it.
  const seats = countSeats(db, purchaseId);
  if (seats && seats.totalSeats > 0) {
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
    overWatchLimit: progress.watchedSeconds >= MAX_WATCHED_SECONDS,
  };
}

export type RefundDecision = "approve" | "decline";

/**
 * A Platform Admin approves or declines an Open Refund Request. Decisions are
 * final.
 */
export function decideRefundRequest(
  db: Db,
  input: {
    refundId: number;
    decision: RefundDecision;
    adminUserId: number;
    now?: string;
  }
) {
  const resolvedAt = input.now ?? new Date().toISOString();
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
    const approve = input.decision === "approve";
    const decided = tx
      .update(refunds)
      .set({
        status: approve ? RefundStatus.Approved : RefundStatus.Declined,
        amountRefunded: approve ? request.amountPaid : null,
        resolvedAt,
        resolvedByUserId: input.adminUserId,
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
            isNull(coupons.redeemedByUserId)
          )
        )
        .run();
    }
    return decided;
  });
}
