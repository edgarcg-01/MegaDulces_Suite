/**
 * [PVI.1] Candado de la COMPARABILIDAD del crecimiento de ventas — el supuesto que multiplica cada
 * celda del plan.
 *
 * ── Qué vigila, y por qué estas pruebas y no otras ─────────────────────────────────────────
 *
 * El defecto era invisible por construcción. `proposeGrowth` pareaba por PERIODO exigiendo
 * `e.a > 0 && e.b > 0` sobre el AGREGADO del canal, así que:
 *
 *   (1) una plaza que nace en el año nuevo sumaba a `b` SIN contraparte en `a`, y
 *   (2) `> 0` no es un umbral: bastaba UNA fila.
 *
 * Medido contra prod el 2026-10-08: `mostrador:03` (8ESQ) pasó de $230,601 a $39,240,479 con venta
 * en **1 de 9** periodos de 2025 y PAREABA — esa sola entidad aportaba **24.28 pp** de los 21.46 %
 * que el canal publicaba. Con pareo por entidad el canal cae a **−2.82 %**, y el negocio comparable
 * entero se CONTRAE **2.95 %** mientras el plan proyectaba **+26.67 %**. `VERDAD_ABSOLUTA` §24.
 *
 * Por eso el candado NO se conforma con «el crecimiento da un número»:
 *
 *  1. **DOS IMPLEMENTACIONES.** La regla vive en TypeScript (`budget-sales-plan.service.ts`) y acá
 *     se reimplementa en SQL+JS sobre la misma MV. Verificar una vista contra sí misma pasa bugs en
 *     verde — la lección de IC.0. Si las dos divergen, una de las dos está mal.
 *
 *  2. **PRUEBA NEGATIVA POR MUTACIÓN.** No alcanza con que la regla nueva excluya a `mostrador:03`:
 *     se exige además que la regla VIEJA lo INCLUYERA. Si las dos lo tratan igual, el arreglo no
 *     está arreglando nada y este archivo se pondría verde de todos modos.
 *
 *  3. **CONTROL POSITIVO DEL DETECTOR.** Una regla que no excluye a NADIE se lee exactamente igual
 *     que «no hay contaminación». Se exige que excluya al menos una entidad.
 *
 *  4. **CONSERVACIÓN.** La regla sólo puede QUITAR entidades, nunca alterar las que conserva:
 *     comparable + excluido tiene que dar el total, al peso.
 *
 *  5. **ENVEJECE DECLARANDO.** El día que 8ESQ acumule dos años completos va a volverse comparable
 *     con todo derecho. Eso NO es una falla: el bloque reporta `NO MEDIDO` y dice por qué, en vez
 *     de ponerse rojo sobre una evolución legítima del dato (ADR-056).
 *
 * ── Cómo correrlo ──────────────────────────────────────────────────────────────────────────
 *
 *     DATABASE_URL_NEW=<prod> node database/tests/test-newdb-sales-growth-comparability.js
 *
 * Es de SÓLO LECTURA: no escribe, no muta, no refresca.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const knexLib = require('knex');

const MV = 'analytics.mv_sellout_budget_rollup';
const MIN_PAIRED_PERIODS = 4;    // = budget-sales-plan.service.ts
const MIN_ENTITY_COVERAGE = 0.8; // = budget-sales-plan.service.ts
const TESTIGO = 'mostrador:03';  // 8ESQ — la entidad que delató el defecto

let ok = 0, bad = 0, nm = 0;
const t = (name, cond, extra) => {
  if (cond) { ok++; console.log(`  ✔ ${name}`); }
  else { bad++; console.log(`  ✘ ${name}${extra ? ' — ' + extra : ''}`); }
};
const noMedido = (name, motivo) => { nm++; console.log(`  ◻ NO MEDIDO: ${name} — ${motivo}`); };
const pct = (n) => (n == null ? 'NULL' : (n * 100).toFixed(2) + '%');
const mx = (x) => Number(x || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });

(async () => {
  const url = process.env.DATABASE_URL_NEW;
  if (!url) { console.error('falta DATABASE_URL_NEW'); process.exit(1); }
  const db = knexLib({ client: 'pg', connection: url, pool: { min: 0, max: 2 } });

  try {
    await db.raw(`SET statement_timeout = '180s'`);

    console.log('\n[1] El objeto y el par de años');
    const existe = (await db.raw(`SELECT to_regclass(?) AS t`, [MV])).rows[0].t;
    if (!existe) {
      noMedido('toda la suite', `${MV} no existe: falta aplicar la migración 20261007202137`);
      console.log(`\n=== ${ok} ✓ / ${bad} ✗ / ${nm} no medidos ===\n`);
      await db.destroy(); process.exit(0);
    }
    t(`${MV} existe`, true);

    // Los dos años más recientes con real, igual que `yearsWithRealBefore` + proposeGrowth.
    // ⚠️ Se descartan los años con menos de 4 periodos: el rollup trae basura de fecha
    // (6 filas en FY2014/2020/2024 por $40,292) y tomar «primer y último año con dato»
    // da +877,002 % de crecimiento. Medido. `VERDAD_ABSOLUTA` §24.7.
    const anios = (await db.raw(`
      SELECT fiscal_year AS y, count(DISTINCT period_no)::int AS periodos, sum(monto)::float8 AS monto
        FROM ${MV} GROUP BY 1 HAVING count(DISTINCT period_no) >= 4 ORDER BY 1`)).rows;
    if (anios.length < 2) {
      noMedido('toda la suite', `hacen falta 2 años con >=4 periodos; hay ${anios.length}`);
      console.log(`\n=== ${ok} ✓ / ${bad} ✗ / ${nm} no medidos ===\n`);
      await db.destroy(); process.exit(0);
    }
    const y1 = Number(anios[anios.length - 1].y), y0 = Number(anios[anios.length - 2].y);
    t(`el par de años es consecutivo (${y0} → ${y1})`, y1 - y0 === 1, `${y0} → ${y1}`);
    t('la basura de fecha queda fuera del par',
      !anios.slice(0, -2).some((a) => Number(a.monto) > 1_000_000),
      'un año descartado con >$1M no es basura: revisar');

    console.log('\n[2] El periodo abierto');
    const cal = (await db.raw(
      `SELECT fiscal_year::int AS fy, period_no::int AS p FROM analytics.v_retail_calendar WHERE date = current_date`)).rows[0];
    const abierto = cal && Number(cal.fy) === y1 ? Number(cal.p) : null;
    console.log(`     hoy cae en FY${cal ? cal.fy : '?'} P${cal ? cal.p : '?'} → abierto=${abierto ?? 'null (año cerrado)'}`);
    t('el periodo en curso se identifica', cal != null, 'v_retail_calendar no resuelve current_date');

    const rows = (await db.raw(`
      SELECT entity_key, channel, fiscal_year::int AS year, period_no::int AS period, sum(monto)::float8 AS monto
        FROM ${MV} WHERE fiscal_year IN (?, ?) GROUP BY 1,2,3,4`, [y0, y1])).rows;
    const cerrados = new Set(rows.filter((r) => abierto == null || r.period < abierto).map((r) => r.period));
    const minEnt = Math.max(MIN_PAIRED_PERIODS, Math.ceil(cerrados.size * MIN_ENTITY_COVERAGE));
    console.log(`     periodos cerrados=${cerrados.size} → mínimo por entidad=${minEnt}`);
    t('el mínimo por entidad es alcanzable', minEnt <= cerrados.size, `${minEnt} > ${cerrados.size}`);

    // ── La regla, reimplementada acá (2ª implementación) ──────────────────────────────────
    const cob = new Map();
    for (const r of rows) {
      if (abierto != null && r.period >= abierto) continue;
      if (!(r.monto > 0)) continue;
      const e = cob.get(r.entity_key) || { a: 0, b: 0 };
      if (r.year === y0) e.a++; else if (r.year === y1) e.b++;
      cob.set(r.entity_key, e);
    }
    const nueva = (ek) => { const e = cob.get(ek); return !!e && e.a >= minEnt && e.b >= minEnt; };
    // regla VIEJA: la entidad entra si tiene cualquier monto > 0 en los dos años
    const tot = new Map();
    for (const r of rows) {
      if (abierto != null && r.period >= abierto) continue;
      const e = tot.get(r.entity_key) || { a: 0, b: 0 };
      if (r.year === y0) e.a += r.monto; else if (r.year === y1) e.b += r.monto;
      tot.set(r.entity_key, e);
    }
    const vieja = (ek) => { const e = tot.get(ek); return !!e && e.a > 0 && e.b > 0; };

    console.log('\n[3] ⭐ PRUEBA NEGATIVA POR MUTACIÓN — el testigo');
    const c = cob.get(TESTIGO), s = tot.get(TESTIGO);
    if (!s) {
      noMedido(`el testigo ${TESTIGO}`, 'la entidad ya no está en el rollup');
    } else if (nueva(TESTIGO)) {
      noMedido(`el testigo ${TESTIGO}`,
        `hoy es comparable (${c.a}/${c.b} periodos >= ${minEnt}): 8ESQ acumuló dos años completos. ` +
        'No es una falla — es evolución legítima del dato. Elegir otro testigo o retirar el bloque.');
    } else {
      t(`la regla NUEVA EXCLUYE a ${TESTIGO}`, true);
      t(`la regla VIEJA lo INCLUÍA (si no, el arreglo no arregla nada)`, vieja(TESTIGO),
        `la vieja también lo excluía: ${mx(s.a)} → ${mx(s.b)}`);
      console.log(`     ${TESTIGO}: ${mx(s.a)} → ${mx(s.b)}  ·  periodos con venta ${c ? c.a : 0}/${c ? c.b : 0} (mínimo ${minEnt})`);
    }

    console.log('\n[4] CONTROL POSITIVO DEL DETECTOR');
    const todas = [...new Set(rows.map((r) => r.entity_key))];
    const fuera = todas.filter((ek) => !nueva(ek));
    t('la regla excluye al menos una entidad (si no, es un no-op que se lee como «todo limpio»)',
      fuera.length > 0, `excluyó ${fuera.length} de ${todas.length}`);
    console.log(`     comparables=${todas.length - fuera.length}  excluidas=${fuera.length}`);

    console.log('\n[5] CONSERVACIÓN — la regla sólo QUITA, nunca altera lo que conserva');
    const sumaY1 = (pred) => rows
      .filter((r) => r.year === y1 && (abierto == null || r.period < abierto) && pred(r.entity_key))
      .reduce((a, r) => a + r.monto, 0);
    const dentroY1 = sumaY1(nueva), fueraY1 = sumaY1(() => true) - sumaY1(nueva);
    t('comparable + excluido == total, al peso',
      Math.abs((dentroY1 + fueraY1) - sumaY1(() => true)) < 0.01,
      `${mx(dentroY1)} + ${mx(fueraY1)} != ${mx(sumaY1(() => true))}`);
    console.log(`     ${y1} cerrado: comparable ${mx(dentroY1)}  ·  excluido ${mx(fueraY1)}`);

    console.log('\n[6] ⭐ EL NÚMERO: comparable contra todo, por canal');
    const yoy = (pred, filtroEnt) => {
      const m = new Map();
      for (const r of rows) {
        if (!pred(r.channel) || !filtroEnt(r.entity_key)) continue;
        const e = m.get(r.period) || { a: 0, b: 0 };
        if (r.year === y0) e.a += r.monto; else if (r.year === y1) e.b += r.monto;
        m.set(r.period, e);
      }
      let a = 0, bb = 0, paired = 0;
      for (const [p, e] of m) {
        if (abierto != null && p >= abierto) continue;
        if (e.a > 0 && e.b > 0) { a += e.a; bb += e.b; paired++; }
      }
      return paired >= MIN_PAIRED_PERIODS && a > 0 ? { g: (bb - a) / a, paired } : { g: null, paired };
    };
    const canales = [...new Set(rows.map((r) => r.channel))].sort();
    let algunoDifiere = false;
    for (const ch of canales) {
      const comp = yoy((x) => x === ch, nueva), todo = yoy((x) => x === ch, () => true);
      const dpp = (comp.g != null && todo.g != null) ? Math.abs(comp.g - todo.g) * 100 : null;
      if (dpp != null && dpp > 5) algunoDifiere = true;
      console.log(`     ${ch.padEnd(12)} todo=${pct(todo.g).padStart(9)}  comparable=${pct(comp.g).padStart(9)}  ` +
        `Δ=${dpp == null ? '—' : dpp.toFixed(2) + ' pp'}`);
    }
    t('al menos un canal cambia >5 pp al parear por entidad (si no, el arreglo es cosmético)',
      algunoDifiere, 'ningún canal se movió: o el dato ya está limpio, o la regla no se aplicó');

    const gComp = yoy(() => true, nueva), gTodo = yoy(() => true, () => true);
    console.log(`\n     GLOBAL  todo=${pct(gTodo.g)}  comparable=${pct(gComp.g)}  (pareados ${gComp.paired})`);
    if (gComp.g == null) noMedido('el crecimiento global comparable', `sólo ${gComp.paired} periodos pareados`);
    else t('el crecimiento global comparable es medible', true);

    // ── [7] `[PVI.3]` La PROCEDENCIA del supuesto ────────────────────────────────────────────
    console.log('\n[7] [PVI.3] La procedencia del supuesto guardado');
    const tieneCol = (await db.raw(`
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='budget' AND table_name='sales_plan_settings'
         AND column_name='growth_provenance'`)).rows.length > 0;
    if (!tieneCol) {
      noMedido('la procedencia del supuesto',
        'falta aplicar la migración 20261008180749_budget_sales_growth_provenance');
    } else {
      t('`budget.sales_plan_settings.growth_provenance` existe', true);
      const st = (await db.raw(`
        SELECT s.budget_id, b.name, s.default_growth_pct::float8 AS def,
               s.growth_by_channel AS g, s.growth_provenance AS p, s.updated_at
          FROM budget.sales_plan_settings s JOIN budget.budgets b ON b.id = s.budget_id`)).rows;
      if (!st.length) {
        noMedido('la procedencia', 'no hay ningún ejercicio con supuestos guardados');
      } else {
        for (const s of st) {
          const canales = Object.keys(s.g || {});
          if (!s.p) {
            // Es el estado ESPERADO hasta que corra el autopilot: la columna nace vacía y nadie
            // puede reconstruir una procedencia que no se midió. Se declara, no se falla.
            noMedido(`procedencia de «${s.name}»`,
              `${canales.length} canales con número y NINGUNO con procedencia — la fila es anterior a PVI.3 ` +
              'o el autopilot no ha vuelto a correr. NULL aquí significa DESCONOCIDA, no «sin procedencia».');
            continue;
          }
          t(`«${s.name}»: todo canal con número tiene procedencia`,
            canales.every((c) => s.p[c] != null),
            `faltan: ${canales.filter((c) => s.p[c] == null).join(', ')}`);
          // ⭐ La huella que delató a `mayoreo`: un canal cuyo número ES el default al decimal
          // tiene que declararse `default`, no `yoy_paired`. Si dice que lo midió, miente.
          for (const c of canales) {
            const esDef = Math.abs(Number(s.g[c]) - Number(s.def)) < 1e-9;
            const dice = s.p[c] && s.p[c].basis;
            if (!esDef) continue;
            t(`«${s.name}» · ${c}: su número ES el default (${pct(Number(s.def))}) y lo declara`,
              dice === 'default' || dice === 'global' || dice === 'manual',
              `declara basis='${dice}' — si de verdad lo midió, que coincida con el default es sospechoso`);
          }
          const sinMedir = canales.filter((c) => s.p[c] && s.p[c].basis === 'default');
          console.log(`     «${s.name}»: ${canales.length} canales · sin medir=${sinMedir.length}` +
            (sinMedir.length ? ` → ${sinMedir.join(', ')}` : ''));
        }
      }
    }

    // ── [8] `[PVI.2]` El `proxy_canal`: cuánto dinero mete y si tiene derecho a meterlo ───────
    console.log('\n[8] [PVI.2] El proxy de canal — meta sin ninguna señal de la entidad');
    const px = (await db.raw(`
      SELECT b.name, b.fiscal_year::int AS fy, l.entity_key,
             sum(l.meta_amount)::float8 AS meta,
             count(*)::int AS celdas,
             count(*) FILTER (WHERE l.base_amount IS NOT NULL)::int AS con_base
        FROM budget.sales_plan_lines l JOIN budget.budgets b ON b.id = l.budget_id
       WHERE l.method = 'proxy_canal'
       GROUP BY 1,2,3`)).rows;
    if (!px.length) {
      noMedido('el proxy de canal', 'ningún ejercicio tiene renglones proxy_canal — el mecanismo existe pero hoy no dispara');
    } else {
      // (a) por definición el proxy NO tiene base: si una fila la trae, el método está mal puesto.
      t('ningún renglón `proxy_canal` trae `base_amount` (por definición no tiene)',
        px.every((x) => x.con_base === 0),
        px.filter((x) => x.con_base > 0).map((x) => `${x.entity_key}:${x.con_base}`).join(', '));

      // (b) ⭐ CON DIENTES: el proxy es el ÚLTIMO recurso. Si una entidad tenía real en el año que
      //     el motor miró (prior = fy-1) y aun así cayó al proxy, la cadena de respaldo está rota.
      const porFy = [...new Set(px.map((x) => x.fy))];
      for (const fy of porFy) {
        const prior = fy - 1;
        const eks = px.filter((x) => x.fy === fy).map((x) => x.entity_key);
        const base = (await db.raw(`
          SELECT entity_key, sum(monto)::float8 AS m FROM ${MV}
           WHERE entity_key = ANY(?) AND fiscal_year = ? GROUP BY 1`, [eks, prior])).rows;
        const conBase = base.filter((r) => Number(r.m) > 0);
        t(`FY${fy}: ninguna entidad con proxy tenía real en ${prior} (el proxy es el ÚLTIMO recurso)`,
          conBase.length === 0,
          conBase.map((r) => `${r.entity_key}=${mx(r.m)}`).join(', '));

        // (c) la huella del promedio: varias entidades del mismo canal con el MISMO importe.
        const tot = (await db.raw(`
          SELECT coalesce(sum(meta_amount),0)::float8 AS m FROM budget.sales_plan_lines l
            JOIN budget.budgets b ON b.id = l.budget_id WHERE b.fiscal_year = ?`, [fy])).rows[0].m;
        const mp = px.filter((x) => x.fy === fy).reduce((a, x) => a + x.meta, 0);
        const distintos = new Set(px.filter((x) => x.fy === fy).map((x) => x.meta.toFixed(2))).size;
        console.log(`     FY${fy}: ${eks.length} entidades · ${mx(mp)} = ${pct(tot > 0 ? mp / tot : null)} de la meta · ${distintos} importe(s) distinto(s)`);
        if (eks.length > 1 && distintos < eks.length) {
          console.log(`       ⛔ ${eks.length} entidades y sólo ${distintos} importe(s): es el PROMEDIO DEL CANAL repartido en partes iguales.`);
        }
        // (d) el contraste con lo que de verdad pasó — se DECLARA, no se falla: cuánto vale el
        //     proxy es una decisión de negocio, pero publicarla sin este número no lo es.
        const real = (await db.raw(`
          SELECT coalesce(sum(monto),0)::float8 AS m FROM ${MV}
           WHERE entity_key = ANY(?) AND fiscal_year = ?`, [eks, fy])).rows[0].m;
        if (Number(real) > 0) {
          noMedido(`el acierto del proxy en FY${fy}`,
            `asignó ${mx(mp)} a entidades que hicieron ${mx(real)} = ${(mp / Number(real)).toFixed(1)}× — ` +
            'es juicio de negocio, no falla de código, pero la cifra tiene que ir a la vista');
        }
      }
    }

    console.log(`\n=== ${ok} ✓ / ${bad} ✗ / ${nm} no medidos ===\n`);
  } catch (e) {
    console.error('ERROR:', e.message);
    bad++;
  } finally {
    await db.destroy();
  }
  process.exit(bad > 0 ? 1 : 0);
})();
