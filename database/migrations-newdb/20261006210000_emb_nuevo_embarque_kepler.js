/**
 * EMB.12 — «Nuevo embarque» deja de capturar lo que Kepler ya capturó.
 *
 * ── EL PROBLEMA ──────────────────────────────────────────────────────────────────────────
 * El formulario de «Nuevo embarque» pedía a mano fecha, unidad, ruta, origen, destino, cajas,
 * valor y chofer. **Todo eso ya lo registra almacén en Kepler** cuando da la «Salida por
 * Embarque» (documento U-D-41, ver `ERP_KEPLER.md` §3.y): la guía (`kdm1.c86`) es el viaje,
 * cada U-D-41 dentro de ella es una parada. Capturarlo dos veces sólo produce un segundo número
 * que no cuadra con el primero.
 *
 * Esta migración agrega lo que faltaba para TOMAR el viaje de Kepler en vez de recapturarlo.
 * Las tres vistas son derive-no-copy sobre `kepler_ods` (regla principal: cero importers):
 *
 *   1. `analytics.erp_shipment_stops` — la PARADA con lo que la cabecera no traía:
 *      · la RUTA. El embarque no la referencia (EMB.0 sondeó las 200 columnas de kdm1), pero
 *        el DOMICILIO DE ENTREGA sí: (cliente `c10`, domicilio `c85`) → `kdudent.c13` →
 *        `kdm_rutas`. Medido 2026-10-05 en Padre Hidalgo y Canindo: resuelve el **100%** de
 *        los embarques de 60 días (892+741 y 715+353), y sólo 4 de 715 contradicen el catálogo
 *        de rutas por cliente `kdm_rutas2`. ⚠️ `c85` vacío se trata como domicilio `1` y se
 *        DECLARA (`domicilio_supuesto`), no se esconde.
 *      · el ORDEN de visita (`kdm_rutas2.c4`, una clave de orden: hay `9.50` entre `9` y `10`).
 *      · facturación (`c43`: F = 879/879 con factura hija), hora de captura (`c69`, NO es hora
 *        de salida) y la nota de almacén (`c24`/`c25`: «CJ 13 PQ 1 UB 3», UB = andén).
 *   2. `analytics.erp_shipment_stop_load` — qué carga lleva la parada, sacado de los renglones:
 *      `kdm2.c54` es la cantidad en la UNIDAD DE MANEJO del almacén (`c55` = CJA/BTO/PAQ/KG…,
 *      `c58` = piezas por empaque); `c9 = c54 × c58` en el 100% de los renglones medidos. Cajas =
 *      `c54` en CJA/BTO; sueltos = el resto. Coincide con la nota manual «CJ n» en el 77%
 *      (327/424) — la diferencia es justo la razón de no tomar la nota como fuente.
 *      ⛔ Kilos sólo de renglones vendidos por KG: el catálogo de Kepler NO trae peso por
 *      producto, así que el peso total del viaje NO existe y no se rellena con cero.
 *   3. `analytics.v_kepler_responsables` — surtidor / checador / embarcador (`kdm1.c80/c81/c82`)
 *      contra `kdm_cat_sur/che/emb`. EMB.0 declaró que esos catálogos no estaban en el ODS; hoy
 *      sí están. La resolución exacto → normalizado → NULL la hace el servicio (la misma regla
 *      de EMB.0.1: `'1'` y `'01'` son personas distintas en el catálogo de checadores).
 *
 * Y en `logistics.shipments`:
 *   · `kepler_sucursal` + `kepler_guia` — la LLAVE del viaje de Kepler. El embarque de la Suite
 *     guarda la llave y lo que Kepler no tiene (ayudantes, comisiones, viáticos, flete, km);
 *     unidad, paradas, cajas y valor se siguen leyendo en vivo de las vistas.
 *   · índice único parcial: una guía no se puede tomar dos veces (sí de nuevo si se canceló).
 *   · `delivery_type` (por ruta / viaje largo): el formulario viejo lo pedía y lo TIRABA — no
 *     existía la columna.
 *
 * Los índices por expresión de `kepler_ods` (`ix_kdm1_venta_doc`, `ix_kdm2_venta_doc`:
 * `btrim(sucursal), c4::int, c5::int, btrim(c6)`) son los que hacen barata la consulta por
 * parada; por eso las vistas exponen EXACTAMENTE esas expresiones y no usan DISTINCT ON (que
 * impediría empujar el filtro hacia adentro).
 *
 * Idempotente: `DROP VIEW IF EXISTS` + `CREATE VIEW` (nada depende todavía de estas vistas, y
 * `CREATE OR REPLACE` no deja cambiar columnas), `hasColumn`, `IF NOT EXISTS`.
 *
 * @param { import("knex").Knex } knex
 */

const M = '00000000-0000-0000-0000-00000000d01c';
const txt = (col) => `NULLIF(btrim(${col}::text),'')`;
const num = (col) => `NULLIF(regexp_replace(${col}::text,'[^0-9.-]','','g'),'')::numeric`;

const V_STOPS = `
  CREATE VIEW analytics.erp_shipment_stops AS
  WITH emb AS (
    SELECT
      btrim(h.sucursal)                    AS sucursal,
      (h.c5)::int                          AS serie,
      btrim(h.c6)                          AS folio,
      NULLIF(btrim(h.c86),'0000000')       AS guia_embarque,
      (h.c9)::date                         AS fecha,
      ${txt('h.c10')}                      AS cliente_code,
      ${txt('h.c32')}                      AS destino_nombre,
      ${txt('h.c33')}                      AS destino_colonia,
      ${txt('h.c34')}                      AS destino_ciudad,
      ${txt('h.c35')}                      AS destino_estado,
      COALESCE(${txt('h.c85')}, '1')       AS domicilio,
      (${txt('h.c85')} IS NULL)            AS domicilio_supuesto,
      ${txt('h.c43')}                      AS facturacion,
      ${txt('h.c69')}                      AS hora_captura,
      ${txt('h.c67')}                      AS usuario_captura,
      NULLIF(concat_ws(' ', ${txt('h.c24')}, ${txt('h.c25')}, ${txt('h.c26')}), '') AS nota_almacen
    FROM kepler_ods.kdm1 h
    WHERE h.c2 = 'U' AND h.c3 = 'D' AND (h.c4)::int = 41
      AND btrim(h.c1) = btrim(h.sucursal)
  ),
  dom AS (
    SELECT DISTINCT ON (btrim(sucursal), btrim(c1), btrim(c2))
      btrim(sucursal) AS sucursal, btrim(c1) AS cliente, btrim(c2) AS domicilio,
      ${txt('c3')} AS calle, ${txt('c5')} AS ciudad, ${txt('c6')} AS telefono,
      ${txt('c13')} AS ruta_clave
    FROM kepler_ods.kdudent
    WHERE btrim(coalesce(c1,'')) <> ''
    ORDER BY btrim(sucursal), btrim(c1), btrim(c2)
  ),
  ruta AS (
    SELECT DISTINCT ON (btrim(sucursal), btrim(c1))
      btrim(sucursal) AS sucursal, btrim(c1) AS clave, ${txt('c2')} AS nombre
    FROM kepler_ods.kdm_rutas
    WHERE btrim(coalesce(c1,'')) <> ''
    ORDER BY btrim(sucursal), btrim(c1)
  ),
  orden AS (
    SELECT btrim(sucursal) AS sucursal, btrim(c1) AS ruta, btrim(c2) AS cliente,
           COALESCE(${txt('c3')}, '1') AS domicilio, min(c4) AS orden
    FROM kepler_ods.kdm_rutas2
    WHERE btrim(coalesce(c2,'')) <> ''
    GROUP BY 1, 2, 3, 4
  )
  SELECT
    '${M}'::uuid                    AS tenant_id,
    e.sucursal, e.serie, e.folio, e.guia_embarque, e.fecha, e.cliente_code,
    e.destino_nombre, e.destino_colonia, e.destino_ciudad, e.destino_estado,
    e.domicilio, e.domicilio_supuesto,
    d.calle                          AS domicilio_calle,
    d.ciudad                         AS domicilio_ciudad,
    d.telefono                       AS domicilio_telefono,
    d.ruta_clave,
    r.nombre                         AS ruta_nombre,
    o.orden                          AS orden_visita,
    CASE WHEN e.cliente_code IS NULL THEN 'sin_cliente'
         WHEN d.cliente IS NULL      THEN 'sin_domicilio'
         WHEN d.ruta_clave IS NULL   THEN 'domicilio_sin_ruta'
         WHEN r.clave IS NULL        THEN 'ruta_fuera_de_catalogo'
         ELSE 'domicilio' END        AS ruta_metodo,
    e.facturacion,
    (e.facturacion IN ('F','R'))     AS facturado,
    e.hora_captura, e.usuario_captura, e.nota_almacen
  FROM emb e
  LEFT JOIN dom   d ON d.sucursal = e.sucursal AND d.cliente = e.cliente_code AND d.domicilio = e.domicilio
  LEFT JOIN ruta  r ON r.sucursal = e.sucursal AND r.clave = d.ruta_clave
  LEFT JOIN orden o ON o.sucursal = e.sucursal AND o.ruta = d.ruta_clave
                   AND o.cliente = e.cliente_code AND o.domicilio = e.domicilio
`;

const V_LOAD = `
  CREATE VIEW analytics.erp_shipment_stop_load AS
  SELECT
    '${M}'::uuid                                           AS tenant_id,
    btrim(l.sucursal)                                      AS sucursal,
    (l.c5)::int                                            AS serie,
    btrim(l.c6)                                            AS folio,
    count(*)::int                                          AS renglones,
    COALESCE(sum(${num('l.c54')}) FILTER (WHERE upper(btrim(l.c55)) IN ('CJA','BTO')), 0) AS cajas,
    COALESCE(sum(${num('l.c54')}) FILTER (WHERE ${txt('l.c55')} IS NOT NULL
                                             AND upper(btrim(l.c55)) NOT IN ('CJA','BTO')), 0) AS sueltos,
    -- NULL = la parada no lleva renglones por kilo. No es «cero kilos».
    sum(l.c9::numeric) FILTER (WHERE upper(btrim(l.c11)) = 'KG')                          AS kg,
    count(*) FILTER (WHERE upper(btrim(l.c11)) = 'KG')::int                                AS renglones_kg,
    -- Renglones sin unidad de manejo: no entran ni a cajas ni a sueltos, y se dicen.
    count(*) FILTER (WHERE ${txt('l.c55')} IS NULL OR ${num('l.c54')} IS NULL)::int        AS renglones_sin_empaque
  FROM kepler_ods.kdm2 l
  WHERE l.c2 = 'U' AND l.c3 = 'D' AND (l.c4)::int = 41
    AND btrim(l.c1) = btrim(l.sucursal)
  GROUP BY btrim(l.sucursal), (l.c5)::int, btrim(l.c6)
`;

const V_RESP = `
  CREATE VIEW analytics.v_kepler_responsables AS
  SELECT btrim(sucursal) AS sucursal, 'surtido'::text AS rol, btrim(c1) AS codigo,
         NULLIF(ltrim(btrim(c1),'0'),'') AS clave, ${txt('c2')} AS nombre
    FROM kepler_ods.kdm_cat_sur WHERE btrim(coalesce(c1,'')) <> ''
  UNION ALL
  SELECT btrim(sucursal), 'checado', btrim(c1), NULLIF(ltrim(btrim(c1),'0'),''), ${txt('c2')}
    FROM kepler_ods.kdm_cat_che WHERE btrim(coalesce(c1,'')) <> ''
  UNION ALL
  SELECT btrim(sucursal), 'embarque', btrim(c1), NULLIF(ltrim(btrim(c1),'0'),''), ${txt('c2')}
    FROM kepler_ods.kdm_cat_emb WHERE btrim(coalesce(c1,'')) <> ''
`;

const COMENTARIOS = {
  'analytics.erp_shipment_stops':
    'EMB.12 — La PARADA del embarque Kepler (U-D-41) con lo que la cabecera no trae: ruta por DOMICILIO DE ENTREGA (kdm1.c10+c85 → kdudent.c13 → kdm_rutas; 100% medido en suc 01 y 06), orden de visita (kdm_rutas2.c4), facturación (c43), hora de CAPTURA (c69, no es salida) y nota de almacén (c24-c26). c85 vacío = domicilio 1, declarado en domicilio_supuesto. Derive-no-copy sobre kepler_ods.',
  'analytics.erp_shipment_stop_load':
    'EMB.12 — Carga por parada desde los renglones (kdm2): cajas = c54 en unidad de manejo CJA/BTO (c55), sueltos = el resto; c9 = c54 × c58 en el 100% medido. kg sólo de renglones vendidos por KG (NULL si no hay): Kepler no tiene peso por producto, el peso total del viaje NO existe.',
  'analytics.v_kepler_responsables':
    'EMB.12 — Catálogos de surtidor / checador / embarcador (kdm_cat_sur/che/emb) para resolver kdm1.c80/c81/c82. La clave normalizada colisiona (checador 1 y 01 son personas distintas): resolver exacto → normalizado → NULL.',
};

async function grantLectura(knex, nombre) {
  await knex.raw(`GRANT SELECT ON ${nombre} TO app_runtime`);
  // dev_ro existe en prod (SEG.4) y no en todas las bases de desarrollo.
  await knex.raw(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dev_ro') THEN
      EXECUTE 'GRANT SELECT ON ${nombre} TO dev_ro';
    END IF; END $$`);
}

exports.up = async function up(knex) {
  for (const [nombre, sql] of [
    ['analytics.erp_shipment_stops', V_STOPS],
    ['analytics.erp_shipment_stop_load', V_LOAD],
    ['analytics.v_kepler_responsables', V_RESP],
  ]) {
    await knex.raw(`DROP VIEW IF EXISTS ${nombre}`);
    await knex.raw(sql);
    await grantLectura(knex, nombre);
    await knex.raw(`COMMENT ON VIEW ${nombre} IS '${COMENTARIOS[nombre].replace(/'/g, "''")}'`);
  }

  const add = async (col, ddl) => {
    if (!(await knex.schema.withSchema('logistics').hasColumn('shipments', col))) {
      await knex.raw(`ALTER TABLE logistics.shipments ADD COLUMN ${ddl}`);
    }
  };
  await add('kepler_sucursal', 'kepler_sucursal VARCHAR(10)');
  await add('kepler_guia', 'kepler_guia VARCHAR(20)');
  await add('delivery_type', 'delivery_type VARCHAR(20)');

  await knex.raw(`ALTER TABLE logistics.shipments DROP CONSTRAINT IF EXISTS logistics_shipments_kepler_par_check`);
  await knex.raw(`
    ALTER TABLE logistics.shipments ADD CONSTRAINT logistics_shipments_kepler_par_check
      CHECK ((kepler_sucursal IS NULL) = (kepler_guia IS NULL))`);
  await knex.raw(`ALTER TABLE logistics.shipments DROP CONSTRAINT IF EXISTS logistics_shipments_delivery_type_check`);
  await knex.raw(`
    ALTER TABLE logistics.shipments ADD CONSTRAINT logistics_shipments_delivery_type_check
      CHECK (delivery_type IS NULL OR delivery_type IN ('route','long_trip'))`);
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_logistics_shipments_kepler_guia
      ON logistics.shipments (tenant_id, kepler_sucursal, kepler_guia)
      WHERE kepler_guia IS NOT NULL AND deleted_at IS NULL AND status <> 'cancelado'`);

  await knex.raw(`COMMENT ON COLUMN logistics.shipments.kepler_guia IS
    'EMB.12 — Guía de embarque de Kepler (kdm1.c86) que este embarque TOMÓ. Con kepler_sucursal es la llave del viaje: unidad, paradas, cajas y valor se leen en vivo de analytics.erp_shipment_*; aquí sólo se guarda lo que Kepler no tiene. Una guía activa no se toma dos veces (ux_logistics_shipments_kepler_guia).'`);
  await knex.raw(`COMMENT ON COLUMN logistics.shipments.delivery_type IS
    'EMB.12 — route | long_trip. El formulario viejo lo pedía pero no se guardaba en ningún lado.'`);
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS logistics.ux_logistics_shipments_kepler_guia');
  await knex.raw('ALTER TABLE logistics.shipments DROP CONSTRAINT IF EXISTS logistics_shipments_delivery_type_check');
  await knex.raw('ALTER TABLE logistics.shipments DROP CONSTRAINT IF EXISTS logistics_shipments_kepler_par_check');
  for (const col of ['delivery_type', 'kepler_guia', 'kepler_sucursal']) {
    await knex.raw(`ALTER TABLE logistics.shipments DROP COLUMN IF EXISTS ${col}`);
  }
  await knex.raw('DROP VIEW IF EXISTS analytics.v_kepler_responsables');
  await knex.raw('DROP VIEW IF EXISTS analytics.erp_shipment_stop_load');
  await knex.raw('DROP VIEW IF EXISTS analytics.erp_shipment_stops');
};
