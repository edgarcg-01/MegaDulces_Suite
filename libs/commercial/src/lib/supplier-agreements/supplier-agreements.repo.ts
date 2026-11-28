import type { Knex } from 'knex';
import {
  ESTADOS_ACUERDO_CERRADOS, LIMITES_ACUERDOS,
  type AcuerdoGuardado, type AcuerdoVista, type AcuerdosDeReunion, type CapturarAcuerdoDto, type EstadoAcuerdo, type EstadoReunion,
  type ListaAcuerdos,
} from '@megadulces/contracts';
import { isPlatformAdminRole, permisoEfectivoSql } from '@megadulces/platform-core';
import { LLAVE_AGENDAR, relojMx, type Quien } from '../supplier-meetings/supplier-meetings.repo';
import {
  acciones, AcuerdosError, estadoTras, exigir, ordenar, porQueNoRecibe, situacion, validarAcuerdo, validarNota,
  type ReunionDelAcuerdo,
} from './supplier-agreements.domain';

/**
 * `[PQ.3.10]` Compras › Proveedores › Acuerdos — el acceso a la base (C2). Cada función recibe la transacción con el
 * tenant ya puesto (`TenantKnexService.run`): la RLS de producción aplica aquí igual que en la prueba
 * `database/tests/test-newdb-pq3-10-acuerdos-api.js`, que carga ESTE archivo con ts-node y escribe como `app_runtime`.
 *
 * Tabla: `commercial.supplier_agreements` (migración 20261126232231). El proveedor NO se copia: se deriva de la reunión
 * (ADR-056). Quién escribió se guarda por id de usuario. Nada se borra: el acuerdo se cancela con nota.
 */

const AGREEMENTS = 'commercial.supplier_agreements';
const MEETINGS = 'commercial.supplier_meetings';
const TZ = 'America/Mexico_City';
const ISO = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ABIERTOS: readonly EstadoAcuerdo[] = ['pending', 'in_progress'];

/**
 * Un acuerdo con su reunión de origen, el proveedor de esa reunión (la ficha viva primero, como Citas) y los nombres de
 * quien es responsable, quien lo asignó y quien lo cerró. El `WHERE` y el `ORDER BY` los pone quien llama, siempre desde
 * código (nunca de la pantalla).
 */
const SELECT_ACUERDO = `
  SELECT a.id, a.meeting_id, m.supplier_code, s.name AS supplier_name,
         to_char(m.starts_at AT TIME ZONE '${TZ}', 'YYYY-MM-DD') AS meeting_date,
         a.area, a.description, a.supplier_contact,
         a.assigned_to::text AS assigned_to_id, rt.nombre AS assigned_to_nombre,
         to_char(a.due_date, 'YYYY-MM-DD') AS due_date, a.status,
         cb.nombre AS closed_by, ${ISO('a.closed_at')} AS closed_at, a.closing_note,
         ab.nombre AS assigned_by, ${ISO('a.assigned_at')} AS assigned_at
    FROM ${AGREEMENTS} a
    JOIN ${MEETINGS} m ON m.tenant_id = a.tenant_id AND m.id = a.meeting_id
    LEFT JOIN LATERAL (
      SELECT x.name FROM catalog.suppliers x
       WHERE x.tenant_id = m.tenant_id AND x.code = m.supplier_code
       ORDER BY (x.deleted_at IS NULL) DESC, x.updated_at DESC LIMIT 1) s ON true
    LEFT JOIN identity.users rt ON rt.id = a.assigned_to
    LEFT JOIN identity.users ab ON ab.id = a.assigned_by
    LEFT JOIN identity.users cb ON cb.id = a.closed_by`;

type FilaAcuerdo = Omit<AcuerdoVista, 'situacion' | 'acciones' | 'assigned_to'> & {
  assigned_to_id: string;
  assigned_to_nombre: string | null;
};

/** Los acuerdos que cumplen `where`, armados para la pantalla (situación y botones con la regla del dominio). */
async function leerAcuerdos(
  trx: Knex.Transaction, tenant: string, hoy: string, where: string, binds: readonly Knex.RawBinding[], orden: string, limite?: number,
): Promise<AcuerdoVista[]> {
  const { rows } = await trx.raw(
    `${SELECT_ACUERDO} WHERE a.tenant_id = ? AND (${where}) ORDER BY ${orden}${limite ? ` LIMIT ${Math.trunc(limite)}` : ''}`,
    [tenant, ...binds],
  );
  return (rows as FilaAcuerdo[]).map((f): AcuerdoVista => {
    const { assigned_to_id, assigned_to_nombre, ...resto } = f;
    return {
      ...resto,
      assigned_to: { user_id: assigned_to_id, nombre: assigned_to_nombre ?? '(sin nombre)' },
      situacion: situacion(f, hoy),
      acciones: acciones(f.status),
    };
  });
}

const EN = (estados: readonly EstadoAcuerdo[]) => `a.status IN (${estados.map((e) => `'${e}'`).join(', ')})`;

/**
 * `GET /compras/proveedores/acuerdos` — los abiertos (vencido, vence hoy, esta semana, al día; lo más atrasado arriba)
 * y los últimos cerrados. Los conteos por situación los saca la base con las MISMAS fronteras que `situacion()` del
 * dominio (lo vigila la prueba contra Postgres): «esta semana» = de mañana a seis días.
 */
export async function leerLista(trx: Knex.Transaction, tenant: string): Promise<ListaAcuerdos> {
  const { hoy } = await relojMx(trx);
  const topeA = LIMITES_ACUERDOS.abiertos;
  const topeC = LIMITES_ACUERDOS.cerrados;
  const abiertos = ordenar(await leerAcuerdos(trx, tenant, hoy, EN(ABIERTOS), [], 'a.due_date, a.id', topeA), hoy);
  const cerrados = ordenar(await leerAcuerdos(trx, tenant, hoy, EN(ESTADOS_ACUERDO_CERRADOS), [], 'a.closed_at DESC, a.id', topeC), hoy);
  const { rows } = await trx.raw(`
    SELECT count(*) FILTER (WHERE ${EN(ABIERTOS)})::int AS abiertos,
           count(*) FILTER (WHERE ${EN(ABIERTOS)} AND a.due_date < ?::date)::int AS vencido,
           count(*) FILTER (WHERE ${EN(ABIERTOS)} AND a.due_date = ?::date)::int AS vence_hoy,
           count(*) FILTER (WHERE ${EN(ABIERTOS)} AND a.due_date > ?::date AND a.due_date <= ?::date + 6)::int AS esta_semana,
           count(*) FILTER (WHERE ${EN(ABIERTOS)} AND a.due_date > ?::date + 6)::int AS al_dia,
           count(*) FILTER (WHERE ${EN(ESTADOS_ACUERDO_CERRADOS)})::int AS cerrados
      FROM ${AGREEMENTS} a WHERE a.tenant_id = ?`, [hoy, hoy, hoy, hoy, hoy, tenant]);
  const c = rows[0];
  return {
    hoy,
    abiertos: {
      total: c.abiertos, tope: topeA, acuerdos: abiertos,
      por_situacion: { vencido: c.vencido, vence_hoy: c.vence_hoy, esta_semana: c.esta_semana, al_dia: c.al_dia },
    },
    cerrados: { total: c.cerrados, tope: topeC, acuerdos: cerrados },
  };
}

interface Reunion extends ReunionDelAcuerdo {
  readonly id: string;
  readonly supplier_code: string;
  readonly organizer_nombre: string | null;
}

/** La reunión de la que sale (o saldría) un acuerdo. */
async function leerReunion(trx: Knex.Transaction, tenant: string, meetingId: string): Promise<Reunion> {
  const { rows } = await trx.raw(`
    SELECT m.id, m.status, m.supplier_code, m.organizer_user_id::text AS organizer_user_id, org.nombre AS organizer_nombre,
           to_char(m.starts_at AT TIME ZONE '${TZ}', 'YYYY-MM-DD') AS fecha
      FROM ${MEETINGS} m
      LEFT JOIN identity.users org ON org.id = m.organizer_user_id
     WHERE m.tenant_id = ? AND m.id = ?`, [tenant, meetingId]);
  if (!rows[0]) throw new AcuerdosError('no_encontrado', 'La reunión no existe.');
  return rows[0] as Reunion & { status: EstadoReunion };
}

/**
 * `GET /compras/proveedores/acuerdos/reunion/:meetingId` — sus acuerdos, si recibe más (y por qué no), y lo que sigue
 * abierto con el MISMO proveedor de otras reuniones.
 */
export async function leerDeReunion(trx: Knex.Transaction, tenant: string, meetingId: string): Promise<AcuerdosDeReunion> {
  const { hoy } = await relojMx(trx);
  const r = await leerReunion(trx, tenant, meetingId);
  const acuerdos = ordenar(await leerAcuerdos(trx, tenant, hoy, 'a.meeting_id = ?', [meetingId], 'a.due_date, a.id'), hoy);
  const tope = LIMITES_ACUERDOS.del_proveedor;
  const OTROS = `m.supplier_code = ? AND a.meeting_id <> ? AND ${EN(ABIERTOS)}`;
  const otros = ordenar(await leerAcuerdos(trx, tenant, hoy, OTROS, [r.supplier_code, meetingId], 'a.due_date, a.id', tope), hoy);
  const { rows } = await trx.raw(`
    SELECT count(*)::int AS n FROM ${AGREEMENTS} a
      JOIN ${MEETINGS} m ON m.tenant_id = a.tenant_id AND m.id = a.meeting_id
     WHERE a.tenant_id = ? AND ${OTROS}`, [tenant, r.supplier_code, meetingId]);
  return {
    hoy,
    meeting_id: r.id,
    meeting_date: r.fecha,
    no_recibe: porQueNoRecibe(r),
    organizer: { user_id: r.organizer_user_id, nombre: r.organizer_nombre ?? '(sin nombre)' },
    acuerdos,
    del_proveedor: { total: rows[0].n, tope, acuerdos: otros },
  };
}

/**
 * Quién puede ser el responsable que pide la pantalla (DC44): una persona ACTIVA que AGENDA Citas (por rol o por persona;
 * los roles de plataforma pasan, como al invitar en Citas). DC44: «crean, cambian y cierran los que agendan; Dirección los
 * ve; cada responsable cierra el suyo». Quien sólo ve Citas no podría cerrar el suyo: un acuerdo en su «Mi trabajo» sin
 * salida (lo encontró la revisión independiente del PR). Al editar, quien ya era responsable se conserva aunque haya
 * perdido la llave (como el participante en Citas), pero no si ya no está activo: nadie vería el acuerdo.
 * Regresa el conjunto que el dominio consulta; el acuerdo del proveedor no lo usa (lo pone el servidor, DC43).
 */
async function responsables(trx: Knex.Transaction, tenant: string, dto: CapturarAcuerdoDto, actual: string | null): Promise<Set<string>> {
  const pedido = typeof dto?.assigned_to === 'string' ? dto.assigned_to.trim().toLowerCase() : '';
  if (dto?.area === 'supplier' || !UUID.test(pedido)) return new Set();
  const f: { activo: boolean; deleted_at: string | null; role_name: string | null; agenda: boolean } | undefined = await trx('identity.users as u')
    .where('u.tenant_id', tenant).andWhere('u.id', pedido)
    .select('u.activo', 'u.deleted_at', 'u.role_name', trx.raw(`${permisoEfectivoSql('u')} AS agenda`, [LLAVE_AGENDAR, LLAVE_AGENDAR]))
    .first();
  if (!f || !f.activo || f.deleted_at) throw new AcuerdosError('invalido', 'Esa persona ya no está activa en la Suite: elige a otra.');
  if (f.agenda || isPlatformAdminRole(f.role_name) || pedido === actual) return new Set([pedido]);
  return new Set();
}

/** Un CHECK o la llave a la reunión que la base rechazó: el dominio debió atajarlo; si llega aquí, se dice, no es un 500. */
async function conLaBase<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    const code = (e as { code?: string })?.code;
    if (code === '23514') throw new AcuerdosError('invalido', `La base rechazó el acuerdo (${(e as { constraint?: string }).constraint ?? 'una regla'}).`);
    if (code === '23503') throw new AcuerdosError('no_encontrado', 'La reunión no existe.');
    throw e;
  }
}

/** `POST /compras/proveedores/acuerdos/reunion/:meetingId` — captura un acuerdo de una reunión realizada. */
export async function capturar(trx: Knex.Transaction, tenant: string, quien: Quien, meetingId: string, dto: CapturarAcuerdoDto): Promise<AcuerdoGuardado> {
  const reunion = await leerReunion(trx, tenant, meetingId);
  // Primero si la reunión recibe (409): antes que revisar al responsable, que daría un 400 que no es el motivo.
  const motivo = porQueNoRecibe(reunion);
  if (motivo) throw new AcuerdosError('conflicto', motivo);
  const a = validarAcuerdo(dto, reunion, await responsables(trx, tenant, dto, null));
  const id = await conLaBase(async () => {
    const [fila] = await trx(AGREEMENTS).insert({
      tenant_id: tenant, meeting_id: meetingId, area: a.area, description: a.description, supplier_contact: a.supplier_contact,
      assigned_to: a.assigned_to, assigned_by: quien.userId, due_date: a.due_date, created_by: quien.userId, updated_by: quien.userId,
    }).returning('id');
    return (fila?.id ?? fila) as string;
  });
  return { id };
}

/** El acuerdo bloqueado para escribirle (dos personas a la vez: la segunda espera y ve lo que hizo la primera). */
async function tomar(trx: Knex.Transaction, tenant: string, id: string) {
  const { rows } = await trx.raw(`
    SELECT a.id, a.meeting_id, a.status, a.assigned_to::text AS assigned_to
      FROM ${AGREEMENTS} a WHERE a.tenant_id = ? AND a.id = ? FOR UPDATE`, [tenant, id]);
  if (!rows[0]) throw new AcuerdosError('no_encontrado', 'El acuerdo no existe.');
  return rows[0] as { id: string; meeting_id: string; status: EstadoAcuerdo; assigned_to: string };
}

/**
 * `POST …/:id/editar` — cambia lo acordado, el área, el responsable o la fecha de un acuerdo ABIERTO. Cambiar el
 * responsable deja quién lo reasignó y cuándo (`assigned_by`, `assigned_at`); todo cambio deja `updated_by`.
 */
export async function editar(trx: Knex.Transaction, tenant: string, quien: Quien, id: string, dto: CapturarAcuerdoDto): Promise<AcuerdoGuardado> {
  const fila = await tomar(trx, tenant, id);
  exigir('editar', fila.status);
  const reunion = await leerReunion(trx, tenant, fila.meeting_id);
  const a = validarAcuerdo(dto, reunion, await responsables(trx, tenant, dto, fila.assigned_to));
  const reasignado = a.assigned_to !== fila.assigned_to.toLowerCase();
  await conLaBase(() => trx(AGREEMENTS).where({ tenant_id: tenant, id }).update({
    area: a.area, description: a.description, supplier_contact: a.supplier_contact, assigned_to: a.assigned_to, due_date: a.due_date,
    ...(reasignado ? { assigned_by: quien.userId, assigned_at: trx.fn.now() } : {}),
    updated_by: quien.userId, updated_at: trx.fn.now(),
  }));
  return { id };
}

/** `POST …/:id/iniciar` — de pendiente a en curso. */
export async function iniciar(trx: Knex.Transaction, tenant: string, quien: Quien, id: string): Promise<AcuerdoGuardado> {
  const fila = await tomar(trx, tenant, id);
  exigir('iniciar', fila.status);
  await trx(AGREEMENTS).where({ tenant_id: tenant, id })
    .update({ status: estadoTras('iniciar'), updated_by: quien.userId, updated_at: trx.fn.now() });
  return { id };
}

/** `POST …/:id/cumplir` y `POST …/:id/cancelar` — siempre con nota; quedan quién y cuándo. Son finales. */
export async function cerrar(
  trx: Knex.Transaction, tenant: string, quien: Quien, id: string, accion: 'cumplir' | 'cancelar', dto: unknown,
): Promise<AcuerdoGuardado> {
  const note = validarNota(dto);
  const fila = await tomar(trx, tenant, id);
  exigir(accion, fila.status);
  await conLaBase(() => trx(AGREEMENTS).where({ tenant_id: tenant, id }).update({
    status: estadoTras(accion), closed_at: trx.fn.now(), closed_by: quien.userId, closing_note: note,
    updated_by: quien.userId, updated_at: trx.fn.now(),
  }));
  return { id };
}
