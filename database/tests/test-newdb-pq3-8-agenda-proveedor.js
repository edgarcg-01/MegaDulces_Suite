#!/usr/bin/env node
/**
 * [PQ.3.8] Compras › Proveedores › Citas — la reunión con el proveedor y quién va, contra base REAL.
 *
 * ── QUÉ AFIRMA ───────────────────────────────────────────────────────────────────────────
 * `commercial.supplier_meetings` guarda la reunión (anexo C §9.1, §10.15); `commercial.supplier_meeting_participants`,
 * quién va. Antes de que exista la API, lo que tiene que ser verdad en la base:
 *
 *  1. **Las listas del código = los CHECK.** Tipos, estados, modalidades, lados y áreas de
 *     `libs/contracts/src/http/supplier-meetings.contract.ts` son EXACTAMENTE los que aceptan los CHECK.
 *  2. **Los casos de la maqueta entran:** una cita con ejecutivo por videollamada, una revisión de negocio con sus
 *     temas, el plan de trabajo 2027, una visita por confirmar; dos personas de Mega Dulces (Compras y Finanzas) y el
 *     ejecutivo del proveedor; una reunión realizada con su minuta y otra cancelada con su motivo.
 *  3. **Negativas, una por regla del CHECK** — incluida la TRAMPA del NULL en los temas: control en la misma base de que
 *     la expresión ingenua (`NULL = ANY(…)`) da NULL, así que sin `array_position(…) IS NULL` un tema nulo entraría.
 *  4. **Un usuario va una vez a la misma reunión;** quitado (`removed_at`), puede volver.
 *  5. **Como `app_runtime`** (el rol de prod): cancela y quita con UPDATE, NO puede borrar; con otro tenant (RLS) no ve
 *     nada ni puede escribir.
 *
 * Todo dentro de una transacción que se REVIERTE: no deja filas.
 * ⚠️ Sin las tablas (migración 20261125203927 sin aplicar) sale con 2 = NO MEDIDO, nunca ✔.
 * ⛔ Escribe (aunque revierta): exige `assert-safe-target`, nunca contra producción.
 */
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const DST = process.env.DATABASE_URL_NEW_RUNTIME || process.env.DATABASE_URL_NEW
  || (() => { throw new Error('falta DATABASE_URL_NEW_RUNTIME o DATABASE_URL_NEW'); })();
const TENANT = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const OTRO = '00000000-0000-0000-0000-0000000000aa';
const U1 = '00000000-0000-0000-0000-0000000038a1';
const U2 = '00000000-0000-0000-0000-0000000038a2';
const CONTRATO = path.join(__dirname, '..', '..', 'libs', 'contracts', 'src', 'http', 'supplier-meetings.contract.ts');

let ok = 0, fail = 0, nm = 0;
const P = (m) => { ok++; console.log(`  ✔ ${m}`); };
const F = (m) => { fail++; console.log(`  ✘ ${m}`); };
const NM = (m) => { nm++; console.log(`  ○ NO MEDIDO — ${m}`); };

/** Las listas del contrato, leídas del CÓDIGO (no copiadas aquí: una copia se queda vieja). */
function listasDelContrato() {
  const src = fs.readFileSync(CONTRATO, 'utf8');
  const lista = (nombre) => {
    const m = src.match(new RegExp(`export const ${nombre}: readonly \\w+\\[\\] = \\[([^\\]]*)\\]`));
    if (!m) throw new Error(`no encontré ${nombre} en ${CONTRATO}`);
    return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
  };
  return {
    kind: lista('TIPOS_REUNION'),
    status: lista('ESTADOS_REUNION'),
    mode: lista('MODALIDADES_REUNION'),
    side: lista('LADOS_PARTICIPANTE'),
    area: lista('AREAS_PARTICIPANTE'),
  };
}

require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-pq3-8-agenda-proveedor', { url: DST });

(async () => {
  const c = new Client({ connectionString: DST });
  await c.connect();
  let dest = (await c.query('SELECT current_user u, current_database() d')).rows[0];
  console.log(`\n[PQ.3.8] la reunión con el proveedor y quién va  —  ${dest.u}@${dest.d}\n`);

  const existe = (await c.query(`SELECT to_regclass('commercial.supplier_meetings') IS NOT NULL
                                        AND to_regclass('commercial.supplier_meeting_participants') IS NOT NULL ok`)).rows[0].ok;
  if (!existe) {
    NM('commercial.supplier_meetings / _participants no existen (migración 20261125203927 sin aplicar)');
    await c.end();
    process.exit(2);
  }

  // 1. Las listas del código = los CHECK. Cada columna, contra los CHECK de SU tabla.
  const contrato = listasDelContrato();
  const defsDe = async (tabla) => (await c.query(`
    SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = $1::regclass AND contype = 'c'`, [tabla])).rows.map((r) => r.def);
  const defsReunion = await defsDe('commercial.supplier_meetings');
  const defsParticipante = await defsDe('commercial.supplier_meeting_participants');
  const valoresDe = (col, defs) => [...new Set(defs.flatMap((d) => {
    const out = [];
    for (const m of d.matchAll(new RegExp(`\\(?\\b${col} = '([^']+)'::text\\)?`, 'g'))) out.push(m[1]);
    for (const m of d.matchAll(new RegExp(`\\b${col} = ANY \\(ARRAY\\[([^\\]]+)\\]\\)`, 'g'))) out.push(...[...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]));
    return out;
  }))].sort();
  for (const [col, defs] of [['kind', defsReunion], ['status', defsReunion], ['mode', defsReunion], ['side', defsParticipante], ['area', defsParticipante]]) {
    const enCheck = valoresDe(col, defs);
    if (JSON.stringify(enCheck) === JSON.stringify(contrato[col])) P(`${col}: el contrato y el CHECK aceptan lo mismo (${contrato[col].join(', ')})`);
    else F(`${col}: el contrato dice [${contrato[col]}] y el CHECK acepta [${enCheck}]`);
  }

  // Probar como el rol de prod. Si la conexión no es app_runtime pero puede volverse, se vuelve.
  if (dest.u !== 'app_runtime') {
    try { await c.query('SET ROLE app_runtime'); dest = { ...dest, u: (await c.query('SELECT current_user u')).rows[0].u }; console.log(`  ⓘ SET ROLE app_runtime (la conexión entró como otro usuario)`); }
    catch { /* se declara abajo */ }
  }
  const comoRuntime = dest.u === 'app_runtime';

  await c.query('BEGIN');
  const sp = async (nombre, fn) => {
    await c.query(`SAVEPOINT ${nombre}`);
    try { return await fn(); } finally { await c.query(`ROLLBACK TO SAVEPOINT ${nombre}`); }
  };
  const reunion = (r) => c.query(`
    INSERT INTO commercial.supplier_meetings
      (tenant_id, supplier_code, kind, status, starts_at, ends_at, mode, location, topics, organizer_user_id,
       work_plan_year, minutes, minutes_by, minutes_at, cancelled_reason, cancelled_by, cancelled_at, created_by, updated_by)
    VALUES (current_tenant_id(), $1, $2, COALESCE($3, 'scheduled'), $4, $5, $6, $7, COALESCE($8::text[], '{}'), $9,
            $10, $11, $12, $13, $14, $15, $16, 'prueba', 'prueba')
    RETURNING id`, [r.supplier ?? 'PQ38-A', r.kind ?? 'executive', r.status ?? null,
    r.starts ?? '2026-11-24T18:00:00Z', r.ends ?? '2026-11-24T18:30:00Z', r.mode ?? 'video', r.location === undefined ? null : r.location,
    r.topics === undefined ? null : r.topics, 'organizer' in r ? r.organizer : U1, r.year ?? null,
    r.minutes === undefined ? null : r.minutes, r.minutesBy ?? null, r.minutesAt ?? null,
    r.reason === undefined ? null : r.reason, r.cancelledBy ?? null, r.cancelledAt ?? null]).then((x) => x.rows[0].id);
  const participante = (p) => c.query(`
    INSERT INTO commercial.supplier_meeting_participants (tenant_id, meeting_id, side, user_id, area, name, job_title, created_by)
    VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6, 'prueba') RETURNING id`,
  [p.meeting, p.side ?? 'internal', p.user === undefined ? null : p.user, p.area === undefined ? null : p.area,
    p.name === undefined ? null : p.name, p.title === undefined ? null : p.title]).then((x) => x.rows[0].id);
  const rebota = async (nombre, codigo, fn, que) => sp(nombre, async () => {
    try { await fn(); F(`entró: ${que}`); }
    catch (e) { if (e.code === codigo) P(`negativa: ${que} → ${codigo}`); else F(`${que} falló por otra cosa: ${e.code} ${e.message}`); }
  });

  try {
    await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT]);

    // 2. Los casos de la maqueta entran.
    const cita = await reunion({ supplier: 'PQ38-HER', kind: 'executive', mode: 'video', topics: ['Lanzamientos del primer trimestre', 'Material de punto de venta'] });
    const revision = await reunion({ supplier: 'PQ38-ROS', kind: 'business_review', mode: 'in_person', location: 'Oficinas Padre Hidalgo',
      starts: '2026-11-23T16:00:00Z', ends: '2026-11-23T17:00:00Z', topics: ['Resultados del trimestre', 'Plan de trabajo 2027 por área'] });
    const plan = await reunion({ supplier: 'PQ38-MON', kind: 'work_plan', year: 2027, mode: 'in_person', location: 'Oficinas Padre Hidalgo',
      starts: '2026-11-25T15:30:00Z', ends: '2026-11-25T17:30:00Z' });
    const porConfirmar = await reunion({ supplier: 'PQ38-BOT', kind: 'executive', status: 'to_confirm', mode: 'in_person' });
    const realizada = await reunion({ supplier: 'PQ38-BOL', kind: 'executive', status: 'held', mode: 'call',
      minutes: 'Confirmaron la lista de precios 2027 para el 1-dic.', minutesBy: 'prueba', minutesAt: '2026-11-24T19:00:00Z' });
    const cancelada = await reunion({ supplier: 'PQ38-FER', kind: 'business_review', status: 'cancelled', mode: 'in_person',
      reason: 'El ejecutivo cambió de zona; se reagenda con el nuevo', cancelledBy: 'prueba', cancelledAt: '2026-11-24T19:00:00Z' });
    if ([cita, revision, plan, porConfirmar, realizada, cancelada].every(Boolean)) {
      P('entran: cita con ejecutivo por videollamada con temas · revisión de negocio en persona · plan de trabajo 2027 · visita por confirmar · realizada con minuta · cancelada con motivo');
    }
    const leida = (await c.query(`SELECT status, topics, work_plan_year FROM commercial.supplier_meetings WHERE id = $1`, [revision])).rows[0];
    if (leida.status === 'scheduled' && JSON.stringify(leida.topics) === JSON.stringify(['Resultados del trimestre', 'Plan de trabajo 2027 por área']) && leida.work_plan_year === null) {
      P('se lee como se guardó: agendada por defecto, los temas EN ORDEN, sin año (no es plan de trabajo)');
    } else F(`la reunión se lee distinta: ${JSON.stringify(leida)}`);

    const p1 = await participante({ meeting: revision, user: U1, area: 'compras' });
    const p2 = await participante({ meeting: revision, user: U2, area: 'finanzas' });
    const p3 = await participante({ meeting: revision, side: 'supplier', name: 'Ejecutivo de cuenta', title: 'Ejecutivo de cuenta' });
    const p4 = await participante({ meeting: revision, side: 'supplier', name: 'Gerente de trade' });
    if (p1 && p2 && p3 && p4) P('entran: Compras y Finanzas por Mega Dulces; el ejecutivo (con puesto) y el gerente de trade (sin puesto) por el proveedor');

    // 3. Control de la trampa del NULL en los temas.
    const trampa = (await c.query(`
      SELECT (NULL::text = ANY ('{a,b}'::text[])) IS NULL AS ingenua,
             array_position('{a,NULL}'::text[], NULL) = 2 AS detecta,
             array_position('{a,b}'::text[], NULL) IS NULL AS limpia`)).rows[0];
    if (trampa.ingenua && trampa.detecta && trampa.limpia) P('control: «NULL = ANY(temas)» da NULL (dejaría pasar la fila); array_position sí distingue un tema nulo de una lista limpia');
    else F(`control de la trampa del NULL no se cumplió (${JSON.stringify(trampa)}): la negativa del tema nulo no prueba nada`);

    // 3. Negativas de la reunión.
    const CK = '23514';
    await rebota('tipo', CK, () => reunion({ kind: 'coffee' }), 'tipo desconocido «coffee»');
    await rebota('estado', CK, () => reunion({ status: 'maybe' }), 'estado desconocido «maybe»');
    await rebota('modo', CK, () => reunion({ mode: 'fax' }), 'modalidad desconocida «fax»');
    await rebota('fin_igual', CK, () => reunion({ starts: '2026-11-24T18:00:00Z', ends: '2026-11-24T18:00:00Z' }), 'termina cuando empieza');
    await rebota('fin_antes', CK, () => reunion({ starts: '2026-11-24T18:00:00Z', ends: '2026-11-24T17:00:00Z' }), 'termina antes de empezar');
    await rebota('prov_vacio', CK, () => reunion({ supplier: '  ' }), 'proveedor en blanco');
    await rebota('lugar_vacio', CK, () => reunion({ location: '   ' }), 'lugar en blanco (o se dice o va nulo)');
    await rebota('tema_nulo', CK, () => reunion({ topics: ['Precios', null] }), 'un tema NULO en la lista');
    await rebota('temas_21', CK, () => reunion({ topics: Array.from({ length: 21 }, (_, i) => `Tema ${i + 1}`) }), '21 temas (el tope es 20)');
    await rebota('plan_sin_ano', CK, () => reunion({ kind: 'work_plan', year: null }), 'plan de trabajo SIN año');
    await rebota('cita_con_ano', CK, () => reunion({ kind: 'executive', year: 2027 }), 'cita con ejecutivo CON año de plan');
    await rebota('plan_2024', CK, () => reunion({ kind: 'work_plan', year: 2024 }), 'plan de trabajo de 2024 (fuera de rango)');
    await rebota('hecha_sin_minuta', CK, () => reunion({ status: 'held' }), 'realizada SIN minuta');
    await rebota('minuta_sin_hecha', CK, () => reunion({ status: 'scheduled', minutes: 'algo', minutesBy: 'prueba', minutesAt: '2026-11-24T19:00:00Z' }), 'agendada CON minuta (la minuta la da por realizada)');
    await rebota('minuta_blanca', CK, () => reunion({ status: 'held', minutes: '   ', minutesBy: 'prueba', minutesAt: '2026-11-24T19:00:00Z' }), 'minuta en blanco');
    await rebota('minuta_sin_quien', CK, () => reunion({ status: 'held', minutes: 'algo', minutesAt: '2026-11-24T19:00:00Z' }), 'minuta sin quién la escribió');
    await rebota('minuta_sin_cuando', CK, () => reunion({ status: 'held', minutes: 'algo', minutesBy: 'prueba' }), 'minuta sin cuándo');
    await rebota('cancel_sin_motivo', CK, () => reunion({ status: 'cancelled' }), 'cancelada SIN motivo');
    await rebota('motivo_sin_cancel', CK, () => reunion({ reason: 'algo', cancelledBy: 'prueba', cancelledAt: '2026-11-24T19:00:00Z' }), 'agendada CON motivo de cancelación');
    await rebota('cancel_blanco', CK, () => reunion({ status: 'cancelled', reason: '  ', cancelledBy: 'prueba', cancelledAt: '2026-11-24T19:00:00Z' }), 'motivo de cancelación en blanco');
    await rebota('cancel_sin_quien', CK, () => reunion({ status: 'cancelled', reason: 'algo', cancelledAt: '2026-11-24T19:00:00Z' }), 'cancelada sin quién');
    await rebota('sin_organiza', '23502', () => reunion({ organizer: null }), 'reunión sin quién la organiza');

    // 3. Negativas de los participantes.
    await rebota('int_sin_usuario', CK, () => participante({ meeting: cita, user: null, area: 'compras' }), 'por Mega Dulces SIN usuario');
    await rebota('int_sin_area', CK, () => participante({ meeting: cita, user: U1, area: null }), 'por Mega Dulces SIN área');
    await rebota('int_con_nombre', CK, () => participante({ meeting: cita, user: U1, area: 'compras', name: 'Fulano' }), 'por Mega Dulces con nombre suelto (el nombre sale del usuario)');
    await rebota('prov_sin_nombre', CK, () => participante({ meeting: cita, side: 'supplier', name: '  ' }), 'por el proveedor SIN nombre');
    await rebota('prov_con_usuario', CK, () => participante({ meeting: cita, side: 'supplier', name: 'Ejecutivo', user: U1 }), 'por el proveedor con usuario de la Suite');
    await rebota('prov_con_area', CK, () => participante({ meeting: cita, side: 'supplier', name: 'Ejecutivo', area: 'compras' }), 'por el proveedor con área de Mega Dulces');
    await rebota('prov_puesto_blanco', CK, () => participante({ meeting: cita, side: 'supplier', name: 'Ejecutivo', title: '  ' }), 'puesto en blanco');
    await rebota('area_mala', CK, () => participante({ meeting: cita, user: U1, area: 'sistemas' }), 'área desconocida «sistemas»');
    await rebota('lado_malo', CK, () => participante({ meeting: cita, side: 'externo', name: 'X' }), 'lado desconocido «externo»');
    await rebota('huerfano', '23503', () => participante({ meeting: '00000000-0000-0000-0000-000000000001', user: U1, area: 'compras' }), 'participante de una reunión que no existe');

    // 4. Un usuario va una vez; quitado, puede volver.
    await rebota('dup', '23505', () => participante({ meeting: revision, user: U1, area: 'marketing' }), 'el MISMO usuario dos veces en la misma reunión');
    await rebota('quitar_sin_quien', CK, () => c.query(`UPDATE commercial.supplier_meeting_participants SET removed_at = now() WHERE id = $1`, [p1]), 'quitar sin decir quién');
    await sp('quitar', async () => {
      await c.query(`UPDATE commercial.supplier_meeting_participants SET removed_at = now(), removed_by = 'prueba' WHERE id = $1`, [p1]);
      const otra = await participante({ meeting: revision, user: U1, area: 'compras' });
      if (otra) P('quitado (UPDATE, no DELETE), el mismo usuario vuelve a entrar');
      const enOtra = await participante({ meeting: cita, user: U1, area: 'compras' });
      if (enOtra) P('el mismo usuario va a OTRA reunión sin chocar');
    });

    // 5. Permisos de app_runtime y RLS.
    // Control: en prod, los privilegios POR DEFECTO de `commercial` le dan DELETE a app_runtime (`arwd`, medido el
    // 2026-11-25). Si esta base no los replica, «app_runtime no borra» saldría verde aunque faltara el REVOKE de la
    // migración: entonces se DECLARA, no se da por probado (el mutante «sin REVOKE» lo encontró).
    const deleteDePorDefecto = (await c.query(`
      SELECT EXISTS (SELECT 1 FROM pg_default_acl d, aclexplode(d.defaclacl) a
                      WHERE d.defaclnamespace = 'commercial'::regnamespace AND d.defaclobjtype = 'r'
                        AND a.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'app_runtime')
                        AND a.privilege_type = 'DELETE') AS si`)).rows[0].si;
    if (comoRuntime && !deleteDePorDefecto) {
      NM('esta base no da DELETE por defecto a app_runtime en commercial (prod sí): «no puede borrar» no prueba el REVOKE');
    }
    if (comoRuntime) {
      await rebota('borrar_reunion', '42501', () => c.query(`DELETE FROM commercial.supplier_meetings WHERE id = $1`, [porConfirmar]), 'app_runtime BORRA una reunión (se cancela con motivo)');
      await rebota('borrar_part', '42501', () => c.query(`DELETE FROM commercial.supplier_meeting_participants WHERE id = $1`, [p4]), 'app_runtime BORRA un participante (se quita con fecha)');
      await sp('cancela', async () => {
        const n = (await c.query(`UPDATE commercial.supplier_meetings
                                     SET status = 'cancelled', cancelled_reason = 'El proveedor no confirmó', cancelled_by = 'prueba',
                                         cancelled_at = now(), updated_by = 'prueba', updated_at = now()
                                   WHERE id = $1`, [porConfirmar])).rowCount;
        if (n === 1) P('app_runtime cancela una reunión con UPDATE y motivo');
        else F(`cancelar tocó ${n} filas`);
      });
      await sp('minuta', async () => {
        const n = (await c.query(`UPDATE commercial.supplier_meetings
                                     SET status = 'held', minutes = 'Se revisaron resultados; 3 acuerdos.', minutes_by = 'prueba',
                                         minutes_at = now(), updated_by = 'prueba', updated_at = now()
                                   WHERE id = $1`, [revision])).rowCount;
        if (n === 1) P('app_runtime escribe la minuta y la reunión pasa a realizada en el mismo UPDATE');
        else F(`la minuta tocó ${n} filas`);
      });
      await sp('rls', async () => {
        await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [OTRO]);
        const n = (await c.query(`SELECT (SELECT count(*) FROM commercial.supplier_meetings WHERE supplier_code LIKE 'PQ38-%')
                                        + (SELECT count(*) FROM commercial.supplier_meeting_participants) AS n`)).rows[0].n;
        if (Number(n) === 0) P('RLS: con otro tenant no se ve ninguna reunión ni participante');
        else F(`RLS: otro tenant ve ${n} filas ajenas`);
        await rebota('rls_insert', '42501', () => c.query(`
          INSERT INTO commercial.supplier_meetings (tenant_id, supplier_code, kind, starts_at, ends_at, mode, organizer_user_id, created_by)
          VALUES ($1, 'PQ38-X', 'executive', '2026-11-24T18:00:00Z', '2026-11-24T18:30:00Z', 'call', $2, 'prueba')`, [TENANT, U1]),
        'insertar con el tenant de OTRO (WITH CHECK)');
      });
    } else {
      NM(`permisos y RLS de app_runtime: la prueba corrió como ${dest.u} y no pudo hacer SET ROLE app_runtime`);
    }
  } finally {
    await c.query('ROLLBACK');
  }

  console.log(`\n${ok} ✔ · ${fail} ✘ · ${nm} ○ NO MEDIDO\n`);
  await c.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
