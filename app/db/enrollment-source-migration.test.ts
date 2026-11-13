import { describe, it, expect } from "vitest";
import { createTestDbBefore } from "~/test/setup";

// Migration 0011 gives every existing Enrollment its source.
describe("backfilling the Enrollment source", () => {
  function legacyDb() {
    const { sqlite, applyRemaining } = createTestDbBefore("0011");
    const run = (statement: string, ...params: unknown[]) =>
      sqlite.prepare(statement).run(...params);

    run(
      "INSERT INTO users (id, name, email, role, created_at) VALUES (1, 'Instructor', 'i@x', 'instructor', 'x'), (2, 'Emma', 'e@x', 'student', 'x'), (3, 'Ava', 'a@x', 'student', 'x'), (4, 'Noah', 'n@x', 'student', 'x'), (5, 'Olivia', 'o@x', 'student', 'x')"
    );
    run("INSERT INTO categories (id, name, slug) VALUES (1, 'C', 'c')");
    run(
      "INSERT INTO courses (id, title, slug, description, sales_copy, instructor_id, category_id, status, created_at, updated_at) VALUES (1, 'TS', 'ts', 'd', 's', 1, 1, 'published', 'x', 'x')"
    );
    // Emma's own purchase; Ava's Team Licence with two seats.
    run(
      "INSERT INTO purchases (id, user_id, course_id, amount_paid, created_at) VALUES (10, 2, 1, 7900, '2026-01-01'), (11, 3, 1, 15800, '2026-01-02'), (12, 4, 1, 7900, '2026-01-03')"
    );
    run("INSERT INTO teams (id, created_at) VALUES (1, 'x')");
    run(
      "INSERT INTO coupons (id, team_id, course_id, code, purchase_id, redeemed_by_user_id, created_at) VALUES (20, 1, 1, 'A', 11, 4, 'x'), (21, 1, 1, 'B', 11, 5, 'x')"
    );
    run(
      "INSERT INTO enrollments (id, user_id, course_id, enrolled_at) VALUES (100, 2, 1, '2026-01-01'), (101, 4, 1, '2026-01-02'), (102, 4, 1, '2026-01-03'), (103, 5, 1, '2026-01-04')"
    );

    applyRemaining();
    return sqlite;
  }

  function enrollmentsOf(sqlite: ReturnType<typeof legacyDb>, userId: number) {
    return sqlite
      .prepare(
        "SELECT purchase_id AS purchaseId, coupon_id AS couponId FROM enrollments WHERE user_id = ?"
      )
      .all(userId);
  }

  it("links an own purchase's Enrollment to that purchase", () => {
    const sqlite = legacyDb();
    expect(enrollmentsOf(sqlite, 2)).toEqual([
      { purchaseId: 10, couponId: null },
    ]);
  });

  it("links a Claimed Seat's Enrollment to that seat", () => {
    const sqlite = legacyDb();
    expect(enrollmentsOf(sqlite, 5)).toEqual([
      { purchaseId: null, couponId: 21 },
    ]);
  });

  it("collapses two Enrollments in one course into one, from the own purchase", () => {
    const sqlite = legacyDb();
    expect(enrollmentsOf(sqlite, 4)).toEqual([
      { purchaseId: 12, couponId: null },
    ]);
  });
});
