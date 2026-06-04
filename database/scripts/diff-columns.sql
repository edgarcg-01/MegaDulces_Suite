SELECT table_schema, table_name, column_name, ordinal_position
FROM information_schema.columns
WHERE (table_schema, table_name) IN (
  ('catalog','brands'), ('catalog','categories'), ('catalog','products'),
  ('commercial','warehouses'), ('commercial','price_lists'),
  ('commercial','customers'), ('commercial','product_prices'), ('commercial','stock')
)
ORDER BY table_schema, table_name, ordinal_position;
