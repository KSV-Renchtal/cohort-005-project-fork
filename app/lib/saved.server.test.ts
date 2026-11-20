import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { UserRole } from "~/db/schema";
import {
  getNote,
  isBookmarked,
  listBookmarks,
  listNotes,
  saveNote,
  toggleBookmark,
} from "./saved.server";
import { approveRefundRequest, raiseRefundRequest } from "./refunds.server";
import { fakeNotifications } from "./notifications.fake.server";

type TestDb = ReturnType<typeof createTestDb>;

const NOW = new Date(2026, 9, 6, 12, 0, 0);
const LATER = new Date(2026, 9, 6, 13, 0, 0);
const LATEST = new Date(2026, 9, 6, 14, 0, 0);

let db: TestDb;
let base: ReturnType<typeof seedBaseData>;
let lessonIds: number[];

beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);

  const module = db
    .insert(schema.modules)
    .values({ courseId: base.course.id, title: "Basics", position: 1 })
    .returning()
    .get();

  lessonIds = [1, 2, 3].map(
    (position) =>
      db
        .insert(schema.lessons)
        .values({ moduleId: module.id, title: `Lesson ${position}`, position })
        .returning()
        .get().id
  );
});

function addStudent(name: string) {
  return db
    .insert(schema.users)
    .values({
      name,
      email: `${name.toLowerCase()}@example.com`,
      role: UserRole.Student,
    })
    .returning()
    .get();
}

describe("toggling a Bookmark", () => {
  it("bookmarks a Lesson, then removes the Bookmark on the second toggle", () => {
    const [lessonId] = lessonIds;

    expect(toggleBookmark(db, base.user.id, lessonId, NOW)).toBe(true);
    expect(isBookmarked(db, base.user.id, lessonId)).toBe(true);

    expect(toggleBookmark(db, base.user.id, lessonId, LATER)).toBe(false);
    expect(isBookmarked(db, base.user.id, lessonId)).toBe(false);
  });

  it("never leaves a Student with two Bookmarks on one Lesson", () => {
    const [lessonId] = lessonIds;
    toggleBookmark(db, base.user.id, lessonId, NOW);

    expect(() =>
      db
        .insert(schema.bookmarks)
        .values({ userId: base.user.id, lessonId })
        .run()
    ).toThrow();
    expect(listBookmarks(db, base.user.id)).toHaveLength(1);
  });
});

describe("saving a Note", () => {
  it("creates the Note with its body trimmed", () => {
    const result = saveNote(db, base.user.id, lessonIds[0], "  # Not a heading  ", NOW);

    expect(result).toEqual({
      ok: true,
      note: { body: "# Not a heading", updatedAt: NOW.toISOString() },
    });
    expect(getNote(db, base.user.id, lessonIds[0])).toEqual({
      body: "# Not a heading",
      updatedAt: NOW.toISOString(),
    });
  });

  it("replaces the body and moves 'last edited' on when saved again", () => {
    saveNote(db, base.user.id, lessonIds[0], "First draft", NOW);
    saveNote(db, base.user.id, lessonIds[0], "Second draft", LATER);

    expect(getNote(db, base.user.id, lessonIds[0])).toEqual({
      body: "Second draft",
      updatedAt: LATER.toISOString(),
    });
    expect(listNotes(db, base.user.id)).toHaveLength(1);
  });

  it("never leaves a Student with two Notes on one Lesson", () => {
    saveNote(db, base.user.id, lessonIds[0], "Mine", NOW);

    expect(() =>
      db
        .insert(schema.notes)
        .values({ userId: base.user.id, lessonId: lessonIds[0], body: "Dup" })
        .run()
    ).toThrow();
  });

  it("accepts exactly 2,000 characters and refuses 2,001", () => {
    expect(saveNote(db, base.user.id, lessonIds[0], "a".repeat(2000), NOW).ok).toBe(true);

    const refused = saveNote(db, base.user.id, lessonIds[1], "a".repeat(2001), NOW);
    expect(refused).toEqual({
      ok: false,
      error: "A note can be at most 2,000 characters.",
    });
    expect(getNote(db, base.user.id, lessonIds[1])).toBeUndefined();
  });

  it("refuses an empty Note", () => {
    expect(saveNote(db, base.user.id, lessonIds[0], "   ", NOW).ok).toBe(false);
    expect(getNote(db, base.user.id, lessonIds[0])).toBeUndefined();
  });
});

describe("the Saved lists", () => {
  it("lists only the Student's own Bookmarks, newest first, with Lesson and Course", () => {
    const other = addStudent("Other");
    toggleBookmark(db, base.user.id, lessonIds[0], NOW);
    toggleBookmark(db, base.user.id, lessonIds[2], LATER);
    toggleBookmark(db, other.id, lessonIds[1], LATEST);

    expect(listBookmarks(db, base.user.id)).toEqual([
      expect.objectContaining({
        lessonId: lessonIds[2],
        lessonTitle: "Lesson 3",
        courseTitle: "Test Course",
        courseSlug: "test-course",
      }),
      expect.objectContaining({ lessonId: lessonIds[0], lessonTitle: "Lesson 1" }),
    ]);
  });

  it("lists only the Student's own Notes, last edited first, with Lesson and Course", () => {
    const other = addStudent("Other");
    saveNote(db, base.user.id, lessonIds[0], "Old note", NOW);
    saveNote(db, base.user.id, lessonIds[1], "Middle note", LATER);
    saveNote(db, other.id, lessonIds[2], "Not mine", LATEST);
    saveNote(db, base.user.id, lessonIds[0], "Old note, edited", LATEST);

    expect(listNotes(db, base.user.id)).toEqual([
      expect.objectContaining({
        body: "Old note, edited",
        lessonTitle: "Lesson 1",
        courseTitle: "Test Course",
        courseSlug: "test-course",
      }),
      expect.objectContaining({ body: "Middle note", lessonTitle: "Lesson 2" }),
    ]);
  });
});

describe("approving a Refund", () => {
  it("keeps the Student's Bookmarks and Notes", async () => {
    const notifications = fakeNotifications();
    const admin = db
      .insert(schema.users)
      .values({ name: "Pat Admin", email: "pat@example.com", role: UserRole.Admin })
      .returning()
      .get();
    const purchase = db
      .insert(schema.purchases)
      .values({
        userId: base.user.id,
        courseId: base.course.id,
        amountPaid: 7900,
        createdAt: new Date(2026, 9, 3).toISOString(),
      })
      .returning()
      .get();
    db.insert(schema.enrollments)
      .values({ userId: base.user.id, courseId: base.course.id })
      .run();

    toggleBookmark(db, base.user.id, lessonIds[0], NOW);
    saveNote(db, base.user.id, lessonIds[0], "Keep me", NOW);

    const raised = await raiseRefundRequest(
      db,
      purchase.id,
      base.user.id,
      "Not for me.",
      NOW,
      notifications
    );
    if (!raised.ok) throw new Error(raised.error);
    const approved = await approveRefundRequest(
      db,
      raised.refundRequestId,
      admin.id,
      null,
      NOW,
      notifications
    );
    expect(approved.ok).toBe(true);

    expect(isBookmarked(db, base.user.id, lessonIds[0])).toBe(true);
    expect(getNote(db, base.user.id, lessonIds[0])?.body).toBe("Keep me");
  });
});
