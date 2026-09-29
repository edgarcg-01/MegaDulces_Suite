/* eslint-disable no-console */
/**
 * [VP.1.2] CANDADO del sell-out — el test de paridad que el código AFIRMABA que existía.
 *
 * ── POR QUÉ ──────────────────────────────────────────────────────────────────────────────
 * `database/migrations-newdb/20260904100000_v_sellout_daily.js` dice, textual:
 *
 *     // VERBATIM del service — si tocás uno, tocá el otro (test de paridad lo verifica).
 *     ... un test de regresión asegura que empatan (si divergen, alguien tocó uno solo).
 *
 * No existía. Grep de `v_sellout_daily` en todo el repo: 6 hits, ninguno un archivo de prueba. El
 * reporte más consultado del negocio iba de la migración a la pantalla sin tocar una sola aserción,
 * y su dedup Kepler↔Wincaja es un predicado de FECHAS escrito a mano en varios archivos. Si alguien
 * mueve una fecha de corte en un lado, la sucursal 01 en julio-2026 se cuenta dos veces —o cero— y
 * nada lo detecta. Ya pasó: dos commits de esta misma superficie dicen "recupera $8.07M/mes" y
 * "$4.44M/mes que la copia tiraba".
 *
 * ── LAS CUATRO PREGUNTAS ─────────────────────────────────────────────────────────────────
 *  1. ¿El corte sale del RESOLVEDOR, y este archivo lo LEE en vez de copiarlo?
 *  2. ¿El dedup no DUPLICA? (ninguna sucursal-día PUBLICADA por las dos fuentes) — con prueba
 *     negativa, porque un detector que nunca contradice es un espejo.
 *  3. El HUECO no se mide acá: se delega — y se comprueba que el delegado CORRA.
 *  4. ¿El rollup mensual empata con la vista diaria, al peso, en meses cerrados?
 *
 * ── [VSO.7] QUÉ CAMBIÓ, Y POR QUÉ ERA PEOR DE LO QUE EL TRACKER DECÍA ────────────────────
 * El tracker anotaba una sola falla: *"el bloque del HUECO es de PRESENCIA (`count>0` de cada
 * lado), da ✔ con 9 días de hueco"*. Cierto, y había una segunda debajo que la explicaba:
 *
 *   ⛔ Este archivo llevaba su PROPIA copia del corte en una constante `CUTOVER`, y desde
 *      [VSO.3] estaba VIEJA en dos de tres — decía `01 → 2026-07-01` (el dato dice `06-27`) y
 *      `02 → 2025-10-01` (dice `10-10`) — y no conocía ni a Morelia Madero `07` ni a Abastos
 *      `08`, o sea las dos sucursales que migraron después de que se escribió.
 *
 * Los dos defectos se PROTEGÍAN: con el corte equivocado, preguntar "¿hay ALGUNA venta de cada
 * lado?" sigue dando ✔, porque sobra Wincaja antes de julio y sobra Kepler después. La prueba
 * débil volvía invisible a la constante vieja. Por eso no alcanzaba con arreglar una.
 *
 * `test-newdb-branch-cutover.js` ([SB.1]) ya había NOMBRADO esta constante como una de las tres
 * copias desincronizadas… y arregló las otras dos. Ésta quedó viva ocho días más.
 *
 *  · El corte ahora se LEE de `analytics.v_branch_erp_cutover` (8 cortes, no 3).
 *  · El bloque de DUPLICADO gana las 5 sucursales que le faltaban — y una PRUEBA NEGATIVA, que
 *    no tenía: adultera el mapa a propósito y exige que el detector encuentre el choque.
 *  · El bloque de HUECO se RETIRA y se delega — con la delegación COMPROBADA, no prometida:
 *    se verifica que el delegado esté registrado en el runner. Delegar en algo que no corre es
 *    borrar la prueba y llamarlo refactor.
 *
 * ── POR QUÉ HAY UN TERCER ESTADO ─────────────────────────────────────────────────────────
 * Los bloques 2-4 necesitan datos de las DOS piernas. En un destino donde `mv_wincaja_sales_daily`
 * está vacía, "cero traslapes" es cierto y no significa nada. Pasarlo como ✔ es exactamente el
 * patrón que esta fase persigue —el verde que no midió nada—, así que se reporta **NO MEDIDO** y se
 * cuenta aparte. Un run limpio en un destino sin datos dice "3 OK · 0 fallas · 4 NO MEDIDOS", que se
 * lee como lo que es.
 *
 *   DATABASE_URL_NEW=… node database/tests/test-newdb-sellout-parity.js
 */
const { Client } = require('pg');
const path = require('path');
const fs = require('fs');

const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL
  || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW — la copia local :5433/postgres_platform fue PURGADA 2026-09-08 (ver reference_prod_db_connection_topology)'); })();

// [VSO.7] Acá vivía la constante `CUTOVER`. No se reemplazó por una constante mejor: se reemplazó
// por una LECTURA de `analytics.v_branch_erp_cutover`. Una copia al día de hoy vuelve a envejecer
// el día que alguien mueva un corte — que es exactamente lo que pasó, dos veces, en [VSO.3].

/** El delegado del bloque de HUECO. Si no corre, delegar en él es borrar la prueba. */
const DELEGADO = 'test-newdb-branch-cutover.js';

/**
 * [VSO.7] Desfases del ROLLUP declarados — **con fecha de vencimiento**.
 *
 * El rollup es una FOTO y la vista es el VIVO: cuando algo cambia el pasado (mover un corte,
 * recalcular una pierna), los dos dejan de empatar hasta que corre el refresh. Ese desfase es
 * real y es temporal, y las dos cosas importan:
 *
 *   · Dejarlo en ROJO sería una alarma que nadie puede apagar hasta mañana — y una alarma que no
 *     se puede apagar enseña a ignorar el tablero. Esta fase ya pagó esa lección dos veces.
 *   · Silenciarlo sería esconder una diferencia de verdad.
 *
 * Por eso se DECLARA con monto, razón medida y **`vence`**. Antes de `vence` es NO MEDIDO (se
 * imprime, no se cuenta como ✔). Después de `vence` la entrada queda INERTE: si el desfase sigue
 * ahí, el candado se pone rojo, porque entonces el refresh ya corrió y no lo arregló.
 *
 * ⭐ Es una declaración que NO puede envejecer en silencio: se apaga sola o grita sola.
 */
const DESFASES_DECLARADOS = [
  {
    mes: '2026-06', monto: 916629.73,
    // El refresh nocturno `analytics_refresh_sellout_monthly` corre ~06:28 MX (12:28 UTC).
    vence: '2026-09-29T14:00:00Z',
    razon: '[VSO.3] movió el corte de Padre Hidalgo de 2026-07-01 a 2026-06-27 (mig 558, aplicada '
      + 'el 2026-09-28 a las 13:42 MX). El refresh del rollup de ESE día ya había corrido a las '
      + '06:28, o sea ANTES: la vista publica los 4 días recuperados y el rollup todavía no. '
      + 'Mismo monto medido a mano, vista contra rollup, el 2026-09-28.',
  },
];

let ok = 0; let fail = 0; let nm = 0;
const check = (label, cond, detail = '') => {
  if (cond) { ok++; console.log(`  ✔ ${label}`); }
  else { fail++; console.log(`  ✖ ${label}${detail ? ` — ${detail}` : ''}`); }
};
/** Ni ✔ ni ✖: no se pudo medir. Se cuenta aparte para que el resumen no mienta. */
const noMedido = (label, motivo) => { nm++; console.log(`  ⓘ NO MEDIDO · ${label} — ${motivo}`); };

/**
 * [VSO.7] Una medición cara que el destino corta por tiempo es **NO MEDIDO**, no una falla.
 *
 * Antes no había red: el `statement_timeout` tiraba la promesa, el `.catch` de abajo imprimía
 * `ERR canceling statement due to statement timeout` y el proceso salía con 1 — indistinguible de
 * "el sell-out está doble-contando". Peor: mataba los bloques que SÍ habrían podido medirse. Un
 * timeout es exactamente el tercer estado que este archivo inventó; le faltaba aplicárselo a sí
 * mismo.
 */
const medir = async (label, fn) => {
  try { return await fn(); } catch (e) {
    if (!/statement timeout|canceling statement/i.test(e.message)) throw e;
    noMedido(label, 'la consulta no terminó dentro del statement_timeout de este destino. '
      + 'No es ✔ ni ✖: no se pudo medir.');
    return null;
  }
};

const RAIZ = path.join(__dirname, '..', '..');
const leer = (rel) => { try { return fs.readFileSync(path.join(RAIZ, rel), 'utf8'); } catch { return null; } };

// ⛔ [VSO.7] Acá vivía `fechasPorSucursal()`, que sacaba las fechas de corte del SQL de las
// migraciones con un regex. Se retira entera: desde [SB.1] el corte no está en ese SQL, así que
// la función buscaba una forma que ya no existe y devolvía `{}` — y el bloque que la usaba se
// ponía verde por no encontrar nada. `${DELEGADO}` conserva la prueba negativa del literal, que
// es la pregunta que de verdad importaba: que el hardcode no VUELVA.

(async () => {
  const c = new Client({ connectionString: URL, ssl: /rlwy|railway|proxy/i.test(URL) ? { rejectUnauthorized: false } : false });
  await c.connect();
  console.log('\n=== SELL-OUT · paridad del dedup Kepler↔Wincaja y del rollup ===\n');
  const q = async (s, p) => (await c.query(s, p)).rows;

  // [VSO.7] Un candado offline NO es un request web: su trabajo es decir la verdad, no responder
  // rápido. Con el `statement_timeout` de 1 min del destino, sumar un mes de `v_sellout_daily`
  // —una UNION de cuatro piernas sobre matvistas— no alcanza a terminar, y la pregunta se quedaba
  // sin respuesta. Se sube para ESTA sesión, acotado: si ni así termina, `medir()` lo declara
  // NO MEDIDO. ⛔ Acotado a propósito: sin tope, un candado lento cuelga la regresión entera y se
  // vuelve el candado que nadie corre.
  try { await c.query("SET statement_timeout = '4min'"); } catch { /* el destino manda */ }

  // ── 1. El corte sale del RESOLVEDOR, y este archivo lo LEE ───────────────────────────────
  console.log('1 · EL CORTE ES UN DATO (y este candado lo lee, no lo copia)');
  const yaCentralizado = (await q(
    `SELECT 1 FROM pg_class cl JOIN pg_namespace n ON n.oid=cl.relnamespace
      WHERE n.nspname='analytics' AND cl.relname='v_branch_erp_cutover'`)).length > 0;

  // ⚠️ [VSO.7] `cutover_date::text` a propósito. Las sucursales que SIEMPRE fueron Kepler traen
  // `-infinity`, y node-pg lo entrega como el número `-Infinity`: `JSON.stringify` lo convierte en
  // `null` y se lee como "no tiene corte" — me pasó midiendo esto, y por un rato creí que Kepler
  // `03/04/05` no publicaban. Es la misma familia que `String(fecha).slice(0,10)` de [LC.16]: el
  // valor está bien y el transporte miente. Como acá sólo se usa para agrupar y para imprimir,
  // TEXTO es la forma correcta.
  const CUTOVER = yaCentralizado ? await q(
    `SELECT kepler_code AS kepler, wincaja_source_branch AS wincaja, cutover_date::text AS desde
       FROM analytics.v_branch_erp_cutover ORDER BY kepler_code`) : [];

  if (!yaCentralizado) {
    noMedido('el corte es un dato leído del resolvedor',
      'no existe analytics.v_branch_erp_cutover en este destino ([SB.1], mig 20260923120000). '
      + 'Sin él no hay de dónde leer el corte, y este archivo ya NO lo tiene copiado — que es el '
      + 'punto. Quien vigila que el resolvedor exista y cubra a toda sucursal que vende es '
      + `${DELEGADO}.`);
  } else {
    check('el resolvedor declara al menos un corte', CUTOVER.length > 0);
    check('ningún corte llega sin fecha (ni NULL ni vacío)',
      CUTOVER.every((x) => !!x.desde),
      `sin fecha: ${CUTOVER.filter((x) => !x.desde).map((x) => x.kepler).join(', ')}`);
    console.log(`  ⓘ ${CUTOVER.length} corte(s) leídos: `
      + CUTOVER.map((x) => `${x.wincaja}→${x.kepler} ${x.desde}`).join(' · '));
    noMedido('literales de corte empatan entre las copias',
      'el corte ya NO está copiado: sale de analytics.v_branch_erp_cutover (SB.1). '
      + `Lo vigila ${DELEGADO}, que además tiene la prueba negativa del literal`);
  }

  // ⛔ [VSO.7] Acá también se leía el SQL de la migración con un regex, para comprobar que Kepler
  // mirara `>=` y Wincaja `<`. Se retira por la misma razón que el resto del bloque: desde [SB.1]
  // la migración histórica ya no describe la vista viva, así que el regex medía un archivo. La
  // pregunta sigue viva y se contesta MEJOR contra el resultado — si los dos predicados miraran
  // para el mismo lado, el bloque 2 vería el doble conteo o el delegado vería el hueco.

  // ── ¿hay con qué medir los bloques de datos? ─────────────────────────────────────────────
  const objs = await q(
    `SELECT c.relname, c.relkind, c.relispopulated FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='analytics' AND c.relname IN ('v_sellout_daily','mv_sellout_monthly','mv_kepler_sales_daily','mv_wincaja_sales_daily')`);
  const tiene = (n) => objs.some((o) => o.relname === n && (o.relkind === 'v' || o.relispopulated));
  const vista = tiene('v_sellout_daily');
  check('analytics.v_sellout_daily existe', vista);

  // ⚠️ [VSO.7] Esto era `SELECT source, count(*) … GROUP BY 1` sobre la vista entera y **tardaba
  // más de 60 s**: con `statement_timeout` de 1 min el candado moría acá y NUNCA llegaba a medir
  // nada. Un candado que no termina es un candado que no corre — [VSO.11] otra vez, con otra cara.
  // La pregunta era "¿esta pierna tiene datos?", y eso es un `EXISTS`: **33 ms y 6 ms**, ~1800×
  // más barato. El `count(*)` contestaba una pregunta que nadie hizo y su número no se usaba para
  // decidir nada, sólo para imprimirse.
  const piernas = { kepler: false, wincaja: false };
  if (vista) {
    for (const src of ['kepler', 'wincaja']) {
      piernas[src] = (await q(
        `SELECT EXISTS (SELECT 1 FROM analytics.v_sellout_daily WHERE source = $1) AS e`, [src]))[0].e;
    }
    console.log(`  ⓘ piernas con datos: kepler ${piernas.kepler ? 'sí' : 'NO'} · wincaja ${piernas.wincaja ? 'sí' : 'NO'}`);
  }
  const dosPiernas = vista && piernas.kepler && piernas.wincaja;

  // ── 2. El dedup no DUPLICA ───────────────────────────────────────────────────────────────
  console.log('\n2 · TRASLAPE (doble conteo por sucursal-día PUBLICADA)');
  if (!dosPiernas) {
    noMedido('traslape Kepler↔Wincaja = 0',
      `hacen falta las DOS piernas con datos (kepler=${piernas.kepler}, wincaja=${piernas.wincaja}). ` +
      'Con una pierna vacía "cero traslapes" es cierto y no prueba nada.');
  } else if (!CUTOVER.length) {
    noMedido('traslape Kepler↔Wincaja = 0', 'sin resolvedor no hay mapa Wincaja→Kepler que aplicar');
  } else {
    // [VSO.7] El mapa sale del resolvedor. Con la constante vieja eran 3 pares; son 8, y los dos
    // que faltaban (`32→07` y `30→08`) son justo los cortes que [VSO.3] tuvo que corregir.
    //
    // ⭐ Este bloque mide el ARTEFACTO PUBLICADO (`v_sellout_daily`), no una reconstrucción del
    // predicado, y por eso NO es redundante con el delegado: si el doble conteo entrara por algo
    // que no es el corte —un JOIN que duplica, una sucursal fuera del resolvedor— sólo lo ve
    // quien mira lo que la pantalla realmente sirve.
    const mapa = (rows) => `(VALUES ${rows.map((x) => `('${x.kepler}','${x.wincaja}')`).join(',')})`;
    const sqlDup = (valores, limite) => `
      WITH m(kepler, wincaja) AS ${valores},
      norm AS (
        SELECT s.business_date,
               COALESCE(m.kepler, s.source_branch) AS sucursal,
               s.source, s.monto
          FROM analytics.v_sellout_daily s
          LEFT JOIN m ON m.wincaja = s.source_branch
         WHERE s.source_branch <> ''
      )
      SELECT sucursal, business_date::date AS dia,
             sum(monto) FILTER (WHERE source='kepler')::numeric(14,2)  AS kepler,
             sum(monto) FILTER (WHERE source='wincaja')::numeric(14,2) AS wincaja
        FROM norm
       GROUP BY 1,2
      HAVING count(DISTINCT source) > 1
       ORDER BY 2 DESC LIMIT ${limite}`;

    const etqDup = `ninguna sucursal-día PUBLICADA trae las DOS fuentes (cero doble conteo, ${CUTOVER.length} cortes)`;
    const dup = await medir(etqDup, () => q(sqlDup(mapa(CUTOVER), 10)));
    if (dup) {
      check(etqDup, dup.length === 0,
        dup.length ? `${dup.length}+ días duplicados, ej: ${dup.slice(0, 3).map((d) => `${d.sucursal} ${String(d.dia).slice(0, 10)} k=$${d.kepler} w=$${d.wincaja}`).join(' · ')}` : '');
    }

    // ── PRUEBA NEGATIVA (este bloque no la tenía: un detector que nunca contradice es un espejo)
    // Se adultera el mapa a propósito —colapsando una sucursal Wincaja VIVA sobre una Kepler VIVA
    // con la que comparte días— y se exige que el detector encuentre el choque. Es read-only: no
    // toca la vista, sólo el mapa con el que se la interroga.
    //
    // ⚠️ La elección del par NO es libre, y mi primer intento salió 0: usé `44→01`, y Wincaja `44`
    // no publica NI UNA fila (su corte es `-infinity`, o sea esa plaza siempre fue Kepler). Un
    // control positivo sobre una rama vacía da cero y se lee igual que "no hay dientes". El par
    // tiene que tener las dos patas con venta REAL en días comunes — por eso se elige midiendo,
    // no a mano.
    // ⚠️ Y una segunda trampa, en mi propia primera versión de esta prueba: elegía el par
    // recorriendo dos listas SIN ORDEN y aceptaba que las VENTANAS [min,max] se solaparan. Las dos
    // cosas están mal. Sin `ORDER BY` el par cambia entre corridas —la prueba negativa deja de ser
    // reproducible— y que dos ventanas se solapen NO implica que compartan un DÍA con venta: el
    // control positivo podía salir 0 por azar y leerse como "el detector no tiene dientes".
    // Se elige con orden estable y por SOLAPE REAL en días, y se ordena por el solape más grande
    // para que el par elegido sea el menos frágil.
    const pares = await medir('el detector de doble conteo tiene dientes', () => q(`
      WITH d AS (
        SELECT DISTINCT source, source_branch, business_date
          FROM analytics.v_sellout_daily WHERE source_branch <> ''
      )
      SELECT k.source_branch AS kepler, w.source_branch AS wincaja, count(*)::int AS dias
        FROM d k JOIN d w ON k.business_date = w.business_date
       WHERE k.source = 'kepler' AND w.source = 'wincaja'
       GROUP BY 1, 2
       ORDER BY dias DESC, 1, 2
       LIMIT 1`));
    const par = pares && pares[0];
    if (pares && !par) {
      noMedido('el detector de doble conteo tiene dientes',
        'ninguna pareja (kepler, wincaja) comparte un solo día con venta, '
        + 'así que no se puede fabricar un choque sin inventar datos');
    } else if (par) {
      const etqNeg = `PRUEBA NEGATIVA · con el mapa adulterado (${par.wincaja}→${par.kepler}, ${par.dias} días en común) el detector SÍ encuentra el choque`;
      const falso = await medir(etqNeg, () => q(sqlDup(mapa([par]), 1)));
      if (falso) {
        check(etqNeg, falso.length > 0,
          'con un mapa deliberadamente falso no detectó nada: el bloque de arriba es un espejo');
      }
    }
  }

  // ── 3. El HUECO se retira acá y se DELEGA — con la delegación comprobada ─────────────────
  // [VSO.7] Este bloque preguntaba "¿hay ALGUNA venta de cada lado del corte?" (`count>0`). Eso es
  // PRESENCIA, no continuidad: da ✔ con nueve días de hueco en medio, y encima lo preguntaba con
  // la fecha equivocada. `${DELEGADO}` lo mide bien —día por día, contra las piernas crudas, con
  // `dias_hueco`/`monto_hueco` y residuos declarados con nombre y monto— y fue así como se
  // encontraron los $1,953,784.56 de [VSO.3].
  //
  // ⛔ Pero "delegar" sólo vale si el delegado CORRE. Si mañana alguien lo saca del runner, esta
  // línea se vuelve una promesa vacía y nadie se entera — que es exactamente [VSO.11], donde 23
  // candados existían en disco y no los llamaba nadie. Así que se comprueba.
  console.log('\n3 · HUECO · delegado (y se verifica que el delegado exista y CORRA)');
  const runner = leer('database/run-all-tests.js');
  const existeArchivo = !!leer(`database/tests/${DELEGADO}`);
  check(`${DELEGADO} existe en disco`, existeArchivo);
  check(`${DELEGADO} está registrado en run-all-tests.js`,
    !!runner && runner.includes(DELEGADO),
    'el hueco quedaría sin medir en NINGÚN candado: esto no es delegar, es borrar la prueba');

  // ── 4. El rollup mensual empata con la vista diaria, al peso ─────────────────────────────
  // La migración dice que la paridad es "ESTRUCTURAL por construcción" (el rollup se define DESDE la
  // vista). Cierto — y aun así se mide: la estructura garantiza la fórmula, no que el REFRESH haya
  // corrido. Un rollup materializado hace cinco noches empata con su definición y no con el dato.
  console.log('\n4 · ROLLUP ↔ VISTA (meses cerrados, al peso)');
  if (!vista || !tiene('mv_sellout_monthly')) {
    noMedido('paridad rollup ↔ vista', 'falta v_sellout_daily o mv_sellout_monthly poblada');
  } else {
    const meses = await q(
      `SELECT year_month FROM analytics.mv_sellout_monthly
        WHERE year_month < to_char((now() AT TIME ZONE 'America/Mexico_City')::date, 'YYYY-MM')
        GROUP BY 1 ORDER BY 1 DESC LIMIT 3`);
    if (!meses.length) {
      noMedido('paridad rollup ↔ vista', 'el rollup no tiene meses CERRADOS cargados');
    } else {
      for (const { year_month } of meses) {
        // ⚠️ [VSO.7] Esto filtraba con `to_char(business_date,'YYYY-MM') = $1`. Envolver la columna
        // en una función ANULA el índice y fuerza el recorrido de la vista entera — es la trampa
        // que `CLAUDE.md` ya documenta de [LC.16], palabra por palabra: *"en la lista de selección
        // `to_char` es gratis; lo que anula el índice es envolverla en el WHERE"*. Acá se cobró
        // igual, en un candado, y el efecto fue peor que lentitud: el mes no terminaba nunca
        // dentro del `statement_timeout`, así que la pregunta "¿el rollup empata con la vista?"
        // llevaba tiempo SIN RESPUESTA y el archivo moría con `ERR`, que se lee como una falla.
        // Mismo resultado, con rango de fechas, que sí puede usar el índice.
        const etqMes = `${year_month}: rollup == vista`;
        const r = await medir(etqMes, async () => (await q(`
          SELECT
            (SELECT sum(monto) FROM analytics.mv_sellout_monthly WHERE year_month=$1)::numeric(14,2) AS mv,
            (SELECT sum(monto) FROM analytics.v_sellout_daily
              WHERE business_date >= ($1 || '-01')::date
                AND business_date <  (($1 || '-01')::date + INTERVAL '1 month'))::numeric(14,2) AS vista`,
        [year_month]))[0]);
        if (!r) continue;
        const d = Math.abs(Number(r.mv || 0) - Number(r.vista || 0));
        const decl = DESFASES_DECLARADOS.find((x) => x.mes === year_month);
        const vigente = decl && Date.now() < Date.parse(decl.vence);
        if (vigente && Math.abs(d - decl.monto) < 0.01) {
          noMedido(`${etqMes} (Δ ${d.toFixed(2)})`,
            `desfase DECLARADO de $${decl.monto.toLocaleString('en-US')} que vence el ${decl.vence}. `
            + `${decl.razon} Si sigue después de esa fecha, este bloque se pone ROJO.`);
        } else {
          check(`${etqMes} (Δ ${d.toFixed(2)})`, d < 0.01,
            `mv=$${r.mv} vista=$${r.vista}`
            + (decl && !vigente ? ` · ⚠️ había un desfase declarado para este mes con vencimiento ${decl.vence}, YA VENCIDO: el refresh corrió y no lo arregló` : ''));
        }
      }
    }
  }

  await c.end();
  const resumen = `${ok} OK · ${fail} falla(s)` + (nm ? ` · ${nm} NO MEDIDO(S)` : '');
  console.log(`\n  ${resumen}\n`);
  if (nm) console.log('  ⓘ "NO MEDIDO" no es "pasó": es que en este destino no había con qué comprobarlo.\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
