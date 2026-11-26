import type { Knex } from 'knex';
import {
  AREAS_PARTICIPANTE, LIMITES_REUNION,
  type AgendaCitas, type AgendarReunionDto, type ChoqueReunion, type DetalleReunion, type OpcionesCitas, type ParticipanteVista,
  type ProveedoresCitas, type ReunionGuardada, type ReunionVista,
} from '@megadulces/contracts';
import { applySmartSearch, isPlatformAdminRole, permisoEfectivoSql, smartSearchRank } from '@megadulces/platform-core';
import {
  acciones, areaDelPuesto, cambiosDeParticipantes, choquesDe, CitasError, exigir, semanaDe, situacion, validarMinuta, validarMotivo,
  validarReunion, type ParticipanteGuardado, type ParticipanteNormalizado, type ReunionParaChoque,
} from './supplier-meetings.domain';

/**
 * `[PQ.3.8]` Compras › Proveedores › Citas — el acceso a la base (C2). Cada función recibe la transacción con el tenant
 * ya puesto (`TenantKnexService.run`): la RLS de producción aplica aquí igual que en la prueba
 * `database/tests/test-newdb-pq3-8-citas-api.js`, que carga ESTE archivo con ts-node y escribe como `app_runtime`.
 *
 * Tablas: `commercial.supplier_meetings` y `commercial.supplier_meeting_participants` (migración 20261125203927).
 * Quién escribió se guarda por **id de usuario** (un username se puede renombrar, AU.34). Nada se borra: la reunión se
 * cancela con motivo y el participante se quita con fecha.
 */

export interface Quien {
  readonly userId: string;
  readonly username: string | null;
}

/** Las llaves de Citas (DC41). Quien va a una reunión por Mega Dulces tiene que poder verla. */
export const LLAVE_VER = 'COMPRAS_CITAS_VER';
export const LLAVE_AGENDAR = 'COMPRAS_CITAS_AGENDAR';

const MEETINGS = 'commercial.supplier_meetings';
const PARTS = 'commercial.supplier_meeting_participants';
const TZ = 'America/Mexico_City';
const ISO = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;

/** La fecha de hoy en la Ciudad de México y el instante de ahora, del reloj de la base (el mismo para todos). */
export async function relojMx(trx: Knex | Knex.Transaction): Promise<{ hoy: string; ahora: string }> {
  const { rows } = await trx.raw(`SELECT to_char((now() AT TIME ZONE '${TZ}')::date, 'YYYY-MM-DD') AS hoy, ${ISO('now()')} AS ahora`);
  return rows[0];
}

/**
 * Una reunión con su proveedor (la ficha viva primero, como el Calendario) y los nombres de quien organiza, escribió
 * la minuta o canceló. El `WHERE` y el `ORDER BY` los pone quien llama, siempre desde código (nunca de la pantalla).
 */
const SELECT_REUNION = `
  SELECT m.id, m.supplier_code, s.name AS supplier_name, m.kind, m.status,
         to_char(m.starts_at AT TIME ZONE '${TZ}', 'YYYY-MM-DD') AS date,
         to_char(m.starts_at AT TIME ZONE '${TZ}', 'HH24:MI') AS start_time,
         to_char(m.ends_at AT TIME ZONE '${TZ}', 'HH24:MI') AS end_time,
         ${ISO('m.starts_at')} AS starts_at, ${ISO('m.ends_at')} AS ends_at,
         m.mode, m.location, m.topics, m.work_plan_year, m.organizer_user_id, org.nombre AS organizer_nombre,
         m.minutes, mb.nombre AS minutes_by, ${ISO('m.minutes_at')} AS minutes_at,
         m.cancelled_reason, cb.nombre AS cancelled_by, ${ISO('m.cancelled_at')} AS cancelled_at
    FROM ${MEETINGS} m
    LEFT JOIN LATERAL (
      SELECT x.name FROM catalog.suppliers x
       WHERE x.tenant_id = m.tenant_id AND x.code = m.supplier_code
       ORDER BY (x.deleted_at IS NULL) DESC, x.updated_at DESC LIMIT 1) s ON true
    LEFT JOIN identity.users org ON org.id = m.organizer_user_id
    LEFT JOIN identity.users mb ON mb.id::text = m.minutes_by
    LEFT JOIN identity.users cb ON cb.id::text = m.cancelled_by`;

type FilaReunion = Omit<ReunionVista, 'situacion' | 'acciones' | 'organizer' | 'participants' | 'choques'> & {
  organizer_user_id: string;
  organizer_nombre: string | null;
};

type FilaParticipante = ParticipanteVista & { meeting_id: string };

/**
 * La gente viva de cada reunión, en un orden ESTABLE: primero Mega Dulces por área (el orden del contrato) y nombre,
 * después el proveedor por nombre. No por `created_at`: los que se guardan juntos comparten la hora de la transacción
 * y saldrían al azar (lo encontró la prueba contra Postgres real).
 */
async function leerParticipantes(trx: Knex.Transaction, tenant: string, ids: readonly string[]): Promise<FilaParticipante[]> {
  if (!ids.length) return [];
  const { rows } = await trx.raw(`
    SELECT p.id, p.meeting_id, p.side, p.user_id, p.area, COALESCE(u.nombre, p.name, '(sin nombre)') AS nombre, p.job_title
      FROM ${PARTS} p
      LEFT JOIN identity.users u ON u.id = p.user_id
     WHERE p.tenant_id = ? AND p.meeting_id = ANY(?::uuid[]) AND p.removed_at IS NULL
     ORDER BY p.side, array_position(?::text[], p.area), lower(COALESCE(u.nombre, p.name, '')), p.id`,
  [tenant, [...ids], [...AREAS_PARTICIPANTE]]);
  return rows;
}

/** Las reuniones que cumplen `where`, armadas para la pantalla. Los choques se buscan entre las mismas reuniones. */
async function leerReuniones(
  trx: Knex.Transaction, tenant: string, ahora: string, where: string, binds: readonly Knex.RawBinding[], orden: string, limite?: number,
): Promise<ReunionVista[]> {
  const { rows } = await trx.raw(
    `${SELECT_REUNION} WHERE m.tenant_id = ? AND (${where}) ORDER BY ${orden}${limite ? ` LIMIT ${Math.trunc(limite)}` : ''}`,
    [tenant, ...binds],
  );
  const filas = rows as FilaReunion[];
  const participantes = await leerParticipantes(trx, tenant, filas.map((f) => f.id));
  const porReunion = new Map<string, ParticipanteVista[]>();
  for (const p of participantes) {
    const { meeting_id, ...vista } = p;
    porReunion.set(meeting_id, [...(porReunion.get(meeting_id) ?? []), vista]);
  }
  const paraChoque: ReunionParaChoque[] = filas.map((f) => ({
    ...f, internos: (porReunion.get(f.id) ?? []).filter((p) => p.side === 'internal' && p.user_id)
      .map((p) => ({ user_id: p.user_id as string, nombre: p.nombre })),
  }));
  const choques = choquesDe(paraChoque, ahora);
  return filas.map((f): ReunionVista => {
    const { organizer_user_id, organizer_nombre, ...resto } = f;
    return {
      ...resto,
      topics: f.topics ?? [],
      work_plan_year: f.work_plan_year == null ? null : Number(f.work_plan_year),
      situacion: situacion(f, ahora),
      acciones: acciones(f, ahora),
      organizer: { user_id: organizer_user_id, nombre: organizer_nombre ?? '(sin nombre)' },
      participants: porReunion.get(f.id) ?? [],
      choques: choques.get(f.id) ?? [],
    };
  });
}

/** `GET /compras/proveedores/citas?semana=` — la semana que contiene `fecha` (hoy, si no llega) y lo pendiente. */
export async function leerAgenda(trx: Knex.Transaction, tenant: string, fecha?: string | null): Promise<AgendaCitas> {
  const { hoy, ahora } = await relojMx(trx);
  const semana = semanaDe(fecha || hoy);
  const reuniones = await leerReuniones(trx, tenant, ahora,
    `m.starts_at >= (?::date)::timestamp AT TIME ZONE '${TZ}' AND m.starts_at < ((?::date + 1)::timestamp AT TIME ZONE '${TZ}')`,
    [semana.desde, semana.hasta], 'm.starts_at, m.id');
  const ABIERTA_PASADA = `m.status IN ('scheduled', 'to_confirm') AND m.ends_at <= now()`;
  const tope = LIMITES_REUNION.sin_minuta;
  const pendientes = await leerReuniones(trx, tenant, ahora, ABIERTA_PASADA, [], 'm.starts_at, m.id', tope);
  const { rows } = await trx.raw(`
    SELECT count(*) FILTER (WHERE ${ABIERTA_PASADA})::int AS sin_minuta,
           count(*) FILTER (WHERE m.status = 'to_confirm' AND m.ends_at > now())::int AS por_confirmar
      FROM ${MEETINGS} m WHERE m.tenant_id = ?`, [tenant]);
  return {
    hoy, semana, reuniones,
    sin_minuta: { total: rows[0].sin_minuta, tope, reuniones: pendientes },
    por_confirmar: rows[0].por_confirmar,
  };
}

/** Las reuniones del mismo día que `id` (para sus choques), con `id` entre ellas. */
async function delMismoDia(trx: Knex.Transaction, tenant: string, ahora: string, id: string): Promise<ReunionVista[]> {
  return leerReuniones(trx, tenant, ahora,
    `(m.starts_at AT TIME ZONE '${TZ}')::date = (SELECT (x.starts_at AT TIME ZONE '${TZ}')::date FROM ${MEETINGS} x WHERE x.tenant_id = m.tenant_id AND x.id = ?)`,
    [id], 'm.starts_at, m.id');
}

/** `GET /compras/proveedores/citas/:id` — la reunión (con sus choques del día) y la anterior REALIZADA con el proveedor. */
export async function leerDetalle(trx: Knex.Transaction, tenant: string, id: string): Promise<DetalleReunion> {
  const { ahora } = await relojMx(trx);
  const reunion = (await delMismoDia(trx, tenant, ahora, id)).find((r) => r.id === id);
  if (!reunion) throw new CitasError('no_encontrada', 'La reunión no existe.');
  const [anterior] = await leerReuniones(trx, tenant, ahora,
    `m.supplier_code = ? AND m.status = 'held' AND m.id <> ? AND m.starts_at < ?::timestamptz`,
    [reunion.supplier_code, id, reunion.starts_at], 'm.starts_at DESC, m.id', 1);
  return { reunion, anterior: anterior ?? null };
}

/** Quien ve la agenda (llave efectiva: rol o permiso por persona). Sin los roles de plataforma, como en el Calendario. */
const VE_LA_AGENDA = `(${permisoEfectivoSql('u')} OR ${permisoEfectivoSql('u')})`;
const LLAVES_VE = [LLAVE_VER, LLAVE_VER, LLAVE_AGENDAR, LLAVE_AGENDAR];

/** `GET /compras/proveedores/citas/opciones` — quién puede ir por Mega Dulces, con el área que propone su puesto. */
export async function leerOpciones(trx: Knex.Transaction, tenant: string): Promise<OpcionesCitas> {
  const filas: { user_id: string; nombre: string | null; role_name: string | null }[] = await trx('identity.users as u')
    .where('u.tenant_id', tenant).andWhere('u.activo', true).whereNull('u.deleted_at')
    .whereRaw(VE_LA_AGENDA, LLAVES_VE)
    .select('u.id as user_id', 'u.nombre', 'u.role_name')
    .orderBy('u.nombre');
  return {
    personas: filas.filter((f) => !isPlatformAdminRole(f.role_name)).map((f) => ({
      user_id: f.user_id, nombre: f.nombre ?? '(sin nombre)', puesto: f.role_name ?? '', area: areaDelPuesto(f.role_name),
    })),
  };
}

/**
 * `GET /compras/proveedores/citas/proveedores?q=` — el buscador común (`applySmartSearch`, `[BU]`) sobre las claves de
 * proveedor del catálogo, una por clave (la ficha viva primero; también la clave que sólo tiene ficha borrada, R4) y sin
 * los internos. Sin texto, nada: el selector pide escribir.
 */
export async function buscarProveedores(trx: Knex.Transaction, tenant: string, q: string | null | undefined): Promise<ProveedoresCitas> {
  const tope = LIMITES_REUNION.proveedores;
  const texto = (q ?? '').trim().slice(0, 80);
  if (!texto) return { proveedores: [], tope };
  const columnas = ['s.name', 's.code'];
  const qb = trx.from(trx.raw(`(
      SELECT DISTINCT ON (x.code) x.code, x.name
        FROM catalog.suppliers x
       WHERE x.tenant_id = ? AND x.code IS NOT NULL AND btrim(x.code) <> '' AND x.is_internal IS NOT TRUE
       ORDER BY x.code, (x.deleted_at IS NULL) DESC, x.updated_at DESC) AS s`, [tenant]))
    .select('s.code', 's.name');
  applySmartSearch(qb, texto, { columns: columnas });
  const rank = smartSearchRank(texto, { columns: columnas });
  if (rank) qb.orderByRaw(`${rank.sql}, s.name`, rank.bindings);
  else qb.orderBy('s.name');
  const proveedores: { code: string; name: string | null }[] = await qb.limit(tope);
  return { proveedores, tope };
}

/** La clave tiene que estar en el catálogo (cualquier ficha, también borrada: R4). */
async function exigirProveedor(trx: Knex.Transaction, tenant: string, code: string): Promise<void> {
  const hay = await trx('catalog.suppliers').where({ tenant_id: tenant, code }).first('id');
  if (!hay) throw new CitasError('invalida', `La clave ${code} no está en el catálogo de proveedores.`);
}

/**
 * Las personas de Mega Dulces que se agregan: activas y que VEN la agenda (DC41). A quien no la ve no se le invita: no
 * podría abrir la reunión. Los roles de plataforma pasan (modo dios del guard). Sólo se revisan las que se AGREGAN: al
 * editar, quien ya estaba no se saca porque haya perdido la llave.
 */
async function exigirPersonas(trx: Knex.Transaction, tenant: string, nuevas: readonly ParticipanteNormalizado[]): Promise<void> {
  const ids = nuevas.filter((p) => p.side === 'internal').map((p) => p.user_id as string);
  if (!ids.length) return;
  const filas: { id: string; nombre: string | null; role_name: string | null; ve: boolean }[] = await trx('identity.users as u')
    .where('u.tenant_id', tenant).andWhere('u.activo', true).whereNull('u.deleted_at')
    .whereIn('u.id', ids)
    .select('u.id', 'u.nombre', 'u.role_name', trx.raw(`${VE_LA_AGENDA} AS ve`, LLAVES_VE));
  const porId = new Map(filas.map((f) => [String(f.id).toLowerCase(), f]));
  for (const id of ids) {
    const f = porId.get(id);
    if (!f) throw new CitasError('invalida', 'Una de las personas elegidas ya no está activa en la Suite.');
    if (!f.ve && !isPlatformAdminRole(f.role_name)) {
      throw new CitasError('invalida', `${f.nombre ?? 'Esa persona'} no ve la agenda de Citas: pide que le den la llave antes de invitarla.`);
    }
  }
}

/** Un CHECK o el índice único que la base rechazó: el dominio debió atajarlo; si llega aquí, se dice, no es un 500. */
async function conLaBase<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    const code = (e as { code?: string })?.code;
    if (code === '23505') throw new CitasError('conflicto', 'Esa persona ya está en la reunión (otra persona la agregó al mismo tiempo): vuelve a abrirla.');
    if (code === '23514') throw new CitasError('invalida', `La base rechazó la reunión (${(e as { constraint?: string }).constraint ?? 'una regla'}).`);
    throw e;
  }
}

const filaParticipante = (tenant: string, meetingId: string, quien: Quien, p: ParticipanteNormalizado) => ({
  tenant_id: tenant, meeting_id: meetingId, side: p.side, user_id: p.user_id, area: p.area, name: p.name, job_title: p.job_title,
  created_by: quien.userId,
});

async function choquesDeLaReunion(trx: Knex.Transaction, tenant: string, id: string): Promise<readonly ChoqueReunion[]> {
  const { ahora } = await relojMx(trx);
  return (await delMismoDia(trx, tenant, ahora, id)).find((r) => r.id === id)?.choques ?? [];
}

const INICIO = `(?::date + ?::time) AT TIME ZONE '${TZ}'`;

/** `POST /compras/proveedores/citas` — agenda la reunión con su gente. Quien la agenda queda como quien la organiza. */
export async function agendar(trx: Knex.Transaction, tenant: string, quien: Quien, dto: AgendarReunionDto): Promise<ReunionGuardada> {
  const { hoy } = await relojMx(trx);
  const r = validarReunion(dto, hoy);
  await exigirProveedor(trx, tenant, r.supplier_code);
  await exigirPersonas(trx, tenant, r.participants);
  const id = await conLaBase(async () => {
    const { rows } = await trx.raw(`
      INSERT INTO ${MEETINGS} (tenant_id, supplier_code, kind, status, starts_at, ends_at, mode, location, topics,
                               organizer_user_id, work_plan_year, created_by, updated_by)
      VALUES (?, ?, ?, ?, ${INICIO}, ${INICIO}, ?, ?, ?::text[], ?, ?, ?, ?)
      RETURNING id`, [
      tenant, r.supplier_code, r.kind, r.status, r.date, r.start_time, r.date, r.end_time, r.mode, r.location, r.topics,
      quien.userId, r.work_plan_year, quien.userId, quien.userId,
    ]);
    const nueva: string = rows[0].id;
    await trx(PARTS).insert(r.participants.map((p) => filaParticipante(tenant, nueva, quien, p)));
    return nueva;
  });
  return { id, choques: await choquesDeLaReunion(trx, tenant, id) };
}

/** La reunión bloqueada para escribirle (dos personas a la vez: la segunda espera y ve lo que hizo la primera). */
async function tomar(trx: Knex.Transaction, tenant: string, id: string) {
  const { rows } = await trx.raw(`
    SELECT m.id, m.status, ${ISO('m.starts_at')} AS starts_at, ${ISO('m.ends_at')} AS ends_at
      FROM ${MEETINGS} m WHERE m.tenant_id = ? AND m.id = ? FOR UPDATE`, [tenant, id]);
  if (!rows[0]) throw new CitasError('no_encontrada', 'La reunión no existe.');
  const { ahora } = await relojMx(trx);
  return { fila: rows[0] as { id: string; status: 'to_confirm' | 'scheduled' | 'held' | 'cancelled'; starts_at: string; ends_at: string }, ahora };
}

/**
 * `POST …/:id/editar` — reprograma o cambia temas, lugar, tipo, proveedor o gente de una reunión ABIERTA. Los
 * participantes que llegan son la lista completa (`cambiosDeParticipantes`): primero se quitan, después se agregan.
 */
export async function editar(trx: Knex.Transaction, tenant: string, quien: Quien, id: string, dto: AgendarReunionDto): Promise<ReunionGuardada> {
  const { fila, ahora } = await tomar(trx, tenant, id);
  exigir('editar', fila, ahora);
  const { hoy } = await relojMx(trx);
  const r = validarReunion(dto, hoy, true);
  await exigirProveedor(trx, tenant, r.supplier_code);
  const guardados: ParticipanteGuardado[] = await trx(PARTS).where({ tenant_id: tenant, meeting_id: id }).whereNull('removed_at')
    .select('id', 'side', 'user_id', 'area', 'name', 'job_title');
  const { quitar, agregar } = cambiosDeParticipantes(guardados, r.participants);
  await exigirPersonas(trx, tenant, agregar);
  await conLaBase(async () => {
    await trx.raw(`
      UPDATE ${MEETINGS}
         SET supplier_code = ?, kind = ?, starts_at = ${INICIO}, ends_at = ${INICIO}, mode = ?, location = ?, topics = ?::text[],
             work_plan_year = ?, updated_by = ?, updated_at = now()
       WHERE tenant_id = ? AND id = ?`, [
      r.supplier_code, r.kind, r.date, r.start_time, r.date, r.end_time, r.mode, r.location, r.topics, r.work_plan_year,
      quien.userId, tenant, id,
    ]);
    if (quitar.length) {
      await trx(PARTS).where({ tenant_id: tenant, meeting_id: id }).whereIn('id', quitar).whereNull('removed_at')
        .update({ removed_at: trx.fn.now(), removed_by: quien.userId });
    }
    if (agregar.length) await trx(PARTS).insert(agregar.map((p) => filaParticipante(tenant, id, quien, p)));
  });
  return { id, choques: await choquesDeLaReunion(trx, tenant, id) };
}

/** `POST …/:id/confirmar` — el ejecutivo confirmó el horario: de «por confirmar» a «agendada». */
export async function confirmar(trx: Knex.Transaction, tenant: string, quien: Quien, id: string): Promise<{ id: string }> {
  const { fila, ahora } = await tomar(trx, tenant, id);
  exigir('confirmar', fila, ahora);
  await trx(MEETINGS).where({ tenant_id: tenant, id }).update({ status: 'scheduled', updated_by: quien.userId, updated_at: trx.fn.now() });
  return { id };
}

/** `POST …/:id/minuta` — la reunión se realizó: queda con su minuta, quién la escribió y cuándo (§9.1). */
export async function escribirMinuta(trx: Knex.Transaction, tenant: string, quien: Quien, id: string, dto: unknown): Promise<{ id: string }> {
  const minutes = validarMinuta(dto);
  const { fila, ahora } = await tomar(trx, tenant, id);
  exigir('minuta', fila, ahora);
  await conLaBase(() => trx(MEETINGS).where({ tenant_id: tenant, id }).update({
    status: 'held', minutes, minutes_by: quien.userId, minutes_at: trx.fn.now(), updated_by: quien.userId, updated_at: trx.fn.now(),
  }));
  return { id };
}

/** `POST …/:id/cancelar` — con el motivo; nada se borra. */
export async function cancelar(trx: Knex.Transaction, tenant: string, quien: Quien, id: string, dto: unknown): Promise<{ id: string }> {
  const reason = validarMotivo(dto);
  const { fila, ahora } = await tomar(trx, tenant, id);
  exigir('cancelar', fila, ahora);
  await conLaBase(() => trx(MEETINGS).where({ tenant_id: tenant, id }).update({
    status: 'cancelled', cancelled_reason: reason, cancelled_by: quien.userId, cancelled_at: trx.fn.now(),
    updated_by: quien.userId, updated_at: trx.fn.now(),
  }));
  return { id };
}
