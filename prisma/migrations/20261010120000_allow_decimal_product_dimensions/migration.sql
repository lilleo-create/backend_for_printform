-- Product dimensions are stored in centimetres and may originate from millimetre input.
-- PostgreSQL widens INTEGER values to DOUBLE PRECISION without changing their value.
ALTER TABLE "Product"
  ALTER COLUMN "dxCm" TYPE DOUBLE PRECISION,
  ALTER COLUMN "dyCm" TYPE DOUBLE PRECISION,
  ALTER COLUMN "dzCm" TYPE DOUBLE PRECISION;
