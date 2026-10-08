import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type { Knex } from 'knex';
import { TenantKnexService, latirCron } from '@megadulces/platform-core';
import { PREFIJO_RELOJ_DESCONOCIDO, estadoTrasIntento, tipoParaAgente, type Orden } from './logic/relojes';
import {
  IncomingBatch,
  NormalizedPunch,
  clockDriftSeconds,
  deviceUsers,
  lastDateByCode,
  latestLocal,
  normalizePunches,
  normalizeSource,
} from './ingest-batch';

/**
 * Fase RH · `[RH.1.2]` — entrada de checadas de los relojes a `hr.*`.
 *
 * Traslado de `aplicarLote` de Mega Talento (ADR-084: se traslada la lógica que ya funciona
 * en producción, no se reescribe), sobre el esquema de la Fase CH extendido en `[RH.1.1]`:
 *
 *   - Serie desconocida → el lote se guarda CRUDO sin aplicar (`sin_registrar`). No se
 *     inventa sitio: atribuir marcas a la plaza equivocada no se nota y no se deshace.
 *   - Reloj en pausa o inactivo → crudo sin aplicar (`en_pausa`); el latido sí cuenta.
 *   - Quien checa, existe: un código que checa sin estar en el padrón del reloj recibe su
 *     enrolamiento («Empleado <código>»). Antes la gente nueva tardaba semanas en aparecer.
 *   - Un enrolamiento ignorado que vuelve a checar DESPUÉS de ignorarse pasa a `pendiente`:
 *     alguien trabaja con ese número y esconderlo lo sacaba de todo.
 *   - El nombre que manda el reloj sólo RELLENA, nunca pisa lo que corrigió RH.
 *   - Idempotente: la llave natural de la checada es (reloj, usuario del reloj, instante).
 *   - Puente con el histórico (`[RH.1.8]`, traslado del `NOT EXISTS` de Mega Talento): una checada
 *     que ya está en el RELOJ DESCONOCIDO de su sitio (misma persona, mismo instante de pared) no se
 *     vuelve a meter. Ver `insertPunches`.
 *   - El lote crudo sólo se guarda si NO se aplicó (lo aplicado ya está en attendance_logs).
 *
 * El tenant es explícito (`HR_INGEST_TENANT_ID`, o el de Mega Dulces): quien llama es una
 * máquina, no una sesión. Todo pasa por `TenantKnexService.run` para respetar el RLS.
 */
export interface IngestResult {
  estado: 'aplicado' | 'pendiente' | 'serie_desconocida';
  serie: string;
  sucursalId: string | null;
  recibidas: number;
  aceptadas: number;
  duplicadas: number;
  rechazadas: number;
  loteId: string | null;
  siguienteBackfillMin: number;
  mensaje?: string;
  /** Códigos ignorados que volvieron a checar y quedaron para revisión. */
  reaparecidos?: string[];
}

export interface HeartbeatBody {
  serie?: string;
  ip?: string | null;
  error?: string | null;
  agenteVersion?: string | null;
  agenteHost?: string | null;
  infoReloj?: IncomingBatch['infoReloj'];
}

interface DeviceRow {
  id: string;
  site_code: string | null;
  timezone: string;
  is_paused: boolean;
  is_active: boolean;
}

interface RegistryRow {
  serial_number: string;
  site_code: string | null;
  label: string | null;
  ip_address: string | null;
  port: number;
  ingest_mode: string;
  comm_key: number;
  is_paused: boolean;
  notes: string | null;
}

export const HR_INGEST_JOB_KEY = 'hr_attendance_ingest';
const MEGA_DULCES_TENANT = '00000000-0000-0000-0000-00000000d01c';
const CHUNK = 500;

/** El tenant de lo que llega de máquina a máquina (el lector no tiene sesión). */
export function tenantDeMaquina(): string {
  return process.env['HR_INGEST_TENANT_ID'] || process.env['DEFAULT_TENANT_ID'] || MEGA_DULCES_TENANT;
}

/** Una orden al reloj tal como la espera el agente de Mega Talento (`escritura.js`). */
export interface OrdenParaAgente {
  id: string;
  serie: string;
  sucursalId: string | null;
  /** El código CRUDO del usuario en ESE reloj (no el del sitio: ver `[RH.1.2]` en la fase). */
  empleadoCodigo: string;
  tipo: string;
  payload: Record<string, unknown>;
  estado: string;
  intentos: number;
  detalle: string;
  alias: string;
  creadoEn: string;
}

@Injectable()
export class HrAttendanceIngestService {
  private readonly logger = new Logger(HrAttendanceIngestService.name);

  constructor(private readonly tk: TenantKnexService) {}

  private tenantId(): string {
    return tenantDeMaquina();
  }

  private backfillMinutes(): number {
    const n = parseInt(process.env['HR_BACKFILL_MIN'] || '60', 10);
    return Number.isFinite(n) && n > 0 ? n : 60;
  }

  /** Un lote de checadas. */
  async ingest(batch: IncomingBatch): Promise<IngestResult> {
    const started = Date.now();
    const serial = String(batch?.serie ?? '').trim();
    if (!serial) throw new BadRequestException('Falta la serie del reloj.');
    const incoming = Array.isArray(batch.checadas) ? batch.checadas : [];
    const tenant = this.tenantId();
    const base: IngestResult = {
      estado: 'aplicado', serie: serial, sucursalId: null,
      recibidas: incoming.length, aceptadas: 0, duplicadas: 0, rechazadas: 0,
      loteId: null, siguienteBackfillMin: this.backfillMinutes(),
    };

    const result = await this.tk.run(tenant, (trx) => this.aplicar(trx, tenant, batch, base, true));
    await this.beat(tenant, result.aceptadas, Date.now() - started);
    return result;
  }

  /**
   * El corazón de la ingesta, dentro de una transacción ya abierta. `guardarLote = false` es
   * para el REPROCESO: el lote ya tiene su renglón en `hr.ingest_batches` y no se duplica.
   */
  private async aplicar(
    trx: Knex.Transaction, tenant: string, batch: IncomingBatch, base: IngestResult, guardarLote: boolean,
  ): Promise<IngestResult> {
    const serial = base.serie;
    const source = normalizeSource(batch.origen);
    const incoming = Array.isArray(batch.checadas) ? batch.checadas : [];
    const device = await this.findDevice(trx, serial);

    if (!device) {
      const loteId = guardarLote
        ? await this.saveBatch(trx, tenant, null, serial, source, incoming.length, 0, 'sin_registrar', batch, 'serie desconocida')
        : null;
      return { ...base, estado: 'serie_desconocida' as const, loteId,
        mensaje: `La serie ${serial} no está en el padrón de relojes. El lote se guardó sin aplicar.` };
    }
    base.sucursalId = device.site_code;

    if (device.is_paused || !device.is_active) {
      const motivo = device.is_paused ? 'reloj en pausa (pendiente de identificar o mapear)' : 'reloj inactivo';
      const loteId = guardarLote
        ? await this.saveBatch(trx, tenant, device.id, serial, source, incoming.length, 0, 'en_pausa', batch, motivo)
        : null;
      if (guardarLote) await this.touch(trx, tenant, device, batch, null);
      return { ...base, estado: 'pendiente' as const, loteId,
        mensaje: `El reloj ${serial} está en pausa: el lote se guardó pero no se aplicó.` };
    }

    const { rows, rejected } = normalizePunches(incoming);
    base.rechazadas = rejected;
    await this.upsertEnrollments(trx, tenant, device.id, deviceUsers(batch.usuarios), rows);
    const reaparecidos = await this.flagReappearances(trx, tenant, device.id, rows);
    const aceptadas = await this.insertPunches(trx, tenant, device, source, rows);
    // En el reproceso el lote es VIEJO: no es señal de vida del reloj, así que no toca su latido.
    if (guardarLote) await this.touch(trx, tenant, device, batch, latestLocal(rows));
    const loteId = guardarLote
      ? await this.saveBatch(trx, tenant, device.id, serial, source, incoming.length, aceptadas, 'aplicado', null, null)
      : null;
    if (reaparecidos.length) {
      this.logger.warn(`reloj ${serial}: ${reaparecidos.length} número(s) ignorado(s) volvieron a checar y quedan para revisión: ${reaparecidos.join(', ')}`);
    }
    return { ...base, aceptadas, duplicadas: rows.length - aceptadas, loteId, reaparecidos };
  }

  /**
   * Aplica los lotes que se habían guardado sin aplicar (serie sin registrar o reloj en pausa),
   * ya que se dio de alta la serie o el reloj salió de pausa. Es lo que hace que «no perder el
   * dato» sea verdad. En orden de llegada; se detiene en el primero que todavía no se puede.
   */
  async reprocesar(serial: string, tenantId: string): Promise<{ lotes: number; aplicados: number; aceptadas: number }> {
    return this.tk.run(tenantId, async (trx) => {
      const pendientes: Array<{ id: string; raw: IncomingBatch; records: number }> = await trx('hr.ingest_batches')
        .where({ serial_number: serial }).whereIn('status', ['sin_registrar', 'en_pausa'])
        .whereNull('reprocessed_at').whereNotNull('raw')
        .orderBy('received_at').select('id', 'raw', 'records');
      let aplicados = 0, aceptadas = 0;
      for (const lote of pendientes) {
        const base: IngestResult = {
          estado: 'aplicado', serie: serial, sucursalId: null, recibidas: lote.records, aceptadas: 0,
          duplicadas: 0, rechazadas: 0, loteId: lote.id, siguienteBackfillMin: this.backfillMinutes(),
        };
        const r = await this.aplicar(trx, tenantId, { ...lote.raw, serie: serial }, base, false);
        if (r.estado !== 'aplicado') break;
        aplicados++;
        aceptadas += r.aceptadas;
        const device = await this.findDevice(trx, serial);
        await trx('hr.ingest_batches').where({ id: lote.id }).update({
          status: 'aplicado', accepted: Math.min(r.aceptadas, lote.records), raw: null,
          device_id: device?.id ?? null, reprocessed_at: trx.fn.now(),
        });
      }
      return { lotes: pendientes.length, aplicados, aceptadas };
    });
  }

  /** Las órdenes pendientes para un reloj, de la más vieja a la más nueva (el agente las ejecuta). */
  async ordenesPendientes(serial: string): Promise<OrdenParaAgente[]> {
    const serie = String(serial || '').trim();
    if (!serie) throw new BadRequestException('Falta serie.');
    return this.tk.run(this.tenantId(), async (trx) => {
      const rows: Array<{ id: string; device_user_id: string; command: Orden; payload: Record<string, unknown> | null;
        status: string; attempts: number; detail: string | null; requested_at: Date; serial_number: string;
        site_code: string | null; label: string | null }> = await trx('hr.device_commands as c')
        .join('hr.attendance_devices as d', function () { this.on('d.tenant_id', 'c.tenant_id').andOn('d.id', 'c.device_id'); })
        .where('d.serial_number', serie).where('c.status', 'pendiente')
        .orderBy('c.requested_at').limit(20)
        .select('c.id', 'c.device_user_id', 'c.command', 'c.payload', 'c.status', 'c.attempts', 'c.detail', 'c.requested_at',
          'd.serial_number', 'd.site_code', 'd.label');
      return rows.map((r) => ({
        id: r.id, serie: r.serial_number, sucursalId: r.site_code, empleadoCodigo: r.device_user_id,
        tipo: tipoParaAgente(r.command), payload: r.payload || {}, estado: r.status, intentos: r.attempts,
        detalle: r.detail || '', alias: r.label || '', creadoEn: new Date(r.requested_at).toISOString(),
      }));
    });
  }

  /**
   * El agente reporta un intento. Un error se reintenta hasta 3 veces; después se queda en
   * `error`, a la vista. El respaldo (el usuario como estaba ANTES de tocarlo) se conserva.
   */
  async reportarOrden(id: string, body: { estado?: string; detalle?: string; respaldo?: unknown }): Promise<{ ok: true }> {
    if (body?.estado !== 'hecho' && body?.estado !== 'error') throw new BadRequestException('estado inválido');
    const reporte = body.estado;
    await this.tk.run(this.tenantId(), async (trx) => {
      const cmd: { attempts: number } | undefined = await trx('hr.device_commands')
        .where({ id, status: 'pendiente' }).forUpdate().first('attempts');
      if (!cmd) return;
      const status = estadoTrasIntento(reporte, cmd.attempts);
      await trx('hr.device_commands').where({ id }).update({
        attempts: Math.min(cmd.attempts + 1, 3), status, detail: String(body.detalle || '').slice(0, 500),
        backup: body.respaldo ? trx.raw('?::jsonb', [JSON.stringify(body.respaldo)]) : trx.raw('backup'),
        completed_at: status === 'pendiente' ? null : trx.fn.now(), updated_at: trx.fn.now(),
      });
    });
    return { ok: true };
  }

  /** El lector avisa que sigue vivo (y qué falla, si algo falla). */
  async heartbeat(body: HeartbeatBody): Promise<{ status: number; body: Record<string, unknown> }> {
    const serial = String(body?.serie ?? '').trim();
    if (!serial) throw new BadRequestException('Falta la serie del reloj.');
    const tenant = this.tenantId();
    const out = await this.tk.run(tenant, async (trx) => {
      const device = await this.findDevice(trx, serial);
      if (!device) return { status: 409, body: { error: `La serie ${serial} no está en el padrón.` } };
      if (body.error) {
        // Un latido CON error también es señal de vida, pero el error se conserva:
        // es lo que la pantalla de relojes tiene que poder explicar.
        await trx('hr.attendance_devices').where({ id: device.id }).update({
          last_seen_at: trx.fn.now(),
          last_error: String(body.error).slice(0, 500),
          seen_ip: body.ip || undefined,
          agent_version: body.agenteVersion || undefined,
          agent_host: body.agenteHost || undefined,
        });
      } else {
        await this.touch(trx, tenant, device, { serie: serial, ip: body.ip, agenteVersion: body.agenteVersion,
          agenteHost: body.agenteHost, infoReloj: body.infoReloj }, null);
      }
      return { status: 200, body: { ok: true, siguienteBackfillMin: this.backfillMinutes() } };
    });
    if (out.status === 200) await this.beat(tenant, 0, 0);
    return out;
  }

  /** El padrón de relojes que le toca al lector (las llaves son las que ya entiende el agente). */
  async registry(filters: { sucursalId?: string; modo?: string }): Promise<Array<Record<string, unknown>>> {
    return this.tk.run(this.tenantId(), async (trx) => {
      const q = trx('hr.attendance_devices')
        .where({ is_active: true })
        .select('serial_number', 'site_code', 'label', 'ip_address', 'port', 'ingest_mode', 'comm_key', 'is_paused', 'notes')
        .orderBy([{ column: 'site_code' }, { column: 'label' }]);
      if (filters.sucursalId) q.andWhere('site_code', filters.sucursalId);
      if (filters.modo) q.andWhere('ingest_mode', filters.modo);
      const rows = await q;
      return rows.map((r: RegistryRow) => ({
        serie: r.serial_number, sucursalId: r.site_code, alias: r.label, ip: r.ip_address, puerto: r.port,
        modo: r.ingest_mode, commKey: r.comm_key, pendiente: r.is_paused, nota: r.notes,
      }));
    });
  }

  // ── piezas ──────────────────────────────────────────────────────────────────

  private async findDevice(trx: Knex.Transaction, serial: string): Promise<DeviceRow | undefined> {
    return trx('hr.attendance_devices')
      .where({ serial_number: serial })
      .first('id', 'site_code', 'timezone', 'is_paused', 'is_active');
  }

  private async upsertEnrollments(
    trx: Knex.Transaction, tenant: string, deviceId: string, names: Map<string, string>, rows: NormalizedPunch[],
  ): Promise<void> {
    if (names.size) {
      // El nombre del reloj sólo RELLENA: si RH corrigió el apodo del reloj por el nombre
      // completo de la persona, el siguiente lote no se lo deshace. `updated_at` NO se toca aquí: marca
      // cambios humanos, y de eso depende saber si un número ignorado volvió a checar después.
      await trx.raw(
        `INSERT INTO hr.device_enrollments (tenant_id, device_id, device_user_id, device_name, is_present, first_seen_at, last_seen_at)
         SELECT ?::uuid, ?::uuid, u.code, u.name, true, now(), now()
           FROM jsonb_to_recordset(?::jsonb) AS u(code text, name text)
         ON CONFLICT (tenant_id, device_id, device_user_id) DO UPDATE SET
           device_name = CASE
             WHEN hr.device_enrollments.device_name IS NULL
               OR btrim(hr.device_enrollments.device_name) = ''
               OR hr.device_enrollments.device_name LIKE 'Empleado %'
             THEN EXCLUDED.device_name ELSE hr.device_enrollments.device_name END,
           is_present = true,
           last_seen_at = now()`,
        [tenant, deviceId, JSON.stringify([...names].map(([code, name]) => ({ code, name })))],
      );
    }
    // Quien checa, existe: un código sin enrolamiento recibe uno al checar.
    const codes = [...new Set(rows.map((r) => r.code))].filter((c) => !names.has(c));
    if (codes.length) {
      await trx.raw(
        `INSERT INTO hr.device_enrollments (tenant_id, device_id, device_user_id, device_name, is_present, first_seen_at, last_seen_at)
         SELECT ?::uuid, ?::uuid, c.code, 'Empleado ' || c.code, true, now(), now()
           FROM jsonb_to_recordset(?::jsonb) AS c(code text)
         ON CONFLICT (tenant_id, device_id, device_user_id) DO UPDATE SET last_seen_at = now()`,
        [tenant, deviceId, JSON.stringify(codes.map((code) => ({ code })))],
      );
    }
  }

  private async flagReappearances(
    trx: Knex.Transaction, tenant: string, deviceId: string, rows: NormalizedPunch[],
  ): Promise<string[]> {
    const last = lastDateByCode(rows);
    if (!last.size) return [];
    const res = await trx.raw(
      `UPDATE hr.device_enrollments e
          SET match_status = 'pendiente',
              match_reason = 'volvió a checar después de ignorarse',
              updated_at = now()
         FROM jsonb_to_recordset(?::jsonb) AS v(code text, last_date text)
        WHERE e.tenant_id = ?::uuid AND e.device_id = ?::uuid AND e.device_user_id = v.code
          AND e.match_status = 'ignorado'
          AND v.last_date > to_char(e.updated_at AT TIME ZONE 'America/Mexico_City', 'YYYY-MM-DD')
       RETURNING e.device_user_id`,
      [JSON.stringify([...last].map(([code, last_date]) => ({ code, last_date }))), tenant, deviceId],
    );
    return (res.rows || []).map((r: { device_user_id: string }) => r.device_user_id);
  }

  /**
   * Inserta las checadas de UN reloj real. Además de la llave natural (reloj, usuario, instante), se salta
   * la checada que ya está en el RELOJ DESCONOCIDO de su sitio con la misma persona y la misma hora de pared.
   *
   * ⭐ Por qué (traslado del `NOT EXISTS` de `api/src/ingesta.ts` de Mega Talento, medido el 2026-10-07):
   * de las 214,784 checadas de Mega Talento, **119,260 no traen reloj**: entraron por la base de la Fase CH
   * hasta el 5-ago-2026 y la carga única las deja en `MT-SIN-RELOJ-<sitio>` (no se adivina su reloj). Los
   * relojes guardan años de historia en su buffer, así que un lector SIN marca de agua — el de `md` en
   * `[RH.1.3]`, o el agente si pierde su `cola.db` — manda todo eso otra vez, ahora con su serie, y la llave
   * natural no lo frena porque el reloj es otro. Mega Talento tiene este mismo puente por esa razón («sin
   * este filtro el primer backfill del agente las volvería a insertar todas») y hoy tiene CERO gemelas.
   *
   * La persona se compara con su código de SITIO (`person_code` del enrolamiento, o el crudo si no se
   * traduce): es como quedó en el desconocido. La hora se compara con el `punched_at` que tendría en el
   * desconocido (su propia zona), para entrar por la llave primaria en vez de recorrer el histórico.
   */
  private async insertPunches(
    trx: Knex.Transaction, tenant: string, device: DeviceRow, source: string, rows: NormalizedPunch[],
  ): Promise<number> {
    const unknown = device.site_code
      ? await trx('hr.attendance_devices').where({ serial_number: `${PREFIJO_RELOJ_DESCONOCIDO}${device.site_code}` })
        .first<{ id: string; timezone: string } | undefined>('id', 'timezone')
      : undefined;
    let accepted = 0;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK).map((r) => ({ code: r.code, local: r.local, ptype: r.punchType, vmode: r.verifyMode }));
      // La hora de pared se convierte con la zona DECLARADA del reloj (no con la del proceso,
      // que en el servidor es UTC: así se corrían seis horas en Mega Talento).
      const res = await trx.raw(
        `INSERT INTO hr.attendance_logs
           (tenant_id, device_id, device_user_id, punched_at, punched_local, punch_type, verify_mode, source, user_id)
         SELECT ?::uuid, ?::uuid, v.code, (v.local::timestamp AT TIME ZONE ?), v.local::timestamp,
                v.ptype::smallint, v.vmode::smallint, ?, e.user_id
           FROM jsonb_to_recordset(?::jsonb) AS v(code text, local text, ptype int, vmode int)
           LEFT JOIN hr.device_enrollments e
             ON e.tenant_id = ?::uuid AND e.device_id = ?::uuid AND e.device_user_id = v.code
          WHERE ?::uuid IS NULL OR NOT EXISTS (
            SELECT 1 FROM hr.attendance_logs h
             WHERE h.tenant_id = ?::uuid AND h.device_id = ?::uuid
               AND h.device_user_id = COALESCE(e.person_code, v.code)
               AND h.punched_at = (v.local::timestamp AT TIME ZONE ?)
               AND h.punched_local = v.local::timestamp)
         ON CONFLICT (tenant_id, device_id, device_user_id, punched_at) DO NOTHING`,
        [tenant, device.id, device.timezone, source, JSON.stringify(chunk), tenant, device.id,
          unknown?.id ?? null, tenant, unknown?.id ?? null, unknown?.timezone ?? device.timezone],
      );
      accepted += res.rowCount || 0;
    }
    return accepted;
  }

  /**
   * El latido del reloj. Se llama SIEMPRE, aunque el lote venga vacío: un lote vacío dice
   * "el reloj está vivo y no ha checado nadie", y eso separa "sin movimiento" de "sin señal".
   */
  private async touch(
    trx: Knex.Transaction, tenant: string, device: DeviceRow, batch: IncomingBatch, latest: string | null,
  ): Promise<void> {
    const info = batch.infoReloj || {};
    const patch: Record<string, unknown> = {
      last_seen_at: trx.fn.now(),
      last_sync_at: trx.fn.now(),
      last_error: null,
      seen_ip: batch.ip || undefined,
      record_count: typeof info.logCounts === 'number' ? info.logCounts : undefined,
      user_count: typeof info.userCounts === 'number' ? info.userCounts : undefined,
      clock_drift_seconds: clockDriftSeconds(info.horaReloj, new Date()) ?? undefined,
      agent_version: batch.agenteVersion || undefined,
      agent_host: batch.agenteHost || undefined,
    };
    if (latest) {
      patch['last_punch_at'] = trx.raw('GREATEST(last_punch_at, (?::timestamp AT TIME ZONE ?))', [latest, device.timezone]);
    }
    if (batch.completa) {
      // Sólo tras una lectura completa: es un conteo sobre una tabla grande.
      patch['last_backfill_at'] = trx.fn.now();
      patch['logs_in_db'] = trx.raw(
        '(SELECT count(*) FROM hr.attendance_logs l WHERE l.tenant_id = ?::uuid AND l.device_id = ?::uuid)',
        [tenant, device.id],
      );
    }
    await trx('hr.attendance_devices').where({ id: device.id }).update(patch);
  }

  private async saveBatch(
    trx: Knex.Transaction, tenant: string, deviceId: string | null, serial: string, source: string,
    records: number, accepted: number, status: 'aplicado' | 'sin_registrar' | 'en_pausa', raw: IncomingBatch | null,
    error: string | null,
  ): Promise<string> {
    const [row] = await trx('hr.ingest_batches')
      .insert({
        tenant_id: tenant, device_id: deviceId, serial_number: serial, source,
        records, accepted, status, raw: raw ? JSON.stringify(raw) : null, error,
      })
      .returning('id');
    return typeof row === 'object' ? row.id : row;
  }

  /** Latido de ENTREGA en `analytics.cron_runs` (ADR-053). Un lote sin checadas nuevas es normal. */
  private async beat(tenant: string, rows: number, durationMs: number): Promise<void> {
    await latirCron(this.tk.global, {
      jobKey: HR_INGEST_JOB_KEY,
      label: 'Relojes checadores: entrada de checadas (Fase RH)',
      tenantId: tenant,
      rowsAffected: rows,
      durationMs,
      ceroEsOk: 'un lote o latido sin checadas nuevas es normal: el reloj está vivo y nadie checó',
      host: 'api',
    });
  }
}
