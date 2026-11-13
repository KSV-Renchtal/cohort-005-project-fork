import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { readFileSync } from "fs";
import path from "path";
import { z } from "zod";
import { fileURLToPath } from "url";
import * as schema from "~/db/schema";
import type { Db } from "~/db";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationsFolder = path.resolve(__dirname, "../../drizzle");

/**
 * Creates a fresh in-memory SQLite database with all tables for testing.
 * Each call returns a new isolated database instance.
 *
 * Uses the same Drizzle migrations as the live database, ensuring
 * test and production schemas are always in sync.
 */
export function createTestDb(): Db {
  const sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  const testDb = drizzle(sqlite, { schema });

  migrate(testDb, { migrationsFolder });

  return testDb;
}

/**
 * For testing a migration on data shaped by the migrations before it.
 * Returns a raw in-memory database migrated up to, but not including, the
 * migration whose file name starts with `tag` (e.g. "0011"), and a function
 * that applies the rest. Insert legacy rows with `sqlite.prepare(...)`.
 */
export function createTestDbBefore(tag: string) {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");

  const migrations = readMigrationFiles({ migrationsFolder });
  const journal = z
    .object({ entries: z.array(z.object({ tag: z.string() })) })
    .parse(
      JSON.parse(
        readFileSync(path.join(migrationsFolder, "meta/_journal.json"), "utf8")
      )
    );
  const stop = journal.entries.findIndex((entry) => entry.tag.startsWith(tag));
  if (stop === -1) throw new Error(`No migration starts with "${tag}"`);

  const apply = (from: number, to: number) => {
    for (const migration of migrations.slice(from, to)) {
      for (const statement of migration.sql) {
        if (statement.trim()) sqlite.exec(statement);
      }
    }
  };

  apply(0, stop);
  return { sqlite, applyRemaining: () => apply(stop, migrations.length) };
}

/**
 * Seeds a minimal set of base data (user, category, course) that most tests need.
 * Returns the created IDs for use in test assertions.
 */
export function seedBaseData(testDb: Db) {
  const user = testDb
    .insert(schema.users)
    .values({
      name: "Test User",
      email: "test@example.com",
      role: schema.UserRole.Student,
    })
    .returning()
    .get();

  const instructor = testDb
    .insert(schema.users)
    .values({
      name: "Test Instructor",
      email: "instructor@example.com",
      role: schema.UserRole.Instructor,
    })
    .returning()
    .get();

  const category = testDb
    .insert(schema.categories)
    .values({ name: "Programming", slug: "programming" })
    .returning()
    .get();

  const course = testDb
    .insert(schema.courses)
    .values({
      title: "Test Course",
      slug: "test-course",
      description: "A test course",
      salesCopy: "## Test Course\n\nSales copy for the test course.",
      instructorId: instructor.id,
      categoryId: category.id,
      status: schema.CourseStatus.Published,
    })
    .returning()
    .get();

  return { user, instructor, category, course };
}
