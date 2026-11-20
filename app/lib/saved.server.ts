import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { and, desc, eq } from "drizzle-orm";
import * as schema from "~/db/schema";
import { bookmarks, courses, lessons, modules, notes } from "~/db/schema";
import { MAX_NOTE_LENGTH } from "~/lib/notes";

// ─── Bookmarks and Notes ───
// A Student's own Bookmark and Note on a Lesson. See GLOSSARY.md.
//
// A Note is private to the Student who wrote it: every read here is scoped to
// one Student, and nothing outside the Student's own Lesson page and Saved
// page may read Note bodies.
//
// Content access is the caller's job (the Lesson action runs
// requireContentAccess before calling in). Every function takes the database
// first, so tests can hand in an in-memory one. Uses positional parameters
// (project convention).

export type Db = BetterSQLite3Database<typeof schema>;

export function isBookmarked(db: Db, userId: number, lessonId: number) {
  return !!db
    .select({ id: bookmarks.id })
    .from(bookmarks)
    .where(and(eq(bookmarks.userId, userId), eq(bookmarks.lessonId, lessonId)))
    .get();
}

/** Adds the Bookmark if there is none, removes it if there is one. Returns whether the Lesson is now bookmarked. */
export function toggleBookmark(
  db: Db,
  userId: number,
  lessonId: number,
  now: Date
): boolean {
  const removed = db
    .delete(bookmarks)
    .where(and(eq(bookmarks.userId, userId), eq(bookmarks.lessonId, lessonId)))
    .returning({ id: bookmarks.id })
    .all();
  if (removed.length > 0) return false;

  // The unique index on (user, lesson) is what keeps this to one Bookmark if
  // two requests race.
  db.insert(bookmarks)
    .values({ userId, lessonId, createdAt: now.toISOString() })
    .onConflictDoNothing()
    .run();
  return true;
}

export function getNote(db: Db, userId: number, lessonId: number) {
  return db
    .select({ body: notes.body, updatedAt: notes.updatedAt })
    .from(notes)
    .where(and(eq(notes.userId, userId), eq(notes.lessonId, lessonId)))
    .get();
}

export type SaveNoteResult =
  | { ok: true; note: { body: string; updatedAt: string } }
  | { ok: false; error: string };

/**
 * Creates the Student's Note on a Lesson, or replaces its body and moves
 * "last edited" on. The body is trimmed; an empty or over-long one is refused,
 * never truncated.
 */
export function saveNote(
  db: Db,
  userId: number,
  lessonId: number,
  body: string,
  now: Date
): SaveNoteResult {
  const trimmed = body.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: "Write something before saving your note." };
  }
  if (trimmed.length > MAX_NOTE_LENGTH) {
    return {
      ok: false,
      error: `A note can be at most ${MAX_NOTE_LENGTH.toLocaleString("en")} characters.`,
    };
  }

  const at = now.toISOString();
  const note = db
    .insert(notes)
    .values({ userId, lessonId, body: trimmed, createdAt: at, updatedAt: at })
    .onConflictDoUpdate({
      target: [notes.userId, notes.lessonId],
      set: { body: trimmed, updatedAt: at },
    })
    .returning({ body: notes.body, updatedAt: notes.updatedAt })
    .get();

  return { ok: true, note };
}

const lessonRef = {
  lessonId: lessons.id,
  lessonTitle: lessons.title,
  courseTitle: courses.title,
  courseSlug: courses.slug,
};

/** The Student's own Bookmarks, newest first, each with its Lesson and Course. */
export function listBookmarks(db: Db, userId: number) {
  return db
    .select({ id: bookmarks.id, createdAt: bookmarks.createdAt, ...lessonRef })
    .from(bookmarks)
    .innerJoin(lessons, eq(bookmarks.lessonId, lessons.id))
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .innerJoin(courses, eq(modules.courseId, courses.id))
    .where(eq(bookmarks.userId, userId))
    .orderBy(desc(bookmarks.createdAt), desc(bookmarks.id))
    .all();
}

/** The Student's own Notes, last edited first, each with its Lesson and Course. */
export function listNotes(db: Db, userId: number) {
  return db
    .select({
      id: notes.id,
      body: notes.body,
      updatedAt: notes.updatedAt,
      ...lessonRef,
    })
    .from(notes)
    .innerJoin(lessons, eq(notes.lessonId, lessons.id))
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .innerJoin(courses, eq(modules.courseId, courses.id))
    .where(eq(notes.userId, userId))
    .orderBy(desc(notes.updatedAt), desc(notes.id))
    .all();
}
