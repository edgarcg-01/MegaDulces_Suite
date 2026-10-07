/**
 * CB.44 — El conciliador de tesorería tiene que poder cruzar el borde de mes.
 *
 * Nace de un caso REAL medido (sucursal 01, cliente C1011):
 *   · factura `U-D-8` 0000319 del 21-jul-2026 por $1,653.00,
 *   · pagada el **24-jul-2026**,
 *   · capturada como cobro `U-A-7` 0000213 el **12-AGO** a las 16:52 — junto con otros
 *     cinco cobros del mismo cliente, teclados entre las 16:50 y las 16:54 ($20,565.85).
 *
 * El banco lo tiene en JULIO y Kepler en AGOSTO. `runMatchTreasury` cortaba los DOS lados
 * al mes calendario, así que los pases que anunciaban «±10d» y «sin tope de fecha» no
 * podían salir del periodo: el depósito no tenía candidato POSIBLE. Efecto: el mismo
 * dinero se reportaba como faltante de los dos lados.
 *
 * Carga el `.ts` REAL del servicio vía ts-node (no una reimplementación): si el motor
 * cambia de criterio, este test se entera. El lado Kepler sale del ODS local de verdad
 * (`analytics.kepler_bank_movements` es una VISTA sobre `kepler_ods.kdm1`); lo único
 * sintético es el lado banco, que es justamente lo que no tenemos en local.
 *
 * Todo corre dentro de UNA transacción con ROLLBACK: no deja rastro.
 */

const path = require('path');
const Module = require('module');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { console.log(`  ✓ ${m}`); pass++; } else { console.error(`  ✗ ${m}`); fail++; } };
const nm = (v) => Number(v || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });

const MEGA = '00000000-0000-0000-0000-00000000d01c';
const PERIODO_BANCO = '2026-07';        // el depósito
const FECHA_DEPOSITO = '2026-07-24';    // lo que nos dijo el usuario
const CLAVE = '6721';                   // BBVA 6721
const LOTE_FECHA = '2026-08-12';        // la captura en Kepler
const LOTE_BENEF = 'DIEGO MAESTRO CAMARILLO';

// Las dos libs del monorepo se resuelven a stubs: el servicio sólo necesita que existan
// los símbolos, no su comportamiento (inyectamos knex real por el fake TenantKnexService).
const STUBS = {
  '@megadulces/platform-core': { TenantKnexService: class {}, TenantContextService: class {} },
  '@megadulces/contracts': { FINANCE_FINDINGS_SINK_PORT: Symbol('findings-sink') },
};
const stubPaths = {};
for (const k of Object.keys(STUBS)) {
  const f = path.resolve(__dirname, `.stub-${k.replace(/[@/]/g, '_')}.js`);
  require('fs').writeFileSync(f, `module.exports = require(${JSON.stringify(__filename)}).__stubs[${JSON.stringify(k)}];`);
  stubPaths[k] = f;
}
module.exports.__stubs = STUBS;
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (stubPaths[req]) return stubPaths[req];
  return origResolve.call(this, req, ...rest);
};

// `skipProject`: sin esto ts-node toma el tsconfig del monorepo y falla con TS5011.
require('ts-node').register({
  transpileOnly: true, skipProject: true,
  compilerOptions: {
    module: 'commonjs', target: 'es2020', esModuleInterop: true, moduleResolution: 'node',
    experimentalDecorators: true, emitDecoratorMetadata: true, ignoreDeprecations: '6.0',
  },
});
const { FinanceBankService } = require(path.resolve(__dirname, '../../libs/finance/src/lib/bank/finance-bank.service.ts'));

const limpiar = () => { for (const f of Object.values(stubPaths)) { try { require('fs').unlinkSync(f); } catch { /* ya no está */ } } };

(async () => {
  const knex = require('knex')({
    client: 'pg',
    connection: process.env.DATABASE_URL_NEW,
    pool: { min: 0, max: 2 },
  });

  try {
    await knex.transaction(async (trx) => {
      await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [MEGA]);

      // ── 0. El lado Kepler tiene que existir de verdad, o el test no prueba nada ──
      const lote = await trx('kepler_ods.kdm1')
        .whereRaw(`btrim(c2::text)='U' AND btrim(c3::text)='A' AND btrim(c4::text)='7'`)
        .andWhereRaw(`c9::date = ?`, [LOTE_FECHA])
        .andWhereRaw(`btrim(c45::text) = ?`, [CLAVE])
        .andWhereRaw(`btrim(c32::text) = ?`, [LOTE_BENEF])
        .andWhereRaw(`btrim(coalesce(c43::text,'')) <> 'C'`)
        .select(trx.raw(`btrim(c6::text) folio`), trx.raw(`round(c16::numeric,2) imp`))
        .orderBy('folio');

      if (lote.length === 0) {
        console.log('  ⚠ NO MEDIDO: el ODS local no tiene el lote de referencia — el test no puede concluir.');
        console.log('    (no se cuenta como ✓ ni como ✗: no hay con qué comprobarse)');
        throw new Error('__skip__');
      }

      const totalLote = Math.round(lote.reduce((s, r) => s + Number(r.imp), 0) * 100) / 100;
      ok(lote.length === 6, `el lote de referencia trae 6 cobros (trae ${lote.length})`);
      ok(Math.abs(totalLote - 20565.85) < 0.01, `el lote suma ${nm(totalLote)} (esperado ${nm(20565.85)})`);
      ok(lote.some((r) => Math.abs(Number(r.imp) - 1653.00) < 0.01), 'el cobro de $1,653.00 (folio 0000213) está en el lote');

      // ── 1. Lado banco sintético: la cuenta + el estado de cuenta de JULIO + el depósito ──
      const [cuenta] = await trx('finance.bank_accounts')
        .insert({ tenant_id: MEGA, bank: 'BBVA', account_label: CLAVE, alias: 'BBVA6721', kind: 'bank', active: true })
        .returning(['id']);
      const [stmt] = await trx('finance.bank_statements')
        .insert({ tenant_id: MEGA, bank_account_id: cuenta.id, period: PERIODO_BANCO, status: 'reconciling',
          opening_balance: 0, closing_balance: totalLote, total_in: totalLote, total_out: 0, source_file: 'test-cb44' })
        .returning(['id']);
      const [dep] = await trx('finance.bank_movements')
        .insert({ tenant_id: MEGA, statement_id: stmt.id, bank_account_id: cuenta.id,
          movement_date: FECHA_DEPOSITO, raw_type: 'I', concept: `DEPOSITO ${LOTE_BENEF}`,
          amount_in: totalLote, amount_out: 0, recon_status: 'pending',
          client_uuid: 'test-cb44-deposito', source_file: 'test-cb44' })
        .returning(['id']);

      // La vista resuelve clave→account_label leyendo finance.bank_accounts: sin la cuenta
      // de arriba devuelve NULL y el matcher descarta todo. Se comprueba, no se asume.
      const vistoLote = await trx('analytics.kepler_bank_movements')
        .where({ tenant_id: MEGA, account_label: CLAVE }).andWhere('doc_tipo', 'U-A-7')
        .andWhere('fecha_valor', LOTE_FECHA).andWhere('beneficiario', LOTE_BENEF)
        .count({ n: '*' }).first();
      ok(Number(vistoLote.n) === 6, `la vista de tesorería expone los 6 cobros del lote con account_label=${CLAVE} (ve ${vistoLote.n})`);

      // ── 2. El motor REAL, con knex real inyectado ──
      const svc = new FinanceBankService(
        { run: (cb) => cb(trx) },                       // TenantKnexService
        { requireTenantId: () => MEGA },                // TenantContextService
      );

      const r = await svc.runMatchTreasury(PERIODO_BANCO);

      ok(r.engine === 'tesoreria', 'corrió el motor de tesorería');
      ok(r.bank_movements === 1, `vio 1 movimiento de banco en ${PERIODO_BANCO} (vio ${r.bank_movements})`);
      ok(r.matched === 1, `CASÓ el depósito cruzando el borde de mes (matched=${r.matched})`);
      ok(r.batch_pass === 1, `lo resolvió el pase de LOTE, no por casualidad (batch_pass=${r.batch_pass})`);

      // REGRESIÓN: los pases 1-4 siguen viendo el mes. Se agregó tras un bug real de esta
      // misma entrega: `pg` devuelve `date` como Date y `String(d).slice(0,10)` da
      // "Tue Sep 01", así que el filtro de "dentro del periodo" daba SIEMPRE falso y el
      // pool del mes quedaba vacío. El caso cruzado seguía en verde y lo tapaba.
      ok(r.kepler_postings > 0, `el pool DEL MES no quedó vacío: los pases 1-4 siguen vivos (kepler_postings=${r.kepler_postings})`);

      // ── 3. Casó contra los 6 folios correctos, no contra cualquier cosa que sume igual ──
      const casados = await trx('finance.bank_recon_matches')
        .where({ tenant_id: MEGA, bank_movement_id: dep.id })
        .select('kepler_doc_tipo', 'kepler_doc_folio', 'kepler_amount', 'matched_by')
        .orderBy('kepler_doc_folio');
      ok(casados.length === 6, `escribió 6 renglones de cruce (escribió ${casados.length})`);
      ok(casados.every((m) => m.kepler_doc_tipo === 'U-A-7'), 'los 6 son U-A-7 (Cobro CFDI)');
      const foliosEsperados = lote.map((r) => r.folio).sort().join(',');
      const foliosCasados = casados.map((m) => String(m.kepler_doc_folio).trim()).sort().join(',');
      ok(foliosCasados === foliosEsperados, `casó exactamente los folios del lote (${foliosCasados})`);
      const sumaCasada = Math.round(casados.reduce((s, m) => s + Number(m.kepler_amount), 0) * 100) / 100;
      ok(Math.abs(sumaCasada - totalLote) < 0.01, `la suma casada cuadra al peso con el depósito (${nm(sumaCasada)})`);
      ok(casados.every((m) => m.matched_by === 'motor-tes-lote'), 'quedó trazado con matched_by=motor-tes-lote');

      const estado = await trx('finance.bank_movements').where({ id: dep.id }).first('recon_status');
      ok(estado.recon_status === 'matched', 'el movimiento del banco quedó marcado como conciliado');

      // ── 4. PRUEBA NEGATIVA: un depósito que NO corresponde a ningún lote no debe casar ──
      const [depFalso] = await trx('finance.bank_movements')
        .insert({ tenant_id: MEGA, statement_id: stmt.id, bank_account_id: cuenta.id,
          movement_date: FECHA_DEPOSITO, raw_type: 'I', concept: 'DEPOSITO QUE NO EXISTE EN KEPLER',
          amount_in: 777777.77, amount_out: 0, recon_status: 'pending',
          client_uuid: 'test-cb44-falso', source_file: 'test-cb44' })
        .returning(['id']);
      const r2 = await svc.runMatchTreasury(PERIODO_BANCO);
      ok(r2.bank_movements === 2, 'la 2ª corrida ve los 2 movimientos del banco');
      ok(r2.matched === 1, `sigue casando SÓLO el bueno: el importe inventado no casa (matched=${r2.matched})`);
      const casadosFalso = await trx('finance.bank_recon_matches').where({ bank_movement_id: depFalso.id }).count({ n: '*' }).first();
      ok(Number(casadosFalso.n) === 0, 'el depósito inventado no generó ningún cruce');

      // ── 5. PRUEBA NEGATIVA: fuera de la ventana de ±45d tampoco debe casar ──
      const [stmtLejos] = await trx('finance.bank_statements')
        .insert({ tenant_id: MEGA, bank_account_id: cuenta.id, period: '2026-01', status: 'reconciling',
          opening_balance: 0, closing_balance: totalLote, total_in: totalLote, total_out: 0, source_file: 'test-cb44' })
        .returning(['id']);
      await trx('finance.bank_movements')
        .insert({ tenant_id: MEGA, statement_id: stmtLejos.id, bank_account_id: cuenta.id,
          movement_date: '2026-01-15', raw_type: 'I', concept: `DEPOSITO ${LOTE_BENEF}`,
          amount_in: totalLote, amount_out: 0, recon_status: 'pending',
          client_uuid: 'test-cb44-lejos', source_file: 'test-cb44' });
      const r3 = await svc.runMatchTreasury('2026-01');
      ok(r3.matched === 0, `un depósito a 7 meses del lote NO casa: la ventana es ±45d, no infinita (matched=${r3.matched})`);

      // ── 6. La declaración de ADR-056: dónde la fecha no es fecha de banco ──
      ok(Array.isArray(r.fecha_no_confiable), 'el resultado declara `fecha_no_confiable`');
      const decl = (r.fecha_no_confiable || []).find((f) => f.account_label === CLAVE && f.doc_tipo === 'U-A-7');
      ok(!!decl, `declara ${CLAVE} × U-A-7: ahí fecha_valor == fecha_captura (no se retrofecha)`);
      if (decl) ok(decl.pct_sin_retrofecha >= 90, `y lo cuantifica: ${decl.pct_sin_retrofecha}% sin retrofecha sobre ${decl.docs} docs (${nm(decl.monto)})`);
      // NEGATIVA: el grano importa. Los cobros U-A-5 de la MISMA cuenta sí se retrofechan,
      // así que no deben salir declarados — si salieran, la declaración sería ruido.
      const sano = (r.fecha_no_confiable || []).find((f) => f.account_label === CLAVE && f.doc_tipo === 'U-A-5');
      ok(!sano, 'NO declara U-A-5 de la misma cuenta: ese proceso sí retrofecha');

      throw new Error('__rollback__');
    });
  } catch (e) {
    if (e.message === '__skip__') { /* ya reportado arriba */ }
    else if (e.message !== '__rollback__') { console.error('  ✗ excepción:', e.message); fail++; }
  } finally {
    await knex.destroy();
    limpiar();
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} CB.44 conciliación cruzando el borde de mes — ${pass} ✓ / ${fail} ✗`);
  process.exit(fail === 0 ? 0 : 1);
})();
