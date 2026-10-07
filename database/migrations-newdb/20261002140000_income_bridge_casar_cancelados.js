/**
 * `[IG.8]` — **Ni un ingreso sin casar: los 5 "sin documento" SÍ tenían documento.**
 *
 * Edgar: *"no podemos dejar ni un ingreso sin casar y no dejar una verdad absoluta"*.
 *
 * ── EL HUECO ERA MÍO, NO DE LA FUENTE ─────────────────────────────────────────────────────────
 * `[IG.7]` declaraba **5 líneas / $204,986 "sin documento"** y decía, textual, *"existe el asiento
 * y no aparece su factura"*. Falso. Las 5 aparecen: su `doc` las dejaba afuera porque el CTE
 * filtraba cancelados con `btrim(coalesce(c43,'')) <> 'C'`. **Un filtro no es una ausencia**, y
 * declarar como hueco lo que uno mismo recortó es la falla simétrica de dibujar un cero.
 *
 *     folio      fecha        plaza                          importe      documento
 *     0007474    2026-09-09   PADRE HIDALGO PISO             130,151.33   CANCELADO ($0.00)
 *     0007058    2026-09-01   ZAMORA CENTRO DAMZO CARDENAS    59,952.89   CANCELADO ($0.00)
 *     0007372    2026-09-08   RUTA 505                         9,210.90   CANCELADO ($0.00)
 *     0007343    2026-09-07   RUTA 505                         5,671.31   CANCELADO ($0.00)
 *     0000977    2026-09-01   ZAMORA CENTRO (nota de crédito)      -3.45   CANCELADO ($0.00)
 *
 * ── ⛔⛔ Y AL ABRIRLO APARECIÓ ALGO QUE NO ES UN DEFECTO DE DATOS, ES DINERO ───────────────────
 * **El documento está cancelado y su póliza de ingreso sigue viva, completa y sin reversar.** La
 * `0007474` tiene su cargo a `115 Clientes` y su abono a `401-002 Ventas` por $130,151.33, y no
 * existe ningún asiento que la reverse (buscado por importe exacto en sep y oct: aparece UNA vez).
 *
 * ⭐ El mecanismo del ERP quedó medido, y por eso se sabe que esto es la excepción: cuando Kepler
 * da de baja un documento escribe una póliza **`BAJA - UD13001-<folio>` en $0.00** —un marcador,
 * no un asiento inverso— y **borra la póliza de ingreso**. Medido sobre 90 días:
 *
 *     bajas marcadas en la cuenta 401 .................. 166   (157 UD13 · 7 UD12 · 2 UD41)
 *     de ésas, con póliza de ingreso todavía viva ......   0   ($0.00)
 *     documentos UD13 cancelados ....................... 158
 *     de ésos, CON su marcador de baja ................. 154   (97.5 %)
 *     SIN marcador, con su ingreso vivo ................   4   ($204,986)  ⛔
 *
 * O sea: la regla del ERP es que no quede ingreso vivo de un documento cancelado, **y se cumple en
 * 154 de 158**. Los 4 que faltan llevan más de tres semanas a medias.
 *
 * ⚠️ **Dos causas compiten y esta vista NO puede separarlas**, porque las dos se ven igual desde el
 * ODS: (a) Kepler ya borró la póliza y el DELETE no se propagó —el mecanismo *fantasma* que
 * `VERDAD_ABSOLUTA.md` §15.2 ya tiene medido y cuya causa raíz está documentada: el CDC no propaga
 * DELETEs—, o (b) la cancelación quedó a medias y la contabilidad nunca se reversó. Separarlas
 * exige leer el Kepler VIVO del CEDIS, no el ODS. **Pero el veredicto no depende de cuál sea**: en
 * los dos casos el documento vale $0.00 y el ingreso está publicado de más. Por eso se marca, se
 * resta en el puente, y se declara con su monto en vez de esconderse.
 *
 * ── QUÉ CAMBIA ────────────────────────────────────────────────────────────────────────────────
 * `doc` deja de filtrar cancelados y publica `doc_cancelado`. Con eso **la liga pasa de 99.9 % a
 * 100 %: las 4,814 líneas tienen su documento, su cliente y su veredicto.** Lo que antes era un
 * hueco ("no sé qué es esto") pasa a ser una afirmación ("esto es un documento cancelado cuyo
 * ingreso sigue publicado, y vale $204,986").
 *
 * ⚠️ Quitar un filtro de un lado de un JOIN es exactamente cómo se duplica una tabla, así que se
 * midió ANTES: la llave `(folio, doctype)` en la sucursal 00 da **13,552 combinaciones y 0
 * repetidas** incluyendo cancelados. No puede abanicar. Y la compuerta 2 lo vuelve a comprobar
 * contra el total del Árbol en cada aplicación, al centavo.
 *
 * ⛔ El cobro cancelado SÍ se sigue excluyendo, y no es lo mismo: `kdm5` **conserva la aplicación
 * de un cobro cancelado**. Medido: el cobro `0029792` vale $0.00 y su aplicación de **$19,810.54**
 * sigue en el libro, contra la factura `0008789`. Quien lea `kdm5` sin cruzar el estado del cobro
 * sobre-cuenta la cobranza — en esa sola factura, por $19,810.
 *
 * ⚠️ `CREATE OR REPLACE FUNCTION` no puede cambiar el tipo de retorno: va `DROP` + `CREATE`, y los
 * GRANT se re-aplican (no sobreviven al DROP).
 * ⛔ Ni un signo de interrogación en el SQL (GOTCHAS §71).
 *
 * @param { import("knex").Knex } knex
 */

const MEDIO_SQL = `
        CASE WHEN btrim(coalesce(b.c3, '')) = 'EFECTIVO'   THEN 'efectivo'
             WHEN btrim(coalesce(b.c3, '')) ~ '^[0-9]+$'   THEN 'banco'
             WHEN b.c3 IS NOT NULL                         THEN 'ajuste'
             ELSE 'sin_catalogo' END`;

const FN_SQL = `
CREATE FUNCTION analytics.income_bridge_src(p_from date, p_to date)
RETURNS TABLE(
  tenant_id uuid, fecha date, anio_mes text, doc_tipo text, folio text,
  canal text, plaza text, importe numeric, lineas int,
  ligado boolean, es_venta boolean, doc_cancelado boolean,
  cliente_code text, cliente_nombre text, vendedor_code text,
  kind text, es_interno boolean, sucursal_destino text,
  cobrado numeric, pagos int, nota_credito numeric, pendiente numeric,
  efectivo numeric, banco numeric, otro_medio numeric,
  cobrado_en_periodo numeric, pagos_en_periodo int,
  primer_cobro date, ultimo_cobro date, cuentas jsonb)
LANGUAGE sql STABLE AS $fn$
  WITH ing AS (
    SELECT e.tenant_id, e.fecha, e.anio_mes, e.doc_tipo, btrim(e.folio) AS folio,
           e.canal, e.plaza, sum(e.importe) AS importe, count(*)::int AS lineas
      FROM analytics.income_entries_src(p_from, p_to) e
     GROUP BY 1,2,3,4,5,6,7
  ),
  fol AS (SELECT DISTINCT folio FROM ing),
  -- ⭐ El cancelado ENTRA. Su poliza de ingreso existe y hay que poder decir que es; dejarlo
  -- afuera lo convertia en un "sin documento" que no era cierto. La llave (folio, doctype) se
  -- midio unica en la 00 incluyendo cancelados (13,552 / 0 repetidas), asi que no abanica.
  doc AS (
    SELECT btrim(m.c6) AS folio,
           'U' || m.c3 || lpad(m.c4::text, 2, '0') || lpad(m.c5::text, 2, '0') AS dt,
           m.c3 AS grupo, m.c4::numeric AS tipo, m.c5::numeric AS sub,
           btrim(m.c10) AS cliente,
           (btrim(coalesce(m.c43::text, '')) = 'C') AS cancelado
      FROM kepler_ods.kdm1 m
     WHERE m.sucursal = '00' AND m.c2 = 'U'
       AND m.c9::date BETWEEN p_from AND p_to
  ),
  -- El cobro cancelado SI se excluye: kdm5 conserva su aplicacion aunque el cobro valga 0.00.
  pag AS (
    SELECT x.c8 AS g, x.c9 AS t, x.c10 AS s, btrim(x.c11) AS folio,
           x.c12::numeric AS monto, (x.c4 IN (5, 7)) AS es_dinero,
           co.c9::date AS fecha_cobro, btrim(co.c45) AS cuenta, b.c2 AS cuenta_nombre,
           ${MEDIO_SQL} AS medio
      FROM kepler_ods.kdm5 x
      JOIN kepler_ods.kdm1 co
        ON co.sucursal = x.sucursal AND co.c1 = x.c1 AND co.c2 = x.c2 AND co.c3 = x.c3
       AND co.c4::numeric = x.c4 AND co.c5::numeric = x.c5 AND btrim(co.c6) = btrim(x.c6)
      LEFT JOIN kepler_ods.kdb1 b
        ON b.sucursal = x.sucursal AND btrim(b.c1) = btrim(co.c45)
     WHERE x.sucursal = '00' AND x.c2 = 'U' AND x.c3 = 'A'
       AND btrim(coalesce(co.c43::text, '')) <> 'C'
       AND btrim(x.c11) IN (SELECT folio FROM fol)
  ),
  agg AS (
    SELECT g, t, s, folio,
           coalesce(sum(monto) FILTER (WHERE es_dinero), 0)                        AS cobrado,
           count(*) FILTER (WHERE es_dinero)::int                                  AS pagos,
           coalesce(sum(monto) FILTER (WHERE NOT es_dinero), 0)                    AS nota_credito,
           coalesce(sum(monto) FILTER (WHERE es_dinero AND medio = 'efectivo'), 0) AS efectivo,
           coalesce(sum(monto) FILTER (WHERE es_dinero AND medio = 'banco'), 0)    AS banco,
           coalesce(sum(monto) FILTER (WHERE es_dinero
                                         AND medio NOT IN ('efectivo','banco')), 0) AS otro_medio,
           coalesce(sum(monto) FILTER (WHERE es_dinero
                                         AND fecha_cobro BETWEEN p_from AND p_to), 0) AS cobrado_en_periodo,
           count(*) FILTER (WHERE es_dinero
                              AND fecha_cobro BETWEEN p_from AND p_to)::int         AS pagos_en_periodo,
           min(fecha_cobro) FILTER (WHERE es_dinero)                               AS primer_cobro,
           max(fecha_cobro) FILTER (WHERE es_dinero)                               AS ultimo_cobro
      FROM pag GROUP BY 1,2,3,4
  ),
  cta AS (
    SELECT g, t, s, folio,
           jsonb_agg(jsonb_build_object('code', cuenta, 'nombre', cuenta_nombre, 'medio', medio,
                                        'pagos', pagos, 'importe', round(importe, 2))
                     ORDER BY importe DESC) AS cuentas
      FROM (SELECT g, t, s, folio, cuenta, cuenta_nombre, medio,
                   count(*)::int AS pagos, sum(monto) AS importe
              FROM pag WHERE es_dinero GROUP BY 1,2,3,4,5,6,7) z
     GROUP BY 1,2,3,4
  )
  SELECT i.tenant_id, i.fecha, i.anio_mes, i.doc_tipo, i.folio AS folio, i.canal, i.plaza,
         i.importe AS importe, i.lineas AS lineas,
         (d.folio IS NOT NULL)                                   AS ligado,
         (i.doc_tipo = 'UD1301')                                 AS es_venta,
         coalesce(d.cancelado, false)                            AS doc_cancelado,
         d.cliente AS cliente_code, k.cliente_nombre, k.vendedor_code,
         CASE WHEN d.folio IS NULL THEN NULL ELSE coalesce(k.kind, 'sin_catalogo') END AS kind,
         CASE WHEN d.folio IS NULL THEN NULL
              ELSE coalesce(k.kind, 'sin_catalogo') LIKE 'interno%' END           AS es_interno,
         k.sucursal_destino AS sucursal_destino,
         CASE WHEN i.doc_tipo = 'UD1301' THEN coalesce(a.cobrado, 0) END          AS cobrado,
         CASE WHEN i.doc_tipo = 'UD1301' THEN coalesce(a.pagos, 0) END            AS pagos,
         CASE WHEN i.doc_tipo = 'UD1301' THEN coalesce(a.nota_credito, 0) END     AS nota_credito,
         CASE WHEN i.doc_tipo = 'UD1301' AND d.folio IS NOT NULL
              THEN i.importe - coalesce(a.cobrado, 0) - coalesce(a.nota_credito, 0) END AS pendiente,
         CASE WHEN i.doc_tipo = 'UD1301' THEN coalesce(a.efectivo, 0) END         AS efectivo,
         CASE WHEN i.doc_tipo = 'UD1301' THEN coalesce(a.banco, 0) END            AS banco,
         CASE WHEN i.doc_tipo = 'UD1301' THEN coalesce(a.otro_medio, 0) END       AS otro_medio,
         CASE WHEN i.doc_tipo = 'UD1301' THEN coalesce(a.cobrado_en_periodo, 0) END AS cobrado_en_periodo,
         CASE WHEN i.doc_tipo = 'UD1301' THEN coalesce(a.pagos_en_periodo, 0) END AS pagos_en_periodo,
         a.primer_cobro AS primer_cobro, a.ultimo_cobro AS ultimo_cobro,
         coalesce(ct.cuentas, '[]'::jsonb) AS cuentas
    FROM ing i
    LEFT JOIN doc d ON d.folio = i.folio AND d.dt = i.doc_tipo
    LEFT JOIN analytics.v_kepler_customer_kind k
      ON k.sucursal = '00' AND k.cliente_code = d.cliente
    LEFT JOIN agg a ON a.g = d.grupo AND a.t = d.tipo AND a.s = d.sub AND a.folio = i.folio
    LEFT JOIN cta ct ON ct.g = d.grupo AND ct.t = d.tipo AND ct.s = d.sub AND ct.folio = i.folio
$fn$;`;

exports.up = async function up(knex) {
  const [{ ok }] = (await knex.raw(`
    SELECT (to_regclass('kepler_ods.kdm1') IS NOT NULL
        AND to_regclass('kepler_ods.kdm5') IS NOT NULL
        AND to_regclass('analytics.v_kepler_customer_kind') IS NOT NULL) AS ok`)).rows;
  if (!ok) throw new Error('faltan kdm1/kdm5 o v_kepler_customer_kind — sin eso no hay liga');

  // El tipo de retorno gana una columna: CREATE OR REPLACE no alcanza.
  await knex.raw(`DROP FUNCTION IF EXISTS analytics.income_bridge_src(date, date)`);
  await knex.raw(FN_SQL);
  await knex.raw(`GRANT EXECUTE ON FUNCTION analytics.income_bridge_src(date, date) TO app_runtime`);
  await knex.raw(`GRANT EXECUTE ON FUNCTION analytics.income_bridge_src(date, date) TO dev_ro`);

  // ── Compuerta 1: ya no puede quedar NI UNA linea sin documento. Es el punto de la migracion.
  const [c] = (await knex.raw(`
    SELECT count(*)::int AS filas,
           count(*) FILTER (WHERE ligado)::int AS ligadas,
           count(*) FILTER (WHERE doc_cancelado)::int AS canceladas,
           coalesce(sum(importe) FILTER (WHERE doc_cancelado), 0)::numeric AS importe_cancelado
      FROM analytics.income_bridge_src((CURRENT_DATE - 90)::date, CURRENT_DATE)`)).rows;
  if (c.filas > 0 && c.ligadas < c.filas) {
    throw new Error(
      `quedan ${c.filas - c.ligadas} lineas sin documento de ${c.filas} — esta migracion existe `
      + 'justamente para que sean cero; si vuelven a aparecer hay una causa NUEVA que investigar');
  }

  // ── Compuerta 2: quitar un filtro de un JOIN es como se duplica una tabla. Contra el Arbol,
  //    al centavo, que es la unica forma de ver un abanico que no cambia el conteo de filas.
  const [p] = (await knex.raw(`
    WITH a AS (SELECT coalesce(sum(importe), 0)::numeric AS v
                 FROM analytics.income_entries_src((CURRENT_DATE - 90)::date, CURRENT_DATE)),
         b AS (SELECT coalesce(sum(importe), 0)::numeric AS v
                 FROM analytics.income_bridge_src((CURRENT_DATE - 90)::date, CURRENT_DATE))
    SELECT a.v AS arbol, b.v AS puente, abs(a.v - b.v) AS delta FROM a, b`)).rows;
  if (Number(p.delta) > 0.01) {
    throw new Error(
      `el puente dejo de cuadrar con el Arbol: ${p.arbol} vs ${p.puente} (delta ${p.delta}) — `
      + 'incluir los cancelados abanico el JOIN');
  }

  // ── Compuerta 3: ni un signo de interrogacion en el cuerpo (GOTCHAS §71).
  const [{ src }] = (await knex.raw(`
    SELECT p.prosrc AS src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'analytics' AND p.proname = 'income_bridge_src'`)).rows;
  if (String(src).includes('?')) throw new Error('el cuerpo trae un ? — knex lo convierte en $N');

  await knex.raw(`COMMENT ON FUNCTION analytics.income_bridge_src(date, date) IS
    'IG.8 - liga por FOLIO la poliza de ingreso con su documento, su cliente y sus cobros. El documento CANCELADO entra y se marca (doc_cancelado) en vez de declararse "sin documento": con eso la liga es del 100 por ciento. Medido 2026-10-02: 4 documentos cancelados conservan su ingreso publicado por 204,986 pesos, contra 154 de 158 que si lo perdieron.'`);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP FUNCTION IF EXISTS analytics.income_bridge_src(date, date)`);
};
