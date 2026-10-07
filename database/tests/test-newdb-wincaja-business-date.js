/* eslint-disable no-console */
/**
 * [RD.1] CANDADO de la fecha de negocio de Wincaja.
 *
 * ── POR QUÉ ──────────────────────────────────────────────────────────────────────────────
 * RS.12b (20260805240000) cambió la expresión de fecha de wincaja.v_sales_lines por una
 * función IMMUTABLE para poder indexarla, y declaró en su propio comentario:
 *
 *     "El contenedor ya corre en TZ MX, así que fecha::date (sesión) ==
 *      fecha_mx_date(fecha) fila por fila ⇒ business_date NO cambia."
 *
 * La premisa era falsa (el Postgres de prod corre en Etc/UTC) y el business_date de TODA
 * la venta Wincaja quedó corrido un día hacia atrás: 542,684 documentos de 2026, 21
 * sucursales, sin una sola excepción. Nadie lo detectó porque era una migración de
 * performance y no midió el antes/después.
 *
 * Este archivo es la prueba negativa que faltaba. No comprueba que el arreglo esté
 * escrito: comprueba que el DATO se comporta como debe, por dos vías que no dependen de
 * cómo esté implementado.
 *
 * ── LAS SEIS PREGUNTAS ───────────────────────────────────────────────────────────────────
 *  1. ¿La fecha del .mdb sigue llegando a medianoche UTC? (si cambia el importer, cambia
 *     la premisa del arreglo y este candado tiene que revisarse, no ignorarse)
 *  2. ¿business_date == el día que trae el .mdb? — el invariante directo.
 *  3. ¿Las rutas descansan DOMINGO? — el árbitro de negocio. Con la fecha corrida
 *     parecían trabajar domingo y descansar sábado. Un reparto no descansa en sábado.
 *  4. ¿La vista dejó de usar la función que corre el día?
 *  5. ¿Existen los índices por expresión que usa la vista? Sin ellos vuelve el Seq Scan
 *     de 1.44 M filas que RS.12b existía para matar: el arreglo sería correcto y lento.
 *  6. ¿Las matvistas que cuelgan de la vista ya se refrescaron? Una matvista vieja
 *     sirve la fecha corrida aunque la vista ya esté bien.
 *
 * ── TERCER ESTADO ────────────────────────────────────────────────────────────────────────
 * Varios bloques necesitan datos de rutas Wincaja. En un destino sin esa data, "cero
 * documentos en domingo" es cierto y no significa nada; pasarlo como OK es el verde que
 * no midió nada. Se reporta NO MEDIDO y se cuenta aparte.
 *
 *   DATABASE_URL_NEW=… node database/tests/test-newdb-wincaja-business-date.js
 */
const { Client } = require('pg');

const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL
  || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW — la copia local :5433/postgres_platform fue PURGADA 2026-09-08 (ver reference_prod_db_connection_topology)'); })();
const TENANT = process.env.WINCAJA_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';

let ok = 0; let fail = 0; let nm = 0;
const check = (label, cond, detail = '') => {
  if (cond) { ok++; console.log(`  ✔ ${label}`); }
  else { fail++; console.log(`  ✖ ${label}${detail ? ` — ${detail}` : ''}`); }
};
const noMedido = (label, motivo) => { nm++; console.log(`  ⓘ NO MEDIDO · ${label} — ${motivo}`); };

(async () => {
  const db = new Client({
    connectionString: URL,
    statement_timeout: 180000,
    ssl: /rlwy|railway|proxy/i.test(URL) ? { rejectUnauthorized: false } : false,
  });
  await db.connect();
  await db.query('SET default_transaction_read_only = on');
  await db.query(`SET app.tenant_id = '${TENANT}'`);
  console.log(`\n=== [RD.1] fecha de negocio Wincaja · ${URL.replace(/:\/\/[^@]*@/, '://***@')} ===`);

  // ── 1. La premisa: `fecha` es un campo SIN hora ────────────────────────────────────────
  // Access guarda la fecha sin hora (la hora vive aparte, en m.hora, texto serial).
  // El offset con que el importer la materializa NO es el mismo en todos los destinos:
  //   prod  → 2026-01-02 00:00:00+00  (medianoche UTC)
  //   .245  → 2026-08-25 00:00:00-06  (medianoche MX = 06:00 UTC)
  // Leerla en UTC da el día correcto en los DOS casos, porque el instante guardado cae
  // dentro del mismo día UTC que la fecha buscada. Lo que hay que vigilar entonces no es
  // "medianoche UTC" (sería falso en .245) sino lo que el arreglo de verdad necesita:
  // que el campo siga siendo date-only con un offset FIJO, y que ese offset no empuje el
  // instante al día UTC siguiente. Si el importer empezara a escribir horas reales, esta
  // premisa se cae y el arreglo hay que repensarlo — no ignorar este bloque.
  console.log('\n1) La fecha del .mdb sigue siendo un campo sin hora, con offset fijo');
  const { rows: [pre] } = await db.query(`
    SELECT count(*)::int AS filas,
           count(DISTINCT (fecha AT TIME ZONE 'UTC')::time)::int AS horas_distintas,
           max((fecha AT TIME ZONE 'UTC')::time)::text            AS hora_max
    FROM wincaja.maestro_mov_almacen
    WHERE fecha >= now() - interval '400 days'`);
  if (!pre.filas) {
    noMedido('fecha date-only con offset fijo', 'wincaja.maestro_mov_almacen sin filas recientes en este destino');
  } else {
    check(`la hora UTC de fecha toma pocos valores fijos (${pre.horas_distintas} distinta/s en ${pre.filas.toLocaleString()} filas)`,
      pre.horas_distintas <= 2,
      `${pre.horas_distintas} horas distintas — el importer empezó a escribir horas reales`);
    check(`el offset no empuja al día UTC siguiente (hora máx ${pre.hora_max})`,
      pre.hora_max < '12:00:00',
      'con un offset al este de UTC la lectura en UTC caería al día siguiente');
  }

  // ── 2. La expresión no depende del huso de la SESIÓN ───────────────────────────────────
  // Éste es el defecto de fondo de RS.12b: una expresión cuyo resultado cambia con el
  // TimeZone de quien pregunta. `fecha::date` (session-dependent) daba un día en el
  // contenedor MX y otro en la DB UTC — de ahí salió el corrimiento. No sirve comparar
  // business_date contra (fecha AT TIME ZONE 'UTC')::date: después del arreglo eso es la
  // MISMA expresión y el bloque nunca podría fallar (sería un candado circular).
  console.log('\n2) business_date no cambia según el huso de la sesión');
  const busDate = async (tz) => {
    await db.query(`SET TimeZone = '${tz}'`);
    const { rows } = await db.query(`
      SELECT business_date::text AS d, count(*)::int AS n
      FROM wincaja.v_sales_lines
      WHERE business_date >= current_date - 400
      GROUP BY 1 ORDER BY 1`);
    return rows;
  };
  const enUtc = await busDate('UTC');
  const enMx = await busDate('America/Mexico_City');
  await db.query(`SET TimeZone = 'UTC'`);
  if (!enUtc.length && !enMx.length) {
    noMedido('business_date independiente del huso', 'la vista no devolvió filas');
  } else {
    check(`business_date idéntico en UTC y en MX (${enUtc.length} días)`,
      JSON.stringify(enUtc) === JSON.stringify(enMx),
      'la expresión de fecha volvió a depender del TimeZone de la sesión');
  }

  // ── 3. El árbitro de negocio: las rutas descansan domingo ──────────────────────────────
  console.log('\n3) Las rutas de reparto descansan DOMINGO, no sábado');
  const { rows: [dow] } = await db.query(`
    SELECT count(*) FILTER (WHERE extract(dow from sl.business_date) = 0)::int AS domingo,
           count(*) FILTER (WHERE extract(dow from sl.business_date) = 6)::int AS sabado,
           count(*)::int AS total
    FROM wincaja.v_sales_lines sl
    JOIN wincaja.branches b
      ON b.tenant_id = sl.tenant_id AND b.source_branch = sl.source_branch AND b.is_route
    WHERE sl.business_date >= '2026-01-01' AND sl.business_date < '2026-07-01'`);
  if (dow.total < 1000) {
    noMedido('rutas descansan domingo', `sólo ${dow.total} líneas de ruta en ene–jun 2026 en este destino`);
  } else {
    // Con la fecha corrida esto daba domingo 10,189 vs sábado 15. Invertido = el bug volvió.
    check(`domingo (${dow.domingo.toLocaleString()}) es el día muerto, no sábado (${dow.sabado.toLocaleString()})`,
      dow.domingo < dow.sabado,
      'la fecha volvió a correrse: el domingo aparece como día operativo');
  }

  // ── 4. La vista no usa la función que corre el día ─────────────────────────────────────
  console.log('\n4) La vista dejó de usar wincaja.fecha_mx_date()');
  const { rows: [def] } = await db.query(
    "SELECT pg_get_viewdef('wincaja.v_sales_lines'::regclass, true) AS d");
  check('wincaja.v_sales_lines no menciona fecha_mx_date', !/fecha_mx_date/.test(def.d),
    'la vista volvió a la expresión que corre el día');

  // ── 5. Los índices por expresión que la vista realmente usa ────────────────────────────
  console.log('\n5) Los índices por expresión siguen cubriendo la expresión de la vista');
  const usada = /fecha_dia/.test(def.d) ? 'fecha_dia' : (/fecha_mx_date/.test(def.d) ? 'fecha_mx_date' : null);
  if (!usada) {
    noMedido('índices por expresión', 'no reconozco la expresión de fecha de la vista');
  } else {
    const { rows: idx } = await db.query(`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'wincaja' AND tablename = 'maestro_mov_almacen'
        AND indexdef LIKE '%' || $1 || '%'`, [usada]);
    check(`hay índice por expresión sobre ${usada}() (${idx.length})`, idx.length >= 1,
      'sin índice la vista vuelve al Seq Scan de 1.44 M filas — correcta y lenta');
    check(`hay índice parcial para el CTE conc_dates`,
      idx.some((i) => /concentrada/.test(i.indexdef)),
      'el DISTINCT de conc_dates deja de ser index-only');
  }

  // ── 6. Lo materializado no quedó con la fecha vieja ────────────────────────────────────
  // OJO: no se puede comparar el MONTO de la matvista contra el de la vista. La matvista
  // lleva JOIN products y JOIN warehouses (internos) y descarta las líneas cuyo SKU no
  // está en el catálogo o cuya sucursal no tiene almacén — es un universo más chico POR
  // CONSTRUCCIÓN, no por estar vieja. Comparar montos da rojo siempre y no mide nada.
  // El árbitro que sí sirve es el mismo del bloque 3, aplicado a la matvista: si sigue
  // mostrando rutas operando en domingo, es que se materializó con la fecha corrida.
  console.log('\n6) Las matvistas que cuelgan de la vista no quedaron con la fecha vieja');
  const { rows: [mv] } = await db.query(`
    SELECT to_regclass('analytics.mv_wincaja_sales_daily') IS NOT NULL AS existe`);
  if (!mv.existe) {
    noMedido('mv_wincaja_sales_daily al día', 'la matvista no existe en este destino');
  } else {
    const { rows: [mdow] } = await db.query(`
      SELECT count(*) FILTER (WHERE extract(dow from business_date) = 0)::int AS domingo,
             count(*) FILTER (WHERE extract(dow from business_date) = 6)::int AS sabado,
             count(*)::int AS total
      FROM analytics.mv_wincaja_sales_daily
      WHERE channel = 'ruta'
        AND business_date >= '2026-01-01' AND business_date < '2026-07-01'`);
    if (mdow.total < 1000) {
      noMedido('mv_wincaja_sales_daily al día', `sólo ${mdow.total} filas de ruta en ene–jun 2026`);
    } else {
      check(`la matvista tampoco pone a las rutas a trabajar en domingo (dom ${mdow.domingo.toLocaleString()} < sáb ${mdow.sabado.toLocaleString()})`,
        mdow.domingo < mdow.sabado,
        'se materializó con la fecha corrida — falta REFRESH MATERIALIZED VIEW CONCURRENTLY analytics.mv_wincaja_sales_daily');
    }
  }

  await db.end();
  console.log(`\n=== ${ok} OK · ${fail} fallas · ${nm} NO MEDIDOS ===\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\nFATAL:', e.message); process.exit(1); });
