'use strict';
/**
 * `[AUD-DAT.6]` — **Retiro de índices muertos: 118 índices, 723 MB que se escriben y nadie lee.**
 *
 * ── Qué se midió (prod, 2026-09-28) ─────────────────────────────────────────
 * Un índice que nunca se escanea no es gratis: se actualiza en CADA insert y update de su tabla,
 * ocupa disco y viaja en cada respaldo. La auditoría de la capa de datos encontró **496 índices
 * no-únicos con `idx_scan = 0`** sumando 980 MB, sobre una ventana de estadísticas larga —
 * `kepler_ods.kdm2` acumula 867 M lecturas en sus índices, así que el contador sirve.
 *
 * ── Los tres frenos, y por qué ninguno es opcional ──────────────────────────
 * `idx_scan = 0` NO alcanza como criterio. De los 496:
 *
 *   · **75 se excluyen por RECIENTES** (creados en migraciones de los últimos 30 días, 203 MB).
 *     Un índice de hace tres días tiene cero lecturas por ser nuevo, no por ser inútil.
 *   · **301 se excluyen porque su tabla está VACÍA** (45 MB). No están muertos: están **sin
 *     nacer**. Es el índice con el que se diseñó una función que todavía no arrancó, y borrarlo
 *     la estrenaría sin él.
 *   · Los que respaldan un CONSTRAINT, los UNIQUE y los PRIMARY **nunca entran**: ahí
 *     `idx_scan = 0` significa "nadie consulta por esa llave", no "la llave no se usa" — el motor
 *     la usa para validar cada escritura. Ya estaba documentado como trampa en la memoria del
 *     proyecto: *no borrar índices por idx_scan=0, son los UNIQUE*.
 *
 * Quedan **118 índices sobre tablas con datos, 723 MB**. El más grande es uno solo:
 * `kepler_ods.ix_kdpv_bitacora_sku_lookup`, 588 MB de índice de cobertura sobre una tabla de
 * 178,848 filas — 3.3 KB por fila — jamás escaneado.
 *
 * ── La única exclusión nominal ──────────────────────────────────────────────
 * `catalog.products_embedding_hnsw` (9 MB, pgvector) se DEJA aunque cumple los tres filtros:
 * borrar un índice ANN no cambia un plan, cambia el **algoritmo** — el match por IA de la Fase K
 * pasaría de vecino aproximado a barrido exacto. Por 9 MB no vale el cambio de comportamiento.
 *
 * ── Cómo corre ──────────────────────────────────────────────────────────────
 * `DROP INDEX CONCURRENTLY`: no bloquea lecturas ni escrituras, sólo otras DDL y el VACUUM. Por
 * eso `config.transaction = false` — CONCURRENTLY no puede correr dentro de una transacción.
 * El `IF EXISTS` y el try por índice hacen la corrida re-ejecutable: si uno falla, los demás siguen.
 *
 * ⚠️ REVERSIBLE POR CONSTRUCCIÓN: el `down` trae el DDL EXACTO de cada índice, sacado de
 * `pg_get_indexdef` ANTES de borrarlo. No es una reconstrucción de memoria.
 *
 * ⚠️ Lo que esto NO puede saber: un índice que sirve a una consulta MENSUAL también marca 0 en
 * una ventana de semanas. Se acepta el riesgo porque el `down` lo devuelve en un comando, y
 * porque el costo de tenerlo es continuo mientras que el de no tenerlo aparece una vez y avisa.
 *
 * @param { import("knex").Knex } knex
 */
exports.config = { transaction: false };

/** Los 118, con el DDL exacto para poder devolverlos. `mb` = lo que pesaba al medirlo. */
const INDICES = [
  {
    "i": "kepler_ods.ix_kdpv_bitacora_sku_lookup",
    "t": "kepler_ods.kdpv_bitacora_precios",
    "mb": 588,
    "ddl": "CREATE INDEX CONCURRENTLY ix_kdpv_bitacora_sku_lookup ON kepler_ods.kdpv_bitacora_precios USING btree (btrim(c3), btrim(sucursal), btrim(c4), c1 DESC, c2 DESC) INCLUDE (c7)"
  },
  {
    "i": "logistics.idx_logistics_positions_tracker_time",
    "t": "logistics.vehicle_positions",
    "mb": 34.38,
    "ddl": "CREATE INDEX CONCURRENTLY idx_logistics_positions_tracker_time ON logistics.vehicle_positions USING btree (tenant_id, tracker_id, captured_at)"
  },
  {
    "i": "finance.ix_fin_findings_model",
    "t": "finance.findings",
    "mb": 14.79,
    "ddl": "CREATE INDEX CONCURRENTLY ix_fin_findings_model ON finance.findings USING btree (tenant_id, status, model_score DESC)"
  },
  {
    "i": "public.idx_route_pings_earth",
    "t": "public.route_location_pings",
    "mb": 12.54,
    "ddl": "CREATE INDEX CONCURRENTLY idx_route_pings_earth ON public.route_location_pings USING gist (ll_to_earth((lat)::double precision, (lng)::double precision))"
  },
  {
    "i": "analytics.ix_store_live_cajero",
    "t": "analytics.store_live_tickets",
    "mb": 11.27,
    "ddl": "CREATE INDEX CONCURRENTLY ix_store_live_cajero ON analytics.store_live_tickets USING btree (tenant_id, cajero, ticket_ts DESC)"
  },
  {
    "i": "commercial.idx_exec360_snap_subject",
    "t": "commercial.execution_360_snapshots",
    "mb": 7.84,
    "ddl": "CREATE INDEX CONCURRENTLY idx_exec360_snap_subject ON commercial.execution_360_snapshots USING btree (tenant_id, subject_type, subject_id, window_days, snapshot_date)"
  },
  {
    "i": "intelligence.idx_affinity_lookup",
    "t": "intelligence.product_affinity",
    "mb": 4.86,
    "ddl": "CREATE INDEX CONCURRENTLY idx_affinity_lookup ON intelligence.product_affinity USING btree (tenant_id, product_a, lift)"
  },
  {
    "i": "analytics.ix_sales_boxes_monthly_prod",
    "t": "analytics.sales_boxes_monthly",
    "mb": 4.62,
    "ddl": "CREATE INDEX CONCURRENTLY ix_sales_boxes_monthly_prod ON analytics.sales_boxes_monthly USING btree (tenant_id, product_id)"
  },
  {
    "i": "intelligence.idx_zone_demand_lookup",
    "t": "intelligence.zone_demand",
    "mb": 3.9,
    "ddl": "CREATE INDEX CONCURRENTLY idx_zone_demand_lookup ON intelligence.zone_demand USING btree (tenant_id, zona, demand_index)"
  },
  {
    "i": "analytics.ix_sales_boxes_monthly_updated_at_desc",
    "t": "analytics.sales_boxes_monthly",
    "mb": 3.6,
    "ddl": "CREATE INDEX CONCURRENTLY ix_sales_boxes_monthly_updated_at_desc ON analytics.sales_boxes_monthly USING btree (updated_at DESC NULLS LAST)"
  },
  {
    "i": "fiscal.ix_fiscal_cfdis_emisor",
    "t": "fiscal.cfdis",
    "mb": 3.55,
    "ddl": "CREATE INDEX CONCURRENTLY ix_fiscal_cfdis_emisor ON fiscal.cfdis USING btree (tenant_id, emisor_rfc)"
  },
  {
    "i": "analytics.ix_cpq_ledger_sat",
    "t": "analytics.contpaqi_ledger_monthly",
    "mb": 3.16,
    "ddl": "CREATE INDEX CONCURRENTLY ix_cpq_ledger_sat ON analytics.contpaqi_ledger_monthly USING btree (tenant_id, agrupador_sat, anio_mes)"
  },
  {
    "i": "analytics.ix_cpq_ledger_fam_mes",
    "t": "analytics.contpaqi_ledger_monthly",
    "mb": 2.96,
    "ddl": "CREATE INDEX CONCURRENTLY ix_cpq_ledger_fam_mes ON analytics.contpaqi_ledger_monthly USING btree (tenant_id, familia, anio_mes)"
  },
  {
    "i": "fiscal.ix_fiscal_cfdis_tipo",
    "t": "fiscal.cfdis",
    "mb": 2.48,
    "ddl": "CREATE INDEX CONCURRENTLY ix_fiscal_cfdis_tipo ON fiscal.cfdis USING btree (tenant_id, tipo_comprobante)"
  },
  {
    "i": "analytics.ix_cpq_ledger_mes",
    "t": "analytics.contpaqi_ledger_monthly",
    "mb": 2.33,
    "ddl": "CREATE INDEX CONCURRENTLY ix_cpq_ledger_mes ON analytics.contpaqi_ledger_monthly USING btree (tenant_id, anio_mes)"
  },
  {
    "i": "fiscal.ix_fiscal_cfdis_request",
    "t": "fiscal.cfdis",
    "mb": 2.24,
    "ddl": "CREATE INDEX CONCURRENTLY ix_fiscal_cfdis_request ON fiscal.cfdis USING btree (tenant_id, request_id)"
  },
  {
    "i": "fiscal.ix_fiscal_cfdis_receptor",
    "t": "fiscal.cfdis",
    "mb": 2.19,
    "ddl": "CREATE INDEX CONCURRENTLY ix_fiscal_cfdis_receptor ON fiscal.cfdis USING btree (tenant_id, receptor_rfc)"
  },
  {
    "i": "analytics.ix_gll_cfdi",
    "t": "analytics.gl_poliza_lines",
    "mb": 1.81,
    "ddl": "CREATE INDEX CONCURRENTLY ix_gll_cfdi ON analytics.gl_poliza_lines USING btree (tenant_id, cfdi_uuid) WHERE (cfdi_uuid IS NOT NULL)"
  },
  {
    "i": "logistics.idx_logistics_vehicle_stops_vehicle_time",
    "t": "logistics.vehicle_stops",
    "mb": 1.41,
    "ddl": "CREATE INDEX CONCURRENTLY idx_logistics_vehicle_stops_vehicle_time ON logistics.vehicle_stops USING btree (tenant_id, vehicle_id, arrived_at)"
  },
  {
    "i": "analytics.ix_cpq_bank_fecha",
    "t": "analytics.contpaqi_bank_movements",
    "mb": 1.16,
    "ddl": "CREATE INDEX CONCURRENTLY ix_cpq_bank_fecha ON analytics.contpaqi_bank_movements USING btree (tenant_id, fecha)"
  },
  {
    "i": "intelligence.idx_zone_demand_product",
    "t": "intelligence.zone_demand",
    "mb": 0.91,
    "ddl": "CREATE INDEX CONCURRENTLY idx_zone_demand_product ON intelligence.zone_demand USING btree (tenant_id, product_id)"
  },
  {
    "i": "analytics.ix_product_demand_prod",
    "t": "analytics.product_demand",
    "mb": 0.74,
    "ddl": "CREATE INDEX CONCURRENTLY ix_product_demand_prod ON analytics.product_demand USING btree (tenant_id, product_id, window_days)"
  },
  {
    "i": "commercial.idx_commercial_stock_aisle",
    "t": "commercial.stock",
    "mb": 0.73,
    "ddl": "CREATE INDEX CONCURRENTLY idx_commercial_stock_aisle ON commercial.stock USING btree (tenant_id, aisle_id)"
  },
  {
    "i": "public.idx_route_pings_user_time",
    "t": "public.route_location_pings",
    "mb": 0.66,
    "ddl": "CREATE INDEX CONCURRENTLY idx_route_pings_user_time ON public.route_location_pings USING btree (user_id, captured_at)"
  },
  {
    "i": "public.idx_route_pings_route_time",
    "t": "public.route_location_pings",
    "mb": 0.64,
    "ddl": "CREATE INDEX CONCURRENTLY idx_route_pings_route_time ON public.route_location_pings USING btree (route_id, captured_at)"
  },
  {
    "i": "analytics.ix_expense_benef",
    "t": "analytics.expense_entries",
    "mb": 0.57,
    "ddl": "CREATE INDEX CONCURRENTLY ix_expense_benef ON analytics.expense_entries USING btree (tenant_id, beneficiario)"
  },
  {
    "i": "analytics.ix_expense_mayor",
    "t": "analytics.expense_entries",
    "mb": 0.48,
    "ddl": "CREATE INDEX CONCURRENTLY ix_expense_mayor ON analytics.expense_entries USING btree (tenant_id, cuenta_mayor)"
  },
  {
    "i": "catalog.idx_catalog_product_barcodes_sku",
    "t": "catalog.product_barcodes",
    "mb": 0.48,
    "ddl": "CREATE INDEX CONCURRENTLY idx_catalog_product_barcodes_sku ON catalog.product_barcodes USING btree (tenant_id, sku)"
  },
  {
    "i": "analytics.ix_expense_entries_warehouse_id",
    "t": "analytics.expense_entries",
    "mb": 0.48,
    "ddl": "CREATE INDEX CONCURRENTLY ix_expense_entries_warehouse_id ON analytics.expense_entries USING btree (warehouse_id)"
  },
  {
    "i": "analytics.ix_invhealth_status",
    "t": "analytics.inventory_health",
    "mb": 0.48,
    "ddl": "CREATE INDEX CONCURRENTLY ix_invhealth_status ON analytics.inventory_health USING btree (tenant_id, status)"
  },
  {
    "i": "inventory.idx_inventory_products_codigo_barras",
    "t": "inventory.products",
    "mb": 0.43,
    "ddl": "CREATE INDEX CONCURRENTLY idx_inventory_products_codigo_barras ON inventory.products USING btree (codigo_barras) WHERE (codigo_barras IS NOT NULL)"
  },
  {
    "i": "catalog.products_source_idx",
    "t": "catalog.products",
    "mb": 0.41,
    "ddl": "CREATE INDEX CONCURRENTLY products_source_idx ON catalog.products USING btree (tenant_id, source)"
  },
  {
    "i": "catalog.idx_products_articulo",
    "t": "catalog.products",
    "mb": 0.38,
    "ddl": "CREATE INDEX CONCURRENTLY idx_products_articulo ON catalog.products USING btree (articulo)"
  },
  {
    "i": "catalog.idx_products_tenant_location",
    "t": "catalog.products",
    "mb": 0.34,
    "ddl": "CREATE INDEX CONCURRENTLY idx_products_tenant_location ON catalog.products USING btree (tenant_id, location) WHERE ((location IS NOT NULL) AND (deleted_at IS NULL))"
  },
  {
    "i": "analytics.ix_cpq_sup_rfc",
    "t": "analytics.contpaqi_suppliers",
    "mb": 0.34,
    "ddl": "CREATE INDEX CONCURRENTLY ix_cpq_sup_rfc ON analytics.contpaqi_suppliers USING btree (tenant_id, rfc)"
  },
  {
    "i": "commercial.idx_exec_baselines_subject",
    "t": "commercial.execution_baselines",
    "mb": 0.31,
    "ddl": "CREATE INDEX CONCURRENTLY idx_exec_baselines_subject ON commercial.execution_baselines USING btree (tenant_id, subject_type, subject_id, window_days)"
  },
  {
    "i": "logistics.idx_logistics_vehicle_stops_customer",
    "t": "logistics.vehicle_stops",
    "mb": 0.29,
    "ddl": "CREATE INDEX CONCURRENTLY idx_logistics_vehicle_stops_customer ON logistics.vehicle_stops USING btree (tenant_id, matched_customer_id)"
  },
  {
    "i": "commercial.idx_commercial_product_prices_list",
    "t": "commercial.product_prices",
    "mb": 0.29,
    "ddl": "CREATE INDEX CONCURRENTLY idx_commercial_product_prices_list ON commercial.product_prices USING btree (tenant_id, price_list_id)"
  },
  {
    "i": "analytics.ix_chain_benef",
    "t": "analytics.expense_doc_chain",
    "mb": 0.28,
    "ddl": "CREATE INDEX CONCURRENTLY ix_chain_benef ON analytics.expense_doc_chain USING btree (tenant_id, beneficiario)"
  },
  {
    "i": "analytics.ix_pos_ticket_sales_date",
    "t": "analytics.pos_ticket_sales",
    "mb": 0.27,
    "ddl": "CREATE INDEX CONCURRENTLY ix_pos_ticket_sales_date ON analytics.pos_ticket_sales USING btree (tenant_id, business_date DESC)"
  },
  {
    "i": "analytics.ix_purchase_velocity_prod",
    "t": "analytics.purchase_velocity",
    "mb": 0.27,
    "ddl": "CREATE INDEX CONCURRENTLY ix_purchase_velocity_prod ON analytics.purchase_velocity USING btree (tenant_id, product_id)"
  },
  {
    "i": "analytics.ix_cash_session_open",
    "t": "analytics.cash_sessions",
    "mb": 0.27,
    "ddl": "CREATE INDEX CONCURRENTLY ix_cash_session_open ON analytics.cash_sessions USING btree (tenant_id, status, opened_at DESC)"
  },
  {
    "i": "analytics.ix_expense_findings_warehouse_id",
    "t": "analytics.expense_findings",
    "mb": 0.2,
    "ddl": "CREATE INDEX CONCURRENTLY ix_expense_findings_warehouse_id ON analytics.expense_findings USING btree (warehouse_id)"
  },
  {
    "i": "logistics.idx_logistics_trackers_tenant_status",
    "t": "logistics.trackers",
    "mb": 0.2,
    "ddl": "CREATE INDEX CONCURRENTLY idx_logistics_trackers_tenant_status ON logistics.trackers USING btree (tenant_id, last_status)"
  },
  {
    "i": "public.idx_route_pings_tenant",
    "t": "public.route_location_pings",
    "mb": 0.2,
    "ddl": "CREATE INDEX CONCURRENTLY idx_route_pings_tenant ON public.route_location_pings USING btree (tenant_id)"
  },
  {
    "i": "commercial.idx_portal_tel_kind_name_time",
    "t": "commercial.portal_telemetry_events",
    "mb": 0.17,
    "ddl": "CREATE INDEX CONCURRENTLY idx_portal_tel_kind_name_time ON commercial.portal_telemetry_events USING btree (kind, name, created_at)"
  },
  {
    "i": "commercial.idx_supervisor_actions_priority",
    "t": "commercial.supervisor_actions",
    "mb": 0.15,
    "ddl": "CREATE INDEX CONCURRENTLY idx_supervisor_actions_priority ON commercial.supervisor_actions USING btree (tenant_id, status, priority DESC)"
  },
  {
    "i": "trade.idx_daily_captures_tenant_folio",
    "t": "trade.daily_captures",
    "mb": 0.14,
    "ddl": "CREATE INDEX CONCURRENTLY idx_daily_captures_tenant_folio ON trade.daily_captures USING btree (tenant_id, folio)"
  },
  {
    "i": "commercial.idx_portal_tel_tenant_time",
    "t": "commercial.portal_telemetry_events",
    "mb": 0.14,
    "ddl": "CREATE INDEX CONCURRENTLY idx_portal_tel_tenant_time ON commercial.portal_telemetry_events USING btree (tenant_id, created_at)"
  },
  {
    "i": "inventory.idx_inventory_products_categoria",
    "t": "inventory.products",
    "mb": 0.13,
    "ddl": "CREATE INDEX CONCURRENTLY idx_inventory_products_categoria ON inventory.products USING btree (categoria)"
  },
  {
    "i": "commercial.idx_supervisor_actions_finding",
    "t": "commercial.supervisor_actions",
    "mb": 0.12,
    "ddl": "CREATE INDEX CONCURRENTLY idx_supervisor_actions_finding ON commercial.supervisor_actions USING btree (tenant_id, finding_id)"
  },
  {
    "i": "catalog.idx_top_sellers_live_rank",
    "t": "catalog.top_sellers_live",
    "mb": 0.1,
    "ddl": "CREATE INDEX CONCURRENTLY idx_top_sellers_live_rank ON catalog.top_sellers_live USING btree (tenant_id, sales_rank)"
  },
  {
    "i": "analytics.ix_daccel_tenant_band",
    "t": "analytics.demand_acceleration",
    "mb": 0.1,
    "ddl": "CREATE INDEX CONCURRENTLY ix_daccel_tenant_band ON analytics.demand_acceleration USING btree (tenant_id, band)"
  },
  {
    "i": "reconciliation.ix_rec_disc_plano",
    "t": "reconciliation.discrepancies",
    "mb": 0.09,
    "ddl": "CREATE INDEX CONCURRENTLY ix_rec_disc_plano ON reconciliation.discrepancies USING btree (tenant_id, plano, periodo)"
  },
  {
    "i": "analytics.ix_purchase_velocity_wh",
    "t": "analytics.purchase_velocity",
    "mb": 0.09,
    "ddl": "CREATE INDEX CONCURRENTLY ix_purchase_velocity_wh ON analytics.purchase_velocity USING btree (tenant_id, warehouse_id)"
  },
  {
    "i": "analytics.ix_ap_compra",
    "t": "analytics.ap_provider",
    "mb": 0.09,
    "ddl": "CREATE INDEX CONCURRENTLY ix_ap_compra ON analytics.ap_provider USING btree (tenant_id, compra_12m)"
  },
  {
    "i": "commercial.ix_replen_channel_sup",
    "t": "commercial.replenishment_channel",
    "mb": 0.07,
    "ddl": "CREATE INDEX CONCURRENTLY ix_replen_channel_sup ON commercial.replenishment_channel USING btree (tenant_id, supplier_id)"
  },
  {
    "i": "commercial.idx_commercial_findings_subject",
    "t": "commercial.commercial_findings",
    "mb": 0.07,
    "ddl": "CREATE INDEX CONCURRENTLY idx_commercial_findings_subject ON commercial.commercial_findings USING btree (tenant_id, subject_type, subject_id)"
  },
  {
    "i": "commercial.idx_capture_vision_capture",
    "t": "commercial.capture_vision",
    "mb": 0.06,
    "ddl": "CREATE INDEX CONCURRENTLY idx_capture_vision_capture ON commercial.capture_vision USING btree (tenant_id, capture_id)"
  },
  {
    "i": "commercial.idx_prospect_stores_tenant_status",
    "t": "commercial.prospect_stores",
    "mb": 0.06,
    "ddl": "CREATE INDEX CONCURRENTLY idx_prospect_stores_tenant_status ON commercial.prospect_stores USING btree (tenant_id, status)"
  },
  {
    "i": "analytics.ix_erppa_factura",
    "t": "analytics.erp_purchase_adjustments",
    "mb": 0.05,
    "ddl": "CREATE INDEX CONCURRENTLY ix_erppa_factura ON analytics.erp_purchase_adjustments USING btree (tenant_id, factura_ref)"
  },
  {
    "i": "commercial.idx_capture_vision_phash",
    "t": "commercial.capture_vision",
    "mb": 0.05,
    "ddl": "CREATE INDEX CONCURRENTLY idx_capture_vision_phash ON commercial.capture_vision USING btree (tenant_id, phash)"
  },
  {
    "i": "commercial.idx_commercial_customers_visit_seq",
    "t": "commercial.customers",
    "mb": 0.05,
    "ddl": "CREATE INDEX CONCURRENTLY idx_commercial_customers_visit_seq ON commercial.customers USING btree (tenant_id, sales_route, visit_sequence)"
  },
  {
    "i": "commercial.idx_customers_earth",
    "t": "commercial.customers",
    "mb": 0.05,
    "ddl": "CREATE INDEX CONCURRENTLY idx_customers_earth ON commercial.customers USING gist (ll_to_earth((latitude)::double precision, (longitude)::double precision)) WHERE ((latitude IS NOT NULL) AND (longitude IS NOT NULL))"
  },
  {
    "i": "finance.ix_fin_grp_status",
    "t": "finance.goods_receipt_proofs",
    "mb": 0.05,
    "ddl": "CREATE INDEX CONCURRENTLY ix_fin_grp_status ON finance.goods_receipt_proofs USING btree (tenant_id, status, created_at DESC)"
  },
  {
    "i": "analytics.ix_erppa_prov",
    "t": "analytics.erp_purchase_adjustments",
    "mb": 0.04,
    "ddl": "CREATE INDEX CONCURRENTLY ix_erppa_prov ON analytics.erp_purchase_adjustments USING btree (tenant_id, proveedor_code)"
  },
  {
    "i": "trade.idx_daily_captures_tenant_route",
    "t": "trade.daily_captures",
    "mb": 0.04,
    "ddl": "CREATE INDEX CONCURRENTLY idx_daily_captures_tenant_route ON trade.daily_captures USING btree (tenant_id, route_id)"
  },
  {
    "i": "logistics.idx_logistics_vehicle_day_summary_day",
    "t": "logistics.vehicle_day_summary",
    "mb": 0.04,
    "ddl": "CREATE INDEX CONCURRENTLY idx_logistics_vehicle_day_summary_day ON logistics.vehicle_day_summary USING btree (tenant_id, day)"
  },
  {
    "i": "trade.idx_daily_captures_tenant",
    "t": "trade.daily_captures",
    "mb": 0.04,
    "ddl": "CREATE INDEX CONCURRENTLY idx_daily_captures_tenant ON trade.daily_captures USING btree (tenant_id)"
  },
  {
    "i": "trade.idx_daily_captures_tenant_fecha",
    "t": "trade.daily_captures",
    "mb": 0.04,
    "ddl": "CREATE INDEX CONCURRENTLY idx_daily_captures_tenant_fecha ON trade.daily_captures USING btree (tenant_id, fecha)"
  },
  {
    "i": "analytics.ix_glp_neto",
    "t": "analytics.gl_polizas",
    "mb": 0.04,
    "ddl": "CREATE INDEX CONCURRENTLY ix_glp_neto ON analytics.gl_polizas USING btree (tenant_id, source, anio_mes) WHERE (abs(neto) >= 0.01)"
  },
  {
    "i": "trade.idx_daily_captures_tenant_customer",
    "t": "trade.daily_captures",
    "mb": 0.04,
    "ddl": "CREATE INDEX CONCURRENTLY idx_daily_captures_tenant_customer ON trade.daily_captures USING btree (tenant_id, customer_id)"
  },
  {
    "i": "commercial.idx_commercial_customers_visit_days",
    "t": "commercial.customers",
    "mb": 0.03,
    "ddl": "CREATE INDEX CONCURRENTLY idx_commercial_customers_visit_days ON commercial.customers USING gin (visit_days)"
  },
  {
    "i": "commercial.idx_supervisor_actions_tenant_status",
    "t": "commercial.supervisor_actions",
    "mb": 0.03,
    "ddl": "CREATE INDEX CONCURRENTLY idx_supervisor_actions_tenant_status ON commercial.supervisor_actions USING btree (tenant_id, status)"
  },
  {
    "i": "commercial.ix_customers_whatsapp_norm",
    "t": "commercial.customers",
    "mb": 0.02,
    "ddl": "CREATE INDEX CONCURRENTLY ix_customers_whatsapp_norm ON commercial.customers USING btree (tenant_id, mx_normalize_phone((whatsapp)::text)) WHERE ((whatsapp IS NOT NULL) AND (deleted_at IS NULL))"
  },
  {
    "i": "identity.idx_users_tenant",
    "t": "identity.users",
    "mb": 0.02,
    "ddl": "CREATE INDEX CONCURRENTLY idx_users_tenant ON identity.users USING btree (tenant_id)"
  },
  {
    "i": "commercial.ix_commercial_orders_cfdi",
    "t": "commercial.orders",
    "mb": 0.02,
    "ddl": "CREATE INDEX CONCURRENTLY ix_commercial_orders_cfdi ON commercial.orders USING btree (tenant_id, cfdi_uuid)"
  },
  {
    "i": "reconciliation.ix_blind_count_date",
    "t": "reconciliation.blind_counts",
    "mb": 0.02,
    "ddl": "CREATE INDEX CONCURRENTLY ix_blind_count_date ON reconciliation.blind_counts USING btree (tenant_id, business_date DESC)"
  },
  {
    "i": "commercial.idx_commercial_order_status_history_order_time",
    "t": "commercial.order_status_history",
    "mb": 0.02,
    "ddl": "CREATE INDEX CONCURRENTLY idx_commercial_order_status_history_order_time ON commercial.order_status_history USING btree (tenant_id, order_id, changed_at)"
  },
  {
    "i": "identity.idx_role_permissions_tenant",
    "t": "identity.role_permissions",
    "mb": 0.02,
    "ddl": "CREATE INDEX CONCURRENTLY idx_role_permissions_tenant ON identity.role_permissions USING btree (tenant_id)"
  },
  {
    "i": "commercial.ix_customers_phone_norm",
    "t": "commercial.customers",
    "mb": 0.02,
    "ddl": "CREATE INDEX CONCURRENTLY ix_customers_phone_norm ON commercial.customers USING btree (tenant_id, mx_normalize_phone((phone)::text)) WHERE ((phone IS NOT NULL) AND (deleted_at IS NULL))"
  },
  {
    "i": "commercial.idx_commercial_recv_lot_captures_created",
    "t": "commercial.receiving_lot_captures",
    "mb": 0.02,
    "ddl": "CREATE INDEX CONCURRENTLY idx_commercial_recv_lot_captures_created ON commercial.receiving_lot_captures USING btree (tenant_id, created_at)"
  },
  {
    "i": "identity.ix_users_warehouse_id",
    "t": "identity.users",
    "mb": 0.02,
    "ddl": "CREATE INDEX CONCURRENTLY ix_users_warehouse_id ON identity.users USING btree (warehouse_id)"
  },
  {
    "i": "commercial.idx_recv_captures_line",
    "t": "commercial.receiving_lot_captures",
    "mb": 0.02,
    "ddl": "CREATE INDEX CONCURRENTLY idx_recv_captures_line ON commercial.receiving_lot_captures USING btree (tenant_id, receiving_line_id) WHERE (receiving_line_id IS NOT NULL)"
  },
  {
    "i": "finance.ix_fin_ep_clasificacion",
    "t": "finance.expense_proofs",
    "mb": 0.02,
    "ddl": "CREATE INDEX CONCURRENTLY ix_fin_ep_clasificacion ON finance.expense_proofs USING btree (tenant_id, clasificacion, status)"
  },
  {
    "i": "commercial.idx_commercial_recv_lot_captures_supplier",
    "t": "commercial.receiving_lot_captures",
    "mb": 0.02,
    "ddl": "CREATE INDEX CONCURRENTLY idx_commercial_recv_lot_captures_supplier ON commercial.receiving_lot_captures USING btree (tenant_id, supplier_code)"
  },
  {
    "i": "identity.idx_users_tenant_status",
    "t": "identity.users",
    "mb": 0.02,
    "ddl": "CREATE INDEX CONCURRENTLY idx_users_tenant_status ON identity.users USING btree (tenant_id, status)"
  },
  {
    "i": "commercial.idx_coaching_notes_collab",
    "t": "commercial.coaching_notes",
    "mb": 0.02,
    "ddl": "CREATE INDEX CONCURRENTLY idx_coaching_notes_collab ON commercial.coaching_notes USING btree (tenant_id, collaborator_id, status)"
  },
  {
    "i": "commercial.idx_commercial_recv_lot_captures_whp",
    "t": "commercial.receiving_lot_captures",
    "mb": 0.02,
    "ddl": "CREATE INDEX CONCURRENTLY idx_commercial_recv_lot_captures_whp ON commercial.receiving_lot_captures USING btree (tenant_id, warehouse_id, product_id)"
  },
  {
    "i": "commercial.idx_commercial_order_status_history_tenant",
    "t": "commercial.order_status_history",
    "mb": 0.02,
    "ddl": "CREATE INDEX CONCURRENTLY idx_commercial_order_status_history_tenant ON commercial.order_status_history USING btree (tenant_id)"
  },
  {
    "i": "commercial.idx_commercial_recv_sessions_wh",
    "t": "commercial.receiving_sessions",
    "mb": 0.02,
    "ddl": "CREATE INDEX CONCURRENTLY idx_commercial_recv_sessions_wh ON commercial.receiving_sessions USING btree (tenant_id, warehouse_id)"
  },
  {
    "i": "inventory.idx_inventory_products_with_image",
    "t": "inventory.products",
    "mb": 0.02,
    "ddl": "CREATE INDEX CONCURRENTLY idx_inventory_products_with_image ON inventory.products USING btree (sku) WHERE (image_url IS NOT NULL)"
  },
  {
    "i": "commercial.ix_commercial_orders_cfdi_pending",
    "t": "commercial.orders",
    "mb": 0.02,
    "ddl": "CREATE INDEX CONCURRENTLY ix_commercial_orders_cfdi_pending ON commercial.orders USING btree (tenant_id, fulfilled_at) WHERE (((status)::text = 'fulfilled'::text) AND (cfdi_uuid IS NULL))"
  },
  {
    "i": "commercial.idx_commercial_orders_tenant",
    "t": "commercial.orders",
    "mb": 0.02,
    "ddl": "CREATE INDEX CONCURRENTLY idx_commercial_orders_tenant ON commercial.orders USING btree (tenant_id)"
  },
  {
    "i": "commercial.idx_commercial_recv_sessions_status",
    "t": "commercial.receiving_sessions",
    "mb": 0.02,
    "ddl": "CREATE INDEX CONCURRENTLY idx_commercial_recv_sessions_status ON commercial.receiving_sessions USING btree (tenant_id, status)"
  },
  {
    "i": "analytics.ix_cxc_snap",
    "t": "analytics.customer_receivable_snapshots",
    "mb": 0.02,
    "ddl": "CREATE INDEX CONCURRENTLY ix_cxc_snap ON analytics.customer_receivable_snapshots USING btree (tenant_id, sucursal, snapshot_date)"
  },
  {
    "i": "identity.user_events_tenant_id_event_index",
    "t": "identity.user_events",
    "mb": 0.02,
    "ddl": "CREATE INDEX CONCURRENTLY user_events_tenant_id_event_index ON identity.user_events USING btree (tenant_id, event)"
  },
  {
    "i": "identity.user_roles_tenant_id_role_name_index",
    "t": "identity.user_roles",
    "mb": 0.02,
    "ddl": "CREATE INDEX CONCURRENTLY user_roles_tenant_id_role_name_index ON identity.user_roles USING btree (tenant_id, role_name)"
  },
  {
    "i": "commercial.idx_orders_requested_delivery_date",
    "t": "commercial.orders",
    "mb": 0.02,
    "ddl": "CREATE INDEX CONCURRENTLY idx_orders_requested_delivery_date ON commercial.orders USING btree (tenant_id, requested_delivery_date) WHERE (requested_delivery_date IS NOT NULL)"
  },
  {
    "i": "inventory.idx_inventory_products_active_with_image",
    "t": "inventory.products_active",
    "mb": 0.02,
    "ddl": "CREATE INDEX CONCURRENTLY idx_inventory_products_active_with_image ON inventory.products_active USING btree (sku) WHERE (image_url IS NOT NULL)"
  },
  {
    "i": "commercial.idx_commercial_stock_movements_tenant",
    "t": "commercial.stock_movements",
    "mb": 0.02,
    "ddl": "CREATE INDEX CONCURRENTLY idx_commercial_stock_movements_tenant ON commercial.stock_movements USING btree (tenant_id)"
  },
  {
    "i": "reconciliation.ix_blind_counts_warehouse_id",
    "t": "reconciliation.blind_counts",
    "mb": 0.02,
    "ddl": "CREATE INDEX CONCURRENTLY ix_blind_counts_warehouse_id ON reconciliation.blind_counts USING btree (warehouse_id)"
  },
  {
    "i": "fiscal.ix_rfc_issues_estado",
    "t": "fiscal.rfc_issues",
    "mb": 0.02,
    "ddl": "CREATE INDEX CONCURRENTLY ix_rfc_issues_estado ON fiscal.rfc_issues USING btree (tenant_id, estado)"
  },
  {
    "i": "commercial.idx_commercial_stock_movements_wh_product",
    "t": "commercial.stock_movements",
    "mb": 0.02,
    "ddl": "CREATE INDEX CONCURRENTLY idx_commercial_stock_movements_wh_product ON commercial.stock_movements USING btree (tenant_id, warehouse_id, product_id)"
  },
  {
    "i": "commercial.idx_commercial_stock_movements_tenant_date",
    "t": "commercial.stock_movements",
    "mb": 0.02,
    "ddl": "CREATE INDEX CONCURRENTLY idx_commercial_stock_movements_tenant_date ON commercial.stock_movements USING btree (tenant_id, created_at)"
  },
  {
    "i": "finance.ix_fin_ep_folio",
    "t": "finance.expense_proofs",
    "mb": 0.02,
    "ddl": "CREATE INDEX CONCURRENTLY ix_fin_ep_folio ON finance.expense_proofs USING btree (tenant_id, folio_solicitud)"
  },
  {
    "i": "commercial.idx_exec_rule_stats_tenant",
    "t": "commercial.execution_rule_stats",
    "mb": 0.02,
    "ddl": "CREATE INDEX CONCURRENTLY idx_exec_rule_stats_tenant ON commercial.execution_rule_stats USING btree (tenant_id)"
  },
  {
    "i": "finance.ix_fin_ep_tiene_comp",
    "t": "finance.expense_proofs",
    "mb": 0.02,
    "ddl": "CREATE INDEX CONCURRENTLY ix_fin_ep_tiene_comp ON finance.expense_proofs USING btree (tenant_id, tiene_comprobacion) WHERE (status = 'validada'::text)"
  },
  {
    "i": "finance.ix_fin_ep_status",
    "t": "finance.expense_proofs",
    "mb": 0.02,
    "ddl": "CREATE INDEX CONCURRENTLY ix_fin_ep_status ON finance.expense_proofs USING btree (tenant_id, status, created_at DESC)"
  },
  {
    "i": "commercial.idx_commercial_orders_user",
    "t": "commercial.orders",
    "mb": 0.02,
    "ddl": "CREATE INDEX CONCURRENTLY idx_commercial_orders_user ON commercial.orders USING btree (tenant_id, user_id)"
  },
  {
    "i": "commercial.idx_commercial_recv_lot_captures_verdict",
    "t": "commercial.receiving_lot_captures",
    "mb": 0.02,
    "ddl": "CREATE INDEX CONCURRENTLY idx_commercial_recv_lot_captures_verdict ON commercial.receiving_lot_captures USING btree (tenant_id, verdict, status)"
  },
  {
    "i": "commercial.idx_commercial_order_lines_tenant",
    "t": "commercial.order_lines",
    "mb": 0.02,
    "ddl": "CREATE INDEX CONCURRENTLY idx_commercial_order_lines_tenant ON commercial.order_lines USING btree (tenant_id)"
  },
  {
    "i": "commercial.idx_commercial_order_lines_order",
    "t": "commercial.order_lines",
    "mb": 0.02,
    "ddl": "CREATE INDEX CONCURRENTLY idx_commercial_order_lines_order ON commercial.order_lines USING btree (tenant_id, order_id)"
  },
  {
    "i": "commercial.idx_commercial_orders_tenant_route",
    "t": "commercial.orders",
    "mb": 0.01,
    "ddl": "CREATE INDEX CONCURRENTLY idx_commercial_orders_tenant_route ON commercial.orders USING btree (tenant_id, route_id) WHERE (route_id IS NOT NULL)"
  },
  {
    "i": "finance.ix_fin_grp_motivo",
    "t": "finance.goods_receipt_proofs",
    "mb": 0.01,
    "ddl": "CREATE INDEX CONCURRENTLY ix_fin_grp_motivo ON finance.goods_receipt_proofs USING btree (motivo_codigo) WHERE (motivo_codigo IS NOT NULL)"
  },
  {
    "i": "catalog.idx_products_tenant_has_image",
    "t": "catalog.products",
    "mb": 0.01,
    "ddl": "CREATE INDEX CONCURRENTLY idx_products_tenant_has_image ON catalog.products USING btree (tenant_id) WHERE ((image_url IS NOT NULL) AND (deleted_at IS NULL))"
  },
  {
    "i": "finance.ix_expense_proofs_evidencia_por",
    "t": "finance.expense_proofs",
    "mb": 0.01,
    "ddl": "CREATE INDEX CONCURRENTLY ix_expense_proofs_evidencia_por ON finance.expense_proofs USING btree (tenant_id, evidencia_por) WHERE (evidencia_por IS NOT NULL)"
  },
  {
    "i": "commercial.idx_commercial_customers_tenant_route",
    "t": "commercial.customers",
    "mb": 0.01,
    "ddl": "CREATE INDEX CONCURRENTLY idx_commercial_customers_tenant_route ON commercial.customers USING btree (tenant_id, route_id) WHERE (route_id IS NOT NULL)"
  }
];

exports.up = async function up(knex) {
  let n = 0, mb = 0, fallos = 0;
  for (const x of INDICES) {
    try {
      await knex.raw('DROP INDEX CONCURRENTLY IF EXISTS ' + x.i);
      n += 1; mb += x.mb;
    } catch (e) {
      fallos += 1;
      console.log('  ! no pude retirar ' + x.i + ': ' + e.message);
    }
  }
  console.log('  · retirados ' + n + '/' + INDICES.length + ' indices · ~' + mb.toFixed(0) + ' MB liberados'
    + (fallos ? ' · ' + fallos + ' fallo(s)' : ''));
};

exports.down = async function down(knex) {
  let n = 0;
  for (const x of INDICES) {
    try { await knex.raw(x.ddl); n += 1; } catch (e) { console.log('  ! no pude recrear ' + x.i + ': ' + e.message); }
  }
  console.log('  · recreados ' + n + '/' + INDICES.length + ' indices');
};
