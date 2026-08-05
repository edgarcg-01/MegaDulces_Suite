/* eslint-disable no-console */
/**
 * Runner agregado: corre todos los smoke tests en secuencia y reporta total.
 *
 * Categorías:
 *   1. DB direct (knex sin API) — Sprints A.0mt, B.0
 *   2. HTTP E2E (requiere API en :3334) — Sprints B.1+, C.*
 *
 * Para correr esto, el API debe estar arriba en :3334 con ENABLE_MULTITENANT=true.
 */

const { spawnSync } = require('child_process');
const path = require('path');

const TESTS = [
  // DB direct (no requieren API)
  { file: 'test-newdb-tenant-context.js', label: 'A.0mt.1 tenant context', needsApi: false },
  { file: 'test-newdb-rls-isolation.js', label: 'A.0mt.2 RLS isolation', needsApi: false },
  { file: 'test-newdb-auth-multitenant.js', label: 'A.0mt.3 auth multi-tenant', needsApi: false },
  { file: 'test-newdb-orders-flow.js', label: 'B.2 orders state machine', needsApi: false },
  { file: 'test-newdb-orders-with-testdata.js', label: 'B.3.2 multi-line order', needsApi: false },
  { file: 'test-newdb-inventory-count.js', label: 'I.1 inventario físico (folio+snapshot+conteo ciego+coverage+freeze+reconcile)', needsApi: false },
  { file: 'test-newdb-replenishment.js', label: 'RA Compras (schema+sugerido−tránsito+requisición state machine+traspaso guard+min cajas+scanner idempotente)', needsApi: false },
  { file: 'test-newdb-ra-service-level.js', label: 'RA-PRO.1/2 safety stock por nivel de servicio + segmentación XYZ (σ/CV población 90d + Z×σ×√LT + piso + CHECK)', needsApi: false },
  { file: 'test-newdb-ra-network.js', label: 'RA-PRO.6 DRP multi-echelon (CEDIS por demanda dependiente: media Σ + σ=√Σσ² risk pooling + guard self-source)', needsApi: false },
  { file: 'test-newdb-purchase-chain.js', label: 'RA.15 cadena de compra (RQ→OC→OE recepción parcial mueve stock + fill rate + RQ→received + traspaso +dst/−src + folios)', needsApi: false },
  { file: 'test-newdb-purchase-adjustments-findings.js', label: 'RE.10 bridge facturas duplicadas → finance.findings (duplicateGroups SQL + shape hallazgo + UPSERT idempotente por dedup_key + rule L2 + findings_total; skip-graceful sin feed)', needsApi: false },
  { file: 'test-newdb-supplier-discount-recon.js', label: 'RE.10 descuento proveedor (import c84 en erp_supplier_payments + reconciliación 2 canales pago/nota: Σpago==Σc84, Σnota==X-D-55 comercial, clasificación canal pago/nota/ambos; skip-graceful sin feed)', needsApi: false },
  { file: 'test-newdb-discount-leakage.js', label: 'RE.10 descuento no capturado (supplier_discount_policy poblada + leakageGroups lost==tasa×monto_no_capturado + push finance.findings oportunidad idempotente; skip-graceful sin feed)', needsApi: false },
  { file: 'test-newdb-pago-duplicado.js', label: 'Maat pago_duplicado (doble pago: mismo proveedor+monto+método en ventana → finance.findings riesgo; extra==(veces-1)×monto + UPSERT idempotente + severity crítica; skip-graceful sin feed)', needsApi: false },
  { file: 'test-newdb-action-proposer.js', label: 'CxP hallazgo→acción HITL (descuento_no_capturado/pago_duplicado sobre umbral → finance.proposed_actions kind=revisar_hallazgo origen=motor ligada por finding_id + idempotente + aprobar→en_revision; auto-limpia)', needsApi: false },
  { file: 'test-newdb-compras-360.js', label: 'CXP.3 Compras 360 (grid recepción⋈ajuste ligado exacto por entrada_folio + neto=factura−ajuste + cobertura total join 1:0..1; skip-graceful sin feed)', needsApi: false },
  { file: 'test-newdb-landed-cost.js', label: 'CXP.4 Costo neto (landed cost por proveedor = compras−descuento efectivo pago c84+notas; costo_neto=compras−desc + rate=desc/compras + flag anómalo>20%; skip-graceful sin feed)', needsApi: false },
  { file: 'test-newdb-contpaqi-ledger.js', label: 'CP.1 balanza ContPAQi (schema+PK+cuadre Σcargos≈Σabonos+neto+formato anio_mes+familias+aislamiento tenant; tolerante sin import)', needsApi: false },
  { file: 'test-newdb-contpaqi-bank.js', label: 'CP.2 ledger bancario ContPAQi (schema+PK id_movimiento+cuentas 102x+flujo deposito/retiro+depósitos≈retiros+formato+aislamiento; tolerante sin import)', needsApi: false },
  { file: 'test-newdb-contpaqi-bank-link.js', label: 'CP.2 crosswalk CB↔ContPAQi (col contpaqi_cuenta + match familia+número enlaza ≥8 cuentas + comparación por periodo con totales; tolerante sin data)', needsApi: false },
  { file: 'test-newdb-contpaqi-efos.js', label: 'CP.3 proveedores ContPAQi + cruce EFOS (schema + grants app_runtime en analytics+fiscal + cobertura RFC + cruce vs sat_list_rfcs 69/69B; tolerante sin data)', needsApi: false },
  { file: 'test-newdb-collection-deposits.js', label: 'CC Comprobantes de Cobranza (schema erp_collections + collection_deposits RLS + importer UA0501 + monto_match tolerancia $1 + attach→join listCobros→validar/rechazar→CHECK, rollback sin efecto real)', needsApi: false },
  { file: 'test-newdb-supplier-receipt-proofs.js', label: 'CC ext Pagos a proveedor (XD2501) + Órdenes de entrada (X-A-40⋈X-A-37): schema 2 mirrors + 2 evidencias RLS + importers + monto_match (pago $1 / entrada total|subtotal) + attach→join→validar/rechazar→CHECK, rollback', needsApi: false },
  { file: 'test-newdb-expense-comprobaciones.js', label: 'GX.8 Comprobación de Gastos (2ª etapa): schema finance.expense_comprobaciones RLS + fuente autocomplete gastos XA1001 (expense_documents) + attach→statusByGasto→validar/rechazar→CHECK, rollback', needsApi: false },
  { file: 'test-newdb-fiq0-phone-identity.js', label: 'FIQ.0 identidad por teléfono (mx_normalize_phone paridad SQL↔TS + índices funcionales + resolveCustomerByPhone 4 formatos + dedup casual + seed tenant map)', needsApi: false },
  { file: 'test-newdb-fiq3-volume-pricing.js', label: 'FIQ.3 precio por cantidad (tiers de volumen: mejor precio con min_qty≤qty, caja≤suelto, bajo-mínimo sin tier — paridad SQL↔JS vs data real)', needsApi: false },
  { file: 'test-newdb-fiq6-reservations.js', label: 'FIQ.6 apartado con TTL (RLS forzado 3 tablas + folio AP-YYYY-NNNNN + reserva sube reserved_quantity/baja disponible + cron expiración devuelve stock + activos por teléfono — rollback sin efecto real)', needsApi: false },
  { file: 'test-newdb-fiq7-contact-trust.js', label: 'FIQ.7 trust-score (RLS 2 tablas + seed thresholds + UPSERT idempotente feature store + CHECK tier + tabla de decisión: cold-start/limpio/no-show block/fallos-deposit/cancela/solo-juega/deuda con umbrales sembrados)', needsApi: false },
  { file: 'test-newdb-fiq1-brain.js', label: 'FIQ.1 cerebro (bot_chat_log RLS + CHECK feedback±1 + throttle cuenta turnos/24h e ignora >24h + tiering Haiku/Sonnet por complejidad) — rollback sin efecto real', needsApi: false },
  { file: 'test-newdb-fiq8-market.js', label: 'FIQ.8 análisis de mercado (ranking demanda real product_sales_stats units_365d/30d: priceado + no-promo + orden DESC + sin revenue + tenant explícito aísla)', needsApi: false },
  { file: 'test-newdb-fiq5-location.js', label: 'FIQ.5 geolocalización (contrato pin Meta → adapter.normalize coords → orchestrator merge delivery_address → home-delivery parseCoords/geofence; conserva calle previa; ignora pin sin coords)', needsApi: false },
  { file: 'test-newdb-fiq10-reorder.js', label: 'FIQ.10 outbound reorden (reorder_nudges RLS + CHECK status + targeting atrasados/contactables/active-at_risk order desc + cooldown anti-spam + composeReorderMessage)', needsApi: false },
  { file: 'test-auto-received-matching.js', label: 'RA.15.1 auto-received matching (X-A-40↔OC por presencia sku+almacén+fecha, dedup folio, OC vieja primero, cap pendiente)', needsApi: false },
  { file: 'test-newdb-fiscal-efos.js', label: 'FISCAL.0/1/1.1 motor listas SAT (69B+69) + validación RFC + bridge Maat (cruce×sat_list_rfcs+idempotencia+triage+formato_invalido+FK rule_registry+dedup finance.findings+L2 suprimida)', needsApi: false },
  { file: 'test-newdb-fiscal-diagnostics.js', label: 'FD.0/2 Diagnóstico facturación (emission_errors RLS + fix bug estatus_sat CHECK + captura idempotente por dedup_key + auto-reapertura)', needsApi: false },
  { file: 'smoke-horus-missed-visit.js', label: 'Horus.ACT (ACT.1 missed_visit + ACT.4 notify/incident + ACT.2 reorden visit_sequence + ACT.3 add_opportunity_store + ACT.5 balanceo route_rebalance_log + sales_route round-trip)', needsApi: false },
  // HTTP E2E (requieren API)
  { file: 'http-inventory-count-test.js', label: 'I.5 conteo correctness (A1 freeze guard + A2 no-revierte + A4 segregación count_3)', needsApi: true },
  { file: 'http-inventory-abc-test.js', label: 'I.6 clasificación ABC (refresh + shape + filtro por clase)', needsApi: true },
  { file: 'http-inventory-cycle-count-test.js', label: 'I.7 conteo cíclico acotado (open-cycle por clase/lista)', needsApi: true },
  { file: 'http-inventory-aisles-test.js', label: 'PA.1 pasillos 2D (CRUD + mapeo bulk SKU→pasillo + carga)', needsApi: true },
  { file: 'http-inventory-aisle-teams-test.js', label: 'PA.3+PA.4 tablero de equipos + aisle-progress + scoping contador (board/generar/set + items.aisle_id + A/B/sobrante)', needsApi: true },
  { file: 'http-e2e-test.js', label: 'B.1 HTTP CRUD + order flow', needsApi: true },
  { file: 'http-carga-load-status-test.js', label: 'Carga: checklist sí/no cargamos (load-status E2E)', needsApi: true },
  { file: 'http-tenant-isolation-test.js', label: 'B HTTP tenant isolation', needsApi: true },
  { file: 'http-analytics-test.js', label: 'C.0 analytics endpoints', needsApi: true },
  { file: 'http-analytics-mv-test.js', label: 'C.1 materialized views', needsApi: true },
  { file: 'http-alerts-ws-test.js', label: 'C.4 alerts WS realtime', needsApi: true },
  { file: 'http-portal-b2b-test.js', label: 'D.1 portal B2B + audit history', needsApi: true },
  { file: 'http-recommendations-test.js', label: 'D.4 recommendations basket', needsApi: true },
  { file: 'http-intelligence-test.js', label: 'M Motor de Inteligencia (Customer360+NBA+agente+feedback)', needsApi: true },
  // Fase J — Logística
  { file: 'test-logistics-rls-smoke.js', label: 'J.0 logistics RLS isolation', needsApi: false },
  { file: 'http-logistics-e2e-test.js', label: 'J.1 logistics modules E2E (fleet+shipments+guides+expenses+payroll)', needsApi: true },
  { file: 'http-logistics-analytics-test.js', label: 'J.5 logistics analytics (overview, profitability, fleet, payroll)', needsApi: true },
  { file: 'http-shipment-hook-fulfill-test.js', label: 'J.6.1 hook close→fulfilled consume stock (FIX)', needsApi: true },
  { file: 'http-logistics-j8-test.js', label: 'J.8 migración repo (state machine 7 estados, checklists, photos, reports jspdf)', needsApi: true },
  { file: 'http-logistics-j9-test.js', label: 'J.9 UI port (endpoints dashboard/staff/guides/costs)', needsApi: true },
  { file: 'http-j10-order-tracking-test.js', label: 'J.10 order tracking (commercial/orders/:id/shipments)', needsApi: true },
  // Fase LM-K — entrega a domicilio desde folio Kepler
  { file: 'http-home-delivery-test.js', label: 'LM-K entrega domicilio (folio Kepler → dispatch → outcome COD → arqueo)', needsApi: true },
  // Fase F — comercio conversacional WhatsApp (webhook simulador end-to-end)
  { file: 'http-whatsapp-webhook-test.js', label: 'F.0/F.1 WhatsApp webhook (verify + /sim inbound → cola → placeholder out + dedup + DB hilo/mensajes)', needsApi: true },
  // Fase K — AI product match en captures
  { file: 'http-ai-match-test.js', label: 'K.1 AI product match (Claude Haiku + Voyage + pgvector)', needsApi: true },
  // LTV Auditoría en Ruta — detalle geográfico (traza GPS + tickets ubicados por hora)
  { file: 'test-newdb-ltv-audit-detail.js', label: 'LTV.16 detalle auditoría (traza por tracker aunque vehicle_id NULL + tickets ligados por route_code↔route_number + ubicación por hora GPS + sin-hora no ubica)', needsApi: false },
  // Cierre de ruta (port Automation_RD)
  { file: 'test-route-tickets-rls-smoke.js', label: 'RD route_tickets RLS isolation', needsApi: false },
  { file: 'http-route-tickets-test.js', label: 'RD cierre de ruta E2E (3 tickets + reportes)', needsApi: true },
  // Captura de vendedor — cadena post-OCR (bridge alias + venta + visita sin ponderación)
  { file: 'http-vendor-capture-e2e-test.js', label: 'VC captura vendedor E2E (alias código→planograma + venta + visita)', needsApi: true },
  // Apartado Rutas — detalle por ruta (tiendas/cobertura + tiempos + trazabilidad)
  { file: 'http-routes-analysis-test.js', label: 'Rutas: detalle por ruta (visits tiempos+GPS, stores cobertura)', needsApi: true },
  // Mapa Comercial — tiendas geolocalizadas + historial propio vs competencia
  { file: 'http-commercial-map-test.js', label: 'Mapa Comercial: stores (coord híbrida + presencia) + history (propio/competencia)', needsApi: true },
  // V.6 Modo Vendedor — autodetección de llegada (nearby + anti-traslape + backfill capture-on-visit)
  { file: 'http-vendor-geo-test.js', label: 'V.6 autodetección llegada (nearby ranked + guard anti-traslape + check-in backfill)', needsApi: true },
  // Take-order: place atómico (preventa draft→confirmed 1 trx idempotente) + replay offline
  { file: 'http-vendor-place-test.js', label: 'Take-order: POST /orders/:id/place (atómico+idempotente, history, preventa no-reserva, replay offline)', needsApi: true },
  // Thot T.1 — recomendación producto-first (afinidad market-basket + zona + rotación + margen)
  { file: 'http-thot-test.js', label: 'Thot T.1 suggest (afinidad cart-aware + zona + rotación·margen, sin basura)', needsApi: true },
  // Thot T.2 — empuje dirigido (marca foco): el negocio decide qué empujar
  { file: 'http-thot-directives-test.js', label: 'Thot T.2 empuje dirigido (directriz marca foco → suggest reason=estrategia)', needsApi: true },
  // SM Supervisor de Movimientos — cuadre caja+inventario (self-contained: inyecta+scan+triage+cleanup)
  { file: 'http-reconciliation-test.js', label: 'SM.1/SM.2 cuadre (caja descuadre crítico + merma + bandeja + feedback L2)', needsApi: true },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Suites que disparan el tier `short`/`long` del throttler global y necesitan
// el reset del bucket (ttl 60s) antes de correr. Si no esperamos, llegan al
// PRIMER request con 429 porque las suites previas agotaron la cuota.
const NEEDS_THROTTLE_COOLDOWN = new Set([
  'http-analytics-mv-test.js',  // C.1 — POST /refresh tiene @Throttle short: 3/60s
  'http-ai-match-test.js',      // K.1 — @Throttle long: 10/60s, además testea el 429 internamente
]);

(async () => {
  const root = path.resolve(__dirname);
  const results = [];
  const useThrottleBypass = process.env.THROTTLE_DISABLED === 'true';
  if (useThrottleBypass) {
    console.log('THROTTLE_DISABLED=true — API debería estar arriba con skipIf activo, sin cooldowns.');
  }

  for (const t of TESTS) {
    if (t.needsApi && !useThrottleBypass && NEEDS_THROTTLE_COOLDOWN.has(t.file)) {
      process.stdout.write(`\n⏸ throttle cooldown 65s antes de ${t.label}...\n`);
      await sleep(65_000);
    } else if (t.needsApi) {
      // Pequeña pausa entre suites HTTP para no agotar el tier short (10/s).
      await sleep(1_500);
    }
    const filePath = path.join(root, 'tests', t.file);
    process.stdout.write(`\n━━━ ${t.label} (${t.file}) ━━━\n`);
    const start = Date.now();
    const r = spawnSync('node', [filePath], {
      cwd: path.resolve(root, '..'),
      stdio: 'inherit',
      env: process.env,
    });
    const ms = Date.now() - start;
    results.push({
      label: t.label,
      file: t.file,
      exit: r.status,
      ok: r.status === 0,
      ms,
    });
  }

  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║                  RESUMEN DE SUITES                      ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  let okCount = 0;
  let failCount = 0;
  for (const r of results) {
    const status = r.ok ? '✅' : '❌';
    console.log(`${status} ${r.label.padEnd(40)} ${r.ms}ms`);
    if (r.ok) okCount++;
    else failCount++;
  }
  console.log(`\nTotal: ${okCount}/${results.length} suites verde, ${failCount} fallaron.`);

  if (failCount > 0) {
    console.log('\n┌── HINTS MEMORIALES (si viste alguno de estos patterns arriba) ──────────');
    console.log('│');
    console.log('│  Connection refused / ECONNREFUSED');
    console.log('│    → API no está arriba en :3334. nx serve api con ENABLE_MULTITENANT=true.');
    console.log('│');
    console.log('│  23502 not-null violation column "tenant_id"');
    console.log('│    → trigger auto_populate_tenant_id no aplicado en la tabla. Ver memoria');
    console.log('│      feedback_auto_populate_trigger_prod. Fix: migración 20260606000000.');
    console.log('│');
    console.log('│  25P02 in_failed_sql_transaction');
    console.log('│    → un catch que tragó error DB dejó la trx en estado falla y siguió.');
    console.log('│      Ver memoria feedback_global_request_tx_25p02. Fix: savepoint.');
    console.log('│');
    console.log('│  permission denied for table / RLS 0 rows con data presente');
    console.log('│    → request handler no usa TenantKnexService.run() → app_runtime ve 0.');
    console.log('│      Ver memoria feedback_tenant_knex_rls. Fix: envolver query en run().');
    console.log('│');
    console.log('│  403 "permisos dinámicos" para rol con permiso correcto en JWT');
    console.log('│    → permission nuevo SIN map en permissionToSubject / permissionToAction');
    console.log('│      en apps/api/.../ability.factory.ts. Ver memoria feedback_ability_factory_mapping.');
    console.log('│');
    console.log('│  column "activo" can only be updated to DEFAULT');
    console.log('│    → writes a columna GENERATED ALWAYS AS (deleted_at IS NULL). Fix:');
    console.log('│      usar deleted_at:NOW() / null. Ver memoria feedback_activo_generated_pattern.');
    console.log('│');
    console.log('│  429 Too Many Requests / ThrottlerException');
    console.log('│    → tier short (10/s) o long (10/60s) agotado. Correr con THROTTLE_DISABLED=true');
    console.log('│      o agregar la suite a NEEDS_THROTTLE_COOLDOWN en run-all-tests.js.');
    console.log('│');
    console.log('│  401 / JWT secret invalid / signature verification failed');
    console.log('│    → JWT_SECRET mismatch entre cliente y server. Arrancar API con');
    console.log('│      JWT_SECRET= explícito en env hasta fix de boot order. Ver memoria');
    console.log('│      project_trade_marketing_b2b_evolution (gaps verificación HTTP E2E).');
    console.log('│');
    console.log('│  "directory corrupt" durante migrate / knex_migrations mismatch');
    console.log('│    → fila en knex_migrations sin archivo en filesystem. Ver memoria');
    console.log('│      feedback_no_manual_knex_migrations_prod. NUNCA INSERT manual.');
    console.log('│');
    console.log('│  ¿Otro patron? Buscá en ~/.claude/projects/.../memory/ con grep antes de debuggear.');
    console.log('└─────────────────────────────────────────────────────────────────────────');
  }

  process.exit(failCount === 0 ? 0 : 1);
})();
