import { describe, it, expect } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import type { Db } from "~/db";
import * as schema from "~/db/schema";
import { buyCourse, claimSeat, findEnrollment } from "./enrollments.server";
import { requestTeamLicenceRefund } from "./refunds.server";
import { decideRefundRequest } from "./admin-refunds.server";

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

    expect(result.ok).toBe(true);
    const enrollment = findEnrollment(db, user.id, course.id);
    expect(enrollment?.couponId).toBe(seats[0].id);
    expect(enrollment?.purchaseId).toBeNull();
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

    const refused = claimSeat(db, {
      code: "SEAT-1",
      userId: user.id,
      userCountry: "US",
    });

    expect(refused).toEqual({
      ok: false,
      error: "You are already enrolled in this course",
    });
    const noah = addLearner(db, "noah@example.com");
    expect(
      claimSeat(db, { code: "SEAT-1", userId: noah.id, userCountry: "US" }).ok
    ).toBe(true);
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

    const refused = claimSeat(db, {
      code: "SEAT-1",
      userId: user.id,
      userCountry: "US",
    });

    expect(refused).toEqual({
      ok: false,
      error:
        "This place is currently locked while a refund request is reviewed.",
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

    expect(
      claimSeat(db, { code: "SEAT-1", userId: user.id, userCountry: "US" }).ok
    ).toBe(true);
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

    const refused = claimSeat(db, {
      code: "SEAT-1",
      userId: user.id,
      userCountry: "US",
    });

    expect(refused).toEqual({
      ok: false,
      error: "This place was refunded and is no longer valid",
    });
    expect(findEnrollment(db, user.id, course.id)).toBeUndefined();
  });
});
