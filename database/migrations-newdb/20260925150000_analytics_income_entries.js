/**
 * `[IG.0.1]` — **Ingresos contables `derive-no-copy`**: `analytics.income_entries_src(from,to)` +
 * la vista `analytics.v_income_entries`. Cero importer nuevo (⭐ regla del proyecto).
 *
 * ── LAS TRES REGLAS DURAS, Y POR QUÉ ESTÁN ADENTRO DE LA FUNCIÓN ─────────────────────────
 * Decodificadas y verificadas en `docs/IMPLEMENTACION/KEPLER_CONTABILIDAD_MODELO.md` §Familia 4.
 * Van en la fuente, no en cada consumidor, porque saltárselas no da un error: da un número mayor.
 * Medido en prod (agosto-2026):
 *
 *   balanza familia 4, TODAS las sucursales ....... $94,061,828.00   ← el espejo ingenuo, +69 %
 *   sólo CEDIS .................................... $61,903,631.74
 *   sólo CEDIS + sólo UD1301 (esto) ...............  $55,940,323.96
 *   mv_sales_blended (testigo independiente) ......  $54,265,356.22   ← cuadra al 3.0 %
 *
 *   1. **Sólo CEDIS** (`c14` nulo/vacío/'00'). La venta se contabiliza CENTRALIZADA en CEDIS con
 *      todas las plazas en el concepto `c6`; las DBs de sucursal REPLICAN esas mismas ventas, así
 *      que sumar las 6 duplica ~$62M. La cobranza `UA0501` sólo cuadra con CEDIS.
 *   2. **Sólo `UD1301`** («Factura Cred No Fiscal», confirmado contra `kdmm`). Los otros doctypes
 *      en 401 (`UD1201` notas, `0000`, `XA1001` bajas) NO son venta.
 *   3. **El canal se clasifica por `c6`, NUNCA por el nombre de la subcuenta.** `401-002` —que
 *      concentra todo el detalle 2026— se llama «VENTA FLETES A TERCEROS» y no es fletes;
 *      `401-003` es «VENTAS VECINAL» en unas sucursales y «VENTAS MAYOREO» en otras.
 *
 * ⚠️ **Hipótesis REFUTADA, anotada para que nadie la reconstruya.** Las contrapartes del renglón
 * más grande son «P.V. Morelia Abastos», «TLMKT Canindo»… y la lectura obvia es «el CEDIS le
 * factura a sus sucursales, hay que excluirlo como traspaso interno» (el Fix#B de los egresos).
 * **Es falso:** eso es la PLAZA donde se vendió al público. Excluirlo borraría venta real.
 *
 * ── POR QUÉ VISTA VIVA Y NO MATVIEW (a diferencia de `bank_postings`) ────────────────────
 * `bank_postings` se materializó porque su filtro (todo el 102) trae 44,770 filas y el fan-out
 * costaba 2.8 s. Acá el filtro es mucho más selectivo —UD1301 + 401— y el fan-out sobre las **21**
 * `kdc2` del ODS **cuesta 72 ms / 8,030 filas (medido en prod)**. Materializar sería pagar un
 * refresco y perder frescura para ganar nada. Y la función acepta rango: con el default de la
 * pantalla (90 d) enumera 4 tablas, no 21.
 *
 * ── PARIDAD CONTRA EL FEED QUE YA ESTABA VALIDADO ───────────────────────────────────────
 * `analytics.sales_by_channel_monthly` (que llena `import-sales-by-channel.js` leyendo las
 * RÉPLICAS) es el árbitro. El port SQL de su `classify()` se verificó contra él en prod:
 *
 *   feb · mar · abr · may · jun · jul 2026 → **delta $0.00 EXACTO** (6 meses cerrados)
 *   ago 2026 → +$77,131.36 (el ODS va adelante: 4 renglones capturados después del corte nocturno)
 *   sep 2026 → **−$793,318.13** (el ODS va ATRÁS: le faltan renglones — síntoma de `AUD-ODS-01`)
 *
 * O sea: **ninguna de las dos fuentes domina a la otra**, y por eso la pantalla no elige una y
 * calla. Sirve de acá (grano diario, frescura de CDC) y DECLARA el delta contra el feed nocturno.
 * El candado `test-newdb-income-parity.js` afirma el $0.00 de los meses cerrados —que es lo que
 * prueba que la lógica es correcta— y sólo DECLARA el del mes vivo.
 *
 * ⚠️ El `classify()` queda implementado DOS veces (JS en el importer, SQL acá). Es deliberado: el
 * importer lee réplicas que no son esta base, así que no hay forma de compartir una sola
 * implementación sin acoplarlos. La mitigación no es un comentario: es el candado de paridad, que
 * se pone rojo el día que diverjan.
 *
 * Aditiva. No toca ninguna tabla. `analytics` no lleva RLS (filtro de tenant explícito en el
 * servicio, mismo patrón que `expense_entries`).
 *
 * @param { import("knex").Knex } knex
 */
const M = '00000000-0000-0000-0000-00000000d01c';

// Port del `classify()` de import-sales-by-channel.js. El ORDEN importa: los prefijos de canal
// ganan, y CONTADO y el residuo con nombre de cliente quedan al final.
// ⚠️ En Postgres el límite de palabra es `\y`, NO `\b` (que adentro de un bracket es backspace).
const CANAL_SQL = `
    CASE
      WHEN up IS NULL OR up = '' THEN 'otro'
      WHEN up ~ '(R\\.?D\\.?|RUTA)\\D*\\d+' THEN 'ruta'
      WHEN up ~ '^R\\.?D\\.?\\y' OR up ~ 'RD MORELIA' OR up ~ 'R\\.?D\\.? MORELIA' THEN 'ruta'
      WHEN up ~ 'TLMKT|TLMK|TELEMK' THEN 'telemarketing'
      WHEN up ~ '^R\\.?V\\.?\\y' THEN 'reparto_vecinal'
      WHEN up ~ '^P\\.?V\\.?\\y' OR up ~ 'PISO' OR up ~ '^SUCURSAL\\y' THEN 'mostrador'
      WHEN up ~ 'CONTADO' THEN 'contado'
      ELSE 'otro'
    END`;

// La plaza sale del MISMO texto, quitándole el prefijo de canal. `regexp_replace` sin la bandera
// 'g' reemplaza sólo la primera ocurrencia, igual que `String.replace` con un regex sin /g.
const PLAZA_SQL = `
    CASE
      WHEN up IS NULL OR up = '' THEN ''
      WHEN up ~ '(R\\.?D\\.?|RUTA)\\D*\\d+' THEN 'RUTA ' || (regexp_match(up, '(?:R\\.?D\\.?|RUTA)\\D*(\\d+)'))[1]
      WHEN up ~ 'TLMKT|TLMK|TELEMK'
        THEN left(btrim(regexp_replace(regexp_replace(up, 'TLMKT?|TELEMK\\w*', ''), '\\s+', ' ', 'g')), 40)
      WHEN up ~ '^R\\.?V\\.?\\y' THEN left(regexp_replace(up, '^R\\.?V\\.?\\s*', ''), 40)
      WHEN up ~ '^P\\.?V\\.?\\y' OR up ~ 'PISO' OR up ~ '^SUCURSAL\\y'
        THEN left(regexp_replace(up, '^P\\.?V\\.?\\s*', ''), 40)
      ELSE left(up, 40)
    END`;

const FN_SQL = `
CREATE OR REPLACE FUNCTION analytics.income_entries_src(p_from date, p_to date)
RETURNS TABLE(tenant_id uuid, fecha date, anio_mes text, doc_tipo text, folio text, linea int,
              cuenta text, concepto text, canal text, plaza text, cargo_abono text, importe numeric)
LANGUAGE plpgsql STABLE AS $fn$
DECLARE
  parts text := '';
  tbl text; ym text; cur date;
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to THEN RETURN; END IF;
  -- Enumera SÓLO los meses del rango que existen en el ODS. Acotar acá es lo que hace barata a la
  -- vista: el default de la pantalla toca 4 tablas, no las 21.
  cur := date_trunc('month', p_from)::date;
  WHILE cur <= p_to LOOP
    tbl := 'kdc2' || to_char(cur, 'YYMM');
    ym  := to_char(cur, 'YYYY-MM');
    IF to_regclass('kepler_ods.' || tbl) IS NOT NULL THEN
      parts := parts || (CASE WHEN parts = '' THEN '' ELSE ' UNION ALL ' END) ||
        format(
          'SELECT c2::date fe, %L::text ym, '
       || '(c15||c16||lpad(c17::text,2,''0'')||lpad(c18::text,2,''0'')) dt, '
       || 'coalesce(nullif(btrim(c19),''''),''0'') fo, coalesce(c10,0)::int li, btrim(c3) cta, '
       || 'btrim(c6) cp, upper(btrim(c6)) up, c4 ca, c5::numeric im '
       || 'FROM kepler_ods.%I '
       -- Regla 1 (sólo CEDIS) + regla 2 (sólo UD1301) + cuenta de ingreso, todas acá.
       || 'WHERE c3 LIKE ''401%%'' AND coalesce(c5,0) <> 0 '
       || '  AND (c15||c16||lpad(c17::text,2,''0'')||lpad(c18::text,2,''0'')) = ''UD1301'' '
       || '  AND (c14 IS NULL OR btrim(c14) = '''' OR btrim(c14) = ''00'')',
          ym, tbl);
    END IF;
    cur := (cur + interval '1 month')::date;
  END LOOP;
  IF parts = '' THEN RETURN; END IF;

  -- ⚠️ CANAL_SQL y PLAZA_SQL van INTERPOLADOS en el template de JS, no como argumentos de
  -- \`format()\`. Pasarlos por \`%s\` obliga a citarlos desde JS, y \`JSON.stringify\` produce comillas
  -- DOBLES: Postgres las lee como IDENTIFICADOR y falla con «column "…CASE…" does not exist».
  -- (Lo destapó la prueba en \`pg_temp\`, no el build.) Son constantes de nuestro propio código —
  -- nunca entrada del usuario— así que interpolarlas es seguro; lo que sí viaja por \`format()\` es
  -- el rango, con \`%L\`.
  RETURN QUERY EXECUTE format($q$
    WITH raw AS (%s)
    SELECT '${M}'::uuid, fe, ym, dt, fo, li, cta, cp,
           ${CANAL_SQL} AS canal,
           ${PLAZA_SQL} AS plaza,
           ca,
           -- Neto acreedor: el abono suma, el cargo (nota/devolución del mismo documento) resta.
           CASE WHEN ca = 'A' THEN im ELSE -im END
      FROM raw
     WHERE fe BETWEEN %L AND %L
       -- Bajas y pólizas canceladas fuera (mismo criterio que el importer, que devuelve null).
       AND (up IS NULL OR up !~ 'BAJA|CANCELAD|P[ÓO]LIZA CANC')
  $q$, parts, p_from, p_to);
END $fn$;`;

exports.up = async function (knex) {
  const ods = await knex.raw(`SELECT to_regclass('kepler_ods.kdm1') AS t`);
  if (!ods.rows[0]?.t) return; // entorno sin réplica ERP: no hay nada que derivar

  await knex.raw(`CREATE SCHEMA IF NOT EXISTS analytics`);
  await knex.raw(FN_SQL);
  await knex.raw(`GRANT EXECUTE ON FUNCTION analytics.income_entries_src(date, date) TO app_runtime`);

  // Vista de conveniencia (24 meses hacia atrás) para consultas ad-hoc, Maat y los candados. La
  // pantalla NO la usa: llama a la función con su rango, que es lo que la hace barata.
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_income_entries AS
    SELECT * FROM analytics.income_entries_src(
      (date_trunc('month', now()) - interval '23 months')::date,
      current_date)`);
  // ⚠️ `security_invoker` y el GRANT NO se heredan tras un CREATE OR REPLACE VIEW: se re-aplican
  // siempre (una migración de la Fase U perdió esto y sólo lo vio la aserción de metadata).
  await knex.raw(`ALTER VIEW analytics.v_income_entries SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON analytics.v_income_entries TO app_runtime`);

  await knex.raw(`COMMENT ON FUNCTION analytics.income_entries_src(date, date) IS
    'IG.0.1 — Ingreso contable derive-no-copy sobre kepler_ods.kdc2YYMM. Las tres reglas duras van adentro: '
    'solo CEDIS (c14), solo UD1301, canal por c6 (el nombre de la subcuenta MIENTE). Port verificado del '
    'classify() de import-sales-by-channel.js: delta $0.00 exacto contra sales_by_channel_monthly en los 6 '
    'meses cerrados feb-jul 2026. Sin las reglas el numero sube +69%. Ver FASE_IG_INGRESOS_CONTABLES.md.'`);
};

exports.down = async function (knex) {
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_income_entries`);
  await knex.raw(`DROP FUNCTION IF EXISTS analytics.income_entries_src(date, date)`);
};
