import { describe, it, expect } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import type { Db } from "~/db";
import * as schema from "~/db/schema";
import { buyCourse } from "./enrollments.server";
import { decideRefundRequest } from "./admin-refunds.server";
import { listRecentlyProgressedCourses } from "./recent-courses.server";

function addLesson(db: Db, courseId: number) {
  const module = db
    .insert(schema.modules)
    .values({ courseId, title: "Module", position: 1 })
    .returning()
    .get();
  return db
    .insert(schema.lessons)
    .values({ moduleId: module.id, title: "Lesson", position: 1 })
    .returning()
    .get();
}

function addCourse(
  db: Db,
  base: typeof schema.courses.$inferSelect,
  slug: string
) {
  return db
    .insert(schema.courses)
    .values({
      title: slug,
      slug,
      description: base.description,
      salesCopy: base.salesCopy,
      instructorId: base.instructorId,
      categoryId: base.categoryId,
      status: base.status,
    })
    .returning()
    .get();
}

function complete(db: Db, userId: number, lessonId: number) {
  db.insert(schema.lessonProgress)
    .values({
      userId,
      lessonId,
      status: schema.LessonProgressStatus.Completed,
      completedAt: new Date().toISOString(),
    })
    .run();
}

describe("listRecentlyProgressedCourses", () => {
  it("leaves out a course whose Refund Request was approved, though progress is kept", () => {
    const db = createTestDb();
    const { user, course } = seedBaseData(db);
    const other = addCourse(db, course, "other-course");
    const refunded = buyCourse(db, {
      userId: user.id,
      courseId: course.id,
      amountPaid: 7900,
      country: "US",
    });
    buyCourse(db, {
      userId: user.id,
      courseId: other.id,
      amountPaid: 7900,
      country: "US",
    });
    complete(db, user.id, addLesson(db, other.id).id);
    complete(db, user.id, addLesson(db, course.id).id);

    const admin = db
      .insert(schema.users)
      .values({
        name: "Pat",
        email: "pat@example.com",
        role: schema.UserRole.Admin,
      })
      .returning()
      .get();
    const refund = db
      .insert(schema.refunds)
      .values({
        purchaseId: refunded.purchase.id,
        reason: "Not for me.",
        requestedAt: new Date().toISOString(),
        status: schema.RefundStatus.Open,
      })
      .returning()
      .get();
    decideRefundRequest(db, {
      refundId: refund.id,
      decision: "approve",
      adminUserId: admin.id,
    });

    expect(
      listRecentlyProgressedCourses(db, user.id).map((c) => c.courseSlug)
    ).toEqual(["other-course"]);
  });
});
