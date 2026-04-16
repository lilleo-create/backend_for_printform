-- Separate checkout sessions for CART and BUY_NOW flows.
CREATE TABLE IF NOT EXISTS checkout_sessions (
  id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  source TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT checkout_sessions_scope_source_unique UNIQUE (scope_key, source)
);

CREATE TABLE IF NOT EXISTS checkout_session_items (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES checkout_sessions(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL,
  variant_id TEXT,
  quantity INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT checkout_session_items_unique UNIQUE (session_id, product_id, variant_id)
);

CREATE INDEX IF NOT EXISTS idx_checkout_sessions_scope_source ON checkout_sessions(scope_key, source);
CREATE INDEX IF NOT EXISTS idx_checkout_session_items_session ON checkout_session_items(session_id);

-- Catalog search/filter indexes.
CREATE INDEX IF NOT EXISTS idx_product_catalog_filters ON "Product"("moderationStatus", "deletedAt", "category", "material", "price");
CREATE INDEX IF NOT EXISTS idx_product_rating_count ON "Product"("ratingCount");
CREATE INDEX IF NOT EXISTS idx_product_title_lower ON "Product"(LOWER("title"));
CREATE INDEX IF NOT EXISTS idx_product_description_lower ON "Product"(LOWER("description"));
