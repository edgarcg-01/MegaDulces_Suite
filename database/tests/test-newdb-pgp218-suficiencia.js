/**
 * `[PGP.218]` ANTES DEL PROGRAMA, EL DINERO DEL CARGO EN SU CUENTA — la lectura (`leerEntradaDeSuficiencia`,
 * `saldosConocidos`) y la regla (`armarSuficiencia`), los módulos TS reales, contra prod en SÓLO LECTURA.
 *
 *   A. EL SALDO ES EL DE BANCOS — `saldosConocidos` (una consulta por fuente para todas las cuentas) da el mismo saldo
 *      que la regla que `EstadoDeCuentaService.saldoConocido` tenía antes de llamarla (cuenta por cuenta, aquí en JS),
 *      en cada cuenta y en fechas de todo el año.
 *   B. ⭐ DOS DÍAS RECONSTRUIDOS — con el saldo de ese día, la historia de cargos HASTA ese día (`[PGP.209]` con el día
 *      cambiado) y lo que de hecho salió del banco como programa:
 *      · Santander 2169 al cierre del 12-nov: sin ningún programa, los 4 cargos de la arrendadora del 14 no cabían; y el
 *        banco los cobró tarde (el testigo, que la regla no lee).
 *      · BanBajío 4166 al cierre del 16-jul: lo que salió el 17 pasaba el saldo; ese día el banco cobró la penalización
 *        por intento de sobregiro (el testigo).
 *      · NEGATIVA: el mismo 2169 sin los cargos y sin programa: alcanza, sin aviso.
 *   C. HOY — la lectura real del endpoint, con la vista de `[PGP.209]` como subconsulta (todavía no está en prod): cada
 *      cuenta con su estado, los cargos son las series vigentes de la ventana, y sin la vista se declara.
 *   Sin los datos de prod (CI): NO MEDIDO, nunca verde.
 */
const path = require('path');
const fs = require('fs');
try { require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true }); } catch { /* opcional */ }
require('ts-node').register({
  transpileOnly: true, skipProject: true,
  compilerOptions: { module: 'commonjs', target: 'es2020', esModuleInterop: true, moduleResolution: 'node', ignoreDeprecations: '6.0' },
});
{
  const ts = require('typescript');
  const RAIZ = path.resolve(__dirname, '..', '..');
  const cfg = ts.parseConfigFileTextToJson('tsconfig.base.json', fs.readFileSync(path.join(RAIZ, 'tsconfig.base.json'), 'utf8')).config;
  const paths = cfg.compilerOptions.paths || {};
  const Module = require('module');
  const orig = Module._resolveFilename;
  Module._resolveFilename = function (req, ...rest) {
    return orig.call(this, paths[req] ? path.join(RAIZ, paths[req][0]) : req, ...rest);
  };
}
const LIB = path.resolve(__dirname, '../../libs/finance/src/lib');
const { saldosConocidos } = require(path.join(LIB, 'bank/estado-de-cuenta/saldo-conocido.query.ts'));
const { cierreDelDia } = require(path.join(LIB, 'bank/estado-de-cuenta/saldo-del-libro.ts'));
const { armarSuficiencia, masDias, DIAS_CARGO_DETENIDO } = require(path.join(LIB, 'payment-calendar/suficiencia-de-cuentas.ts'));
const { leerEntradaDeSuficiencia, VISTA_DE_CARGOS } = require(path.join(LIB, 'payment-calendar/suficiencia-de-cuentas.query.ts'));
const MIG209 = require('../migrations-newdb/20261125224611_pgp209_cargos_recurrentes_del_banco.js');

const T = '00000000-0000-0000-0000-00000000d01c';
let pass = 0, fail = 0, nm = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const noMedido = (m) => { nm++; console.log('  ·  NO MEDIDO —', m); };
const knex = require('knex')(require('../knexfile-newdb.js').development);
const salir = async () => {
  await knex.destroy();
  console.log(`\n  ${pass} ✓ · ${fail} ✗ · ${nm} no medido`);
  process.exit(fail ? 1 : (pass ? 0 : 2));
};
const soloLectura = (fn) => knex.transaction(async (trx) => {
  await trx.raw('SET TRANSACTION READ ONLY');
  await trx.raw('SET LOCAL statement_timeout = 180000');
  await trx.raw(`SET LOCAL app.tenant_id = '${T}'`);
  return fn(trx);
});
const $ = (n) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** La regla de `EstadoDeCuentaService.saldoConocido` ANTES de `[PGP.218]`, cuenta por cuenta (el control). */
async function saldoConocidoAntes(trx, cuentaId, antesDe) {
  const delBanco = await trx('finance.bank_statement_lines')
    .where({ bank_account_id: cuentaId }).andWhere('movement_date', '<', antesDe)
    .orderBy([{ column: 'movement_date', order: 'desc' }, { column: 'created_at', order: 'desc' }, { column: 'seq', order: 'desc' }])
    .first('running_balance');
  if (delBanco) return Number(delBanco.running_balance);
  const ultimoDia = await trx('finance.bank_movements')
    .where({ bank_account_id: cuentaId }).whereNull('deleted_at').whereNotNull('running_balance')
    .andWhere('movement_date', '<', antesDe).first(trx.raw("to_char(max(movement_date), 'YYYY-MM-DD') as d"));
  if (!ultimoDia || !ultimoDia.d) return null;
  const delDia = await trx('finance.bank_movements')
    .where({ bank_account_id: cuentaId, movement_date: ultimoDia.d }).whereNull('deleted_at')
    .select('amount_in', 'amount_out', 'running_balance');
  return cierreDelDia(delDia);
}

/** La vista de `[PGP.209]` como si hoy fuera `dia`: sólo los movimientos hasta ese día. */
const vistaAl = (dia) => `(${MIG209.SELECT_SQL
  .replace(/finance\.bank_movements m\b/g, `(SELECT * FROM finance.bank_movements WHERE movement_date <= DATE '${dia}') m`)
  .replace(/FROM finance\.bank_movements\n/g, `FROM (SELECT * FROM finance.bank_movements WHERE movement_date <= DATE '${dia}') bm0\n`)
  .replace(/current_date/g, `DATE '${dia}'`)})`;

/** Un día reconstruido: el saldo de ese día, la historia hasta ese día y, como programa, lo que de hecho salió. */
async function reconstruir(trx, cuentaLabel, hoy, { diasDePrograma }) {
  const ba = (await trx.raw(`SELECT id::text AS id, bank, account_label, alias FROM finance.bank_accounts
     WHERE tenant_id = ? AND kind = 'bank' AND right(account_label, 4) = ?`, [T, cuentaLabel])).rows[0];
  if (!ba) return null;
  const hasta = masDias(hoy, 7);
  const saldos = await saldosConocidos(trx, [ba.id], masDias(hoy, 1));
  const series = (await trx.raw(`
    SELECT v.bank_account_id::text AS bank_account_id, v.series_key, v.rule, v.concept_head, v.latest_concept,
           to_char(v.next_expected_date, 'YYYY-MM-DD') AS next_expected_date, v.expected_monthly_amount::float AS expected_monthly_amount
      FROM ${vistaAl(hoy)} v WHERE v.bank_account_id = ? AND v.is_active AND v.next_expected_date <= ?`, [ba.id, hasta])).rows;
  let pagos = [];
  if (diasDePrograma > 0) {
    // Lo que salió de la cuenta esos días, sin lo que cobra el banco (las series de [PGP.209] y sus comisiones).
    const deSerie = new Set((await trx.raw(`SELECT unnest(movement_ids)::text AS id FROM (${MIG209.SELECT_SQL}) v WHERE bank_account_id = ?`, [ba.id])).rows.map((r) => r.id));
    pagos = (await trx.raw(`SELECT id::text, to_char(movement_date, 'YYYY-MM-DD') AS fecha, amount_out::float AS importe, concept
        FROM finance.bank_movements WHERE bank_account_id = ? AND deleted_at IS NULL AND amount_out > 0 AND movement_date > ? AND movement_date <= ?`,
    [ba.id, hoy, masDias(hoy, diasDePrograma)])).rows
      .filter((r) => !deSerie.has(r.id) && !/PENALIZ|SOBREGIRO|COMISI|IVA/i.test(r.concept || ''))
      .map((r) => ({ allocation_id: r.id, bank_account_id: ba.id, fecha: r.fecha, importe: r.importe, ejecutado: false }));
  }
  const s = armarSuficiencia({ hoy, hasta, cuentas: [ba], saldos, series, pagos, sinCuenta: { pagos: 0, importe: 0 } });
  return { ba, cuenta: s.cuentas[0] };
}

(async () => {
  console.log('\n[PGP.218] ¿le alcanza a la cuenta para lo programado y para los cargos del banco? — módulos reales, sólo lectura\n');
  const hay = await soloLectura(async (trx) => {
    if (!(await trx.raw(`SELECT to_regclass('finance.bank_statement_lines') IS NOT NULL AS t`)).rows[0].t) return 0;
    return (await trx.raw(`SELECT count(*)::int AS n FROM finance.bank_movements WHERE deleted_at IS NULL AND amount_out > 0 AND movement_date >= '2026-07-01'`)).rows[0].n;
  }).catch((e) => { noMedido(`no hay Postgres: ${e.message}`); return -1; });
  if (hay < 0) return salir();
  if (hay < MIG209.RETIROS_DE_PROD) { noMedido(`esta base tiene ${hay} retiros de banco (CI): los controles se miden contra prod`); return salir(); }

  await soloLectura(async (trx) => {
    console.log(' A. El saldo es el de Bancos');
    const cuentas = (await trx.raw(`SELECT id::text AS id FROM finance.bank_accounts WHERE tenant_id = ? AND active AND kind IN ('bank', 'factoraje')`, [T])).rows.map((r) => r.id);
    const fechas = [];
    for (let m = 1; m <= 11; m++) for (const d of ['01', '16']) fechas.push(`2026-${String(m).padStart(2, '0')}-${d}`);
    for (let k = 0; k < 10; k++) fechas.push(masDias('2026-11-16', k));
    let iguales = 0, total = 0, conSaldo = 0; const difieren = [];
    for (const f of fechas) {
      const lote = await saldosConocidos(trx, cuentas, f);
      for (const id of cuentas) {
        total++;
        const nuevo = lote.get(id)?.saldo ?? null;
        const antes = await saldoConocidoAntes(trx, id, f);
        if (nuevo === antes) { iguales++; if (nuevo !== null) conSaldo++; } else if (difieren.length < 3) difieren.push(`${id.slice(0, 8)} ${f}: antes ${antes}, ahora ${nuevo}`);
      }
    }
    ok(iguales === total && conSaldo > total / 2,
      `saldosConocidos (una consulta por fuente) = la regla de EstadoDeCuentaService en ${iguales} de ${total} (cuenta × fecha; ${conSaldo} con saldo)${difieren.length ? ` — ${difieren.join(' · ')}` : ''}`);

    console.log('\n B. Dos días reconstruidos (la historia hasta ese día; lo que de hecho salió como programa)');
    const n12 = await reconstruir(trx, '2169', '2026-11-12', { diasDePrograma: 0 });
    if (!n12 || n12.cuenta.saldo === null) noMedido('Santander 2169 al 12-nov: sin saldo');
    else {
      const c = n12.cuenta;
      const arr = c.cargos.filter((x) => x.concepto === 'DOMICILIACION PAGO SERVICIO');
      console.log(`    → 2169 al cierre del 12-nov: saldo ${$(c.saldo)} (${c.saldo_fuente}); cargos ${c.cargos.length} (${$(c.cargos_total)}): ` +
        `${c.cargos.map((x) => `${$(x.importe)} el ${x.fecha}`).join(', ')}; faltan ${$(c.faltan)}`);
      ok(c.estado === 'no_alcanza' && arr.length === 4 && c.cargos_total === 79876 && c.faltan === 48731.55 && c.cargo_sin_cubrir?.fecha === '2026-11-14',
        `Santander 2169, 12-nov, SIN programa: los 4 cargos de la arrendadora del 14 ($79,876) no caben en ${$(c.saldo)}: faltan ${$(c.faltan)} (medido $48,731.55); el primero sin cubrir, ${$(c.cargo_sin_cubrir?.importe)} del ${c.cargo_sin_cubrir?.fecha}`);
      // El testigo, que la regla no lee: ¿cuándo los cobró el banco?
      const cobros = (await trx.raw(`SELECT round(amount_out, 2)::float AS imp, to_char(movement_date, 'YYYY-MM-DD') AS f FROM finance.bank_movements
          WHERE bank_account_id = ? AND deleted_at IS NULL AND movement_date BETWEEN '2026-11-12' AND '2026-11-30' AND concept ~* 'DOMICILIACION'
            AND round(amount_out, 2) = ANY(?::numeric[])`, [n12.ba.id, arr.map((x) => x.importe)])).rows;
      const tarde = cobros.filter((r) => r.f > '2026-11-14');
      ok(cobros.length === 4 && tarde.length >= 3,
        `TESTIGO: el banco cobró esos 4 cargos el ${cobros.map((r) => r.f.slice(8)).join(', ')} de noviembre — ${tarde.length} después del 14`);
      const neg = armarSuficiencia({ hoy: '2026-11-12', hasta: masDias('2026-11-12', 7), cuentas: [n12.ba], saldos: new Map([[n12.ba.id, { saldo: c.saldo, fecha: c.saldo_fecha, fuente: c.saldo_fuente }]]), series: [], pagos: [], sinCuenta: { pagos: 0, importe: 0 } }).cuentas[0];
      ok(neg.estado === 'alcanza' && neg.cargo_sin_cubrir === null && !neg.programa_excede, 'NEGATIVA: el mismo saldo sin cargos esperados ni programa → alcanza, sin aviso');
    }

    // El programa del día siguiente: lo que salió el 17.
    const j16 = await reconstruir(trx, '4166', '2026-07-16', { diasDePrograma: 1 });
    if (!j16 || j16.cuenta.saldo === null) noMedido('BanBajío 4166 al 16-jul: el libro no permite afirmar el cierre de ese día');
    else {
      const c = j16.cuenta;
      const del17 = c.pagos.filter((p) => p.fecha === '2026-07-17').reduce((t, p) => t + p.importe, 0);
      console.log(`    → 4166 al cierre del 16-jul: saldo ${$(c.saldo)} (${c.saldo_fuente}); salió el 17: ${$(del17)}; faltan ${$(c.faltan)}`);
      const pen = (await trx.raw(`SELECT count(*)::int AS n FROM finance.bank_movements WHERE bank_account_id = ? AND deleted_at IS NULL
          AND movement_date = '2026-07-17' AND concept ~* 'sobregiro' AND amount_out > 0`, [j16.ba.id])).rows[0].n;
      ok(c.estado === 'no_alcanza' && c.programa_excede && del17 > c.saldo && Math.abs(c.faltan - (del17 + c.cargos_total - c.saldo)) < 0.01 && pen > 0,
        `BanBajío 4166, 16-jul: lo que salió el 17 (${$(del17)}) pasaba el saldo (${$(c.saldo)}): el aviso habría dicho «faltan ${$(c.faltan)}»; TESTIGO: ese día el banco cobró ${pen} renglones de penalización por intento de sobregiro`);
    }

    console.log('\n C. Hoy: la lectura del endpoint (la vista de PGP.209 como subconsulta: todavía no está en prod)');
    const hoy = (await trx.raw(`SELECT to_char((now() AT TIME ZONE 'America/Mexico_City')::date, 'YYYY-MM-DD') AS d`)).rows[0].d;
    const t0 = Date.now();
    const entrada = await leerEntradaDeSuficiencia(trx, T, hoy, { vistaDeCargos: `(${MIG209.SELECT_SQL})` });
    const s = armarSuficiencia(entrada);
    const ms = Date.now() - t0;
    ok(ms < 5000, `costo: la lectura entera en ${(ms / 1000).toFixed(1)} s (techo 5 s)`);
    const vigentes = (await trx.raw(`SELECT count(*)::int AS n, coalesce(sum(expected_monthly_amount), 0)::float AS t FROM (${MIG209.SELECT_SQL}) v
        WHERE v.tenant_id = ? AND v.is_active AND v.next_expected_date <= ?`, [T, s.hasta])).rows[0];
    const enCuentas = s.cuentas.reduce((t, c) => t + c.cargos.length, 0);
    const detenidos = s.cuentas.reduce((t, c) => t + c.cargos_detenidos.length, 0);
    ok(s.cargos_medidos && enCuentas + detenidos === vigentes.n, `los cargos de la ventana son las series vigentes de PGP.209 hasta el ${s.hasta}: ${enCuentas} que cuentan + ${detenidos} detenidos (más de 31 días sin cobrarse) = ${enCuentas + detenidos} de ${vigentes.n} (${$(vigentes.t)})`);
    const limite = masDias(hoy, -DIAS_CARGO_DETENIDO);
    ok(s.cuentas.every((c) => c.cargos.every((x) => x.fecha >= limite) && c.cargos_detenidos.every((x) => x.fecha < limite)),
      `ningún cargo con más de ${DIAS_CARGO_DETENIDO} días de atraso (antes del ${limite}) se cuenta, y ningún detenido es más reciente`);
    ok(s.cuentas.every((c) => (c.saldo === null) === (c.estado === 'no_medido')), `toda cuenta sin saldo dice «no medido» y ninguna con saldo lo dice (${s.cuentas.filter((c) => c.estado === 'no_medido').length} sin saldo de ${s.cuentas.length})`);
    for (const c of s.cuentas.filter((x) => x.cargos.length || x.pagos.length || x.estado === 'no_alcanza')) {
      console.log(`    · ${c.bank} ${c.account_label.slice(-4)}: ${c.estado}; saldo ${c.saldo === null ? 'no medido' : `${$(c.saldo)} del ${c.saldo_fecha}${c.saldo_viejo ? ` (hace ${c.saldo_dias} días)` : ''}`}; ` +
        `programado ${$(c.programado)}; cargos ${$(c.cargos_total)}${c.cargo_sin_cubrir ? `; no cubre ${$(c.cargo_sin_cubrir.importe)} del ${c.cargo_sin_cubrir.fecha}: faltan ${$(c.cargo_sin_cubrir.faltan)}` : ''}`);
    }
    console.log(`    · sin cuenta de origen todavía: ${s.sin_cuenta.pagos} pagos, ${$(s.sin_cuenta.importe)}`);
    const sinVista = (await trx.raw(`SELECT to_regclass(?) IS NOT NULL AS t`, [VISTA_DE_CARGOS])).rows[0].t;
    if (!sinVista) {
      const real = armarSuficiencia(await leerEntradaDeSuficiencia(trx, T, hoy));
      ok(real.cargos_medidos === false && real.cuentas.every((c) => c.cargos.length === 0),
        'sin la vista de PGP.209 (su migración sin aplicar) el endpoint lo DICE: cargos_medidos = false, no «cero cargos»');
    } else {
      noMedido('la vista de PGP.209 ya existe en esta base: el camino «sin la vista» no se puede ejercer aquí (lo cubre la prueba unitaria)');
    }
  });
  return salir();
})().catch(async (e) => { console.error('ERROR:', e.message); fail++; return salir(); });
