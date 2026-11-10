/* eslint-disable no-console */
/**
 * `[PQ.94]` La API de Temporadas contra una base REAL, con el payload de la pantalla (CLAUDE.md regla 13:
 * un endpoint que ESCRIBE no está probado hasta que una prueba lo ejerció contra base real).
 *
 * Carga con ts-node el MISMO `temporadas.repo.ts` que usa la API (no una copia del SQL) y lo corre como
 * `app_runtime` con el tenant puesto, o sea con la RLS y los GRANT de producción. Todo en UNA transacción
 * que se revierte. Si la base no trae las tablas, aplica el `up()` de la migración dentro de ella.
 *
 * ⛔ Escribe (y revierte): no corre contra producción (`assertSafeTarget`). A mano, con `DATABASE_URL_NEW`
 * apuntando a una base local (localhost):
 *   node database/tests/test-newdb-pq94-temporadas-api.js
 *
 * ⚠️ `calcularCandidatos` lee `analytics.mv_sellout_monthly`: si no está poblada se declara NO MEDIDO y la
 *    unión de decisiones se ejerce con una propuesta armada a mano.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-pq94-temporadas-api');
const { noMedido, correr } = require('./_lib/no-medido');
const RAIZ = path.resolve(__dirname, '..', '..');

let R;
let C;
try {
  require('ts-node').register({ transpileOnly: true, skipProject: true,
    compilerOptions: { module: 'commonjs', moduleResolution: 'node', target: 'es2021', experimentalDecorators: true, emitDecoratorMetadata: true, ignoreDeprecations: '6.0' } });
  const tsc = require('typescript');
  const base = tsc.readConfigFile(path.join(RAIZ, 'tsconfig.base.json'), tsc.sys.readFile).config;
  require('tsconfig-paths').register({ baseUrl: RAIZ, paths: base.compilerOptions.paths });
  R = require(path.join(RAIZ, 'libs/commercial/src/lib/temporadas/temporadas.repo.ts'));
  C = require(path.join(RAIZ, 'libs/contracts/src/http/temporadas.contract.ts'));
} catch (e) {
  noMedido(`no se pudo cargar el repositorio con ts-node: ${e.message}`);
}
const knex = require('knex')(require('../knexfile-newdb.js').development);
const mig = require('../migrations-newdb/20261110010537_pq94_temporadas_calendario_y_productos.js');

const TENANT = '00000000-0000-0000-0000-00000000d01c';

let ok = 0;
let ko = 0;
const check = (desc, cond, detalle) => {
  if (cond) { ok += 1; console.log(`  ✓ ${desc}`); }
  else { ko += 1; console.log(`  ✗ ${desc}${detalle !== undefined ? `  → ${JSON.stringify(detalle)}` : ''}`); }
};
/** Corre `fn` en un SAVEPOINT; devuelve el error (o null) y deja la transacción usable. */
async function errorDe(trx, fn) {
  await trx.raw('SAVEPOINT sp_api');
  try { await fn(); await trx.raw('RELEASE SAVEPOINT sp_api'); return null; } catch (e) { await trx.raw('ROLLBACK TO SAVEPOINT sp_api'); return e; }
}

correr(async () => {
  console.log('\n[PQ.94] API de Temporadas — el repositorio real, como app_runtime, con el payload de la pantalla\n');
  const trx = await knex.transaction();
  try {
    if ((await trx.raw('show transaction_read_only')).rows[0].transaction_read_only === 'on') noMedido('la conexión es de sólo lectura');
    if (!(await trx('identity.tenants').where({ id: TENANT }).first('id'))) noMedido(`no existe el tenant ${TENANT}`);
    if (!(await trx.schema.withSchema('catalog').hasTable('season_products'))) await mig.up(trx);

    const skus = (await trx('catalog.products').where({ tenant_id: TENANT }).whereNull('deleted_at').orderBy('sku').limit(3).pluck('sku'));
    if (skus.length < 3) noMedido('la base no tiene 3 productos en catalog.products para decidir');
    const [A, B, D] = skus;
    const usuario = await trx('identity.users').where({ tenant_id: TENANT }).whereNotNull('nombre').first('id', 'nombre', 'username');
    if (!usuario) noMedido('la base no tiene usuarios del tenant');
    const quien = { userId: usuario.id, username: usuario.username ?? null };

    // Desde aquí, como la API en producción: rol de la app y tenant puesto (RLS + GRANT reales).
    await trx.raw('SET LOCAL ROLE app_runtime');
    await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);

    // 1 · El calendario
    const vista = await R.leerTemporadas(trx, TENANT);
    check('el calendario trae las 7 temporadas sembradas', vista.temporadas.length === 7, vista.temporadas.map((t) => t.key));
    const hoy = vista.hoy;
    const enVenta = vista.temporadas.filter((t) => t.fechas.some((f) => f.momento === 'en_venta'));
    check('el orden pone primero la que está en venta (si hay alguna hoy)', !enVenta.length || vista.temporadas[0].fechas.some((f) => f.momento === 'en_venta'),
      vista.temporadas.map((t) => [t.key, t.fechas.map((f) => f.momento).join('/')]));
    check('cada temporada trae sus fechas como texto YYYY-MM-DD y el momento de hoy', vista.temporadas.every((t) => t.fechas.every((f) => /^\d{4}-\d{2}-\d{2}$/.test(f.sale_from) && ['por_iniciar', 'en_venta', 'terminada'].includes(f.momento))));
    check('lo sembrado dice que es propuesta y de dónde salió', vista.temporadas.every((t) => t.fechas.every((f) => f.status === 'propuesta' && (f.proposal_source || '').length > 0)));
    const navidad = vista.temporadas.find((t) => t.key === 'navidad');
    const nav = navidad.fechas.find((f) => f.sale_from <= hoy && hoy <= f.sale_to) || navidad.fechas[0];


    // 2 · Decisiones por lote, con el payload de la pantalla (origen, evidencia) y una respuesta PARCIAL.
    const evidencia = { venta_temporada: 344170, concentracion: 1, cayo_despues: null, por_nombre: true, year: nav.year };
    const lote = { decisiones: [
      { sku: A, decision: 'confirmada', recurrence: 'anual', replenishment: 'compra_unica', origin: 'propuesta_del_sistema', evidence: evidencia },
      { sku: B, decision: 'descartada', reason: 'vende todo el año', origin: 'propuesta_del_sistema', evidence: evidencia },
      { sku: D, decision: 'confirmada', recurrence: 'anual', origin: 'propuesta_del_sistema' },                         // D repetida:
      { sku: D, decision: 'confirmada', recurrence: 'anual', replenishment: 'hasta_corte', origin: 'manual' },          // ninguna entra
      { sku: 'NO-EXISTE-PQ94', decision: 'confirmada', recurrence: 'anual', replenishment: 'compra_unica', origin: 'manual' },
    ] };
    const r1 = await R.guardarDecisiones(trx, TENANT, quien, navidad.id, lote);
    check('lote parcial: 2 guardadas (A y B)', r1.guardadas === 2, r1);
    const motivo = (sku) => r1.fallidas.filter((f) => f.sku === sku).map((f) => f.motivo).join(' | ');
    check('una clave repetida en el lote no entra en NINGUNA de sus apariciones, con un solo motivo', /Viene 2 veces/.test(motivo(D))
      && r1.fallidas.filter((f) => f.sku === D).length === 1
      && !(await trx('catalog.season_products').where({ tenant_id: TENANT, season_id: navidad.id, sku: D }).whereNull('deleted_at').first()), r1.fallidas);
    check('una clave que no está en el catálogo no entra', /no está en el catálogo/.test(motivo('NO-EXISTE-PQ94')), r1.fallidas);
    const r1b = await R.guardarDecisiones(trx, TENANT, quien, navidad.id, { decisiones: [{ sku: D, decision: 'confirmada', recurrence: 'anual', origin: 'propuesta_del_sistema' }] });
    check('la que no dice si se repone no entra, con su motivo', r1b.guardadas === 0 && /compra única o se repone/.test(r1b.fallidas[0]?.motivo ?? ''), r1b);
    const filaA = await trx('catalog.season_products').where({ tenant_id: TENANT, season_id: navidad.id, sku: A }).whereNull('deleted_at').first();
    check('A quedó confirmada, anual, compra única, con quién decidió y su evidencia', filaA?.decision === 'confirmada' && filaA.recurrence === 'anual'
      && filaA.replenishment === 'compra_unica' && filaA.decided_by === quien.userId && filaA.origin === 'propuesta_del_sistema'
      && Number(filaA.evidence?.venta_temporada) === 344170, filaA);
    const filaB = await trx('catalog.season_products').where({ tenant_id: TENANT, season_id: navidad.id, sku: B }).whereNull('deleted_at').first();
    check('B quedó descartada con su motivo y sin recurrencia ni reposición', filaB?.decision === 'descartada' && filaB.reason === 'vende todo el año'
      && filaB.recurrence === null && filaB.replenishment === null, filaB);

    // 2b · Re-decidir actualiza el MISMO renglón (no duplica) y limpia lo que ya no aplica.
    const r2 = await R.guardarDecisiones(trx, TENANT, quien, navidad.id, { decisiones: [
      { sku: B, decision: 'confirmada', recurrence: 'solo_un_anio', only_year: nav.year, replenishment: 'hasta_corte', origin: 'manual' }] });
    const filasB = await trx('catalog.season_products').where({ tenant_id: TENANT, season_id: navidad.id, sku: B }).whereNull('deleted_at');
    check('re-decidir actualiza el mismo renglón (no duplica)', r2.guardadas === 1 && filasB.length === 1 && filasB[0].decision === 'confirmada'
      && filasB[0].only_year === nav.year && filasB[0].id === filaB.id, { r2, filasB });
    // D se confirma «sólo un año» para el año ANTERIOR: no debe contar en el año de nav (hallazgo 2 de la revisión).
    const r3 = await R.guardarDecisiones(trx, TENANT, quien, navidad.id, { decisiones: [
      { sku: D, decision: 'confirmada', recurrence: 'solo_un_anio', only_year: nav.year - 1, replenishment: 'compra_unica', origin: 'manual' }] });
    check('D confirmada «sólo un año» del año anterior', r3.guardadas === 1, r3);

    // 2c · Lo que se rechaza entero.
    const e404 = await errorDe(trx, () => R.guardarDecisiones(trx, TENANT, quien, '00000000-0000-0000-0000-000000000000', lote));
    check('temporada que no existe → no_encontrada', e404?.tipo === 'no_encontrada', e404?.message);
    const eVacio = await errorDe(trx, () => R.guardarDecisiones(trx, TENANT, quien, navidad.id, { decisiones: [] }));
    check('lote vacío → invalida', eVacio?.tipo === 'invalida', eVacio?.message);
    const grande = { decisiones: Array.from({ length: C.TEMPORADAS_LOTE_MAX + 1 }, (_, i) => ({ sku: `X${i}`, decision: 'descartada', reason: 'x', origin: 'manual' })) };
    const eGrande = await errorDe(trx, () => R.guardarDecisiones(trx, TENANT, quien, navidad.id, grande));
    check(`lote de más de ${C.TEMPORADAS_LOTE_MAX} → invalida`, eGrande?.tipo === 'invalida', eGrande?.message);
    const eSinQuien = await errorDe(trx, () => R.guardarDecisiones(trx, TENANT, { userId: '', username: null }, navidad.id, lote));
    check('sin usuario → invalida (nadie decide en anónimo)', eSinQuien?.tipo === 'invalida', eSinQuien?.message);

    // 3 · Confirmar fechas (payload de la pantalla: las fechas precargadas, con corte).
    const eFechas = await errorDe(trx, () => R.confirmarFechas(trx, TENANT, quien, nav.id, { sale_from: nav.sale_from, sale_to: nav.sale_to, cutoff: '2000-01-01' }));
    check('corte fuera de la venta → invalida, con el motivo en llano', eFechas?.tipo === 'invalida' && /dentro de la venta/.test(eFechas.message), eFechas?.message);
    const otroAnio = `${nav.year + 1}${nav.sale_from.slice(4)}`;
    const eAnio = await errorDe(trx, () => R.confirmarFechas(trx, TENANT, quien, nav.id, { sale_from: otroAnio, sale_to: `${nav.year + 1}${nav.sale_to.slice(4)}` }));
    check('la venta de otro año → invalida (no queda una temporada 2026 con ventana de 2027)', eAnio?.tipo === 'invalida' && /tiene que empezar en/.test(eAnio.message), eAnio?.message);
    const eImposible = await errorDe(trx, () => R.confirmarFechas(trx, TENANT, quien, nav.id, { sale_from: `${nav.year}-02-01`, sale_to: `${nav.year}-02-30` }));
    check('una fecha que no existe (30-feb) → invalida, no un 500 de Postgres', eImposible?.tipo === 'invalida', eImposible?.message || eImposible?.code);
    const conf = await R.confirmarFechas(trx, TENANT, quien, nav.id, { sale_from: nav.sale_from, sale_to: nav.sale_to, cutoff: nav.sale_to, clearance_from: nav.clearance_from });
    check('confirmar fechas → confirmada', conf.status === 'confirmada' && conf.id === nav.id, conf);
    const conf2 = await R.confirmarFechas(trx, TENANT, quien, nav.id, { sale_from: nav.sale_from, sale_to: nav.sale_to, cutoff: nav.sale_to, clearance_from: nav.clearance_from });
    check('unas fechas confirmadas se pueden corregir (reconfirmar)', conf2.status === 'confirmada', conf2);
    const vista2 = await R.leerTemporadas(trx, TENANT);
    const nav2 = vista2.temporadas.find((t) => t.key === 'navidad').fechas.find((f) => f.id === nav.id);
    check('el calendario dice quién confirmó y cuándo', nav2.status === 'confirmada' && nav2.confirmed_by_name === usuario.nombre && !!nav2.confirmed_at, nav2);
    check('y cuenta los productos confirmados de la temporada (A, B y D)', vista2.temporadas.find((t) => t.key === 'navidad').productos.confirmados === 3);
    const e404f = await errorDe(trx, () => R.confirmarFechas(trx, TENANT, quien, '00000000-0000-0000-0000-000000000000', { sale_from: nav.sale_from, sale_to: nav.sale_to }));
    check('fechas que no existen → no_encontrada', e404f?.tipo === 'no_encontrada', e404f?.message);

    // 4 · ⭐ Lo que la pantalla confirma es lo que verá el motor (y nada más).
    const est = await trx('catalog.v_product_season_status').where({ tenant_id: TENANT, season_id: navidad.id }).select('sku', 'state', 'replenish_allowed', 'year');
    const estA = est.find((e) => e.sku === A && e.year === nav.year);
    if (hoy >= nav.sale_from && hoy <= nav.sale_to) {
      check('A (confirmada, compra única) ya aparece en el estado de hoy y NO se repone', estA && estA.replenish_allowed === false, est);
      check('D («sólo» el año anterior) NO aparece en el estado de este año', !est.some((e) => e.sku === D && e.year === nav.year), est);
    } else {
      console.log(`  ⓘ NO MEDIDO — hoy (${hoy}) no cae en la Navidad de ${nav.year}: el estado «en venta» no se puede ejercer hoy`);
    }
    const otra = vista2.temporadas.find((t) => t.key === 'dia_de_muertos');
    check('lo propuesto de otra temporada sigue sin publicar nada', (await trx('catalog.v_product_season_status').where({ tenant_id: TENANT, season_id: otra.id })).length === 0);

    // 5 · Candidatos: la cabecera fresca, la vista cara (si hay venta) y la unión con las decisiones (siempre).
    const cab = await R.leerCabecera(trx, TENANT, nav.id);
    check('la cabecera trae los meses de la ventana y si ya cerró', cab && /^\d{4}-\d{2}$/.test(cab.meses.desde) && typeof cab.ventana_cerrada === 'boolean'
      && cab.sale_from === nav.sale_from, cab);
    const poblada = (await trx.raw(`SELECT relispopulated FROM pg_class WHERE oid = 'analytics.mv_sellout_monthly'::regclass`)).rows[0].relispopulated;
    if (poblada) {
      const filas = await R.calcularFilas(trx, TENANT, nav.id);
      check('calcularFilas trae la base de meses y si está completa', Number.isInteger(filas.base.meses) && filas.base.completa === (filas.base.meses >= 12), filas.base);
    } else {
      console.log('  ⓘ NO MEDIDO — analytics.mv_sellout_monthly no está poblada aquí: calcularFilas se midió en prod (plan §19.11)');
      const ef = await errorDe(trx, () => R.calcularFilas(trx, TENANT, nav.id));
      check('…y sin venta poblada falla con el código de Postgres, no con un vacío que parezca «sin candidatos»', ef && ef.code === '55000', ef?.code || ef);
    }
    const calcFalso = {
      filas: [
        { sku: A, nombre: 'A', venta_temporada: 10, venta_12m: 10, concentracion: 1, venta_mes_siguiente: 0, cayo_despues: null, por_nombre: true },
        { sku: D, nombre: 'D', venta_temporada: 8, venta_12m: 9, concentracion: 0.89, venta_mes_siguiente: 0, cayo_despues: true, por_nombre: false },
        { sku: 'SOLO-PROPUESTO', nombre: 'P', venta_temporada: 5, venta_12m: 6, concentracion: 0.83, venta_mes_siguiente: 0, cayo_despues: true, por_nombre: false },
      ],
      base: { meses: 4, completa: false },
    };
    const unido = await R.unirDecisiones(trx, TENANT, cab, calcFalso, '2026-11-10T00:00:00.000Z');
    check('la unión pone la decisión vigente en cada candidato', unido.candidatos.find((c) => c.sku === A)?.decision === 'confirmada'
      && unido.candidatos.find((c) => c.sku === 'SOLO-PROPUESTO')?.decision === null);
    check('⭐ lo confirmado «sólo» para OTRO año sale por decidir en éste (no «Confirmado»)', unido.candidatos.find((c) => c.sku === D)?.decision === null, unido.candidatos);
    check('lo decidido que no salió en la propuesta va aparte (B); lo de otro año no', unido.fuera_de_propuesta.some((f) => f.sku === B && f.decision === 'confirmada')
      && !unido.fuera_de_propuesta.some((f) => f.sku === D), unido.fuera_de_propuesta);
    check('el resumen cuadra: 3 propuestos · 1 confirmado · 0 descartados · 2 por decidir',
      JSON.stringify(unido.resumen) === JSON.stringify({ propuestos: 3, confirmados: 1, descartados: 0, por_decidir: 2 }), unido.resumen);
    check('la base incompleta y la ventana viajan a la pantalla', unido.base.completa === false && unido.base.meses === 4 && unido.ventana_cerrada === cab.ventana_cerrada);
    await trx.raw('RESET ROLE');
  } finally {
    await trx.rollback().catch(() => undefined);
    await knex.destroy();
  }
  console.log(`\n  ${ok} ✓ · ${ko} ✗\n`);
  process.exit(ko ? 1 : 0);
});
