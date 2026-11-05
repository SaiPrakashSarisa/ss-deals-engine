ALTER TABLE "deals" ADD COLUMN "title" text;--> statement-breakpoint
UPDATE "deals" AS d
SET "title" = left(btrim(p."title"), 200)
FROM "products" AS p
WHERE p."id" = d."product_id"
  AND p."title" IS NOT NULL
  AND char_length(btrim(p."title")) >= 1;--> statement-breakpoint
UPDATE "deals" SET "title" = 'Untitled' WHERE "title" IS NULL OR char_length("title") < 1;--> statement-breakpoint
ALTER TABLE "deals" ALTER COLUMN "title" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_title_length" CHECK (char_length("deals"."title") between 1 and 200);
