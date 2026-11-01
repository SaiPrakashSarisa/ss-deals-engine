ALTER TABLE "affiliate_links" ADD CONSTRAINT "affiliate_links_id_product_id_unique" UNIQUE("id","product_id");--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_id_product_id_unique" UNIQUE("id","product_id");--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_link_product_affiliate_links_fk" FOREIGN KEY ("link_id","product_id") REFERENCES "public"."affiliate_links"("id","product_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_deal_product_deals_fk" FOREIGN KEY ("deal_id","product_id") REFERENCES "public"."deals"("id","product_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE FUNCTION set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON deals FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON publications FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON settings FOR EACH ROW EXECUTE FUNCTION set_updated_at();
