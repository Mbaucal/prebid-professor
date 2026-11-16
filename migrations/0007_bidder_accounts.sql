-- Separate account identity and supply path from adapter parameters.
-- Legacy rows retain their exact bidder code, params and inherited site SChain.
ALTER TABLE bidders ADD COLUMN account_json TEXT NOT NULL DEFAULT '{}';
