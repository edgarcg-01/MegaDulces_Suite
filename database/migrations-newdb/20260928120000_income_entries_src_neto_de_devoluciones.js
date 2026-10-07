/**
 * `[IG.4.1]` — **El ingreso pasa a ser NETO de devoluciones.**
 *
 * Hasta acá `income_entries_src()` sólo traía `UD1301` (la venta) y dejaba fuera `UA2501`/`UA2502`
 * «Nota Créd/Dev NoFis POS», que son devoluciones contra la cuenta `403`. Medido sobre 12 meses:
 * **−$1,505,625.79 que el ingreso publicado NO restaba**. Un ingreso que no descuenta lo devuelto
 * está inflado, y punto.
 *
 * ── POR QUÉ EN LA FUENTE Y NO COMO UN KPI APARTE ─────────────────────────────────────────
 * La primera versión de este arreglo iba a publicar «venta bruta» + «devoluciones» + «neto» como
 * tres números separados, **sobre una premisa falsa**: que las devoluciones no se podían atribuir a
 * un canal porque su concepto traía nombre de cliente. Eso salió de mirar un `string_agg` truncado
 * a 70 caracteres, que mostraba los primeros por orden alfabético.
 *
 * Al medirlas por monto, el concepto es **la misma plaza que la venta** (`P.V. Zamora Centro`,
 * `P.V. Padre Hidalgo Piso`, `R.V. PH SALGADO MORALES…`), así que el MISMO clasificador las ubica:
 *
 *     mostrador ....... −$198,220.02   (210 renglones)
 *     reparto vecinal .  −$15,743.39   (6)
 *     otro ............   −$6,555.47   (14)      ← sólo el 3 %
 *
 * Entonces no hace falta partir la pantalla en bruto y neto: la devolución se resta **en su propio
 * canal y su propia plaza**, y la tabla sigue sumando exactamente su KPI. Partirla habría dejado
 * `sum(canales) ≠ total`, que es el defecto que este proyecto ya pagó en otra pantalla.
 *
 * ── EL SIGNO SALE SOLO ───────────────────────────────────────────────────────────────────
 * `importe` ya se calcula como `CASE WHEN c4='A' THEN im ELSE -im END`. Una devolución es un CARGO
 * a la cuenta de ingreso, así que entra negativa sin ninguna regla nueva.
 *
 * ── LO QUE ESTO LE HACE AL CANDADO, Y CÓMO SE RESUELVE ───────────────────────────────────
 * ⚠️ `analytics.sales_by_channel_monthly` —el árbitro— es **sólo `UD1301`**, así que a partir de
 * acá el total ya NO le va a cuadrar: va a diferir exactamente en las devoluciones. Eso **no es un
 * descuadre**, es la corrección. El candado (`test-newdb-income-parity.js`) compara filtrando
 * `doc_tipo = 'UD1301'`, que sigue probando el alcance y el clasificador, y suma una aserción
 * nueva: `neto = bruto + devoluciones`.
 *
 * `UD1201` sigue FUERA a propósito: sus conceptos recientes son rutas y podría ser venta real, pero
 * el decode heredado lo llama «notas» y eso lo dictamina contabilidad, no esta migración.
 * `UD4102` (traspaso a sucursal) también sigue fuera: es mercancía moviéndose adentro de la
 * empresa. Las dos se siguen declarando en la pestaña ¿Cuadra?.
 *
 * ⛔ Ni un `?` en el SQL (`GOTCHAS.md §71`): `knex.raw` los convierte en `$N`.
 *
 * @param { import("knex").Knex } knex
 */
const M = '00000000-0000-0000-0000-00000000d01c';

const CANAL_SQL = `
    CASE
      WHEN up IS NULL OR up = '' THEN 'otro'
      WHEN up ~ '(R\\.{0,1}D\\.{0,1}|RUTA)\\D*\\d+' THEN 'ruta'
      WHEN up ~ '^R\\.{0,1}D\\.{0,1}\\y' OR up ~ 'RD MORELIA' OR up ~ 'R\\.{0,1}D\\.{0,1} MORELIA' THEN 'ruta'
      WHEN up ~ 'TLMKT|TLMK|TELEMK' THEN 'telemarketing'
      WHEN up ~ '^R\\.{0,1}V\\.{0,1}\\y' THEN 'reparto_vecinal'
      WHEN up ~ '^P\\.{0,1}V\\.{0,1}\\y' OR up ~ 'PISO' OR up ~ '^SUCURSAL\\y' THEN 'mostrador'
      WHEN up ~ 'CONTADO' THEN 'contado'
      ELSE 'otro'
    END`;

const PLAZA_SQL = `
    CASE
      WHEN up IS NULL OR up = '' THEN ''
      WHEN up ~ '(R\\.{0,1}D\\.{0,1}|RUTA)\\D*\\d+'
        THEN 'RUTA ' || (regexp_match(up, '(R\\.{0,1}D\\.{0,1}|RUTA)\\D*(\\d+)'))[2]
      WHEN up ~ 'TLMKT|TLMK|TELEMK'
        THEN left(btrim(regexp_replace(regexp_replace(up, 'TLMKT{0,1}|TELEMK\\w*', ''), '\\s+', ' ', 'g')), 40)
      WHEN up ~ '^R\\.{0,1}V\\.{0,1}\\y' THEN left(regexp_replace(up, '^R\\.{0,1}V\\.{0,1}\\s*', ''), 40)
      WHEN up ~ '^P\\.{0,1}V\\.{0,1}\\y' OR up ~ 'PISO' OR up ~ '^SUCURSAL\\y'
        THEN left(regexp_replace(up, '^P\\.{0,1}V\\.{0,1}\\s*', ''), 40)
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
       || 'WHERE coalesce(c5,0) <> 0 '
       -- Regla 1: sólo CEDIS. Las 6 DBs de sucursal REPLICAN esta misma venta.
       || '  AND (c14 IS NULL OR btrim(c14) = '''' OR btrim(c14) = ''00'') '
       -- Regla 2, ahora en DOS piernas: la VENTA (UD1301 contra 401) y su DEVOLUCIÓN (UA25xx
       -- contra 4xx, que en la práctica es 403). La devolución entra como cargo, o sea negativa.
       || '  AND ( ((c15||c16||lpad(c17::text,2,''0'')||lpad(c18::text,2,''0'')) = ''UD1301'' '
       || '         AND c3 LIKE ''401%%'') '
       || '     OR ((c15||c16||lpad(c17::text,2,''0'')||lpad(c18::text,2,''0'')) LIKE ''UA25%%'' '
       || '         AND c3 LIKE ''4%%'') )',
          ym, tbl);
    END IF;
    cur := (cur + interval '1 month')::date;
  END LOOP;
  IF parts = '' THEN RETURN; END IF;

  RETURN QUERY EXECUTE format($q$
    WITH raw AS (%s)
    SELECT '${M}'::uuid, fe, ym, dt, fo, li, cta, cp,
           ${CANAL_SQL} AS canal,
           ${PLAZA_SQL} AS plaza,
           ca,
           CASE WHEN ca = 'A' THEN im ELSE -im END
      FROM raw
     WHERE fe BETWEEN %L AND %L
       AND (up IS NULL OR up !~ 'BAJA|CANCELAD|P[ÓO]LIZA CANC')
  $q$, parts, p_from, p_to);
END $fn$;`;

// `income_out_of_scope` deja de reportar las devoluciones como «fuera»: ya entran al total. Sigue
// declarando lo que de verdad queda afuera (UD1201 y los traspasos UD4102).
const OOS_SQL = `
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
       || 'WHERE c3 LIKE ''4%%'' AND coalesce(c5,0) <> 0 '
       || '  AND (c14 IS NULL OR btrim(c14) = '''' OR btrim(c14) = ''00'') '
       || '  AND (c15||c16||lpad(c17::text,2,''0'')||lpad(c18::text,2,''0'')) <> ''UD1301'' '
       || '  AND (c15||c16||lpad(c17::text,2,''0'')||lpad(c18::text,2,''0'')) NOT LIKE ''UA25%%''',
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

  await knex.raw(FN_SQL);
  await knex.raw(OOS_SQL);
  await knex.raw(`GRANT EXECUTE ON FUNCTION analytics.income_entries_src(date, date) TO app_runtime`);
  await knex.raw(`GRANT EXECUTE ON FUNCTION analytics.income_out_of_scope(date, date) TO app_runtime`);

  // ── Compuertas ──────────────────────────────────────────────────────────────────────────
  // 1. `[IG.0.4]`: ninguna regex puede traer placeholders de knex.
  const { rows: def } = await knex.raw(
    `SELECT string_agg(pg_get_functiondef(p.oid), E'\\n') AS src FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'analytics' AND p.proname IN ('income_entries_src', 'income_out_of_scope')`);
  if (/~ '[^']*\$\d/.test(def?.[0]?.src || '')) {
    throw new Error('[IG.4.1] Quedó un placeholder de knex adentro de una regex.');
  }

  // 2. Las devoluciones tienen que estar ADENTRO y ser negativas — si no, el arreglo no llegó.
  const { rows: chk } = await knex.raw(
    `SELECT COALESCE(SUM(importe) FILTER (WHERE doc_tipo LIKE 'UA25%'), 0)::numeric AS dev,
            COUNT(*) FILTER (WHERE doc_tipo LIKE 'UA25%')::int AS n
       FROM analytics.income_entries_src((date_trunc('month', now()) - interval '2 months')::date,
                                          current_date)`);
  if ((chk?.[0]?.n ?? 0) === 0) {
    throw new Error('[IG.4.1] La fuente no está trayendo ninguna devolución UA25xx.');
  }
  if (Number(chk?.[0]?.dev ?? 0) >= 0) {
    throw new Error(`[IG.4.1] Las devoluciones entraron con signo POSITIVO (${chk?.[0]?.dev}) — sumarían en vez de restar.`);
  }

  await knex.raw(`COMMENT ON FUNCTION analytics.income_entries_src(date, date) IS
    'IG.4.1 — Ingreso contable NETO derive-no-copy sobre kepler_ods.kdc2YYMM. Tres reglas duras: solo CEDIS '
    '(c14), venta = UD1301 contra 401, devolucion = UA25xx contra 4xx (entra negativa, se clasifica en su '
    'mismo canal y plaza), canal por c6 porque el nombre de la subcuenta MIENTE. ⚠️ Ya NO cuadra contra '
    'sales_by_channel_monthly, que es solo UD1301: difiere exactamente en las devoluciones, y eso es la '
    'correccion, no un descuadre. Ver FASE_IG_INGRESOS_CONTABLES.md.'`);
};

exports.down = async function () {
  // Sin vuelta atrás: revertir es volver a publicar un ingreso que no resta lo devuelto.
};
