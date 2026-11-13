import { and, count, eq, gte, inArray, sql } from "drizzle-orm";
import type { Db } from "~/db";
import {
  enrollments,
  lessons,
  modules,
  quizAttempts,
  quizzes,
} from "~/db/schema";
import { rangeStart, type AnalyticsRange } from "~/lib/analytics";

export type QuizPassRate = {
  quizId: number;
  title: string;
  moduleTitle: string;
  lessonTitle: string;
  passingScorePercent: number;
  studentCount: number;
  passedCount: number;
  passRatePercent: number | null;
  averageBestScorePercent: number | null;
};

/**
 * Pass rate per quiz of a course, over the learners Enrolled in it today.
 * Quiz attempts outlive a refund (progress is kept), so the Enrollment join is
 * what keeps a refunded learner out of the numbers.
 */
export function getCourseQuizPassRates(
  db: Db,
  courseId: number,
  range: AnalyticsRange
): QuizPassRate[] {
  const quizRows = db
    .select({
      quizId: quizzes.id,
      title: quizzes.title,
      passingScore: quizzes.passingScore,
      moduleTitle: modules.title,
      lessonTitle: lessons.title,
    })
    .from(quizzes)
    .innerJoin(lessons, eq(quizzes.lessonId, lessons.id))
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(modules.courseId, courseId))
    .orderBy(modules.position, lessons.position, quizzes.id)
    .all();

  if (quizRows.length === 0) return [];

  const quizIds = quizRows.map((quiz) => quiz.quizId);
  const start = rangeStart(range);

  // One row per student per quiz, holding the best they managed.
  //
  // `passed` and `score` are selected bare beside `max(score)`: SQLite answers
  // those from the very row the maximum came from, which is how the best
  // attempt's own recorded verdict is read rather than a fresh comparison.
  const bestAttempts = db
    .select({
      quizId: quizAttempts.quizId,
      bestScore: sql<number>`max(${quizAttempts.score})`.as("best_score"),
      passed: sql<number>`${quizAttempts.passed}`.as("best_passed"),
    })
    .from(quizAttempts)
    .innerJoin(
      enrollments,
      and(
        eq(enrollments.userId, quizAttempts.userId),
        eq(enrollments.courseId, courseId)
      )
    )
    .where(
      and(
        inArray(quizAttempts.quizId, quizIds),
        start === null ? undefined : gte(quizAttempts.attemptedAt, start)
      )
    )
    .groupBy(quizAttempts.quizId, quizAttempts.userId)
    .as("best_attempts");

  const stats = db
    .select({
      quizId: bestAttempts.quizId,
      studentCount: count(),
      passedCount: sql<number>`sum(${bestAttempts.passed})`,
      averageBestScore: sql<number>`avg(${bestAttempts.bestScore})`,
    })
    .from(bestAttempts)
    .groupBy(bestAttempts.quizId)
    .all();

  const statsByQuiz = new Map(stats.map((row) => [row.quizId, row]));

  return quizRows.map((quiz) => {
    const row = statsByQuiz.get(quiz.quizId);
    const studentCount = row?.studentCount ?? 0;
    const passedCount = Number(row?.passedCount ?? 0);

    return {
      quizId: quiz.quizId,
      title: quiz.title,
      moduleTitle: quiz.moduleTitle,
      lessonTitle: quiz.lessonTitle,
      passingScorePercent: Math.round(quiz.passingScore * 100),
      studentCount,
      passedCount,
      passRatePercent:
        studentCount === 0
          ? null
          : Math.round((passedCount / studentCount) * 100),
      averageBestScorePercent:
        studentCount === 0
          ? null
          : Math.round(Number(row?.averageBestScore ?? 0) * 100),
    };
  });
}
