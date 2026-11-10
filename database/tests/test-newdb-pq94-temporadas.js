/* eslint-disable no-console */
/**
 * `[PQ.94]` Temporadas contra una base REAL: la migración corre y es idempotente, la siembra es sólo
 * PROPUESTA, cada CHECK y cada índice único rechaza lo que debe (con el código exacto de Postgres), la
 * RLS no deja ver otro tenant, y `v_product_season_status` sólo publica lo CONFIRMADO (ADR-056).
 *
 * Plan: `docs/IMPLEMENTACION/FASES/FASE_PQ_PEDIDO_VERDAD_Y_CIERRE.md` §19.8.
 *
 * Todo en UNA transacción que se revierte al final. Si la base no trae las tablas, se aplica el `up()`
 * dentro de la transacción (y se revierte con ella).
 *
 * ⛔ Escribe (y revierte): no corre contra producción (`assertSafeTarget`). Con el `.env` de la máquina
 * de Francisco (prod en sólo lectura) sale NO MEDIDO: la ejerce el job `pruebas-db` del CI, o a mano
 * con `DATABASE_URL_NEW` apuntando a una base local (localhost):
 *   node database/tests/test-newdb-pq94-temporadas.js
 *
 * ⚠️ `v_season_candidates` lee `analytics.mv_sellout_monthly`. Si la vista materializada no está poblada
 *    (base local o de CI), se comprueba el PLAN de la consulta y el resultado se declara NO MEDIDO: la
 *    lógica se midió en prod con su prototipo (plan §19.8).
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-pq94-temporadas');
const { noMedido, correr } = require('./_lib/no-medido');
const knex = require('knex')(require('../knexfile-newdb.js').development);
const mig = require('../migrations-newdb/20261110010537_pq94_temporadas_calendario_y_productos.js');

const TENANT = '00000000-0000-0000-0000-00000000d01c';
const OTRO_TENANT = '11111111-2222-3333-4444-555555555555';
const USUARIO = '00000000-0000-0000-0000-0000000000aa';

let ok = 0;
let ko = 0;
const check = (desc, cond, detalle) => {
  if (cond) { ok += 1; console.log(`  ✓ ${desc}`); }
  else { ko += 1; console.log(`  ✗ ${desc}${detalle !== undefined ? `  → ${JSON.stringify(detalle)}` : ''}`); }
};

/** Ejecuta `fn` en un SAVEPOINT y devuelve el código de error de Postgres (o null si no falló). */
async function codigoDe(trx, fn) {
  await trx.raw('SAVEPOINT sp');
  try {
    await fn();
    await trx.raw('RELEASE SAVEPOINT sp');
    return null;
  } catch (e) {
    await trx.raw('ROLLBACK TO SAVEPOINT sp');
    return e.code || e.message;
  }
}

correr(async () => {
  console.log('\n[PQ.94] Temporadas — siembra, CHECKs, unicidad, RLS y vistas contra base real\n');
  const trx = await knex.transaction();
  try {
    const roOnly = (await trx.raw('show transaction_read_only')).rows[0].transaction_read_only === 'on';
    if (roOnly) noMedido('la conexión es de sólo lectura: no se puede crear ni escribir las tablas');
    const tenant = await trx('identity.tenants').where({ id: TENANT }).first('id');
    if (!tenant) noMedido(`no existe el tenant ${TENANT} en identity.tenants (base sin sembrar)`);

    const C = () => trx.withSchema('catalog');
    const existia = await trx.schema.withSchema('catalog').hasTable('season_products');
    if (!existia) await mig.up(trx);
    check(`las tres tablas existen (${existia ? 'ya migradas' : 'up() aplicado en la transacción'})`,
      (await Promise.all(['seasons', 'season_dates', 'season_products'].map((t) => trx.schema.withSchema('catalog').hasTable(t)))).every(Boolean));
    check('up() es idempotente (segunda corrida sin error)', (await codigoDe(trx, () => mig.up(trx))) === null);

    // 1 · La siembra: las 7 temporadas del Plan Anual de Mercadotecnia 2026, 14 temporada-año, TODAS
    //     propuesta, sin fecha de compra ni de corte (nadie las definió).
    const temporadas = await C().table('seasons').where({ tenant_id: TENANT }).whereNull('deleted_at').select('id', 'key', 'date_rule');
    check('se sembraron 7 temporadas (sin duplicar al re-correr)', temporadas.length === 7, temporadas.map((t) => t.key));
    check('ni Reyes ni Cuaresma (eventos, sin señal de producto)', !temporadas.some((t) => ['reyes', 'cuaresma'].includes(t.key)));
    const fechas = await C().table('season_dates').where({ tenant_id: TENANT }).whereNull('deleted_at');
    check('se sembraron 14 temporada-año (7 × 2025 y 2026)', fechas.length === 14, fechas.length);
    check('toda la siembra es PROPUESTA', fechas.every((f) => f.status === 'propuesta'), fechas.map((f) => f.status));
    check('la siembra no inventa fecha de corte ni de compra', fechas.every((f) => f.cutoff === null && f.buy_by === null));
    const padre = temporadas.find((t) => t.key === 'dia_del_padre');
    const fPadre = fechas.filter((f) => f.season_id === padre?.id);
    check('Día del Padre es móvil y trae su tercer domingo de junio (15-jun-2025, 21-jun-2026)', padre?.date_rule === 'movil'
      && fPadre.map((f) => fechaTxt(f.sale_to)).sort().join() === '2025-06-15,2026-06-21', fPadre.map((f) => fechaTxt(f.sale_to)));
    const navidad = temporadas.find((t) => t.key === 'navidad');
    const muertos = temporadas.find((t) => t.key === 'dia_de_muertos');
    const fMuertos = fechas.find((f) => f.season_id === muertos.id && f.year === 2026);
    check('Muertos con la ventana del MAYORISTA (1-sep a 2-nov), no la del consumidor',
      fechaTxt(fMuertos.sale_from) === '2026-09-01' && fechaTxt(fMuertos.sale_to) === '2026-11-02', [fechaTxt(fMuertos.sale_from), fechaTxt(fMuertos.sale_to)]);

    // 1b · La regla de la mitad del mes (fn_season_window_months), con las ventanas reales.
    const meses = async (a, b) => {
      const r = (await trx.raw(`SELECT to_char(m_ini,'YYYY-MM') a, to_char(m_fin,'YYYY-MM') b FROM catalog.fn_season_window_months(?::date, ?::date)`, [a, b])).rows[0];
      return `${r.a}..${r.b}`;
    };
    for (const [desc, a, b, esperado] of [
      ['Muertos 1-sep a 2-nov → sep..oct (2 días de nov no cuentan)', '2025-09-01', '2025-11-02', '2025-09..2025-10'],
      ['Navidad 20-oct a 24-dic → nov..dic (12 días de oct no cuentan)', '2025-10-20', '2025-12-24', '2025-11..2025-12'],
      ['San Valentín 5-ene a 14-feb → ene..feb (14 de 28 = la mitad, cuenta)', '2026-01-05', '2026-02-14', '2026-01..2026-02'],
      ['Patrias 15-ago a 16-sep → ago..sep', '2026-08-15', '2026-09-16', '2026-08..2026-09'],
      ['Padre 31-may a 21-jun → jun..jun', '2026-05-31', '2026-06-21', '2026-06..2026-06'],
      ['ventana corta 25-abr a 10-may: ninguno llega a la mitad → el de más días (may)', '2026-04-25', '2026-05-10', '2026-05..2026-05'],
    ]) {
      const r = await meses(a, b);
      check(`mitad del mes · ${desc}`, r === esperado, r);
    }
    const vol = (await trx.raw(`SELECT provolatile FROM pg_proc WHERE proname = 'fn_season_window_months'`)).rows[0]?.provolatile;
    check('la función es STABLE, no IMMUTABLE (date_trunc depende de la zona horaria)', vol === 's', vol);

    // 2 · CHECKs y unicidad, con el código exacto.
    const sd = (p) => ({ tenant_id: TENANT, season_id: navidad.id, year: 2030, sale_from: '2030-11-15', sale_to: '2030-12-24', ...p });
    check('venta que termina antes de empezar → 23514', await codigoDe(trx, () => C().table('season_dates').insert(sd({ sale_to: '2030-11-01' }))) === '23514');
    check('corte fuera de la ventana → 23514', await codigoDe(trx, () => C().table('season_dates').insert(sd({ cutoff: '2030-12-30' }))) === '23514');
    check('comprar después de que empieza la venta → 23514', await codigoDe(trx, () => C().table('season_dates').insert(sd({ buy_by: '2030-11-20' }))) === '23514');
    check('«confirmada» sin quién ni cuándo → 23514', await codigoDe(trx, () => C().table('season_dates').insert(sd({ status: 'confirmada' }))) === '23514');
    check('dos fechas vivas para la misma temporada y año → 23505', await codigoDe(trx, () => C().table('season_dates').insert(sd({ year: 2026 }))) === '23505');
    check('temporada duplicada por clave → 23505', await codigoDe(trx, () => C().table('seasons').insert({ tenant_id: TENANT, key: 'navidad', name: 'Otra', date_rule: 'fija' })) === '23505');
    check('clave con mayúsculas o espacios → 23514', await codigoDe(trx, () => C().table('seasons').insert({ tenant_id: TENANT, key: 'Navidad 2', name: 'x', date_rule: 'fija' })) === '23514');

    const sp = (p) => ({ tenant_id: TENANT, season_id: navidad.id, sku: '17050', decision: 'confirmada', recurrence: 'anual', replenishment: 'compra_unica', origin: 'manual', decided_by: USUARIO, ...p });
    check('confirmar sin decir si se repone → 23514', await codigoDe(trx, () => C().table('season_products').insert(sp({ replenishment: null }))) === '23514');
    check('«sólo un año» sin el año → 23514', await codigoDe(trx, () => C().table('season_products').insert(sp({ recurrence: 'solo_un_anio' }))) === '23514');
    check('descartar sin motivo → 23514', await codigoDe(trx, () => C().table('season_products').insert(sp({ decision: 'descartada', recurrence: null, replenishment: null }))) === '23514');
    check('clave con espacios → 23514', await codigoDe(trx, () => C().table('season_products').insert(sp({ sku: ' 17050' }))) === '23514');
    check('un producto confirmado entra', await codigoDe(trx, () => C().table('season_products').insert(sp())) === null);
    check('el mismo producto dos veces en la temporada → 23505', await codigoDe(trx, () => C().table('season_products').insert(sp())) === '23505');
    check('temporada de otro tenant → 23503 (llave compuesta)', await codigoDe(trx, async () => {
      await trx('identity.tenants').insert({ id: OTRO_TENANT, ...(await columnasTenant(trx)) }).onConflict('id').ignore();
      await C().table('season_products').insert(sp({ tenant_id: OTRO_TENANT, sku: '99999' }));
    }) === '23503');

    // 3 · El estado de hoy: sólo lo confirmado (ADR-056). Fechas relativas a hoy en México.
    const hoy = (await trx.raw(`SELECT to_char((now() AT TIME ZONE 'America/Mexico_City')::date, 'YYYY-MM-DD') AS d`)).rows[0].d;
    const dia = (n) => { const [y, m, d] = hoy.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
    const anio = 2031; // año de prueba: no choca con la siembra
    const [tA] = await C().table('seasons').insert({ tenant_id: TENANT, key: 'prueba_corte', name: 'Prueba corte', date_rule: 'fija' }).returning('id');
    const [tB] = await C().table('seasons').insert({ tenant_id: TENANT, key: 'prueba_futura', name: 'Prueba futura', date_rule: 'fija' }).returning('id');
    const [tC] = await C().table('seasons').insert({ tenant_id: TENANT, key: 'prueba_propuesta', name: 'Prueba propuesta', date_rule: 'fija' }).returning('id');
    const [tD] = await C().table('seasons').insert({ tenant_id: TENANT, key: 'prueba_antes_remate', name: 'Prueba antes del remate', date_rule: 'fija' }).returning('id');
    const [tE] = await C().table('seasons').insert({ tenant_id: TENANT, key: 'prueba_en_remate', name: 'Prueba en remate', date_rule: 'fija' }).returning('id');
    const conf = { status: 'confirmada', confirmed_by: USUARIO, confirmed_at: trx.fn.now() };
    // Venta cerrada hace 2 días; el remate empieza en 3 (D) o empezó ayer (E).
    await C().table('season_dates').insert({ tenant_id: TENANT, season_id: tD.id, year: anio, sale_from: dia(-10), sale_to: dia(-2), clearance_from: dia(3), ...conf });
    await C().table('season_dates').insert({ tenant_id: TENANT, season_id: tE.id, year: anio, sale_from: dia(-10), sale_to: dia(-2), clearance_from: dia(-1), ...conf });
    await C().table('season_dates').insert({ tenant_id: TENANT, season_id: tA.id, year: anio, sale_from: dia(-5), sale_to: dia(5), cutoff: dia(-1), ...conf });
    await C().table('season_dates').insert({ tenant_id: TENANT, season_id: tB.id, year: anio, sale_from: dia(10), sale_to: dia(20), buy_by: dia(-3), ...conf });
    await C().table('season_dates').insert({ tenant_id: TENANT, season_id: tC.id, year: anio, sale_from: dia(-5), sale_to: dia(5) }); // propuesta
    const prod = (season, sku, p) => ({ tenant_id: TENANT, season_id: season, sku, decision: 'confirmada', recurrence: 'anual', replenishment: 'hasta_corte', origin: 'propuesta_del_sistema', decided_by: USUARIO, ...p });
    await C().table('season_products').insert([
      prod(tA.id, 'T-CORTE'),
      prod(tA.id, 'T-UNICA', { replenishment: 'compra_unica' }),
      prod(tB.id, 'T-FUTURA'),
      prod(tC.id, 'T-PROPUESTA'),
      prod(tA.id, 'T-DESCARTADA', { decision: 'descartada', recurrence: null, replenishment: null, reason: 'vende todo el año' }),
      prod(tA.id, 'T-OTRO-ANIO', { recurrence: 'solo_un_anio', only_year: anio - 1 }),
      prod(tD.id, 'T-ANTES-REMATE', { replenishment: 'compra_unica' }),
      prod(tE.id, 'T-EN-REMATE', { replenishment: 'compra_unica' }),
    ]);
    const est = await C().table('v_product_season_status').where({ tenant_id: TENANT }).where('sku', 'like', 'T-%').select('sku', 'state', 'replenish_allowed');
    const de = (s) => est.find((e) => e.sku === s);
    check('pasado el corte: estado «pasado_el_corte» y NO se repone', de('T-CORTE')?.state === 'pasado_el_corte' && de('T-CORTE')?.replenish_allowed === false, de('T-CORTE'));
    check('compra única: no se repone', de('T-UNICA')?.replenish_allowed === false, de('T-UNICA'));
    check('temporada por iniciar y «hasta el corte»: sí se repone', de('T-FUTURA')?.state === 'por_iniciar' && de('T-FUTURA')?.replenish_allowed === true, de('T-FUTURA'));
    check('⭐ fechas sólo PROPUESTAS no aparecen (ADR-056)', !de('T-PROPUESTA'), de('T-PROPUESTA'));
    check('un descartado no aparece', !de('T-DESCARTADA'));
    check('«sólo un año» de otro año no aparece', !de('T-OTRO-ANIO'));
    check('cerrada la venta pero antes de la fecha de remate: «pasado_el_corte», no «en_remate»', de('T-ANTES-REMATE')?.state === 'pasado_el_corte', de('T-ANTES-REMATE'));
    check('desde la fecha de remate: «en_remate»', de('T-EN-REMATE')?.state === 'en_remate', de('T-EN-REMATE'));
    check('la siembra (toda propuesta) no publica ningún estado', (await C().table('v_product_season_status').where({ tenant_id: TENANT, season_id: muertos.id })).length === 0);

    // 4 · Candidatos: el plan filtra la temporada-año ANTES de agregar la venta.
    const dm25 = fechas.find((f) => f.season_id === muertos.id && f.year === 2025);
    const plan = (await trx.raw(`EXPLAIN SELECT * FROM catalog.v_season_candidates WHERE season_date_id = ?`, [dm25.id])).rows.map((r) => r['QUERY PLAN']).join('\n');
    check('el plan de candidatos resuelve sus columnas', /mv_sellout_monthly/.test(plan), plan.slice(0, 200));
    // Control del instrumento: `tenant_id = ` también contiene «id = »; por eso se busca el id EXACTO.
    check('el filtro por temporada-año llega a season_dates (una sola temporada se calcula)',
      /on season_dates/.test(plan) && plan.includes(`(id = '${dm25.id}'::uuid)`), plan);
    const poblada = (await trx.raw(`SELECT relispopulated FROM pg_class WHERE oid = 'analytics.mv_sellout_monthly'::regclass`)).rows[0].relispopulated;
    if (poblada) {
      const cands = await C().table('v_season_candidates').where({ season_date_id: dm25.id }).select('sku', 'name_match', 'collapsed_after');
      check('candidatos de Día de Muertos 2025: sale al menos uno', cands.length > 0, cands.length);
      check('todo candidato trae su porqué (nombre o desplome)', cands.every((c) => c.name_match || c.collapsed_after === true));
    } else {
      console.log('  ⓘ NO MEDIDO — analytics.mv_sellout_monthly no está poblada en esta base: el resultado de candidatos se midió en prod con el prototipo (plan §19.8)');
    }

    // 5 · RLS con el rol de la app; y la app no borra.
    const rls = await codigoDe(trx, async () => {
      await trx.raw('SET LOCAL ROLE app_runtime');
      await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);
      const propias = (await C().table('seasons').count('* as n'))[0].n;
      const estados = (await C().table('v_product_season_status').count('* as n'))[0].n;
      await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [OTRO_TENANT]);
      const ajenas = (await C().table('seasons').count('* as n'))[0].n;
      const estadosAjenos = (await C().table('v_product_season_status').count('* as n'))[0].n;
      const borrar = await codigoDe(trx, () => C().table('season_products').where({ sku: 'T-CORTE' }).del());
      await trx.raw('RESET ROLE');
      check('app_runtime ve sus temporadas (12 = 7 sembradas + 5 de prueba)', Number(propias) === 12, propias);
      check('app_runtime lee la vista de estado por su RLS', Number(estados) >= 3, estados);
      check('con otro tenant, la RLS no deja ver ninguna temporada', Number(ajenas) === 0, ajenas);
      check('ni la vista de estado (security_invoker)', Number(estadosAjenos) === 0, estadosAjenos);
      check('app_runtime no puede borrar decisiones → 42501', borrar === '42501', borrar);
    });
    check('la prueba de RLS corrió (rol app_runtime disponible)', rls === null, rls);

    // 6 · down() se niega con decisiones de personas.
    const down = await codigoDe(trx, () => mig.down(trx));
    check('down() se niega a borrar con decisiones', typeof down === 'string' && /down rechazado/.test(down), down);
  } finally {
    await trx.rollback().catch(() => undefined);
    await knex.destroy();
  }
  console.log(`\n  ${ok} ✓ · ${ko} ✗\n`);
  process.exit(ko ? 1 : 0);
});

/** Una columna `date` como `YYYY-MM-DD` sin depender de la zona horaria de Node. */
function fechaTxt(v) {
  if (typeof v === 'string') return v.slice(0, 10);
  return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
}

/** Las columnas NOT NULL sin default de `identity.tenants`, con un valor de prueba, para sembrar el otro tenant. */
async function columnasTenant(trx) {
  const { rows } = await trx.raw(`
    SELECT column_name, data_type FROM information_schema.columns
     WHERE table_schema = 'identity' AND table_name = 'tenants' AND is_nullable = 'NO' AND column_default IS NULL AND column_name <> 'id'`);
  const out = {};
  for (const r of rows) out[r.column_name] = /char|text/.test(r.data_type) ? `prueba_pq94_${r.column_name}` : (r.data_type === 'boolean' ? false : 0);
  return out;
}
