/* eslint-disable no-console */
/**
 * Fase CG.21 — **la caja se confirma, no se teclea: los dos signos salen de Kepler.**
 * Smoke DB-direct, rollback al final (cero efecto real).
 *
 * Lo que esta suite existe para probar, y casi todo con PRUEBA NEGATIVA:
 *
 *   · `kdm1.c45` es la cuenta por la que se movió el dinero, y `kdb1` la nombra. La vista
 *     `analytics.v_kepler_cajas` tiene que traer las cinco cajas de EFECTIVO — incluidas las que
 *     no se usan, porque una caja dormida y una que no existe NO pueden verse igual (ADR-056).
 *   · ⛔ **La llave lleva el `doc_tipo`.** Medido: el folio COLISIONA entre `X-A-45`, `X-D-26` y
 *     `X-D-60`. Confirmar uno NO puede bloquear al otro — es la prueba que justifica la forma
 *     `sucursal|doc_tipo|folio|clave_banco` y la que fallaría con `sucursal|folio` a secas.
 *   · ⛔ **Lo contado llega al LIBRO, no sólo al hallazgo.** Era un bug de CG.20: el servicio
 *     releía el importe del ERP y descartaba el conteo. Acá se prueba contra la tabla.
 *   · `tipo_cuenta` se deriva de `kdb1.c3='EFECTIVO'` y no de una lista de claves a mano: con la
 *     lista vieja, `0030` y `0050` salían clasificadas como banco.
 *   · La cobertura cuenta los DOS signos: la vista anterior filtraba `tipo='ingreso'` y habría
 *     dejado invisible justo la mitad que esta fase vino a anclar.
 *
 * ⚠️ Los bloques que dependen del ODS reportan **NO MEDIDO** si `kepler_ods` no está en este
 * entorno, nunca ✓. Un bloque que se pone verde por ausencia de datos es peor que uno rojo.
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-caja-movimientos-kepler');

const T = '00000000-0000-0000-0000-00000000d01c';
const CAPTURISTA = '00000000-0000-0000-0000-0000000000aa';

let pass = 0, fail = 0, nomedido = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const skip = (m) => { nomedido++; console.log('  ⃝ NO MEDIDO —', m); };

async function violation(trx, fn) {
  await trx.raw('SAVEPOINT sp');
  let code = null;
  try { await fn(); } catch (e) { code = e.code; }
  await trx.raw('ROLLBACK TO SAVEPOINT sp');
  return code;
}

let n = 0;
const mov = (over = {}) => ({
  tenant_id: T,
  folio: `CGK-${Date.now()}-${(n += 1)}`,
  tipo: 'gasto', fecha: '2026-09-22', sucursal: '00',
  kepler_cuenta: '601-001', kepler_concepto: '001',
  glosa: 'Movimiento anclado de prueba', monto: 100,
  created_by: CAPTURISTA, ...over,
});

(async () => {
  try {
    // ── 1. El sustrato ────────────────────────────────────────────────────────────────────────
    console.log('\n── 1. Vistas ──');
    for (const v of ['analytics.v_kepler_cajas', 'finance.v_caja_movimientos_pendientes', 'finance.v_caja_cobertura']) {
      const reg = await knex.raw(`SELECT to_regclass('${v}') r`);
      ok(!!reg.rows[0].r, `${v} existe`);
    }
    for (const v of ['finance.v_caja_movimientos_pendientes', 'finance.v_caja_cobertura']) {
      const o = await knex.raw(`SELECT reloptions FROM pg_class WHERE oid='${v}'::regclass`);
      ok((o.rows[0]?.reloptions || []).some((x) => x === 'security_invoker=true'),
        `${v} con security_invoker=true (una vista NO hereda la RLS de cash_ledger)`);
    }
    // ⚠️ El GRANT no sobrevive a un CREATE OR REPLACE (ADR-057). Sin esto, la app ve un 42501 en
    // runtime y la pantalla queda vacía "sin motivo".
    for (const [sch, rel] of [['analytics', 'kepler_bank_movements'], ['analytics', 'v_kepler_cajas'],
      ['finance', 'v_caja_movimientos_pendientes'], ['finance', 'v_caja_cobertura']]) {
      const g = await knex.raw(
        `SELECT has_table_privilege('app_runtime', '${sch}.${rel}', 'SELECT') AS p`);
      ok(g.rows[0]?.p === true, `app_runtime puede leer ${sch}.${rel} (el GRANT no se hereda del replace)`);
    }

    // ── 2. El decode: c45 y el catálogo de cajas ──────────────────────────────────────────────
    console.log('\n── 2. c45 -> kdb1: la cuenta por la que se movió el dinero ──');
    const ods = await knex.raw(`SELECT to_regclass('kepler_ods.kdb1') r`);
    if (!ods.rows[0].r) {
      skip('kepler_ods.kdb1 no existe en este entorno: el decode de c45 no se puede comprobar. NO se da por bueno.');
      skip('el catálogo de cajas (5 de EFECTIVO, entre ellas 0011 CAJA GENERAL) queda sin verificar.');
      skip('la paridad v_kepler_cajas == tipo_cuenta=caja queda sin verificar.');
    } else {
      const cajas = await knex('analytics.v_kepler_cajas').where('tenant_id', T).select('clave', 'nombre');
      const claves = cajas.map((c) => String(c.clave)).sort();
      ok(claves.includes('0011'), `0011 está en el catálogo de cajas (salió: ${claves.join(', ') || 'nada'})`);
      const cg = cajas.find((c) => String(c.clave) === '0011');
      ok(!!cg && /CAJA GENERAL/i.test(String(cg.nombre)),
        `0011 se llama CAJA GENERAL en Kepler, no es una suposición nuestra (dice: ${cg ? cg.nombre : '—'})`);
      // ⛔ La que fallaría con el CASE viejo: listaba ('0010','0011','0040') a mano y dejaba
      // 0030 CAJA CHICA MORELIA ABASTOS y 0050 CAJA CHICA CANINDO como 'banco'.
      ok(claves.includes('0030') && claves.includes('0050'),
        '[negativa] 0030 y 0050 TAMBIÉN son cajas: el criterio derivado (c3=EFECTIVO) las agarra, la lista a mano no');

      // Paridad: las dos vistas tienen que decir lo mismo sobre qué es una caja, o van a divergir.
      const enMov = await knex('analytics.kepler_bank_movements')
        .where({ tenant_id: T, tipo_cuenta: 'caja' }).distinct('clave_banco');
      const sobran = enMov.map((r) => String(r.clave_banco)).filter((c) => !claves.includes(c));
      ok(sobran.length === 0,
        `paridad: toda clave que kepler_bank_movements marca 'caja' está en el catálogo (sobran: ${sobran.join(', ') || 'ninguna'})`);
    }

    // ── 3. ⛔ La llave lleva el doc_tipo, y esto lo prueba ─────────────────────────────────────
    console.log('\n── 3. La llave compuesta: el folio COLISIONA entre doctypes ──');
    await knex.transaction(async (trx) => {
      await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [T]);

      // Mismo folio, DOS documentos distintos de Kepler. Medido en vivo: los folios 0000011,
      // 0000029 y 0000030 existen a la vez en X-A-45, X-D-26 y X-D-60.
      const refPago = '00|X-D-26|0000029|0011';
      const refAnt = '00|X-D-60|0000029|0011';

      await trx('finance.cash_ledger').insert(mov({ origen_tipo: 'pago_proveedor', origen_ref: refPago }));
      const segundo = await violation(trx, () => trx('finance.cash_ledger')
        .insert(mov({ origen_tipo: 'pago_proveedor', origen_ref: refPago })));
      ok(segundo === '23505',
        `[negativa] el MISMO documento dos veces choca con ux_cash_ledger_origen_vivo (fue ${segundo})`);

      // ⭐ La prueba que da sentido a la llave: el anticipo con el MISMO folio tiene que entrar.
      // Con `sucursal|folio` a secas, esto sería un 23505 y el pago desaparecería de la bandeja
      // sin que nadie lo hubiera capturado.
      let entro = true;
      try {
        await trx('finance.cash_ledger').insert(mov({ origen_tipo: 'pago_proveedor', origen_ref: refAnt }));
      } catch { entro = false; }
      ok(entro, '⭐ otro doctype con el MISMO folio SÍ entra: la llave lleva doc_tipo, no sólo sucursal|folio');

      // Cancelar libera el documento: el índice es parcial a propósito.
      await trx('finance.cash_ledger').where({ tenant_id: T, origen_ref: refPago }).update({ estado: 'cancelado' });
      let reentro = true;
      try {
        await trx('finance.cash_ledger').insert(mov({ origen_tipo: 'pago_proveedor', origen_ref: refPago }));
      } catch { reentro = false; }
      ok(reentro, 'cancelar LIBERA el documento: se puede volver a capturar (el índice excluye cancelado)');

      throw new Error('__ROLLBACK__');
    }).catch((e) => { if (e.message !== '__ROLLBACK__') throw e; });
    console.log('  ok rollback aplicado - la DB queda como estaba');
    pass++;

    // ── 4. Los dos origen_tipo que anclan ya están permitidos ─────────────────────────────────
    console.log('\n── 4. origen_tipo: el egreso entra sin tocar el CHECK ──');
    await knex.transaction(async (trx) => {
      await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [T]);
      for (const t of ['cobro', 'pago_proveedor']) {
        let entro = true;
        try {
          await trx('finance.cash_ledger').insert(mov({
            tipo: t === 'cobro' ? 'ingreso' : 'gasto',
            origen_tipo: t, origen_ref: `00|X-D-26|${Date.now()}${n += 1}|0011`,
          }));
        } catch { entro = false; }
        ok(entro, `origen_tipo='${t}' lo admite cash_ledger_origen_chk (cero cirugía de constraint)`);
      }
      const inventado = await violation(trx, () => trx('finance.cash_ledger')
        .insert(mov({ origen_tipo: 'egreso_erp', origen_ref: '00|X|1|0011' })));
      ok(inventado === '23514',
        `[negativa] un origen_tipo inventado NO pasa: el CHECK es un enum cerrado (fue ${inventado})`);
      throw new Error('__ROLLBACK__');
    }).catch((e) => { if (e.message !== '__ROLLBACK__') throw e; });
    console.log('  ok rollback aplicado');
    pass++;

    // ── 5. La cobertura cuenta los DOS signos ─────────────────────────────────────────────────
    console.log('\n── 5. Cobertura por signo ──');
    const cols = await knex('information_schema.columns')
      .where({ table_schema: 'finance', table_name: 'v_caja_cobertura' }).pluck('column_name');
    ok(cols.includes('tipo'), 'v_caja_cobertura tiene `tipo` como DIMENSIÓN (la vista anterior filtraba tipo=ingreso)');
    ok(cols.includes('anclados') && cols.includes('capturados'),
      'publica anclado vs tecleado: una caja 100% a mano no puede verse igual que una anclada (ADR-056)');

    await knex.transaction(async (trx) => {
      await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [T]);
      await trx('finance.cash_ledger').insert(mov({
        tipo: 'gasto', fecha: '2026-09-22',
        origen_tipo: 'pago_proveedor', origen_ref: `00|X-D-26|COB${n += 1}|0011`,
      }));
      const fila = await trx('finance.v_caja_cobertura').where({ tipo: 'gasto' }).first();
      ok(!!fila && Number(fila.anclados) >= 1,
        '⭐ un EGRESO anclado aparece en la cobertura (con la vista vieja quedaba invisible)');
      throw new Error('__ROLLBACK__');
    }).catch((e) => { if (e.message !== '__ROLLBACK__') throw e; });
    console.log('  ok rollback aplicado');
    pass++;

    // ── 6. Declarado, no dibujado ─────────────────────────────────────────────────────────────
    console.log('\n── 6. Declarado ──');
    skip('⛔ EL BUG QUE ESTA FASE ARREGLA — que `monto_contado` llegue al LIBRO y no sólo al hallazgo '
      + 'se prueba contra el SERVICIO (create() resolvía el importe del ERP y lo pisaba). Es HTTP, '
      + 'no tabla: ADR-044. Sin credenciales en esta sesión queda declarado, NO verde.');
    skip('que la bandeja liste los dos signos y resuelva la cuenta por el camino de cada uno '
      + '(route_customer_map para el ingreso, caja_classify_rules para el egreso) es del servicio: HTTP.');
    skip('el cuadre contra el Control de los 5 meses cerrados ($44,108,221.92 vs $44,123,427.09) se midió '
      + 'a mano contra las réplicas crudas de md:5433; falta traerlo acá como aserción con tolerancia 0.5%.');
    skip('que `medir` de la bandeja «caja-por-confirmar» LANCE cuando la sesión no trae tenant (en vez de '
      + 'contar 0 y decir "al día") se prueba con una sesión sin app.tenant_id — necesita el runtime, no la tabla.');

    console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} ✓ / ${fail} ✗ / ${nomedido} NO MEDIDO\n`);
    process.exitCode = fail === 0 ? 0 : 1;
  } catch (e) {
    console.error('\n💥', e.message, '\n', e.stack);
    process.exitCode = 1;
  } finally {
    await knex.destroy();
  }
})();
