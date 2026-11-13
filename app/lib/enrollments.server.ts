import { data } from "react-router";
import { and, eq } from "drizzle-orm";
import type { Db } from "~/db";
import { isClaimedSeat, seatLockMessage } from "~/lib/seats.server";
import { coupons, enrollments, purchases } from "~/db/schema";

// Every Enrollment records its source: the learner's own purchase or a
// Claimed Seat. A learner has at most one Enrollment per course.

export function findEnrollment(db: Db, userId: number, courseId: number) {
  return db
    .select()
    .from(enrollments)
    .where(
      and(eq(enrollments.userId, userId), eq(enrollments.courseId, courseId))
    )
    .get();
}

/** The learner buys the course for themselves and gets an Enrollment from it. */
export function buyCourse(
  db: Db,
  input: {
    userId: number;
    courseId: number;
    amountPaid: number;
    country: string | null;
  }
) {
  return db.transaction((tx) => {
    if (findEnrollment(tx, input.userId, input.courseId)) {
      throw data("You are already enrolled in this course.", { status: 409 });
    }

    const purchase = tx.insert(purchases).values(input).returning().get();
    const enrollment = tx
      .insert(enrollments)
      .values({
        userId: input.userId,
        courseId: input.courseId,
        purchaseId: purchase.id,
      })
      .returning()
      .get();

    return { purchase, enrollment };
  });
}

/**
 * The learner claims an Unclaimed Seat and gets an Enrollment from it.
 * Throws a response with the reason when the seat cannot be claimed.
 */
export function claimSeat(
  db: Db,
  input: { code: string; userId: number; userCountry: string }
) {
  return db.transaction((tx) => {
    const seat = tx
      .select()
      .from(coupons)
      .where(eq(coupons.code, input.code))
      .get();
    if (!seat) {
      throw data("No Unclaimed Seat matches this link.", { status: 404 });
    }

    if (isClaimedSeat(seat)) {
      throw data("This place is already a Claimed Seat.", { status: 409 });
    }

    const lockMessage = seatLockMessage(tx, seat);
    if (lockMessage) {
      throw data(lockMessage, { status: seat.voidedAt !== null ? 410 : 409 });
    }

    if (findEnrollment(tx, input.userId, seat.courseId)) {
      throw data("You are already enrolled in this course", { status: 409 });
    }

    const purchase = tx
      .select()
      .from(purchases)
      .where(eq(purchases.id, seat.purchaseId))
      .get();

    if (purchase?.country && purchase.country !== input.userCountry) {
      throw data(
        "This Unclaimed Seat can only be claimed from the purchaser's country.",
        { status: 403 }
      );
    }

    tx.update(coupons)
      .set({
        redeemedByUserId: input.userId,
        redeemedAt: new Date().toISOString(),
      })
      .where(eq(coupons.id, seat.id))
      .run();

    return tx
      .insert(enrollments)
      .values({
        userId: input.userId,
        courseId: seat.courseId,
        couponId: seat.id,
      })
      .returning()
      .get();
  });
}
