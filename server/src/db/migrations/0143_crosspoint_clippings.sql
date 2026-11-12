CREATE SEQUENCE "public"."crosspoint_clipping_revision_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "crosspoint_clippings" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"book_file_id" integer NOT NULL,
	"book_id" integer NOT NULL,
	"annotation_id" integer,
	"clipping_id" varchar(64) NOT NULL,
	"revision" bigint NOT NULL,
	"deleted" boolean DEFAULT false NOT NULL,
	"spine_index" integer DEFAULT 0 NOT NULL,
	"start_page" integer DEFAULT 0 NOT NULL,
	"end_page" integer DEFAULT 0 NOT NULL,
	"page_count" integer DEFAULT 1 NOT NULL,
	"start_word" integer DEFAULT 0 NOT NULL,
	"end_word" integer DEFAULT 0 NOT NULL,
	"word_count" integer DEFAULT 0 NOT NULL,
	"paragraph_index" integer,
	"chapter_title" varchar(64) DEFAULT '' NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"device_created_at" bigint DEFAULT 0 NOT NULL,
	"layout_signature" bigint DEFAULT 0 NOT NULL,
	"start_offset" bigint,
	"end_offset" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crosspoint_clippings_offsets_chk" CHECK (("crosspoint_clippings"."start_offset" is null) = ("crosspoint_clippings"."end_offset" is null))
);
--> statement-breakpoint
ALTER TABLE "annotations" DROP CONSTRAINT "annotations_origin_chk";--> statement-breakpoint
ALTER TABLE "crosspoint_clippings" ADD CONSTRAINT "crosspoint_clippings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crosspoint_clippings" ADD CONSTRAINT "crosspoint_clippings_book_file_id_book_files_id_fk" FOREIGN KEY ("book_file_id") REFERENCES "public"."book_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crosspoint_clippings" ADD CONSTRAINT "crosspoint_clippings_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crosspoint_clippings" ADD CONSTRAINT "crosspoint_clippings_annotation_id_annotations_id_fk" FOREIGN KEY ("annotation_id") REFERENCES "public"."annotations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "crosspoint_clippings_user_file_clipping_uidx" ON "crosspoint_clippings" USING btree ("user_id","book_file_id","clipping_id");--> statement-breakpoint
CREATE INDEX "crosspoint_clippings_user_file_revision_idx" ON "crosspoint_clippings" USING btree ("user_id","book_file_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "crosspoint_clippings_file_annotation_uidx" ON "crosspoint_clippings" USING btree ("book_file_id","annotation_id") WHERE "crosspoint_clippings"."annotation_id" is not null;--> statement-breakpoint
CREATE INDEX "crosspoint_clippings_annotation_id_idx" ON "crosspoint_clippings" USING btree ("annotation_id");--> statement-breakpoint
ALTER TABLE "annotations" ADD CONSTRAINT "annotations_origin_chk" CHECK ("annotations"."origin" in ('web', 'koreader', 'kobo', 'crosspoint'));