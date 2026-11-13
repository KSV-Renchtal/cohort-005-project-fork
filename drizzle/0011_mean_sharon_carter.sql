PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_enrollments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`course_id` integer NOT NULL,
	`enrolled_at` text NOT NULL,
	`completed_at` text,
	`purchase_id` integer,
	`coupon_id` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`course_id`) REFERENCES `courses`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`purchase_id`) REFERENCES `purchases`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`coupon_id`) REFERENCES `coupons`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "enrollments_one_source" CHECK(("purchase_id" IS NULL) <> ("coupon_id" IS NULL))
);
--> statement-breakpoint
-- Backfill the source. One Enrollment per learner and course survives (the
-- oldest row). Its source is the learner's latest own purchase of the course
-- (a purchase with no seats), or else the seat they claimed in it. A row with
-- neither source is dropped: it gave access nothing paid for.
WITH `kept` AS (
	SELECT min("id") AS "id" FROM `enrollments` GROUP BY "user_id", "course_id"
), `sourced` AS (
	SELECT e."id", e."user_id", e."course_id", e."enrolled_at", e."completed_at",
		(SELECT p."id" FROM `purchases` p
			WHERE p."user_id" = e."user_id" AND p."course_id" = e."course_id"
				AND NOT EXISTS (SELECT 1 FROM `coupons` c WHERE c."purchase_id" = p."id")
			ORDER BY p."created_at" DESC, p."id" DESC LIMIT 1) AS "own_purchase_id",
		(SELECT c."id" FROM `coupons` c
			WHERE c."redeemed_by_user_id" = e."user_id" AND c."course_id" = e."course_id"
			ORDER BY c."id" LIMIT 1) AS "seat_id"
	FROM `enrollments` e
	WHERE e."id" IN (SELECT "id" FROM `kept`)
)
INSERT INTO `__new_enrollments`("id", "user_id", "course_id", "enrolled_at", "completed_at", "purchase_id", "coupon_id")
SELECT "id", "user_id", "course_id", "enrolled_at", "completed_at", "own_purchase_id",
	CASE WHEN "own_purchase_id" IS NULL THEN "seat_id" END
FROM `sourced`
WHERE "own_purchase_id" IS NOT NULL OR "seat_id" IS NOT NULL;--> statement-breakpoint
DROP TABLE `enrollments`;--> statement-breakpoint
ALTER TABLE `__new_enrollments` RENAME TO `enrollments`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `enrollments_course_idx` ON `enrollments` (`course_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `enrollments_user_course_idx` ON `enrollments` (`user_id`,`course_id`);