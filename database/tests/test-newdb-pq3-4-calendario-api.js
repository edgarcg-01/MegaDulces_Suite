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
 *  8. Las propuestas de Kepler no traen a quien ya tiene regla.
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
      rZona = await R.guardarRegla(trx, TENANT, quien, { supplier_code: P2.code, scope: 'zone', zone_code: conZona.zona_code, pattern: 'every_n_days', every_n_days: 14, reviewer_user_id: usuario.id });
      check(`el MISMO proveedor con regla corporativa y de sucursal (${conZona.branch_code}); otra de zona (${conZona.zona_code}) con quién revisa`,
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
      check('la regla de zona dice su zona y la persona que revisa', !!z && z.alcance_nombre.startsWith('Zona ') && z.revisa === usuario.nombre, z && { alcance: z.alcance_nombre, revisa: z.revisa });
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
      const prop = await R.leerPropuestas(trx, TENANT);
      check('las propuestas no traen a quien ya tiene regla', !prop.sin_regla.some((p) => p.supplier_code === P.code), prop.sin_regla.length);
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
