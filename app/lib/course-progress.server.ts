import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "~/db";
import {
  LessonProgressStatus,
  lessonProgress,
  lessons,
  modules,
  videoWatchEvents,
} from "~/db/schema";

/**
 * A learner's progress in one course right now: watch time is the furthest
 * position reached in each lesson, summed, plus how many of the course's
 * lessons they completed. Progress is per learner and lesson, so it outlives
 * any one Enrollment.
 */
export function getCourseProgress(db: Db, userId: number, courseId: number) {
  const lessonIds = db
    .select({ id: lessons.id })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(modules.courseId, courseId))
    .all()
    .map((row) => row.id);

  if (lessonIds.length === 0) {
    return { watchedSeconds: 0, completedLessons: 0, totalLessons: 0 };
  }

  const watchedSeconds = db
    .select({
      furthest: sql<number>`max(${videoWatchEvents.positionSeconds})`,
    })
    .from(videoWatchEvents)
    .where(
      and(
        eq(videoWatchEvents.userId, userId),
        inArray(videoWatchEvents.lessonId, lessonIds)
      )
    )
    .groupBy(videoWatchEvents.lessonId)
    .all()
    .reduce((total, row) => total + row.furthest, 0);

  const completed = db
    .select({ count: sql<number>`count(distinct ${lessonProgress.lessonId})` })
    .from(lessonProgress)
    .where(
      and(
        eq(lessonProgress.userId, userId),
        eq(lessonProgress.status, LessonProgressStatus.Completed),
        inArray(lessonProgress.lessonId, lessonIds)
      )
    )
    .get();

  return {
    watchedSeconds,
    completedLessons: completed?.count ?? 0,
    totalLessons: lessonIds.length,
  };
}
