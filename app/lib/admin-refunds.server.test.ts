import { describe, it, expect } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import type { Db } from "~/db";
import * as schema from "~/db/schema";
import { buyCourse, claimSeat } from "./enrollments.server";
import { listOpenRefundRequests } from "./admin-refunds.server";

function setup() {
  const db = createTestDb();
  return { db, ...seedBaseData(db) };
}

function addLearner(db: Db, name: string) {
  return db
    .insert(schema.users)
    .values({
      name,
      email: `${name.toLowerCase()}@example.com`,
      role: schema.UserRole.Student,
    })
    .returning()
    .get();
}

function requestRefund(
  db: Db,
  purchaseId: number,
  input: {
    reason?: string;
    requestedAt: string;
    status?: schema.RefundStatus;
  }
) {
  return db
    .insert(schema.refunds)
    .values({
      purchaseId,
      reason: input.reason ?? "It was not what I expected.",
      requestedAt: input.requestedAt,
      status: input.status ?? schema.RefundStatus.Open,
    })
    .returning()
    .get();
}

function addLesson(db: Db, courseId: number, position: number) {
  const module =
    db
      .select()
      .from(schema.modules)
      .all()
      .find((m) => m.courseId === courseId) ??
    db
      .insert(schema.modules)
      .values({ courseId, title: "Module", position: 1 })
      .returning()
      .get();
  return db
    .insert(schema.lessons)
    .values({ moduleId: module.id, title: `Lesson ${position}`, position })
    .returning()
    .get();
}

function watch(db: Db, userId: number, lessonId: number, positionSeconds: number) {
  db.insert(schema.videoWatchEvents)
    .values({ userId, lessonId, eventType: "progress", positionSeconds })
    .run();
}

describe("listOpenRefundRequests", () => {
  it("lists Open Refund Requests oldest first and leaves out decided ones", () => {
    const { db, user, course } = setup();
    const noah = addLearner(db, "Noah");
    const isla = addLearner(db, "Isla");
    const own = (userId: number) =>
      buyCourse(db, { userId, courseId: course.id, amountPaid: 7900, country: "US" })
        .purchase;

    const newer = requestRefund(db, own(user.id).id, {
      requestedAt: "2026-11-10T10:00:00.000Z",
    });
    const older = requestRefund(db, own(noah.id).id, {
      requestedAt: "2026-11-09T10:00:00.000Z",
    });
    requestRefund(db, own(isla.id).id, {
      requestedAt: "2026-11-01T10:00:00.000Z",
      status: schema.RefundStatus.Declined,
    });

    const rows = listOpenRefundRequests(db);

    expect(rows.map((row) => row.id)).toEqual([older.id, newer.id]);
  });

  it("shows who asked, the course, what they paid, when, and the reason", () => {
    const { db, user, course } = setup();
    const purchase = db
      .insert(schema.purchases)
      .values({
        userId: user.id,
        courseId: course.id,
        amountPaid: 4900,
        country: "US",
        createdAt: "2026-11-01T12:00:00.000Z",
      })
      .returning()
      .get();
    requestRefund(db, purchase.id, {
      reason: "The audio is too quiet.",
      requestedAt: "2026-11-04T12:00:00.000Z",
    });

    const [row] = listOpenRefundRequests(db);

    expect(row).toMatchObject({
      requesterName: "Test User",
      courseTitle: "Test Course",
      amountPaid: 4900,
      purchasedAt: "2026-11-01T12:00:00.000Z",
      dayOfWindow: 3,
      reason: "The audio is too quiet.",
    });
  });

  it("shows an own purchase's current watch time and completed lessons", () => {
    const { db, user, course } = setup();
    const [one, two] = [1, 2, 3].map((p) => addLesson(db, course.id, p));
    watch(db, user.id, one.id, 600);
    watch(db, user.id, one.id, 1200); // furthest in lesson one: 20 min
    watch(db, user.id, one.id, 300); // rewatching does not reduce it
    watch(db, user.id, two.id, 900); // 15 min
    db.insert(schema.lessonProgress)
      .values([
        {
          userId: user.id,
          lessonId: one.id,
          status: schema.LessonProgressStatus.Completed,
        },
        {
          userId: user.id,
          lessonId: two.id,
          status: schema.LessonProgressStatus.InProgress,
        },
      ])
      .run();
    const { purchase } = buyCourse(db, {
      userId: user.id,
      courseId: course.id,
      amountPaid: 7900,
      country: "US",
    });
    requestRefund(db, purchase.id, { requestedAt: "2026-11-04T12:00:00.000Z" });

    const [row] = listOpenRefundRequests(db);

    expect(row.progress).toEqual({
      kind: "own",
      watchedSeconds: 2100,
      overWatchLimit: false,
      completedLessons: 1,
      totalLessons: 3,
    });
  });

  it("flags an own purchase watched past the 2-hour limit", () => {
    const { db, user, course } = setup();
    const lesson = addLesson(db, course.id, 1);
    watch(db, user.id, lesson.id, 2 * 60 * 60 + 1);
    const { purchase } = buyCourse(db, {
      userId: user.id,
      courseId: course.id,
      amountPaid: 7900,
      country: "US",
    });
    requestRefund(db, purchase.id, { requestedAt: "2026-11-04T12:00:00.000Z" });

    const [row] = listOpenRefundRequests(db);

    expect(row.progress).toMatchObject({ kind: "own", overWatchLimit: true });
  });

  it("shows a Team Licence's claimed seats instead of watch time", () => {
    const { db, user, course } = setup();
    const ava = addLearner(db, "Ava");
    const team = db.insert(schema.teams).values({}).returning().get();
    const purchase = db
      .insert(schema.purchases)
      .values({ userId: ava.id, courseId: course.id, amountPaid: 23700, country: null })
      .returning()
      .get();
    for (const code of ["SEAT-1", "SEAT-2", "SEAT-3"]) {
      db.insert(schema.coupons)
        .values({ teamId: team.id, courseId: course.id, code, purchaseId: purchase.id })
        .run();
    }
    claimSeat(db, { code: "SEAT-1", userId: user.id, userCountry: "US" });
    requestRefund(db, purchase.id, { requestedAt: "2026-11-04T12:00:00.000Z" });

    const [row] = listOpenRefundRequests(db);

    expect(row.requesterName).toBe("Ava");
    expect(row.progress).toEqual({
      kind: "teamLicence",
      claimedSeats: 1,
      totalSeats: 3,
    });
  });
});
