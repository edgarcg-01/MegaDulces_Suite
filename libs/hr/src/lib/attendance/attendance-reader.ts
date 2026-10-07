import type { Knex } from 'knex';
import { configEfectiva } from './logic/config-reglas';
import type { ReglaConfig } from './logic/tipos';
import type { FichaPadron, FilaDia, HorarioAsignado, IncidenciaVigente } from './logic/asistencia-persona';
import type { ChecadaDetector, HorarioSitio, PersonaDetector } from './logic/detector';
import { ESTADOS_VIGENTES, type EstadoIncidencia } from './logic/incidencias';
import { esPromotora } from './logic/tipos';

/**
 * Fase RH · `[RH.1.5]` — lo que la lógica de asistencia lee de la base. Una sola puerta para el
 * agente, la pantalla y el cierre, para que los tres vean lo mismo.
 *
 * Todas las funciones reciben la transacción YA dentro del tenant (`TenantKnexService.run`): el
 * RLS forzado de `hr.*` e `identity.*` hace el aislamiento.
 *
 * ── Las checadas salen de `hr.v_site_punches` ──
 * La vista de `[RH.1.1]` tiene la forma de la tabla `checadas` de Mega Talento: sitio, código de
 * la persona EN EL SITIO, fecha y hora de pared. Se filtra por `punched_at` con un margen de un
 * día a cada lado (lo que usa el índice por reloj) y luego por la hora de pared exacta: el corte
 * del día es el del reloj, no el de UTC.
 *
 * ── `tipo` (entrada/salida) NO se usa, a propósito ──
 * El agente que alimenta Mega Talento nunca lo manda (la librería ZK no lo trae): sus reglas se
 * calibraron con `tipo` vacío en el 100% de las checadas. El lector de la Fase CH sí decodificaba
 * el estado del reloj (`punch_type`), así que mezclarlo encendería las ramas "con tipo" de cuatro
 * reglas sólo para la parte vieja de la historia. El dato queda guardado; usarlo es una decisión
 * de RH sobre relojes que lo marquen bien, no de la mudanza.
 *
 * ── Fechas con `to_char` ──
 * Toda fecha sale como texto 'yyyy-MM-dd': un `date` de pg convertido en JS se corre un día en MX
 * (GOTCHAS, LC.16).
 */

/** Las checadas con fecha anterior a ésta son basura de reloj sin hora (Mega Talento: `DATO_VALIDO`). */
export const DATO_VALIDO_DESDE = '2023-01-01';

export async function cargarConfig(trx: Knex.Transaction, siteCode: string): Promise<ReglaConfig> {
  const rows: Array<{ site_code: string | null; config: unknown }> = await trx('hr.attendance_rules')
    .whereNull('site_code').orWhere('site_code', siteCode).select('site_code', 'config');
  const global = rows.find((r) => r.site_code === null)?.config;
  const propia = rows.find((r) => r.site_code === siteCode)?.config;
  return configEfectiva(siteCode, global, propia);
}

export async function sitioExiste(trx: Knex.Transaction, siteCode: string): Promise<boolean> {
  return !!(await trx('hr.attendance_sites').where({ code: siteCode }).first('code'));
}

// ── Padrón ──────────────────────────────────────────────────────────────────────────────────

interface FilaPadron {
  code: string;
  device_name: string | null;
  user_id: string | null;
  nombre: string | null;
  status: string | null;
  deleted_at: string | null;
  department_code: string | null;
  department_name: string | null;
  position_name: string | null;
  schedule_id: string | null;
}

/**
 * El padrón del sitio: cada código con el que alguien está enrolado en un reloj del sitio, sin
 * los que RH marcó `ignorado` (lo que Mega Talento llamaba `padron_depurado`), con la persona de
 * la Suite cuando el código ya está ligado (ADR-084 D1).
 *
 * Si el mismo código aparece en dos relojes del sitio, manda el que está ligado y, entre iguales,
 * el que se vio más recientemente.
 *
 * `activo`: sin ligar, se mide (es lo que hacía Mega Talento con una ficha nueva); ligado, sólo
 * si la persona está `invited`/`active` y no borrada. `suspended` cuenta como baja: sus
 * ausencias se esperan.
 */
export async function padron(trx: Knex.Transaction, siteCode: string): Promise<{
  fichas: Map<string, FichaPadron>;
  personas: PersonaDetector[];
}> {
  const { rows } = await trx.raw<{ rows: FilaPadron[] }>(`
    WITH enr AS (
      SELECT DISTINCT ON (COALESCE(e.person_code, e.device_user_id))
             COALESCE(e.person_code, e.device_user_id) AS code,
             e.device_name, e.user_id
        FROM hr.device_enrollments e
        JOIN hr.attendance_devices d ON d.tenant_id = e.tenant_id AND d.id = e.device_id
       WHERE d.site_code = ? AND e.match_status <> 'ignorado'
       ORDER BY COALESCE(e.person_code, e.device_user_id), (e.user_id IS NULL), e.last_seen_at DESC
    )
    SELECT enr.code, enr.device_name, enr.user_id,
           u.nombre, u.status, u.deleted_at::text AS deleted_at,
           u.department_code, dep.name AS department_name, pos.name AS position_name,
           ps.schedule_id
      FROM enr
      LEFT JOIN identity.users u ON u.id = enr.user_id
      LEFT JOIN identity.departments dep ON dep.tenant_id = u.tenant_id AND dep.code = u.department_code AND dep.deleted_at IS NULL
      LEFT JOIN identity.positions pos ON pos.tenant_id = u.tenant_id AND pos.code = u.position_code AND pos.deleted_at IS NULL
      LEFT JOIN hr.person_schedules ps ON ps.site_code = ? AND ps.person_code = enr.code`, [siteCode, siteCode]);

  const fichas = new Map<string, FichaPadron>();
  const personas: PersonaDetector[] = [];
  for (const r of rows) {
    const ligado = !!r.user_id && r.nombre !== null;
    const activo = !ligado || ((r.status === 'invited' || r.status === 'active') && !r.deleted_at);
    // El departamento con su código y su nombre: `esPromotora` busca "promotor" en el texto.
    const departamento = ligado ? [r.department_name, r.department_code].filter(Boolean).join(' · ') || null : null;
    const ficha: FichaPadron = {
      userId: ligado ? r.user_id : null,
      registrado: ligado,
      nombre: (ligado && r.nombre) || r.device_name || null,
      nombreCompleto: ligado ? r.nombre : null,
      departamento,
      puesto: r.position_name,
      fotoUrl: null,
      activo,
    };
    fichas.set(r.code, ficha);
    personas.push({
      codigo: r.code,
      nombre: ficha.nombre || r.code,
      horarioId: r.schedule_id,
      excluida: !activo || esPromotora({ departamento }),
    });
  }
  return { fichas, personas };
}

// ── Horarios ────────────────────────────────────────────────────────────────────────────────

export async function horariosDelSitio(trx: Knex.Transaction, siteCode: string): Promise<HorarioSitio[]> {
  const rows: Array<{
    id: string; name: string; weekdays: number[]; entrada: string; salida: string;
    comida_ini: string | null; comida_fin: string | null; tolerance_minutes: number; is_active: boolean;
  }> = await trx('hr.work_schedules').where({ site_code: siteCode }).orderBy('name').select(
    'id', 'name', 'weekdays', 'tolerance_minutes', 'is_active',
    trx.raw(`to_char(starts_at, 'HH24:MI') AS entrada`),
    trx.raw(`to_char(ends_at, 'HH24:MI') AS salida`),
    trx.raw(`to_char(lunch_starts_at, 'HH24:MI') AS comida_ini`),
    trx.raw(`to_char(lunch_ends_at, 'HH24:MI') AS comida_fin`),
  );
  return rows.map((r) => ({
    id: r.id, nombre: r.name, dias: (r.weekdays || []).map(Number), entrada: r.entrada, salida: r.salida,
    inicioComida: r.comida_ini, finComida: r.comida_fin, toleranciaMin: r.tolerance_minutes || 0, activo: r.is_active,
  }));
}

/**
 * Los horarios que RH confirmó por persona. Con UNA entrada y salida es un horario COMPLETO
 * (asignado desde el portal): contra él se miden retardo, faltas, salida antes y comida. Sin
 * salida es una confirmación de entrada (la del bot), y con 2–3 entradas es un rotativo.
 */
export async function confirmados(trx: Knex.Transaction, siteCode: string): Promise<{
  turnos: Map<string, string[]>;
  asignados: Map<string, HorarioAsignado>;
}> {
  const rows: Array<{
    person_code: string; turnos: string[] | null; salida: string | null; lunch_minutes: number | null;
    works_saturday: boolean; sab_ent: string | null; sab_sal: string | null;
    confirmed_by_name: string | null; updated_at: string | null;
  }> = await trx('hr.person_schedules').where({ site_code: siteCode }).select(
    'person_code', 'lunch_minutes', 'works_saturday', 'confirmed_by_name',
    trx.raw(`ARRAY(SELECT to_char(t, 'HH24:MI') FROM unnest(shift_starts) t ORDER BY t) AS turnos`),
    trx.raw(`to_char(ends_at, 'HH24:MI') AS salida`),
    trx.raw(`to_char(saturday_starts_at, 'HH24:MI') AS sab_ent`),
    trx.raw(`to_char(saturday_ends_at, 'HH24:MI') AS sab_sal`),
    trx.raw(`to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS updated_at`),
  );
  const turnos = new Map<string, string[]>();
  const asignados = new Map<string, HorarioAsignado>();
  for (const r of rows) {
    const t = (r.turnos || []).filter(Boolean);
    if (!t.length) continue;
    turnos.set(r.person_code, t);
    if (r.salida && t.length === 1) {
      asignados.set(r.person_code, {
        entrada: t[0], salida: r.salida, comidaMin: Number(r.lunch_minutes) || 0,
        sabado: !!r.works_saturday, sabadoEntrada: r.sab_ent, sabadoSalida: r.sab_sal,
        asignadoPor: r.confirmed_by_name, actualizadoEn: r.updated_at,
      });
    }
  }
  return { turnos, asignados };
}

// ── Checadas ────────────────────────────────────────────────────────────────────────────────

/** El filtro común: sitio + rango de fechas de pared, con el margen que usa el índice. */
const FILTRO_RANGO = `
  site_code = ?
  AND punched_at >= (?::date - 1)::timestamptz AND punched_at < (?::date + 2)::timestamptz
  AND punched_local >= ?::date AND punched_local < (?::date + 1)
  AND punched_local >= '${DATO_VALIDO_DESDE}'::date`;
const bindRango = (siteCode: string, desde: string, hasta: string): string[] => [siteCode, desde, hasta, desde, hasta];

/** Un renglón por persona-día con todas sus horas (la pantalla de asistencia). */
export async function diasPorPersona(trx: Knex.Transaction, siteCode: string, desde: string, hasta: string): Promise<FilaDia[]> {
  const { rows } = await trx.raw<{ rows: Array<{ codigo: string; nombre_reloj: string | null; fecha: string; horas: string[] }> }>(`
    SELECT person_code AS codigo, max(person_name) AS nombre_reloj, work_date AS fecha,
           array_agg(punch_time ORDER BY punch_time) AS horas
      FROM hr.v_site_punches
     WHERE ${FILTRO_RANGO}
     GROUP BY person_code, work_date
     ORDER BY person_code, work_date`, bindRango(siteCode, desde, hasta));
  return rows.map((r) => ({ codigo: r.codigo, nombreReloj: r.nombre_reloj || '', fecha: r.fecha, horas: r.horas }));
}

/** Cada checada del rango (el agente de alertas). `tipo` va vacío: ver la cabecera. */
export async function checadasDelRango(trx: Knex.Transaction, siteCode: string, desde: string, hasta: string): Promise<ChecadaDetector[]> {
  const { rows } = await trx.raw<{ rows: Array<{ codigo: string; nombre: string | null; fecha: string; fecha_hora: string; hora: string }> }>(`
    SELECT person_code AS codigo, person_name AS nombre, work_date AS fecha,
           to_char(punched_local, 'YYYY-MM-DD"T"HH24:MI:SS') AS fecha_hora, punch_time AS hora
      FROM hr.v_site_punches
     WHERE ${FILTRO_RANGO}
     ORDER BY person_code, punched_local`, bindRango(siteCode, desde, hasta));
  return rows.map((r) => ({ codigo: r.codigo, nombre: r.nombre, fecha: r.fecha, fechaHora: r.fecha_hora, hora: r.hora, tipo: null }));
}

/**
 * Silencio (días sin aparecer) y días con UNA marca, sobre TODA la historia del sitio. El
 * silencio se mide contra el último día con dato DEL SITIO, nunca contra hoy (los relojes se
 * descargan a ritmos distintos).
 */
export async function contextoHistorico(trx: Knex.Transaction, siteCode: string): Promise<{
  silencio: Map<string, number>;
  unaMarca: Map<string, { dias: number; conUna: number }>;
}> {
  const { rows } = await trx.raw<{ rows: Array<{ codigo: string; silencio: number; dias: number; con_una: number }> }>(`
    WITH d AS (
      SELECT person_code, punched_local::date AS fecha, count(*) AS marcas
        FROM hr.v_site_punches
       WHERE site_code = ? AND punched_local >= '${DATO_VALIDO_DESDE}'::date
       GROUP BY 1, 2
    ), fin AS (SELECT max(fecha) AS fin FROM d)
    SELECT person_code AS codigo,
           ((SELECT fin FROM fin) - max(fecha))::int AS silencio,
           count(*)::int AS dias,
           count(*) FILTER (WHERE marcas = 1)::int AS con_una
      FROM d GROUP BY person_code`, [siteCode]);
  const silencio = new Map<string, number>();
  const unaMarca = new Map<string, { dias: number; conUna: number }>();
  for (const r of rows) {
    silencio.set(r.codigo, Number(r.silencio));
    unaMarca.set(r.codigo, { dias: r.dias, conUna: r.con_una });
  }
  return { silencio, unaMarca };
}

/** Quien lleva `dias` o más sin aparecer → la fecha de su última checada (el corte del agente). */
export async function ultimaChecadaDeSilenciosos(trx: Knex.Transaction, siteCode: string, dias: number): Promise<Map<string, string>> {
  const { rows } = await trx.raw<{ rows: Array<{ codigo: string; ultima: string }> }>(`
    WITH d AS (
      SELECT person_code, max(punched_local::date) AS ultima
        FROM hr.v_site_punches
       WHERE site_code = ? AND punched_local >= '${DATO_VALIDO_DESDE}'::date
       GROUP BY 1
    ), fin AS (SELECT max(ultima) AS fin FROM d)
    SELECT person_code AS codigo, to_char(ultima, 'YYYY-MM-DD') AS ultima
      FROM d, fin WHERE fin.fin - d.ultima >= ?`, [siteCode, dias]);
  return new Map(rows.map((r) => [r.codigo, r.ultima]));
}

/**
 * Qué tiene que revisar el agente en cada sitio: primer y último día con dato y cuántas checadas
 * caen en la ventana rodante. `<= hoy` no es paranoia: un reloj con la hora mal puesta graba
 * fechas futuras, y una sola correría la ventana de todo el sitio.
 */
export async function ventanas(trx: Knex.Transaction, hoy: string, ventanaDias: number): Promise<Array<{
  site_code: string; primero: string; ultimo: string; en_ventana: number;
}>> {
  const { rows } = await trx.raw<{ rows: Array<{ site_code: string; primero: string; ultimo: string; en_ventana: number }> }>(`
    WITH lim AS (
      SELECT site_code, min(punched_local::date) AS primero, max(punched_local::date) AS ultimo
        FROM hr.v_site_punches
       WHERE punched_local >= '${DATO_VALIDO_DESDE}'::date AND punched_local < (?::date + 1)
       GROUP BY site_code
    )
    SELECT l.site_code, to_char(l.primero, 'YYYY-MM-DD') AS primero, to_char(l.ultimo, 'YYYY-MM-DD') AS ultimo,
           (SELECT count(*)::int FROM hr.v_site_punches c
             WHERE c.site_code = l.site_code
               AND c.punched_local >= greatest(l.primero, l.ultimo - (?::int - 1))
               AND c.punched_local < l.ultimo + 1) AS en_ventana
      FROM lim l
      JOIN hr.attendance_sites s ON s.code = l.site_code
     ORDER BY l.site_code`, [hoy, ventanaDias]);
  return rows;
}

// ── Incidencias y justificantes ─────────────────────────────────────────────────────────────

/** Las incidencias que TOCAN el rango (no sólo las que empiezan en él). Por omisión, las vigentes. */
export async function incidenciasEnRango(
  trx: Knex.Transaction, siteCode: string, desde: string, hasta: string,
  estados: EstadoIncidencia[] = ESTADOS_VIGENTES,
): Promise<IncidenciaVigente[]> {
  const rows: Array<{ id: string; person_code: string; incident_type: string; desde: string; hasta: string; note: string | null; minutes: number | null }> =
    await trx('hr.attendance_incidents')
      .where({ site_code: siteCode })
      .where('date_from', '<=', hasta).where('date_to', '>=', desde)
      .whereIn('status', estados)
      .orderBy([{ column: 'date_from' }, { column: 'created_at' }])
      .select('id', 'person_code', 'incident_type', 'note', 'minutes',
        trx.raw(`to_char(date_from, 'YYYY-MM-DD') AS desde`), trx.raw(`to_char(date_to, 'YYYY-MM-DD') AS hasta`));
  return rows.map((r) => ({
    id: r.id, personCode: r.person_code, tipo: r.incident_type, desde: r.desde, hasta: r.hasta,
    nota: r.note || '', minutos: r.minutes == null ? null : Number(r.minutes),
  }));
}

/**
 * Justificantes viejos de texto libre aprobados (`hr.attendance_reviews`, histórico de Mega
 * Talento). En la Suite ya no se escriben —el mecanismo es la incidencia, ver `[RH.1.5]` en la
 * fase—, pero se leen para que los números de semanas viejas salgan igual que allá.
 */
export async function revisionesAprobadas(trx: Knex.Transaction, siteCode: string, desde: string, hasta: string): Promise<Map<string, Map<string, string>>> {
  const rows: Array<{ person_code: string; fecha: string; justification: string }> = await trx('hr.attendance_reviews')
    .where({ site_code: siteCode, status: 'aprobada' }).whereNotNull('justification')
    .whereBetween('work_date', [desde, hasta])
    .select('person_code', 'justification', trx.raw(`to_char(work_date, 'YYYY-MM-DD') AS fecha`));
  const out = new Map<string, Map<string, string>>();
  for (const r of rows) {
    if (!out.has(r.person_code)) out.set(r.person_code, new Map());
    (out.get(r.person_code) as Map<string, string>).set(r.fecha, r.justification);
  }
  return out;
}

/** El cierre VIGENTE del sitio que toca el rango, o null. */
export async function cierreQueToca(trx: Knex.Transaction, siteCode: string, desde: string, hasta: string): Promise<{
  id: string; period_start: string; period_end: string; closed_by_name: string | null;
} | null> {
  const r = await trx('hr.attendance_closures')
    .where({ site_code: siteCode }).whereNull('reopened_at')
    .where('period_start', '<=', hasta).where('period_end', '>=', desde)
    .orderBy('period_start').first('id', 'closed_by_name',
      trx.raw(`to_char(period_start, 'YYYY-MM-DD') AS period_start`),
      trx.raw(`to_char(period_end, 'YYYY-MM-DD') AS period_end`));
  return r || null;
}
