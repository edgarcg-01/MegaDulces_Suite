/* eslint-disable no-console */
/**
 * `[IG.0.2]` — **El candado del ingreso contable.** Es lo primero que se construyó de la Fase IG, y
 * a propósito: sin él cualquier cosa encima puede publicar un número 69 % más grande y nadie se
 * entera.
 *
 * ── QUÉ CUIDA ────────────────────────────────────────────────────────────────────────────
 * `analytics.income_entries_src()` deriva el ingreso del ODS aplicando tres reglas que NO son
 * opcionales, y saltárselas **no da un error: da un número mayor**. Medido en prod (agosto-2026):
 *
 *     balanza familia 4, TODAS las sucursales ....... $94,061,828.00   ← el espejo ingenuo
 *     sólo CEDIS ................................... $61,903,631.74
 *     sólo CEDIS + sólo UD1301 (lo correcto) ....... $55,940,323.96
 *
 * El árbitro es `analytics.sales_by_channel_monthly`, que llena `import-sales-by-channel.js`
 * leyendo las **réplicas por sucursal** — otra fuente y otro camino. Que los dos coincidan es lo
 * que prueba que la derivación es correcta.
 *
 * ── LOS TRES ESTADOS, NO DOS ─────────────────────────────────────────────────────────────
 * ADR-056: lo que no se puede medir se DECLARA.
 *   · **meses CERRADOS** → se AFIRMA igualdad al centavo. Medido: feb–jul 2026, delta $0.00.
 *   · **mes en curso y el anterior** → se DECLARA el delta, no se afirma. Las dos fuentes se leen
 *     en momentos distintos (el ODS por CDC al minuto, el feed a las 03:35), así que un delta chico
 *     es sano. Medido 2026-09-25: ago **+$77,131.36** (el ODS va adelante) y sep **−$793,318.13**
 *     (el ODS va ATRÁS: le faltan renglones — es `AUD-ODS-01` del lado del ingreso).
 *   · **sin datos** → `NO MEDIDO`, nunca ✔ por vacuidad.
 *
 * ── Y LA PRUEBA NEGATIVA ─────────────────────────────────────────────────────────────────
 * Un gate sin prueba negativa es una intención. El bloque 4 quita el filtro de CEDIS a propósito y
 * **exige ver el salto**: si algún día alguien "simplifica" la función quitándolo porque «faltan
 * ventas», este candado se pone rojo antes que la pantalla mienta.
 *
 * No escribe nada. Requiere ODS (`kepler_ods.kdc2*`): sin él reporta NO MEDIDO y sale en 0.
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);

const M = '00000000-0000-0000-0000-00000000d01c';
let pass = 0, fail = 0, nomedido = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }
function declarar(msg) { nomedido++; console.log('  ⊘ NO MEDIDO —', msg); }
const money = (n) => '$' + Number(n).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Meses cerrados = los que ya terminaron. El mes en curso y el anterior quedan fuera del candado
 *  duro: el feed nocturno y el CDC se leen en momentos distintos y el delta es de tiempo, no de
 *  lógica. `YYYY-MM`. */
function mesesCerrados(n = 6) {
  const out = [];
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 2); // salta el mes en curso y el anterior
  for (let i = 0; i < n; i++) {
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    d.setMonth(d.getMonth() - 1);
  }
  return out.reverse();
}

const ultimoDia = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  const bis = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  return `${ym}-${String([31, bis ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]).padStart(2, '0')}`;
};

(async () => {
  console.log('\n=== [IG.0.2] Paridad del ingreso contable: derivación del ODS vs feed validado ===\n');

  const ods = await knex.raw(`SELECT to_regclass('kepler_ods.kdm1') AS t`);
  if (!ods.rows[0]?.t) {
    declarar('este entorno no tiene réplica ERP (kepler_ods) — nada que derivar');
    console.log(`\n=== ${pass} ✓ / ${fail} ✗ / ${nomedido} ⊘ ===\n`);
    await knex.destroy();
    process.exit(0);
  }
  // ⛔ `to_regclass` NO resuelve FUNCIONES, sólo relaciones (tablas, vistas, índices, secuencias).
  // Con él esta comprobación devolvía `false` **aunque la función existiera** → el candado salía por
  // el camino de «NO MEDIDO» y **terminaba en verde SIEMPRE**: un gate que no puede fallar, que es
  // justo la clase de verde-por-vacuidad que este archivo existe para impedir. Lo destapó aplicar la
  // migración a prod y ver que el chequeo seguía diciendo que no estaba.
  // `to_regprocedure` sí, y lleva la firma porque el nombre solo es ambiguo si hay sobrecargas.
  const fn = await knex.raw(
    `SELECT to_regprocedure('analytics.income_entries_src(date,date)') IS NOT NULL AS t`)
    .then((r) => r.rows[0]?.t).catch(() => false);
  if (!fn) {
    declarar('analytics.income_entries_src() no existe todavía — falta aplicar la migración 20260925150000');
    console.log(`\n=== ${pass} ✓ / ${fail} ✗ / ${nomedido} ⊘ ===\n`);
    await knex.destroy();
    process.exit(0);
  }

  // ── 1. Meses CERRADOS: igualdad al centavo contra el feed que ya estaba validado ──────────
  console.log('1) Meses cerrados — la derivación DEBE dar exactamente lo mismo que el feed nocturno');
  let mesesConDato = 0;
  for (const ym of mesesCerrados(6)) {
    const from = `${ym}-01`, to = ultimoDia(ym);
    // `[IG.4.1]` Se compara la venta BRUTA (`UD1301`), no el total: desde que el ingreso resta
    // devoluciones, el feed nocturno —que es sólo UD1301— ya no puede cuadrar con el neto. El
    // alcance y el clasificador se siguen probando igual; lo que cambia es contra qué pierna.
    const [{ v: derivado }] = (await knex.raw(
      `SELECT COALESCE(SUM(importe),0)::numeric AS v FROM analytics.income_entries_src(?::date, ?::date)
        WHERE tenant_id = ? AND doc_tipo = 'UD1301'`,
      [from, to, M])).rows;
    const [{ v: feed }] = (await knex.raw(
      `SELECT COALESCE(SUM(ventas),0)::numeric AS v FROM analytics.sales_by_channel_monthly WHERE tenant_id = ? AND anio_mes = ?`,
      [M, ym])).rows;
    if (Number(derivado) === 0 && Number(feed) === 0) { declarar(`${ym}: las dos fuentes vienen vacías`); continue; }
    mesesConDato++;
    const delta = Number(derivado) - Number(feed);
    ok(Math.abs(delta) < 0.005,
      `${ym}: derivado ${money(derivado)} == feed ${money(feed)}  (Δ ${money(delta)})`);
  }
  if (!mesesConDato) declarar('ningún mes cerrado tenía datos en las dos fuentes');

  // ── 1-bis. El cuerpo instalado no puede traer placeholders de knex ────────────────────────
  // `knex.raw(sql)` parsea `?` como placeholder **aunque no le pases bindings** y lo sustituye por
  // `$N`. En una regex de Postgres el `?` es un cuantificador, así que la migración 20260925150000
  // instaló `(R\.$1D\.$2|RUTA)` en prod y el clasificador quedó mudo. El TOTAL siguió cuadrando:
  // sólo mintió el desglose. Esta comprobación es barata y no depende de que haya datos.
  console.log('\n1-bis) El cuerpo de la función no trae placeholders de knex');
  const { rows: def } = await knex.raw(
    `SELECT pg_get_functiondef(p.oid) AS src FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'analytics' AND p.proname = 'income_entries_src'`);
  const cuerpo = def?.[0]?.src || '';
  ok(cuerpo !== '' && !/~ '[^']*\$\d/.test(cuerpo),
    'ninguna regex de la función contiene $1/$2 (señal de que knex se comió un `?`)');

  // ── 2. Por CANAL y por PLAZA, no sólo el total: un clasificador roto cuadra en la suma ────
  console.log('\n2) Por canal y por plaza — la suma puede cuadrar con los canales cruzados');
  const ymRef = mesesCerrados(1)[0];
  const porCanal = (await knex.raw(
    `SELECT canal, COALESCE(SUM(importe),0)::numeric AS v FROM analytics.income_entries_src(?::date, ?::date)
      WHERE tenant_id = ? AND doc_tipo = 'UD1301' GROUP BY 1`, [`${ymRef}-01`, ultimoDia(ymRef), M])).rows;
  if (!porCanal.length) {
    declarar(`${ymRef}: la derivación no devolvió canales`);
  } else {
    for (const c of porCanal) {
      const [{ v: feed }] = (await knex.raw(
        `SELECT COALESCE(SUM(ventas),0)::numeric AS v FROM analytics.sales_by_channel_monthly
          WHERE tenant_id = ? AND anio_mes = ? AND canal = ?`, [M, ymRef, c.canal])).rows;
      ok(Math.abs(Number(c.v) - Number(feed)) < 0.005,
        `${ymRef} · ${c.canal}: ${money(c.v)} == ${money(feed)}`);
    }

    // Y por PLAZA. El canal solo no alcanza: la plaza sale del MISMO texto `c6` con otra regex, y
    // puede romperse sola dejando el canal intacto.
    const porPlaza = (await knex.raw(
      `SELECT canal, plaza, COALESCE(SUM(importe),0)::numeric AS v
         FROM analytics.income_entries_src(?::date, ?::date)
        WHERE tenant_id = ? AND doc_tipo = 'UD1301' GROUP BY 1,2 ORDER BY 3 DESC LIMIT 10`,
      [`${ymRef}-01`, ultimoDia(ymRef), M])).rows;
    let plazasMal = 0;
    for (const p of porPlaza) {
      const [{ v: feed }] = (await knex.raw(
        `SELECT COALESCE(SUM(ventas),0)::numeric AS v FROM analytics.sales_by_channel_monthly
          WHERE tenant_id = ? AND anio_mes = ? AND canal = ? AND plaza = ?`,
        [M, ymRef, p.canal, p.plaza])).rows;
      if (Math.abs(Number(p.v) - Number(feed)) >= 0.005) plazasMal++;
    }
    ok(plazasMal === 0, `${ymRef}: las 10 plazas más grandes cuadran al centavo (${plazasMal} distinta(s))`);
  }

  // ── 2-bis. El ingreso publicado es NETO de devoluciones ──────────────────────────────────
  // `[IG.4.1]`: hasta esta fase el total no restaba las «Nota Créd/Dev NoFis POS» y salía inflado
  // (−$1,505,625.79 en 12 meses). Acá se comprueba que entran, que entran NEGATIVAS y que el total
  // es exactamente la suma de las dos piernas — si alguien las vuelve a dejar fuera, esto se cae.
  console.log('\n2-bis) El total es NETO: venta bruta + devoluciones');
  const [neto] = (await knex.raw(
    `SELECT COALESCE(SUM(importe),0)::numeric                                   AS total,
            COALESCE(SUM(importe) FILTER (WHERE doc_tipo = 'UD1301'),0)::numeric AS bruta,
            COALESCE(SUM(importe) FILTER (WHERE doc_tipo LIKE 'UA25%'),0)::numeric AS devol,
            COUNT(*) FILTER (WHERE doc_tipo LIKE 'UA25%')::int                   AS n_devol
       FROM analytics.income_entries_src(?::date, ?::date) WHERE tenant_id = ?`,
    [`${ymRef}-01`, ultimoDia(ymRef), M])).rows;
  if (Number(neto.n_devol) === 0) {
    declarar(`${ymRef}: no hubo devoluciones en el mes — nada que comprobar`);
  } else {
    ok(Number(neto.devol) < 0, `las devoluciones entran NEGATIVAS (${money(neto.devol)}) — restan, no suman`);
    ok(Math.abs(Number(neto.total) - (Number(neto.bruta) + Number(neto.devol))) < 0.005,
      `total ${money(neto.total)} == bruta ${money(neto.bruta)} + devoluciones ${money(neto.devol)}`);
    ok(Number(neto.total) < Number(neto.bruta),
      'el neto es MENOR que la bruta — el ingreso ya no sale inflado');
  }

  // ── 3. Mes vivo: se DECLARA, no se afirma ────────────────────────────────────────────────
  console.log('\n3) Mes en curso — se declara el delta (las dos fuentes se leen en momentos distintos)');
  const hoy = new Date();
  const ymVivo = `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, '0')}`;
  const [{ v: dv }] = (await knex.raw(
    `SELECT COALESCE(SUM(importe),0)::numeric AS v FROM analytics.income_entries_src(?::date, ?::date) WHERE tenant_id = ?`,
    [`${ymVivo}-01`, ultimoDia(ymVivo), M])).rows;
  const [{ v: fv }] = (await knex.raw(
    `SELECT COALESCE(SUM(ventas),0)::numeric AS v FROM analytics.sales_by_channel_monthly WHERE tenant_id = ? AND anio_mes = ?`,
    [M, ymVivo])).rows;
  const dLive = Number(dv) - Number(fv);
  console.log(`  · ${ymVivo}: derivado ${money(dv)} · feed ${money(fv)} · Δ ${money(dLive)}` +
    (dLive < 0 ? '  ⚠️ el ODS va ATRÁS del feed (síntoma de AUD-ODS-01)' : ''));
  declarar(`${ymVivo}: mes vivo — el delta se informa, no se afirma`);

  // ── 4. PRUEBA NEGATIVA: sin el filtro de CEDIS el número TIENE que saltar ─────────────────
  console.log('\n4) Prueba negativa — quitar el filtro de CEDIS debe inflar el número');
  const tbl = `kdc2${ymRef.slice(2, 4)}${ymRef.slice(5, 7)}`;
  const existe = (await knex.raw(`SELECT to_regclass(?) AS t`, [`kepler_ods.${tbl}`])).rows[0]?.t;
  if (!existe) {
    declarar(`no existe kepler_ods.${tbl} para la prueba negativa`);
  } else {
    const [{ v: canonico }] = (await knex.raw(
      `SELECT COALESCE(SUM(importe),0)::numeric AS v FROM analytics.income_entries_src(?::date, ?::date) WHERE tenant_id = ?`,
      [`${ymRef}-01`, ultimoDia(ymRef), M])).rows;

    // ⚠️ La aserción va contra el alcance INGENUO COMPLETO —familia 4 entera, todas las sucursales,
    // todos los doctypes—, que es literalmente lo que sale de copiar la pantalla de egresos. Medir
    // un filtro a la vez NO sirve de gate: en julio, quitar sólo el de sucursal mueve $6,837
    // (0.01 %), así que un `> 0` pasaría también con la función rota. Juntos sí se ven:
    //   jul-2026: $56,987,270.38 → $82,403,541.39  (+44.6 %)
    //   ago-2026: $55,940,323.96 → $94,061,828.00  (+69.0 %)
    const [{ v: ingenuo }] = (await knex.raw(
      `SELECT COALESCE(SUM(c5::numeric),0)::numeric AS v FROM kepler_ods.${tbl}
        WHERE c4 = 'A' AND c3 LIKE '4%' AND COALESCE(c5,0) <> 0`)).rows;
    const gap = Number(canonico) > 0 ? ((Number(ingenuo) - Number(canonico)) / Number(canonico)) * 100 : 0;
    ok(gap > 10,
      `el alcance ingenuo infla +${gap.toFixed(1)} % (${money(canonico)} → ${money(ingenuo)}) — las reglas SIRVEN`);

    // Informativo (no aserción): cuánto aporta cada filtro por separado, para que el día que esto
    // se rompa se sepa cuál se cayó.
    const [{ v: sinSuc }] = (await knex.raw(
      `SELECT COALESCE(SUM(CASE WHEN c4='A' THEN c5::numeric ELSE -c5::numeric END),0)::numeric AS v
         FROM kepler_ods.${tbl}
        WHERE c3 LIKE '401%' AND COALESCE(c5,0) <> 0
          AND (c15||c16||lpad(c17::text,2,'0')||lpad(c18::text,2,'0')) = 'UD1301'`)).rows;
    const [{ v: sinDoc }] = (await knex.raw(
      `SELECT COALESCE(SUM(CASE WHEN c4='A' THEN c5::numeric ELSE -c5::numeric END),0)::numeric AS v
         FROM kepler_ods.${tbl}
        WHERE c3 LIKE '401%' AND COALESCE(c5,0) <> 0
          AND (c14 IS NULL OR btrim(c14) = '' OR btrim(c14) = '00')`)).rows;
    console.log(`  · desglose: sin el filtro de sucursal ${money(Number(sinSuc) - Number(canonico))} · ` +
      `sin el de documento ${money(Number(sinDoc) - Number(canonico))}`);
  }

  // ── 5. La función respeta su rango (no devuelve meses de más) ────────────────────────────
  console.log('\n5) El rango se respeta');
  const fuera = (await knex.raw(
    `SELECT count(*)::int AS n FROM analytics.income_entries_src(?::date, ?::date)
      WHERE tenant_id = ? AND (fecha < ?::date OR fecha > ?::date)`,
    [`${ymRef}-01`, ultimoDia(ymRef), M, `${ymRef}-01`, ultimoDia(ymRef)])).rows[0].n;
  ok(fuera === 0, `ninguna fila fuera del rango pedido (${fuera})`);

  console.log(`\n=== ${pass} ✓ / ${fail} ✗ / ${nomedido} ⊘ NO MEDIDO ===\n`);
  await knex.destroy();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error('ERROR:', e.message);
  await knex.destroy();
  process.exit(1);
});
