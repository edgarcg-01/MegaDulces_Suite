'use strict';
/**
 * `[EMB.24]` `[EMB.26]` `[EMB.29]` — Pago por viaje cerrado (ADR-091).
 *
 * La comisión, los viáticos y la maniobra de carga de logística se pagan HOY como gasto en Kepler
 * (conceptos 075 / 128 / 186), un gasto por persona cada 14 días, sin decir qué viajes paga: de
 * 159 gastos 075/128 de 90 días sólo 5 tienen vale en la Suite. Esta migración arma lo necesario
 * para liberar ese dinero SÓLO cuando el viaje se cerró y cuadró, y pagarlo por Gastos.
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-10-09/12) ────────────────────────────────────
 *  · Traspasos (serie 2, destino `TI###`): 927 de 981 (94%) tienen su recepción `U-A-50` en la
 *    sucursal destino, casi todas al mismo importe; mediana 0–2 días, p90 ≤ 9.
 *  · Clientes (serie 1): la factura sale 15–25 min DESPUÉS del embarque (antes de salir) y el
 *    cobro llega 7–21 días después en ~50%: Kepler no confirma la entrega a tiempo. Decisión del
 *    usuario (opción A): la parada de cliente la cierra la REMISIÓN FIRMADA que sube Logística.
 *  · ⛔ `TI###` NO es el número de sucursal (TI007 = Zamora 05, TI004 = Morelia Abastos 08).
 *    Cruzando por el número la cobertura salía 5%; con `pv_suc_ip`, 94%.
 *
 * ── Qué crea ───────────────────────────────────────────────────────────────────────────────
 *  1. `analytics.erp_shipment_stop_closure` — por PARADA de Kepler (U-D-41): tipo (traspaso /
 *     cliente / carga_ruta) y, en traspasos, la recepción y el veredicto (cerrada / faltante /
 *     sobrante / pendiente). Derive-no-copy sobre `kepler_ods`.
 *  2. `finance.trip_pay_lines` — la liga vale ↔ (viaje o carga, persona, concepto). Su índice
 *     único parcial es lo que impide PAGAR DOS VECES lo mismo. Si el vale se rechaza, el
 *     renglón deja de estar vigente cuando se arma el siguiente vale.
 *  3. `logistics.v_trip_stop_closure` — por parada de la guía de la Suite: cómo se cerró.
 *  4. `logistics.v_trip_state` — por guía: abierto / cerrado / cerrado con diferencia / guía
 *     incompleta / sin paradas / cancelado.
 *  5. `logistics.v_trip_pay_items` — lo que cada persona tiene por cada viaje o carga, si ya se
 *     liberó y si ya está en un vale.
 *
 * Las vistas de `logistics` son `security_invoker`: respetan la RLS de quien consulta.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const M = '00000000-0000-0000-0000-00000000d01c';

const V_STOP_CLOSURE = `
  CREATE VIEW analytics.erp_shipment_stop_closure AS
  WITH ti AS (
    SELECT DISTINCT ON (btrim(c7)) btrim(c7) AS ti, btrim(c1) AS suc
      FROM kepler_ods.pv_suc_ip
     WHERE btrim(c7) ~ '^TI[0-9]+$' AND btrim(c1) ~ '^[0-9]{2}$'
     ORDER BY btrim(c7), btrim(c1)
  ),
  emb AS (
    SELECT
      btrim(h.sucursal)                         AS sucursal,
      (h.c5)::integer                           AS serie,
      btrim(h.c6)                               AS folio,
      NULLIF(btrim(h.c86),'0000000')            AS guia_embarque,
      (h.c9)::date                              AS fecha,
      NULLIF(btrim(h.c10),'')                   AS destino_code,
      round(COALESCE(h.c16,0)::numeric, 2)      AS importe_embarcado,
      CASE WHEN (h.c5)::integer = 2 AND btrim(h.c10) ~ '^TI[0-9]'      THEN 'traspaso'
           WHEN (h.c5)::integer = 2 AND btrim(h.c10) ~ '^(RUTA|RD)'    THEN 'carga_ruta'
           WHEN (h.c5)::integer = 1                                    THEN 'cliente'
           ELSE 'otro' END                       AS tipo_parada
      FROM kepler_ods.kdm1 h
     WHERE h.c2 = 'U' AND h.c3 = 'D' AND (h.c4)::integer = 41
       AND btrim(h.c1) = btrim(h.sucursal)
  )
  SELECT
    '${M}'::uuid AS tenant_id,
    e.sucursal, e.serie, e.folio, e.guia_embarque, e.fecha,
    e.destino_code, e.tipo_parada, e.importe_embarcado,
    td.suc                                  AS destino_sucursal,
    r.recepcion_folio, r.recepcion_importe, r.recepcion_fecha,
    CASE WHEN r.recepcion_importe IS NULL THEN NULL
         ELSE round(r.recepcion_importe - e.importe_embarcado, 2) END AS diferencia,
    CASE e.tipo_parada
      WHEN 'traspaso' THEN
        CASE WHEN td.suc IS NULL                                          THEN 'destino_desconocido'
             WHEN r.recepcion_folio IS NULL                               THEN 'pendiente'
             WHEN abs(r.recepcion_importe - e.importe_embarcado) <= 1     THEN 'cerrada'
             WHEN r.recepcion_importe < e.importe_embarcado               THEN 'faltante'
             ELSE 'sobrante' END
      WHEN 'carga_ruta' THEN 'cerrada'
      ELSE 'la_cierra_la_suite' END         AS cierre_kepler
  FROM emb e
  LEFT JOIN ti td  ON td.ti  = e.destino_code
  LEFT JOIN ti tor ON tor.suc = e.sucursal
  LEFT JOIN LATERAL (
    SELECT btrim(x.c6)                           AS recepcion_folio,
           round(COALESCE(x.c16,0)::numeric, 2)  AS recepcion_importe,
           (x.c9)::date                          AS recepcion_fecha
      FROM kepler_ods.kdm1 x
     WHERE x.c2 = 'U' AND x.c3 = 'A' AND x.c4 = 50
       AND btrim(x.sucursal) = td.suc
       AND btrim(x.c39) = e.folio
       AND btrim(x.c1) = td.suc
       AND x.c37 = 41 AND x.c38 = e.serie
       AND btrim(x.c10) = tor.ti
       AND COALESCE(btrim(x.c43),'') <> 'C'
     ORDER BY abs((x.c9)::date - e.fecha), btrim(x.c6)
     LIMIT 1
  ) r ON e.tipo_parada = 'traspaso'
`;

const V_TRIP_STOP = `
  CREATE VIEW logistics.v_trip_stop_closure WITH (security_invoker = true) AS
  SELECT
    r.tenant_id,
    r.id                         AS recipient_id,
    r.guide_id,
    g.shipment_id,
    s.folio                      AS shipment_folio,
    s.kepler_sucursal,
    s.kepler_guia,
    s.shipment_date,
    r.sequence_order,
    r.customer_name,
    r.kepler_serie,
    r.kepler_folio,
    r.value,
    COALESCE(c.tipo_parada, CASE WHEN r.kepler_folio IS NULL THEN 'manual' ELSE 'sin_documento' END) AS tipo_parada,
    c.destino_code,
    c.importe_embarcado,
    c.recepcion_folio,
    c.recepcion_importe,
    c.recepcion_fecha,
    c.diferencia,
    r.status                     AS recipient_status,
    r.delivered_at,
    r.delivered_to,
    r.proof_photo_url,
    r.incident_type,
    r.incident_notes,
    CASE
      WHEN c.tipo_parada = 'traspaso' THEN
        CASE c.cierre_kepler WHEN 'cerrada' THEN 'cerrada'
                             WHEN 'faltante' THEN 'diferencia'
                             WHEN 'sobrante' THEN 'diferencia'
                             ELSE 'pendiente' END
      WHEN c.tipo_parada = 'carga_ruta' THEN 'cerrada'
      WHEN r.status IN ('entregado','no_entregado','rechazado') AND r.proof_photo_url IS NOT NULL THEN 'cerrada'
      ELSE 'pendiente'
    END                          AS estado_parada,
    CASE
      WHEN c.tipo_parada = 'traspaso' THEN
        CASE c.cierre_kepler
          WHEN 'cerrada'  THEN 'Recibido en destino por el mismo importe'
          WHEN 'faltante' THEN 'Recibido con faltante'
          WHEN 'sobrante' THEN 'Recibido con sobrante'
          WHEN 'destino_desconocido' THEN 'Destino sin sucursal en Kepler'
          ELSE 'Falta la recepción en la sucursal destino' END
      WHEN c.tipo_parada = 'carga_ruta' THEN 'Carga a camión de ruta: se cierra al embarcar'
      WHEN r.status = 'entregado'    AND r.proof_photo_url IS NOT NULL THEN 'Entregado con remisión firmada'
      WHEN r.status IN ('no_entregado','rechazado') AND r.proof_photo_url IS NOT NULL THEN 'No se entregó, con evidencia'
      WHEN r.status <> 'pendiente' THEN 'Falta la foto de la remisión'
      ELSE 'Falta registrar la entrega con la remisión firmada'
    END                          AS motivo
  FROM logistics.guide_recipients r
  JOIN logistics.delivery_guides g ON g.tenant_id = r.tenant_id AND g.id = r.guide_id
  JOIN logistics.shipments       s ON s.tenant_id = g.tenant_id AND s.id = g.shipment_id
  LEFT JOIN analytics.erp_shipment_stop_closure c
         ON r.kepler_folio IS NOT NULL
        AND c.sucursal = r.kepler_warehouse_code
        AND c.serie    = NULLIF(btrim(r.kepler_serie),'')::integer
        AND c.folio    = r.kepler_folio
`;

const V_TRIP_STATE = `
  CREATE VIEW logistics.v_trip_state WITH (security_invoker = true) AS
  WITH p AS (
    SELECT guide_id,
           count(*)                                              AS paradas,
           count(*) FILTER (WHERE estado_parada = 'cerrada')     AS cerradas,
           count(*) FILTER (WHERE estado_parada = 'diferencia')  AS con_diferencia,
           count(*) FILTER (WHERE estado_parada = 'pendiente')   AS pendientes
      FROM logistics.v_trip_stop_closure
     GROUP BY guide_id
  )
  SELECT
    g.tenant_id,
    g.id                  AS guide_id,
    g.number              AS guide_number,
    g.shipment_id,
    s.folio               AS shipment_folio,
    s.kepler_sucursal,
    s.kepler_guia,
    s.shipment_date,
    s.status              AS shipment_status,
    (g.driver_id IS NULL OR g.departure_time IS NULL OR g.arrival_time IS NULL) AS guia_incompleta,
    COALESCE(p.paradas, 0)        AS paradas,
    COALESCE(p.cerradas, 0)       AS paradas_cerradas,
    COALESCE(p.con_diferencia, 0) AS paradas_con_diferencia,
    COALESCE(p.pendientes, 0)     AS paradas_pendientes,
    CASE
      WHEN g.status = 'cancelada' OR s.status = 'cancelado' THEN 'cancelado'
      WHEN g.driver_id IS NULL OR g.departure_time IS NULL OR g.arrival_time IS NULL THEN 'guia_incompleta'
      WHEN COALESCE(p.paradas, 0) = 0  THEN 'sin_paradas'
      WHEN p.pendientes > 0            THEN 'abierto'
      WHEN p.con_diferencia > 0        THEN 'cerrado_con_diferencia'
      ELSE 'cerrado'
    END                   AS estado_viaje
  FROM logistics.delivery_guides g
  JOIN logistics.shipments s ON s.tenant_id = g.tenant_id AND s.id = g.shipment_id
  LEFT JOIN p ON p.guide_id = g.id
  WHERE g.deleted_at IS NULL AND s.deleted_at IS NULL
`;

const V_PAY_ITEMS = `
  CREATE VIEW logistics.v_trip_pay_items WITH (security_invoker = true) AS
  WITH personas AS (
    SELECT t.*, x.rol, x.driver_id, x.comision, x.viatico
      FROM logistics.v_trip_state t
      JOIN logistics.delivery_guides g ON g.tenant_id = t.tenant_id AND g.id = t.guide_id
      CROSS JOIN LATERAL (VALUES
        ('chofer',   g.driver_id,  g.driver_commission,  NULLIF(g.per_diem_breakdown -> 'driver'  ->> 'subtotal','')::numeric),
        ('ayudante', g.helper1_id, g.helper1_commission, NULLIF(g.per_diem_breakdown -> 'helper1' ->> 'subtotal','')::numeric),
        ('ayudante', g.helper2_id, g.helper2_commission, NULLIF(g.per_diem_breakdown -> 'helper2' ->> 'subtotal','')::numeric)
      ) AS x(rol, driver_id, comision, viatico)
     WHERE x.driver_id IS NOT NULL
  ),
  items AS (
    SELECT tenant_id, 'guia'::text AS source, guide_id AS source_id, shipment_id, shipment_folio,
           kepler_sucursal, kepler_guia, shipment_date, guide_number, driver_id, rol,
           'comision'::text AS concept, round(comision, 2) AS amount, estado_viaje,
           paradas, paradas_cerradas, paradas_con_diferencia, paradas_pendientes
      FROM personas WHERE COALESCE(comision, 0) > 0
    UNION ALL
    SELECT tenant_id, 'guia', guide_id, shipment_id, shipment_folio,
           kepler_sucursal, kepler_guia, shipment_date, guide_number, driver_id, rol,
           'viatico', round(viatico, 2), estado_viaje,
           paradas, paradas_cerradas, paradas_con_diferencia, paradas_pendientes
      FROM personas WHERE COALESCE(viatico, 0) > 0
    UNION ALL
    SELECT ld.tenant_id, 'carga', ld.id, ld.shipment_id, s.folio,
           s.kepler_sucursal, s.kepler_guia, s.shipment_date, NULL, ld.driver_id, 'cargador',
           'maniobra_carga', round(ld.rate, 2),
           CASE WHEN s.status = 'cancelado' THEN 'cancelado'
                WHEN s.kepler_guia IS NOT NULL OR s.status <> 'programado' THEN 'cargado'
                ELSE 'sin_salida' END,
           NULL, NULL, NULL, NULL
      FROM logistics.load_details ld
      JOIN logistics.shipments s ON s.tenant_id = ld.tenant_id AND s.id = ld.shipment_id
     WHERE s.deleted_at IS NULL AND COALESCE(ld.rate, 0) > 0
  )
  SELECT
    i.*,
    d.full_name AS persona,
    (i.estado_viaje IN ('cerrado','cerrado_con_diferencia','cargado')) AS liberado,
    CASE i.estado_viaje
      WHEN 'cerrado'                THEN 'Viaje cerrado'
      WHEN 'cerrado_con_diferencia' THEN 'Viaje cerrado; una parada con diferencia (no frena el pago)'
      WHEN 'cargado'                THEN 'Carga registrada en Kepler'
      WHEN 'abierto'                THEN 'Faltan paradas por cerrar'
      WHEN 'guia_incompleta'        THEN 'La guía no está completa'
      WHEN 'sin_paradas'            THEN 'La guía no tiene paradas'
      WHEN 'sin_salida'             THEN 'El embarque todavía no sale'
      WHEN 'cancelado'              THEN 'Viaje cancelado'
      ELSE i.estado_viaje END       AS motivo,
    pl.expense_proof_id,
    ep.status                       AS vale_status,
    ep.folio_solicitud              AS vale_folio,
    (pl.id IS NOT NULL AND COALESCE(ep.status,'') <> 'rechazada') AS en_vale
  FROM items i
  JOIN logistics.drivers d ON d.tenant_id = i.tenant_id AND d.id = i.driver_id
  LEFT JOIN finance.trip_pay_lines pl
         ON pl.tenant_id = i.tenant_id AND pl.source = i.source AND pl.source_id = i.source_id
        AND pl.driver_id = i.driver_id AND pl.concept = i.concept AND pl.vigente
  LEFT JOIN finance.expense_proofs ep ON ep.id = pl.expense_proof_id
`;

const COMENTARIOS = {
  'analytics.erp_shipment_stop_closure':
    'EMB.24 — Cierre de cada parada de Kepler (U-D-41). Traspaso (serie 2, TI###): con la recepción U-A-50 de la sucursal destino (c37=41, c38=serie, c39=folio, c10=TI del origen); TI### se traduce con pv_suc_ip (NO es el número de sucursal). Carga a ruta: cerrada al embarcar. Cliente: la cierra la Suite con la remisión firmada (ADR-091). Derive-no-copy.',
  'logistics.v_trip_stop_closure':
    'EMB.24 — Cómo se cerró cada parada de una guía de la Suite: traspaso con la recepción de Kepler, carga a ruta al embarcar, cliente con la remisión firmada (foto obligatoria). Lo que no tiene documento queda pendiente, nunca cerrado por omisión.',
  'logistics.v_trip_state':
    'EMB.26 — Estado del viaje por guía: abierto / cerrado / cerrado_con_diferencia / guia_incompleta / sin_paradas / cancelado. Una diferencia no frena el pago (decisión 2026-10-09: se retiene sólo la parada).',
  'logistics.v_trip_pay_items':
    'EMB.26/EMB.29 — Lo que cada persona tiene por viaje (comisión 075, viático 128) o por carga (maniobra 186), si ya se liberó y si ya está en un vale de Gastos. Montos calculados en la guía (EMB.19/22) y en la carga (tarifa_maniobra_carga).',
};

async function grantLectura(knex, nombre) {
  await knex.raw(`GRANT SELECT ON ${nombre} TO app_runtime`);
  await knex.raw(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dev_ro') THEN
      EXECUTE 'GRANT SELECT ON ${nombre} TO dev_ro';
    END IF; END $$`);
}

async function dropVistas(knex) {
  await knex.raw('DROP VIEW IF EXISTS logistics.v_trip_pay_items');
  await knex.raw('DROP VIEW IF EXISTS logistics.v_trip_state');
  await knex.raw('DROP VIEW IF EXISTS logistics.v_trip_stop_closure');
  await knex.raw('DROP VIEW IF EXISTS analytics.erp_shipment_stop_closure');
}

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  // 2. La liga vale ↔ viaje/carga. Va ANTES de las vistas: v_trip_pay_items la lee.
  if (!(await knex.schema.withSchema('finance').hasTable('trip_pay_lines'))) {
    await knex.raw(`
      CREATE TABLE finance.trip_pay_lines (
        id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id         uuid NOT NULL REFERENCES identity.tenants(id),
        expense_proof_id  uuid NOT NULL REFERENCES finance.expense_proofs(id) ON DELETE RESTRICT,
        source            text NOT NULL CHECK (source IN ('guia','carga')),
        source_id         uuid NOT NULL,
        shipment_id       uuid,
        driver_id         uuid NOT NULL,
        concept           text NOT NULL CHECK (concept IN ('comision','viatico','maniobra_carga')),
        amount            numeric(12,2) NOT NULL CHECK (amount > 0),
        detail            jsonb NOT NULL DEFAULT '{}'::jsonb,
        vigente           boolean NOT NULL DEFAULT true,
        created_at        timestamptz NOT NULL DEFAULT now(),
        created_by        text,
        updated_at        timestamptz NOT NULL DEFAULT now(),
        updated_by        text
      )`);
  }
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_trip_pay_lines_una_vez
      ON finance.trip_pay_lines (tenant_id, source, source_id, driver_id, concept)
      WHERE vigente`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_trip_pay_lines_vale ON finance.trip_pay_lines (expense_proof_id)`);
  await knex.raw('ALTER TABLE finance.trip_pay_lines ENABLE ROW LEVEL SECURITY');
  await knex.raw('ALTER TABLE finance.trip_pay_lines FORCE ROW LEVEL SECURITY');
  await knex.raw('DROP POLICY IF EXISTS tenant_isolation ON finance.trip_pay_lines');
  await knex.raw(`CREATE POLICY tenant_isolation ON finance.trip_pay_lines
    USING (tenant_id = public.current_tenant_id()) WITH CHECK (tenant_id = public.current_tenant_id())`);
  // Sin DELETE: un renglón pagado nunca se borra; si su vale se rechaza deja de estar vigente.
  await knex.raw('GRANT SELECT, INSERT, UPDATE ON finance.trip_pay_lines TO app_runtime');
  await knex.raw(`COMMENT ON TABLE finance.trip_pay_lines IS
    'EMB.29 — Qué viaje o carga paga cada vale de Gastos, por persona y concepto (075 comisión, 128 viático, 186 maniobra). El índice único parcial ux_trip_pay_lines_una_vez impide pagar dos veces lo mismo. Si el vale se rechaza, el renglón deja de estar vigente al armar el siguiente vale.'`);

  // 1, 3, 4, 5. Las vistas.
  await dropVistas(knex);
  for (const [nombre, sql] of [
    ['analytics.erp_shipment_stop_closure', V_STOP_CLOSURE],
    ['logistics.v_trip_stop_closure', V_TRIP_STOP],
    ['logistics.v_trip_state', V_TRIP_STATE],
    ['logistics.v_trip_pay_items', V_PAY_ITEMS],
  ]) {
    await knex.raw(sql);
    await grantLectura(knex, nombre);
    await knex.raw(`COMMENT ON VIEW ${nombre} IS '${COMENTARIOS[nombre].replace(/'/g, "''")}'`);
  }
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await dropVistas(knex);
  await knex.raw('DROP TABLE IF EXISTS finance.trip_pay_lines');
};
