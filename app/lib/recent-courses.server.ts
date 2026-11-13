import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "~/db";
import {
  courses,
  enrollments,
  lessonProgress,
  lessons,
  modules,
} from "~/db/schema";

/**
 * The learner's most recently worked-on courses, newest activity first.
 * Progress outlives a refund, so only courses the learner is still Enrolled in
 * count.
 */
export function listRecentlyProgressedCourses(
  db: Db,
  userId: number,
  limit: number = 3
) {
  return db
    .select({
      courseId: courses.id,
      courseTitle: courses.title,
      courseSlug: courses.slug,
      coverImageUrl: courses.coverImageUrl,
      lastActivityId: sql<number>`max(${lessonProgress.id})`,
    })
    .from(lessonProgress)
    .innerJoin(lessons, eq(lessonProgress.lessonId, lessons.id))
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .innerJoin(courses, eq(modules.courseId, courses.id))
    .innerJoin(
      enrollments,
      and(
        eq(enrollments.courseId, courses.id),
        eq(enrollments.userId, lessonProgress.userId)
      )
    )
    .where(eq(lessonProgress.userId, userId))
    .groupBy(courses.id)
    .orderBy(desc(sql`max(${lessonProgress.id})`))
    .limit(limit)
    .all();
}
