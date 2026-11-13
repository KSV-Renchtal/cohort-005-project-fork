import { data } from "react-router";
import { and, eq } from "drizzle-orm";
import type { Db } from "~/db";
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

export type ClaimSeatResult =
  | { ok: true; enrollment: typeof enrollments.$inferSelect }
  | { ok: false; error: string };

/** The learner claims an Unclaimed Seat and gets an Enrollment from it. */
export function claimSeat(
  db: Db,
  input: { code: string; userId: number; userCountry: string }
): ClaimSeatResult {
  return db.transaction((tx): ClaimSeatResult => {
    const seat = tx
      .select()
      .from(coupons)
      .where(eq(coupons.code, input.code))
      .get();
    if (!seat) {
      return { ok: false, error: "Coupon not found" };
    }

    if (seat.redeemedByUserId !== null) {
      return { ok: false, error: "Coupon has already been redeemed" };
    }

    if (findEnrollment(tx, input.userId, seat.courseId)) {
      return { ok: false, error: "You are already enrolled in this course" };
    }

    const purchase = tx
      .select()
      .from(purchases)
      .where(eq(purchases.id, seat.purchaseId))
      .get();

    if (purchase?.country && purchase.country !== input.userCountry) {
      return {
        ok: false,
        error:
          "This coupon can only be redeemed from the same country as the purchaser",
      };
    }

    tx.update(coupons)
      .set({
        redeemedByUserId: input.userId,
        redeemedAt: new Date().toISOString(),
      })
      .where(eq(coupons.id, seat.id))
      .run();

    const enrollment = tx
      .insert(enrollments)
      .values({
        userId: input.userId,
        courseId: seat.courseId,
        couponId: seat.id,
      })
      .returning()
      .get();

    return { ok: true, enrollment };
  });
}
