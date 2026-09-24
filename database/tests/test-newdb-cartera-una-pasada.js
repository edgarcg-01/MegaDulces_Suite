#!/usr/bin/env node
/**
 * [CXC.20] La cartera de `/finanzas/cartera`, en UNA pasada y sin dos verdades.
 *
 * ── QUÉ AFIRMA ───────────────────────────────────────────────────────────────────────────
 * Tres cosas que la pantalla hacía mal y que este archivo tiene que impedir que vuelvan:
 *
 *  1. **El saldo es UNO.** El KPI usaba `max(saldo_cliente,0)` (de `kdue`, la fórmula verificada
 *     contra el PDF de Kepler) y la barra de antigüedad + el resumen gerencial sumaban
 *     `Σ saldo_ajustado`. Medido en prod el 2026-09-24: **$57,780,190.86 arriba contra
 *     $57,008,478.22 abajo**, mismos filtros, misma pantalla. Ahora el hueco es un segmento con
 *     nombre y la barra suma EXACTO el KPI.
 *  2. **Las sucursales salen del dato.** La pantalla traía su lista escrita a mano con seis
 *     (`01`..`06`) y dejaba **$45.4M — el 78.5%** sin ninguna forma de filtrarlo.
 *  3. **El vendedor se identifica por (sucursal, código).** 11 de 81 códigos de `kduv` nombran a
 *     personas distintas según la plaza.
 *
 * ── CÓMO ─────────────────────────────────────────────────────────────────────────────────
 * ⛔ El SQL se **lee del servicio real** (`customer-ledger.service.ts`), no se copia acá. Un test
 * que copia el SQL se pone verde mientras el servicio hace otra cosa — que es exactamente cómo
 * la contradicción del punto 1 sobrevivió a una suite de 12 archivos.
 *
 * ⚠️ Cada bloque tiene su **prueba negativa**: no alcanza con ver el número bueno, hay que
 * demostrar que la forma vieja daba el malo. Un gate sin prueba negativa es una intención.
 *
 * ⚠️ Sin datos el archivo reporta **NO MEDIDO**, nunca ✔ (ADR-056). Una base vacía pone verde
 * cualquier aserción sobre sumas.
 */
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const DST = process.env.DATABASE_URL_NEW
  || (() => { throw new Error('falta DATABASE_URL_NEW'); })();
const TENANT = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const SRC = path.join(__dirname, '..', '..', 'libs', 'finance', 'src', 'lib',
  'customer-ledger', 'customer-ledger.service.ts');

let ok = 0, fail = 0, nm = 0;
const P = (m) => { ok++; console.log(`  ✔ ${m}`); };
const F = (m) => { fail++; console.log(`  ✘ ${m}`); };
const NM = (m) => { nm++; console.log(`  ○ NO MEDIDO — ${m}`); };
const eq = (a, b, tol = 0.05) => Math.abs(Number(a) - Number(b)) <= tol;
const money = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * El SQL VIVO del servicio. Se extrae el bloque `const VIVA … AS almacenes\`;` y se evalúa como
 * lo que es: un template literal con dos interpolaciones (`bucket()` y `filtros`).
 */
function sqlDelServicio(filtros) {
  const src = fs.readFileSync(SRC, 'utf8');
  const i = src.indexOf("const VIVA = 'd.res > 0.005';");
  const j = src.indexOf('AS almacenes`;', i);
  if (i < 0 || j < 0) {
    throw new Error('no se encontró el bloque SQL en customer-ledger.service.ts — ¿se renombró? '
      + 'Este test lee el SQL del servicio a propósito; arreglar el marcador, no copiar el SQL.');
  }
  const chunk = src.slice(i, j + 'AS almacenes`;'.length).replace('(extra: string)', '(extra)');
  return new Function('filtros', `${chunk}\nreturn sql;`)(filtros);
}

/** knex traduce `?` a `$N`; este script habla `pg` directo y hace la misma traducción. */
function aPg(sql) {
  let out = '', n = 0, dentro = false;
  for (const ch of sql) {
    if (ch === "'") dentro = !dentro;
    out += (ch === '?' && !dentro) ? `$${++n}` : ch;
  }
  return out;
}

/** Replica la agregación que el servicio hace en Node sobre las filas que devuelve el SQL. */
function plegar(clientes) {
  const a = { saldo: 0, vencido: 0, residual: 0, n: 0, hueco: 0, huecoClientes: 0,
    por_vencer: 0, d0_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 };
  for (const c of clientes) {
    const saldo = Math.max(Number(c.saldo_cliente) || 0, 0);
    if (saldo <= 0.005) continue;
    const residual = Number(c.residual) || 0;
    a.saldo += saldo; a.vencido += Number(c.vencido) || 0; a.residual += residual; a.n++;
    for (const k of ['por_vencer', 'd0_30', 'd31_60', 'd61_90', 'd90_plus']) a[k] += Number(c[k]) || 0;
    const h = saldo - residual;
    if (Math.abs(h) > 0.005) { a.hueco += h; a.huecoClientes++; }
  }
  return a;
}

(async () => {
  const c = new Client({ connectionString: DST, statement_timeout: 300000 });
  await c.connect();
  const dest = (await c.query('SELECT inet_server_addr()::text h, current_database() d')).rows[0];
  console.log(`\n[CXC.20] cartera en una pasada  —  ${dest.h || 'local'}/${dest.d}\n`);

  const vivo = (await c.query(
    `SELECT count(*)::int n FROM analytics.customer_receivables WHERE tenant_id = $1 AND cargo_abono = 'C'`,
    [TENANT])).rows[0].n;
  if (!vivo) {
    NM('analytics.customer_receivables no tiene cargos para este tenant: no hay con qué comprobar '
      + 'ninguna suma. Correr contra una base con ODS cargado.');
    console.log(`\n${ok} ✔ · ${fail} ✘ · ${nm} ○ NO MEDIDO\n`);
    await c.end();
    process.exit(fail ? 1 : 0);
  }

  const correr = async (filtros, bind) => {
    const t = Date.now();
    const r = await c.query(aPg(sqlDelServicio(filtros)), bind);
    return { row: r.rows[0], ms: Date.now() - t };
  };

  // ── 1. Paridad: la pasada nueva da lo mismo que el cálculo viejo ────────────────────────
  console.log('1) Paridad con el cálculo anterior');
  const { row, ms } = await correr('', [TENANT, TENANT]);
  const A = plegar(row.clientes || []);
  const viejo = (await c.query(`
    WITH base AS (
      SELECT sucursal, cliente_code, max(saldo_cliente) sc,
             sum(CASE WHEN saldo_ajustado > 0.005 THEN saldo_ajustado ELSE 0 END) docs,
             sum(CASE WHEN saldo_ajustado > 0.005 AND vencimiento IS NOT NULL
                       AND (now() AT TIME ZONE 'America/Mexico_City')::date > vencimiento
                      THEN saldo_ajustado ELSE 0 END) venc
        FROM analytics.customer_receivables
       WHERE tenant_id = $1 AND cargo_abono = 'C' GROUP BY 1, 2)
    SELECT round(sum(GREATEST(sc,0)),2) saldo, round(sum(venc),2) vencido, round(sum(docs),2) docs,
           count(*)::int clientes FROM base WHERE GREATEST(sc,0) > 0.005`, [TENANT])).rows[0];
  eq(A.saldo, viejo.saldo) ? P(`saldo idéntico: ${money(A.saldo)}`) : F(`saldo ${money(A.saldo)} ≠ ${money(viejo.saldo)}`);
  eq(A.vencido, viejo.vencido) ? P(`vencido idéntico: ${money(A.vencido)}`) : F(`vencido ${money(A.vencido)} ≠ ${money(viejo.vencido)}`);
  A.n === Number(viejo.clientes) ? P(`clientes idénticos: ${A.n}`) : F(`clientes ${A.n} ≠ ${viejo.clientes}`);
  console.log(`    (una sola consulta sirve tabla + KPIs + resumen + filtros: ${ms} ms)`);

  // ── 2. UNA sola verdad del saldo ───────────────────────────────────────────────────────
  console.log('\n2) El saldo es uno solo — y el hueco tiene nombre');
  const aging = A.por_vencer + A.d0_30 + A.d31_60 + A.d61_90 + A.d90_plus;
  eq(aging, A.residual)
    ? P(`los 5 tramos de antigüedad suman el desglose por documento: ${money(aging)}`)
    : F(`tramos ${money(aging)} ≠ residual ${money(A.residual)}`);
  eq(aging + A.hueco, A.saldo)
    ? P(`tramos + «sin documento» == KPI: ${money(aging)} + ${money(A.hueco)} = ${money(A.saldo)}`)
    : F(`tramos + hueco (${money(aging + A.hueco)}) ≠ KPI (${money(A.saldo)})`);
  // ⚠️ NEGATIVA: si el hueco fuera 0 esta aserción sería vacua y no estaría probando nada.
  if (Math.abs(A.hueco) > 0.005) {
    !eq(aging, A.saldo, 0.05)
      ? P(`prueba negativa: SIN el segmento la barra valdría ${money(A.saldo - aging)} menos `
          + `(${A.huecoClientes} clientes) — el bug era real`)
      : F('el hueco existe pero la barra sin él da igual: la aserción de arriba es vacua');
  } else {
    NM('hoy no hay hueco entre kdue y el desglose: la prueba negativa no tiene caso que ejercer. '
      + 'No significa que el segmento sobre — significa que hoy no se puede comprobar.');
  }

  // ── 3. Las sucursales salen del dato, no de una lista ──────────────────────────────────
  console.log('\n3) Las sucursales las pone el dato');
  const ofrecidas = (row.opciones.sucursales || []).slice().sort();
  const enDato = (await c.query(
    `SELECT DISTINCT sucursal FROM analytics.customer_receivables
      WHERE tenant_id = $1 AND sucursal IS NOT NULL ORDER BY 1`, [TENANT])).rows.map((x) => x.sucursal);
  JSON.stringify(ofrecidas) === JSON.stringify(enDato)
    ? P(`ofrece exactamente las del dato (${ofrecidas.length}): ${ofrecidas.join(', ')}`)
    : F(`ofrece ${JSON.stringify(ofrecidas)} y el dato tiene ${JSON.stringify(enDato)}`);

  const catalogo = new Map((row.almacenes || []).map((w) => [w.code, w.name]));
  const sinNombre = ofrecidas.filter((s) => !catalogo.has(s));
  sinNombre.length === 0
    ? P('todas tienen nombre en commercial.warehouses (ninguna se muestra como código pelado)')
    : NM(`${sinNombre.length} sin nombre en el catálogo (${sinNombre.join(', ')}): se muestran `
        + 'como código, que es lo correcto — pero conviene darlas de alta');

  // ⚠️ NEGATIVA: cuánto dinero escondía la lista escrita a mano.
  const VIEJA = ['01', '02', '03', '04', '05', '06'];
  const fuera = ofrecidas.filter((s) => !VIEJA.includes(s));
  if (fuera.length) {
    const oculto = (await c.query(`
      WITH base AS (SELECT sucursal, cliente_code, max(saldo_cliente) sc
                      FROM analytics.customer_receivables
                     WHERE tenant_id = $1 AND cargo_abono = 'C' AND sucursal = ANY($2) GROUP BY 1,2)
      SELECT round(sum(GREATEST(sc,0)),2) saldo, count(*)::int n FROM base WHERE GREATEST(sc,0) > 0.005`,
      [TENANT, fuera])).rows[0];
    const pct = (Number(oculto.saldo) / A.saldo) * 100;
    P(`prueba negativa: la lista vieja (01-06) dejaba sin filtro ${fuera.join(', ')} = `
      + `$${money(oculto.saldo)} (${pct.toFixed(1)}% de la cartera, ${oculto.n} clientes)`);
  } else {
    NM('hoy no hay sucursales fuera de 01-06: la lista vieja no escondería nada y la prueba '
      + 'negativa no se puede ejercer. Vuelve a tener sentido en cuanto abra una plaza.');
  }

  // ── 4. El vendedor se identifica por (sucursal, código) ────────────────────────────────
  console.log('\n4) El vendedor es (sucursal, código), no el código pelado');
  const amb = (await c.query(`
    SELECT count(*)::int total, count(*) FILTER (WHERE nombres > 1)::int ambiguos
      FROM (SELECT btrim(c2) code, count(DISTINCT btrim(c3)) nombres
              FROM kepler_ods.kduv WHERE btrim(COALESCE(c2,'')) <> '' GROUP BY 1) t`)).rows[0];
  const rollup = row.por_vendedor || [];
  const llaves = new Set(rollup.map((v) => `${v.sucursal}||${v.code}`));
  llaves.size === rollup.length
    ? P(`el rollup tiene una fila por (sucursal, código): ${rollup.length} filas, ${llaves.size} llaves`)
    : F('el rollup repite (sucursal, código): está agregando mal');
  const conNombre = rollup.filter((v) => v.nombre).length;
  conNombre > 0
    ? P(`${conNombre} de ${rollup.length} filas traen el nombre de kduv (antes ninguna)`)
    : F('ninguna fila resolvió nombre: el join contra kduv no está funcionando');
  // ⚠️ NEGATIVA: si agrupara por código pelado, ¿cuántas carteras se fundirían con nombre ajeno?
  if (Number(amb.ambiguos) > 0) {
    const porCodigo = new Set(rollup.map((v) => v.code));
    porCodigo.size < llaves.size
      ? P(`prueba negativa: ${amb.ambiguos} de ${amb.total} códigos de kduv nombran a personas `
          + `distintas según la plaza, y agrupar por código pelado colapsaría ${llaves.size} filas en ${porCodigo.size}`)
      : NM('hay códigos ambiguos en kduv pero ninguno aparece en dos sucursales dentro de esta '
          + 'cartera: el colapso no se puede demostrar con los datos de hoy');
  } else {
    NM('ningún código de kduv es ambiguo hoy: no hay caso que ejercer para la prueba negativa');
  }

  // ── 5. Los filtros siguen filtrando (y el invariante aguanta filtrado) ─────────────────
  console.log('\n5) Con filtro, el invariante se sostiene');
  const unaSuc = enDato[0];
  const f = await correr('WHERE d.sucursal = ?', [TENANT, unaSuc, TENANT]);
  const B = plegar(f.row.clientes || []);
  const soloUna = new Set((f.row.clientes || []).map((x) => x.sucursal));
  soloUna.size === 1 && soloUna.has(unaSuc)
    ? P(`filtro sucursal='${unaSuc}' devuelve sólo esa sucursal (${B.n} clientes, ${f.ms} ms)`)
    : F(`el filtro dejó pasar ${[...soloUna].join(',')}`);
  const agingB = B.por_vencer + B.d0_30 + B.d31_60 + B.d61_90 + B.d90_plus;
  eq(agingB + B.hueco, B.saldo)
    ? P(`filtrado: tramos + hueco == KPI (${money(B.saldo)})`)
    : F(`filtrado: ${money(agingB + B.hueco)} ≠ ${money(B.saldo)}`);
  // Las opciones NO se recortan con el filtro: elegir una sucursal no puede borrar las otras.
  JSON.stringify((f.row.opciones.sucursales || []).slice().sort()) === JSON.stringify(ofrecidas)
    ? P('con la sucursal filtrada, el desplegable sigue ofreciendo las 9')
    : F('filtrar por sucursal recortó el propio desplegable: quedaría sin forma de volver');

  console.log(`\n${ok} ✔ · ${fail} ✘ · ${nm} ○ NO MEDIDO\n`);
  await c.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\n✘ ', e.message); process.exit(1); });
