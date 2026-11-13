import { describe, it, expect } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import type { Db } from "~/db";
import * as schema from "~/db/schema";
import { buyCourse } from "./enrollments.server";
import { decideRefundRequest } from "./admin-refunds.server";
import { getCourseQuizPassRates } from "./course-analytics.server";

function addUser(db: Db, name: string, role = schema.UserRole.Student) {
  return db
    .insert(schema.users)
    .values({ name, email: `${name.toLowerCase()}@example.com`, role })
    .returning()
    .get();
}

function addQuiz(db: Db, courseId: number) {
  const module = db
    .insert(schema.modules)
    .values({ courseId, title: "Module", position: 1 })
    .returning()
    .get();
  const lesson = db
    .insert(schema.lessons)
    .values({ moduleId: module.id, title: "Lesson", position: 1 })
    .returning()
    .get();
  return db
    .insert(schema.quizzes)
    .values({ lessonId: lesson.id, title: "Check", passingScore: 0.7 })
    .returning()
    .get();
}

function attempt(db: Db, userId: number, quizId: number, score: number) {
  db.insert(schema.quizAttempts)
    .values({ userId, quizId, score, passed: score >= 0.7 })
    .run();
}

function refundAndApprove(db: Db, purchaseId: number) {
  const admin = addUser(db, "Pat", schema.UserRole.Admin);
  const refund = db
    .insert(schema.refunds)
    .values({
      purchaseId,
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
}

describe("getCourseQuizPassRates", () => {
  it("leaves a refunded learner's quiz attempts out of the pass rate", () => {
    const db = createTestDb();
    const { user, course } = seedBaseData(db);
    const noah = addUser(db, "Noah");
    const quiz = addQuiz(db, course.id);

    const own = buyCourse(db, {
      userId: user.id,
      courseId: course.id,
      amountPaid: 7900,
      country: "US",
    });
    buyCourse(db, {
      userId: noah.id,
      courseId: course.id,
      amountPaid: 7900,
      country: "US",
    });
    attempt(db, user.id, quiz.id, 0.2);
    attempt(db, noah.id, quiz.id, 0.9);

    refundAndApprove(db, own.purchase.id);

    const [rate] = getCourseQuizPassRates(db, course.id, "all");
    expect(rate).toMatchObject({
      quizId: quiz.id,
      studentCount: 1,
      passedCount: 1,
      passRatePercent: 100,
      averageBestScorePercent: 90,
    });
  });
});
