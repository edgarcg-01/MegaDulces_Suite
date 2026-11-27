#!/usr/bin/env node
/**
 * [PQ.3.10] Acuerdos · C2 — la API de los acuerdos con el proveedor contra Postgres real: el repositorio y el servicio
 * REALES (ts-node) escribiendo como `app_runtime` con el tenant puesto, con el payload que manda la pantalla (regla 13:
 * un endpoint que escribe no está probado hasta que una prueba lo ejerció contra base real). Las reuniones se arman con
 * el servicio REAL de Citas (agendar + minuta), no a mano.
 *
 * ── QUÉ AFIRMA ───────────────────────────────────────────────────────────────────────────
 *  1. Capturar de una reunión REALIZADA: el de Mercadotecnia con su responsable; el del proveedor con el nombre de su
 *     persona y el ORGANIZADOR como responsable (DC43, lo pone el servidor); quien captura queda como quien asignó.
 *  2. NEGATIVAS sin guardar nada: reunión agendada (409), cancelada (409), inexistente (404); responsable sin acceso a
 *     Citas (400), que sólo VE Citas como Dirección (400: no podría cerrar el suyo, DC44), inactivo (400); otro
 *     responsable en el del proveedor (400); fecha antes de la reunión (400); del proveedor sin su persona (400). La llave
 *     POR PERSONA sí cuenta.
 *  3. Editar: reasignar deja quién y cuándo (`assigned_by`, `assigned_at`); editar sin reasignar no los toca; quien ya
 *     era responsable se conserva aunque haya perdido la llave, pero un responsable NUEVO sin llave = 400.
 *  4. Iniciar (dos veces = 409) · cumplir (sin nota = 400; con nota, final con quién, cuándo y nota) · cancelar; cerrado
 *     no se edita, no se inicia ni se vuelve a cerrar (409).
 *  5. La lista: abiertos con lo vencido primero; los conteos por situación de la BASE = la `situacion()` del dominio en
 *     las fronteras (ayer, hoy, +6, +7); los cerrados, lo más recién cerrado arriba.
 *  6. La reunión: sus acuerdos, si recibe más (la agendada dice por qué no) y lo abierto con el MISMO proveedor de otras
 *     reuniones (no lo cerrado, no el de otro proveedor).
 *  7. RLS: con otro tenant, la reunión no existe (404), la lista no los trae y sin filtro no se ven.
 *  9. «Mi trabajo» (`FUENTES_VISIBLES` de `me-tasks.ts`, ejecutada aquí): los abiertos de una persona, los vencidos con la
 *     fecha de México (lo que vence HOY no cuenta) y el vencimiento más próximo al mediodía de ese día.
 *  8. `design:paramtypes` del servicio, emitido por TypeScript: lo que Nest inyecta en producción (#414).
 *
 * Todo dentro de una transacción que se REVIERTE: no deja filas. ⚠️ Sin las tablas (migraciones 20261125203927 y
 * 20261126232231 sin aplicar) sale con 2 = NO MEDIDO, nunca ✔.
 * ⛔ Escribe (aunque revierta): exige `assert-safe-target`, nunca contra producción.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-pq3-10-acuerdos-api');
const { noMedido, correr } = require('./_lib/no-medido');

const RAIZ = path.resolve(__dirname, '..', '..');
let A;
let SA;
let SC;
let MT;
try {
  require('reflect-metadata');
  require('ts-node').register({ transpileOnly: true, skipProject: true,
    compilerOptions: { module: 'commonjs', moduleResolution: 'node', target: 'es2021', experimentalDecorators: true, emitDecoratorMetadata: true, ignoreDeprecations: '6.0' } });
  const tsc = require('typescript');
  const base = tsc.readConfigFile(path.join(RAIZ, 'tsconfig.base.json'), tsc.sys.readFile).config;
  require('tsconfig-paths').register({ baseUrl: RAIZ, paths: base.compilerOptions.paths });
  A = require(path.join(RAIZ, 'libs/commercial/src/lib/supplier-agreements/supplier-agreements.domain.ts'));
  SA = require(path.join(RAIZ, 'libs/commercial/src/lib/supplier-agreements/supplier-agreements.service.ts'));
  SC = require(path.join(RAIZ, 'libs/commercial/src/lib/supplier-meetings/supplier-meetings.service.ts'));
  MT = require(path.join(RAIZ, 'libs/trade/src/lib/users/me-tasks.ts'));
} catch (e) {
  noMedido(`no se pudo cargar el repositorio con ts-node: ${e.message}`);
}
const knex = require('knex')(require('../knexfile-newdb.js').development);
const TENANT = '00000000-0000-0000-0000-00000000d01c';
const OTRO = '00000000-0000-0000-0000-0000000000aa';

let ok = 0;
let ko = 0;
const check = (desc, cond, detalle) => {
  if (cond) { ok += 1; console.log(`  ✓ ${desc}`); }
  else { ko += 1; console.log(`  ✗ ${desc}${detalle !== undefined ? `  → ${JSON.stringify(detalle)}` : ''}`); }
};

correr(async () => {
  console.log('\n[PQ.3.10] Acuerdos · la API de los acuerdos con el proveedor — Postgres real\n');
  const hay = (await knex.raw(`SELECT to_regclass('commercial.supplier_meetings') IS NOT NULL
                                    AND to_regclass('commercial.supplier_agreements') IS NOT NULL AS ok`)).rows[0].ok;
  if (!hay) { await knex.destroy(); noMedido('commercial.supplier_meetings / supplier_agreements no existen (migraciones 20261125203927 / 20261126232231 sin aplicar)'); return; }

  // 8. Lo que Nest inyecta: el `design:paramtypes` que emite TypeScript, no el que uno supone.
  const tipos = (Reflect.getMetadata('design:paramtypes', SA.SupplierAgreementsService) || []).map((t) => t && t.name);
  check('design:paramtypes del servicio = [TenantKnexService, TenantContextService]', JSON.stringify(tipos) === JSON.stringify(['TenantKnexService', 'TenantContextService']), tipos);

  const trx = await knex.transaction();
  try {
    await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);
    const hoy = (await trx.raw(`SELECT to_char((now() AT TIME ZONE 'America/Mexico_City')::date, 'YYYY-MM-DD') AS d`)).rows[0].d;
    const sumar = (f, n) => { const d = new Date(`${f}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

    // ── Lo que hay antes (como dueño): roles, personas y proveedores de prueba ─────────────────────────────────────
    const rol = async (role_name, permissions) => trx('identity.role_permissions').insert({ tenant_id: TENANT, role_name, permissions });
    await rol('pq310_agenda', { COMPRAS_CITAS_AGENDAR: true });
    await rol('pq310_ver', { COMPRAS_CITAS_VER: true });
    await rol('pq310_sin', { COMPRAS_CALENDARIO_VER: true });
    // password_hash: el CHECK lo pide; no es un hash bcrypt, así que nadie entra con él (y todo se revierte).
    const persona = async (username, nombre, role_name, activo = true) => {
      const [u] = await trx('identity.users').insert({ tenant_id: TENANT, username, nombre, role_name, activo, password_hash: '!sin-acceso-prueba' }).returning('id');
      return u.id ?? u;
    };
    const ANA = await persona('pq310_ana', 'Prueba Ana Compras', 'pq310_agenda');
    const MARI = await persona('pq310_mari', 'Prueba Mari Compras', 'pq310_agenda');
    const LUIS = await persona('pq310_luis', 'Prueba Luis Mercadotecnia', 'pq310_agenda');
    const DIRE = await persona('pq310_dire', 'Prueba Dirección', 'pq310_ver'); // sólo VE Citas, como Dirección
    const PEPE = await persona('pq310_pepe', 'Prueba Pepe Tienda', 'pq310_sin');
    const LETY = await persona('pq310_lety', 'Prueba Lety Tesorería', 'pq310_sin');
    const BAJA = await persona('pq310_baja', 'Prueba Baja', 'pq310_agenda', false);
    // La llave POR PERSONA cuenta (permisoEfectivoSql): Lety no la tiene por rol, sí por persona.
    await trx('identity.user_permissions').insert({ tenant_id: TENANT, user_id: LETY, permission_key: 'COMPRAS_CITAS_AGENDAR', allow: true });
    await trx('catalog.suppliers').insert({ tenant_id: TENANT, code: 'PQ310A', name: 'PRUEBA ACUERDOS DULCERIA ALFA' });
    await trx('catalog.suppliers').insert({ tenant_id: TENANT, code: 'PQ310B', name: 'PRUEBA ACUERDOS BETA' });

    // ── Desde aquí, el rol de producción ────────────────────────────────────────────────────────────────────────
    await trx.raw('SET LOCAL ROLE app_runtime');
    const ana = { userId: ANA, username: 'pq310_ana' };
    const mari = { userId: MARI, username: 'pq310_mari' };
    const run = { run: (fn) => fn(trx) };
    const svc = new SA.SupplierAgreementsService(run, { requireTenantId: () => TENANT });
    const citas = new SC.SupplierMeetingsService(run, { requireTenantId: () => TENANT });
    /** El código HTTP con que rechaza el servicio (en un SAVEPOINT: un rechazo no deja nada a medias). */
    const rechazo = async (f) => {
      await trx.raw('SAVEPOINT rechazo');
      try { await f(); await trx.raw('RELEASE SAVEPOINT rechazo'); return 'ok'; } catch (e) {
        await trx.raw('ROLLBACK TO SAVEPOINT rechazo');
        return `${e.getStatus ? e.getStatus() : 'crudo'} ${e.message}`;
      }
    };
    const cuantos = async () => Number((await trx.raw(`SELECT count(*) n FROM commercial.supplier_agreements a
      JOIN commercial.supplier_meetings m ON m.tenant_id = a.tenant_id AND m.id = a.meeting_id WHERE m.supplier_code LIKE 'PQ310%'`)).rows[0].n);

    // Las reuniones, con el servicio REAL de Citas: Ana organiza.
    const reunion = (supplier_code, date, start_time = '10:00', end_time = '11:00') => citas.agendar(ana, {
      supplier_code, kind: 'executive', date, start_time, end_time, mode: 'in_person', location: null, topics: ['Precios'],
      work_plan_year: null, participants: [{ side: 'internal', user_id: ANA, area: 'compras' }, { side: 'internal', user_id: LUIS, area: 'marketing' }],
    });
    const R1D = sumar(hoy, -3);
    const R1 = (await reunion('PQ310A', R1D)).id;
    await citas.minuta(ana, R1, { minutes: 'Se revisaron precios y la exhibición de diciembre.' });
    const R0 = (await reunion('PQ310A', sumar(hoy, -10))).id;              // la anterior con el mismo proveedor
    await citas.minuta(ana, R0, { minutes: 'Primera reunión.' });
    const RB = (await reunion('PQ310B', sumar(hoy, -3), '12:00', '13:00')).id; // otro proveedor
    await citas.minuta(ana, RB, { minutes: 'Otro proveedor.' });
    const RAG = (await reunion('PQ310A', sumar(hoy, 5))).id;               // agendada: todavía no recibe
    const RCA = (await reunion('PQ310A', sumar(hoy, 6))).id;               // cancelada: nunca recibe
    await citas.cancelar(ana, RCA, { reason: 'El ejecutivo no pudo' });

    // 1. Capturar, con el payload de la pantalla.
    const mkt = await svc.capturar(ana, R1, { area: 'marketing', description: '  Armar la exhibición de diciembre  ', due_date: sumar(hoy, 10), assigned_to: LUIS, supplier_contact: null });
    const prov = await svc.capturar(ana, R1, { area: 'supplier', description: 'Mandar la lista de precios 2027', due_date: hoy, assigned_to: null, supplier_contact: '  Ejecutivo de ventas  ' });
    check('capturar: regresa el id (los dos)', !!mkt.id && !!prov.id, [mkt, prov]);
    const fila = async (id) => (await trx.raw(`SELECT area, description, supplier_contact, assigned_to::text, assigned_by::text, assigned_at,
        to_char(due_date, 'YYYY-MM-DD') due_date, status, created_by, updated_by, closed_at, closed_by::text, closing_note
      FROM commercial.supplier_agreements WHERE id = ?`, [id])).rows[0];
    const f1 = await fila(mkt.id);
    check('el de Mercadotecnia: texto limpio, responsable Luis, asignó y creó Ana, pendiente', f1.description === 'Armar la exhibición de diciembre'
      && f1.assigned_to === LUIS && f1.assigned_by === ANA && f1.created_by === ANA && f1.status === 'pending' && f1.supplier_contact === null, f1);
    const f2 = await fila(prov.id);
    check('el del proveedor: su persona guardada y el ORGANIZADOR (Ana) como responsable (DC43)', f2.supplier_contact === 'Ejecutivo de ventas' && f2.assigned_to === ANA && f2.area === 'supplier', f2);

    // 2. Negativas: nada se guarda.
    const antes = await cuantos();
    const base = (o = {}) => ({ area: 'compras', description: 'Revisar el mínimo de compra', due_date: sumar(hoy, 3), assigned_to: MARI, supplier_contact: null, ...o });
    const n1 = await rechazo(() => svc.capturar(ana, RAG, base()));
    check('reunión agendada (sin minuta): 409 y dice por qué', /^409 Los acuerdos salen de una reunión realizada/.test(n1), n1);
    const n2 = await rechazo(() => svc.capturar(ana, RCA, base()));
    check('reunión cancelada: 409', /^409 La reunión está cancelada/.test(n2), n2);
    const n2b = await rechazo(() => svc.capturar(ana, RCA, base({ assigned_to: BAJA })));
    check('reunión cancelada con un responsable inactivo: el motivo es la reunión (409), no el responsable', /^409 La reunión está cancelada/.test(n2b), n2b);
    const n3 = await rechazo(() => svc.capturar(ana, '11111111-1111-4111-8111-111111111111', base()));
    check('reunión que no existe: 404', /^404 La reunión no existe/.test(n3), n3);
    const n4 = await rechazo(() => svc.capturar(ana, R1, base({ assigned_to: PEPE })));
    check('responsable sin acceso a Citas: 400', /^400 El responsable tiene que agendar Citas: cada responsable cierra el suyo/.test(n4), n4);
    const n4b = await rechazo(() => svc.capturar(ana, R1, base({ area: 'direccion', assigned_to: DIRE })));
    check('responsable que sólo VE Citas (Dirección): 400 — no podría cerrar el suyo (DC44)', /^400 El responsable tiene que agendar Citas/.test(n4b), n4b);
    const n5 = await rechazo(() => svc.capturar(ana, R1, base({ assigned_to: BAJA })));
    check('responsable inactivo: 400', /^400 Esa persona ya no está activa/.test(n5), n5);
    const n6 = await rechazo(() => svc.capturar(ana, R1, base({ area: 'supplier', supplier_contact: 'Ejecutivo', assigned_to: LUIS })));
    check('el del proveedor con otro responsable: 400 (no se cambia en silencio)', /^400 El acuerdo del proveedor lo sigue quien organizó/.test(n6), n6);
    const n7 = await rechazo(() => svc.capturar(ana, R1, base({ due_date: sumar(R1D, -1) })));
    check('fecha compromiso antes de la reunión: 400', /^400 La fecha compromiso no puede ser antes de la reunión/.test(n7), n7);
    const n8 = await rechazo(() => svc.capturar(ana, R1, base({ area: 'supplier', assigned_to: null })));
    check('el del proveedor sin su persona: 400', /^400 Escribe el nombre de la persona del proveedor/.test(n8), n8);
    check('…y ninguno guardó nada', (await cuantos()) === antes, { antes, despues: await cuantos() });
    const fin = await svc.capturar(ana, R1, base({ area: 'finanzas', description: 'Revisar el plazo de pago', assigned_to: LETY, due_date: sumar(hoy, -1) }));
    check('la llave POR PERSONA cuenta (Lety, de Finanzas)', (await fila(fin.id)).assigned_to === LETY);

    // 3. Editar. En una transacción now() no avanza: la hora de asignación se lleva un día atrás (como dueño) para que
    // «no cambia» y «sí cambia» se puedan distinguir.
    await trx.raw('RESET ROLE');
    await trx('commercial.supplier_agreements').where({ id: mkt.id }).update({ assigned_at: trx.raw(`now() - interval '1 day'`) });
    await trx.raw('SET LOCAL ROLE app_runtime');
    const a0 = (await fila(mkt.id)).assigned_at;
    await svc.editar(mari, mkt.id, { area: 'marketing', description: 'Armar la exhibición de diciembre (dos cabeceras)', due_date: sumar(hoy, 12), assigned_to: LUIS });
    const e1 = await fila(mkt.id);
    check('editar sin reasignar: cambia texto y fecha; quien asignó y cuándo NO cambian; queda quién editó', e1.description === 'Armar la exhibición de diciembre (dos cabeceras)'
      && e1.due_date === sumar(hoy, 12) && e1.assigned_by === ANA && String(e1.assigned_at) === String(a0) && e1.updated_by === MARI, e1);
    await svc.editar(mari, mkt.id, { area: 'finanzas', description: 'Revisar la exhibición con Finanzas', due_date: sumar(hoy, 12), assigned_to: LETY });
    const e2 = await fila(mkt.id);
    check('reasignar: el responsable nuevo, quién reasignó (Mari) y la hora de asignación se renueva', e2.assigned_to === LETY && e2.assigned_by === MARI && e2.area === 'finanzas'
      && String(e2.assigned_at) !== String(a0), [e2.assigned_to, e2.assigned_by, String(e2.assigned_at), String(a0)]);
    // Lety pierde la llave (la quita el dueño): sigue siendo responsable al editar, pero no se le asigna uno nuevo.
    await trx.raw('RESET ROLE');
    await trx('identity.user_permissions').where({ tenant_id: TENANT, user_id: LETY }).update({ allow: false });
    await trx.raw('SET LOCAL ROLE app_runtime');
    const n9 = await rechazo(() => svc.editar(mari, mkt.id, { area: 'finanzas', description: 'Revisar la exhibición con Finanzas y Compras', due_date: sumar(hoy, 12), assigned_to: LETY }));
    check('quien ya era responsable se conserva aunque haya perdido la llave', n9 === 'ok', n9);
    const n10 = await rechazo(() => svc.capturar(ana, R1, base({ assigned_to: LETY })));
    check('…pero un acuerdo NUEVO para quien ya no agenda Citas: 400', /^400 El responsable tiene que agendar Citas/.test(n10), n10);
    const n11 = await rechazo(() => svc.editar(mari, prov.id, { area: 'supplier', description: 'Mandar la lista', due_date: hoy, assigned_to: MARI, supplier_contact: 'Ejecutivo' }));
    check('editar el del proveedor para dárselo a otro: 400', /^400 El acuerdo del proveedor lo sigue quien organizó/.test(n11), n11);
    const n12 = await rechazo(() => svc.editar(mari, '11111111-1111-4111-8111-111111111111', base()));
    check('editar un acuerdo que no existe: 404', /^404 El acuerdo no existe/.test(n12), n12);

    // 4. Iniciar, cumplir y cancelar.
    await svc.iniciar(ana, prov.id);
    check('iniciar: en curso', (await fila(prov.id)).status === 'in_progress');
    const n13 = await rechazo(() => svc.iniciar(ana, prov.id));
    check('iniciar dos veces: 409', /^409 El acuerdo ya está en curso/.test(n13), n13);
    const n14 = await rechazo(() => svc.cumplir(ana, prov.id, { note: '   ' }));
    check('cumplir sin nota: 400', /^400 Escribe la nota de cierre/.test(n14), n14);
    await svc.cumplir(mari, prov.id, { note: '  Llegó la lista el viernes.  ' });
    const c1 = await fila(prov.id);
    check('cumplido: con nota limpia, quién (Mari) y cuándo', c1.status === 'done' && c1.closing_note === 'Llegó la lista el viernes.' && c1.closed_by === MARI && !!c1.closed_at, c1);
    const n15 = await rechazo(() => svc.editar(ana, prov.id, { area: 'supplier', description: 'otra', due_date: hoy, supplier_contact: 'X' }));
    const n16 = await rechazo(() => svc.cancelar(ana, prov.id, { note: 'x' }));
    const n17 = await rechazo(() => svc.iniciar(ana, prov.id));
    check('cumplido no se edita, no se cancela ni se inicia: 409 las tres', [n15, n16, n17].every((x) => /^409 El acuerdo ya se cumplió/.test(x)), [n15, n16, n17]);
    await svc.cancelar(ana, fin.id, { note: 'Ya no procede: el proveedor cambió de plazo.' });
    const c2 = await fila(fin.id);
    check('cancelado: con nota y quién', c2.status === 'cancelled' && c2.closed_by === ANA && c2.closing_note === 'Ya no procede: el proveedor cambió de plazo.', c2);
    const n18 = await rechazo(() => svc.cumplir(ana, fin.id, { note: 'x' }));
    check('cancelado no se cumple después: 409', /^409 El acuerdo está cancelado/.test(n18), n18);
    // En una transacción `now()` no avanza: los dos se cerraron «a la misma hora». El cumplido se lleva dos horas atrás
    // (como dueño) para que el orden de los cerrados se pueda medir.
    await trx.raw('RESET ROLE');
    await trx('commercial.supplier_agreements').where({ id: prov.id }).update({ closed_at: trx.raw(`now() - interval '2 hours'`) });
    await trx.raw('SET LOCAL ROLE app_runtime');

    // 5. La lista: las fronteras de la situación.
    const F = { ayer: sumar(hoy, -1), hoy, mas6: sumar(hoy, 6), mas7: sumar(hoy, 7) };
    const ids = {};
    for (const [k, d] of Object.entries(F)) {
      ids[k] = (await svc.capturar(ana, R1, base({ description: `Frontera ${k}`, due_date: d }))).id;
    }
    const L = await svc.lista();
    const sit = (id) => L.abiertos.acuerdos.find((x) => x.id === id)?.situacion;
    check('situación en las fronteras: ayer vencido · hoy vence hoy · +6 esta semana · +7 al día',
      sit(ids.ayer) === 'vencido' && sit(ids.hoy) === 'vence_hoy' && sit(ids.mas6) === 'esta_semana' && sit(ids.mas7) === 'al_dia',
      Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, sit(id)])));
    const porDominio = { vencido: 0, vence_hoy: 0, esta_semana: 0, al_dia: 0 };
    for (const x of L.abiertos.acuerdos) porDominio[A.situacion(x, L.hoy)] += 1;
    check('los conteos de la BASE = la situación del dominio sobre las filas (mismas fronteras)', JSON.stringify(L.abiertos.por_situacion) === JSON.stringify(porDominio)
      && L.abiertos.total === L.abiertos.acuerdos.length, { base: L.abiertos.por_situacion, dominio: porDominio, total: L.abiertos.total });
    const rango = { vencido: 0, vence_hoy: 1, esta_semana: 2, al_dia: 3 };
    const rangos = L.abiertos.acuerdos.map((x) => rango[x.situacion]);
    check('abiertos en orden: lo vencido arriba, después hoy, la semana y al día', rangos.every((r, i) => i === 0 || rangos[i - 1] <= r), rangos);
    const vMkt = L.abiertos.acuerdos.find((x) => x.id === mkt.id);
    check('la vista: proveedor derivado de la reunión, día de la reunión, nombres y botones', vMkt && vMkt.supplier_code === 'PQ310A' && vMkt.supplier_name === 'PRUEBA ACUERDOS DULCERIA ALFA'
      && vMkt.meeting_date === R1D && vMkt.assigned_to.nombre === 'Prueba Lety Tesorería' && vMkt.assigned_by === 'Prueba Mari Compras'
      && JSON.stringify(vMkt.acciones) === JSON.stringify(['iniciar', 'cumplir', 'cancelar', 'editar']), vMkt);
    const misC = L.cerrados.acuerdos.filter((x) => x.id === prov.id || x.id === fin.id);
    check('cerrados: los dos, sin botones, con quién cerró y su nota', misC.length === 2 && misC.every((x) => x.acciones.length === 0 && !!x.closed_by && !!x.closing_note)
      && L.cerrados.total >= 2, misC.map((x) => [x.situacion, x.closed_by]));
    check('cerrados: lo más recién cerrado arriba (el cancelado de ahora antes que el cumplido de hace dos horas)',
      JSON.stringify(misC.map((x) => x.id)) === JSON.stringify([fin.id, prov.id]), misC.map((x) => [x.situacion, x.closed_at]));

    // 9. «Mi trabajo»: la fuente de me-tasks.ts, ejecutada contra esta base. Mari tiene las cuatro fronteras abiertas.
    const fuente = MT.FUENTES_VISIBLES.find((x) => x.fuente === 'commercial.supplier_agreements');
    const mw = fuente && await fuente.medir(trx, TENANT, MARI);
    check('Mi trabajo de Mari: 4 abiertos, 1 vencido (lo de HOY no cuenta), el más próximo al mediodía de México de ayer', !!mw && mw.total === 4 && mw.vencidas === 1
      && mw.vence_at === `${F.ayer}T18:00:00.000Z` && !!mw.mas_viejo_at, mw);
    check('…y la fuente lleva a Acuerdos con «Míos», con las llaves de Citas', fuente && fuente.ruta === '/compras/acuerdos' && fuente.queryParams.de === 'mios'
      && JSON.stringify([...fuente.anyOf].sort()) === JSON.stringify(['COMPRAS_CITAS_AGENDAR', 'COMPRAS_CITAS_VER']), fuente && [fuente.ruta, fuente.queryParams, fuente.anyOf]);

    // 6. La reunión.
    const D1 = await svc.deReunion(R1);
    check('reunión realizada: recibe, con su día y su organizador', D1.no_recibe === null && D1.meeting_date === R1D && D1.organizer.user_id === ANA, [D1.no_recibe, D1.meeting_date, D1.organizer]);
    check('sus acuerdos: los 7 (abiertos y cerrados), lo abierto primero', D1.acuerdos.length === 7 && D1.acuerdos.slice(-2).every((x) => ['cumplido', 'cancelado'].includes(x.situacion)), D1.acuerdos.map((x) => x.situacion));
    check('…y de otras reuniones con el mismo proveedor no hay abiertos (R0 no tiene)', D1.del_proveedor.total === 0, D1.del_proveedor);
    const DAG = await svc.deReunion(RAG);
    const abiertosR1 = D1.acuerdos.filter((x) => x.status === 'pending' || x.status === 'in_progress').map((x) => x.id).sort();
    check('la agendada: no recibe y dice por qué; trae lo ABIERTO de R1 con el mismo proveedor (no lo cerrado)', /^Los acuerdos salen de una reunión realizada/.test(DAG.no_recibe)
      && JSON.stringify(DAG.del_proveedor.acuerdos.map((x) => x.id).sort()) === JSON.stringify(abiertosR1) && DAG.del_proveedor.total === abiertosR1.length, [DAG.no_recibe, DAG.del_proveedor.total, abiertosR1.length]);
    const DB = await svc.deReunion(RB);
    check('otro proveedor: no ve los acuerdos de PQ310A', DB.del_proveedor.total === 0 && DB.acuerdos.length === 0, DB.del_proveedor);
    const DCA = await svc.deReunion(RCA);
    check('la cancelada: no recibe', /^La reunión está cancelada/.test(DCA.no_recibe), DCA.no_recibe);

    // 7. RLS: con otro tenant, no existe.
    await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [OTRO]);
    const svcOtro = new SA.SupplierAgreementsService(run, { requireTenantId: () => OTRO });
    const n19 = await rechazo(() => svcOtro.deReunion(R1));
    const LO = await svcOtro.lista();
    check('otro tenant: la reunión no existe (404) y su lista no trae los acuerdos', /^404 /.test(n19) && !LO.abiertos.acuerdos.some((x) => x.id === mkt.id) && !LO.cerrados.acuerdos.some((x) => x.id === prov.id), n19);
    const n20 = await rechazo(() => svcOtro.cumplir(ana, mkt.id, { note: 'x' }));
    check('otro tenant: cumplir un acuerdo ajeno = 404', /^404 El acuerdo no existe/.test(n20), n20);
    const sinFiltro = (await trx.raw('SELECT count(*)::int n FROM commercial.supplier_agreements WHERE id = ?', [mkt.id])).rows[0].n;
    check('RLS: como app_runtime con otro tenant, sin filtrar por tenant, el acuerdo no existe', sinFiltro === 0, sinFiltro);
    await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);
  } finally {
    if (!trx.isCompleted()) await trx.rollback();
    await knex.destroy();
  }
  console.log(`\n  ${ok} ✓ · ${ko} ✗\n`);
  process.exit(ko ? 1 : 0);
});
