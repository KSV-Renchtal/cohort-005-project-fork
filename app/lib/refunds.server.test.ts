import { describe, it, expect } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import type { Db } from "~/db";
import * as schema from "~/db/schema";
import { eq } from "drizzle-orm";
import { buyCourse, claimSeat, findEnrollment } from "./enrollments.server";
import { decideRefundRequest } from "./admin-refunds.server";
import {
  findRefundableOwnPurchase,
  listTeamLicences,
  ownPurchaseRefundOffer,
  requestOwnPurchaseRefund,
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

function setPurchasedAt(db: Db, purchaseId: number, when: Date) {
  db.update(schema.purchases)
    .set({ createdAt: when.toISOString() })
    .where(eq(schema.purchases.id, purchaseId))
    .run();
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

describe("requestOwnPurchaseRefund", () => {
  it("asks for the learner's own purchase back, never a Team Licence they bought", () => {
    const { db, course, buyer, purchase: teamLicence } = setup();
    const { purchase: own } = buyCourse(db, {
      userId: buyer.id,
      courseId: course.id,
      amountPaid: 7900,
      country: null,
    });
    // The Team Licence is the newer of the two purchases.
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    setPurchasedAt(db, own.id, yesterday);
    setPurchasedAt(db, teamLicence.id, new Date());

    const { request } = requestOwnPurchaseRefund(db, {
      userId: buyer.id,
      courseId: course.id,
      reason: REASON,
    });

    expect(request.purchaseId).toBe(own.id);
  });

  it("allows a new request after a decline, but none after an approval", () => {
    const { db, course, learner, admin } = ownPurchaseSetup();
    const ask = () =>
      requestOwnPurchaseRefund(db, {
        userId: learner.id,
        courseId: course.id,
        reason: REASON,
      }).request;
    const decide = (
      refundId: number,
      decision: schema.RefundStatus.Approved | schema.RefundStatus.Declined
    ) =>
      decideRefundRequest(db, { refundId, decision, platformAdminUserId: admin.id });

    decide(ask().id, schema.RefundStatus.Declined);
    decide(ask().id, schema.RefundStatus.Approved);

    expect(rejection(ask)).toMatchObject({ init: { status: 403 } });
  });

  it("lets a refunded learner buy again and ask again", () => {
    const { db, course, learner, admin } = ownPurchaseSetup();
    const { request } = requestOwnPurchaseRefund(db, {
      userId: learner.id,
      courseId: course.id,
      reason: REASON,
    });
    decideRefundRequest(db, {
      refundId: request.id,
      decision: schema.RefundStatus.Approved,
      platformAdminUserId: admin.id,
    });

    buyCourse(db, {
      userId: learner.id,
      courseId: course.id,
      amountPaid: 7900,
      country: null,
    });
    const ask = () =>
      requestOwnPurchaseRefund(db, {
        userId: learner.id,
        courseId: course.id,
        reason: REASON,
      });

    expect(ask().request.status).toBe(schema.RefundStatus.Open);
    expect(findEnrollment(db, learner.id, course.id)).toBeDefined();
  });

  it("counts watch time from before a refund towards the 2-hour limit", () => {
    const { db, course, learner, admin, lesson } = ownPurchaseSetup();
    watch(db, learner.id, lesson.id, 2 * 60 * 60);
    const purchaseId = findEnrollment(db, learner.id, course.id)?.purchaseId;
    const refund = db
      .insert(schema.refunds)
      .values({ purchaseId: purchaseId ?? 0, reason: REASON })
      .returning()
      .get();
    decideRefundRequest(db, {
      refundId: refund.id,
      decision: schema.RefundStatus.Approved,
      platformAdminUserId: admin.id,
    });

    buyCourse(db, {
      userId: learner.id,
      courseId: course.id,
      amountPaid: 7900,
      country: null,
    });

    expect(
      rejection(() =>
        requestOwnPurchaseRefund(db, {
          userId: learner.id,
          courseId: course.id,
          reason: REASON,
        })
      )
    ).toMatchObject({ init: { status: 403 } });
  });

  it("is not offered to a learner who claimed a seat", () => {
    const { db, course, learner } = setup();
    claimSeat(db, { code: "SEAT-1", userId: learner.id, userCountry: "US" });

    const error = rejection(() =>
      requestOwnPurchaseRefund(db, {
        userId: learner.id,
        courseId: course.id,
        reason: REASON,
      })
    );

    expect(error).toMatchObject({ init: { status: 403 } });
  });
});

function ownPurchaseSetup() {
  const db = createTestDb();
  const { course, user: learner } = seedBaseData(db);
  const admin = db
    .insert(schema.users)
    .values({ name: "Admin", email: "admin@example.com", role: schema.UserRole.Admin })
    .returning()
    .get();
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
  buyCourse(db, {
    userId: learner.id,
    courseId: course.id,
    amountPaid: 7900,
    country: null,
  });
  return { db, course, learner, admin, lesson };
}

function watch(db: Db, userId: number, lessonId: number, positionSeconds: number) {
  db.insert(schema.videoWatchEvents)
    .values({ userId, lessonId, eventType: "progress", positionSeconds })
    .run();
}

describe("ownPurchaseRefundOffer", () => {
  it("offers the learner's own purchase back until it is refunded", () => {
    const { db, course, learner, admin } = ownPurchaseSetup();
    const offer = () => ownPurchaseRefundOffer(db, learner.id, course.id);

    expect(offer()).toMatchObject({ amount: 7900 });

    const { request } = requestOwnPurchaseRefund(db, {
      userId: learner.id,
      courseId: course.id,
      reason: REASON,
    });
    decideRefundRequest(db, {
      refundId: request.id,
      decision: schema.RefundStatus.Approved,
      platformAdminUserId: admin.id,
    });

    expect(offer()).toBeNull();
  });

  it("offers nothing to the buyer of a Team Licence or a learner with a seat", () => {
    const { db, course, buyer, learner } = setup();
    claimSeat(db, { code: "SEAT-1", userId: learner.id, userCountry: "US" });

    expect(ownPurchaseRefundOffer(db, buyer.id, course.id)).toBeNull();
    expect(ownPurchaseRefundOffer(db, learner.id, course.id)).toBeNull();
  });
});

describe("findRefundableOwnPurchase", () => {
  it("returns the learner's own purchase when a Refund Request can be raised on it", () => {
    const { db, course, learner } = ownPurchaseSetup();

    expect(findRefundableOwnPurchase(db, learner.id, course.id)).toMatchObject({
      userId: learner.id,
      courseId: course.id,
      amountPaid: 7900,
    });
  });

  it("refuses, before any reason is looked at, when a rule blocks the request", () => {
    const { db, course, learner, lesson } = ownPurchaseSetup();
    watch(db, learner.id, lesson.id, 2 * 60 * 60);

    expect(
      rejection(() => findRefundableOwnPurchase(db, learner.id, course.id))
    ).toMatchObject({
      data: "You have watched too much of this course to request a refund.",
      init: { status: 403 },
    });
  });

  it("refuses a learner who did not buy the course", () => {
    const { db, course, admin } = ownPurchaseSetup();

    expect(
      rejection(() => findRefundableOwnPurchase(db, admin.id, course.id))
    ).toMatchObject({
      data: "You have not bought this course.",
      init: { status: 403 },
    });
  });
});
