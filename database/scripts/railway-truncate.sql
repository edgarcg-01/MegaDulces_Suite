-- Truncate all tables in target schemas before restore.
-- session_replication_role=replica disables FK checks + triggers (RLS bypassed by superuser).
-- public.* is NOT touched (trade marketing legacy).
BEGIN;
SET session_replication_role = 'replica';

TRUNCATE
  catalog.brands,
  catalog.categories,
  catalog.products,
  commercial.customers,
  commercial.warehouses,
  commercial.price_lists,
  commercial.product_prices,
  commercial.promotions,
  commercial.stock,
  commercial.stock_movements,
  commercial.orders,
  commercial.order_lines,
  commercial.order_status_history,
  commercial.order_sequences,
  commercial.payments,
  commercial.recommended_baskets,
  commercial.call_logs,
  commercial.lead_reservations,
  erp.staff,
  identity.role_permissions,
  identity.tenants,
  identity.users,
  logistics.config_finance,
  logistics.routes,
  logistics.payroll_periods,
  logistics.drivers,
  logistics.vehicles,
  logistics.delivery_guides,
  logistics.guide_recipients,
  logistics.liquidations,
  logistics.load_details,
  logistics.sequences,
  logistics.shipment_checklists,
  logistics.shipment_expenses,
  logistics.shipment_photos,
  logistics.shipments,
  logistics.unload_details,
  logistics.vehicle_maintenance,
  logistics.vehicle_usage_logs
RESTART IDENTITY CASCADE;

SET session_replication_role = 'origin';
COMMIT;
