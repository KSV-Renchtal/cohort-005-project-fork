import { describe, it, expect } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import type { Db } from "~/db";
import * as schema from "~/db/schema";
import { eq } from "drizzle-orm";
import { claimSeat } from "./enrollments.server";
import {
  listTeamLicences,
  requestTeamLicenceRefund,
} from "./refunds.server";

const BOUGHT_AT = new Date(2026, 0, 10, 23, 0);
const REASON = "Our team changed plans and won't use these seats.";

function setup() {
  const db = createTestDb();
  const { course, user } = seedBaseData(db);
  const buyer = addUser(db, "ava@example.com");
  const team = db.insert(schema.teams).values({}).returning().get();
  addTeamMember(db, team.id, buyer.id, schema.TeamMemberRole.Admin);
  const purchase = db
    .insert(schema.purchases)
    .values({
      userId: buyer.id,
      courseId: course.id,
      amountPaid: 7900 * 2,
      country: null,
      createdAt: BOUGHT_AT.toISOString(),
    })
    .returning()
    .get();
  for (const code of ["SEAT-1", "SEAT-2"]) {
    db.insert(schema.coupons)
      .values({ teamId: team.id, courseId: course.id, code, purchaseId: purchase.id })
      .run();
  }
  return { db, course, learner: user, buyer, team, purchase };
}

function addUser(db: Db, email: string) {
  return db
    .insert(schema.users)
    .values({ name: email, email, role: schema.UserRole.Student })
    .returning()
    .get();
}

function addTeamMember(
  db: Db,
  teamId: number,
  userId: number,
  role: schema.TeamMemberRole
) {
  db.insert(schema.teamMembers).values({ teamId, userId, role }).run();
}

function eqId(id: number) {
  return eq(schema.refunds.id, id);
}

function daysAfterPurchase(days: number, hour = 12) {
  const when = new Date(BOUGHT_AT);
  when.setDate(when.getDate() + days);
  when.setHours(hour);
  return when;
}

function rejection(fn: () => unknown) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("Expected the request to be rejected");
}

describe("requestTeamLicenceRefund", () => {
  it("opens a Refund Request on the Team Licence for its buyer", () => {
    const { db, buyer, team, purchase } = setup();

    requestTeamLicenceRefund(
      db,
      { userId: buyer.id, purchaseId: purchase.id, reason: REASON },
      daysAfterPurchase(3)
    );

    const [licence] = listTeamLicences(db, team.id, daysAfterPurchase(3));
    expect(licence?.latestRefundRequest).toMatchObject({
      status: schema.RefundStatus.Open,
      reason: REASON,
    });
  });

  it("lets any Team Admin of the team ask, not only the buyer", () => {
    const { db, team, purchase } = setup();
    const otherAdmin = addUser(db, "otto@example.com");
    addTeamMember(db, team.id, otherAdmin.id, schema.TeamMemberRole.Admin);

    const request = requestTeamLicenceRefund(
      db,
      { userId: otherAdmin.id, purchaseId: purchase.id, reason: REASON },
      daysAfterPurchase(3)
    );

    expect(request.status).toBe(schema.RefundStatus.Open);
  });

  it("refuses team members who are not Team Admins, and outsiders", () => {
    const { db, team, purchase } = setup();
    const member = addUser(db, "mia@example.com");
    addTeamMember(db, team.id, member.id, schema.TeamMemberRole.Member);
    const outsider = addUser(db, "olga@example.com");
    const otherTeam = db.insert(schema.teams).values({}).returning().get();
    addTeamMember(db, otherTeam.id, outsider.id, schema.TeamMemberRole.Admin);

    for (const user of [member, outsider]) {
      const error = rejection(() =>
        requestTeamLicenceRefund(
          db,
          { userId: user.id, purchaseId: purchase.id, reason: REASON },
          daysAfterPurchase(3)
        )
      );
      expect(error).toMatchObject({ init: { status: 403 } });
    }
  });

  it("is open until the end of the fourteenth calendar day", () => {
    const { db, buyer, purchase } = setup();
    const ask = (now: Date) =>
      requestTeamLicenceRefund(
        db,
        { userId: buyer.id, purchaseId: purchase.id, reason: REASON },
        now
      );

    expect(rejection(() => ask(daysAfterPurchase(15, 0)))).toMatchObject({
      init: { status: 403 },
    });
    expect(ask(daysAfterPurchase(14, 23)).status).toBe(
      schema.RefundStatus.Open
    );
  });

  it("allows only one Open Refund Request at a time", () => {
    const { db, buyer, purchase } = setup();
    const ask = () =>
      requestTeamLicenceRefund(
        db,
        { userId: buyer.id, purchaseId: purchase.id, reason: REASON },
        daysAfterPurchase(3)
      );

    ask();

    expect(rejection(ask)).toMatchObject({ init: { status: 409 } });
  });

  it("allows a new request after a decline, but none after an approval", () => {
    const { db, buyer, purchase } = setup();
    const ask = () =>
      requestTeamLicenceRefund(
        db,
        { userId: buyer.id, purchaseId: purchase.id, reason: REASON },
        daysAfterPurchase(3)
      );
    const decide = (id: number, status: schema.RefundStatus) =>
      db
        .update(schema.refunds)
        .set({ status })
        .where(eqId(id))
        .run();

    decide(ask().id, schema.RefundStatus.Declined);
    decide(ask().id, schema.RefundStatus.Approved);

    expect(rejection(ask)).toMatchObject({ init: { status: 403 } });
  });

  it("is not possible once the Team Licence has a Claimed Seat", () => {
    const { db, buyer, learner, purchase } = setup();
    claimSeat(db, { code: "SEAT-1", userId: learner.id, userCountry: "US" });

    const error = rejection(() =>
      requestTeamLicenceRefund(
        db,
        { userId: buyer.id, purchaseId: purchase.id, reason: REASON },
        daysAfterPurchase(3)
      )
    );

    expect(error).toMatchObject({ init: { status: 403 } });
  });

  it("ignores how much the Team Admin has watched of the course", () => {
    const { db, buyer, course, purchase } = setup();
    const module = db
      .insert(schema.modules)
      .values({ courseId: course.id, title: "Intro", position: 1 })
      .returning()
      .get();
    const lesson = db
      .insert(schema.lessons)
      .values({ moduleId: module.id, title: "Welcome", position: 1 })
      .returning()
      .get();
    db.insert(schema.videoWatchEvents)
      .values({
        userId: buyer.id,
        lessonId: lesson.id,
        eventType: "progress",
        positionSeconds: 3 * 60 * 60,
      })
      .run();

    const request = requestTeamLicenceRefund(
      db,
      { userId: buyer.id, purchaseId: purchase.id, reason: REASON },
      daysAfterPurchase(3)
    );

    expect(request.status).toBe(schema.RefundStatus.Open);
  });
});

describe("listTeamLicences", () => {
  it("offers a refund on a Team Licence nobody has claimed a seat from", () => {
    const { db, team, purchase } = setup();

    const licences = listTeamLicences(db, team.id, daysAfterPurchase(3));

    expect(licences).toEqual([
      expect.objectContaining({
        purchaseId: purchase.id,
        courseTitle: "Test Course",
        amountPaid: 15800,
        totalSeats: 2,
        claimedSeats: 0,
        refundOffer: { lastDayInWindow: "2026-01-24" },
        refundBlockedBecause: null,
      }),
    ]);
  });

  it("says why no refund is offered once a seat is claimed", () => {
    const { db, team, learner } = setup();
    claimSeat(db, { code: "SEAT-1", userId: learner.id, userCountry: "US" });

    const [licence] = listTeamLicences(db, team.id, daysAfterPurchase(3));

    expect(licence).toMatchObject({
      claimedSeats: 1,
      refundOffer: null,
      refundBlockedBecause:
        "A Team Licence with a claimed seat cannot be refunded.",
    });
  });
});
