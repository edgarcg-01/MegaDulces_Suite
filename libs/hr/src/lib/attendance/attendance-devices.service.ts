import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Knex } from 'knex';
import { TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import { HrAttendanceIngestService } from './attendance-ingest.service';
import { esRelojDesconocido, nombreParaReloj, semaforoReloj, type Orden } from './logic/relojes';

/**
 * Fase RH · `[RH.1.2]` — ADMINISTRAR LOS RELOJES: el padrón de equipos, su semáforo, los lotes
 * que llegaron y no se aplicaron, y las órdenes al reloj (renombrar, restaurar).
 *
 * Traslado de `relojesRouter` (`ingesta.ts`) y `reloj-comandos.ts` de Mega Talento, con dos
 * diferencias que corrigen defectos de allá:
 *
 *   · La orden lleva el código CRUDO del usuario en CADA reloj. Mega Talento mandaba el código
 *     del SITIO, y el agente busca a la persona por ese código: en un reloj que numera distinto
 *     (el de comida de corporativo) un «renombrar» habría tocado a otra persona o a nadie.
 *   · Se ordena sólo a los relojes donde la persona ESTÁ enrolada (el padrón de cada reloj se
 *     sincroniza en cada lote). Allá se mandaba a todos los relojes del sitio.
 *
 * Borrar a alguien de un reloj NO se expone: Mega Talento lo retiró el 29/09/2026 (RH ya no
 * borra, da de baja). Las órdenes de borrado viejas se conservan por sus RESPALDOS, que son lo
 * que permite «restaurar» (dar de alta de nuevo con su número, nombre, tarjeta y contraseña; la
 * huella y el rostro no vienen en el respaldo y hay que volver a registrarlos en el equipo).
 */

export interface RelojDto {
  site_code?: string;
  label?: string | null;
  ip_address?: string | null;
  port?: unknown;
  ingest_mode?: string;
  comm_key?: unknown;
  is_active?: boolean;
  is_paused?: boolean;
  notes?: string | null;
}

const MODOS = ['agente', 'push', 'manual'];

@Injectable()
export class HrAttendanceDevicesService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly ingest: HrAttendanceIngestService,
  ) {}

  private quien(): { id: string | null; nombre: string | null } {
    const c = this.tenantCtx.get();
    return { id: c?.userId ?? null, nombre: c?.username ?? null };
  }

  /** El padrón de relojes. Los «relojes desconocidos» de la carga no son equipos: no salen. */
  async listar(): Promise<unknown[]> {
    return this.tk.run(this.tenantCtx.requireTenantId(), async (trx) => {
      const rows: Array<{ serial_number: string }> = await trx('hr.attendance_devices as d')
        .leftJoin('hr.attendance_sites as s', function () { this.on('s.tenant_id', 'd.tenant_id').andOn('s.code', 'd.site_code'); })
        .orderBy([{ column: 'd.site_code' }, { column: 'd.label' }])
        .select('d.id', 'd.serial_number', 'd.site_code', 's.name as site_name', 'd.label', 'd.ip_address', 'd.port',
          'd.ingest_mode', 'd.comm_key', 'd.is_active', 'd.is_paused', 'd.notes', 'd.model', 'd.firmware');
      return rows.filter((r) => !esRelojDesconocido(r.serial_number));
    });
  }

  /**
   * El semáforo de cada reloj activo. Mide la última SEÑAL del lector (lote o latido), no la
   * última checada: un reloj vivo sin nadie checando es verde; un reloj sin señal es rojo
   * aunque su última checada sea de hace un minuto.
   */
  async estado(): Promise<unknown[]> {
    return this.tk.run(this.tenantCtx.requireTenantId(), async (trx) => {
      const rows: Array<Record<string, unknown> & { serial_number: string; is_paused: boolean; segundos: number | null }> =
        await trx('hr.attendance_devices').where({ is_active: true })
          .orderBy([{ column: 'site_code' }, { column: 'label' }])
          .select('serial_number', 'site_code', 'label', 'ingest_mode', 'ip_address', 'seen_ip', 'notes', 'is_paused',
            'last_seen_at', 'last_punch_at', 'last_backfill_at', 'record_count', 'logs_in_db', 'clock_drift_seconds',
            'last_error', 'agent_version', 'agent_host',
            trx.raw('EXTRACT(EPOCH FROM (now() - last_seen_at))::int AS segundos'));
      return rows.filter((r) => !esRelojDesconocido(r.serial_number)).map((r) => ({
        serie: r.serial_number, sucursalId: r['site_code'], alias: r['label'] || '', modo: r['ingest_mode'],
        ip: r['seen_ip'] || r['ip_address'] || '', nota: r['notes'] || '',
        ultimaSenal: r['last_seen_at'], ultimaChecada: r['last_punch_at'], ultimoBackfill: r['last_backfill_at'],
        segundosSinSenal: r.segundos, logsEnReloj: r['record_count'], logsEnBase: r['logs_in_db'],
        desfaseRelojSeg: r['clock_drift_seconds'], ultimoError: r['last_error'] || '',
        agenteVersion: r['agent_version'] || '', agenteHost: r['agent_host'] || '',
        semaforo: semaforoReloj({ pendiente: r.is_paused, segundosSinSenal: r.segundos }),
      }));
    });
  }

  /** Alta o edición de un reloj por su serie (la ÚNICA identidad estable del equipo). */
  async guardar(serial: string, b: RelojDto): Promise<unknown> {
    const serie = String(serial || '').trim();
    if (!serie) throw new BadRequestException('Falta la serie.');
    if (esRelojDesconocido(serie)) throw new BadRequestException('Esa serie es la del reloj desconocido de la carga: no es un equipo.');
    const site = String(b.site_code || '').trim();
    if (!site) throw new BadRequestException('Falta el sitio de checado.');
    const modo = b.ingest_mode || 'agente';
    if (!MODOS.includes(modo)) throw new BadRequestException(`Modo inválido: ${modo}.`);
    const puerto = b.port == null || b.port === '' ? 4370 : Number(b.port);
    if (!Number.isInteger(puerto) || puerto < 1 || puerto > 65535) throw new BadRequestException('El puerto va de 1 a 65535.');
    const clave = b.comm_key == null || b.comm_key === '' ? 0 : Number(b.comm_key);
    if (!Number.isInteger(clave) || clave < 0) throw new BadRequestException('La clave de comunicación es un número entero.');
    const q = this.quien();
    return this.tk.run(this.tenantCtx.requireTenantId(), async (trx) => {
      if (!(await trx('hr.attendance_sites').where({ code: site }).first('code'))) {
        throw new NotFoundException(`No existe el sitio de checado "${site}".`);
      }
      const fila = {
        site_code: site, label: b.label ?? null, ip_address: b.ip_address ?? null, port: puerto, ingest_mode: modo,
        comm_key: clave, is_active: b.is_active !== false, is_paused: b.is_paused === true, notes: b.notes ?? null,
        updated_by: q.id, updated_at: trx.fn.now(),
      };
      await trx('hr.attendance_devices').insert({ ...fila, tenant_id: this.tenantCtx.requireTenantId(), serial_number: serie })
        .onConflict(['tenant_id', 'serial_number']).merge(Object.keys(fila));
      return trx('hr.attendance_devices').where({ serial_number: serie })
        .first('id', 'serial_number', 'site_code', 'label', 'ip_address', 'port', 'ingest_mode', 'comm_key', 'is_active', 'is_paused', 'notes');
    });
  }

  /** Lo que llegó y NO se aplicó: series sin registrar y relojes en pausa. Es trabajo de RH. */
  async lotesPendientes(): Promise<unknown[]> {
    return this.tk.run(this.tenantCtx.requireTenantId(), (trx) =>
      trx('hr.ingest_batches').whereIn('status', ['sin_registrar', 'en_pausa']).whereNull('reprocessed_at')
        .groupBy('serial_number', 'source', 'status', 'error')
        .orderByRaw('max(received_at) DESC')
        .select('serial_number', 'source', 'status', 'error',
          trx.raw('count(*)::int AS lotes'), trx.raw('sum(records)::int AS registros'),
          trx.raw('min(received_at) AS primero'), trx.raw('max(received_at) AS ultimo')));
  }

  async reprocesar(serial: string): Promise<{ lotes: number; aplicados: number; aceptadas: number }> {
    return this.ingest.reprocesar(String(serial || '').trim(), this.tenantCtx.requireTenantId());
  }

  // ── Órdenes al reloj ────────────────────────────────────────────────────────────────────

  /** Los relojes del sitio y las órdenes recientes (de una persona, si se pide). */
  async ordenes(f: { site_code?: string; person_code?: string }): Promise<{ relojes: unknown[]; ordenes: unknown[] }> {
    const site = String(f.site_code || '').trim();
    if (!site) throw new BadRequestException('Falta site_code.');
    return this.tk.run(this.tenantCtx.requireTenantId(), async (trx) => {
      const relojes = await this.relojesQueReciben(trx, site);
      const q = trx('hr.device_commands as c')
        .join('hr.attendance_devices as d', function () { this.on('d.tenant_id', 'c.tenant_id').andOn('d.id', 'c.device_id'); })
        .leftJoin('hr.device_enrollments as e', function () {
          this.on('e.tenant_id', 'c.tenant_id').andOn('e.device_id', 'c.device_id').andOn('e.device_user_id', 'c.device_user_id');
        })
        .where('d.site_code', site)
        .orderBy('c.requested_at', 'desc').limit(50)
        .select('c.id', 'c.command', 'c.payload', 'c.status', 'c.attempts', 'c.detail', 'c.requested_at', 'c.completed_at',
          'c.device_user_id', 'd.serial_number', 'd.label',
          trx.raw('COALESCE(e.person_code, c.device_user_id) AS person_code'),
          trx.raw('(c.backup IS NOT NULL) AS con_respaldo'));
      if (f.person_code) q.whereRaw('COALESCE(e.person_code, c.device_user_id) = ?', [String(f.person_code).trim()]);
      return { relojes, ordenes: await q };
    });
  }

  /** Cambia el nombre con el que la persona está en los relojes del sitio (vía el agente). */
  async renombrar(b: { site_code?: string; person_code?: string; name?: unknown }): Promise<{ ok: true; nombre: string; relojes: number }> {
    const site = String(b.site_code || '').trim();
    const persona = String(b.person_code || '').trim();
    const nombre = nombreParaReloj(b.name);
    if (!site || !persona || !nombre) throw new BadRequestException('Faltan el sitio, la persona o un nombre válido.');
    return this.tk.run(this.tenantCtx.requireTenantId(), async (trx) => {
      const destinos = await this.dondeEstaEnrolada(trx, site, persona);
      if (!destinos.length) throw new NotFoundException('Esa persona no está enrolada en ningún reloj activo del sitio.');
      for (const d of destinos) {
        // Lo que ve el sistema cambia ya; el reloj, cuando el agente ejecute la orden.
        await trx('hr.device_enrollments').where({ device_id: d.device_id, device_user_id: d.device_user_id })
          .update({ device_name: nombre, updated_at: trx.fn.now() });
        await this.encolar(trx, d.device_id, d.device_user_id, 'renombrar', { nombre });
      }
      return { ok: true as const, nombre, relojes: destinos.length };
    });
  }

  /**
   * Vuelve a dar de alta a alguien en los relojes de los que se le borró, con el RESPALDO que se
   * guardó al borrarlo. Si su lugar en el equipo lo ocupa otra persona, el agente no lo pisa.
   */
  async restaurar(b: { site_code?: string; person_code?: string }): Promise<{ ok: true; relojes: number }> {
    const site = String(b.site_code || '').trim();
    const persona = String(b.person_code || '').trim();
    if (!site || !persona) throw new BadRequestException('Faltan el sitio y la persona.');
    return this.tk.run(this.tenantCtx.requireTenantId(), async (trx) => {
      const { rows: borrados } = await trx.raw<{ rows: Array<{ device_id: string; device_user_id: string; backup: unknown }> }>(`
        SELECT DISTINCT ON (c.device_id) c.device_id, c.device_user_id, c.backup
          FROM hr.device_commands c
          JOIN hr.attendance_devices d ON d.tenant_id = c.tenant_id AND d.id = c.device_id
          LEFT JOIN hr.device_enrollments e
            ON e.tenant_id = c.tenant_id AND e.device_id = c.device_id AND e.device_user_id = c.device_user_id
         WHERE d.site_code = ? AND COALESCE(e.person_code, c.device_user_id) = ?
           AND c.command = 'borrar' AND c.status = 'hecho' AND c.backup IS NOT NULL
         ORDER BY c.device_id, c.completed_at DESC NULLS LAST`, [site, persona]);
      if (!borrados.length) throw new NotFoundException('No hay respaldo de un borrado de esa persona en los relojes del sitio.');
      for (const x of borrados) await this.encolar(trx, x.device_id, x.device_user_id, 'restaurar', { respaldo: x.backup });
      return { ok: true as const, relojes: borrados.length };
    });
  }

  /** Cancela una orden, sólo mientras siga pendiente. */
  async cancelar(id: string): Promise<{ ok: true }> {
    const q = this.quien();
    return this.tk.run(this.tenantCtx.requireTenantId(), async (trx) => {
      const n = await trx('hr.device_commands').where({ id, status: 'pendiente' }).update({
        status: 'cancelado', detail: `Cancelado por ${q.nombre || 'RH'}`, completed_at: trx.fn.now(), updated_at: trx.fn.now(),
      });
      if (!n) throw new ConflictException('Ya no está pendiente: el agente la tomó o ya terminó.');
      return { ok: true as const };
    });
  }

  // ── piezas ──────────────────────────────────────────────────────────────────────────────

  /** Los relojes a los que el agente les puede escribir en este sitio. */
  private async relojesQueReciben(trx: Knex.Transaction, site: string): Promise<Array<{ id: string; serial_number: string; label: string | null }>> {
    return trx('hr.attendance_devices')
      .where({ site_code: site, is_active: true, is_paused: false, ingest_mode: 'agente' })
      .orderBy('label').select('id', 'serial_number', 'label');
  }

  /** En qué relojes (que reciben órdenes) está enrolada la persona, y con qué código crudo. */
  private async dondeEstaEnrolada(trx: Knex.Transaction, site: string, persona: string): Promise<Array<{ device_id: string; device_user_id: string }>> {
    return trx('hr.device_enrollments as e')
      .join('hr.attendance_devices as d', function () { this.on('d.tenant_id', 'e.tenant_id').andOn('d.id', 'e.device_id'); })
      .where({ 'd.site_code': site, 'd.is_active': true, 'd.is_paused': false, 'd.ingest_mode': 'agente', 'e.is_present': true })
      .whereRaw('COALESCE(e.person_code, e.device_user_id) = ?', [persona])
      .select('e.device_id', 'e.device_user_id');
  }

  /**
   * Deja la orden. Una igual todavía pendiente se REEMPLAZA (renombrar dos veces seguidas no debe
   * dejar dos escrituras compitiendo en el mismo equipo).
   */
  private async encolar(trx: Knex.Transaction, deviceId: string, deviceUserId: string, orden: Orden, payload: Record<string, unknown>): Promise<void> {
    const q = this.quien();
    await trx('hr.device_commands')
      .where({ device_id: deviceId, device_user_id: deviceUserId, status: 'pendiente' })
      .where((w) => { w.where('command', orden); if (orden === 'borrar') w.orWhereNotNull('command'); })
      .update({ status: 'cancelado', detail: 'Reemplazada por una más nueva', completed_at: trx.fn.now(), updated_at: trx.fn.now() });
    await trx('hr.device_commands').insert({
      tenant_id: this.tenantCtx.requireTenantId(), device_id: deviceId, device_user_id: deviceUserId,
      command: orden, payload: JSON.stringify(payload), requested_by: q.id, requested_by_name: q.nombre,
    });
  }
}
