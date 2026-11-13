import { describe, it, expect } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import type { Db } from "~/db";
import * as schema from "~/db/schema";
import { claimSeat } from "./enrollments.server";
import { requestTeamLicenceRefund } from "./refunds.server";
import { decideRefundRequest } from "./admin-refunds.server";
import { listTeamSeats } from "./seats.server";

function setup() {
  const db = createTestDb();
  const base = seedBaseData(db);
  const teamAdmin = db
    .insert(schema.users)
    .values({ name: "Ava", email: "ava@example.com", role: schema.UserRole.Student })
    .returning()
    .get();
  const team = db.insert(schema.teams).values({}).returning().get();
  db.insert(schema.teamMembers)
    .values({ teamId: team.id, userId: teamAdmin.id, role: schema.TeamMemberRole.Admin })
    .run();
  return { db, ...base, teamAdmin, team };
}

function buyTeamLicence(
  db: Db,
  input: { teamId: number; buyerId: number; courseId: number; codes: string[] }
) {
  const purchase = db
    .insert(schema.purchases)
    .values({
      userId: input.buyerId,
      courseId: input.courseId,
      amountPaid: 7900 * input.codes.length,
      country: null,
    })
    .returning()
    .get();
  for (const code of input.codes) {
    db.insert(schema.coupons)
      .values({ teamId: input.teamId, courseId: input.courseId, code, purchaseId: purchase.id })
      .run();
  }
  return purchase;
}

function askForRefund(db: Db, teamAdminId: number, purchaseId: number) {
  return requestTeamLicenceRefund(db, {
    userId: teamAdminId,
    purchaseId,
    reason: "We no longer need these places.",
  });
}

describe("listTeamSeats", () => {
  it("counts each course's seats and Claimed Seats, leaving out void seats", () => {
    const { db, user, course, teamAdmin, team } = setup();
    const refunded = buyTeamLicence(db, {
      teamId: team.id,
      buyerId: teamAdmin.id,
      courseId: course.id,
      codes: ["OLD-1", "OLD-2"],
    });
    decideRefundRequest(db, {
      refundId: askForRefund(db, teamAdmin.id, refunded.id).id,
      decision: schema.RefundStatus.Approved,
      platformAdminUserId: teamAdmin.id,
    });
    buyTeamLicence(db, {
      teamId: team.id,
      buyerId: teamAdmin.id,
      courseId: course.id,
      codes: ["NEW-1", "NEW-2", "NEW-3"],
    });
    claimSeat(db, { code: "NEW-1", userId: user.id, userCountry: "US" });

    expect(listTeamSeats(db, team.id).courseStats).toEqual([
      {
        courseId: course.id,
        courseTitle: "Test Course",
        courseSlug: "test-course",
        totalSeats: 3,
        claimedSeats: 1,
      },
    ]);
  });

  it("marks each seat claimed, unclaimed, locked during an Open Refund Request, or void", () => {
    const { db, user, course, teamAdmin, team } = setup();
    const refunded = buyTeamLicence(db, {
      teamId: team.id,
      buyerId: teamAdmin.id,
      courseId: course.id,
      codes: ["VOID-1"],
    });
    decideRefundRequest(db, {
      refundId: askForRefund(db, teamAdmin.id, refunded.id).id,
      decision: schema.RefundStatus.Approved,
      platformAdminUserId: teamAdmin.id,
    });
    const frozen = buyTeamLicence(db, {
      teamId: team.id,
      buyerId: teamAdmin.id,
      courseId: course.id,
      codes: ["LOCKED-1"],
    });
    askForRefund(db, teamAdmin.id, frozen.id);
    buyTeamLicence(db, {
      teamId: team.id,
      buyerId: teamAdmin.id,
      courseId: course.id,
      codes: ["OPEN-1", "TAKEN-1"],
    });
    claimSeat(db, { code: "TAKEN-1", userId: user.id, userCountry: "US" });

    const seats = listTeamSeats(db, team.id).seats;

    expect(
      Object.fromEntries(
        seats.map((seat) => [seat.code, [seat.status, seat.claimedByEmail]])
      )
    ).toEqual({
      "VOID-1": ["void", null],
      "LOCKED-1": ["locked", null],
      "OPEN-1": ["unclaimed", null],
      "TAKEN-1": ["claimed", "test@example.com"],
    });
  });
});
