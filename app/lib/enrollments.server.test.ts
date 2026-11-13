import { describe, it, expect } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import type { Db } from "~/db";
import * as schema from "~/db/schema";
import { eq } from "drizzle-orm";
import { buyCourse, claimSeat, findEnrollment } from "./enrollments.server";
import { requestTeamLicenceRefund } from "./refunds.server";
import { decideRefundRequest } from "./admin-refunds.server";

function rejection(fn: () => unknown) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("Expected the claim to be rejected");
}

function setup() {
  const db = createTestDb();
  const base = seedBaseData(db);
  const teamAdmin = addLearner(db, "ava@example.com");
  return { db, ...base, teamAdmin };
}

function addLearner(db: Db, email: string) {
  return db
    .insert(schema.users)
    .values({ name: email, email, role: schema.UserRole.Student })
    .returning()
    .get();
}

function createTeamLicence(
  db: Db,
  adminId: number,
  courseId: number,
  codes: string[]
) {
  const team = db.insert(schema.teams).values({}).returning().get();
  const purchase = db
    .insert(schema.purchases)
    .values({
      userId: adminId,
      courseId,
      amountPaid: 7900 * codes.length,
      country: null,
    })
    .returning()
    .get();
  const seats = codes.map((code) =>
    db
      .insert(schema.coupons)
      .values({ teamId: team.id, courseId, code, purchaseId: purchase.id })
      .returning()
      .get()
  );
  return { team, purchase, seats };
}

describe("buyCourse", () => {
  it("creates an Enrollment linked to that purchase", () => {
    const { db, user, course } = setup();

    const { purchase } = buyCourse(db, {
      userId: user.id,
      courseId: course.id,
      amountPaid: 7900,
      country: "US",
    });

    const enrollment = findEnrollment(db, user.id, course.id);
    expect(enrollment?.purchaseId).toBe(purchase.id);
    expect(enrollment?.couponId).toBeNull();
  });
});

describe("claimSeat", () => {
  it("creates an Enrollment linked to that Claimed Seat", () => {
    const { db, user, course, teamAdmin } = setup();
    const { seats } = createTeamLicence(db, teamAdmin.id, course.id, [
      "SEAT-1",
    ]);

    const result = claimSeat(db, {
      code: "SEAT-1",
      userId: user.id,
      userCountry: "US",
    });

    expect(result.couponId).toBe(seats[0].id);
    const enrollment = findEnrollment(db, user.id, course.id);
    expect(enrollment?.couponId).toBe(seats[0].id);
    expect(enrollment?.purchaseId).toBeNull();
  });

  it("refuses a code that matches no Unclaimed Seat", () => {
    const { db, user } = setup();

    expect(
      rejection(() =>
        claimSeat(db, { code: "NOPE", userId: user.id, userCountry: "US" })
      )
    ).toMatchObject({
      data: "No Unclaimed Seat matches this link.",
      init: { status: 404 },
    });
  });

  it("refuses a Claimed Seat", () => {
    const { db, user, course, teamAdmin } = setup();
    createTeamLicence(db, teamAdmin.id, course.id, ["SEAT-1"]);
    const noah = addLearner(db, "noah@example.com");
    claimSeat(db, { code: "SEAT-1", userId: noah.id, userCountry: "US" });

    expect(
      rejection(() =>
        claimSeat(db, { code: "SEAT-1", userId: user.id, userCountry: "US" })
      )
    ).toMatchObject({
      data: "This place is already a Claimed Seat.",
      init: { status: 409 },
    });
  });

  it("refuses a learner outside the purchaser's country", () => {
    const { db, user, course, teamAdmin } = setup();
    const { purchase } = createTeamLicence(db, teamAdmin.id, course.id, [
      "SEAT-1",
    ]);
    db.update(schema.purchases)
      .set({ country: "DE" })
      .where(eq(schema.purchases.id, purchase.id))
      .run();

    expect(
      rejection(() =>
        claimSeat(db, { code: "SEAT-1", userId: user.id, userCountry: "US" })
      )
    ).toMatchObject({
      data: "This Unclaimed Seat can only be claimed from the purchaser's country.",
      init: { status: 403 },
    });
    expect(findEnrollment(db, user.id, course.id)).toBeUndefined();
  });
});

describe("a learner has at most one Enrollment per course", () => {
  it("cannot buy a course they hold a Claimed Seat in", () => {
    const { db, user, course, teamAdmin } = setup();
    createTeamLicence(db, teamAdmin.id, course.id, ["SEAT-1"]);
    claimSeat(db, { code: "SEAT-1", userId: user.id, userCountry: "US" });

    expect(() =>
      buyCourse(db, {
        userId: user.id,
        courseId: course.id,
        amountPaid: 7900,
        country: "US",
      })
    ).toThrow();
  });

  it("cannot claim a seat in a course they bought, and the seat stays claimable", () => {
    const { db, user, course, teamAdmin } = setup();
    createTeamLicence(db, teamAdmin.id, course.id, ["SEAT-1"]);
    buyCourse(db, {
      userId: user.id,
      courseId: course.id,
      amountPaid: 7900,
      country: "US",
    });

    expect(
      rejection(() =>
        claimSeat(db, { code: "SEAT-1", userId: user.id, userCountry: "US" })
      )
    ).toMatchObject({
      data: "You are already enrolled in this course",
      init: { status: 409 },
    });
    const noah = addLearner(db, "noah@example.com");
    claimSeat(db, { code: "SEAT-1", userId: noah.id, userCountry: "US" });
    expect(findEnrollment(db, noah.id, course.id)).toBeDefined();
  });

  it("is enforced by the database too", () => {
    const { db, user, course } = setup();
    const { purchase } = buyCourse(db, {
      userId: user.id,
      courseId: course.id,
      amountPaid: 7900,
      country: "US",
    });

    expect(() =>
      db
        .insert(schema.enrollments)
        .values({
          userId: user.id,
          courseId: course.id,
          purchaseId: purchase.id,
        })
        .run()
    ).toThrow(/UNIQUE/);
  });
});

function openTeamLicenceRefund(
  db: Db,
  teamAdminId: number,
  licence: ReturnType<typeof createTeamLicence>
) {
  db.insert(schema.teamMembers)
    .values({
      teamId: licence.team.id,
      userId: teamAdminId,
      role: schema.TeamMemberRole.Admin,
    })
    .run();
  return requestTeamLicenceRefund(db, {
    userId: teamAdminId,
    purchaseId: licence.purchase.id,
    reason: "We no longer need these places.",
  });
}

describe("Unclaimed Seats of a Team Licence with a Refund Request", () => {
  it("cannot be claimed while the Refund Request is Open", () => {
    const { db, user, course, teamAdmin } = setup();
    const licence = createTeamLicence(db, teamAdmin.id, course.id, ["SEAT-1"]);
    openTeamLicenceRefund(db, teamAdmin.id, licence);

    expect(
      rejection(() =>
        claimSeat(db, { code: "SEAT-1", userId: user.id, userCountry: "US" })
      )
    ).toMatchObject({
      data: "This place is currently locked while a refund request is reviewed.",
      init: { status: 409 },
    });
    expect(findEnrollment(db, user.id, course.id)).toBeUndefined();
  });

  it("can be claimed again after the Refund Request is declined", () => {
    const { db, user, course, teamAdmin } = setup();
    const licence = createTeamLicence(db, teamAdmin.id, course.id, ["SEAT-1"]);
    const request = openTeamLicenceRefund(db, teamAdmin.id, licence);
    decideRefundRequest(db, {
      refundId: request.id,
      decision: schema.RefundStatus.Declined,
      platformAdminUserId: teamAdmin.id,
    });

    claimSeat(db, { code: "SEAT-1", userId: user.id, userCountry: "US" });
    expect(findEnrollment(db, user.id, course.id)).toBeDefined();
  });

  it("are void after the Refund Request is approved", () => {
    const { db, user, course, teamAdmin } = setup();
    const licence = createTeamLicence(db, teamAdmin.id, course.id, ["SEAT-1"]);
    const request = openTeamLicenceRefund(db, teamAdmin.id, licence);
    decideRefundRequest(db, {
      refundId: request.id,
      decision: schema.RefundStatus.Approved,
      platformAdminUserId: teamAdmin.id,
    });

    expect(
      rejection(() =>
        claimSeat(db, { code: "SEAT-1", userId: user.id, userCountry: "US" })
      )
    ).toMatchObject({
      data: "This place was refunded and is no longer valid",
      init: { status: 410 },
    });
    expect(findEnrollment(db, user.id, course.id)).toBeUndefined();
  });
});
