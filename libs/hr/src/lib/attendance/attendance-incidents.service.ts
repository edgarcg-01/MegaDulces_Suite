import { BadRequestException, ConflictException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import type { Knex } from 'knex';
import { TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import * as reader from './attendance-reader';
import {
  banderasDe, rechazoDelPaso, textoSemanaCerrada, validarCaptura, PASOS, TODOS_LOS_ESTADOS, TIPOS_INCIDENCIA,
  type Accion, type BanderaIncidencia, type CapturaIncidencia, type EstadoIncidencia,
} from './logic/incidencias';
import { RE_FECHA } from './logic/fechas';

/**
 * Fase RH · `[RH.1.6]` — INCIDENCIAS: captura, flujo de 6 estados, bitácora y el candado de la
 * semana cerrada. Traslado de las rutas de `mega-talento-90/api/src/incidencias.ts`; las reglas
 * puras viven en `logic/incidencias.ts`.
 *
 *   · Cada paso corre en UNA transacción con la fila tomada `FOR UPDATE`, y deja su renglón en
 *     `hr.attendance_incident_log` (sólo agregar: `app_runtime` no puede editarla ni borrarla).
 *   · Nada se borra: quitar es ANULAR, con quién, cuándo y por qué.
 *   · Una semana cerrada para prenómina no se toca: capturar, calificar o quitar algo en ella
 *     responde 409 hasta que se reabra. Auditar sí se puede: es justo lo que se hace sobre lo cerrado.
 *
 * ══ LA INCIDENCIA ES EL ÚNICO MECANISMO (decisión de `[RH.1.5]`) ══
 * Mega Talento tenía dos formas de justificar un día: la incidencia (tipada) y la "revisión"
 * (`asistencia_revision`, texto libre). La revisión excusaba por coincidencia de palabras y se
 * escribía SIN pasar por el candado de semana cerrada: justificar con ella cambiaba el número de
 * una semana ya pagada. En la Suite no se escribe: sus filas viejas se leen (para que los números
 * históricos salgan igual) y todo lo nuevo entra como incidencia.
 */

/** Quién da el paso, con lo que el controlador sabe de sus permisos. */
export interface ActorIncidencia {
  puedeCalificar: boolean;
  puedeAuditar: boolean;
}

export interface FilaIncidencia {
  id: string;
  site_code: string;
  person_code: string;
  incident_type: string;
  date_from: string;
  date_to: string;
  minutes: number | null;
  note: string | null;
  status: EstadoIncidencia;
  authorized_by_name: string | null;
  base_schedule_minutes: number | null;
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
  rated_by: string | null;
  rated_by_name: string | null;
  rated_at: string | null;
  rejection_reason: string | null;
  audited_by: string | null;
  audited_by_name: string | null;
  audited_at: string | null;
  audit_note: string | null;
  voided_by: string | null;
  voided_by_name: string | null;
  voided_at: string | null;
  void_reason: string | null;
  hd_30d?: number | null;
  banderas?: BanderaIncidencia[];
}

const SELECT_FILA = `
  i.id, i.site_code, i.person_code, i.incident_type,
  to_char(i.date_from, 'YYYY-MM-DD') AS date_from, to_char(i.date_to, 'YYYY-MM-DD') AS date_to,
  i.minutes, i.note, i.status, i.authorized_by_name, i.base_schedule_minutes,
  i.created_by, i.created_by_name, i.created_at, i.rated_by, i.rated_by_name, i.rated_at, i.rejection_reason,
  i.audited_by, i.audited_by_name, i.audited_at, i.audit_note,
  i.voided_by, i.voided_by_name, i.voided_at, i.void_reason`;

@Injectable()
export class HrAttendanceIncidentsService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  tipos(): typeof TIPOS_INCIDENCIA {
    return TIPOS_INCIDENCIA;
  }

  private quien(): { id: string | null; nombre: string | null } {
    const c = this.tenantCtx.get();
    return { id: c?.userId ?? null, nombre: c?.username ?? null };
  }

  /**
   * Las incidencias que TOCAN el rango. Sin `statuses`, todas menos las anuladas (la bandeja);
   * con `statuses=todas`, también las anuladas (la auditoría).
   */
  async listar(f: { site_code?: string; date_from?: string; date_to?: string; person_code?: string; statuses?: string }): Promise<FilaIncidencia[]> {
    if (!f.site_code || !RE_FECHA.test(String(f.date_from)) || !RE_FECHA.test(String(f.date_to))) {
      throw new BadRequestException('Faltan site_code, date_from y date_to (yyyy-MM-dd).');
    }
    let estados: EstadoIncidencia[] = TODOS_LOS_ESTADOS.filter((e) => e !== 'anulada');
    if (f.statuses === 'todas') estados = TODOS_LOS_ESTADOS;
    else if (f.statuses) estados = f.statuses.split(',').filter((e): e is EstadoIncidencia => (TODOS_LOS_ESTADOS as string[]).includes(e));
    return this.tk.run(this.tenantCtx.requireTenantId(), async (trx) => {
      if (!estados.length) return [];
      // Un marcador por estado: knex expande un arreglo como lista, así que `ANY(?)` no sirve.
      const params: string[] = [String(f.site_code), String(f.date_to), String(f.date_from), ...estados];
      let filtro = '';
      if (f.person_code) { params.push(f.person_code); filtro = ' AND i.person_code = ?'; }
      const { rows } = await trx.raw<{ rows: FilaIncidencia[] }>(`
        SELECT ${SELECT_FILA},
               CASE WHEN i.incident_type = 'horario_distinto' THEN (
                 SELECT count(*)::int FROM hr.attendance_incidents j
                  WHERE j.site_code = i.site_code AND j.person_code = i.person_code
                    AND j.incident_type = 'horario_distinto' AND j.status NOT IN ('anulada', 'rechazada')
                    AND j.date_from BETWEEN i.date_from - 29 AND i.date_from) END AS hd_30d
          FROM hr.attendance_incidents i
         WHERE i.site_code = ? AND i.date_from <= ?::date AND i.date_to >= ?::date
           AND i.status IN (${estados.map(() => '?').join(', ')})${filtro}
         ORDER BY i.date_from, i.created_at`, params);
      return rows.map((r) => ({ ...r, banderas: banderasDe(r) }));
    });
  }

  async bitacora(id: string): Promise<unknown[]> {
    return this.tk.run(this.tenantCtx.requireTenantId(), (trx) =>
      trx('hr.attendance_incident_log').where({ incident_id: id }).orderBy([{ column: 'acted_at' }, { column: 'id' }])
        .select('action', 'status_before', 'status_after', 'actor_id', 'actor_name', 'acted_at', 'detail'));
  }

  /** Captura. Quien puede calificar la deja calificada, salvo que la entregue a propósito. */
  async capturar(body: CapturaIncidencia, actor: ActorIncidencia): Promise<FilaIncidencia> {
    const v = validarCaptura(body);
    if (!v.ok) throw new BadRequestException(v.error);
    const c = v.valor;
    const q = this.quien();
    const directa = actor.puedeCalificar && !c.deliver;
    return this.tk.run(this.tenantCtx.requireTenantId(), async (trx) => {
      if (!(await reader.sitioExiste(trx, c.site_code))) throw new NotFoundException(`No existe el sitio de checado "${c.site_code}".`);
      await this.exigirSemanaAbierta(trx, c.site_code, c.date_from, c.date_to);
      const [fila] = await trx('hr.attendance_incidents').insert({
        tenant_id: this.tenantCtx.requireTenantId(),
        site_code: c.site_code, person_code: c.person_code, incident_type: c.incident_type,
        date_from: c.date_from, date_to: c.date_to, note: c.note, minutes: c.minutes,
        authorized_by_name: c.authorized_by_name, base_schedule_minutes: c.base_schedule_minutes,
        status: directa ? 'calificada' : 'capturada',
        user_id: await this.usuarioDe(trx, c.site_code, c.person_code),
        created_by: q.id, created_by_name: q.nombre,
        rated_by: directa ? q.id : null, rated_by_name: directa ? q.nombre : null, rated_at: directa ? trx.fn.now() : null,
      }).returning('id');
      const id = typeof fila === 'object' ? (fila as { id: string }).id : fila;
      const r = await this.leer(trx, id);
      await this.registrar(trx, r, 'creada', null, directa ? 'Capturada y calificada por quien califica.' : 'Entregada para calificar.');
      return { ...r, banderas: banderasDe(r) };
    });
  }

  /** Un paso sobre una incidencia guardada: calificar, rechazar, anular o auditar. */
  async paso(id: string, accion: string, motivo: string, actor: ActorIncidencia): Promise<FilaIncidencia> {
    if (!(accion in PASOS)) throw new NotFoundException('Paso desconocido.');
    const a = accion as Accion;
    const q = this.quien();
    return this.tk.run(this.tenantCtx.requireTenantId(), async (trx) => {
      const { rows: [actual] } = await trx.raw<{ rows: FilaIncidencia[] }>(
        `SELECT ${SELECT_FILA} FROM hr.attendance_incidents i WHERE i.id = ? FOR UPDATE`, [id]);
      if (!actual) throw new NotFoundException('Esa incidencia ya no existe.');
      const rechazo = rechazoDelPaso(a, actual, { id: q.id, nombre: q.nombre, ...actor }, motivo);
      if (rechazo) throw new HttpException(rechazo.error, rechazo.status);
      if (a !== 'auditar') await this.exigirSemanaAbierta(trx, actual.site_code, actual.date_from, actual.date_to);

      const ahora = trx.fn.now();
      const sets: Record<Accion, Record<string, unknown>> = {
        calificar: { rated_by: q.id, rated_by_name: q.nombre, rated_at: ahora },
        rechazar:  { rated_by: q.id, rated_by_name: q.nombre, rated_at: ahora, rejection_reason: motivo },
        anular:    { voided_by: q.id, voided_by_name: q.nombre, voided_at: ahora, void_reason: motivo },
        auditar:   { audited_by: q.id, audited_by_name: q.nombre, audited_at: ahora, audit_note: motivo || null },
      };
      await trx('hr.attendance_incidents').where({ id })
        .update({ ...sets[a], status: PASOS[a].hacia, updated_at: ahora });
      const r = await this.leer(trx, id);
      await this.registrar(trx, r, PASOS[a].hacia, actual.status, motivo || null);
      return { ...r, banderas: banderasDe(r) };
    });
  }

  private async exigirSemanaAbierta(trx: Knex.Transaction, site: string, desde: string, hasta: string): Promise<void> {
    const cerrado = await reader.cierreQueToca(trx, site, desde, hasta);
    if (cerrado) throw new ConflictException(textoSemanaCerrada(cerrado));
  }

  /** La persona de la Suite detrás del código del reloj, si ya está ligada. */
  private async usuarioDe(trx: Knex.Transaction, site: string, personCode: string): Promise<string | null> {
    const r = await trx('hr.device_enrollments as e')
      .join('hr.attendance_devices as d', function () { this.on('d.tenant_id', 'e.tenant_id').andOn('d.id', 'e.device_id'); })
      .where('d.site_code', site).whereRaw('COALESCE(e.person_code, e.device_user_id) = ?', [personCode])
      .whereNotNull('e.user_id').first('e.user_id');
    return r?.user_id ?? null;
  }

  private async leer(trx: Knex.Transaction, id: string): Promise<FilaIncidencia> {
    const { rows: [r] } = await trx.raw<{ rows: FilaIncidencia[] }>(`SELECT ${SELECT_FILA} FROM hr.attendance_incidents i WHERE i.id = ?`, [id]);
    return r;
  }

  /** La bitácora: la fila completa después de cada acción. */
  async registrar(trx: Knex.Transaction, fila: FilaIncidencia, accion: string, antes: string | null, detalle: string | null): Promise<void> {
    const q = this.quien();
    await trx('hr.attendance_incident_log').insert({
      tenant_id: this.tenantCtx.requireTenantId(), incident_id: fila.id, action: accion,
      status_before: antes, status_after: fila.status, actor_id: q.id, actor_name: q.nombre,
      detail: detalle, row_snapshot: JSON.stringify(fila),
      // `now()` es la hora de la TRANSACCIÓN: el cierre escribe varios pasos en una sola, y con
      // `now()` quedarían empatados y su orden sería al azar.
      acted_at: trx.raw('clock_timestamp()'),
    });
  }
}
