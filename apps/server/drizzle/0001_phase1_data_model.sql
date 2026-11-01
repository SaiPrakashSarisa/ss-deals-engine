CREATE TYPE "public"."affiliate_link_validation_status" AS ENUM('unvalidated', 'structure_ok', 'invalid');--> statement-breakpoint
CREATE TYPE "public"."affiliate_link_verification" AS ENUM('api_generated', 'sitestripe_manual', 'network_deeplink_manual', 'tag_appended');--> statement-breakpoint
CREATE TYPE "public"."channel_platform" AS ENUM('telegram');--> statement-breakpoint
CREATE TYPE "public"."content_draft_source" AS ENUM('template', 'llm', 'manual_edit');--> statement-breakpoint
CREATE TYPE "public"."deal_score_class" AS ENUM('excellent', 'good', 'average', 'not_recommended');--> statement-breakpoint
CREATE TYPE "public"."deal_status" AS ENUM('draft', 'pending_approval', 'approved', 'scheduled', 'published', 'rejected', 'failed');--> statement-breakpoint
CREATE TYPE "public"."price_snapshot_origin" AS ENUM('clerk_entered', 'owner_entered', 'api', 'quickpost_import');--> statement-breakpoint
CREATE TYPE "public"."product_source" AS ENUM('amazon', 'flipkart', 'myntra', 'ajio', 'other');--> statement-breakpoint
CREATE TYPE "public"."publication_link_kind" AS ENUM('tagged', 'short');--> statement-breakpoint
CREATE TYPE "public"."publication_mode" AS ENUM('text', 'photo');--> statement-breakpoint
CREATE TYPE "public"."publication_origin" AS ENUM('app', 'quickpost_import');--> statement-breakpoint
CREATE TYPE "public"."publication_status" AS ENUM('queued', 'publishing', 'published', 'failed', 'uncertain');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('owner', 'clerk');--> statement-breakpoint
CREATE TABLE "affiliate_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"original_url" text NOT NULL,
	"affiliate_url" text NOT NULL,
	"short_url" text,
	"affiliate_tag" text,
	"verification" "affiliate_link_verification" NOT NULL,
	"validation_status" "affiliate_link_validation_status" NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" uuid,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid,
	"details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"platform" "channel_platform" NOT NULL,
	"name" text NOT NULL,
	"username" text,
	"chat_id" text,
	"is_active" boolean NOT NULL,
	CONSTRAINT "channels_platform_username_unique" UNIQUE("platform","username")
);
--> statement-breakpoint
CREATE TABLE "content_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deal_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"body_html" text NOT NULL,
	"source" "content_draft_source" NOT NULL,
	"is_current" boolean NOT NULL,
	CONSTRAINT "content_drafts_deal_version_unique" UNIQUE("deal_id","version")
);
--> statement-breakpoint
CREATE TABLE "deals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"link_id" uuid NOT NULL,
	"status" "deal_status" NOT NULL,
	"price_paise" integer NOT NULL,
	"old_price_paise" integer,
	"old_price_verified" boolean DEFAULT false NOT NULL,
	"highlights" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"offer_text" text,
	"preview_enabled" boolean DEFAULT true NOT NULL,
	"source_note" text,
	"clerk_notes" text,
	"review_note" text,
	"rejected_reason" text,
	"score" integer,
	"score_class" "deal_score_class",
	"created_by" uuid NOT NULL,
	"approved_by" uuid,
	"image_path" text,
	"image_mime" text,
	"image_uploaded_by" uuid,
	"submitted_at" timestamp with time zone,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deals_price_paise_positive" CHECK ("deals"."price_paise" > 0),
	CONSTRAINT "deals_old_price_above_price" CHECK ("deals"."old_price_paise" is null or "deals"."old_price_paise" > "deals"."price_paise"),
	CONSTRAINT "deals_old_price_verified_requires_old_price" CHECK ("deals"."old_price_paise" is not null or "deals"."old_price_verified" = false),
	CONSTRAINT "deals_offer_text_length" CHECK ("deals"."offer_text" is null or char_length("deals"."offer_text") <= 120)
);
--> statement-breakpoint
CREATE TABLE "price_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"deal_id" uuid,
	"price_paise" integer NOT NULL,
	"origin" "price_snapshot_origin" NOT NULL,
	"recorded_by" uuid,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_snapshots_price_paise_positive" CHECK ("price_snapshots"."price_paise" > 0)
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" "product_source" NOT NULL,
	"external_id" text NOT NULL,
	"canonical_url" text NOT NULL,
	"title" text,
	"brand" text,
	"category" text,
	CONSTRAINT "products_source_external_id_unique" UNIQUE("source","external_id")
);
--> statement-breakpoint
CREATE TABLE "publications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deal_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"content_draft_id" uuid NOT NULL,
	"status" "publication_status" NOT NULL,
	"mode" "publication_mode" DEFAULT 'text' NOT NULL,
	"link_kind" "publication_link_kind" DEFAULT 'tagged' NOT NULL,
	"origin" "publication_origin" DEFAULT 'app' NOT NULL,
	"posted_price_paise" integer,
	"scheduled_for" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"external_message_id" text,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "publications_channel_deal_unique" UNIQUE("channel_id","deal_id")
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text NOT NULL,
	"password_hash" text,
	"role" "user_role" NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"can_publish_directly" boolean DEFAULT false NOT NULL,
	"telegram_user_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
ALTER TABLE "affiliate_links" ADD CONSTRAINT "affiliate_links_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affiliate_links" ADD CONSTRAINT "affiliate_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_drafts" ADD CONSTRAINT "content_drafts_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_link_id_affiliate_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."affiliate_links"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_image_uploaded_by_users_id_fk" FOREIGN KEY ("image_uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_snapshots" ADD CONSTRAINT "price_snapshots_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_snapshots" ADD CONSTRAINT "price_snapshots_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_snapshots" ADD CONSTRAINT "price_snapshots_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_content_draft_id_content_drafts_id_fk" FOREIGN KEY ("content_draft_id") REFERENCES "public"."content_drafts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "affiliate_links_product_id_idx" ON "affiliate_links" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "content_drafts_one_current_per_deal" ON "content_drafts" USING btree ("deal_id") WHERE "content_drafts"."is_current" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "deals_one_active_per_product" ON "deals" USING btree ("product_id") WHERE "deals"."status" in ('draft', 'pending_approval', 'approved', 'scheduled');--> statement-breakpoint
CREATE INDEX "price_snapshots_product_recorded_at_idx" ON "price_snapshots" USING btree ("product_id","recorded_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "publications_one_inflight_per_channel_product" ON "publications" USING btree ("channel_id","product_id") WHERE "publications"."status" in ('queued', 'publishing', 'uncertain');--> statement-breakpoint
CREATE UNIQUE INDEX "users_telegram_user_id_unique" ON "users" USING btree ("telegram_user_id") WHERE "users"."telegram_user_id" is not null;