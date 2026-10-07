'use strict';
/**
 * `[RA-PRO.67]` — **La bandeja de OC abiertas mezcla papel vivo con papel muerto.**
 *
 * ── El defecto, medido contra prod el 2026-10-02 ─────────────────────────────────────────────
 * `/compras/oc-abiertas` lista **292 renglones por $33,570,584**. De esos, **36 por $2,443,575
 * no van a salir nunca por su cuenta**: el ERP ya los sacó de pendiente, o su vale está
 * cancelado. Siguen ahí, con 0% de probabilidad, indistinguibles de una orden que sí espera
 * mercancía.
 *
 * La causa es de una línea: `cerrada` se deriva **sólo de la cadena de documentos**
 * (vale `X-A-37` + orden de entrada `X-A-40`) y nunca mira nada más. El servicio sí lee
 * `estatus` —lo usa para poner la probabilidad en cero— pero no para separar la fila.
 *
 * ── Dos testigos, y NINGUNO alcanza solo ────────────────────────────────────────────────────
 * Ésta es la razón de que se agreguen DOS señales y no una (ADR-059: cada cifra necesita su
 * árbitro, y donde los testigos se contradicen se declara en vez de elegir a ciegas).
 *
 *   **Testigo 1 — la palabra del ERP** (`c43`). Medido a 365 días sobre 10,681 órdenes, existen
 *   exactamente cinco valores y su acuerdo con la cadena discrimina fuerte:
 *
 *       F  9,453 OC  99.3% con cadena completa   ← finalizada
 *       R    527 OC  99.6%                       ← recibida
 *       N    419 OC  27.0%                       ← pendiente
 *       C    263 OC  32.3%                       ← cancelada
 *       A     19 OC  57.9%                       ← SIN DOCUMENTAR en el decode de Kepler
 *
 *   **Testigo 2 — el documento** (el vale). Se mira si la orden tiene vale y si alguno sigue
 *   vivo (`c43 <> 'C'`).
 *
 * ⭐ **El testigo 2 resolvió lo que el testigo 1 no podía.** `A` no está documentado y su 57.9%
 * cae justo entre `N` y `F`: si fuera *"Autorizada"* sería un estado PENDIENTE y mandarlo a papel
 * muerto se habría comido **$1,110,521** de pipeline legítimo. En vez de adivinar la letra se
 * miraron las 19 órdenes: **17 tienen TODOS sus vales cancelados**. O sea que no hace falta saber
 * qué significa `A` — el estado se demuestra por documento. Las otras 2 traen vales finalizados
 * y quedan, correctamente, fuera de papel muerto.
 *
 * ── Y la cruza deja ver que ninguno sobra ────────────────────────────────────────────────────
 * Sobre los 292 renglones de la bandeja, los dos testigos coinciden en los bloques grandes y
 * **se contradicen en 4 filas** — que es justo lo que justifica conservar los dos:
 *
 *     sin vale          + c43 'N'  253 filas  $30,261,233   ← pendiente de verdad
 *     sin vale          + c43 'C'    2 filas  $   837,662   ← sólo el ERP la ve cancelada
 *     vale cancelado    + c43 'A'    8 filas  $ 1,110,521   ← compra abortada
 *     vale cancelado    + c43 'N'    2 filas  $    67,048   ← el ERP va rezagado
 *     vale vivo         + c43 'F'   27 filas  $ 1,294,120   ← 100% de acuerdo
 *
 * Los 27 de la última fila son el hallazgo que el comprador no tenía: el ERP las dio por
 * finalizadas y **la mercancía nunca entró** — su vale sigue vivo esperando orden de entrada.
 *
 * ── ⛔ Lo que esta migración NO hace ─────────────────────────────────────────────────────────
 * **No filtra nada y no cambia ningún número publicado.** `cerrada` conserva su semántica exacta
 * (ver el candado de abajo) y las columnas nuevas van al final. Quién se esconde y quién se
 * pinta lo decide la pantalla, en un commit aparte. Tampoco se escribe a Kepler: la corrección
 * del documento se hace allá (ADR-040).
 *
 * ── La reescritura de `cerrada`, y por qué además es más rápida ──────────────────────────────
 * El `EXISTS (vale JOIN entrada)` se reemplaza por UN `LEFT JOIN LATERAL` que recorre los vales
 * una sola vez y devuelve las tres cosas a la vez (cuántos, cuántos vivos, si alguno tiene
 * entrada). Es la misma pregunta con un solo barrido en vez de uno anidado.
 *
 *   Medido en prod sobre 10,681 órdenes de 365 días:
 *     · `cerrada` vieja vs nueva .... **0 discrepancias de 10,681**
 *     · tiempo ...................... **455 ms** (la nota de la mig original declaraba ~2 s)
 *
 * ⚠️ Se mantienen las columnas CRUDAS en los `JOIN` (`c4='35'`, `c37='35'`, `c39=c6`), sin
 * `btrim`. Es la lección que ya trae la migración 20260829190000: envolverlas inutiliza
 * `ix_ods_kdm1_xa_c39 (sucursal, c39, c37)` y la vista pasó de ~2 s a **331 s**. El `btrim` vive
 * en la SALIDA, donde no cuesta.
 *
 * @param { import("knex").Knex } knex
 */

const V = 'analytics.erp_purchase_orders';
const M = '00000000-0000-0000-0000-00000000d01c';

/** El cuerpo de la vista. `extra` agrega columnas al final sin tocar las 15 que ya existen. */
function sql(extra) {
  return `
    CREATE OR REPLACE VIEW ${V} AS
    SELECT
      '${M}'::uuid                                   AS tenant_id,
      h.sucursal::text                               AS sucursal,
      btrim(h.c6::text)                              AS folio,
      h.c9::date                                     AS doc_date,
      (CURRENT_DATE - h.c9::date)                    AS dias_abierta,
      NULLIF(btrim(h.c10::text),'')                  AS proveedor_code,
      NULLIF(btrim(h.c32::text),'')                  AS proveedor_nombre,
      NULLIF(btrim(h.c22::text),'')                  AS proveedor_rfc,
      NULLIF(btrim(h.c24::text),'')                  AS concepto,
      NULLIF(btrim(h.c30::text),'')                  AS condicion_pago,
      round(coalesce(nullif(regexp_replace(h.c16::text,'[^0-9.-]','','g'),'')::numeric,0),2) AS monto,
      COALESCE(NULLIF(btrim(h.c43::text),''), 'N')   AS estatus,
      ('md_'||h.sucursal)::text                      AS source_branch,
      COALESCE(z.tiene_entrada, false)               AS cerrada,
      now()                                          AS computed_at
      ${extra}
    FROM kepler_ods.kdm1 h
    LEFT JOIN LATERAL (
      -- Un solo barrido de los vales de esta orden. Columnas CRUDAS: el btrim mata el índice.
      SELECT count(*)::int                                                          AS vales,
             count(*) FILTER (WHERE COALESCE(NULLIF(btrim(v.c43::text),''),'N') <> 'C')::int
                                                                                    AS vales_vivos,
             bool_or(EXISTS (
               SELECT 1 FROM kepler_ods.kdm1 e
                WHERE e.sucursal = v.sucursal AND e.c1 = v.c1
                  AND e.c2 = 'X' AND e.c3 = 'A' AND e.c4 = '40'
                  AND e.c37 = '37' AND e.c39 = v.c6))                               AS tiene_entrada
        FROM kepler_ods.kdm1 v
       WHERE v.sucursal = h.sucursal AND v.c1 = h.c1
         AND v.c2 = 'X' AND v.c3 = 'A' AND v.c4 = '37'
         AND v.c37 = '35' AND v.c39 = h.c6
    ) z ON true
    WHERE h.c2='X' AND h.c3='A' AND h.c4='35' AND h.sucursal=h.c1
  `;
}

/** Las cuatro columnas nuevas, siempre AL FINAL (CREATE OR REPLACE sólo admite agregar ahí). */
const EXTRA = `,
      COALESCE(z.vales, 0)                           AS vales,
      COALESCE(z.vales_vivos, 0)                     AS vales_vivos,
      -- El estado DEMOSTRADO por la cadena de documentos, sin depender de qué significa c43.
      CASE WHEN COALESCE(z.tiene_entrada,false) THEN 'cerrada'
           WHEN COALESCE(z.vales,0) = 0            THEN 'sin_vale'
           WHEN COALESCE(z.vales_vivos,0) = 0      THEN 'vale_cancelado'
           ELSE 'vale_vivo' END                      AS estado_cadena,
      -- La palabra del ERP, en positivo sobre el único valor documentado como pendiente.
      -- NO se afirma qué significan 'F','R','C','A': sólo que no son 'N'.
      (COALESCE(NULLIF(btrim(h.c43::text),''), 'N') = 'N') AS pendiente_en_erp`;

exports.up = async function up(knex) {
  const ods = await knex.raw(`SELECT to_regclass('kepler_ods.kdm1') AS t`);
  if (!ods.rows[0]?.t) {
    console.log('  [RA-PRO.67] kepler_ods ausente — no-op (dev local sin réplica).');
    return;
  }
  const cur = await knex.raw(
    `SELECT relkind FROM pg_class WHERE oid = to_regclass('${V}')`);
  if (cur.rows[0]?.relkind !== 'v') {
    console.log('  [RA-PRO.67] erp_purchase_orders no es vista — no-op (corre tras 20260829190000).');
    return;
  }

  // ⚠️ EL ORDEN IMPORTA, Y NO ES COSMETICO. `CREATE OR REPLACE VIEW` toma ACCESS EXCLUSIVE
  // sobre la vista y knex corre la migracion entera en UNA transaccion: todo lo que se haga
  // despues del DDL sostiene ese lock y BLOQUEA a quien lea `erp_purchase_orders` (las tres
  // pantallas de compras). La primera version de este archivo comparaba contra el EXISTS
  // anidado DESPUES del DDL: medido, **26.8 s** de lock en horario habil.
  //
  // Por eso la foto del valor VIEJO se toma ANTES (solo ACCESS SHARE), y despues del DDL queda
  // un join contra una tabla temporal. Ademas es un candado MEJOR: compara contra lo que la
  // vista publicaba de verdad, no contra una reimplementacion de su logica.
  await knex.raw(`
    CREATE TEMP TABLE ra67_antes ON COMMIT DROP AS
    SELECT sucursal, folio, cerrada FROM ${V} WHERE doc_date >= CURRENT_DATE - 365`);
  const { rows: [ant] } = await knex.raw('SELECT count(*)::int n FROM ra67_antes');
  if (!ant.n) throw new Error('[RA-PRO.67] el candado no midió nada: 0 órdenes en 365 días');

  await knex.raw(sql(EXTRA));
  await knex.raw(`GRANT SELECT ON ${V} TO app_runtime`);
  await knex.raw(`COMMENT ON VIEW ${V} IS
    'RA-PRO.45.1/67 — Ordenes de compra de Kepler (X-A-35). cerrada = tiene vale X-A-37 con orden '
    'de entrada X-A-40 aguas abajo. estado_cadena (sin_vale|vale_cancelado|vale_vivo|cerrada) es '
    'el estado DEMOSTRADO por documento; pendiente_en_erp es la palabra del ERP (c43=N). Son dos '
    'testigos distintos y se contradicen en ~4 de 292 filas: no colapsarlos en uno.'`);

  // ── Candado 1: la reescritura de `cerrada` no movió una sola fila ────────────────────────
  // Contra la foto tomada ANTES del DDL: el valor que la vista publicaba de verdad.
  const { rows: [c1] } = await knex.raw(`
    SELECT count(*)::int AS n,
           count(*) FILTER (WHERE v.cerrada IS DISTINCT FROM a.cerrada)::int AS discrepan,
           count(*) FILTER (WHERE v.folio IS NULL)::int                      AS perdidas
      FROM ra67_antes a
      LEFT JOIN ${V} v ON v.sucursal = a.sucursal AND v.folio = a.folio`);
  if (c1.n !== ant.n) throw new Error(`[RA-PRO.67] el join perdió filas: ${c1.n} != ${ant.n}`);
  if (c1.perdidas) {
    throw new Error(
      `[RA-PRO.67] ${c1.perdidas} órdenes desaparecieron de la vista: el conjunto de FILAS ` +
      'tambien tiene que quedar igual, no solo el valor de cerrada.');
  }
  if (c1.discrepan) {
    throw new Error(
      `[RA-PRO.67] la reescritura MOVIO cerrada: ${c1.discrepan} de ${c1.n} filas difieren ` +
      'de lo que la vista publicaba antes. NO debe cambiar ningun numero publicado.');
  }

  // ── Candado 2: la particion es exhaustiva y DISCRIMINA ───────────────────────────────────
  // Un estado que se lleva el 100% no esta clasificando: esta repitiendo `cerrada` con otro
  // nombre. Se exige que los cuatro existan.
  const { rows: [c2] } = await knex.raw(`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE estado_cadena='cerrada')::int        AS cerrada,
           count(*) FILTER (WHERE estado_cadena='sin_vale')::int       AS sin_vale,
           count(*) FILTER (WHERE estado_cadena='vale_cancelado')::int AS vale_cancelado,
           count(*) FILTER (WHERE estado_cadena='vale_vivo')::int      AS vale_vivo,
           count(*) FILTER (WHERE estado_cadena IS NULL)::int          AS sin_estado
      FROM ${V} WHERE doc_date >= CURRENT_DATE - 365`);
  if (c2.sin_estado) throw new Error(`[RA-PRO.67] ${c2.sin_estado} ordenes sin estado_cadena`);
  for (const k of ['cerrada', 'sin_vale', 'vale_cancelado', 'vale_vivo']) {
    if (!c2[k]) {
      throw new Error(
        `[RA-PRO.67] el estado '${k}' quedo VACIO sobre ${c2.total} ordenes: la particion no ` +
        'discrimina, asi que no esta midiendo lo que dice medir.');
    }
  }
  const suma = c2.cerrada + c2.sin_vale + c2.vale_cancelado + c2.vale_vivo;
  if (suma !== c2.total) {
    throw new Error(`[RA-PRO.67] la particion no cubre el universo: ${suma} != ${c2.total}`);
  }

  // ── Candado 3: `cerrada` y `estado_cadena` no pueden contradecirse ───────────────────────
  const { rows: [c3] } = await knex.raw(`
    SELECT count(*)::int AS contradicen FROM ${V}
     WHERE doc_date >= CURRENT_DATE - 365
       AND cerrada <> (estado_cadena = 'cerrada')`);
  if (c3.contradicen) {
    throw new Error(
      `[RA-PRO.67] ${c3.contradicen} filas donde cerrada y estado_cadena se contradicen: ` +
      'dos campos del mismo hecho salen del mismo calculo.');
  }

  console.log(
    `  [RA-PRO.67] ok — ${c2.total} ordenes/365d · cerrada sin cambios (0/${c1.n}) · ` +
    `sin_vale ${c2.sin_vale} · vale_cancelado ${c2.vale_cancelado} · vale_vivo ${c2.vale_vivo}`);
};

exports.down = async function down(knex) {
  const ods = await knex.raw(`SELECT to_regclass('kepler_ods.kdm1') AS t`);
  if (!ods.rows[0]?.t) return;
  const cur = await knex.raw(
    `SELECT relkind FROM pg_class WHERE oid = to_regclass('${V}')`);
  if (cur.rows[0]?.relkind !== 'v') return;
  // ⚠️ CREATE OR REPLACE no puede QUITAR columnas: hay que soltar la vista y rehacerla con las
  // 15 originales. Nada depende de ella por dependencia dura (los consumidores son servicios).
  await knex.raw(`DROP VIEW IF EXISTS ${V}`);
  await knex.raw(sql(''));
  await knex.raw(`GRANT SELECT ON ${V} TO app_runtime`);
};
