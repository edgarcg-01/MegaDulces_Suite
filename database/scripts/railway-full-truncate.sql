-- Full reset of all data tables before complete restore from backup.
-- session_replication_role=replica bypasses FK checks and triggers.
BEGIN;
SET session_replication_role = 'replica';

TRUNCATE
  -- domain schemas
  catalog.brands, catalog.categories, catalog.products,
  commercial.customers, commercial.warehouses, commercial.price_lists,
  commercial.product_prices, commercial.promotions, commercial.stock,
  commercial.stock_movements, commercial.orders, commercial.order_lines,
  commercial.order_status_history, commercial.order_sequences,
  commercial.payments, commercial.recommended_baskets, commercial.call_logs,
  commercial.lead_reservations,
  erp.staff,
  identity.role_permissions, identity.users, identity.tenants,
  logistics.config_finance, logistics.routes, logistics.payroll_periods,
  logistics.drivers, logistics.vehicles, logistics.delivery_guides,
  logistics.guide_recipients, logistics.liquidations, logistics.load_details,
  logistics.sequences, logistics.shipment_checklists, logistics.shipment_expenses,
  logistics.shipment_photos, logistics.shipments, logistics.unload_details,
  logistics.vehicle_maintenance, logistics.vehicle_usage_logs,
  -- public.* (trade marketing)
  public.catalogs, public.daily_assignments, public.daily_captures,
  public.exhibitions, public.exhibition_photos, public.rubric_criteria,
  public.rubric_levels, public.scoring_config, public.scoring_config_versions,
  public.scoring_weights, public.stores, public.valid_exhibition_combinations,
  public.visits, public.zones, public.products_normalize_backup_20260528
RESTART IDENTITY;

SET session_replication_role = 'origin';
COMMIT;
