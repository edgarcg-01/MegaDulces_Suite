'use strict';
/**
 * `[PQ.150]` — **La factura del SAT ligada a su aplicación `X-A-20`**, derivada (`derive-no-copy`, regla 1 /
 * ADR-056): `commercial.v_supplier_invoice_application`, una fila por par factura ↔ aplicación, uno a uno.
 * Es la liga que PQ.148 aprende de la historia (anexo P §3.2) y la que PQ.157 necesita para validar el
 * costo al aplicar. Hasta hoy la única regla era RFC + total ±$1 + ±20 días, y el RFC del acreedor falta
 * en Kepler (`kdxd.c10`) para 6 de cada 10 aplicaciones.
 *
 * Plan: `docs/IMPLEMENTACION/FASES/FASE_PQ_ANEXO_PROVEEDOR_AVISO_DE_ENTREGA.md` §3.10 y §7 (`[PQ.150]`).
 *
 * ── Las llaves (las mismas piezas que Recepción ya usa, replicadas en SQL) ──────────────────────
 *  De la más fuerte a la más débil; cada una UNO A UNO en los dos sentidos sobre lo que quedó libre:
 *   1. `rfc_folio`   — RFC del acreedor + el folio del proveedor que Kepler guarda en la referencia
 *                      (`kdm1.c11`, núcleo o cola: `emparejar-papel.ts`), la factura hasta 60 días antes
 *                      o 15 después, y su total entre la mitad y el doble de la aplicación.
 *   2. `folio_total` — folio de la referencia + total ±$1 + ±20 días (el acreedor sin RFC en Kepler).
 *   3. `rfc_total`   — RFC + total ±$1 + ±20 días (la regla de antes).
 *  Las réplicas en SQL (`folioNumero`, `nucleoReferencia`, `rfcComparable`, `rfcBienFormado`) se
 *  exportan para que la prueba las compare contra las de TypeScript, caso por caso.
 *
 * ── Lo medido antes (sólo lectura, pg-prod `system_identifier` 7688376744939610156, 2026-11-25) ──
 *  · Aplicaciones vivas de 60 días (sin CL005): 1,938. Con la regla de antes se ligan **553 (28.5 %,
 *    $47.4 M de $114.5 M, 41 %)**; con las tres llaves, **962 (49.6 %, $88.6 M, 77 %)**.
 *  · ⭐ Las llaves no se contradicen: donde el folio y el importe encuentran factura cada uno por su
 *    lado, eligen la MISMA en **458 de 458**. Testigo por renglón (importe de la factura ↔ renglón de
 *    la aplicación, ±0.5 %, uno a uno), pares con la mitad o más de sus renglones casados:
 *    rfc_folio 78 % · folio_total 75 % · rfc_total 93 %, contra 2–9 % del placebo (la misma factura
 *    contra otra aplicación del mismo acreedor).
 *  · La banda del total en `rfc_folio` sale de lo medido: 3 ligas caían en facturas de $0 y $6.48 con
 *    el mismo número de folio. Dentro de la banda quedan dos proveedores con la aplicación 3–5 % y
 *    9 % abajo de su factura (69 aplicaciones, ~$548 mil en 60 días): es el caso de `[PQ.157]`.
 *  · Control con respuesta conocida: esta vista y la medición en JS (que usa las funciones TS de
 *    Recepción) dan las mismas 962 ligas, par por par.
 *  · Lo que no se liga: 765 aplicaciones ($9.1 M) son de acreedores sin ninguna factura en ContPAQi
 *    (remisión, personas físicas: `[RE.35.2]`). La llave por nombre del acreedor sumaría 35 más; NO
 *    va aquí (replicar `parecidoNombre` en SQL es otra pieza): queda declarada en el anexo P.
 *
 * ── Por qué también una matvista ───────────────────────────────────────────────────────────────
 *  La vista entera cuesta **8.3 s** (5,243 pares de toda la historia) y filtrarla por un proveedor NO
 *  es más barato (el uno a uno se decide contra todos los candidatos: medido, 92 s con el filtro).
 *  Quien la lea en una pantalla lee `analytics.mv_supplier_invoice_application`, copia materializada
 *  sin un solo cambio de lógica (`SELECT * FROM` la vista), refrescada cada hora por
 *  `AnalyticsRefreshService` con `REFRESH CONCURRENTLY` (~3 min de CPU al día). La vista queda para
 *  el dato al momento.
 *
 * ⚠️ Aplicar fuera de horario pico: poblar la matvista es un pase de 8 s con el candado de
 *    migraciones tomado. Sin re-login; no toca permisos.
 *
 * Idempotente (`CREATE OR REPLACE VIEW`; la matvista se recrea).
 *
 * @param { import("knex").Knex } knex
 */

/**
 * `folioNumero()` de `receipt-match.ts`, en SQL. ⛔ Si cambia una, cambia la otra: la prueba compara las dos.
 * ⚠️ Sin `?` en el SQL: knex lo toma por parámetro. `\.{0,1}` es el `\.?` de la versión TS.
 */
const FOLIO_NUMERO = (x) => `(SELECT CASE WHEN m IS NULL THEN NULL WHEN ltrim(m, '0') = '' THEN '0' ELSE ltrim(m, '0') END
  FROM (SELECT substring(regexp_replace(regexp_replace(upper(regexp_replace(${x}, '^\\s+|\\s+$', '', 'g')),
    '^[A-Z]{1,3}[0-9]{3,4}\\s*[-–]\\s*', ''), '^(NO\\.{0,1}|NUM\\.{0,1}|FOLIO)\\s*', '') from '[0-9]{2,}') AS m) f)`;
/** `nucleoReferencia()` de `emparejar-papel.ts` (= `sqlNucleoReferencia` + el largo mínimo `FOLIO_MINIMO` = 3). */
const NUCLEO = (x) => `(SELECT CASE WHEN length(n) >= 3 THEN n END
  FROM (SELECT ltrim(regexp_replace(regexp_replace(COALESCE(${x}, ''), '^\\s*\\d{2}\\s*-\\s*', ''), '\\D', '', 'g'), '0') AS n) r)`;
/** `rfcComparable()` de `receipt-match.ts`: sin puntuación, mayúsculas, glifos ambiguos plegados (O→0, I/L→1, S→5, B→8, Z→2, G→6). */
const RFC_COMPARABLE = (x) => `NULLIF(translate(regexp_replace(upper(coalesce(${x}, '')), '[^A-Z0-9]', '', 'g'), 'OILSBZG', '0115826'), '')`;
/** El RFC del acreedor en Kepler, comparable, sólo si tiene forma de RFC (= `rfcBienFormado()`). */
const RFC_KEPLER = (x) => `CASE WHEN regexp_replace(upper(coalesce(${x}, '')), '[^A-Z0-9Ñ&]', '', 'g') ~ '^[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}$'
  THEN ${RFC_COMPARABLE(x)} END`;
/** ¿El folio de la factura casa con el núcleo de la referencia? Igual, o la referencia es su cola de 4+ (= `esSufijoDeReferencia()`). */
const FOLIO_CASA = (nucleo, fol) =>
  `(${nucleo} = ${fol} OR (length(${nucleo}) >= 4 AND length(${fol}) > length(${nucleo}) AND right(${fol}, length(${nucleo})) = ${nucleo}))`;
const MISMA_AP = (t) => `${t}.sucursal = ap.sucursal AND ${t}.c1 = ap.c1 AND ${t}.c5 = ap.c5 AND ${t}.folio = ap.folio`;

/**
 * El cuerpo de la vista. `antesDe` (fecha ISO) recorta aplicaciones y facturas a lo anterior a ese día:
 * la medición antes/después de lo que aprende la historia (`[PQ.148]`) aprende del pasado y se prueba
 * sobre los últimos 30 días. La vista va SIN `antesDe`.
 */
function cuerpo({ antesDe = null } = {}) {
  if (antesDe != null && !/^\d{4}-\d{2}-\d{2}$/.test(String(antesDe))) throw new Error(`antesDe inválido: ${antesDe}`);
  const corteAp = antesDe ? `AND m.c9::date < DATE '${antesDe}'` : '';
  const corteCf = antesDe ? `AND (c.fecha AT TIME ZONE 'America/Mexico_City')::date < DATE '${antesDe}'` : '';
  const unico = (k) => `SELECT * FROM (SELECT ${k}.*, count(*) OVER (PARTITION BY sucursal, c1, c5, folio) AS n_ap,
                                  count(*) OVER (PARTITION BY cfdi_id) AS n_cf FROM ${k}) x
   WHERE n_ap = 1 AND n_cf = 1`;
  return `
WITH acre AS (
  SELECT d.sucursal, btrim(d.c2) AS prov, ${RFC_KEPLER('d.c10')} AS rfc
    FROM kepler_ods.kdxd d
),
aparte AS (SELECT DISTINCT rfc FROM acre WHERE prov = 'CL005' AND rfc IS NOT NULL),
-- MATERIALIZED: se leen una vez (≈14 mil aplicaciones, ≈150 mil facturas) y se cruzan por igualdad.
ap AS MATERIALIZED (
  SELECT m.sucursal, m.c1, m.c5, m.c6 AS folio, btrim(m.c10) AS proveedor_code, a.rfc,
         m.c16::numeric AS total, m.c9::date AS fecha, NULLIF(btrim(m.c11), '') AS referencia,
         ${NUCLEO('m.c11')} AS nucleo, floor(m.c16::numeric)::bigint AS tb
    FROM kepler_ods.kdm1 m
    LEFT JOIN acre a ON a.sucursal = m.sucursal AND a.prov = btrim(m.c10)
   WHERE m.c2 = 'X' AND m.c3 = 'A' AND m.c4 = 20 AND btrim(m.c1) = m.sucursal
     AND btrim(coalesce(m.c43, '')) <> 'C' AND btrim(m.c10) <> 'CL005' ${corteAp}
),
cf AS MATERIALIZED (
  SELECT x.* FROM (
    SELECT c.tenant_id, c.id, c.uuid, c.emisor_rfc, ${RFC_COMPARABLE('c.emisor_rfc')} AS rfc, c.total,
           (c.fecha AT TIME ZONE 'America/Mexico_City')::date AS fecha, ${FOLIO_NUMERO('c.folio')} AS fol, floor(c.total)::bigint AS tb
      FROM fiscal.cfdis c
     WHERE c.rol = 'recibidas' AND c.tipo_comprobante = 'I' AND coalesce(c.estatus_sat, '') NOT ILIKE 'cancel%' ${corteCf}) x
   WHERE NOT EXISTS (SELECT 1 FROM aparte a WHERE a.rfc = x.rfc)
),
k1 AS (
  SELECT ap.sucursal, ap.c1, ap.c5, ap.folio, cf.tenant_id, cf.id AS cfdi_id
    FROM ap JOIN cf ON cf.rfc = ap.rfc
   WHERE ap.nucleo IS NOT NULL AND cf.fol IS NOT NULL AND ${FOLIO_CASA('ap.nucleo', 'cf.fol')}
     AND cf.fecha - ap.fecha BETWEEN -60 AND 15
     AND cf.total > 0 AND ap.total BETWEEN cf.total * 0.5 AND cf.total * 2
),
p1 AS MATERIALIZED (${unico('k1')}),
-- El total ±$1 se cruza por cubetas de un peso (la de al lado, a lo más): igualdad, no producto cartesiano.
k2 AS (
  SELECT ap.sucursal, ap.c1, ap.c5, ap.folio, cf.tenant_id, cf.id AS cfdi_id
    FROM ap CROSS JOIN (VALUES (-1), (0), (1)) d(k)
    JOIN cf ON cf.tb = ap.tb + d.k
   WHERE ap.nucleo IS NOT NULL AND cf.fol IS NOT NULL AND abs(cf.total - ap.total) < 1
     AND abs(cf.fecha - ap.fecha) <= 20 AND ${FOLIO_CASA('ap.nucleo', 'cf.fol')}
     AND NOT EXISTS (SELECT 1 FROM p1 WHERE ${MISMA_AP('p1')})
     AND NOT EXISTS (SELECT 1 FROM p1 WHERE p1.cfdi_id = cf.id)
),
p2 AS MATERIALIZED (${unico('k2')}),
k3 AS (
  SELECT ap.sucursal, ap.c1, ap.c5, ap.folio, cf.tenant_id, cf.id AS cfdi_id
    FROM ap CROSS JOIN (VALUES (-1), (0), (1)) d(k)
    JOIN cf ON cf.rfc = ap.rfc AND cf.tb = ap.tb + d.k
   WHERE abs(cf.total - ap.total) < 1 AND abs(cf.fecha - ap.fecha) <= 20
     AND NOT EXISTS (SELECT 1 FROM p1 WHERE ${MISMA_AP('p1')})
     AND NOT EXISTS (SELECT 1 FROM p2 WHERE ${MISMA_AP('p2')})
     AND NOT EXISTS (SELECT 1 FROM p1 WHERE p1.cfdi_id = cf.id)
     AND NOT EXISTS (SELECT 1 FROM p2 WHERE p2.cfdi_id = cf.id)
),
p3 AS (${unico('k3')}),
liga AS (
  SELECT p1.*, 'rfc_folio'::text AS metodo FROM p1
  UNION ALL SELECT p2.*, 'folio_total' FROM p2
  UNION ALL SELECT p3.*, 'rfc_total' FROM p3
)
SELECT l.tenant_id, l.cfdi_id, cf.uuid AS cfdi_uuid, cf.emisor_rfc AS proveedor_rfc,
       l.sucursal, l.c1 AS almacen, l.c5 AS subtipo, l.folio, ap.proveedor_code, ap.referencia, l.metodo,
       ap.total AS total_aplicacion, cf.total AS total_cfdi, round(ap.total - cf.total, 2) AS diferencia,
       ap.fecha AS fecha_aplicacion, cf.fecha AS fecha_cfdi
  FROM liga l
  JOIN ap ON ${MISMA_AP('l')}
  JOIN cf ON cf.id = l.cfdi_id`;
}

const VISTA = 'commercial.v_supplier_invoice_application';
const MV = 'analytics.mv_supplier_invoice_application';
/** Piso de la compuerta: medido 5,243 pares el 2026-11-25. Con 0 el rol que materializó no ve `fiscal.cfdis` (RLS forzada). */
const PISO = 3000;
/** Con menos aplicaciones `X-A-20` en el ODS es una base de pruebas: el piso no se puede exigir (se declara). */
const APLICACIONES_DE_PROD = 5000;

exports.cuerpo = cuerpo;
exports.SELECT_SQL = cuerpo();
exports.SQL = { FOLIO_NUMERO, NUCLEO, RFC_COMPARABLE, RFC_KEPLER };
exports.VISTA = VISTA;
exports.MV = MV;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`CREATE OR REPLACE VIEW ${VISTA} WITH (security_invoker = true) AS ${exports.SELECT_SQL}`);
  await knex.raw(`COMMENT ON VIEW ${VISTA} IS
    '[PQ.150] La factura del SAT (fiscal.cfdis, recibidas tipo I) <-> su aplicacion X-A-20 de Kepler, uno a uno. Llaves en orden: rfc_folio (RFC del acreedor + folio del proveedor en la referencia kdm1.c11, total entre 0.5x y 2x), folio_total (folio + total +-1, +-20 d), rfc_total (RFC + total +-1, +-20 d). derive-no-copy; sin CL005. Cuesta ~8 s entera: en caliente leer analytics.mv_supplier_invoice_application.'`);
  await knex.raw(`GRANT SELECT ON ${VISTA} TO app_runtime`);

  // La copia materializada, sin un cambio de lógica. Se puebla en la migración (un pase, ~8 s): nacer
  // vacía dejaría a la historia de PQ.148 sin pares hasta el primer refresco.
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS ${MV}`);
  await knex.raw(`CREATE MATERIALIZED VIEW ${MV} AS SELECT * FROM ${VISTA} WITH DATA`);
  // Los dos UNIQUE son el uno a uno (una factura, una aplicación) y habilitan REFRESH CONCURRENTLY.
  await knex.raw(`CREATE UNIQUE INDEX ux_mv_supplier_invoice_application_cfdi ON ${MV} (tenant_id, cfdi_id)`);
  await knex.raw(`CREATE UNIQUE INDEX ux_mv_supplier_invoice_application_ap ON ${MV} (tenant_id, sucursal, almacen, subtipo, folio)`);
  await knex.raw(`CREATE INDEX ix_mv_supplier_invoice_application_rfc ON ${MV} (tenant_id, proveedor_rfc)`);
  await knex.raw(`GRANT SELECT ON ${MV} TO app_runtime`);

  // Compuerta: NO puede nacer vacía. Es el modo de falla de esta familia (GOTCHAS §87.1): si el rol que
  // materializa no tiene BYPASSRLS, fiscal.cfdis (FORCE ROW LEVEL SECURITY) no le da filas y la
  // matvista se ve «poblada» con cero. La MISMA transacción y el mismo rol que la vista: la cardinalidad
  // contra la vista no se vuelve a pagar (otro pase de 8 s); el uno a uno lo sostienen los UNIQUE.
  // El piso sólo aplica con el ODS de prod (≈14 mil aplicaciones): una base de pruebas no tiene con qué.
  const [{ n, metodos }] = (await knex.raw(`SELECT count(*)::int AS n, count(DISTINCT metodo)::int AS metodos FROM ${MV}`)).rows;
  const [{ aps }] = (await knex.raw(`SELECT count(*)::int AS aps FROM kepler_ods.kdm1 WHERE c2 = 'X' AND c3 = 'A' AND c4 = 20`)).rows;
  if (aps >= APLICACIONES_DE_PROD && (!(n >= PISO) || metodos !== 3)) {
    throw new Error(`[PQ.150] ${MV} quedó con ${n} pares y ${metodos} métodos sobre ${aps} aplicaciones (se esperaban ~5,200 y 3). ` +
      'Si dio 0: el rol que materializó no tiene BYPASSRLS y la RLS de fiscal.cfdis la vació en silencio.');
  }
  if (aps < APLICACIONES_DE_PROD) console.log(`  · [PQ.150] NO MEDIDO: ${aps} aplicaciones en el ODS de esta base; el piso de ${PISO} pares se exige con las de prod`);
  await knex.raw(`COMMENT ON MATERIALIZED VIEW ${MV} IS
    $$[PQ.150] Copia materializada de ${VISTA}, sin un cambio de logica (SELECT * FROM la vista). Existe por COSTO:
    la vista cuesta ~8 s entera y filtrarla por proveedor no es mas barato (el uno a uno se decide contra todos).
    La refresca AnalyticsRefreshService cada hora (REFRESH CONCURRENTLY). NO lleva RLS: filtrar tenant_id explicito.
    Si el refresh se mueve a un rol sin BYPASSRLS se materializa VACIA (fiscal.cfdis tiene FORCE ROW LEVEL SECURITY).$$`);
  console.log(`  ✓ [PQ.150] ${VISTA} + ${MV}: ${n} pares factura <-> aplicacion`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`: las dos son nuevas y nada depende de ellas todavía. */
exports.down = async function down(knex) {
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS ${MV}`);
  await knex.raw(`DROP VIEW IF EXISTS ${VISTA}`);
};
