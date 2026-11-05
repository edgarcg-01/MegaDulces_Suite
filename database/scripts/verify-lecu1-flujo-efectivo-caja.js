#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * `[LE.CU.1]` **Reproduce contra prod, en SÓLO LECTURA, las cifras de `VERDAD_ABSOLUTA.md` §36**:
 * el efectivo de Caja General seguido desde su origen y al revés.
 *
 *   node database/scripts/verify-lecu1-flujo-efectivo-caja.js [desde YYYY-MM-DD] [hasta YYYY-MM-DD]
 *
 * Por omisión, del primer corte del libro (12-oct) al 3-nov: la ventana medida el 2026-11-04.
 * Necesita `PROD_DB_URL` (cuenta de sólo lectura; `resolverProd` lo exige y verifica el clúster
 * por `system_identifier`, no por el nombre de la base).
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────────────────────
 * §36 se midió con guiones de una sesión que vivían fuera del repo: sin ellos la sección no se
 * podía volver a correr, y una cifra que no se puede reproducir no es verdad absoluta (es un
 * relato). Este guion es la capa C0 del rediseño del Cuadre (`FASE_LE_ANEXO_CUADRE.md`): los
 * motores de `[LE.CU.2]` tienen que publicar estas mismas cifras.
 *
 * ── Qué mide (cada bloque con su sección) ───────────────────────────────────────────────────
 *   1. el cuadre libro↔Kepler día por día, con los MOTORES DEL SERVICIO (§36.2): el residuo de
 *      cada día tiene que ser $0.00;
 *   2. el replay de la bóveda contra el inventario que publica la máquina (§36.4);
 *   3. el balance físico de la ventana (§36.4 y §36.5), con el bulto «morralla» aparte;
 *   4. Canindo: venta de la camioneta contra cobro (§36.3);
 *   5. cobros a `0001` DEVOLUCIONES y cortes de las cajas que alimentan Caja General (§36.3b, §36.8).
 *
 * Los motores se cargan con `ts-node` en modo transpile-only: no compila ni levanta el backend
 * (CLAUDE.md regla 3); sólo lee las funciones puras de `libs/finance/src/lib/caja/`.
 */
const path = require('path');

const RAIZ = path.resolve(__dirname, '..', '..');
require(path.join(RAIZ, 'node_modules', 'dotenv')).config({ path: path.join(RAIZ, '.env'), quiet: true });
// Sin el tsconfig del repo: sólo se transpilan las funciones puras (TS 6 exige `rootDir` al proyecto).
process.env.TS_NODE_SKIP_PROJECT = 'true';
process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: "commonjs", target: "es2020", esModuleInterop: true, ignoreDeprecations: "6.0" });
require(path.join(RAIZ, 'node_modules', 'ts-node', 'register', 'transpile-only'));
const { resolverProd } = require('./lib/destino-prod');

const CAJA = path.join(RAIZ, 'libs', 'finance', 'src', 'lib', 'caja');
const { casarPorImporte, estadoDiaCuadre, CUADRE_TOLERANCIA_PESOS } = require(path.join(CAJA, 'caja-cuadre.engine.ts'));
const { casarLibroConKepler, cobroDeRutaComoKepler, juntaCuadres, llaveKeplerDelLibro } = require(path.join(CAJA, 'caja-kepler-libro.engine.ts'));

const T = '00000000-0000-0000-0000-00000000d01c';
const EPS = CUADRE_TOLERANCIA_PESOS;
const n = (x) => Number(x) || 0;
const r2 = (v) => Math.round(v * 100) / 100;
const mx = (v) => '$' + Number(v || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const ymd = (f) => {
  if (f instanceof Date) { const p = (k) => String(k).padStart(2, '0'); return `${f.getFullYear()}-${p(f.getMonth() + 1)}-${p(f.getDate())}`; }
  return String(f).slice(0, 10);
};
const kkey = (r) => `${r.sucursal}|${r.doc_tipo}|${r.folio}|${r.clave_banco}`;
const NUM = (c) => `coalesce(NULLIF(regexp_replace(${c}::text,'[^0-9.-]','','g'),'')::numeric,0)`;
/** Las rutas: almacén de Kepler ↔ número de ruta. Canindo sólo existe en el carril de la camioneta. */
const RUTAS = { 21: '01-001', 22: '01-002', 23: '01-003', 26: '01-004', 27: '01-005', 28: '01-006', 501: '06-001', 502: '06-002', 503: '06-003', 504: '06-004', 505: '06-005' };

async function cuadreDia(trx, dk) {
  const libro = (await trx('finance.cash_ledger').where('tenant_id', T).whereNull('deleted_at').whereNot('estado', 'cancelado').andWhere('fecha', dk)
    .select('folio', 'tipo', 'monto', 'glosa', 'origen_tipo', 'origen_ref', 'declared_doc_ref'))
    .map((r) => ({ ...r, dir: r.tipo === 'ingreso' ? 'in' : 'out', ref: llaveKeplerDelLibro(r) }));
  const kep = await trx('analytics.kepler_bank_movements').where('tenant_id', T).andWhere('account_label', 'CG').andWhere('fecha_valor', dk)
    .select('sucursal', 'clave_banco', 'folio', 'fecha_valor as fecha', 'concepto', 'doc_tipo', 'importe', 'signo');
  const rc = await trx('analytics.route_collections').where('tenant_id', T).andWhere('cuenta', '0011').andWhere('fecha', dk)
    .groupBy('almacen', 'cobro_folio', 'fecha').select('almacen', 'cobro_folio', 'fecha', trx.raw('SUM(importe)::numeric AS importe'), trx.raw('NULL AS truck'), trx.raw('NULL AS concepto'));
  kep.push(...rc.map(cobroDeRutaComoKepler));
  const lbl = (r) => ({ id: String(r.folio), key: kkey(r), fecha: ymd(r.fecha), importe: r2(n(r.importe)) });
  const kepSide = (s) => kep.filter((r) => (n(r.signo) > 0 ? 1 : -1) === s).map(lbl);
  const libSide = (dir) => libro.filter((r) => r.dir === dir).map((r) => ({ id: r.folio, key: `libro|${r.folio}`, fecha: dk, importe: r2(n(r.monto)), ref: r.ref }));
  const enDia = new Set(kep.map(kkey));
  const refs = [...new Set(libro.map((r) => r.ref).filter((k) => k && !enDia.has(k)))];
  const fuera = new Map();
  if (refs.length) {
    const tes = await trx('analytics.kepler_bank_movements').where('tenant_id', T).andWhere('account_label', 'CG')
      .whereRaw(`sucursal || '|' || doc_tipo || '|' || folio || '|' || clave_banco = ANY(?)`, [refs])
      .select('sucursal', 'clave_banco', 'folio', 'fecha_valor as fecha', 'doc_tipo', 'importe', 'signo');
    const rc2 = await trx('analytics.route_collections').where('tenant_id', T).whereRaw(`almacen || '|U-A-5|' || cobro_folio || '|' || cuenta = ANY(?)`, [refs])
      .groupBy('almacen', 'cobro_folio', 'fecha').select('almacen', 'cobro_folio', 'fecha', trx.raw('SUM(importe)::numeric AS importe'), trx.raw('NULL AS truck'), trx.raw('NULL AS concepto'));
    for (const r of [...tes, ...rc2.map(cobroDeRutaComoKepler)]) fuera.set(kkey(r), lbl(r));
  }
  const lado = (dir, s) => juntaCuadres(casarPorImporte([], [], EPS), casarLibroConKepler(libSide(dir), kepSide(s), EPS, fuera));
  const vin = lado('in', 1), vout = lado('out', -1);
  /**
   * El residuo: la diferencia del día (la de `conciliacionWorkbook`) menos lo que explican los
   * movimientos con nombre. ⚠️ La diferencia del día suma Kepler por `signo>0` / `signo<0`, y el
   * casamiento manda el `signo` nulo al lado del gasto: los sin dirección se suman de vuelta, que
   * es justamente el defecto de §36.2 escrito como aritmética.
   */
  const suma = (xs) => xs.reduce((a, x) => a + n(x.importe ?? x.monto), 0);
  const residuo = {};
  for (const [dir, s, v] of [['in', 1, vin], ['out', -1, vout]]) {
    const delta = suma(libro.filter((r) => r.dir === dir)) - suma(kep.filter((r) => (s > 0 ? n(r.signo) > 0 : n(r.signo) < 0)));
    const otroDia = v.pares.filter((p) => p.otro.fecha !== dk).reduce((a, p) => a + p.caja.importe, 0);
    const deltasPar = v.pares.filter((p) => p.otro.fecha === dk).reduce((a, p) => a + p.delta, 0);
    const sinSigno = s < 0 ? suma(kep.filter((r) => r.signo == null || n(r.signo) === 0)) : 0;
    residuo[dir] = r2(delta - (v.caja_solos_monto - v.otro_solos_monto + otroDia + deltasPar + sinSigno));
  }
  return { solosKep: [...vin.otro_solos, ...vout.otro_solos], solosLib: [...vin.caja_solos, ...vout.caja_solos], residuo };
}

/**
 * El contenido de la bóveda en un instante: el último inventario que publicó la máquina antes de
 * ese instante, o —antes del primer inventario (27-oct)— el replay hacia atrás desde él. El replay
 * se valida en el bloque 2; sin esa validación este número no vale.
 */
function bovedaEn(t, counts, mov) {
  const sg = (m) => ({ Deposito: 1, Dispensar: -1, 'Vaciar Stocks': -1, Dotar: 1 }[m.type_label] || 0);
  const antes = counts.filter((c) => new Date(c.captured_at) <= t);
  if (antes.length) return n(antes[antes.length - 1].t);
  const c0 = counts[0];
  return n(c0.t) - mov.filter((m) => new Date(m.occurred_at) > t && +m.id <= +c0.a).reduce((s, m) => s + sg(m) * n(m.t), 0);
}

(async () => {
  const knex = await resolverProd();
  try {
    await knex.transaction(async (trx) => {
      await trx.raw('SET TRANSACTION READ ONLY');
      await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [T]);
      await trx.raw("SET LOCAL statement_timeout = '180s'");
      const primer = await trx('finance.cash_ledger_cuts').where('tenant_id', T).orderBy('fecha', 'asc').first('fecha');
      const desde = process.argv[2] || ymd(primer.fecha);
      const hasta = process.argv[3] || '2026-11-03';
      console.log(`\n[LE.CU.1] ventana ${desde} → ${hasta} · prod verificado, transacción READ ONLY\n`);

      // ── 1. El cuadre libro↔Kepler, día por día (§36.2) ──────────────────────────────────────
      let dias = 0, conResiduo = 0, solosK = 0, solosKm = 0, solosL = 0, solosLm = 0;
      for (let d = new Date(desde + 'T12:00:00'); ymd(d) <= hasta; d.setDate(d.getDate() + 1)) {
        const dk = ymd(d); const c = await cuadreDia(trx, dk); dias++;
        if (Math.abs(c.residuo.in) > 0.01 || Math.abs(c.residuo.out) > 0.01) { conResiduo++; console.log(`  ⚠ ${dk} residuo entra ${mx(c.residuo.in)} · sale ${mx(c.residuo.out)}`); }
        solosK += c.solosKep.length; solosKm += c.solosKep.reduce((a, x) => a + x.importe, 0);
        solosL += c.solosLib.length; solosLm += c.solosLib.reduce((a, x) => a + x.importe, 0);
      }
      console.log(`1. Cuadre: ${dias} días · con residuo ${conResiduo} (debe ser 0) · Kepler sin pareja ${solosK} (${mx(solosKm)}) · libro sin pareja ${solosL} (${mx(solosLm)})`);
      console.log('   ⚠ «Kepler sin pareja» incluye lo ya capturado en otro día; §36.2 lo parte con la llave del libro.');

      // ── 2. La bóveda: replay contra el inventario de la máquina (§36.4) ──────────────────────
      const counts = (await trx.raw(`SELECT after_external_id::bigint a, total::numeric t, captured_at FROM analytics.caos_cash_counts WHERE tenant_id=? ORDER BY captured_at`, [T])).rows;
      const mov = (await trx.raw(`SELECT external_id::bigint id, type_label, total::numeric t, occurred_at FROM analytics.caos_cash_movements WHERE tenant_id=? AND occurred_at >= '2026-10-09' ORDER BY occurred_at, external_id`, [T])).rows;
      const sg = (m) => ({ Deposito: 1, Dispensar: -1, 'Vaciar Stocks': -1, Dotar: 1 }[m.type_label] || 0);
      let ok = 0;
      for (let i = 1; i < counts.length; i++) {
        const a = counts[i - 1], b = counts[i];
        const fl = mov.filter((m) => +m.id > +a.a && +m.id <= +b.a).reduce((s, m) => s + sg(m) * n(m.t), 0);
        if (Math.abs(n(a.t) + fl - n(b.t)) < 0.01) ok++;
      }
      // El instante del arqueo A23641 (10-oct 12:58:46 MX), con el que abre el primer corte del libro.
      const A23641 = new Date('2026-10-10T18:58:46Z');
      console.log(`2. Bóveda: ${ok} de ${counts.length - 1} conteos consecutivos cierran con el replay · contenido al cierre del 10-oct ${mx(bovedaEn(A23641, counts, mov))} (§36.4: $342,500)`);

      // ── 3. El balance físico de la ventana (§36.4, §36.5) ────────────────────────────────────
      const cortes = (await trx.raw(`SELECT c.folio, c.fecha, c.fondo_inicial, c.contado, c.morralla, c.closed_at,
          (SELECT sum(d.denominacion*d.piezas) FROM finance.cash_ledger_cut_denominations d WHERE d.cut_id=c.id) piezas,
          (SELECT coalesce(sum(monto) FILTER (WHERE tipo='ingreso'),0) FROM finance.cash_ledger l WHERE l.corte_id=c.id AND l.deleted_at IS NULL AND l.estado<>'cancelado') ing,
          (SELECT coalesce(sum(monto) FILTER (WHERE tipo<>'ingreso'),0) FROM finance.cash_ledger l WHERE l.corte_id=c.id AND l.deleted_at IS NULL AND l.estado<>'cancelado') gas
        FROM finance.cash_ledger_cuts c WHERE c.tenant_id=? AND c.fecha BETWEEN ? AND ? ORDER BY c.fecha`, [T, desde, hasta])).rows;
      // El físico inicial: el cajón con que abre el primer corte de la ventana + la bóveda en ese
      // instante. Para la ventana por omisión es el arqueo A23641; para otra, el cierre del corte
      // anterior (lo contado pieza por pieza, sin el bulto).
      const previo = (await trx.raw(`SELECT c.closed_at, (SELECT sum(d.denominacion*d.piezas) FROM finance.cash_ledger_cut_denominations d WHERE d.cut_id=c.id) piezas
        FROM finance.cash_ledger_cuts c WHERE c.tenant_id=? AND c.fecha < ? ORDER BY c.fecha DESC LIMIT 1`, [T, desde])).rows[0];
      const inicioT = previo ? new Date(previo.closed_at) : A23641;
      const cajon0 = previo ? n(previo.piezas) : n(cortes[0].fondo_inicial);
      // ⚠️ El gasto de las 12:59 del 10-oct (CG-2026-00018) se pagó con lo dispensado DESPUÉS del
      // arqueo y no quedó en ningún corte: pertenece a la ventana por omisión.
      const sinCorte = previo ? 0 : n((await trx.raw(`SELECT coalesce(sum(monto),0) s FROM finance.cash_ledger WHERE tenant_id=? AND corte_id IS NULL AND deleted_at IS NULL AND estado<>'cancelado' AND tipo<>'ingreso' AND fecha='2026-10-10'`, [T])).rows[0].s);
      const I = cortes.reduce((s, c) => s + n(c.ing), 0), G = cortes.reduce((s, c) => s + n(c.gas), 0) + sinCorte;
      const ult = cortes[cortes.length - 1];
      const P0 = cajon0 + bovedaEn(inicioT, counts, mov);
      const B1 = bovedaEn(new Date(ult.closed_at), counts, mov);
      const P1 = n(ult.piezas) + B1;
      const esperado = r2(P0 + I - G);
      console.log(`3. Balance físico: inicial ${mx(P0)} + ingresos ${mx(I)} − gastos ${mx(G)} = esperado ${mx(esperado)}`);
      console.log(`   contado pieza por pieza al cierre de ${ult.folio}: cajón ${mx(ult.piezas)} + bóveda ${mx(B1)} = ${mx(P1)} → diferencia ${mx(P1 - esperado)} (§36.4: faltan $48,047.70)`);
      const bultos = cortes.filter((c) => n(c.morralla) > 0.49).map((c) => `${ymd(c.fecha).slice(5)} ${mx(c.morralla)}`);
      console.log(`   bulto tecleado como morralla (> 49¢, sin desglose) en ${bultos.length} cortes: ${bultos.join(' · ')}`);

      // ── 4. Canindo: venta de la camioneta contra cobro (§36.3) ───────────────────────────────
      let tot = 0;
      const lineas = [];
      for (const [ruta, alm] of Object.entries(RUTAS).filter(([r]) => +r >= 500)) {
        const v = (await trx.raw(`SELECT coalesce(sum(venta),0) s FROM analytics.v_rd_route_daily WHERE tenant_id=? AND route_code=? AND business_date BETWEEN ? AND ?`, [T, ruta, desde, hasta])).rows[0].s;
        const k = (await trx.raw(`SELECT coalesce(sum(importe),0) s FROM analytics.route_collections WHERE tenant_id=? AND almacen=? AND fecha BETWEEN ? AND ?`, [T, alm, desde, hasta])).rows[0].s;
        tot += n(v) - n(k); lineas.push(`ruta ${ruta} ${mx(n(v) - n(k))}`);
      }
      console.log(`4. Canindo, vendido sin cobro en la ventana: ${mx(tot)} (${lineas.join(' · ')})`);

      // ── 5. Cobros a 0001 y cortes de las cajas que alimentan Caja General (§36.3b, §36.8) ────
      const c0001 = (await trx.raw(`SELECT count(*) n, coalesce(sum(${NUM('c16')}),0) s FROM kepler_ods.kdm1 WHERE c2='U' AND c3='A' AND btrim(c4::text)='5' AND btrim(c45)='0001' AND btrim(coalesce(c43,''))<>'C' AND c9::date BETWEEN ? AND ?`, [desde, hasta])).rows[0];
      console.log(`5. Cobros U-A-5 a 0001 DEVOLUCIONES: ${c0001.n} por ${mx(c0001.s)} (§36.8 cuenta también el 4-nov: 7 por $163,882.36)`);
      const alim = (await trx.raw(`WITH c AS (SELECT k.sucursal, btrim(k.c6) folio, btrim(k.c5::text) serie, ${NUM('k.c16')} imp FROM kepler_ods.kdm1 k
           WHERE k.c2='U' AND k.c3='D' AND btrim(k.c4::text)='23' AND btrim(k.c1)=k.sucursal AND btrim(coalesce(k.c43,''))<>'C' AND k.c9::date BETWEEN ? AND ?
             AND ((k.sucursal='01' AND btrim(k.c27::text)='4') OR (k.sucursal='07' AND btrim(k.c27::text) IN ('3','4')) OR (k.sucursal='08' AND btrim(k.c27::text)='9')))
         SELECT c.sucursal, sum(c.imp - coalesce((SELECT sum(${NUM('a.c12')}) FROM kepler_ods.kdm5 a JOIN kepler_ods.kdm1 ab ON ab.sucursal=a.sucursal AND ab.c1=a.c1 AND ab.c2=a.c2 AND ab.c3=a.c3 AND ab.c4=a.c4 AND ab.c5=a.c5 AND ab.c6=a.c6
               WHERE a.sucursal=c.sucursal AND btrim(a.c1::text)=c.sucursal AND a.c8='D' AND btrim(a.c9::text)='23' AND btrim(a.c11::text)=c.folio AND btrim(a.c10::text)=c.serie AND btrim(coalesce(ab.c43,''))<>'C'),0)) sin_cobro
         FROM c GROUP BY 1 ORDER BY 1`, [desde, hasta])).rows;
      console.log(`   cortes de las cajas que alimentan Caja General, sin cobrar: ${alim.map((a) => `suc. ${a.sucursal} ${mx(a.sin_cobro)}`).join(' · ')} (§36.3b: $289,200.09 del 29-oct al 3-nov)`);
    });
  } finally {
    await knex.destroy();
  }
})().catch((e) => { console.error('\n✗', e.message); process.exit(1); });
