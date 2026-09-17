/**
 * EMB.0.1 — CORRECCIÓN: el código literal MANDA; el normalizado es sólo el respaldo.
 *
 * ── EL DEFECTO QUE ESTA MIGRACIÓN ARREGLA ────────────────────────────────────────────────
 * `20260917120000` resolvía la unidad y el chofer **siempre** por la clave normalizada (sin
 * ceros a la izquierda), porque así pasaba de resolver el 27% al 100%. Lo que no vi: cuando
 * el documento escribe un código que existe LITERAL en el catálogo, normalizarlo puede
 * llevarlo a OTRA fila. El espacio de claves cortas de Kepler es local a la sucursal y está
 * reusado:
 *
 *     suc 00..07  `00009` → MARIA CANDELARIA SALGADO MORALES
 *     suc 01      `09`    → "MARIA CANDELARIA  SALGADO"   (la misma, alta duplicada)
 *     suc 05      `09`    → **BENJAMIN ALONZO ZARAGOZA**  (OTRA persona)
 *
 * Con la regla vieja, un embarque de la suc 05 con `c84='09'` se le atribuía a María.
 * **Medido en prod: 582 de 3,870 embarques con chofer (15%) quedaban con el nombre
 * equivocado.** El transporte no estaba afectado (0 casos: las dos variantes de una unidad
 * apuntan a la misma placa), pero se le aplica la misma regla porque la garantía no puede
 * depender de que hoy los datos sean amables.
 *
 * ── LA REGLA NUEVA, y por qué en este orden ──────────────────────────────────────────────
 *   1. **exacto** — el código tal cual lo escribió Kepler existe en el catálogo de ESA
 *      sucursal. Es el testigo más fuerte que hay: es literalmente lo que el ERP guardó.
 *   2. **normalizado** — sólo si el literal no existe (el documento escribe `010` donde el
 *      catálogo tiene `00010`). Cubre el 73% que motivó la normalización, sin pisar al 1.
 *   3. **NULL con motivo** — si ninguno resuelve. Nunca un nombre inventado.
 *
 * El método queda EXPUESTO en `transporte_metodo` / `chofer_metodo`, no escondido: un
 * consumidor tiene que poder saber con qué se resolvió el nombre que está mostrando, y una
 * caída del método de `exacto` a `normalizado` es justo la señal de que algo cambió en el
 * catálogo (ADR-056/057: el testigo se ordena y se declara, no se elige en silencio).
 *
 * Se recrean las dos vistas en orden de dependencia (trips lee de headers). Los resolvedores
 * `v_kepler_*` NO cambian: siguen siendo el respaldo normalizado y el que enumera el catálogo.
 *
 * @param { import("knex").Knex } knex
 */

const M = '00000000-0000-0000-0000-00000000d01c';
const money = (col) => `round(coalesce(nullif(regexp_replace(${col}::text,'[^0-9.-]','','g'),'')::numeric,0),2)`;
const key = (col) => `NULLIF(ltrim(btrim(${col}::text),'0'),'')`;
const txt = (col) => `NULLIF(btrim(${col}::text),'')`;

const V_HEADERS = `
  CREATE VIEW analytics.erp_shipment_headers AS
  WITH emb AS (
    SELECT DISTINCT ON (btrim(h.c1), (h.c5)::int, btrim(h.c6::text))
      btrim(h.c1)            AS sucursal,
      (h.c5)::int            AS serie,
      btrim(h.c6::text)      AS folio,
      h.c9::date             AS fecha,
      ${txt('h.c10')}        AS cliente_code,
      ${txt('h.c32')}        AS destino_nombre,
      ${txt('h.c33')}        AS destino_colonia,
      ${txt('h.c34')}        AS destino_ciudad,
      ${txt('h.c35')}        AS destino_estado,
      ${txt('h.c22')}        AS rfc,
      ${txt('h.c11')}        AS estatus,
      ${txt('h.c12')}        AS vendedor_code,
      ${txt('h.c24')}        AS comentarios,
      ${txt('h.c27')}        AS canal,
      (h.c37)::int           AS padre_tipo,
      ${txt('h.c39')}        AS pedido_folio,
      ${key('h.c83')}        AS transporte_key,
      ${key('h.c84')}        AS chofer_key,
      ${txt('h.c83')}        AS transporte_code,
      ${txt('h.c84')}        AS chofer_code,
      NULLIF(${txt('h.c86')}, '0000000')      AS guia_embarque,
      ${txt('h.c80')}        AS resp_surtido,
      ${txt('h.c81')}        AS resp_checado,
      ${txt('h.c82')}        AS resp_embarque,
      h.c18::date            AS fecha_pago_cruda,
      ${money('h.c13')}      AS descuento,
      ${money('h.c15')}      AS ieps,
      ${money('h.c16')}      AS total
    FROM kepler_ods.kdm1 h
    WHERE h.c2='U' AND h.c3='D' AND (h.c4)::int=41 AND btrim(h.c1)=btrim(h.sucursal)
    ORDER BY btrim(h.c1), (h.c5)::int, btrim(h.c6::text), h.c9
  ),
  doc AS (
    SELECT DISTINCT ON (btrim(m.sucursal), (m.c4)::int)
      btrim(m.sucursal) AS sucursal, (m.c4)::int AS serie, ${txt('m.c5')} AS etiqueta
    FROM kepler_ods.kdmm m
    WHERE m.c1::text='U' AND m.c2::text='D' AND m.c3::text='41'
    ORDER BY btrim(m.sucursal), (m.c4)::int
  ),
  vend AS (
    SELECT DISTINCT ON (btrim(u.sucursal), btrim(u.c2::text))
      btrim(u.sucursal) AS sucursal, btrim(u.c2::text) AS code, ${txt('u.c3')} AS nombre
    FROM kepler_ods.kduv u
    ORDER BY btrim(u.sucursal), btrim(u.c2::text)
  ),
  -- Catálogos por el código LITERAL de esa sucursal (el testigo fuerte).
  tx AS (
    SELECT DISTINCT ON (btrim(sucursal), btrim(c1))
      btrim(sucursal) AS sucursal, btrim(c1) AS codigo,
      ${txt('c2')} AS descripcion, ${txt('c3')} AS placas, ${key('c4')} AS chofer_asignado
    FROM kepler_ods.kdm_transporte WHERE btrim(coalesce(c1,'')) <> ''
    ORDER BY btrim(sucursal), btrim(c1)
  ),
  cx AS (
    SELECT DISTINCT ON (btrim(sucursal), btrim(c1))
      btrim(sucursal) AS sucursal, btrim(c1) AS codigo, ${txt('c2')} AS nombre
    FROM kepler_ods.kdm_chofer WHERE btrim(coalesce(c1,'')) <> ''
    ORDER BY btrim(sucursal), btrim(c1)
  )
  SELECT
    '${M}'::uuid                              AS tenant_id,
    e.sucursal,
    e.serie,
    COALESCE(d.etiqueta, 'Embarque serie '||e.serie) AS serie_label,
    e.folio,
    e.sucursal||'UD41'||lpad(e.serie::text,2,'0')||'-'||e.folio AS folio_digital,
    e.fecha,
    e.estatus,
    e.cliente_code, e.destino_nombre, e.destino_colonia, e.destino_ciudad, e.destino_estado,
    e.rfc, e.canal,
    -- Unidad: exacto > normalizado > NULL.
    e.transporte_code,
    COALESCE(tex.codigo, t.clave_kepler)      AS transporte_clave_kepler,
    COALESCE(tex.descripcion, t.descripcion)  AS transporte_descripcion,
    COALESCE(tex.placas, t.placas)            AS transporte_placas,
    -- Chofer: misma precedencia. Es la que corrige los 582 embarques mal atribuidos.
    e.chofer_code,
    COALESCE(cex.codigo, c.clave_kepler)      AS chofer_clave_kepler,
    COALESCE(cex.nombre, c.nombre)            AS chofer_nombre,
    cax.nombre                                AS chofer_asignado_a_la_unidad,
    e.guia_embarque,
    e.resp_surtido, e.resp_checado, e.resp_embarque,
    e.vendedor_code, v.nombre AS vendedor_nombre,
    e.pedido_folio,
    CASE WHEN e.padre_tipo = 40
         THEN e.sucursal||'UD40'||lpad(e.serie::text,2,'0')||'-'||e.pedido_folio END AS pedido_folio_digital,
    e.comentarios,
    e.descuento, e.ieps, e.total,
    e.fecha_pago_cruda                        AS fecha_pago_pactada,
    (e.fecha_pago_cruda IS NOT NULL AND e.fecha_pago_cruda >= e.fecha) AS fecha_pago_valida,
    NULL::text                                AS ruta_declarada,
    (COALESCE(tex.codigo, t.clave) IS NOT NULL) AS transporte_resuelto,
    COALESCE(t.ambiguo, false)                AS transporte_ambiguo,
    (COALESCE(cex.codigo, c.clave) IS NOT NULL) AS chofer_resuelto,
    COALESCE(c.ambiguo, false)                AS chofer_ambiguo,
    (e.chofer_code IS NULL)                   AS chofer_sin_capturar,
    -- CON QUÉ se resolvió cada uno. Un consumidor tiene derecho a saberlo.
    CASE WHEN e.transporte_code IS NULL THEN NULL
         WHEN tex.codigo IS NOT NULL THEN 'exacto'
         WHEN t.clave    IS NOT NULL THEN 'normalizado'
         ELSE 'sin_resolver' END              AS transporte_metodo,
    CASE WHEN e.chofer_code IS NULL THEN NULL
         WHEN cex.codigo IS NOT NULL THEN 'exacto'
         WHEN c.clave    IS NOT NULL THEN 'normalizado'
         ELSE 'sin_resolver' END              AS chofer_metodo,
    now()                                     AS computed_at
  FROM emb e
  LEFT JOIN doc  d  ON d.sucursal = e.sucursal AND d.serie = e.serie
  LEFT JOIN vend v  ON v.sucursal = e.sucursal AND v.code  = e.vendedor_code
  LEFT JOIN tx  tex ON tex.sucursal = e.sucursal AND tex.codigo = e.transporte_code
  LEFT JOIN cx  cex ON cex.sucursal = e.sucursal AND cex.codigo = e.chofer_code
  LEFT JOIN analytics.v_kepler_transporte t ON t.sucursal = e.sucursal AND t.clave = e.transporte_key
  LEFT JOIN analytics.v_kepler_chofer     c ON c.sucursal = e.sucursal AND c.clave = e.chofer_key
  LEFT JOIN analytics.v_kepler_chofer   cax ON cax.sucursal = e.sucursal
                                           AND cax.clave = COALESCE(tex.chofer_asignado, t.chofer_asignado)
`;

const V_TRIPS = `
  CREATE VIEW analytics.erp_shipment_trips AS
  SELECT
    '${M}'::uuid                                   AS tenant_id,
    h.sucursal,
    h.guia_embarque,
    h.sucursal||'-G'||h.guia_embarque              AS guia_digital,
    min(h.fecha)                                   AS fecha,
    count(*)::int                                  AS paradas,
    count(DISTINCT h.cliente_code)::int            AS destinos,
    count(DISTINCT h.serie)::int                   AS series,
    min(h.transporte_code)                         AS transporte_code,
    min(h.transporte_descripcion)                  AS transporte_descripcion,
    min(h.transporte_placas)                       AS transporte_placas,
    min(h.chofer_code)                             AS chofer_code,
    min(h.chofer_nombre)                           AS chofer_nombre,
    (count(DISTINCT h.transporte_code) > 1)        AS multi_transporte,
    (count(DISTINCT h.chofer_code)     > 1)        AS multi_chofer,
    (count(DISTINCT h.fecha)           > 1)        AS multi_fecha,
    sum(h.total)                                   AS total,
    min(h.fecha)                                   AS fecha_min,
    max(h.fecha)                                   AS fecha_max,
    now()                                          AS computed_at
  FROM analytics.erp_shipment_headers h
  WHERE h.guia_embarque IS NOT NULL
  GROUP BY h.sucursal, h.guia_embarque
`;

const COMENTARIOS = {
  'analytics.erp_shipment_headers':
    'EMB.0 — Cabecera logística del embarque Kepler U-D-41 EN VIVO (derive-no-copy sobre kepler_ods.kdm1). Trae transporte (c83), chofer (c84), guía de embarque (c86) y responsables surtido/checado/embarque (c80/c81/c82), más destino, vendedor y pedido padre. Grano = la PARADA; el viaje es analytics.erp_shipment_trips. EMB.0.1: la unidad y el chofer se resuelven por código EXACTO y sólo si no existe se cae al normalizado — ver transporte_metodo/chofer_metodo (el normalizado ciego atribuía mal 582 embarques). NO es cartera: la deuda la manda kdue (erp_shipment_billing).',
  'analytics.erp_shipment_trips':
    'EMB.0 — El VIAJE: agrupa las paradas por guía de embarque (kdm1.c86). Medido 2026: ~2,500 guías para ~5,700 embarques, hasta 32 paradas por guía, y 386/388 de las multiparada con una sola unidad. Éste es el grano que corresponde a logistics.shipments, no el documento suelto.',
};

exports.up = async function up(knex) {
  // Orden de dependencia: trips lee de headers.
  await knex.raw('DROP VIEW IF EXISTS analytics.erp_shipment_trips');
  await knex.raw('DROP VIEW IF EXISTS analytics.erp_shipment_headers');
  for (const [nombre, sql] of [['analytics.erp_shipment_headers', V_HEADERS], ['analytics.erp_shipment_trips', V_TRIPS]]) {
    await knex.raw(sql);
    await knex.raw(`GRANT SELECT ON ${nombre} TO app_runtime`);
    await knex.raw(`COMMENT ON VIEW ${nombre} IS '${COMENTARIOS[nombre].replace(/'/g, "''")}'`);
  }
};

exports.down = async function down(knex) {
  // Volver atrás = re-correr la versión anterior de las vistas (mig 20260917120000).
  await knex.raw('DROP VIEW IF EXISTS analytics.erp_shipment_trips');
  await knex.raw('DROP VIEW IF EXISTS analytics.erp_shipment_headers');
  const previa = require('./20260917120000_analytics_erp_shipment_headers.js');
  await previa.up(knex);
};
