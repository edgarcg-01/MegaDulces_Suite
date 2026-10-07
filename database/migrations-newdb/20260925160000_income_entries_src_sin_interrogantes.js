/**
 * `[IG.0.4]` — **`knex.raw()` se comió los `?` de mis regex y los convirtió en `$1`, `$2`.**
 *
 * La migración `20260925150000` quedó aplicada en prod (batch 541) con el clasificador de canal
 * ROTO. Lo que se instaló fue:
 *
 *     WHEN up ~ '(R\.$1D\.$2|RUTA)\D*\d+' THEN 'ruta'      ← debía decir  (R\.?D\.?|RUTA)
 *
 * `knex.raw(sql)` **parsea `?` como placeholder posicional aunque no le pases bindings**, y los
 * sustituye por `$N`. En una regex de Postgres el `?` es un cuantificador, así que cada `\.?`,
 * `TLMKT?` y `(?:` de mi SQL salió mutilado.
 *
 * ── LO QUE ESTO COSTÓ, MEDIDO ────────────────────────────────────────────────────────────
 * El TOTAL nunca se movió (julio: $56,987,270.38, exacto contra el feed). Lo que se rompió fue el
 * desglose, que es el corazón de la pantalla:
 *
 *   | canal            | instalado (roto) | correcto      |
 *   |------------------|-----------------:|--------------:|
 *   | mostrador        |    $6,324,400.46 | $33,807,924.40 |
 *   | otro (residuo)   |   $39,300,333.58 |  $5,021,917.61 |
 *   | ruta             |      $590,763.82 |  $5,924,473.75 |
 *   | reparto vecinal  |     (desaparece) |  $1,461,182.10 |
 *
 * ── POR QUÉ NO LO VIO LA PRUEBA ──────────────────────────────────────────────────────────
 * Verifiqué la función creándola en `pg_temp` **con `psql`**, y ahí los 5 canales cuadraban al
 * centavo. `psql` no toca los `?`; `knex` sí. O sea que **probé con un ejecutor distinto del que
 * despliega**, y el bug vive exactamente en esa diferencia. Es la misma familia del bug de la Fase
 * CV.7 (allá los `$1` nativos no funcionaban porque knex sólo entiende `?`; acá al revés).
 *
 * Lo atrapó el candado de paridad POR CANAL (`test-newdb-income-parity.js` bloque 2) al correrlo
 * contra la función ya desplegada. El bloque 1 —el total— salió verde: si el candado sólo hubiera
 * comparado totales, esto entraba a producción sin ruido.
 *
 * ── EL ARREGLO ───────────────────────────────────────────────────────────────────────────
 * **Cero `?` en el SQL**, en vez de escaparlos como `\?`. Escapar funciona, pero deja una trampa
 * que el próximo que edite el archivo no puede adivinar; `{0,1}` dice lo mismo y no depende de
 * ninguna convención del cliente que ejecuta. También se retira el grupo no-capturante `(?:…)`:
 * se usa un grupo normal y se lee `[2]`.
 *
 * Idempotente: `CREATE OR REPLACE`.
 *
 * @param { import("knex").Knex } knex
 */
const M = '00000000-0000-0000-0000-00000000d01c';

// ⛔ NI UN `?` acá abajo. `knex.raw` lo convertiría en `$N` y la regex quedaría muda.
//    `\.?` → `\.{0,1}` · `TLMKT?` → `TLMKT{0,1}` · `(?:…)` → grupo normal.
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
       || 'WHERE c3 LIKE ''401%%'' AND coalesce(c5,0) <> 0 '
       || '  AND (c15||c16||lpad(c17::text,2,''0'')||lpad(c18::text,2,''0'')) = ''UD1301'' '
       || '  AND (c14 IS NULL OR btrim(c14) = '''' OR btrim(c14) = ''00'')',
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

exports.up = async function (knex) {
  const ods = await knex.raw(`SELECT to_regclass('kepler_ods.kdm1') AS t`);
  if (!ods.rows[0]?.t) return;

  await knex.raw(FN_SQL);
  await knex.raw(`GRANT EXECUTE ON FUNCTION analytics.income_entries_src(date, date) TO app_runtime`);

  // ── Compuerta: que el cuerpo instalado NO tenga placeholders de knex ────────────────────
  // Sin esto el mismo error vuelve en silencio: la función se crea igual, el total sigue
  // cuadrando y sólo el desglose miente. `$1`/`$2` dentro de un literal de esta función sólo
  // pueden venir de que knex se comió un `?`.
  const { rows } = await knex.raw(
    `SELECT pg_get_functiondef(p.oid) AS src FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'analytics' AND p.proname = 'income_entries_src'`);
  const src = rows?.[0]?.src || '';
  if (/R\\\.\$\d/.test(src) || /\$\d[A-Z]/.test(src)) {
    throw new Error(
      '[IG.0.4] La función quedó con placeholders de knex ($1/$2) adentro de una regex. ' +
      'Revisá que no haya ni un `?` en CANAL_SQL/PLAZA_SQL.');
  }
  // Y que el clasificador de verdad clasifique: si todo cae en `otro`, está roto.
  const { rows: chk } = await knex.raw(
    `SELECT count(DISTINCT canal)::int AS canales
       FROM analytics.income_entries_src((date_trunc('month', now()) - interval '2 months')::date,
                                          current_date)`);
  if ((chk?.[0]?.canales ?? 0) < 2) {
    throw new Error(`[IG.0.4] El clasificador devolvió ${chk?.[0]?.canales} canal(es) distintos — está roto.`);
  }
};

exports.down = async function () {
  // Sin vuelta atrás a propósito: revertir sería reinstalar la versión ROTA.
};
