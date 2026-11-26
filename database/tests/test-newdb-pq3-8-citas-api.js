#!/usr/bin/env node
/**
 * [PQ.3.8] Citas · C2 — la API de la reunión con el proveedor contra Postgres real: el repositorio y el servicio REALES
 * (ts-node) escribiendo como `app_runtime` con el tenant puesto, con el payload que manda la pantalla (regla 13: un
 * endpoint que escribe no está probado hasta que una prueba lo ejerció contra base real).
 *
 * ── QUÉ AFIRMA ───────────────────────────────────────────────────────────────────────────
 *  1. Agendar guarda la reunión con su hora de la Ciudad de México (10:00 MX = 16:00Z), su gente y sus temas; quien
 *     agenda queda como organizador; la agenda de la semana la trae con su situación y sus botones.
 *  2. Choques: la misma persona en dos reuniones que se enciman — aviso al guardar y en el detalle.
 *  3. NEGATIVAS sin guardar nada (400): invitar a quien no ve la agenda, a un inactivo, una clave que no está en el
 *     catálogo, sin nadie de Mega Dulces, plan de trabajo sin año. La llave POR PERSONA sí cuenta; la clave con sólo
 *     ficha borrada (R4) sí se agenda.
 *  4. Editar: reprograma y cambia gente — el que falta queda quitado con fecha y quién (no se borra), cambiar el área es
 *     quitar y agregar; un participante que ya no está = 409.
 *  5. Confirmar (por confirmar → agendada; dos veces = 409) · minuta (antes de empezar = 409; después, realizada con
 *     quién y cuándo; ya realizada no se edita ni se cancela = 409) · cancelar (sin motivo = 400; con motivo, final).
 *  6. «Pasó sin minuta» en la agenda; el detalle trae la anterior REALIZADA con el proveedor; el buscador común encuentra
 *     por nombre y clave (también la ficha borrada) y no ofrece internos; las opciones son quien ve la agenda.
 *  7. RLS: con otro tenant, la reunión no existe (404) y la agenda no la trae.
 *  8. `design:paramtypes` del servicio, emitido por TypeScript: lo que Nest inyecta en producción (#414).
 *
 * Todo dentro de una transacción que se REVIERTE: no deja filas. ⚠️ Sin las tablas (migración 20261125203927 sin
 * aplicar) sale con 2 = NO MEDIDO, nunca ✔.
 * ⛔ Escribe (aunque revierta): exige `assert-safe-target`, nunca contra producción.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-pq3-8-citas-api');
const { noMedido, correr } = require('./_lib/no-medido');

const RAIZ = path.resolve(__dirname, '..', '..');
let R;
let S;
try {
  require('reflect-metadata');
  require('ts-node').register({ transpileOnly: true, skipProject: true,
    compilerOptions: { module: 'commonjs', moduleResolution: 'node', target: 'es2021', experimentalDecorators: true, emitDecoratorMetadata: true, ignoreDeprecations: '6.0' } });
  const tsc = require('typescript');
  const base = tsc.readConfigFile(path.join(RAIZ, 'tsconfig.base.json'), tsc.sys.readFile).config;
  require('tsconfig-paths').register({ baseUrl: RAIZ, paths: base.compilerOptions.paths });
  R = require(path.join(RAIZ, 'libs/commercial/src/lib/supplier-meetings/supplier-meetings.repo.ts'));
  S = require(path.join(RAIZ, 'libs/commercial/src/lib/supplier-meetings/supplier-meetings.service.ts'));
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
  console.log('\n[PQ.3.8] Citas · la API de la reunión con el proveedor — Postgres real\n');
  const hay = (await knex.raw(`SELECT to_regclass('commercial.supplier_meetings') IS NOT NULL
                                    AND to_regclass('commercial.supplier_meeting_participants') IS NOT NULL AS ok`)).rows[0].ok;
  if (!hay) { await knex.destroy(); noMedido('commercial.supplier_meetings / _participants no existen (migración 20261125203927 sin aplicar)'); return; }

  // 8. Lo que Nest inyecta: el `design:paramtypes` que emite TypeScript, no el que uno supone.
  const tipos = (Reflect.getMetadata('design:paramtypes', S.SupplierMeetingsService) || []).map((t) => t && t.name);
  check('design:paramtypes del servicio = [TenantKnexService, TenantContextService]', JSON.stringify(tipos) === JSON.stringify(['TenantKnexService', 'TenantContextService']), tipos);

  const trx = await knex.transaction();
  try {
    await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);
    const { hoy } = await R.relojMx(trx);
    const sumar = (f, n) => { const d = new Date(`${f}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

    // ── Lo que hay antes (como dueño): roles, personas y proveedores de prueba ─────────────────────────────────────
    const rol = async (role_name, permissions) => trx('identity.role_permissions').insert({ tenant_id: TENANT, role_name, permissions });
    await rol('pq38_agenda', { COMPRAS_CITAS_AGENDAR: true });
    await rol('pq38_ver', { COMPRAS_CITAS_VER: true });
    await rol('pq38_sin', { COMPRAS_CALENDARIO_VER: true });
    // password_hash: el CHECK lo pide; no es un hash bcrypt, así que nadie entra con él (y todo se revierte).
    const persona = async (username, nombre, role_name, activo = true) => {
      const [u] = await trx('identity.users').insert({ tenant_id: TENANT, username, nombre, role_name, activo, password_hash: '!sin-acceso-prueba' }).returning('id');
      return u.id ?? u;
    };
    const ANA = await persona('pq38_ana', 'Prueba Ana Compras', 'pq38_agenda');
    const LUIS = await persona('pq38_luis', 'Prueba Luis Mercadotecnia', 'pq38_ver');
    const PEPE = await persona('pq38_pepe', 'Prueba Pepe Tienda', 'pq38_sin');
    const LETY = await persona('pq38_lety', 'Prueba Lety Tesorería', 'pq38_sin');
    const BAJA = await persona('pq38_baja', 'Prueba Baja', 'pq38_agenda', false);
    // La llave POR PERSONA cuenta (permisoEfectivoSql): Lety no la tiene por rol, sí por persona.
    await trx('identity.user_permissions').insert({ tenant_id: TENANT, user_id: LETY, permission_key: 'COMPRAS_CITAS_VER', allow: true });
    await trx('catalog.suppliers').insert({ tenant_id: TENANT, code: 'PQ38A', name: 'PRUEBA CITAS DULCERIA ALFA' });
    await trx('catalog.suppliers').insert({ tenant_id: TENANT, code: 'PQ38B', name: 'PRUEBA CITAS BETA BORRADA', deleted_at: trx.fn.now() });
    await trx('catalog.suppliers').insert({ tenant_id: TENANT, code: 'PQ38I', name: 'PRUEBA CITAS INTERNO', is_internal: true, internal_reason: 'prueba PQ.3.8: traspaso entre sucursales' });

    // ── Desde aquí, el rol de producción ────────────────────────────────────────────────────────────────────────
    await trx.raw('SET LOCAL ROLE app_runtime');
    const quien = { userId: ANA, username: 'pq38_ana' };
    const svc = new S.SupplierMeetingsService({ run: (fn) => fn(trx) }, { requireTenantId: () => TENANT });
    /** El código HTTP con que rechaza el servicio (en un SAVEPOINT: un rechazo no deja nada a medias). */
    const rechazo = async (f) => {
      await trx.raw('SAVEPOINT rechazo');
      try { await f(); await trx.raw('RELEASE SAVEPOINT rechazo'); return 'ok'; } catch (e) {
        await trx.raw('ROLLBACK TO SAVEPOINT rechazo');
        return `${e.getStatus ? e.getStatus() : 'crudo'} ${e.message}`;
      }
    };
    const cuantas = async () => Number((await trx.raw(`SELECT count(*) n FROM commercial.supplier_meetings WHERE supplier_code LIKE 'PQ38%'`)).rows[0].n);

    // El payload de la pantalla.
    const D1 = sumar(hoy, 7);
    const payload = (o = {}) => ({
      supplier_code: 'PQ38A', kind: 'executive', date: D1, start_time: '10:00', end_time: '11:00', mode: 'in_person',
      location: 'Sala de juntas', topics: ['Precios 2027', 'Lanzamientos'], work_plan_year: null,
      participants: [
        { side: 'internal', user_id: LUIS, area: 'marketing' },  // llega antes que Ana: el orden lo pone el área, no la pantalla
        { side: 'internal', user_id: ANA, area: 'compras' },
        { side: 'supplier', name: 'Ejecutivo de ventas', job_title: 'Gerente regional' },
      ],
      ...o,
    });

    // 1. Agendar.
    const g1 = await svc.agendar(quien, payload());
    check('agendar: regresa el id y sin choques', !!g1.id && g1.choques.length === 0, g1);
    const d1 = await svc.detalle(g1.id);
    const r1 = d1.reunion;
    check('la hora es de la Ciudad de México: 10:00 MX = 16:00Z (sin horario de verano)', r1.date === D1 && r1.start_time === '10:00' && r1.end_time === '11:00'
      && r1.starts_at === `${D1}T16:00:00Z` && r1.ends_at === `${D1}T17:00:00Z`, [r1.date, r1.start_time, r1.starts_at, r1.ends_at]);
    check('agendada, con los botones editar y cancelar (sin minuta: todavía no empieza)', r1.status === 'scheduled' && r1.situacion === 'agendada'
      && JSON.stringify(r1.acciones) === JSON.stringify(['editar', 'cancelar']), [r1.status, r1.situacion, r1.acciones]);
    check('quien agenda organiza; proveedor con nombre de su ficha; temas en orden', r1.organizer.user_id === ANA && r1.organizer.nombre === 'Prueba Ana Compras'
      && r1.supplier_name === 'PRUEBA CITAS DULCERIA ALFA' && JSON.stringify(r1.topics) === JSON.stringify(['Precios 2027', 'Lanzamientos']), [r1.organizer, r1.supplier_name, r1.topics]);
    check('participantes en orden estable: Mega Dulces por área (Compras antes que Mercadotecnia, aunque llegó después) y luego el proveedor', JSON.stringify(r1.participants.map((p) => [p.side, p.nombre, p.area, p.job_title]))
      === JSON.stringify([['internal', 'Prueba Ana Compras', 'compras', null], ['internal', 'Prueba Luis Mercadotecnia', 'marketing', null], ['supplier', 'Ejecutivo de ventas', null, 'Gerente regional']]),
    r1.participants);
    const fila = (await trx.raw(`SELECT created_by, updated_by, organizer_user_id::text o FROM commercial.supplier_meetings WHERE id = ?`, [g1.id])).rows[0];
    check('auditoría: creó y organiza quien agenda (por id de usuario)', fila.created_by === ANA && fila.updated_by === ANA && fila.o === ANA, fila);
    const ag = await svc.agenda(D1);
    check('la agenda de esa semana la trae', ag.reuniones.some((r) => r.id === g1.id) && ag.semana.desde <= D1 && D1 <= ag.semana.hasta, ag.semana);
    const agHoy = await svc.agenda(null);
    check('sin semana, la de hoy (y no trae la de la semana próxima)', agHoy.semana.desde <= hoy && hoy <= agHoy.semana.hasta && !agHoy.reuniones.some((r) => r.id === g1.id), agHoy.semana);

    // 2. Choques.
    const g2 = await svc.agendar(quien, payload({ start_time: '10:30', end_time: '12:00', participants: [{ side: 'internal', user_id: ANA, area: 'compras' }] }));
    check('choque al guardar: Ana ya va a otra reunión a esa hora', g2.choques.length === 1 && g2.choques[0].user_id === ANA && g2.choques[0].meeting_id === g1.id, g2.choques);
    const d1b = await svc.detalle(g1.id);
    check('…y el detalle de la primera lo avisa también (sólo por Ana, no por Luis)', d1b.reunion.choques.length === 1 && d1b.reunion.choques[0].meeting_id === g2.id, d1b.reunion.choques);

    // 3. Negativas: nada se guarda.
    const antes = await cuantas();
    const n1 = await rechazo(() => svc.agendar(quien, payload({ participants: [{ side: 'internal', user_id: PEPE, area: 'compras' }] })));
    check('invitar a quien no ve la agenda: 400 y lo dice', /^400 Prueba Pepe Tienda no ve la agenda/.test(n1), n1);
    const n2 = await rechazo(() => svc.agendar(quien, payload({ participants: [{ side: 'internal', user_id: BAJA, area: 'compras' }] })));
    check('invitar a un usuario inactivo: 400', /^400 Una de las personas elegidas ya no está activa/.test(n2), n2);
    const n3 = await rechazo(() => svc.agendar(quien, payload({ supplier_code: 'NOEXISTE' })));
    check('una clave que no está en el catálogo: 400', /^400 La clave NOEXISTE no está en el catálogo/.test(n3), n3);
    const n4 = await rechazo(() => svc.agendar(quien, payload({ participants: [{ side: 'supplier', name: 'Ejecutivo' }] })));
    check('sin nadie de Mega Dulces: 400', /^400 Al menos una persona de Mega Dulces/.test(n4), n4);
    const n5 = await rechazo(() => svc.agendar(quien, payload({ kind: 'work_plan' })));
    check('plan de trabajo sin año: 400', /^400 El plan de trabajo es de un año/.test(n5), n5);
    const n6 = await rechazo(() => svc.agendar(quien, payload({ status: 'held' })));
    check('agendar ya realizada: 400 (la minuta va después)', /^400 Una reunión nueva queda agendada o por confirmar/.test(n6), n6);
    check('…y ninguno guardó nada', (await cuantas()) === antes, { antes, despues: await cuantas() });
    const g3 = await svc.agendar(quien, payload({ supplier_code: 'PQ38B', kind: 'work_plan', work_plan_year: 2027, start_time: '16:00', end_time: '18:00',
      participants: [{ side: 'internal', user_id: LETY, area: 'finanzas' }] }));
    const r3 = (await svc.detalle(g3.id)).reunion;
    check('la llave por persona cuenta (Lety) y la clave con sólo ficha borrada se agenda (R4), con su nombre', r3.participants[0].user_id === LETY
      && r3.supplier_name === 'PRUEBA CITAS BETA BORRADA' && r3.work_plan_year === 2027, [r3.participants, r3.supplier_name, r3.work_plan_year]);

    // 4. Editar.
    const [pAna, pLuis, pEje] = r1.participants;
    const e1 = await svc.editar(quien, g1.id, payload({
      start_time: '12:00', end_time: '13:30', topics: ['Precios 2027'],
      participants: [
        { id: pAna.id, side: 'internal', user_id: ANA, area: 'direccion' },          // cambió el área: quitar + agregar
        { id: pEje.id, side: 'supplier', name: 'Ejecutivo de ventas', job_title: 'Gerente regional' }, // igual: se queda
        { side: 'supplier', name: 'Gerente de marca', job_title: null },              // nuevo
      ],                                                                              // Luis falta: se quita
    }));
    const r1e = (await svc.detalle(g1.id)).reunion;
    check('editar: reprogramada a 12:00–13:30 y ya no choca con la de 10:30–12:00', r1e.start_time === '12:00' && r1e.end_time === '13:30' && e1.choques.length === 0, [r1e.start_time, e1.choques]);
    check('editar: gente viva = Ana (Dirección), el ejecutivo de antes (mismo renglón) y el nuevo, por nombre', JSON.stringify(r1e.participants.map((p) => [p.nombre, p.area]))
      === JSON.stringify([['Prueba Ana Compras', 'direccion'], ['Ejecutivo de ventas', null], ['Gerente de marca', null]])
      && r1e.participants.some((p) => p.id === pEje.id) && !r1e.participants.some((p) => p.id === pAna.id), r1e.participants);
    const quitados = (await trx.raw(`SELECT id::text, removed_by, removed_at IS NOT NULL AS con_fecha FROM commercial.supplier_meeting_participants
                                        WHERE meeting_id = ? AND removed_at IS NOT NULL ORDER BY id`, [g1.id])).rows;
    check('Luis y el renglón viejo de Ana quedan QUITADOS con fecha y quién (no borrados)', quitados.length === 2
      && quitados.every((q) => q.removed_by === ANA && q.con_fecha) && quitados.some((q) => q.id === pLuis.id) && quitados.some((q) => q.id === pAna.id), quitados);
    const n7 = await rechazo(() => svc.editar(quien, g1.id, payload({ participants: [{ id: pLuis.id, side: 'internal', user_id: LUIS, area: 'marketing' }] })));
    check('editar con un participante que ya no está: 409', /^409 Alguien ya no está en la reunión/.test(n7), n7);

    // 5. Confirmar, minuta y cancelar.
    const g4 = await svc.agendar(quien, payload({ status: 'to_confirm', start_time: '17:00', end_time: '17:30', participants: [{ side: 'internal', user_id: ANA, area: 'compras' }] }));
    const r4 = (await svc.detalle(g4.id)).reunion;
    check('por confirmar: situación y botones (confirmar primero)', r4.situacion === 'por_confirmar' && r4.acciones[0] === 'confirmar', [r4.situacion, r4.acciones]);
    await svc.confirmar(quien, g4.id);
    check('confirmar: queda agendada', (await svc.detalle(g4.id)).reunion.status === 'scheduled');
    const n8 = await rechazo(() => svc.confirmar(quien, g4.id));
    check('confirmar dos veces: 409', /^409 La reunión ya estaba confirmada/.test(n8), n8);
    const n9 = await rechazo(() => svc.minuta(quien, g4.id, { minutes: 'Se habló de precios' }));
    check('minuta antes de que empiece: 409', /^409 La reunión todavía no empieza/.test(n9), n9);

    const AYER = sumar(hoy, -1);
    const g5 = await svc.agendar(quien, payload({ date: AYER, participants: [{ side: 'internal', user_id: ANA, area: 'compras' }] }));
    const ag5 = await svc.agenda(null);
    const p5 = ag5.sin_minuta.reuniones.find((r) => r.id === g5.id);
    check('la de ayer sin minuta: en «pasó sin minuta» (de cualquier semana), con el botón de minuta', !!p5 && p5.situacion === 'sin_minuta'
      && p5.acciones.includes('minuta') && ag5.sin_minuta.total >= 1, p5 && [p5.situacion, p5.acciones, ag5.sin_minuta.total]);
    const n10 = await rechazo(() => svc.minuta(quien, g5.id, { minutes: '   ' }));
    check('minuta vacía: 400', /^400 Escribe la minuta/.test(n10), n10);
    await svc.minuta(quien, g5.id, { minutes: '  Se acordó precio especial para Navidad.  ' });
    const m5 = (await trx.raw(`SELECT status, minutes, minutes_by, minutes_at IS NOT NULL AS cuando FROM commercial.supplier_meetings WHERE id = ?`, [g5.id])).rows[0];
    check('minuta: realizada, con el texto limpio, quién y cuándo', m5.status === 'held' && m5.minutes === 'Se acordó precio especial para Navidad.' && m5.minutes_by === ANA && m5.cuando, m5);
    const r5 = (await svc.detalle(g5.id)).reunion;
    check('realizada: sin botones y con el nombre de quien escribió la minuta', r5.situacion === 'realizada' && r5.acciones.length === 0 && r5.minutes_by === 'Prueba Ana Compras', [r5.situacion, r5.acciones, r5.minutes_by]);
    const n11 = await rechazo(() => svc.editar(quien, g5.id, payload({ date: AYER })));
    const n12 = await rechazo(() => svc.minuta(quien, g5.id, { minutes: 'otra' }));
    const n13 = await rechazo(() => svc.cancelar(quien, g5.id, { reason: 'x' }));
    check('realizada no se edita, no se reescribe su minuta ni se cancela: 409 las tres', [n11, n12, n13].every((x) => /^409 La reunión ya se realizó/.test(x)), [n11, n12, n13]);
    const d4 = await svc.detalle(g4.id);
    check('el detalle trae la anterior REALIZADA con el proveedor, con su minuta', d4.anterior && d4.anterior.id === g5.id && d4.anterior.minutes === 'Se acordó precio especial para Navidad.', d4.anterior && d4.anterior.id);

    const n14 = await rechazo(() => svc.cancelar(quien, g2.id, { reason: '  ' }));
    check('cancelar sin motivo: 400', /^400 Escribe por qué se cancela/.test(n14), n14);
    await svc.cancelar(quien, g2.id, { reason: 'El ejecutivo cambió de zona' });
    const r2 = (await svc.detalle(g2.id)).reunion;
    check('cancelada: con motivo y quién, sin botones', r2.situacion === 'cancelada' && r2.cancelled_reason === 'El ejecutivo cambió de zona'
      && r2.cancelled_by === 'Prueba Ana Compras' && r2.acciones.length === 0, [r2.situacion, r2.cancelled_by, r2.acciones]);
    const n15 = await rechazo(() => svc.confirmar(quien, g2.id));
    check('una cancelada no revive: 409', /^409 La reunión está cancelada/.test(n15), n15);

    // 6. Buscador común y opciones.
    const b1 = await svc.proveedores('alfa dulceria');
    check('buscador: «alfa dulceria» (dos palabras, sin acento, otro orden) encuentra PQ38A', b1.proveedores.some((p) => p.code === 'PQ38A'), b1.proveedores);
    const b2 = await svc.proveedores('PQ38B');
    check('buscador: por clave, también la que sólo tiene ficha borrada', b2.proveedores.length === 1 && b2.proveedores[0].name === 'PRUEBA CITAS BETA BORRADA', b2.proveedores);
    const b3 = await svc.proveedores('PQ38');
    check('buscador: el proveedor interno no se ofrece (PQ38 trae A y B, no I)', JSON.stringify(b3.proveedores.map((p) => p.code).sort()) === JSON.stringify(['PQ38A', 'PQ38B']), b3.proveedores);
    check('buscador: sin texto, nada (el selector pide escribir)', (await svc.proveedores('  ')).proveedores.length === 0);
    const op = await svc.opciones();
    const ids = new Set(op.personas.map((p) => p.user_id));
    check('opciones: quien ve la agenda (por rol o por persona), no quien no la ve ni el inactivo', ids.has(ANA) && ids.has(LUIS) && ids.has(LETY) && !ids.has(PEPE) && !ids.has(BAJA),
      op.personas.filter((p) => /^Prueba/.test(p.nombre)));

    // 7. RLS: con otro tenant, no existe.
    await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [OTRO]);
    const svcOtro = new S.SupplierMeetingsService({ run: (fn) => fn(trx) }, { requireTenantId: () => OTRO });
    const n16 = await rechazo(() => svcOtro.detalle(g1.id));
    const agOtro = await svcOtro.agenda(D1);
    check('otro tenant: el servicio no la encuentra (404) y su agenda no la trae', /^404 /.test(n16) && !agOtro.reuniones.some((r) => r.id === g1.id), n16);
    const sinFiltro = (await trx.raw('SELECT count(*)::int n FROM commercial.supplier_meetings WHERE id = ?', [g1.id])).rows[0].n;
    const sinFiltroP = (await trx.raw('SELECT count(*)::int n FROM commercial.supplier_meeting_participants WHERE meeting_id = ?', [g1.id])).rows[0].n;
    check('RLS: como app_runtime con otro tenant, sin filtrar por tenant, la reunión y su gente no existen', sinFiltro === 0 && sinFiltroP === 0, { sinFiltro, sinFiltroP });
    await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);
  } finally {
    if (!trx.isCompleted()) await trx.rollback();
    await knex.destroy();
  }
  console.log(`\n  ${ok} ✓ · ${ko} ✗\n`);
  process.exit(ko ? 1 : 0);
});
