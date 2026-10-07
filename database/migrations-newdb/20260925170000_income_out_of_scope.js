/**
 * `[IG.3.1]` — **`analytics.income_out_of_scope(from,to)`: lo que el ingreso DEJA FUERA.**
 *
 * Nace de una pregunta que el candado de paridad **no puede contestar**: *«¿no nos estamos
 * saltando ningún tipo de ingreso?»*. El candado compara `income_entries_src()` contra
 * `sales_by_channel_monthly`, y ese feed usa **las mismas tres reglas** — así que es un espejo, no
 * un árbitro del ALCANCE (ADR-059 regla 5: un árbitro que nunca contradice es un espejo).
 *
 * ── LO QUE SE MIDIÓ PARA ESCRIBIR ESTO (prod, 2026-09-25) ────────────────────────────────
 *
 * **1. Los asientos de familia 4 de las sucursales (~$23.3M en julio) SON duplicado.** Contra el
 * testigo independiente (`mv_sales_blended`, julio):
 *
 *     sólo CEDIS ......... $56,987,270   vs hecho de venta $54,661,889  → **+4.3 %**  ✅
 *     CEDIS + sucursales . $80,288,953   vs hecho de venta $54,661,889  → **+46.9 %** ⛔
 *
 * O sea que la regla «sólo CEDIS» está bien y excluirlos NO es saltarse ingreso. (El folio no
 * sirve para probarlo: cada sucursal re-folia su copia, así que 3,419 de 3,437 renglones "no
 * están en CEDIS" por número y sí lo están por hecho.)
 *
 * **2. `701 PRODUCTOS FINANCIEROS` no tiene movimientos.** Es ingreso y los egresos lo excluyen a
 * propósito, así que valía la pena mirarlo: está vacío. No se pierde nada.
 *
 * **3. Sí queda algo afuera, y son tres cosas distintas** (12 meses, CEDIS, familia 4, fuera de
 * `UD1301`):
 *
 *   · `UA2501`/`UA2502` «Nota Créd/Dev NoFis POS» → **−$1,505,625.79 que NO se restan.** El
 *     ingreso publicado está inflado en ese monto. Es lo que hace que algunos meses den negativo
 *     al medir «fuera de alcance».
 *   · `UD1201` «Factura Cont No Fiscal» → **$4,809,937.99 que NO se suman.** El decode heredado lo
 *     descarta como «notas», pero sus conceptos recientes son rutas (`R.D. 21 PH Urbano Olivares`,
 *     `R.D. 22 PH Fuentes Montes`), que parecen venta real. ⚠️ **No se afirma**: necesita que
 *     contabilidad lo dictamine.
 *   · `UD4102` «Embarque Sucursal» con concepto `TRASPASO A SUCURSAL…` → **bien excluido** (es
 *     mercancía moviéndose dentro de la empresa, $5.89M en agosto), pero **nadie lo decía**, y
 *     quien cuadre contra la balanza —que sí los tiene— los va a ir a buscar.
 *
 * ── POR QUÉ SE DECLARA Y NO SE CORRIGE ───────────────────────────────────────────────────
 * Restar las devoluciones cambia el número publicado **y lo separa del feed nocturno**, que hoy es
 * el árbitro del candado. Eso es una decisión de negocio con consecuencias en dos lugares, no un
 * arreglo técnico. ADR-056: lo que no se puede decidir acá se DECLARA con su monto, no se dibuja
 * como cero ni se corrige en silencio.
 *
 * ⛔ Ni un `?` en el SQL (ver `GOTCHAS.md §71`): `knex.raw` los convierte en `$N`.
 *
 * @param { import("knex").Knex } knex
 */
const FN_SQL = `
CREATE OR REPLACE FUNCTION analytics.income_out_of_scope(p_from date, p_to date)
RETURNS TABLE(fecha date, dt text, cuenta text, concepto text, v numeric)
LANGUAGE plpgsql STABLE AS $fn$
DECLARE
  parts text := '';
  tbl text; cur date;
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to THEN RETURN; END IF;
  cur := date_trunc('month', p_from)::date;
  WHILE cur <= p_to LOOP
    tbl := 'kdc2' || to_char(cur, 'YYMM');
    IF to_regclass('kepler_ods.' || tbl) IS NOT NULL THEN
      parts := parts || (CASE WHEN parts = '' THEN '' ELSE ' UNION ALL ' END) ||
        format(
          'SELECT c2::date fe, '
       || '(c15||c16||lpad(c17::text,2,''0'')||lpad(c18::text,2,''0'')) dt, '
       || 'btrim(c3) cta, btrim(c6) cp, '
       || 'CASE WHEN c4 = ''A'' THEN c5::numeric ELSE -c5::numeric END im '
       || 'FROM kepler_ods.%I '
       -- Mismo universo que el ingreso (familia 4 + sólo CEDIS) pero TODO lo que NO es UD1301.
       || 'WHERE c3 LIKE ''4%%'' AND coalesce(c5,0) <> 0 '
       || '  AND (c14 IS NULL OR btrim(c14) = '''' OR btrim(c14) = ''00'') '
       || '  AND (c15||c16||lpad(c17::text,2,''0'')||lpad(c18::text,2,''0'')) <> ''UD1301''',
          tbl);
    END IF;
    cur := (cur + interval '1 month')::date;
  END LOOP;
  IF parts = '' THEN RETURN; END IF;

  RETURN QUERY EXECUTE format($q$
    SELECT fe, dt, cta, cp, im FROM (%s) x WHERE fe BETWEEN %L AND %L
  $q$, parts, p_from, p_to);
END $fn$;`;

exports.up = async function (knex) {
  const ods = await knex.raw(`SELECT to_regclass('kepler_ods.kdm1') AS t`);
  if (!ods.rows[0]?.t) return;

  await knex.raw(`CREATE SCHEMA IF NOT EXISTS analytics`);
  await knex.raw(FN_SQL);
  await knex.raw(`GRANT EXECUTE ON FUNCTION analytics.income_out_of_scope(date, date) TO app_runtime`);

  // Compuerta de `[IG.0.4]`: ninguna regex del cuerpo puede traer placeholders de knex.
  const { rows } = await knex.raw(
    `SELECT pg_get_functiondef(p.oid) AS src FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'analytics' AND p.proname = 'income_out_of_scope'`);
  if (/~ '[^']*\$\d/.test(rows?.[0]?.src || '')) {
    throw new Error('[IG.3.1] La función quedó con placeholders de knex adentro de una regex.');
  }

  await knex.raw(`COMMENT ON FUNCTION analytics.income_out_of_scope(date, date) IS
    'IG.3.1 — lo que el alcance del ingreso DEJA FUERA: devoluciones UA25xx (no se restan), UD1201 Factura '
    'Contado No Fiscal (no se suma, decode heredado en duda) y UD4102 traspasos a sucursal (bien excluidos, '
    'pero la balanza SI los tiene). Se declara, no se corrige: restar devoluciones separa el numero del feed '
    'nocturno que hoy es el arbitro. Ver FASE_IG_INGRESOS_CONTABLES.md.'`);
};

exports.down = async function (knex) {
  await knex.raw(`DROP FUNCTION IF EXISTS analytics.income_out_of_scope(date, date)`);
};
