/**
 * EMB.0 — La CABECERA LOGÍSTICA del embarque de Kepler (U-D-41), DERIVE-NO-COPY.
 *
 * Qué resuelve: hoy el embarque llega a la Suite por tres puertas y ninguna trae lo
 * logístico. `analytics.stock_movements` trae el detalle de artículos (Fase DM),
 * `analytics.erp_shipment_billing` trae el dinero (Fase CxC) y `analytics.erp_shipments`
 * trae el surtido por SKU (`kdpord`). **Unidad, chofer, guía de embarque y responsables no
 * estaban en ninguna** — verificado columna por columna contra prod el 2026-09-17.
 *
 * Son VISTAS, no tablas: `kdm1`, `kdm_transporte`, `kdm_chofer`, `kdmm` y `kduv` ya se
 * replican solas al ODS (carriles CTID + hash de `replicate-ods-live`), así que la frescura
 * es la del CDC (~segundos) y no hay nada que re-correr ni agendar. Un importer aquí sería
 * justo lo que la regla principal del proyecto prohíbe.
 *
 * ── DECODE, cerrado contra un HECHO INDEPENDIENTE ────────────────────────────────────────
 * No se dedujo por estadística: se tomó una captura de la pantalla "Salida por Embarque" de
 * Kepler (UD4101-0000713, Sucursal Canindo) y se buscó la fila. Es suc **06**, serie 1,
 * folio 0000713, 15-sep-2026 — y cuadra campo por campo:
 *   c5=serie · c6=folio · c9=fecha · c10=cliente · c11=estatus · c12=VENDEDOR (→ kduv.c2)
 *   c13=descuento · c15=IEPS · c16=IMPORTE total · c18=FECHA DE PAGO · c19=descuento cliente
 *   c22=RFC · c24=comentarios · c32..c35=nombre y domicilio del destino
 *   c37/c38/c39=documento padre (40 = pedido U-D-40)
 *   **c80=resp. surtido · c81=resp. checado · c82=resp. embarque**
 *   **c83=TRANSPORTE ASIGNADO · c84=CHOFER · c86=GUÍA DE EMBARQUE**
 * La estadística sola NO alcanzaba y habría elegido mal: los códigos de unidad y de chofer
 * comparten el espacio `000NN` — en la captura el `00017` es a la vez la unidad FORD 450
 * placas NC-1134-D y el chofer CESAR CASAS MENDOZA.
 *
 * ── CUATRO TRAMPAS MEDIDAS, cada una desarmada acá ───────────────────────────────────────
 * 1. **El relleno de ceros NO coincide entre documento y catálogo.** `kdm1.c83` escribe 3
 *    dígitos (3,092 filas), 5 (1,346), 4 (501) y 2 (3); `kdm_transporte.c1` usa 5 (208 de
 *    211). Con igualdad literal resolvía **1,347 de 4,942 (27%)**; normalizando los ceros a
 *    la izquierda resuelve **4,942/4,942 y 3,090/3,090 choferes**.
 * 2. **…pero normalizar COLISIONA.** La misma unidad está dada de alta dos veces (`00018` y
 *    `018`, ambas SUBURBAN P6X-164-D): 3 colisiones de transporte y 58 de chofer. Un LEFT
 *    JOIN crudo DUPLICARÍA embarques. Por eso los catálogos pasan por un resolvedor con
 *    `DISTINCT ON` que garantiza 1 fila por (sucursal, clave normalizada) prefiriendo la
 *    forma canónica de 5 dígitos, y marca `ambiguo` cuando las variantes NO describen lo
 *    mismo — hay una real: suc 00 chofer 3 = "JOSE ANTONIO MENDEZ **VILLA**" (00003) contra
 *    "JOSE ANTONIO MENDEZ **CAMARENA**" (03). Eso se declara, no se elige en silencio.
 * 3. **`kdm1` NO trae ruta.** Se sondearon las 200+ columnas contra `kdm_rutas` (clave y
 *    nombre): el único "match" masivo era una fila VACÍA del catálogo de la suc 01, que
 *    empareja con toda columna vacía — falso positivo. El otro, `c34`, es el MUNICIPIO del
 *    destino, que coincide con nombres de ruta porque las rutas se llaman como los pueblos
 *    (ZIROSTO, PENJAMO…). El embarque no referencia una ruta: `ruta_declarada` va NULL.
 * 4. **`c18` (fecha de pago) se contradice en el 10.9%**: 538 de 4,942 son ANTERIORES al
 *    propio embarque (mismo síntoma que la Fase AX documentó para U-D-8). Se publica el
 *    valor crudo MÁS la bandera `fecha_pago_valida`; no se nulifica en silencio ni se
 *    presenta como vencimiento. ⛔ Y NO es cuenta por cobrar: la deuda la manda `kdue`
 *    (ver `analytics.erp_shipment_billing`); sumar esto sería doble conteo.
 *
 * ── LA GUÍA ES EL VIAJE, EL EMBARQUE ES LA PARADA ────────────────────────────────────────
 * Medido en 2026: **2,096 guías (`c86`) agrupan 4,941 embarques**, 2.8–3.7 paradas por guía
 * en las sucursales 01/02/06 y hasta 32. De las 388 guías multiparada, **386 llevan un solo
 * transporte, 388/388 un solo chofer y 384 una sola fecha**. Por eso hay DOS vistas:
 * `erp_shipment_headers` (la parada) y `erp_shipment_trips` (el viaje). Mapear 1 embarque =
 * 1 `logistics.shipments` inventaría 4,941 viajes donde hubo 2,096.
 *
 * DEDUPE: `kdm1` arrastra la réplica de cada rama en las demás → `btrim(c1)=btrim(sucursal)`
 * deja sólo la copia propia (mismo filtro que `erp_shipment_billing` y los feeds per-branch).
 *
 * Sin RLS (analytics.* filtra tenant_id explícito). Aditiva, idempotente, reversible.
 *
 * @param { import("knex").Knex } knex
 */

const M = '00000000-0000-0000-0000-00000000d01c';

// Money defensivo: kepler_ods conserva el tipo del origen y hay columnas sucias.
const money = (col) => `round(coalesce(nullif(regexp_replace(${col}::text,'[^0-9.-]','','g'),'')::numeric,0),2)`;
// Clave de catálogo normalizada: Kepler escribe el MISMO código con distinto relleno de
// ceros en el documento y en el catálogo. '000' → NULL (es "sin dato", no el código cero).
const key = (col) => `NULLIF(ltrim(btrim(${col}::text),'0'),'')`;
// Texto o NULL — nunca cadena vacía disfrazada de valor.
const txt = (col) => `NULLIF(btrim(${col}::text),'')`;

// ─────────────────────────────────────────────────────────────────────────────────────────
// Resolvedores de catálogo. Viven aparte a propósito: los va a necesitar cualquier otro
// documento de Kepler que cite una unidad o un chofer, y repetir el DISTINCT ON inline es
// como se reintroducen las colisiones (ADR-056: el primitivo se comparte o se declara).
// ─────────────────────────────────────────────────────────────────────────────────────────
// ⚠️ `count(DISTINCT …) OVER ()` NO existe en Postgres ("DISTINCT no está implementado para
// funciones de ventana deslizante"). Por eso el conteo de variantes va en un agregado aparte
// y se une a la fila elegida, en vez de resolverse con una ventana.
const V_TRANSPORTE = `
  CREATE OR REPLACE VIEW analytics.v_kepler_transporte AS
  WITH agg AS (
    SELECT btrim(t.sucursal) AS sucursal, ${key('t.c1')} AS clave,
           count(*)::int AS variantes,
           count(DISTINCT upper(btrim(coalesce(t.c2,''))))::int AS descripciones
    FROM kepler_ods.kdm_transporte t
    WHERE ${key('t.c1')} IS NOT NULL
    GROUP BY 1,2
  ), elegida AS (
    SELECT DISTINCT ON (btrim(t.sucursal), ${key('t.c1')})
      btrim(t.sucursal)  AS sucursal,
      ${key('t.c1')}     AS clave,          -- clave normalizada (la de cruce)
      btrim(t.c1)        AS clave_kepler,   -- la forma canónica elegida
      ${txt('t.c2')}     AS descripcion,
      ${txt('t.c3')}     AS placas,
      ${key('t.c4')}     AS chofer_asignado
    FROM kepler_ods.kdm_transporte t
    WHERE ${key('t.c1')} IS NOT NULL
    -- La forma LARGA gana: 208 de 211 filas del catálogo usan 5 dígitos.
    ORDER BY btrim(t.sucursal), ${key('t.c1')}, length(btrim(t.c1)) DESC, btrim(t.c1)
  )
  SELECT e.*, a.variantes, (a.descripciones > 1) AS ambiguo
  FROM elegida e JOIN agg a ON a.sucursal = e.sucursal AND a.clave = e.clave
`;

const V_CHOFER = `
  CREATE OR REPLACE VIEW analytics.v_kepler_chofer AS
  WITH agg AS (
    SELECT btrim(h.sucursal) AS sucursal, ${key('h.c1')} AS clave,
           count(*)::int AS variantes,
           count(DISTINCT upper(btrim(coalesce(h.c2,''))))::int AS nombres
    FROM kepler_ods.kdm_chofer h
    WHERE ${key('h.c1')} IS NOT NULL
    GROUP BY 1,2
  ), elegida AS (
    SELECT DISTINCT ON (btrim(h.sucursal), ${key('h.c1')})
      btrim(h.sucursal) AS sucursal,
      ${key('h.c1')}    AS clave,
      btrim(h.c1)       AS clave_kepler,
      ${txt('h.c2')}    AS nombre
    FROM kepler_ods.kdm_chofer h
    WHERE ${key('h.c1')} IS NOT NULL
    ORDER BY btrim(h.sucursal), ${key('h.c1')}, length(btrim(h.c1)) DESC, btrim(h.c1)
  )
  SELECT e.*, a.variantes, (a.nombres > 1) AS ambiguo
  FROM elegida e JOIN agg a ON a.sucursal = e.sucursal AND a.clave = e.clave
`;

// ─────────────────────────────────────────────────────────────────────────────────────────
// La PARADA: un documento U-D-41 = una entrega a un destino.
// ─────────────────────────────────────────────────────────────────────────────────────────
const V_HEADERS = `
  CREATE OR REPLACE VIEW analytics.erp_shipment_headers AS
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
  -- La etiqueta de la serie sale del CATÁLOGO de documentos, no de un CASE quemado acá:
  -- si Kepler la renombra, la vista lo sigue. kdmm también está replicado por rama.
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
    -- Destino
    e.cliente_code, e.destino_nombre, e.destino_colonia, e.destino_ciudad, e.destino_estado,
    e.rfc, e.canal,
    -- Unidad y chofer, ya resueltos contra el catálogo
    e.transporte_code, t.clave_kepler AS transporte_clave_kepler,
    t.descripcion AS transporte_descripcion, t.placas AS transporte_placas,
    e.chofer_code, c.clave_kepler AS chofer_clave_kepler, c.nombre AS chofer_nombre,
    -- El chofer que el catálogo asigna a esa unidad: sirve para cubrir el hueco de c84,
    -- pero se entrega APARTE porque es el asignado, no el que manejó ese día.
    ca.nombre AS chofer_asignado_a_la_unidad,
    -- Guía = el viaje. Ver analytics.erp_shipment_trips.
    e.guia_embarque,
    -- Responsables: quedan en CÓDIGO. Los catálogos de Surtidores/Checadores/Embarcadores
    -- que Kepler muestra en su menú NO están replicados en el ODS (verificado 2026-09-17).
    e.resp_surtido, e.resp_checado, e.resp_embarque,
    -- Comercial
    e.vendedor_code, v.nombre AS vendedor_nombre,
    e.pedido_folio,
    CASE WHEN e.padre_tipo = 40
         THEN e.sucursal||'UD40'||lpad(e.serie::text,2,'0')||'-'||e.pedido_folio END AS pedido_folio_digital,
    e.comentarios,
    e.descuento, e.ieps, e.total,
    -- Fecha de pago pactada: CRUDA + veredicto. 10.9% de las filas la traen anterior al
    -- propio embarque, así que un consumidor que la use sin mirar la bandera se equivoca.
    e.fecha_pago_cruda                        AS fecha_pago_pactada,
    (e.fecha_pago_cruda IS NOT NULL AND e.fecha_pago_cruda >= e.fecha) AS fecha_pago_valida,
    -- El embarque NO referencia una ruta (medido: ninguna columna cruza con kdm_rutas).
    NULL::text                                AS ruta_declarada,
    -- Procedencia y huecos, explícitos (ADR-056): lo que no se pudo resolver se DECLARA.
    (t.clave IS NOT NULL)                     AS transporte_resuelto,
    COALESCE(t.ambiguo, false)                AS transporte_ambiguo,
    (c.clave IS NOT NULL)                     AS chofer_resuelto,
    COALESCE(c.ambiguo, false)                AS chofer_ambiguo,
    (e.chofer_code IS NULL)                   AS chofer_sin_capturar,
    now()                                     AS computed_at
  FROM emb e
  LEFT JOIN doc  d  ON d.sucursal = e.sucursal AND d.serie = e.serie
  LEFT JOIN vend v  ON v.sucursal = e.sucursal AND v.code  = e.vendedor_code
  LEFT JOIN analytics.v_kepler_transporte t ON t.sucursal = e.sucursal AND t.clave = e.transporte_key
  LEFT JOIN analytics.v_kepler_chofer     c ON c.sucursal = e.sucursal AND c.clave = e.chofer_key
  LEFT JOIN analytics.v_kepler_chofer     ca ON ca.sucursal = e.sucursal AND ca.clave = t.chofer_asignado
`;

// ─────────────────────────────────────────────────────────────────────────────────────────
// El VIAJE: la guía de embarque agrupa las paradas. Es el grano que corresponde a
// `logistics.shipments` (un viaje de una unidad), no el documento suelto.
// ─────────────────────────────────────────────────────────────────────────────────────────
const V_TRIPS = `
  CREATE OR REPLACE VIEW analytics.erp_shipment_trips AS
  SELECT
    '${M}'::uuid                                   AS tenant_id,
    h.sucursal,
    h.guia_embarque,
    h.sucursal||'-G'||h.guia_embarque              AS guia_digital,
    min(h.fecha)                                   AS fecha,
    count(*)::int                                  AS paradas,
    count(DISTINCT h.cliente_code)::int            AS destinos,
    count(DISTINCT h.serie)::int                   AS series,
    -- Se agrega con min() porque está MEDIDO que la guía lleva una sola unidad y un solo
    -- chofer (386/388 y 388/388 de las guías multiparada); las banderas de abajo denuncian
    -- la excepción en vez de esconderla detrás del min().
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

const VIEWS = [
  ['analytics.v_kepler_transporte', V_TRANSPORTE,
    'Resolvedor del catálogo de unidades de Kepler (kdm_transporte): 1 fila por sucursal × clave NORMALIZADA (sin ceros a la izquierda — el documento y el catálogo rellenan distinto). Colapsa las altas duplicadas (00018/018) prefiriendo la forma de 5 dígitos y marca `ambiguo` si las variantes describen cosas distintas.'],
  ['analytics.v_kepler_chofer', V_CHOFER,
    'Resolvedor del catálogo de choferes de Kepler (kdm_chofer). Mismo criterio que v_kepler_transporte. `ambiguo`=true en la colisión real de la suc 00 (MENDEZ VILLA vs MENDEZ CAMARENA).'],
  ['analytics.erp_shipment_headers', V_HEADERS,
    'EMB.0 — Cabecera logística del embarque Kepler U-D-41 EN VIVO (derive-no-copy sobre kepler_ods.kdm1). Trae lo que ninguna otra puerta traía: transporte (c83), chofer (c84), guía de embarque (c86) y responsables surtido/checado/embarque (c80/c81/c82), más destino, vendedor y pedido padre. Grano = la PARADA. El viaje es analytics.erp_shipment_trips. NO es cartera: la deuda la manda kdue (ver erp_shipment_billing).'],
  ['analytics.erp_shipment_trips', V_TRIPS,
    'EMB.0 — El VIAJE: agrupa las paradas por guía de embarque (kdm1.c86). Medido 2026: 2,096 guías / 4,941 embarques, hasta 32 paradas por guía, y 386/388 de las multiparada con una sola unidad. Éste es el grano que corresponde a logistics.shipments, no el documento suelto.'],
];

exports.up = async function up(knex) {
  await knex.raw('CREATE SCHEMA IF NOT EXISTS analytics');
  for (const [name, sql, comment] of VIEWS) {
    await knex.raw(sql);
    await knex.raw(`GRANT SELECT ON ${name} TO app_runtime`);
    // ⚠️ COMMENT ON no admite parámetros enlazados (`$1`): el literal va escapado a mano.
    await knex.raw(`COMMENT ON VIEW ${name} IS '${comment.replace(/'/g, "''")}'`);
  }
};

exports.down = async function down(knex) {
  // Orden inverso: trips depende de headers, y headers de los dos resolvedores.
  for (const [name] of [...VIEWS].reverse()) {
    await knex.raw(`DROP VIEW IF EXISTS ${name}`);
  }
};
