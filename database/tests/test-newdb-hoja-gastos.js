/* eslint-disable no-console */
/**
 * `[CGA-A.65]` — La hoja de gastos de zona (migración `20261029143450`) contra una base REAL: cuatro
 * ojos, transiciones, renglones inmutables, un pago en una sola hoja vigente, el total igual a la
 * suma de sus renglones, el folio «HG-n», el aislamiento por empresa, y el pago: sin aprobación no
 * se paga, quien aprobó no paga, un retiro paga una sola hoja y el cajón pone menos de $500. Cada
 * regla con su negativa.
 *
 * Si la migración no está aplicada, la aplica DENTRO de la transacción (la misma función `up`, no
 * una copia) y al final se deshace todo: cero efecto en la base.
 * Uso: DATABASE_URL_NEW=… node database/tests/test-newdb-hoja-gastos.js
 */
const crypto = require('crypto');
const knex = require('knex')(require('../knexfile-newdb.js').development);
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-hoja-gastos');
const migracion = require('../migrations-newdb/20261029143450_cga_a65_hoja_gastos_zona.js');
// El cuadre leía NEW.sheet_id también cuando dispara expense_sheets: cerrar daba 500 en prod (2026-10-30).
const arregloCuadre = require('../migrations-newdb/20261030133058_cga_a65_hoja_cerrar_y_pagar.js');
const conConteo = require('../migrations-newdb/20261030140503_cga_a65_hoja_cajon_con_conteo.js');

const uuid = () => crypto.randomUUID();
const TT = uuid();
const OTRO = uuid();
const [ZONA_1, ZONA_2, FIN] = [uuid(), uuid(), uuid()];

let pass = 0, fail = 0, nomedido = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const skip = (m) => { nomedido++; console.log('  ⃝ NO MEDIDO —', m); };
async function intento(trx, fn) {
  await trx.raw('SAVEPOINT sp');
  let err = null;
  try { await fn(); } catch (e) { err = { code: e.code, constraint: e.constraint, message: String(e.message) }; }
  await trx.raw('ROLLBACK TO SAVEPOINT sp');
  return err;
}
const muestra = (err) => (err ? `${err.code} ${err.constraint || ''} ${err.message.slice(0, 90)}` : 'sin error');
const conMensaje = (err, texto) => !!err && err.code === '23514' && err.message.includes(texto);

const renglon = (sheetId, folio, importe, extra = {}) => ({
  tenant_id: TT, sheet_id: sheetId, origen_ref: `08|X-D-26|${folio}|0011`, sucursal: '08', doc_tipo: 'X-D-26', folio,
  fecha_pago: '2026-10-23', clase: 'proveedor', importe, ...extra,
});

/**
 * El cuadre es un trigger DIFERIDO (se revisa al confirmar): aquí se dispara a mano y se vuelve a
 * diferir, para que la siguiente hoja pueda escribir su cabecera antes que sus renglones.
 */
async function verificaCuadre(trx) {
  await trx.raw('SET CONSTRAINTS ALL IMMEDIATE');
  await trx.raw('SET CONSTRAINTS ALL DEFERRED');
}

let hayRol = true;
async function comoApp(trx, tenant = TT) {
  if (hayRol) await trx.raw('SET LOCAL ROLE app_runtime');
  await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [tenant]);
}

/** Una hoja con sus renglones, en la misma transacción; devuelve el id. */
async function hoja(trx, numero, renglones, extra = {}) {
  const total = Math.round(renglones.reduce((a, r) => a + r[1], 0) * 100) / 100;
  const [s] = await trx('finance.expense_sheets').insert({
    tenant_id: TT, numero, zona: 'morelia', venta_del_dia: '2026-10-23', total, renglones: renglones.length,
    client_key: `prueba-${numero}-${uuid()}`, cerrada_por: ZONA_1, ...extra,
  }).returning(['id', 'folio']);
  await trx('finance.expense_sheet_lines').insert(renglones.map(([f, i]) => renglon(s.id, f, i)));
  return s;
}

(async () => {
  console.log('\n🧪 [CGA-A.65] La hoja de gastos de zona — contra base real\n');
  hayRol = (await knex.raw(`SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime'`)).rows.length > 0;
  if (!hayRol) skip('no existe app_runtime: los privilegios y la RLS no se prueban como la app');
  const tieneTenant = (await knex.raw(`SELECT to_regprocedure('public.current_tenant_id()') AS fn`)).rows[0].fn;
  if (!tieneTenant) {
    skip('la base no tiene current_tenant_id(): falta la migración de origen');
    console.log(`\n${pass} ✓ / ${fail} ✗ / ${nomedido} NO MEDIDO`);
    await knex.destroy();
    process.exit(0);
  }

  try {
    await knex.transaction(async (trx) => {
      const aplicada = (await trx.raw(`SELECT to_regclass('finance.expense_sheets') AS t`)).rows[0].t;
      if (!aplicada) {
        if (!hayRol) {
          skip('la migración no está aplicada y sin app_runtime no se puede aplicar (sus GRANT lo nombran)');
          throw new Error('__rollback__');
        }
        await migracion.up(trx);
        console.log('  (la migración se aplicó dentro de la transacción y se deshace al final)');
      }
      await arregloCuadre.up(trx);
      await conConteo.up(trx);
      await comoApp(trx);

      console.log('── 1. Una hoja cerrada, con su folio, y su total es la suma de sus renglones ──');
      const h1 = await hoja(trx, 1, [['0000533', 13035], ['0000534', 7330]]);
      await verificaCuadre(trx);
      ok(true, 'una hoja que cuadra pasa el cuadre al confirmar');
      ok(h1.folio === 'HG-1', `el folio es el que se escribe en la referencia del retiro: ${h1.folio}`);

      console.log('\n── 2. Lo que la base no deja ──');
      const errTotal = await intento(trx, async () => {
        const [s] = await trx('finance.expense_sheets').insert({ tenant_id: TT, numero: 90, zona: 'morelia', venta_del_dia: '2026-10-23',
          total: 100, renglones: 1, client_key: `prueba-${uuid()}`, cerrada_por: ZONA_1 }).returning('id');
        await trx('finance.expense_sheet_lines').insert(renglon(s.id, '0000900', 99));
        await trx.raw('SET CONSTRAINTS ALL IMMEDIATE');
      });
      await trx.raw('SET CONSTRAINTS ALL DEFERRED');
      ok(conMensaje(errTotal, 'expense_sheet_descuadre'), `una hoja que dice $100 con renglones de $99 no se confirma (${muestra(errTotal)})`);

      const errCuatro = await intento(trx, () => trx('finance.expense_sheets').where({ id: h1.id })
        .update({ estado: 'aprobada', aprobada_por: ZONA_1, aprobada_at: trx.fn.now() }));
      ok(!!errCuatro && errCuatro.constraint === 'expense_sheet_cuatro_ojos', `quien la cerró no la aprueba (${muestra(errCuatro)})`);

      const errMotivo = await intento(trx, () => trx('finance.expense_sheets').where({ id: h1.id })
        .update({ estado: 'rechazada', rechazada_por: FIN, rechazada_at: trx.fn.now(), motivo: 'no' }));
      ok(!!errMotivo && errMotivo.constraint === 'expense_sheet_motivo', `rechazar sin motivo (10 letras) no se puede (${muestra(errMotivo)})`);

      const errEdita = await intento(trx, () => trx('finance.expense_sheets').where({ id: h1.id }).update({ total: 1 }));
      ok(conMensaje(errEdita, 'expense_sheet_inmutable'), `una hoja no se edita: se rechaza o se cancela (${muestra(errEdita)})`);

      const errRenglon = await intento(trx, () => trx('finance.expense_sheet_lines').where({ sheet_id: h1.id, folio: '0000533' }).update({ importe: 1 }));
      ok(conMensaje(errRenglon, 'expense_sheet_line_inmutable'), `un renglón no se edita (${muestra(errRenglon)})`);

      const errBorra = await intento(trx, () => trx('finance.expense_sheet_lines').where({ sheet_id: h1.id }).del());
      ok(!!errBorra, `un renglón no se borra (${muestra(errBorra)})`);

      const errVigencia = await intento(trx, () => trx('finance.expense_sheet_lines').where({ sheet_id: h1.id, folio: '0000533' }).update({ vigente: false }));
      ok(conMensaje(errVigencia, 'expense_sheet_line_vigencia'), `con la hoja cerrada, su renglón sigue vigente (${muestra(errVigencia)})`);

      const errDoble = await intento(trx, () => hoja(trx, 2, [['0000533', 13035]]));
      ok(!!errDoble && errDoble.code === '23505' && errDoble.constraint === 'ux_expense_sheet_line_vigente',
        `un pago no va en dos hojas vigentes (${muestra(errDoble)})`);

      const errNumero = await intento(trx, () => hoja(trx, 1, [['0000777', 10]]));
      ok(!!errNumero && errNumero.code === '23505' && errNumero.constraint === 'ux_expense_sheet_numero', `el número no se repite (${muestra(errNumero)})`);

      console.log('\n── 3. Finanzas aprueba (otra persona) y lo resuelto ya no se toca ──');
      await trx('finance.expense_sheets').where({ id: h1.id }).update({ estado: 'aprobada', aprobada_por: FIN, aprobada_at: trx.fn.now() });
      ok((await trx('finance.expense_sheets').where({ id: h1.id }).first()).estado === 'aprobada', 'otra persona la aprueba');
      const errReabre = await intento(trx, () => trx('finance.expense_sheets').where({ id: h1.id })
        .update({ estado: 'rechazada', rechazada_por: FIN, rechazada_at: trx.fn.now(), motivo: 'ya no se puede rechazar' }));
      ok(conMensaje(errReabre, 'expense_sheet_resuelta'), `aprobada no se rechaza después (${muestra(errReabre)})`);
      const errFirma = await intento(trx, () => trx('finance.expense_sheets').where({ id: h1.id }).update({ aprobada_por: ZONA_2 }));
      ok(conMensaje(errFirma, 'expense_sheet_resuelta'), `ni se cambia quién la aprobó (${muestra(errFirma)})`);

      console.log('\n── 3b. Sin aprobación no se paga; la paga otra persona, con UN retiro que la cuadra ──');
      // h1 suma $20,365 (13,035 + 7,330) y la aprobó finanzas.
      const PAGA = uuid();
      const pago = (extra = {}) => ({ estado: 'pagada', medio: 'caos', pagada_por: PAGA, pagada_at: trx.fn.now(),
        caos_device: 'AST700', caos_external_id: 1707, caos_total: 20300, cajon: 65, ...extra });
      const h6 = await hoja(trx, 6, [['0000610', 900]]);
      await verificaCuadre(trx);
      const errSinAprobar = await intento(trx, () => trx('finance.expense_sheets').where({ id: h6.id })
        .update({ ...pago({ caos_external_id: 9001, caos_total: 900, cajon: 0 }), aprobada_por: FIN, aprobada_at: trx.fn.now() }));
      ok(conMensaje(errSinAprobar, 'expense_sheet_sin_aprobar'), `una hoja cerrada no se paga, ni aprobándola en el mismo paso (${muestra(errSinAprobar)})`);
      const errMismo = await intento(trx, () => trx('finance.expense_sheets').where({ id: h1.id }).update(pago({ pagada_por: FIN })));
      ok(!!errMismo && errMismo.constraint === 'expense_sheet_paga_otro', `quien la aprobó no la paga (${muestra(errMismo)})`);
      const errCajon = await intento(trx, () => trx('finance.expense_sheets').where({ id: h1.id }).update(pago({ caos_total: 19865, cajon: 500 })));
      ok(!!errCajon && errCajon.constraint === 'expense_sheet_medio', `el cajón pone menos de $500 (${muestra(errCajon)})`);
      const errNoSuma = await intento(trx, () => trx('finance.expense_sheets').where({ id: h1.id }).update(pago({ caos_total: 20300, cajon: 60 })));
      ok(!!errNoSuma && errNoSuma.constraint === 'expense_sheet_medio', `el retiro más el cajón son la hoja (${muestra(errNoSuma)})`);
      const errEditaAlPagar = await intento(trx, () => trx('finance.expense_sheets').where({ id: h1.id }).update({ ...pago(), venta_del_dia: '2026-10-24' }));
      ok(conMensaje(errEditaAlPagar, 'expense_sheet_inmutable'), `al pagar no se edita lo aprobado (${muestra(errEditaAlPagar)})`);
      await trx('finance.expense_sheets').where({ id: h1.id }).update(pago());
      ok((await trx('finance.expense_sheets').where({ id: h1.id }).first()).estado === 'pagada', 'otra persona la paga con un retiro que la cuadra (el cajón pone $65)');
      const errRepaga = await intento(trx, () => trx('finance.expense_sheets').where({ id: h1.id }).update({ cajon: 64, caos_total: 20301 }));
      ok(conMensaje(errRepaga, 'expense_sheet_resuelta'), `pagada ya no se toca (${muestra(errRepaga)})`);
      await trx('finance.expense_sheets').where({ id: h6.id }).update({ estado: 'aprobada', aprobada_por: FIN, aprobada_at: trx.fn.now() });
      const errRetiro = await intento(trx, () => trx('finance.expense_sheets').where({ id: h6.id }).update(pago({ caos_total: 900, cajon: 0 })));
      ok(!!errRetiro && errRetiro.code === '23505' && errRetiro.constraint === 'ux_expense_sheet_retiro', `un retiro paga una sola hoja (${muestra(errRetiro)})`);
      // Edgar, 2026-10-30: «cuando sea de cajón que se haga un arqueo».
      const conCajon = (extra) => ({ estado: 'pagada', medio: 'cajon', pagada_por: PAGA, pagada_at: trx.fn.now(), cajon: 900, ...extra });
      const errSinConteo = await intento(trx, () => trx('finance.expense_sheets').where({ id: h6.id }).update(conCajon({})));
      ok(conMensaje(errSinConteo, 'expense_sheet_conteo'), `del cajón sin conteo no se paga (${muestra(errSinConteo)})`);
      const errNoCuenta = await intento(trx, () => trx('finance.expense_sheets').where({ id: h6.id }).update(conCajon({ conteo: { '500': 1, '200': 1, '100': 1, '50': 1 }, conteo_morralla: 0 })));
      ok(conMensaje(errNoCuenta, 'expense_sheet_conteo'), `un conteo que suma $850 no paga $900 (${muestra(errNoCuenta)})`);
      const errPieza = await intento(trx, () => trx('finance.expense_sheets').where({ id: h6.id }).update(conCajon({ conteo: { '450': 2 }, conteo_morralla: 0 })));
      ok(conMensaje(errPieza, 'expense_sheet_conteo'), `una pieza de $450 no es un conteo (${muestra(errPieza)})`);
      const errMorralla = await intento(trx, () => trx('finance.expense_sheets').where({ id: h6.id }).update(conCajon({ conteo: { '500': 1, '200': 1, '100': 1, '50': 1, '20': 2, '5': 1, '2': 2, '0.5': 1 }, conteo_morralla: 0.5 })));
      ok(!!errMorralla && errMorralla.constraint === 'expense_sheet_conteo_morralla', `la morralla es de menos de 50¢, aunque el conteo sume (${muestra(errMorralla)})`);
      await trx('finance.expense_sheets').where({ id: h6.id }).update(conCajon({ conteo: { '500': 1, '200': 2 }, conteo_morralla: 0 }));
      ok((await trx('finance.expense_sheets').where({ id: h6.id }).first()).medio === 'cajon', 'por excepción, con el cajón entero (sin retiro) y contado: 1 × $500 + 2 × $200');

      console.log('\n── 3c. Pagada con el cajón ANTES de exigir el conteo (HG-1): lo recibe una vez ──');
      // Edgar, 2026-10-30: HG-1 tiene su arqueo en papel en Control, «hay que traer ese arqueo».
      const h7 = await hoja(trx, 7, [['0000611', 900]]);
      await verificaCuadre(trx);
      await trx('finance.expense_sheets').where({ id: h7.id }).update({ estado: 'aprobada', aprobada_por: FIN, aprobada_at: trx.fn.now() });
      // Como se pagó en prod: con la transición de antes del conteo, y la regla nueva llega después.
      await trx.raw('RESET ROLE');
      await arregloCuadre.up(trx);
      await comoApp(trx);
      await trx('finance.expense_sheets').where({ id: h7.id }).update(conCajon({}));
      await trx.raw('RESET ROLE');
      await conConteo.up(trx);
      await comoApp(trx);
      const tarde = (extra) => ({ conteo: { '500': 1, '200': 2 }, conteo_morralla: 0, conteo_por: PAGA, conteo_at: trx.fn.now(), ...extra });
      const errTardeNoSuma = await intento(trx, () => trx('finance.expense_sheets').where({ id: h7.id }).update(tarde({ conteo: { '500': 1 } })));
      ok(conMensaje(errTardeNoSuma, 'expense_sheet_conteo'), `el conteo traído después también suma lo que salió (${muestra(errTardeNoSuma)})`);
      const errTardeEdita = await intento(trx, () => trx('finance.expense_sheets').where({ id: h7.id }).update(tarde({ conteo: { '500': 1, '200': 2 }, cajon: 899 })));
      ok(conMensaje(errTardeEdita, 'expense_sheet_resuelta'), `con el conteo no se cambia lo pagado (${muestra(errTardeEdita)})`);
      const errTardeCaos = await intento(trx, () => trx('finance.expense_sheets').where({ id: h1.id }).update(tarde({ conteo: { '50': 1, '10': 1, '5': 1 } })));
      ok(conMensaje(errTardeCaos, 'expense_sheet_resuelta'), `una hoja pagada con retiro no recibe conteo (${muestra(errTardeCaos)})`);
      await trx('finance.expense_sheets').where({ id: h7.id }).update(tarde({}));
      const h7b = await trx('finance.expense_sheets').where({ id: h7.id }).first();
      ok(h7b.conteo && h7b.conteo['200'] === 2 && h7b.estado === 'pagada', 'la pagada sin conteo recibe el suyo: 1 × $500 + 2 × $200');
      const errOtroConteo = await intento(trx, () => trx('finance.expense_sheets').where({ id: h7.id }).update(tarde({ conteo: { '500': 1, '100': 4 } })));
      ok(conMensaje(errOtroConteo, 'expense_sheet_resuelta'), `y con su conteo puesto ya no se cambia (${muestra(errOtroConteo)})`);

      console.log('\n── 4. Rechazada: sus pagos vuelven a la hoja abierta y pueden ir en otra ──');
      const h3 = await hoja(trx, 3, [['0000600', 500]]);
      await trx('finance.expense_sheets').where({ id: h3.id })
        .update({ estado: 'rechazada', rechazada_por: FIN, rechazada_at: trx.fn.now(), motivo: 'falta el vale del proveedor' });
      await trx('finance.expense_sheet_lines').where({ sheet_id: h3.id }).update({ vigente: false });
      const errOtra = await intento(trx, async () => { await hoja(trx, 4, [['0000600', 500]]); await verificaCuadre(trx); });
      await trx.raw('SET CONSTRAINTS ALL DEFERRED');
      ok(!errOtra, `el pago de una hoja rechazada entra en otra (${muestra(errOtra)})`);
      const errRevive = await intento(trx, () => trx('finance.expense_sheet_lines').where({ sheet_id: h3.id }).update({ vigente: true }));
      ok(conMensaje(errRevive, 'expense_sheet_line_vigencia'), `y el renglón de la rechazada no vuelve a ser vigente (${muestra(errRevive)})`);

      console.log('\n── 5. Quien la cerró la puede cancelar; otra empresa no la ve ──');
      const h5 = await hoja(trx, 5, [['0000601', 250]]);
      await trx('finance.expense_sheets').where({ id: h5.id })
        .update({ estado: 'cancelada', cancelada_por: ZONA_1, cancelada_at: trx.fn.now(), motivo: 'la cerré con un pago de más' });
      ok((await trx('finance.expense_sheets').where({ id: h5.id }).first()).estado === 'cancelada', 'cancelada por quien la cerró, con motivo');
      if (hayRol) {
        await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [OTRO]);
        const ven = await trx('finance.expense_sheets').count({ n: '*' }).first();
        ok(Number(ven.n) === 0, `otra empresa no ve ninguna hoja (ve ${ven.n})`);
        await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TT]);
      } else {
        skip('aislamiento por empresa: sin app_runtime, la RLS forzada no aplica al dueño');
      }

      throw new Error('__rollback__');
    });
  } catch (e) {
    if (e.message !== '__rollback__') { fail++; console.log('  ✗ error inesperado:', e.message); }
  }

  console.log(`\n${pass} ✓ / ${fail} ✗ / ${nomedido} NO MEDIDO`);
  await knex.destroy();
  process.exit(fail ? 1 : 0);
})();
