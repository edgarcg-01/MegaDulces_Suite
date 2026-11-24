import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import type { Knex } from 'knex';
import { ObjectStorageService, TenantContextService, TenantKnexService, sanitizarNombre, validarAdjunto } from '@megadulces/platform-core';
import type {
  HrAsistenciaResponse, HrFirmaDepartamentoDto, HrFirmaSemanaDto, HrFirmasSemanaDto, HrRegistrarFirmaBody,
} from '@megadulces/contracts';

/** La hoja escaneada: una foto de celular o un PDF de escáner caben de sobra. */
export const FIRMA_MAX_BYTES = 10 * 1024 * 1024;
const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;
const SIN_DEPARTAMENTO = 'Sin departamento';

/** El departamento como lo agrupa el reporte (mismo criterio que `departamentoDe` de la pantalla). */
export function departamentoDe(p: { departamento?: string | null }): string {
  return String(p.departamento ?? '').trim() || SIN_DEPARTAMENTO;
}

/**
 * Fase RH · `[RH.15.5]` — La firma de la semana.
 *
 * LFT 132-XXXIV (DOF 1-may-2026): el registro electrónico de la jornada hace PRUEBA PLENA si se acredita que lo
 * acordaron la persona trabajadora y el patrón. RH lo acredita como ya lo hacía: una hoja por departamento, firmada
 * por las personas y por su jefe de área (representante del patrón, art. 11). Aquí esa hoja se GUARDA, ligada a la
 * semana que se firmó:
 *
 *   · Sólo se firma una semana CERRADA: lo que se firma es la foto del cierre, no algo que todavía cambia.
 *   · Se guarda la huella (sha256) de esa foto. Si la semana se reabre y se vuelve a cerrar distinta, la hoja vieja
 *     queda «de otra versión» y la persona cuenta como SIN firmar.
 *   · Una hoja no se borra: se anula con motivo.
 *
 * Usa los permisos de los cierres: registra quien cierra la semana, lo ve quien ve los cierres. Sin permiso nuevo.
 */
@Injectable()
export class HrAttendanceSignoffsService {
  private readonly logger = new Logger(HrAttendanceSignoffsService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    @Optional() private readonly storage?: ObjectStorageService,
  ) {}

  private quien(): { id: string | null; nombre: string | null } {
    const c = this.tenantCtx.get();
    return { id: c?.userId ?? null, nombre: c?.username ?? null };
  }

  /** El cierre vigente de la semana, con la huella de su foto y sus personas por departamento. */
  private async cierreVigente(trx: Knex.Transaction, site: string, desde: string): Promise<{
    id: string; sha: string; departamentos: Map<string, Array<{ codigo: string; nombre: string }>>;
  } | null> {
    const c = await trx('hr.attendance_closures')
      .where({ site_code: site, period_start: desde }).whereNull('reopened_at')
      .first<{ id: string; sha: string; snapshot: HrAsistenciaResponse } | undefined>(
        'id', trx.raw(`encode(sha256(convert_to(snapshot::text, 'UTF8')), 'hex') AS sha`), 'snapshot');
    if (!c) return null;
    const deps = new Map<string, Array<{ codigo: string; nombre: string }>>();
    // Firman quienes quedaron en la foto como personas del padrón; un código sin identificar no tiene a quién pedirle firma.
    for (const p of c.snapshot?.personas ?? []) {
      if (p.registrado === false) continue;
      const d = departamentoDe(p);
      if (!deps.has(d)) deps.set(d, []);
      deps.get(d)!.push({ codigo: p.codigo, nombre: p.nombreCompleto || p.nombre || `Persona ${p.codigo}` });
    }
    for (const l of deps.values()) l.sort((a, b) => a.nombre.localeCompare(b.nombre));
    return { id: c.id, sha: c.sha, departamentos: deps };
  }

  private digitalMedido: boolean | null = null;

  /** `[RH.15.11]` ¿Ya corrió la migración de la firma digital? Se recuerda sólo el «sí». */
  private async hayDigital(trx: Knex.Transaction): Promise<boolean> {
    if (this.digitalMedido) return true;
    const r = await trx.raw(`SELECT to_regclass('hr.attendance_digital_signatures') IS NOT NULL AS ok`);
    this.digitalMedido = !!r.rows[0]?.ok || null;
    return !!this.digitalMedido;
  }

  /**
   * `[RH.15.11]` La firma desde el celular, en la versión vigente: quién firmó (cuenta como firmada en cuanto se hace) y
   * quién tiene un QR vivo sin usar.
   */
  private async celularDe(trx: Knex.Transaction, cierre: { id: string; sha: string }): Promise<{
    firmas: Map<string, { id: string; at: string }>; ligas: Set<string>;
  }> {
    const firmas = new Map<string, { id: string; at: string }>();
    const ligas = new Set<string>();
    if (!(await this.hayDigital(trx))) return { firmas, ligas };
    const vivas: Array<{ person_code: string }> = await trx('hr.attendance_sign_links')
      .where({ closure_id: cierre.id, snapshot_sha256: cierre.sha }).whereNull('used_at').whereNull('revoked_at')
      .where('expires_at', '>', trx.fn.now()).select('person_code');
    for (const l of vivas) ligas.add(l.person_code);
    const filas: Array<{ id: string; person_code: string; at: string }> = await trx('hr.attendance_digital_signatures')
      .where({ closure_id: cierre.id, snapshot_sha256: cierre.sha }).whereNull('voided_at')
      .select('id', 'person_code', trx.raw(`to_char(signed_at AT TIME ZONE 'America/Mexico_City', 'YYYY-MM-DD"T"HH24:MI:SS') AS at`));
    for (const f of filas) firmas.set(f.person_code, { id: String(f.id), at: f.at });
    return { firmas, ligas };
  }

  /** Cómo va la firma de una semana: por departamento, quién firmó, y las hojas registradas. */
  async estado(q: { site_code?: string; period_start?: string }): Promise<HrFirmasSemanaDto> {
    const site = String(q.site_code || '').trim();
    const desde = String(q.period_start || '');
    if (!site || !RE_FECHA.test(desde)) throw new BadRequestException('Faltan site_code y period_start (yyyy-MM-dd).');
    return this.tk.run(this.tenantCtx.requireTenantId(), async (trx) => {
      const cierre = await this.cierreVigente(trx, site, desde);
      const filas: Array<Record<string, unknown>> = await trx('hr.attendance_signoffs')
        .where({ site_code: site, period_start: desde })
        .orderBy('created_at', 'desc')
        .select('id', 'department', 'person_codes', 'jefe_nombre', 'file_name', 'file_type', 'notes', 'created_by_name',
          'closure_id', 'snapshot_sha256', 'void_reason',
          trx.raw(`to_char(created_at AT TIME ZONE 'America/Mexico_City', 'YYYY-MM-DD"T"HH24:MI:SS') AS created_at`),
          trx.raw(`to_char(voided_at AT TIME ZONE 'America/Mexico_City', 'YYYY-MM-DD"T"HH24:MI:SS') AS voided_at`));
      const hojas: HrFirmaSemanaDto[] = filas.map((f) => ({
        id: String(f['id']), department: String(f['department']), person_codes: (f['person_codes'] as string[]) ?? [],
        jefe_nombre: String(f['jefe_nombre']), file_name: (f['file_name'] as string) ?? null, file_type: (f['file_type'] as string) ?? null,
        notes: (f['notes'] as string) ?? null, created_at: String(f['created_at']), created_by_name: (f['created_by_name'] as string) ?? null,
        vigente: !!cierre && f['closure_id'] === cierre.id && f['snapshot_sha256'] === cierre.sha,
        voided_at: (f['voided_at'] as string) ?? null, void_reason: (f['void_reason'] as string) ?? null,
      }));
      const enPapel = new Set(hojas.filter((h) => h.vigente && !h.voided_at).flatMap((h) => h.person_codes));
      const celular = cierre ? await this.celularDe(trx, cierre) : { firmas: new Map<string, { id: string; at: string }>(), ligas: new Set<string>() };
      const departamentos: HrFirmaDepartamentoDto[] = [...(cierre?.departamentos ?? new Map()).entries()]
        .sort(([a], [b]) => (a === SIN_DEPARTAMENTO ? 1 : b === SIN_DEPARTAMENTO ? -1 : a.localeCompare(b)))
        .map(([department, personas]) => {
          const conFirma = personas.map((p: { codigo: string; nombre: string }) => {
            const cel = celular.firmas.get(p.codigo);
            const via = cel ? 'celular' as const : enPapel.has(p.codigo) ? 'papel' as const : null;
            return {
              ...p, firmo: via !== null, via, firma_id: cel?.id ?? null, firmado_at: cel?.at ?? null,
              liga: via === null && celular.ligas.has(p.codigo),
            };
          });
          return { department, personas: conFirma, firmaron: conFirma.filter((p) => p.firmo).length, total: conFirma.length };
        });
      return {
        site_code: site, period_start: desde, cerrada: !!cierre, closure_id: cierre?.id ?? null, departamentos, hojas,
        firmaron: departamentos.reduce((s, d) => s + d.firmaron, 0), total: departamentos.reduce((s, d) => s + d.total, 0),
      };
    });
  }

  /** Registra una hoja firmada (PDF o foto). */
  async registrar(b: HrRegistrarFirmaBody): Promise<HrFirmaSemanaDto> {
    const site = String(b?.site_code || '').trim();
    const desde = String(b?.period_start || '');
    const depto = String(b?.department || '').trim();
    const jefe = String(b?.jefe_nombre || '').trim();
    const codigos = [...new Set((Array.isArray(b?.person_codes) ? b.person_codes : []).map((c) => String(c).trim()).filter(Boolean))];
    if (!site || !RE_FECHA.test(desde)) throw new BadRequestException('Faltan site_code y period_start (yyyy-MM-dd).');
    if (!depto) throw new BadRequestException('Falta el departamento de la hoja.');
    if (jefe.length < 3) throw new BadRequestException('Escribe el nombre del jefe de área que firmó la hoja.');
    if (!codigos.length) throw new BadRequestException('Marca al menos a una persona que firmó la hoja.');
    const archivo = validarAdjunto(b?.file_data_uri, FIRMA_MAX_BYTES);
    if (!archivo.ok) throw new BadRequestException(`La hoja escaneada no sirve: ${archivo.detalle}.`);
    if (!this.storage?.isConfigured()) {
      throw new ConflictException('El almacenamiento de archivos no está configurado: no se puede guardar la hoja firmada.');
    }
    const q = this.quien();
    const tenant = this.tenantCtx.requireTenantId();

    return this.tk.run(tenant, async (trx) => {
      const cierre = await this.cierreVigente(trx, site, desde);
      if (!cierre) throw new ConflictException('Primero cierra la semana: se firma lo que quedó cerrado.');
      const personas = cierre.departamentos.get(depto);
      if (!personas) throw new BadRequestException(`«${depto}» no es un departamento de esa semana.`);
      const deAqui = new Set(personas.map((p) => p.codigo));
      const ajenas = codigos.filter((c) => !deAqui.has(c));
      if (ajenas.length) throw new BadRequestException(`No son de «${depto}» en esa semana: ${ajenas.join(', ')}.`);

      const nombre = sanitizarNombre(b.file_name, archivo.adjunto.contentType);
      const { key } = await this.storage!.putBuffer(archivo.adjunto.buffer, archivo.adjunto.contentType, `hr/${tenant}/firmas-asistencia`, nombre);
      const [fila] = await trx('hr.attendance_signoffs').insert({
        tenant_id: tenant, closure_id: cierre.id, site_code: site, period_start: desde, department: depto,
        person_codes: codigos, jefe_nombre: jefe, snapshot_sha256: cierre.sha,
        file_key: key, file_name: nombre, file_type: archivo.adjunto.contentType, file_bytes: archivo.adjunto.sizeBytes,
        notes: String(b.notes ?? '').trim().slice(0, 500) || null,
        created_by: q.id, created_by_name: q.nombre, updated_by: q.id,
      }).returning(['id']);
      this.logger.log(`[RH.15.5] ${site} ${desde} «${depto}»: hoja firmada por ${codigos.length} persona(s) y ${jefe} (${q.nombre ?? q.id})`);
      const estado = await this.estadoDe(trx, cierre, String(fila.id));
      return estado;
    });
  }

  private async estadoDe(trx: Knex.Transaction, cierre: { id: string; sha: string }, id: string): Promise<HrFirmaSemanaDto> {
    const f = await trx('hr.attendance_signoffs').where({ id }).first('id', 'department', 'person_codes', 'jefe_nombre', 'file_name',
      'file_type', 'notes', 'created_by_name', 'closure_id', 'snapshot_sha256', 'void_reason',
      trx.raw(`to_char(created_at AT TIME ZONE 'America/Mexico_City', 'YYYY-MM-DD"T"HH24:MI:SS') AS created_at`),
      trx.raw(`to_char(voided_at AT TIME ZONE 'America/Mexico_City', 'YYYY-MM-DD"T"HH24:MI:SS') AS voided_at`));
    return {
      id: f.id, department: f.department, person_codes: f.person_codes, jefe_nombre: f.jefe_nombre, file_name: f.file_name,
      file_type: f.file_type, notes: f.notes, created_at: f.created_at, created_by_name: f.created_by_name,
      vigente: f.closure_id === cierre.id && f.snapshot_sha256 === cierre.sha, voided_at: f.voided_at ?? null, void_reason: f.void_reason ?? null,
    };
  }

  /** La hoja escaneada, con una liga temporal del bucket privado. */
  async archivo(id: string): Promise<{ url: string }> {
    return this.tk.run(this.tenantCtx.requireTenantId(), async (trx) => {
      const f = await trx('hr.attendance_signoffs').where({ id }).first('file_key');
      if (!f) throw new NotFoundException('Esa hoja firmada no existe.');
      const url = this.storage?.isConfigured() ? await this.storage.signedUrl(f.file_key, 600) : '';
      if (!url) throw new ConflictException('El almacenamiento de archivos no está configurado: no se puede abrir la hoja.');
      return { url };
    });
  }

  /** Anula una hoja (se registró mal, era de otra semana…). No se borra: queda con el motivo. */
  async anular(id: string, motivo: string): Promise<{ ok: true }> {
    const m = String(motivo || '').trim();
    if (m.length < 5) throw new BadRequestException('Escribe por qué se anula la hoja (al menos 5 letras): queda guardado.');
    const q = this.quien();
    return this.tk.run(this.tenantCtx.requireTenantId(), async (trx) => {
      const n = await trx('hr.attendance_signoffs').where({ id }).whereNull('voided_at')
        .update({ voided_at: trx.fn.now(), voided_by: q.id, voided_by_name: q.nombre, void_reason: m, updated_at: trx.fn.now(), updated_by: q.id });
      if (!n) throw new NotFoundException('Esa hoja no existe o ya estaba anulada.');
      return { ok: true as const };
    });
  }
}
