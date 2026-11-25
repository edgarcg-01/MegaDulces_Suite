import { createHash, randomBytes } from 'node:crypto';
import {
  BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, Optional,
} from '@nestjs/common';
import type { Knex } from 'knex';
import { ObjectStorageService, TenantContextService, TenantKnexService, validarAdjunto } from '@megadulces/platform-core';
import type {
  HrAsistenciaResponse, HrEstadoDia, HrExpedienteFirmaDto, HrExpedienteFirmasDto, HrFirmaPublicaDia, HrFirmaPublicaDto,
  HrFirmaPublicaFirmarBody, HrFirmaPublicaResultadoDto, HrGenerarLigasFirmaBody, HrHojaFirmaPersona, HrHojaFirmasDto,
  HrLigasFirmaDto, HrPersonaAsistencia,
} from '@megadulces/contracts';
import { departamentoDe } from './attendance-signoffs.service';

/** Cuánto vive un QR: lo entrega el jefe en persona; el fin de semana no lo mata. */
export const LIGA_FIRMA_HORAS = 72;
/** Un trazo de firma en PNG pesa decenas de KB; 1 MB es de sobra y corta un abuso. */
export const FIRMA_TRAZO_MAX_BYTES = 1024 * 1024;
/** Un motivo de anulación que se entienda después (mismo mínimo que la hoja de papel). */
export const MOTIVO_ANULAR_MINIMO = 5;
const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;
const BYTES_AZAR = 18;   // 144 bits: no se adivina
const RUTA_PUBLICA = 'mi-semana';
const TZ = 'America/Mexico_City';

const ETIQUETA: Record<HrEstadoDia, string> = {
  a_tiempo: 'Asistió', absorbido: 'Asistió (con tolerancia)', retardo: 'Retardo', falta: 'Falta', descanso: 'Descanso',
  marca_faltante: 'Una sola checada', justificado: 'Justificado', sin_dato: 'Sin dato del reloj',
};

/** La huella que se guarda del token. El token no se guarda nunca. */
export function huellaToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * El token lleva el tenant (16 bytes, no es secreto) y 18 bytes al azar: así la página pública sabe en qué tenant
 * buscar sin una consulta que se salte la seguridad por renglón (RLS). Lo que autoriza es el azar, por su huella.
 */
export function crearToken(tenantId: string): string {
  const t = Buffer.from(tenantId.replace(/-/g, ''), 'hex');
  if (t.length !== 16) throw new Error('tenant inválido');
  return Buffer.concat([t, randomBytes(BYTES_AZAR)]).toString('base64url');
}

/** El tenant de un token, o `null` si el token no tiene la forma. */
export function tenantDelToken(token: string): string | null {
  const s = String(token ?? '');
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(s)) return null;
  const b = Buffer.from(s, 'base64url');
  if (b.length !== 16 + BYTES_AZAR) return null;
  const h = b.subarray(0, 16).toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const sumarDias = (ymd: string, n: number): string => {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const hhmm = (min: number): string => `${Math.floor(min / 60)}:${String(Math.round(min % 60)).padStart(2, '0')}`;
const ymd = (v: unknown): string => (typeof v === 'string' ? v.slice(0, 10) : new Date(v as Date).toISOString().slice(0, 10));
const nombreDe = (p: HrPersonaAsistencia): string => String(p.nombreCompleto || p.nombre || `Persona ${p.codigo}`).trim();

/** La semana de una persona, en palabras, tal como quedó en la foto del cierre. */
export function semanaDe(persona: HrPersonaAsistencia, desde: string): Pick<HrHojaFirmaPersona, 'dias' | 'horas_semana' | 'faltas'> {
  const hasta = sumarDias(desde, 6);
  const crudos = (persona.semanas ?? []).flatMap((s) => s.dias ?? [])
    .filter((d) => d.fecha >= desde && d.fecha <= hasta)
    .sort((a, b) => a.fecha.localeCompare(b.fecha));
  const minutos = crudos.reduce((s, d) => s + (d.netasMin ?? 0), 0);
  const dias: HrFirmaPublicaDia[] = crudos.map((d) => ({
    fecha: d.fecha, estado: d.estado, etiqueta: ETIQUETA[d.estado] ?? d.estado,
    entrada: d.entrada ?? null, salida: d.salida ?? null,
    horas: d.netasMin != null ? hhmm(d.netasMin) : (d.horasNetas || null),
    incidencias: (d.incidencias ?? []).map((i) => i.etiqueta).filter(Boolean),
  }));
  return { dias, horas_semana: hhmm(minutos), faltas: dias.filter((d) => d.estado === 'falta').length };
}

/** Los números de reloj de una persona, por plaza (los que RH ligó a su usuario). */
export async function numerosDe(trx: Knex.Transaction, userId: string): Promise<Array<{ site_code: string; person_code: string }>> {
  const { rows } = await trx.raw<{ rows: Array<{ site_code: string; person_code: string }> }>(`
    SELECT DISTINCT d.site_code, COALESCE(e.person_code, e.device_user_id) AS person_code
      FROM hr.device_enrollments e
      JOIN hr.attendance_devices d ON d.tenant_id = e.tenant_id AND d.id = e.device_id
     WHERE e.user_id = ? AND e.match_status <> 'ignorado'
     ORDER BY 1, 2`, [userId]);
  return rows;
}

const NO_SIRVE = 'Esta liga ya no sirve. Pide otra a tu jefe de área.';

interface Cierre { id: string; sha: string; snapshot: HrAsistenciaResponse; reabierto: boolean }
interface Liga {
  id: string; tenant_id: string; closure_id: string; site_code: string; period_start: string; department: string;
  person_code: string; snapshot_sha256: string; expires_at: Date; used_at: Date | null; revoked_at: Date | null;
}
interface FilaFirma {
  id: string; closure_id: string; site_code: string; period_start: string; department: string; person_code: string;
  snapshot_sha256: string; file_key: string; ip: string | null; user_agent: string | null; signed_at: string;
  voided_at: string | null; void_reason: string | null;
}

/**
 * Fase RH · `[RH.15.11]` — La firma de la semana desde el CELULAR, con un QR personal.
 *
 *   1. RH (quien cierra la semana) genera los QR de un departamento y el jefe de área los reparte EN PERSONA.
 *   2. La persona lo escanea, ve SU semana tal como quedó cerrada y firma con el dedo. Esa firma ES la autorización:
 *      cuenta en cuanto se guarda (decisión de RH, 2026-11-17: sin número de reloj ni confirmación del jefe).
 *   3. Queda guardada: por departamento (la hoja con todas las firmas, en PDF) y en el expediente de cada persona.
 *
 * ⚠️ Riesgo declarado: la liga es la única llave. Quien tenga el QR ve la semana de esa persona y puede firmar por ella.
 * Lo que lo acota: 144 bits al azar (no se adivina), un solo uso, 72 h, se revoca al generar otra, IP + navegador + hora
 * de cada firma, y RH la anula con motivo. Falta que Jurídico lo valide.
 * ⚠️ Lo que esto NO es: una firma electrónica avanzada (e.firma). Es evidencia de conformidad con el registro.
 */
@Injectable()
export class HrAttendanceFirmaDigitalService {
  private readonly logger = new Logger(HrAttendanceFirmaDigitalService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    @Optional() private readonly storage?: ObjectStorageService,
  ) {}

  private quien(): { id: string | null; nombre: string | null } {
    const c = this.tenantCtx.get();
    return { id: c?.userId ?? null, nombre: c?.username ?? null };
  }

  private columnasCierre(trx: Knex.Transaction): Array<string | Knex.Raw> {
    return ['id', trx.raw(`encode(sha256(convert_to(snapshot::text, 'UTF8')), 'hex') AS sha`), 'snapshot',
      trx.raw('reopened_at IS NOT NULL AS reabierto')];
  }

  private async cierreVigente(trx: Knex.Transaction, site: string, desde: string): Promise<Cierre | null> {
    const c = await trx('hr.attendance_closures')
      .where({ site_code: site, period_start: desde }).whereNull('reopened_at')
      .first<Cierre | undefined>(this.columnasCierre(trx));
    return c ?? null;
  }

  private personasDe(cierre: Cierre, depto: string): HrPersonaAsistencia[] {
    return (cierre.snapshot?.personas ?? []).filter((p) => p.registrado !== false && departamentoDe(p) === depto);
  }

  private async guardarTrazo(tenant: string, dataUri: string | undefined, nombre: string): Promise<{ key: string; bytes: number }> {
    const a = validarAdjunto(String(dataUri ?? ''), FIRMA_TRAZO_MAX_BYTES);
    if (!a.ok) throw new BadRequestException(`La firma no se pudo leer: ${a.detalle}.`);
    if (a.adjunto.contentType !== 'image/png') throw new BadRequestException('La firma debe ser el trazo del recuadro (PNG).');
    if (!this.storage?.isConfigured()) throw new ConflictException('El almacenamiento de archivos no está configurado: no se puede guardar la firma.');
    const { key } = await this.storage.putBuffer(a.adjunto.buffer, 'image/png', `hr/${tenant}/firmas-asistencia/celular`, nombre);
    return { key, bytes: a.adjunto.sizeBytes };
  }

  private async nombreSitio(trx: Knex.Transaction, site: string): Promise<string> {
    const s = await trx('hr.attendance_sites').where({ code: site }).first('name');
    return String(s?.name || site);
  }

  /** Las firmas del celular, con fechas en hora de México. */
  private firmas(trx: Knex.Transaction): Knex.QueryBuilder {
    return trx('hr.attendance_digital_signatures').select(
      'id', 'closure_id', 'site_code', 'department', 'person_code', 'snapshot_sha256', 'file_key', 'ip', 'user_agent', 'void_reason',
      trx.raw(`to_char(period_start, 'YYYY-MM-DD') AS period_start`),
      trx.raw(`to_char(signed_at AT TIME ZONE '${TZ}', 'YYYY-MM-DD"T"HH24:MI:SS') AS signed_at`),
      trx.raw(`to_char(voided_at AT TIME ZONE '${TZ}', 'YYYY-MM-DD"T"HH24:MI:SS') AS voided_at`));
  }

  private async png(key: string): Promise<string | null> {
    return this.storage?.isConfigured() ? this.storage.getDataUri(key) : null;
  }

  // ── Lado de RH (con sesión) ────────────────────────────────────────────────────────────

  /** Genera los QR de un departamento. Revoca los vivos de esas personas. `origin` si no hay `APP_PUBLIC_URL`. */
  async generar(b: HrGenerarLigasFirmaBody, origin?: string): Promise<HrLigasFirmaDto> {
    const site = String(b?.site_code || '').trim();
    const desde = String(b?.period_start || '');
    const depto = String(b?.department || '').trim();
    if (!site || !RE_FECHA.test(desde)) throw new BadRequestException('Faltan site_code y period_start (yyyy-MM-dd).');
    if (!depto) throw new BadRequestException('Falta el departamento.');
    const base = (process.env['APP_PUBLIC_URL'] || origin || '').replace(/\/+$/, '');
    if (!/^https?:\/\//.test(base)) throw new BadRequestException('No se pudo armar la liga: falta el origen público (APP_PUBLIC_URL).');
    const tenant = this.tenantCtx.requireTenantId();
    const q = this.quien();

    return this.tk.run(tenant, async (trx) => {
      const cierre = await this.cierreVigente(trx, site, desde);
      if (!cierre) throw new ConflictException('Primero cierra la semana: se firma lo que quedó cerrado.');
      const personas = this.personasDe(cierre, depto);
      if (!personas.length) throw new BadRequestException(`«${depto}» no es un departamento de esa semana.`);
      let elegidas = personas;
      if (Array.isArray(b.person_codes) && b.person_codes.length) {
        const pedidas = new Set(b.person_codes.map((c) => String(c).trim()));
        const ajenas = [...pedidas].filter((c) => !personas.some((p) => p.codigo === c));
        if (ajenas.length) throw new BadRequestException(`No son de «${depto}» en esa semana: ${ajenas.join(', ')}.`);
        elegidas = personas.filter((p) => pedidas.has(p.codigo));
      }

      // Quién ya firmó ESTA versión: en papel (hoja vigente) o en su celular (firma sin anular).
      const enPapel = new Set<string>((await trx('hr.attendance_signoffs')
        .where({ closure_id: cierre.id, snapshot_sha256: cierre.sha }).whereNull('voided_at')
        .select('person_codes')).flatMap((r: { person_codes: string[] }) => r.person_codes));
      const enCelular = new Set<string>((await trx('hr.attendance_digital_signatures')
        .where({ closure_id: cierre.id, snapshot_sha256: cierre.sha }).whereNull('voided_at')
        .select('person_code')).map((r: { person_code: string }) => r.person_code));

      const omitidas: HrLigasFirmaDto['omitidas'] = [];
      const ligas: HrLigasFirmaDto['ligas'] = [];
      const vence = new Date(Date.now() + LIGA_FIRMA_HORAS * 3_600_000);
      for (const p of elegidas) {
        const nombre = nombreDe(p);
        if (enCelular.has(p.codigo)) { omitidas.push({ person_code: p.codigo, nombre, motivo: 'Ya firmó en su celular' }); continue; }
        if (enPapel.has(p.codigo)) { omitidas.push({ person_code: p.codigo, nombre, motivo: 'Ya firmó en papel' }); continue; }
        await trx('hr.attendance_sign_links')
          .where({ closure_id: cierre.id, person_code: p.codigo }).whereNull('used_at').whereNull('revoked_at')
          .update({ revoked_at: trx.fn.now(), revoke_reason: 'se generó otra liga', updated_at: trx.fn.now(), updated_by: q.id });
        const token = crearToken(tenant);
        await trx('hr.attendance_sign_links').insert({
          tenant_id: tenant, closure_id: cierre.id, site_code: site, period_start: desde, department: depto, person_code: p.codigo,
          token_sha256: huellaToken(token), snapshot_sha256: cierre.sha, expires_at: vence,
          created_by: q.id, created_by_name: q.nombre, updated_by: q.id,
        });
        ligas.push({ person_code: p.codigo, nombre, url: `${base}/${RUTA_PUBLICA}/${token}`, expires_at: vence.toISOString() });
      }
      ligas.sort((a, c) => a.nombre.localeCompare(c.nombre));
      this.logger.log(`[RH.15.11] ${site} ${desde} «${depto}»: ${ligas.length} QR generados, ${omitidas.length} omitidos (${q.nombre ?? q.id})`);
      return { site_code: site, period_start: desde, period_end: sumarDias(desde, 6), department: depto, ligas, omitidas };
    });
  }

  /** RH anula una firma del celular (firmó alguien más, se equivocó de persona…). No se borra: queda con su motivo. */
  async anular(id: string, motivo: string): Promise<{ ok: true }> {
    const m = String(motivo ?? '').trim();
    if (m.length < MOTIVO_ANULAR_MINIMO) throw new BadRequestException('Escribe por qué se anula la firma (queda en el registro).');
    const q = this.quien();
    return this.tk.run(this.tenantCtx.requireTenantId(), async (trx) => {
      const f = await trx('hr.attendance_digital_signatures').where({ id }).forUpdate().first('id', 'voided_at', 'person_code');
      if (!f) throw new NotFoundException('Esa firma no existe.');
      if (f.voided_at) throw new ConflictException('Esa firma ya estaba anulada.');
      await trx('hr.attendance_digital_signatures').where({ id }).update({
        voided_at: trx.fn.now(), voided_by: q.id, voided_by_name: q.nombre, void_reason: m.slice(0, 500), updated_at: trx.fn.now(),
      });
      this.logger.log(`[RH.15.11] firma ${id} (#${f.person_code}) anulada: ${m} (${q.nombre ?? q.id})`);
      return { ok: true as const };
    });
  }

  /** El trazo de una persona, con liga temporal del bucket privado. */
  async archivoFirma(id: string): Promise<{ url: string }> {
    return this.tk.run(this.tenantCtx.requireTenantId(), async (trx) => {
      const f = await trx('hr.attendance_digital_signatures').where({ id }).first('file_key');
      if (!f) throw new NotFoundException('Esa firma no existe.');
      const url = this.storage?.isConfigured() ? await this.storage.signedUrl(f.file_key, 600) : '';
      if (!url) throw new ConflictException('El almacenamiento de archivos no está configurado: no se puede abrir la firma.');
      return { url };
    });
  }

  /** Una persona en la hoja: su semana de esa foto y su firma (del celular, con el trazo; o la hoja de papel). */
  private async filaHoja(
    persona: HrPersonaAsistencia, desde: string, digital: FilaFirma | undefined,
    papel: { id: string; created_at: string } | undefined,
  ): Promise<HrHojaFirmaPersona> {
    let firma: HrHojaFirmaPersona['firma'] = null;
    if (digital) {
      firma = {
        via: 'celular', firmado_at: digital.signed_at, png: await this.png(digital.file_key), ip: digital.ip, navegador: digital.user_agent,
        id: String(digital.id), anulada: digital.voided_at ? { at: digital.voided_at, motivo: String(digital.void_reason ?? '') } : null,
      };
    } else if (papel) {
      firma = { via: 'papel', firmado_at: papel.created_at, png: null, ip: null, navegador: null, id: papel.id, anulada: null };
    }
    return { codigo: persona.codigo, nombre: nombreDe(persona), department: departamentoDe(persona), ...semanaDe(persona, desde), firma };
  }

  /** La hoja de un departamento, con todas sus firmas de la versión vigente: lo que se imprime o se guarda en PDF. */
  async hoja(q: { site_code?: string; period_start?: string; department?: string }): Promise<HrHojaFirmasDto> {
    const site = String(q.site_code || '').trim();
    const desde = String(q.period_start || '');
    const depto = String(q.department || '').trim();
    if (!site || !RE_FECHA.test(desde)) throw new BadRequestException('Faltan site_code y period_start (yyyy-MM-dd).');
    if (!depto) throw new BadRequestException('Falta el departamento.');
    return this.tk.run(this.tenantCtx.requireTenantId(), async (trx) => {
      const cierre = await this.cierreVigente(trx, site, desde);
      if (!cierre) throw new ConflictException('La semana no está cerrada.');
      const personas = this.personasDe(cierre, depto).sort((a, b) => nombreDe(a).localeCompare(nombreDe(b)));
      if (!personas.length) throw new BadRequestException(`«${depto}» no es un departamento de esa semana.`);
      const digitales: FilaFirma[] = await this.firmas(trx)
        .where({ closure_id: cierre.id, snapshot_sha256: cierre.sha, department: depto }).whereNull('voided_at');
      const hojas: Array<{ id: string; person_codes: string[]; created_at: string }> = await trx('hr.attendance_signoffs')
        .where({ closure_id: cierre.id, snapshot_sha256: cierre.sha }).whereNull('voided_at')
        .orderBy('created_at').select('id', 'person_codes',
          trx.raw(`to_char(created_at AT TIME ZONE '${TZ}', 'YYYY-MM-DD"T"HH24:MI:SS') AS created_at`));
      const filas: HrHojaFirmaPersona[] = [];
      for (const p of personas) {
        const papel = hojas.find((h) => h.person_codes.includes(p.codigo));
        filas.push(await this.filaHoja(p, desde, digitales.find((d) => d.person_code === p.codigo),
          papel ? { id: String(papel.id), created_at: papel.created_at } : undefined));
      }
      return {
        site_code: site, site_name: await this.nombreSitio(trx, site), period_start: desde, period_end: sumarDias(desde, 6),
        department: depto, version: cierre.sha.slice(0, 12), vigente: true, personas: filas,
      };
    });
  }

  /** El comprobante de UNA firma del celular, con la versión exacta que se firmó (aunque se haya reabierto después). */
  async comprobante(id: string): Promise<HrHojaFirmasDto> {
    return this.tk.run(this.tenantCtx.requireTenantId(), async (trx) => {
      const f: FilaFirma | undefined = await this.firmas(trx).where({ id }).first();
      if (!f) throw new NotFoundException('Esa firma no existe.');
      const cierre: Cierre | undefined = await trx('hr.attendance_closures').where({ id: f.closure_id }).first(this.columnasCierre(trx));
      if (!cierre) throw new NotFoundException('No se encontró la semana cerrada de esa firma.');
      const persona = (cierre.snapshot?.personas ?? []).find((p) => p.codigo === f.person_code);
      if (!persona) throw new NotFoundException('La persona ya no está en la foto de esa semana.');
      const desde = ymd(f.period_start);
      return {
        site_code: f.site_code, site_name: await this.nombreSitio(trx, f.site_code), period_start: desde, period_end: sumarDias(desde, 6),
        department: f.department, version: f.snapshot_sha256.slice(0, 12),
        vigente: !cierre.reabierto && cierre.sha === f.snapshot_sha256,
        personas: [await this.filaHoja(persona, desde, f, undefined)],
      };
    });
  }

  /**
   * El expediente de firmas de una persona: cada semana que firmó (celular o papel), la más nueva primero. Por PERSONA
   * (`user_id`: todas sus plazas, por sus números de reloj ligados) o, si todavía no está ligada, por plaza + número.
   */
  async expediente(q: { site_code?: string; person_code?: string; user_id?: string }): Promise<HrExpedienteFirmasDto> {
    const site = String(q.site_code || '').trim();
    const persona = String(q.person_code || '').trim();
    const userId = String(q.user_id || '').trim();
    if (userId && !/^[0-9a-f-]{36}$/i.test(userId)) throw new BadRequestException('user_id inválido.');
    if (!userId && (!site || !persona)) throw new BadRequestException('Faltan user_id, o site_code y person_code.');
    return this.tk.run(this.tenantCtx.requireTenantId(), async (trx) => {
      const pares: Array<{ site_code: string; person_code: string }> = userId
        ? await numerosDe(trx, userId)
        : [{ site_code: site, person_code: persona }];
      if (!pares.length) return { site_code: site || null, person_code: persona || null, user_id: userId || null, firmas: [] };
      const sitios = [...new Set(pares.map((p) => p.site_code))];
      const dePar = (w: Knex.QueryBuilder, col: string) => w.where((o) => {
        for (const p of pares) o.orWhere((x) => x.where('site_code', p.site_code).whereRaw(col, [p.person_code]));
      });

      // La versión vigente de cada semana de esas plazas, para decir si lo firmado sigue siendo lo cerrado.
      const vigentes = new Map<string, { id: string; sha: string }>(
        ((await trx('hr.attendance_closures').whereIn('site_code', sitios).whereNull('reopened_at')
          .select('id', trx.raw(`encode(sha256(convert_to(snapshot::text, 'UTF8')), 'hex') AS sha`))) as Array<{ id: string; sha: string }>)
          .map((c) => [c.id, c]));
      const esVigente = (closure: string, sha: string) => vigentes.get(closure)?.sha === sha;

      const digitales: FilaFirma[] = await dePar(this.firmas(trx), 'person_code = ?');
      const papel: Array<{ id: string; site_code: string; closure_id: string; snapshot_sha256: string; department: string; period_start: string;
        created_at: string; voided_at: string | null; void_reason: string | null }> = await dePar(trx('hr.attendance_signoffs'), '? = ANY(person_codes)')
        .select('id', 'site_code', 'closure_id', 'snapshot_sha256', 'department', 'void_reason',
          trx.raw(`to_char(period_start, 'YYYY-MM-DD') AS period_start`),
          trx.raw(`to_char(created_at AT TIME ZONE '${TZ}', 'YYYY-MM-DD"T"HH24:MI:SS') AS created_at`),
          trx.raw(`to_char(voided_at AT TIME ZONE '${TZ}', 'YYYY-MM-DD"T"HH24:MI:SS') AS voided_at`));

      const firmas: HrExpedienteFirmaDto[] = [
        ...digitales.map((d): HrExpedienteFirmaDto => ({
          site_code: d.site_code, period_start: d.period_start, period_end: sumarDias(d.period_start, 6), department: d.department,
          via: 'celular', firmado_at: d.signed_at, id: String(d.id), vigente: esVigente(d.closure_id, d.snapshot_sha256),
          anulada: d.voided_at ? { at: d.voided_at, motivo: String(d.void_reason ?? '') } : null,
        })),
        ...papel.map((h): HrExpedienteFirmaDto => ({
          site_code: h.site_code, period_start: h.period_start, period_end: sumarDias(h.period_start, 6), department: h.department,
          via: 'papel', firmado_at: h.created_at, id: String(h.id), vigente: esVigente(h.closure_id, h.snapshot_sha256),
          anulada: h.voided_at ? { at: h.voided_at, motivo: String(h.void_reason ?? '') } : null,
        })),
      ].sort((a, b) => b.period_start.localeCompare(a.period_start) || b.firmado_at.localeCompare(a.firmado_at));
      return { site_code: site || null, person_code: persona || null, user_id: userId || null, firmas };
    });
  }

  // ── Lado público (sin sesión; lo autoriza el token) ───────────────────────────────────────

  /** Lee la liga y la valida. `paraFirmar` bloquea la fila (dos pestañas no firman dos veces). */
  private async liga(trx: Knex.Transaction, token: string, paraFirmar = false): Promise<{ l: Liga; cierre: Cierre; persona: HrPersonaAsistencia }> {
    const qb = trx('hr.attendance_sign_links').where({ token_sha256: huellaToken(token) });
    const l: Liga | undefined = await (paraFirmar ? qb.forUpdate() : qb).first();
    if (!l || l.revoked_at) throw new ForbiddenException(NO_SIRVE);
    if (l.used_at) throw new ForbiddenException('Ya firmaste tu semana con esta liga. Si necesitas algo, habla con tu jefe de área.');
    if (new Date(l.expires_at).getTime() <= Date.now()) throw new ForbiddenException('Esta liga venció. Pide otra a tu jefe de área.');
    const desde = ymd(l.period_start);
    const cierre = await this.cierreVigente(trx, l.site_code, desde);
    if (!cierre || cierre.id !== l.closure_id || cierre.sha !== l.snapshot_sha256) {
      throw new ForbiddenException('Tu semana cambió después de que se generó esta liga. Pide otra a tu jefe de área.');
    }
    const persona = (cierre.snapshot?.personas ?? []).find((p) => p.codigo === l.person_code);
    if (!persona) throw new ForbiddenException(NO_SIRVE);
    return { l: { ...l, period_start: desde }, cierre, persona };
  }

  /** Su semana tal como quedó cerrada, para leerla y firmarla. */
  async publica(token: string): Promise<HrFirmaPublicaDto> {
    const tenant = tenantDelToken(token);
    if (!tenant) throw new ForbiddenException(NO_SIRVE);
    return this.tk.run(tenant, async (trx) => {
      const { l, persona } = await this.liga(trx, token);
      return {
        nombre: nombreDe(persona), site_name: await this.nombreSitio(trx, l.site_code),
        period_start: l.period_start, period_end: sumarDias(l.period_start, 6),
        expires_at: new Date(l.expires_at).toISOString(), ...semanaDe(persona, l.period_start),
      };
    });
  }

  /** Firma: guarda el trazo con la versión que vio y gasta la liga. La firma cuenta desde aquí. */
  async firmar(token: string, b: HrFirmaPublicaFirmarBody, meta: { ip?: string | null; userAgent?: string | null }): Promise<HrFirmaPublicaResultadoDto> {
    const tenant = tenantDelToken(token);
    if (!tenant) throw new ForbiddenException(NO_SIRVE);
    return this.tk.run(tenant, async (trx) => {
      const { l } = await this.liga(trx, token, true);
      const trazo = await this.guardarTrazo(tenant, b?.firma_png, `firma-${l.person_code}.png`);
      try {
        const [f] = await trx('hr.attendance_digital_signatures').insert({
          tenant_id: tenant, link_id: l.id, closure_id: l.closure_id, site_code: l.site_code, period_start: l.period_start,
          department: l.department, person_code: l.person_code, snapshot_sha256: l.snapshot_sha256,
          file_key: trazo.key, file_bytes: trazo.bytes,
          ip: String(meta.ip ?? '').slice(0, 64) || null, user_agent: String(meta.userAgent ?? '').slice(0, 300) || null,
        }).returning(['signed_at']);
        await trx('hr.attendance_sign_links').where({ id: l.id }).update({ used_at: trx.fn.now(), updated_at: trx.fn.now() });
        this.logger.log(`[RH.15.11] ${l.site_code} ${l.period_start}: #${l.person_code} firmó su semana en el celular`);
        return { ok: true as const, signed_at: new Date(f.signed_at).toISOString() };
      } catch (e) {
        // Ya hay una firma vigente de esa persona en esa versión (otra liga, otra pestaña): no se duplica.
        if ((e as { code?: string }).code === '23505') throw new ForbiddenException('Tu semana ya está firmada. Si necesitas algo, habla con tu jefe de área.');
        throw e;
      }
    });
  }
}
