/**
 * `[PQ.3.4]` La API del Calendario de compras contra una base REAL, con el payload de la pantalla
 * (CLAUDE.md regla 13: un endpoint que ESCRIBE no está probado hasta que una prueba lo ejerció contra
 * base real).
 *
 * Carga con ts-node el MISMO `purchase-calendar.repo.ts` que usa la API (no una copia del SQL) y lo corre
 * como `app_runtime` con el tenant puesto, o sea con la RLS y los GRANT de producción. Todo en UNA
 * transacción que se revierte. Si la base no trae las tablas, aplica el `up()` de la migración
 * 20261120130156 dentro de ella.
 *
 * Qué afirma:
 *  1. Definir una regla (el 15 y el último, corporativo) la crea; volver a definirla en el MISMO alcance
 *     la REEMPLAZA (mismo id) y limpia el patrón anterior.
 *  2. Las reglas de sucursal y de zona entran con las sucursales y zonas REALES de la base.
 *  3. Lo inválido se rechaza con un motivo en llano antes de llegar a Postgres (sin días, zona que no
 *     existe, proveedor que no existe, persona que no existe, sin usuario).
 *  4. El calendario devuelve cada regla con su alcance en palabras, su estado de hoy y la fuente DICHA.
 *  5. Marcar el día crea la marca; marcar otra vez la misma fecha la CORRIGE (no duplica); lo inválido no
 *     entra; el calendario muestra la última marca.
 *  6. «Fuera de ciclo» con motivo saca la regla del rezago; sin motivo no entra; `hasta: null` la regresa.
 *  7. La baja es UPDATE (la regla deja de verse) y libera el alcance para otra; una regla dada de baja ya
 *     no se puede marcar ni dar de baja otra vez.
 *  8. Las propuestas de Kepler no traen a quien ya tiene regla. `[PQ.3.14]` El día fijo por sucursal se DECLARA:
 *     medido si la base tiene la actividad de Kepler; si no, `measured: false` con nota, sin inventar ninguno, y la
 *     transacción sigue viva (la consulta va en un SAVEPOINT).
 *  9. `[PQ.3.6]` El alcance por sucursal: quien ve una sucursal sólo ve las reglas que caben en ella (y el
 *     resumen cuenta sólo esas); marcar, sacar del ciclo, dar de baja o definir fuera de su alcance se
 *     rechaza como `fuera_de_alcance` sin escribir; sin alcance dicho, el repositorio no adivina: falla.
 *
 * ⛔ Escribe (y revierte): no corre contra producción (`assertSafeTarget`). A mano, con `DATABASE_URL_NEW`
 *    apuntando a una base local.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-pq3-4-calendario-api');
const { noMedido, correr } = require('./_lib/no-medido');
const RAIZ = path.resolve(__dirname, '..', '..');

let R;
let D;
try {
  require('ts-node').register({ transpileOnly: true, skipProject: true,
    compilerOptions: { module: 'commonjs', moduleResolution: 'node', target: 'es2021', experimentalDecorators: true, emitDecoratorMetadata: true, ignoreDeprecations: '6.0' } });
  const tsc = require('typescript');
  const base = tsc.readConfigFile(path.join(RAIZ, 'tsconfig.base.json'), tsc.sys.readFile).config;
  require('tsconfig-paths').register({ baseUrl: RAIZ, paths: base.compilerOptions.paths });
  R = require(path.join(RAIZ, 'libs/commercial/src/lib/purchase-calendar/purchase-calendar.repo.ts'));
  D = require(path.join(RAIZ, 'libs/commercial/src/lib/purchase-calendar/purchase-calendar.domain.ts'));
} catch (e) {
  noMedido(`no se pudo cargar el repositorio con ts-node: ${e.message}`);
}
const knex = require('knex')(require('../knexfile-newdb.js').development);
const mig = require('../migrations-newdb/20261120130156_pq3_2_reglas_de_revision_compras.js');

const TENANT = '00000000-0000-0000-0000-00000000d01c';

let ok = 0;
let ko = 0;
let nm = 0;
const check = (desc, cond, detalle) => {
  if (cond) { ok += 1; console.log(`  ✓ ${desc}`); }
  else { ko += 1; console.log(`  ✗ ${desc}${detalle !== undefined ? `  → ${JSON.stringify(detalle)}` : ''}`); }
};
const NM = (m) => { nm += 1; console.log(`  ○ NO MEDIDO — ${m}`); };
/** Corre `fn` en un SAVEPOINT; devuelve el error (o null) y deja la transacción usable. */
async function errorDe(trx, fn) {
  await trx.raw('SAVEPOINT sp_api');
  try { await fn(); await trx.raw('RELEASE SAVEPOINT sp_api'); return null; } catch (e) { await trx.raw('ROLLBACK TO SAVEPOINT sp_api'); return e; }
}
const sumar = (f, n) => { const d = new Date(`${f}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

correr(async () => {
  console.log('\n[PQ.3.4] API del Calendario de compras — el repositorio real, como app_runtime, con el payload de la pantalla\n');
  const trx = await knex.transaction();
  try {
    if ((await trx.raw('show transaction_read_only')).rows[0].transaction_read_only === 'on') noMedido('la conexión es de sólo lectura');
    if (!(await trx('identity.tenants').where({ id: TENANT }).first('id'))) noMedido(`no existe el tenant ${TENANT}`);
    if (!(await trx.schema.withSchema('commercial').hasTable('purchase_review_rules'))) await mig.up(trx);
    // `[PQ.3.15]` Las columnas de la cadencia (idempotente): el repositorio ya las escribe.
    await require('../migrations-newdb/20261124133043_pq3_15_cadencia_dias_de_la_semana.js').up(trx);

    // Proveedores SIN regla viva: en una base con reglas (la local tras una prueba visual, prod algún día) la
    // primera regla sería «actualizada» y no «creada», y la prueba fallaría por el dato, no por el código.
    const provs = await trx('catalog.suppliers as s').where({ 's.tenant_id': TENANT }).whereNull('s.deleted_at').whereNotNull('s.code')
      .whereRaw(`btrim(s.code) <> ''`)
      .whereRaw(`NOT EXISTS (SELECT 1 FROM commercial.purchase_review_rules r
                              WHERE r.tenant_id = s.tenant_id AND r.supplier_code = s.code AND r.deleted_at IS NULL)`)
      .orderBy('s.code').limit(2).select('s.code', 's.name');
    if (provs.length < 2) noMedido('la base no tiene 2 proveedores vivos en catalog.suppliers');
    const [P, P2] = provs;
    const usuario = await trx('identity.users').where({ tenant_id: TENANT }).whereNotNull('nombre').first('id', 'nombre', 'username');
    if (!usuario) noMedido('la base no tiene usuarios del tenant');
    const quien = { userId: usuario.id, username: usuario.username ?? null, escribe: null };

    // [PQ.3.18] (c) Un proveedor OCASIONAL (una sola OC hace 30 días, monto mínimo) sembrado en el ODS de Kepler, como
    // postgres y DENTRO de esta transacción (se revierte): sin él, la base local no tiene escalón 3 y la escritura en
    // bloque no se ejercería. Si la tabla no lo acepta (otra forma), la sección (c) se declara NO MEDIDA.
    const OCAS = 'PQ318OCAS';
    const sembroOcasional = (await errorDe(trx, async () => {
      const f = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
      await trx('kepler_ods.kdm1').insert({
        sucursal: '01', c1: '01', c2: 'X', c3: 'A', c4: 35, c5: 0, c6: 'PQ318-0001', c9: `${f} 12:00:00`,
        c10: OCAS, c32: 'OCASIONAL DE PRUEBA PQ318', c16: 1, c43: 'F',
      });
    })) === null;

    // Desde aquí, como la API en producción: rol de la app y tenant puesto (RLS + GRANT reales).
    await trx.raw('SET LOCAL ROLE app_runtime');
    await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);
    const hoy = await R.hoyMx(trx);
    const sucursales = await R.leerSucursales(trx);

    // La actividad de Kepler (`SQL_ACTIVIDAD_KEPLER`) lee la plaza de origen de la entrada. Una base sin
    // el ODS de Kepler (la local, quizá la del CI) trae `erp_goods_receipts` en su forma vieja, sin esa
    // columna: ahí esa consulta NO se mide (se midió en prod, sólo lectura, el 2026-11-20: 445–494 ms con
    // 340 claves) y el calendario se arma con las MISMAS piezas reales (reglas, marcas, sucursales) y
    // actividad vacía. Todo lo demás se ejerce igual.
    const cols = (await trx.raw(`SELECT column_name FROM information_schema.columns
                                  WHERE table_schema = 'analytics' AND table_name = 'erp_goods_receipts'`)).rows.map((r) => r.column_name);
    const actividadOk = cols.includes('origen_warehouse_code') && cols.includes('dup_of_folio');
    if (!actividadOk) NM('la consulta de actividad de Kepler: a esta base le falta analytics.erp_goods_receipts.origen_warehouse_code (sin ODS de Kepler); se midió en prod');
    const almacenes = await R.leerAlmacenes(trx, TENANT);
    const leerCalendario = async (lee = null) => (actividadOk
      ? R.leerCalendario(trx, TENANT, lee)
      : D.armarCalendario(hoy, (await R.leerReglas(trx, TENANT)).filter((r) => D.reglaEnAlcance(r, sucursales, lee)), [],
        await R.leerMarcas(trx, TENANT, sumar(hoy, -62)), sucursales, almacenes, lee));

    // 1 · Definir y redefinir la regla corporativa (el ejemplo de Francisco: el 15 y el último).
    const r1 = await R.guardarRegla(trx, TENANT, quien, { supplier_code: P.code, scope: 'corporate', pattern: 'month_days', month_days: [15], month_last_day: true, weekend_shift: 'friday' });
    check('definir «el 15 y el último», corporativo → creada', r1.accion === 'creada' && !!r1.id, r1);
    const r1b = await R.guardarRegla(trx, TENANT, quien, { supplier_code: P.code, scope: 'corporate', pattern: 'every_n_days', every_n_days: 7 });
    const fila1 = await trx('commercial.purchase_review_rules').where({ id: r1.id }).first();
    check('redefinirla en el MISMO alcance la reemplaza (mismo id) y limpia el patrón anterior',
      r1b.accion === 'actualizada' && r1b.id === r1.id && fila1.pattern === 'every_n_days' && Number(fila1.every_n_days) === 7
      && fila1.month_days === null && fila1.month_last_day === false && fila1.created_by === usuario.id, { r1b, fila1 });

    // 2 · Sucursal y zona, con las REALES de la base.
    const conZona = sucursales.find((s) => s.zona_code);
    let rSuc = null;
    let rZona = null;
    if (conZona) {
      rSuc = await R.guardarRegla(trx, TENANT, quien, { supplier_code: P.code, scope: 'branch', branch_code: conZona.branch_code, pattern: 'weekdays', weekdays: [3] });
      // `[PQ.3.22]` El responsable (permiso + alcance) se prueba en test-newdb-pq3-21-calendario-mejoras.js; aquí, el puesto.
      rZona = await R.guardarRegla(trx, TENANT, quien, { supplier_code: P2.code, scope: 'zone', zone_code: conZona.zona_code, pattern: 'every_n_days', every_n_days: 14 });
      check(`el MISMO proveedor con regla corporativa y de sucursal (${conZona.branch_code}); otra de zona (${conZona.zona_code})`,
        rSuc.accion === 'creada' && rZona.accion === 'creada' && rSuc.id !== r1.id, { rSuc, rZona });
    } else {
      NM('la base no trae sucursales con zona en analytics.v_branch_zone: las reglas de sucursal y zona no se probaron');
    }

    // 3 · Lo inválido, con motivo en llano y sin llegar a Postgres.
    const inval = [
      ['días de la semana sin días', { supplier_code: P.code, scope: 'corporate', pattern: 'weekdays', weekdays: [] }, /día de la semana/],
      ['una zona que no existe', { supplier_code: P.code, scope: 'zone', zone_code: 'NO-EXISTE', pattern: 'weekdays', weekdays: [1] }, /zona/],
      ['un proveedor que no existe', { supplier_code: 'PQ34-NO-EXISTE', scope: 'corporate', pattern: 'weekdays', weekdays: [1] }, /No encontramos al proveedor/],
      ['una persona que no existe', { supplier_code: P.code, scope: 'corporate', pattern: 'weekdays', weekdays: [1], reviewer_user_id: '00000000-0000-0000-0000-000000000001' }, /no existe/],
      ['cada 0 días', { supplier_code: P.code, scope: 'corporate', pattern: 'every_n_days', every_n_days: 0 }, /de 1 a 365/],
    ];
    for (const [que, dto, rx] of inval) {
      const e = await errorDe(trx, () => R.guardarRegla(trx, TENANT, quien, dto));
      check(`rechaza ${que} → invalida, «${e?.message}»`, e?.tipo === 'invalida' && rx.test(e.message), e?.message || e?.code);
    }
    const eAnon = await errorDe(trx, () => R.guardarRegla(trx, TENANT, { userId: '', username: null, escribe: null }, { supplier_code: P.code, scope: 'corporate', pattern: 'weekdays', weekdays: [1] }));
    check('sin usuario → invalida (nadie define en anónimo)', eAnon?.tipo === 'invalida', eAnon?.message);

    // 4 · El calendario.
    const t0 = Date.now();
    const cal = await leerCalendario();
    const ms = Date.now() - t0;
    const mia = cal.reglas.find((r) => r.id === r1.id);
    check(`el calendario trae la regla corporativa con su alcance en palabras, su estado y quién la definió (${ms} ms)`,
      !!mia && mia.alcance_nombre === 'Todas las sucursales' && mia.revisa === 'Gerencia de compras'
      && ['al_dia', 'toca_hoy', 'rezagada', 'sin_ancla'].includes(mia.estado.estado) && mia.definida_por === usuario.nombre, mia);
    check('el calendario DICE de dónde sale «atendido» y desde cuándo buscó', /canceladas/.test(cal.fuente) && cal.actividad_desde === sumar(hoy, -62), { fuente: cal.fuente, desde: cal.actividad_desde });
    const suma = Object.values(cal.resumen).reduce((a, b) => a + b, 0);
    check('el resumen cuenta exactamente las reglas', suma === cal.reglas.length, cal.resumen);
    if (rZona) {
      const z = cal.reglas.find((r) => r.id === rZona.id);
      check('la regla de zona dice su zona y que la revisa la gerencia de esa zona', !!z && z.alcance_nombre.startsWith('Zona ') && z.revisa.startsWith('Gerencia de zona'), z && { alcance: z.alcance_nombre, revisa: z.revisa });
    }
    // `[PQ.3.5]` Lo que la pantalla necesita para el formulario y para «Abrir en Pedido», leído como app_runtime.
    const zonasBase = [...new Set(sucursales.map((s) => s.zona_code).filter(Boolean))].sort();
    check('el calendario trae las zonas (las MISMAS con que valida la API) y todas las sucursales',
      JSON.stringify(cal.zonas.map((z) => z.code).sort()) === JSON.stringify(zonasBase)
      && cal.sucursales.length === sucursales.length, { zonas: cal.zonas, sucursales: cal.sucursales });
    check('la regla corporativa abre Pedido sin filtro de sucursal; su nota y la ficha de Pedido viajan (null si la clave no tiene productos ahí)',
      Array.isArray(mia.pedido_warehouse_ids) && mia.pedido_warehouse_ids.length === 0 && 'note' in mia
      && (mia.pedido_supplier_id === null || typeof mia.pedido_supplier_id === 'string'), { note: mia.note, sup: mia.pedido_supplier_id });
    if (rSuc) {
      const s = cal.reglas.find((r) => r.id === rSuc.id);
      const esperado = almacenes.filter((a) => a.code === conZona.branch_code).map((a) => a.id);
      check(`la regla de sucursal (${conZona.branch_code}) abre Pedido con SU almacén y ningún otro`,
        !!s && JSON.stringify(s.pedido_warehouse_ids) === JSON.stringify(esperado), { tiene: s?.pedido_warehouse_ids, esperado });
    }

    // 5 · Marcar el día (payload de la pantalla).
    const m1 = await R.marcar(trx, TENANT, quien, r1.id, { review_date: hoy, outcome: 'skipped', skip_reason: 'in_quotation', postponed_to: sumar(hoy, 3), note: null });
    const m2 = await R.marcar(trx, TENANT, quien, r1.id, { review_date: hoy, outcome: 'skipped', skip_reason: 'order_exists', postponed_to: null, note: '  ' });
    const marcas = await trx('commercial.purchase_review_marks').where({ rule_id: r1.id });
    check('marcar crea; marcar la MISMA fecha la corrige (una sola marca, sin nueva fecha, nota vacía → null)',
      m1.accion === 'creada' && m2.accion === 'corregida' && marcas.length === 1 && marcas[0].skip_reason === 'order_exists'
      && marcas[0].postponed_to === null && marcas[0].note === null, { m1, m2, marcas });
    const eOtro = await errorDe(trx, () => R.marcar(trx, TENANT, quien, r1.id, { review_date: hoy, outcome: 'skipped', skip_reason: 'other', note: '' }));
    check('«Otro» sin nota → invalida', eOtro?.tipo === 'invalida' && /escribe el motivo/.test(eOtro.message), eOtro?.message);
    const eLejos = await errorDe(trx, () => R.marcar(trx, TENANT, quien, r1.id, { review_date: sumar(hoy, 30), outcome: 'skipped', skip_reason: 'not_needed' }));
    check('marcar a 30 días adelante → invalida', eLejos?.tipo === 'invalida', eLejos?.message);
    const eFuera = await errorDe(trx, () => R.marcar(trx, TENANT, quien, r1.id, { review_date: hoy, outcome: 'ordered_outside_kepler', skip_reason: 'blocked' }));
    check('«se pidió fuera de Kepler» con motivo de no pedir → invalida', eFuera?.tipo === 'invalida', eFuera?.message);
    const cal2 = await leerCalendario();
    const conMarca = cal2.reglas.find((r) => r.id === r1.id);
    check('el calendario muestra la última marca, con quién marcó', conMarca?.ultima_marca?.skip_reason === 'order_exists' && conMarca.ultima_marca.marcada_por === usuario.nombre, conMarca?.ultima_marca);

    // 6 · Fuera de ciclo.
    const eSinMotivo = await errorDe(trx, () => R.fueraDeCiclo(trx, TENANT, quien, r1.id, { hasta: sumar(hoy, 30), motivo: ' ' }));
    check('fuera de ciclo sin motivo → invalida', eSinMotivo?.tipo === 'invalida', eSinMotivo?.message);
    await R.fueraDeCiclo(trx, TENANT, quien, r1.id, { hasta: sumar(hoy, 30), motivo: 'Temporada: no surte hasta enero' });
    const cal3 = await leerCalendario();
    check('fuera de ciclo con motivo: la regla sale del rezago', cal3.reglas.find((r) => r.id === r1.id)?.estado.estado === 'fuera_de_ciclo', cal3.reglas.find((r) => r.id === r1.id)?.estado);
    await R.fueraDeCiclo(trx, TENANT, quien, r1.id, { hasta: null });
    const fila1c = await trx('commercial.purchase_review_rules').where({ id: r1.id }).first();
    check('hasta = null la regresa al ciclo (fecha y motivo limpios)', fila1c.out_of_cycle_until === null && fila1c.out_of_cycle_reason === null, fila1c);

    // 7 · Baja.
    await R.darDeBaja(trx, TENANT, quien, r1.id);
    const cal4 = await leerCalendario();
    const filaBaja = await trx('commercial.purchase_review_rules').where({ id: r1.id }).first();
    check('la baja es UPDATE: la regla sigue en la tabla con quién y cuándo, y ya no sale en el calendario',
      !!filaBaja && filaBaja.deleted_by === usuario.id && filaBaja.deleted_at !== null && !cal4.reglas.some((r) => r.id === r1.id), filaBaja);
    const eBaja2 = await errorDe(trx, () => R.darDeBaja(trx, TENANT, quien, r1.id));
    check('dar de baja otra vez → no_encontrada', eBaja2?.tipo === 'no_encontrada', eBaja2?.message);
    const eMarcaBaja = await errorDe(trx, () => R.marcar(trx, TENANT, quien, r1.id, { review_date: hoy, outcome: 'ordered_outside_kepler' }));
    check('marcar una regla dada de baja → no_encontrada', eMarcaBaja?.tipo === 'no_encontrada', eMarcaBaja?.message);
    const rNueva = await R.guardarRegla(trx, TENANT, quien, { supplier_code: P.code, scope: 'corporate', pattern: 'weekdays', weekdays: [2, 4] });
    check('la baja libera el alcance: entra una regla corporativa NUEVA (otro id)', rNueva.accion === 'creada' && rNueva.id !== r1.id, rNueva);

    // 9 · `[PQ.3.6]` El alcance por sucursal, con las sucursales y zonas REALES de la base.
    if (rSuc && rZona) {
      const suc = conZona.branch_code;
      const otra = sucursales.find((x) => x.branch_code !== suc && x.zona_code !== conZona.zona_code)?.branch_code
        ?? sucursales.find((x) => x.branch_code !== suc).branch_code;
      const deLaZona = sucursales.filter((x) => x.zona_code === conZona.zona_code).map((x) => x.branch_code);
      const calSuc = await leerCalendario([suc]);
      const ids = calSuc.reglas.map((r) => r.id);
      check(`quien ve sólo ${suc} ve su regla de sucursal, no la corporativa ${deLaZona.length > 1 ? 'ni la de su zona' : ''}; el resumen cuenta sólo ésas y lo dice`,
        ids.includes(rSuc.id) && !ids.includes(rNueva.id) && (deLaZona.length === 1 || !ids.includes(rZona.id))
        && Object.values(calSuc.resumen).reduce((a, b) => a + b, 0) === calSuc.reglas.length
        && calSuc.tu_alcance.todas === false && JSON.stringify(calSuc.tu_alcance.sucursales) === JSON.stringify([suc]),
        { ids, tu_alcance: calSuc.tu_alcance });
      const calZona = await leerCalendario(deLaZona);
      check(`quien ve la zona ${conZona.zona_code} (${deLaZona.join(',')}) ve la regla de zona y la de su sucursal, no la corporativa`,
        calZona.reglas.some((r) => r.id === rZona.id) && calZona.reglas.some((r) => r.id === rSuc.id) && !calZona.reglas.some((r) => r.id === rNueva.id),
        calZona.reglas.map((r) => r.alcance_nombre));
      const calTodo = await leerCalendario(null);
      check('quien ve todo (null) ve las tres y lo dice', [rSuc.id, rZona.id, rNueva.id].every((i) => calTodo.reglas.some((r) => r.id === i)) && calTodo.tu_alcance.todas === true,
        calTodo.tu_alcance);

      const deOtra = { ...quien, escribe: [otra] };
      const deSuc = { ...quien, escribe: [suc] };
      const marcasAntes = await trx('commercial.purchase_review_marks').where({ rule_id: rSuc.id }).count({ n: '*' }).first();
      const eMarca = await errorDe(trx, () => R.marcar(trx, TENANT, deOtra, rSuc.id, { review_date: hoy, outcome: 'ordered_outside_kepler' }));
      const marcasDespues = await trx('commercial.purchase_review_marks').where({ rule_id: rSuc.id }).count({ n: '*' }).first();
      check(`marcar la regla de ${suc} con alcance de ${otra} → fuera_de_alcance, sin escribir («${eMarca?.message}»)`,
        eMarca?.tipo === 'fuera_de_alcance' && Number(marcasAntes.n) === Number(marcasDespues.n), { e: eMarca?.message, marcasAntes, marcasDespues });
      const mOk = await R.marcar(trx, TENANT, deSuc, rSuc.id, { review_date: hoy, outcome: 'ordered_outside_kepler' });
      check(`marcar la regla de ${suc} con SU alcance → creada`, mOk.accion === 'creada', mOk);
      const eCorp = await errorDe(trx, () => R.marcar(trx, TENANT, deSuc, rNueva.id, { review_date: hoy, outcome: 'ordered_outside_kepler' }));
      check('la sucursal no marca la regla corporativa → fuera_de_alcance', eCorp?.tipo === 'fuera_de_alcance', eCorp?.message);
      const eFc = await errorDe(trx, () => R.fueraDeCiclo(trx, TENANT, deOtra, rSuc.id, { hasta: sumar(hoy, 10), motivo: 'x' }));
      const eBj = await errorDe(trx, () => R.darDeBaja(trx, TENANT, deOtra, rSuc.id));
      const sigueViva = await trx('commercial.purchase_review_rules').where({ id: rSuc.id }).first('deleted_at', 'out_of_cycle_until');
      check('sacar del ciclo o dar de baja fuera de su alcance → fuera_de_alcance, y la regla queda igual',
        eFc?.tipo === 'fuera_de_alcance' && eBj?.tipo === 'fuera_de_alcance' && sigueViva.deleted_at === null && sigueViva.out_of_cycle_until === null, { eFc: eFc?.message, eBj: eBj?.message, sigueViva });
      const P3 = (await trx('catalog.suppliers').where({ tenant_id: TENANT }).whereNull('deleted_at').whereNotNull('code').whereNotIn('code', [P.code, P2.code])
        .whereRaw(`btrim(code) <> ''`).orderBy('code').first('code'))?.code;
      if (P3) {
        const eDef = await errorDe(trx, () => R.guardarRegla(trx, TENANT, deSuc, { supplier_code: P3, scope: 'corporate', pattern: 'weekdays', weekdays: [1] }));
        const nuevas = await trx('commercial.purchase_review_rules').where({ tenant_id: TENANT, supplier_code: P3 }).whereNull('deleted_at').count({ n: '*' }).first();
        check('definir una regla corporativa con alcance de una sucursal → fuera_de_alcance, sin fila nueva', eDef?.tipo === 'fuera_de_alcance' && Number(nuevas.n) === 0, { e: eDef?.message, nuevas });
      } else {
        NM('no hay un tercer proveedor para probar definir fuera de alcance');
      }
      const eSinAlcance = await errorDe(trx, () => R.marcar(trx, TENANT, { userId: usuario.id, username: null }, rSuc.id, { review_date: hoy, outcome: 'ordered_outside_kepler' }));
      const eLeerSin = await errorDe(trx, () => R.leerCalendario(trx, TENANT));
      check('PRUEBA NEGATIVA: sin alcance dicho no se adivina «todas»: escribir y leer fallan',
        !!eSinAlcance && /sin alcance/.test(eSinAlcance.message) && !!eLeerSin && /sin alcance/.test(eLeerSin.message), { e1: eSinAlcance?.message, e2: eLeerSin?.message });
    } else {
      NM('el alcance por sucursal: sin reglas de sucursal y zona en esta base');
    }

    // 8 · Propuestas de Kepler.
    const hayVista = (await trx.raw(`SELECT to_regclass('commercial.v_purchase_calendar_proposal') IS NOT NULL AS ok`)).rows[0].ok;
    if (hayVista) {
      const causas = {};
      const prop = await R.leerPropuestas(trx, TENANT, (e, que) => { causas[que] = e; });
      const causa = causas.dia_fijo ?? null;
      check('las propuestas no traen a quien ya tiene regla', !prop.sin_regla.some((p) => p.supplier_code === P.code), prop.sin_regla.length);
      // [PQ.3.14] El día fijo por sucursal: con el ODS de Kepler se mide; sin él, se DECLARA no medido (con su nota y
      // la causa a quien llama), la consulta va en un SAVEPOINT y la transacción sigue viva para lo que viene.
      check(`[PQ.3.14] el día fijo se declara: measured = ${actividadOk} (la base ${actividadOk ? 'tiene' : 'no tiene'} la actividad de Kepler)`,
        prop.dia_fijo && prop.dia_fijo.measured === actividadOk
          && (actividadOk ? prop.dia_fijo.note === null && causa === null : !!prop.dia_fijo.note && !!causa)
          && prop.sin_regla.every((p) => Array.isArray(p.dias_fijos) && (actividadOk || p.dias_fijos.length === 0)),
        { dia_fijo: prop.dia_fijo, causa: causa && causa.message });
      check('[PQ.3.14] las dos listas con las columnas reales: «sin regla» = 0 reglas vivas; «pendiente» = con regla y con día fijo por definir',
        prop.sin_regla.every((p) => p.reglas_vivas === 0) && Array.isArray(prop.dia_fijo_pendiente)
          && prop.dia_fijo_pendiente.every((p) => p.reglas_vivas > 0 && p.dias_fijos.length > 0),
        { sin: prop.sin_regla.length, pendiente: prop.dia_fijo_pendiente.length });
      const viva = await trx.raw('SELECT 1 AS ok').then((r) => r.rows[0].ok === 1).catch(() => false);
      check('[PQ.3.14] tras leer el día fijo la transacción sigue viva (el fallo, si lo hubo, quedó en su SAVEPOINT)', viva, viva);
      if (actividadOk) {
        const conDia = prop.sin_regla.filter((p) => p.dias_fijos.length);
        console.log(`  · ${conDia.length} proveedores sin regla con día fijo en alguna sucursal`);
      }

      // [PQ.3.18] El embudo de llenado: se DECLARA, cuadra contra una consulta independiente y ordena por escalón.
      const E = prop.embudo;
      const lista = [...prop.sin_regla, ...prop.dia_fijo_pendiente];
      if (E && E.measured) {
        const vistaConRegla = Number((await trx.raw(`
          SELECT count(*) AS n FROM commercial.v_purchase_calendar_proposal v
           WHERE EXISTS (SELECT 1 FROM commercial.purchase_review_rules r
                          WHERE r.tenant_id = ? AND r.supplier_code = v.supplier_code AND r.deleted_at IS NULL)`, [TENANT])).rows[0].n);
        check('[PQ.3.18] el embudo cuadra: proveedores = sin regla + con regla; con regla = la vista con regla viva (consulta independiente); los escalones suman el total',
          E.total.proveedores === prop.sin_regla.length + prop.con_regla && E.total.con_regla === vistaConRegla
            && E.escalones.length === 3 && E.escalones.reduce((a, e) => a + e.proveedores, 0) === E.total.proveedores
            && E.escalones.reduce((a, e) => a + e.con_regla, 0) === E.total.con_regla && causas.compra === undefined,
          { total: E.total, vistaConRegla, escalones: E.escalones.map((e) => [e.escalon, e.proveedores, e.con_regla]) });
        const enOrden = lista.every((p, i) => p.peso && [1, 2, 3].includes(p.peso.escalon)
          && (i === 0 || i === prop.sin_regla.length || lista[i - 1].peso.escalon < p.peso.escalon
            || (lista[i - 1].peso.escalon === p.peso.escalon && lista[i - 1].peso.compra_pct >= p.peso.compra_pct)));
        check('[PQ.3.18] cada propuesta trae su peso y la lista va por escalón y luego por lo que pesa en la compra', enOrden,
          lista.slice(0, 5).map((p) => [p.supplier_code, p.peso]));
        // PRUEBA NEGATIVA: definir una regla la suma al avance; darla de baja la saca (el avance vuelve a lo de antes).
        const primero = prop.sin_regla.find((p) => p.peso && p.peso.compra_pct > 0);
        if (primero) {
          const r1 = await R.guardarRegla(trx, TENANT, quien, { supplier_code: primero.supplier_code, scope: 'corporate', pattern: 'weekdays', weekdays: [2] });
          const conRegla = (await R.leerPropuestas(trx, TENANT)).embudo.total;
          await R.darDeBaja(trx, TENANT, quien, r1.id);
          const deBaja = (await R.leerPropuestas(trx, TENANT)).embudo.total;
          check(`[PQ.3.18] PRUEBA NEGATIVA: con la regla de ${primero.supplier_code} el avance sube 1 (y ${primero.peso.compra_pct} % de la compra); dada de baja, vuelve a lo de antes`,
            conRegla.con_regla === E.total.con_regla + 1 && Math.abs(conRegla.compra_con_regla_pct - E.total.compra_con_regla_pct - primero.peso.compra_pct) <= 0.2
              && deBaja.con_regla === E.total.con_regla && deBaja.compra_con_regla_pct === E.total.compra_con_regla_pct,
            { antes: E.total, conRegla, deBaja });
        } else {
          NM('[PQ.3.18] la prueba negativa del avance: ninguna propuesta con compra en 12 meses en esta base');
        }
      } else {
        check('[PQ.3.18] sin la compra de 12 meses el embudo se DECLARA no medido, con nota y la causa a quien llama; nadie trae peso',
          !!E && E.measured === false && !!E.note && !!causas.compra && lista.every((p) => p.peso === null), { embudo: E, causa: causas.compra && causas.compra.message });
      }
      const viva2 = await trx.raw('SELECT 1 AS ok').then((r) => r.rows[0].ok === 1).catch(() => false);
      check('[PQ.3.18] tras leer la compra de 12 meses la transacción sigue viva (el fallo, si lo hubo, quedó en su SAVEPOINT)', viva2, viva2);

      // [PQ.3.18] (c) Los ocasionales en bloque (DC27), con el payload de la pantalla: las claves que ella muestra en el escalón 3.
      const propC = await R.leerPropuestas(trx, TENANT);
      const ocas = propC.sin_regla.filter((p) => p.peso && p.peso.escalon === 3).map((p) => p.supplier_code);
      if (sembroOcasional && propC.embudo.measured && ocas.includes(OCAS)) {
        const reglasDe = async (code) => Number((await trx('commercial.purchase_review_rules')
          .where({ tenant_id: TENANT, supplier_code: code }).whereNull('deleted_at').count({ n: '*' }).first()).n);
        const noOcas = propC.sin_regla.find((p) => p.peso && p.peso.escalon !== 3)?.supplier_code ?? P.code;
        const noOcasAntes = await reglasDe(noOcas);
        const eVacio = await errorDe(trx, () => R.definirOcasionales(trx, TENANT, quien, { supplier_codes: [] }));
        const unaSuc = sucursales.find((x) => x.zona_code)?.branch_code ?? '01';
        const eAlcance = await errorDe(trx, () => R.definirOcasionales(trx, TENANT, { ...quien, escribe: [unaSuc] }, { supplier_codes: [OCAS] }));
        // Sin NINGÚN ocasional en la lista no se llega a guardar nada: el alcance se exige igual, antes (si no, 200 con todo omitido).
        const eAlcance2 = await errorDe(trx, () => R.definirOcasionales(trx, TENANT, { ...quien, escribe: [unaSuc] }, { supplier_codes: [noOcas] }));
        check(`[PQ.3.18] (c) sin proveedores → invalida («${eVacio?.message}»); con alcance de una sucursal → fuera_de_alcance, también si la lista no trae ningún ocasional; nada escrito`,
          eVacio?.tipo === 'invalida' && eAlcance?.tipo === 'fuera_de_alcance' && eAlcance2?.tipo === 'fuera_de_alcance' && (await reglasDe(OCAS)) === 0,
          { e1: eVacio?.message, e2: eAlcance?.message, e3: eAlcance2?.message ?? 'sin error' });
        const r = await R.definirOcasionales(trx, TENANT, quien, { supplier_codes: [OCAS, noOcas] });
        const fila = await trx('commercial.purchase_review_rules').where({ tenant_id: TENANT, supplier_code: OCAS }).whereNull('deleted_at')
          .first('scope', 'pattern', 'every_n_days', 'out_of_cycle_reason', 'created_by', trx.raw(`to_char(out_of_cycle_until, 'YYYY-MM-DD') AS hasta`));
        check(`[PQ.3.18] (c) define al ocasional: corporativa «cada 180 días», fuera de ciclo hasta ${sumar(hoy, 182)} con motivo y con quién; ${noOcas} queda omitida con su motivo`,
          r.definidas === 1 && r.hasta === sumar(hoy, 182) && r.omitidas.length === 1 && r.omitidas[0].supplier_code === noOcas && !!r.omitidas[0].motivo
            && !!fila && fila.scope === 'corporate' && fila.pattern === 'every_n_days' && Number(fila.every_n_days) === 180 && fila.hasta === r.hasta
            && /Ocasional/.test(fila.out_of_cycle_reason ?? '') && String(fila.created_by) === String(usuario.id),
          { r, fila });
        check(`[PQ.3.18] (c) PRUEBA NEGATIVA: la clave que NO es ocasional (${noOcas}) no recibió regla nueva aunque vino en la lista`,
          (await reglasDe(noOcas)) === noOcasAntes, { antes: noOcasAntes, despues: await reglasDe(noOcas) });
        const r2 = await R.definirOcasionales(trx, TENANT, quien, { supplier_codes: [OCAS] });
        check('[PQ.3.18] (c) otra vez con la misma clave: ya tiene regla → omitida, sin duplicar ni reemplazar',
          r2.definidas === 0 && r2.omitidas.length === 1 && (await reglasDe(OCAS)) === 1, r2);
        const enCal = (await leerCalendario(null)).reglas.find((x) => x.supplier_code === OCAS);
        check('[PQ.3.18] (c) en el calendario sale «fuera de ciclo» con su fecha de regreso: no amanece rezagado',
          enCal?.estado.estado === 'fuera_de_ciclo' && enCal?.out_of_cycle_until === r.hasta, enCal && { estado: enCal.estado, hasta: enCal.out_of_cycle_until });
      } else {
        NM(`[PQ.3.18] (c) los ocasionales en bloque: ${!sembroOcasional ? 'no se pudo sembrar el ocasional en kepler_ods.kdm1' : !propC.embudo.measured ? 'el embudo no se midió' : 'el ocasional sembrado no salió en el escalón 3'}`);
      }
    } else {
      NM('la vista commercial.v_purchase_calendar_proposal no existe en esta base (PQ.3.1 sin fuente)');
    }
  } finally {
    await trx.rollback();
    await knex.destroy();
  }
  console.log(`\n  ${ok} ✓ · ${ko} ✗ · ${nm} ○ NO MEDIDO`);
  if (ko) process.exit(1);
});
