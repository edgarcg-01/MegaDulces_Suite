/* eslint-disable no-console */
/**
 * `[PU.VA]` Candado del SUPUESTO DE CRECIMIENTO, el número que gobierna todo el presupuesto.
 * (ADR-059 R4/R5 · ADR-056 · `docs/VERDAD_ABSOLUTA.md` §22)
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────────────────────
 * La pantalla de Presupuesto publica los supuestos bajo la leyenda *«los calcula el sistema desde
 * la historia; no se capturan»*. Medido contra prod el 2026-10-07, ninguna de esas tres cosas era
 * cierta del lado del gasto:
 *
 *   · `budget.expense_plan_settings` y `budget.sales_plan_settings` tienen **CERO filas**, así que
 *     el motor que arma el plan lee `settings.default_growth_pct || 0` y usa **0 %** — mientras la
 *     pantalla exhibe 20.1 / 10.6 / 62.1 / 29.3 calculados en vivo y nunca guardados.
 *   · el `0 %` del gasto no es un cero medido: son **3 pares contra un mínimo de 4**, porque el
 *     egreso de familia 6 arranca en **agosto de 2025**. El servicio lo DECLARA (`basis:'default'`)
 *     y la pantalla descartaba ese campo.
 *   · y el **mes en curso** entraba como mes completo a los dos cálculos, porque sólo se exigía
 *     `> 0`. Octubre-2026 al día 7 ($910,934) se convertía en la base de octubre-2027.
 *
 * ── Qué vigila ──────────────────────────────────────────────────────────────────────────────
 *   [1] El `basis` existe y DISCRIMINA: `yoy_paired` ≠ `default`. Si el servicio dejara de
 *       declararlo, la pantalla volvería a no poder distinguir «medí 0» de «no pude medir».
 *   [2] ⭐ PRUEBA NEGATIVA del mes en curso: con el criterio viejo (`> 0` a secas) el pareo INCLUYE
 *       un mes parcial; con el nuevo lo excluye. Si los dos dieran lo mismo, el arreglo sería un
 *       no-op y este bloque se pondría rojo — *un gate sin prueba negativa es una intención*.
 *   [3] ⭐⭐ El mes en curso NO es base del plan: se mide el antes/después sobre el año base real.
 *       Medido al aplicarlo: el total del plan FY2027 pasó de $68,451,309 a $74,852,188 (+$6.40 M),
 *       y **no todo era octubre** — nov y dic subían $533,407 cada uno porque el promedio con el
 *       que se rellenan los meses sin dato también venía contaminado.
 *   [4] R5 — el ÁRBITRO MUERDE: el crecimiento que se puede derivar de Kepler y el que sostienen
 *       los libros (ContPAQi, §21) **no coinciden**. Si coincidieran, uno de los dos sería espejo
 *       del otro y no habría arbitraje. Se declara el alcance: la ruta cobra fuera del circuito
 *       fiscal (§22.10), así que el árbitro cubre un universo PARCIAL — y eso se afirma, no se tapa.
 *   [5] Lo que no se puede medir se DECLARA: una tabla de supuestos vacía tiene que llegar con
 *       `exists:false`, no con un `0` indistinguible de una medición.
 *   [6] El latido de la pasada es legible: `budget_autopilot` reporta estado, y `generation_runs`
 *       dice si alguna vez completó. La pantalla dejó de conjeturar gracias a esto.
 *
 * ⚠️ Lo que este candado NO puede vigilar: el `+10.55 %` de los libros **no es transponible** al
 * plan (familia 6 ≠ agrupador SAT, §21.3). Mientras Contabilidad no firme la correspondencia, acá
 * se comprueba que los dos lados DIFIEREN, nunca cuál tiene razón.
 *
 * Mutaciones ejercibles: `PU_MUTAR=sin_basis | mes_abierto | espejo`. Las tres lo ponen en rojo.
 * Sólo lectura: no escribe una fila. Corre contra prod a propósito — el hecho que mide vive ahí.
 */
const path = require('path');
const { Client } = require('pg');
const { noMedido, esFaltaDeAcceso } = require('./_lib/no-medido');

require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL;
const MUTAR = process.env.PU_MUTAR || '';
const FAMILIAS = ['6'];
/** Mismo umbral que `budget-expense-plan.service.ts`. Si allá cambia y acá no, este candado avisa. */
const MIN_PAIRED_MONTHS = 4;

let ok = 0, fail = 0, skip = 0;
const chk = (c, m) => { if (c) { ok++; console.log(`  ✔ ${m}`); } else { fail++; console.log(`  ✖ ${m}`); } };
const nm = (m) => { skip++; console.log(`  ◻ NO MEDIDO — ${m}`); };
const n = (x) => Number(x ?? 0).toLocaleString('es-MX', { maximumFractionDigits: 0 });
const ym = (y, m) => `${y}-${String(m).padStart(2, '0')}`;

(async () => {
  if (!URL) return noMedido('falta DATABASE_URL_NEW');
  const c = new Client({
    connectionString: URL,
    ssl: /rlwy\.net|railway|amazonaws/i.test(URL) ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 20000, statement_timeout: 300000,
  });
  try {
    await c.connect();
  } catch (e) {
    if (esFaltaDeAcceso(e)) return noMedido(`sin acceso a la base: ${e.message}`);
    throw e;
  }

  try {
    const { rows: [t] } = await c.query(`SELECT id FROM public.tenants WHERE slug = 'mega_dulces'`);
    if (!t) return noMedido('no está el tenant mega_dulces');
    const T = t.id;
    const { rows: [hoyRow] } = await c.query(`SELECT to_char(current_date, 'YYYY-MM') AS mes`);
    const MES_HOY = hoyRow.mes;
    // El criterio tiene que ser EL MISMO que el de la vista del árbitro y el del servicio. Si los
    // tres divergen, son tres primitivos para una idea (ADR-056) y el bug vuelve por otro lado.
    //
    // ⚠️ Son DOS funciones a propósito. La primera corrió mutando las dos a la vez y la mutación
    // `mes_abierto` salía **verde con 2 NO MEDIDO**: al apagar el criterio, el propio candado
    // concluía «no hay mes abierto que excluir» y se declaraba sin medir. *La mutación tiene que
    // romper lo que se está probando, no la capacidad de probarlo.* `enCursoReal` NUNCA se muta:
    // es la que decide si hay algo que medir; `enCurso` es la regla bajo prueba.
    const enCursoReal = (y, m) => ym(y, m) >= MES_HOY;
    const enCurso = (y, m) => (MUTAR === 'mes_abierto' ? false : enCursoReal(y, m));

    // ── [1] el basis discrimina ───────────────────────────────────────────────────────────────
    console.log('\n[1] El veredicto `basis` existe y discrimina');
    const src = require('fs').readFileSync(
      path.resolve(__dirname, '..', '..', 'libs/finance/src/lib/budget/budget-expense-plan.service.ts'), 'utf8',
    );
    const declara = /basis:\s*'yoy_paired'/.test(src) && /basis:\s*'default'/.test(src);
    chk(MUTAR === 'sin_basis' ? !declara : declara,
      'el servicio emite los DOS veredictos (`yoy_paired` medido · `default` no se pudo medir)');
    chk(new RegExp(`MIN_PAIRED_MONTHS\\s*=\\s*${MIN_PAIRED_MONTHS}\\b`).test(src),
      `el umbral de pares sigue en ${MIN_PAIRED_MONTHS} — si cambia allá, este candado lo acusa`);

    // ── [2] prueba negativa del mes en curso en el PAREO ──────────────────────────────────────
    console.log('\n[2] PRUEBA NEGATIVA — el mes en curso cambia el pareo (si no, el arreglo es no-op)');
    const { rows: anios } = await c.query(
      `SELECT DISTINCT extract(year from fecha)::int AS y FROM analytics.expense_entries
        WHERE tenant_id = $1 AND familia = ANY($2) ORDER BY 1`, [T, FAMILIAS]);
    const ys = anios.map((r) => r.y);
    if (ys.length < 2) {
      nm(`hacen falta 2 años de egreso para parear; hay ${ys.length}`);
    } else {
      const y1 = ys[ys.length - 1], y0 = ys[ys.length - 2];
      const { rows: mm } = await c.query(
        `SELECT extract(year from fecha)::int AS y, extract(month from fecha)::int AS m,
                sum(CASE WHEN cargo_abono = 'A' THEN -importe ELSE importe END)::numeric AS monto
           FROM analytics.expense_entries
          WHERE tenant_id = $1 AND familia = ANY($2) AND cuenta_mayor IS NOT NULL AND cuenta_mayor <> ''
            AND extract(year from fecha) = ANY($3)
          GROUP BY 1, 2`, [T, FAMILIAS, [y0, y1]]);
      const by = {}; for (const r of mm) { (by[r.m] = by[r.m] || {})[r.y] = Number(r.monto); }
      const parear = (excluir) => {
        let a = 0, b = 0, p = 0;
        for (const m of Object.keys(by)) {
          const mi = Number(m);
          if (excluir && (enCurso(y1, mi) || enCurso(y0, mi))) continue;
          const e = by[m];
          if (e[y0] > 0 && e[y1] > 0) { a += e[y0]; b += e[y1]; p++; }
        }
        return { pares: p, crec: p >= MIN_PAIRED_MONTHS && a > 0 ? ((b - a) / a) * 100 : null };
      };
      const viejo = parear(false), nuevo = parear(true);
      console.log(`    criterio viejo: ${viejo.pares} pares · ${viejo.crec == null ? 'DEFAULT' : viejo.crec.toFixed(2) + ' %'}`);
      console.log(`    criterio nuevo: ${nuevo.pares} pares · ${nuevo.crec == null ? 'DEFAULT' : nuevo.crec.toFixed(2) + ' %'}`);
      const hayMesAbierto = Object.keys(by).some((m) => enCursoReal(y1, Number(m)) && by[m][y1] > 0 && by[m][y0] > 0);
      if (!hayMesAbierto) {
        nm('no hay un mes en curso que paree en los dos años — nada que excluir en esta corrida');
      } else {
        chk(nuevo.pares < viejo.pares,
          `el mes en curso SALE del pareo: ${viejo.pares} → ${nuevo.pares} pares. Si fueran iguales, el arreglo no haría nada`);
      }
      chk(nuevo.crec == null || Number.isFinite(nuevo.crec),
        'el crecimiento derivado es un número o se DECLARA que no alcanza (nunca un 0 de relleno)');
    }

    // ── [3] el mes en curso NO es base del plan ───────────────────────────────────────────────
    console.log('\n[3] El mes en curso no es BASE del plan (antes/después sobre el año base real)');
    const anioBase = ys.length ? ys[ys.length - 1] : null;
    if (anioBase == null) {
      nm('sin año base de egresos');
    } else {
      const { rows: bb } = await c.query(
        `SELECT cuenta_mayor AS acc, extract(month from fecha)::int AS m,
                sum(CASE WHEN cargo_abono = 'A' THEN -importe ELSE importe END)::numeric AS monto
           FROM analytics.expense_entries
          WHERE tenant_id = $1 AND familia = ANY($2) AND cuenta_mayor IS NOT NULL AND cuenta_mayor <> ''
            AND extract(year from fecha) = $3
          GROUP BY 1, 2`, [T, FAMILIAS, anioBase]);
      const g = {}; for (const r of bb) { (g[r.acc] = g[r.acc] || {})[r.m] = Number(r.monto); }
      const plan = (excluir) => {
        let total = 0;
        for (const acc of Object.keys(g)) {
          const bm = g[acc];
          const pres = Object.entries(bm).filter(([m, v]) => v > 0 && !(excluir && enCurso(anioBase, Number(m)))).map(([, v]) => v);
          const avg = pres.length ? pres.reduce((a, b) => a + b, 0) / pres.length : 0;
          const rec = pres.length >= 6;
          for (let m = 1; m <= 12; m++) {
            const base = (excluir && enCurso(anioBase, m)) ? 0 : (bm[m] || 0);
            if (base > 0) total += base; else if (rec && avg > 0) total += avg;
          }
        }
        return total;
      };
      const antes = plan(false), despues = plan(true);
      const mesesAbiertos = [...Array(12).keys()].map((i) => i + 1).filter((m) => enCursoReal(anioBase, m) && (Object.values(g).some((bm) => (bm[m] || 0) > 0)));
      console.log(`    plan simulado — antes ${n(antes)} · después ${n(despues)} · delta ${n(despues - antes)}`);
      if (!mesesAbiertos.length) {
        nm(`el año base ${anioBase} no tiene meses abiertos con dato — el arreglo no aplica en esta corrida`);
      } else {
        chk(despues > antes,
          `excluir el mes en curso SUBE el plan (${n(antes)} → ${n(despues)}): un mes parcial lo subdeclaraba, y arrastraba el promedio de los demás`);
      }
    }

    // ── [4] R5 — el árbitro muerde, y su alcance se declara ───────────────────────────────────
    console.log('\n[4] R5 — Kepler y los libros NO dan el mismo crecimiento (si cuadraran, sería un espejo)');
    const { rows: ar } = await c.query(
      `SELECT anio_mes, kepler, contpaqi FROM analytics.v_expense_arbiter
        WHERE bloque = 'gasto_resto' AND anio_mes >= $1 AND anio_mes <= $2 ORDER BY 1`,
      [`${anioBase ? anioBase - 1 : 2025}-01`, `${anioBase || 2026}-12`]);
    const yoyLado = (lado) => {
      const by = {};
      for (const r of ar) { const [y, m] = r.anio_mes.split('-'); (by[m] = by[m] || {})[y] = r[lado] == null ? null : Number(r[lado]); }
      let a = 0, b = 0, p = 0;
      const Y0 = String(anioBase - 1), Y1 = String(anioBase);
      for (const m of Object.keys(by)) {
        if (enCurso(Number(Y1), Number(m))) continue;
        const e = by[m];
        if (e[Y0] > 0 && e[Y1] > 0) { a += e[Y0]; b += e[Y1]; p++; }
      }
      return p ? { crec: ((b - a) / a) * 100, pares: p } : null;
    };
    const kep = yoyLado('kepler'), lib = yoyLado('contpaqi');
    if (!kep || !lib) {
      nm('una de las dos piernas no tiene meses pareados — no hay con qué arbitrar');
    } else {
      console.log(`    Kepler ${kep.crec.toFixed(2)} % (${kep.pares} pares) · libros ${lib.crec.toFixed(2)} % (${lib.pares} pares)`);
      const difieren = MUTAR === 'espejo' ? false : Math.abs(kep.crec - lib.crec) > 1;
      chk(difieren,
        `los dos lados difieren (${kep.crec.toFixed(2)} % vs ${lib.crec.toFixed(2)} %) — un árbitro que nunca contradice es un espejo`);
      chk(lib.pares >= kep.pares,
        `los libros tienen al menos tantos meses cerrados como Kepler (${lib.pares} ≥ ${kep.pares}): la cobertura es parte del veredicto`);
    }
    // El alcance del árbitro se AFIRMA, no se asume: la venta de ruta no pasa por los libros (§22.10).
    const { rows: [rutaAcc] } = await c.query(
      `SELECT count(*)::int AS cuentas, coalesce(sum(abonos - cargos), 0)::numeric AS monto
         FROM analytics.contpaqi_ledger_monthly
        WHERE familia = '4' AND cuenta_nombre ~* '(ruta|RD )' AND anio_mes >= $1`,
      [`${anioBase || 2026}-01`]);
    chk(Number(rutaAcc.cuentas) >= 0,
      `alcance declarado: las cuentas de ingreso que nombran una ruta mueven ${n(rutaAcc.monto)} en el año base — el árbitro NO cubre la venta de ruta (§22.10)`);

    // ── [5] la ausencia se declara, no se dibuja ──────────────────────────────────────────────
    console.log('\n[5] Una tabla de supuestos vacía llega como AUSENCIA, no como cero');
    const { rows: [cnt] } = await c.query(
      `SELECT (SELECT count(*) FROM budget.expense_plan_settings)::int AS gastos,
              (SELECT count(*) FROM budget.sales_plan_settings)::int   AS ventas`);
    console.log(`    supuestos guardados — gastos: ${cnt.gastos} · ventas: ${cnt.ventas}`);
    chk(/exists:\s*false/.test(src),
      'el servicio marca `exists:false` cuando no hay fila de supuestos — es lo que deja a la pantalla distinguir ausencia de cero');
    if (cnt.gastos === 0 && cnt.ventas === 0) {
      console.log('    ⚠️ los dos están en CERO: el motor armaría el plan a 0 % mientras la pantalla muestra otra cosa (§22.6)');
    }

    // ── [6] el latido de la pasada es legible ─────────────────────────────────────────────────
    console.log('\n[6] El latido de la pasada se puede leer (la pantalla dejó de conjeturar)');
    const { rows: [lat] } = await c.query(
      `SELECT status, error, last_start FROM analytics.cron_runs
        WHERE tenant_id = $1 AND job_key = 'budget_autopilot'`, [T]);
    const { rows: [gr] } = await c.query(`SELECT count(*)::int AS n FROM budget.generation_runs WHERE tenant_id = $1`, [T]);
    if (!lat) {
      nm('`budget_autopilot` no reporta latido — no se puede saber si corrió');
    } else {
      console.log(`    status=${lat.status} · pasadas completadas=${gr.n}${lat.error ? ` · error="${String(lat.error).slice(0, 70)}"` : ''}`);
      chk(lat.status != null,
        'el latido declara un estado — `null` sería «no sé», que es distinto de «ok» (ADR-056)');
      chk(!(lat.status === 'ok' && Number(gr.n) === 0),
        'no puede reportar `ok` sin una sola pasada completada: eso es exactamente el cero que se lee como «no había nada que hacer»');
    }
    // ── [7] ⭐⭐ la consulta del servicio, ARMADA COMO LA ARMA ÉL ──────────────────────────────
    //
    // Este bloque nació de una falla que los seis de arriba NO vieron: `netByAccountYearMonth`
    // interpola `''` como columna de sucursal y la metía **también en el GROUP BY**, donde Postgres
    // responde `non-integer constant in GROUP BY`. Como `by_sucursal` es **false por defecto**, eso
    // no era un borde: era el camino normal, y significa que el plan de gastos **nunca pudo
    // proponerse**. Lo encontró la verificación por HTTP; acá pasaba en verde porque los bloques de
    // arriba **replican** la consulta con `GROUP BY 1, 2` en vez de armarla como el servicio.
    //
    // ⭐ *Reproducir una consulta no es ejecutarla.* Por eso este bloque construye el SQL con la
    // MISMA interpolación del servicio y lo corre contra la base, en los DOS modos.
    console.log('\n[7] La consulta del servicio se EJECUTA, en los dos modos de `by_sucursal`');
    const sqlDelServicio = (bySuc) => {
      const sucSel = bySuc ? "coalesce(sucursal, '')" : `''`;
      const sucGroup = bySuc ? "coalesce(sucursal, '')" : '';
      return `SELECT cuenta_mayor AS account_code, max(cuenta_mayor_nombre) AS account_name,
                     max(familia) AS familia, ${sucSel} AS sucursal,
                     extract(year from fecha)::int AS year, extract(month from fecha)::int AS month,
                     sum(CASE WHEN cargo_abono = 'A' THEN -importe ELSE importe END) AS monto
                FROM analytics.expense_entries
               WHERE tenant_id = $1 AND familia = ANY($2) AND cuenta_mayor IS NOT NULL AND cuenta_mayor <> ''
                 AND extract(year from fecha) = ANY($3)
               GROUP BY cuenta_mayor${sucGroup ? `, ${sucGroup}` : ''}, extract(year from fecha), extract(month from fecha)`;
    };
    for (const bySuc of [false, true]) {
      try {
        const r = await c.query(sqlDelServicio(bySuc), [T, FAMILIAS, ys.length ? ys.slice(-2) : [2025, 2026]]);
        chk(true, `by_sucursal=${bySuc}: la consulta CORRE (${r.rows.length} filas)`);
      } catch (e) {
        chk(false, `by_sucursal=${bySuc}: la consulta REVIENTA → ${String(e.message).slice(0, 80)}`);
      }
    }
    // ⭐ PRUEBA NEGATIVA: la forma vieja tiene que SEGUIR siendo rechazada por Postgres. Sin esto,
    // el bloque de arriba sólo prueba que el SQL bueno corre — y eso también sería cierto si el
    // motor hubiera empezado a tolerar la constante, que es justo lo que no se quiere suponer.
    try {
      await c.query(
        `SELECT cuenta_mayor, '' AS sucursal, sum(importe) FROM analytics.expense_entries
          WHERE tenant_id = $1 GROUP BY cuenta_mayor, '', extract(year from fecha)`, [T]);
      chk(false, 'PRUEBA NEGATIVA: Postgres ACEPTÓ la constante en el GROUP BY — la premisa del arreglo ya no vale');
    } catch (e) {
      chk(/non-integer constant in GROUP BY/i.test(e.message),
        `PRUEBA NEGATIVA: la forma vieja sigue siendo ilegal (${String(e.message).slice(0, 48)})`);
    }
    // Y la premisa, vigilada en el fuente: no puede volver a interpolarse la constante en el GROUP BY.
    chk(!/GROUP BY cuenta_mayor, \$\{sucSel\}/.test(src),
      'el fuente ya no interpola la columna del SELECT dentro del GROUP BY — ahí es donde la constante es ilegal');

    // ── [8] ⭐ El saldo del ledger es del EGRESO: el ingreso NO se suma con él ─────────────────
    //
    // Medido contra prod el 2026-10-07, con el primer ejercicio que el motor llegó a armar: la
    // pestaña Ejercicio publicaba `vigente = $547,249,778`, que es la meta de ventas más el plan de
    // gastos en un solo número. Un ingreso no se reserva, no se compromete y no se ejerce, así que
    // además diluía la ocupación del gasto. La spec lo dice en `FASE_PU` §145-147.
    console.log('\n[8] El saldo del ledger suma EGRESO, no la meta de ventas');
    const { rows: tipos } = await c.query(
      `SELECT line_type, sum(vigente_amount)::numeric AS vigente, sum(reserved_amount)::numeric AS reserved,
              sum(committed_amount)::numeric AS committed, sum(exercised_amount)::numeric AS exercised
         FROM budget.budget_lines WHERE tenant_id = $1 GROUP BY 1`, [T]);
    const suma = (filtro, campo) => tipos.filter(filtro).reduce((s, r) => s + Number(r[campo] ?? 0), 0);
    const hayIngreso = tipos.some((r) => r.line_type === 'ingreso' && Number(r.vigente) > 0);
    const hayEgreso = tipos.some((r) => r.line_type !== 'ingreso' && Number(r.vigente) > 0);
    // MUTAR=suma_todo revive el criterio viejo para comprobar que el candado lo acusa.
    const esEgreso = (r) => (MUTAR === 'suma_todo' ? true : r.line_type !== 'ingreso');
    const vigEgreso = suma(esEgreso, 'vigente');
    const vigTodo = suma(() => true, 'vigente');
    const vigIngreso = suma((r) => r.line_type === 'ingreso', 'vigente');
    console.log(`    egreso ${n(vigEgreso)} · ingreso ${n(vigIngreso)} · sumando todo ${n(vigTodo)}`);
    if (!hayIngreso || !hayEgreso) {
      nm(`el ejercicio no tiene los dos lados (ingreso>0: ${hayIngreso} · egreso>0: ${hayEgreso}) — no hay nada que separar`);
    } else {
      chk(vigEgreso < vigTodo,
        `⭐ PRUEBA NEGATIVA — separar cambia el número (${n(vigTodo)} → ${n(vigEgreso)}): si fueran iguales, el arreglo sería un no-op`);
      chk(Math.abs((vigEgreso + vigIngreso) - vigTodo) < 0.01,
        'y lo separado CUADRA con el total: egreso + ingreso = lo que se sumaba antes (nada se perdió en el camino)');
    }
    const srcCmp = require('fs').readFileSync(
      path.resolve(__dirname, '..', '..', 'libs/finance/src/lib/budget/budget-comparison.service.ts'), 'utf8');
    chk(/line_type\) !== 'ingreso'/.test(srcCmp),
      'el servicio EXCLUYE el ingreso en vez de enumerar los egresos — con lista blanca, un tipo nuevo quedaría fuera y el disponible saldría más alto de lo que es');
    chk(/ingreso_meta/.test(srcCmp),
      'la meta de ventas viaja aparte (`ingreso_meta`): separarla no puede significar perderla');
  } finally {
    await c.end().catch(() => undefined);
  }

  console.log(`\n=== ${ok} OK · ${fail} FALLA · ${skip} NO MEDIDO ===`);
  if (fail > 0) process.exitCode = 1;
})();
