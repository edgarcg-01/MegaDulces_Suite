import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Knex } from 'knex';
import { TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import type {
  HrAltaPersonaBody, HrLigarBody, HrLigarResultadoDto, HrPersonaBuscadaDto, HrSinPersonaDto, HrSinPersonaResponse,
} from '@megadulces/contracts';
import { esRelojDesconocido } from './logic/relojes';
import { candidatosPara, normalizarNombre, usernameAlta, validarAlta, type CuentaPersona } from './logic/personas';

/**
 * Fase RH · `[RH.1.12]` — LIGAR un código de reloj a su persona, desde la Suite.
 *
 * Un reloj sólo sabe «el 214 de Zamora checó». Quién es el 214 lo dice `hr.device_enrollments.user_id`, y hasta hoy
 * sólo lo escribía la carga única de Mega Talento (`[RH.1.4]`): nada en el producto lo hacía. Después del corte, cada
 * persona nueva (3 a 11 por semana, medido en Mega Talento) aparecería como «Empleado 214», sin faltas, sin sección
 * y fuera del reporte, y nadie podría arreglarlo. Esta es la bandeja que faltaba:
 *
 *   · `sinPersona`  — los códigos sin persona, con los candidatos que propone el MISMO motor de la carga
 *                     (`logic/personas.ts`). El motor propone; RH confirma. Nunca se liga automático: un enlace
 *                     equivocado le atribuye las faltas de una persona a otra, y eso es dato de nómina.
 *   · `ligar`       — al código en TODOS los relojes de su plaza (como la carga). No pisa un enlace a otra persona
 *                     sin `reemplazar` explícito.
 *   · `desligar`    — con motivo escrito.
 *   · `alta`        — da de alta a la persona sin contraseña ni acceso (rol `sin_acceso`, como la carga), guarda su
 *                     ficha de la plaza (sección del reporte, promotora) y la liga.
 *
 * Cada cambio deja su asiento en `identity.user_events` (la bitácora de personas) y el `updated_by` del enrolamiento.
 * La asistencia se calcula al leer: ligar a alguien días después recupera todo su historial.
 *
 * ⚠️ El alta escribe `identity.users` directo, igual que la carga: el alta de `libs/trade` es para cuentas CON acceso
 * (exige contraseña y rol) y `libs/hr` no puede importarla.
 */

const ROL_SIN_ACCESO = 'sin_acceso';
const RE_ADMIN = /^\s*admin/i;
/** El enrolamiento con su plaza y su código (el código de nómina si el reloj numera distinto). */
interface Enrolamiento { id: string; user_id: string | null; site_code: string; codigo: string; warehouse_code: string | null }

@Injectable()
export class HrAttendanceEnrollmentsService {
  private readonly logger = new Logger(HrAttendanceEnrollmentsService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  private quien(): { id: string | null; nombre: string | null } {
    const c = this.tenantCtx.get();
    return { id: c?.userId ?? null, nombre: c?.username ?? null };
  }

  private run<T>(fn: (trx: Knex.Transaction, tenant: string) => Promise<T>): Promise<T> {
    const tenant = this.tenantCtx.requireTenantId();
    return this.tk.run(tenant, (trx) => fn(trx, tenant));
  }

  /** Las cuentas de personas de la Suite (las de servicio no son personas). */
  private async cuentas(trx: Knex.Transaction, tenant: string): Promise<CuentaPersona[]> {
    return trx('identity.users').where({ tenant_id: tenant }).whereNull('deleted_at').whereIn('kind', ['interno', 'externo'])
      .select('id', 'nombre', 'warehouse_code', 'status');
  }

  // ── La bandeja ──────────────────────────────────────────────────────────────────────────────────────────────────

  async sinPersona(): Promise<HrSinPersonaResponse> {
    return this.run(async (trx, tenant) => {
      const filas: Array<Record<string, unknown>> = (await trx.raw(`
        SELECT e.id AS enrollment_id, d.site_code, COALESCE(s.name, d.site_code) AS site_name, s.warehouse_code,
               d.label AS device_label, d.serial_number, COALESCE(e.person_code, e.device_user_id) AS codigo,
               e.device_name AS nombre_reloj, u.ultima, COALESCE(u.n14, 0) AS n14, p.report_section, p.is_promoter
          FROM hr.device_enrollments e
          JOIN hr.attendance_devices d ON d.tenant_id = e.tenant_id AND d.id = e.device_id
          LEFT JOIN hr.attendance_sites s ON s.tenant_id = d.tenant_id AND s.code = d.site_code
          LEFT JOIN hr.person_site_profiles p ON p.tenant_id = e.tenant_id AND p.site_code = d.site_code
                                             AND p.person_code = COALESCE(e.person_code, e.device_user_id)
          LEFT JOIN LATERAL (
            SELECT max(l.punched_at) AS ultima, count(*) FILTER (WHERE l.punched_at >= now() - interval '14 days')::int AS n14
              FROM hr.attendance_logs l
             WHERE l.tenant_id = e.tenant_id AND l.device_id = e.device_id AND l.device_user_id = e.device_user_id) u ON true
         WHERE e.tenant_id = ? AND e.user_id IS NULL AND e.match_status <> 'ignorado'
           AND d.is_active AND COALESCE(s.is_active, true) AND d.site_code IS NOT NULL
         ORDER BY u.ultima DESC NULLS LAST
         LIMIT 300`, [tenant])).rows;
      // Lo que no es una persona: el reloj desconocido de la carga (agrupa lo histórico sin reloj) y la cuenta «Admin».
      const vivas = filas.filter((f) => !esRelojDesconocido(String(f['serial_number'])) && !RE_ADMIN.test(String(f['nombre_reloj'] ?? '')));

      const sitios = [...new Set(vivas.map((f) => String(f['site_code'])))];
      const ligados = new Map<string, string[]>();
      if (sitios.length) {
        const rows: Array<{ k: string; user_id: string }> = (await trx.raw(`
          SELECT d.site_code || '|' || COALESCE(e.person_code, e.device_user_id) AS k, e.user_id
            FROM hr.device_enrollments e
            JOIN hr.attendance_devices d ON d.tenant_id = e.tenant_id AND d.id = e.device_id
           WHERE e.tenant_id = ? AND e.user_id IS NOT NULL AND d.site_code = ANY(?)`, [tenant, sitios])).rows;
        for (const r of rows) ligados.set(r.k, [...(ligados.get(r.k) ?? []), r.user_id]);
      }
      const cuentas = await this.cuentas(trx, tenant);
      const secciones: string[] = (await trx('hr.person_site_profiles').where({ tenant_id: tenant }).whereNotNull('report_section')
        .distinct('report_section').orderBy('report_section')).map((r: { report_section: string }) => r.report_section);

      const salida: HrSinPersonaDto[] = vivas.map((f) => {
        const codigo = String(f['codigo']);
        const site = String(f['site_code']);
        return {
          enrollment_id: String(f['enrollment_id']),
          site_code: site,
          site_name: String(f['site_name']),
          device_label: (f['device_label'] as string | null) ?? null,
          serial_number: String(f['serial_number']),
          codigo,
          nombre_reloj: (f['nombre_reloj'] as string | null) ?? null,
          ultima_checada: f['ultima'] ? new Date(f['ultima'] as string).toISOString() : null,
          checadas_14d: Number(f['n14'] ?? 0),
          seccion: (f['report_section'] as string | null) ?? null,
          promotora: f['is_promoter'] === true,
          candidatos: candidatosPara({
            nombreReloj: (f['nombre_reloj'] as string | null) ?? null,
            almacen: (f['warehouse_code'] as string | null) ?? null,
            ligadosMismoCodigo: ligados.get(`${site}|${codigo}`) ?? [],
            cuentas,
          }),
        };
      });
      return { filas: salida, total: salida.length, secciones };
    });
  }

  /** Buscar a mano a quién ligar: todas las palabras escritas tienen que estar en el nombre. */
  async buscar(q: string): Promise<HrPersonaBuscadaDto[]> {
    const tokens = normalizarNombre(q).split(' ').filter((t) => t.length >= 2);
    if (!tokens.length) return [];
    return this.run(async (trx, tenant) => {
      const todas = await this.cuentas(trx, tenant);
      return todas
        .filter((c) => { const n = normalizarNombre(c.nombre); return tokens.every((t) => n.includes(t)); })
        .sort((a, b) => String(a.nombre).localeCompare(String(b.nombre), 'es'))
        .slice(0, 15)
        .map((c) => ({ user_id: c.id, nombre: c.nombre ?? '(sin nombre)', status: c.status, warehouse_code: c.warehouse_code }));
    });
  }

  // ── Escrituras ──────────────────────────────────────────────────────────────────────────────────────────────────

  /** El enrolamiento, bloqueado hasta el fin de la transacción (dos personas de RH al mismo tiempo no se pisan). */
  private async tomar(trx: Knex.Transaction, tenant: string, id: string): Promise<Enrolamiento> {
    if (!/^[0-9a-f-]{36}$/i.test(String(id))) throw new NotFoundException('Ese código no está.');
    const r = (await trx.raw(`
      SELECT e.id, e.user_id, d.site_code, COALESCE(e.person_code, e.device_user_id) AS codigo, s.warehouse_code
        FROM hr.device_enrollments e
        JOIN hr.attendance_devices d ON d.tenant_id = e.tenant_id AND d.id = e.device_id
        LEFT JOIN hr.attendance_sites s ON s.tenant_id = d.tenant_id AND s.code = d.site_code
       WHERE e.tenant_id = ? AND e.id = ?
         FOR UPDATE OF e`, [tenant, id])).rows[0] as Enrolamiento | undefined;
    if (!r) throw new NotFoundException('Ese código no está.');
    if (!r.site_code) throw new ConflictException('Ese reloj no tiene plaza: dale una plaza en Relojes antes de ligar a alguien.');
    return r;
  }

  /** Las personas ligadas al mismo código en los relojes de la plaza (sin contar a `excepto`). */
  private async otrosDuenos(trx: Knex.Transaction, tenant: string, e: Enrolamiento, excepto: string): Promise<Array<{ id: string; nombre: string | null }>> {
    return (await trx.raw(`
      SELECT DISTINCT u.id, u.nombre
        FROM hr.device_enrollments x
        JOIN hr.attendance_devices d ON d.tenant_id = x.tenant_id AND d.id = x.device_id
        JOIN identity.users u ON u.tenant_id = x.tenant_id AND u.id = x.user_id
       WHERE x.tenant_id = ? AND d.site_code = ? AND COALESCE(x.person_code, x.device_user_id) = ?
         AND x.user_id IS NOT NULL AND x.user_id <> ?`, [tenant, e.site_code, e.codigo, excepto])).rows;
  }

  /** Liga el código a `userId` en todos los relojes de la plaza; con `reemplazar`, también donde era de otra persona. */
  private async aplicarLiga(trx: Knex.Transaction, tenant: string, e: Enrolamiento, userId: string, reemplazar: string[], motivo: string): Promise<number> {
    const q = this.quien();
    const res = await trx.raw(`
      UPDATE hr.device_enrollments x
         SET user_id = ?, match_status = 'confirmado', match_reason = ?, updated_by = ?, updated_at = now()
        FROM hr.attendance_devices d
       WHERE d.tenant_id = x.tenant_id AND d.id = x.device_id AND x.tenant_id = ?
         AND d.site_code = ? AND COALESCE(x.person_code, x.device_user_id) = ?
         AND (x.user_id IS NULL OR x.user_id = ? OR x.user_id = ANY(?::uuid[]))`,
    [userId, motivo, q.id, tenant, e.site_code, e.codigo, userId, reemplazar]);
    return res.rowCount ?? 0;
  }

  private async asentar(trx: Knex.Transaction, tenant: string, userId: string, event: string, detalle: Record<string, unknown>): Promise<void> {
    const q = this.quien();
    try {
      await trx('identity.user_events').insert({
        tenant_id: tenant, user_id: userId, event, detalle: JSON.stringify(detalle), actor_user_id: q.id, actor_username: q.nombre,
      });
    } catch (err) {
      // Igual que en el alta de usuarios: perder el asiento es menos grave que dejar la liga a medias.
      this.logger.warn(`[RH.1.12] no se pudo asentar «${event}» de ${userId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async ligar(id: string, b: HrLigarBody): Promise<HrLigarResultadoDto> {
    const userId = String(b?.user_id ?? '');
    if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new BadRequestException('Elige a la persona.');
    return this.run(async (trx, tenant) => {
      const e = await this.tomar(trx, tenant, id);
      const u = await trx('identity.users').where({ tenant_id: tenant, id: userId }).whereNull('deleted_at')
        .whereIn('kind', ['interno', 'externo']).first('id', 'nombre');
      if (!u) throw new BadRequestException('Esa persona no existe en la Suite.');
      const otros = await this.otrosDuenos(trx, tenant, e, userId);
      if (otros.length && b.reemplazar !== true) {
        throw new ConflictException(`El código ${e.codigo} de esta plaza ya es de ${otros.map((o) => o.nombre ?? 'otra persona').join(', ')}. `
          + 'Si está mal, confirma que quieres reemplazarlo.');
      }
      const n = await this.aplicarLiga(trx, tenant, e, userId, otros.map((o) => o.id), otros.length ? 'reemplazado por RH' : 'ligado por RH');
      await this.asentar(trx, tenant, userId, 'reloj_ligado', { site_code: e.site_code, codigo: e.codigo, enrollment_id: e.id, enrolamientos: n });
      for (const o of otros) await this.asentar(trx, tenant, o.id, 'reloj_desligado', { site_code: e.site_code, codigo: e.codigo, motivo: 'reemplazado', por: userId });
      return { user_id: userId, nombre: String(u.nombre ?? ''), enrolamientos: n };
    });
  }

  async desligar(id: string, motivo: unknown): Promise<{ enrolamientos: number }> {
    const m = String(motivo ?? '').replace(/\s+/g, ' ').trim();
    if (m.length < 5) throw new BadRequestException('Escribe por qué se desliga (al menos 5 letras).');
    return this.run(async (trx, tenant) => {
      const e = await this.tomar(trx, tenant, id);
      if (!e.user_id) throw new ConflictException('Ese código no está ligado a nadie.');
      const q = this.quien();
      const res = await trx.raw(`
        UPDATE hr.device_enrollments x
           SET user_id = NULL, match_status = 'pendiente', match_reason = ?, updated_by = ?, updated_at = now()
          FROM hr.attendance_devices d
         WHERE d.tenant_id = x.tenant_id AND d.id = x.device_id AND x.tenant_id = ?
           AND d.site_code = ? AND COALESCE(x.person_code, x.device_user_id) = ? AND x.user_id = ?`,
      [`desligado por RH: ${m.slice(0, 200)}`, q.id, tenant, e.site_code, e.codigo, e.user_id]);
      await this.asentar(trx, tenant, e.user_id, 'reloj_desligado', { site_code: e.site_code, codigo: e.codigo, motivo: m });
      return { enrolamientos: res.rowCount ?? 0 };
    });
  }

  async alta(id: string, b: HrAltaPersonaBody): Promise<HrLigarResultadoDto> {
    const v = validarAlta(b ?? {});
    if ('error' in v) throw new BadRequestException(v.error);
    return this.run(async (trx, tenant) => {
      const e = await this.tomar(trx, tenant, id);
      if (e.user_id) throw new ConflictException('Ese código ya está ligado a una persona.');
      const otros = await this.otrosDuenos(trx, tenant, e, '00000000-0000-0000-0000-000000000000');
      if (otros.length) {
        throw new ConflictException(`El código ${e.codigo} de esta plaza ya es de ${otros.map((o) => o.nombre ?? 'otra persona').join(', ')}: ligalo a esa persona en vez de dar de alta a otra.`);
      }
      const rol = await trx('identity.role_permissions').where({ tenant_id: tenant, role_name: ROL_SIN_ACCESO }).whereNull('deleted_at').first('role_name');
      if (!rol) throw new ConflictException(`Falta el rol ${ROL_SIN_ACCESO} (migración 20261012094356): no se puede dar de alta todavía.`);
      const username = usernameAlta(e.site_code, e.codigo);
      if (await trx('identity.users').where({ tenant_id: tenant, username }).first('id')) {
        throw new ConflictException(`Ya existe una persona dada de alta para este código (${username}): búscala y ligala.`);
      }
      const q = this.quien();
      const [u] = await trx('identity.users').insert({
        tenant_id: tenant, username, password_hash: null, nombre: v.nombre, role_name: ROL_SIN_ACCESO, kind: 'interno',
        // `activo` lo deriva el trigger de `status` (`[ID.8]`): `invited` queda sin acceso y sin contraseña.
        status: 'invited', department_code: null, position_code: null, warehouse_code: e.warehouse_code,
      }).returning('id');
      const userId = String(u.id ?? u);
      await trx('hr.person_site_profiles').insert({
        tenant_id: tenant, site_code: e.site_code, person_code: e.codigo, report_section: v.seccion,
        is_promoter: b.promotora === true, is_active: true, updated_by: q.id,
      }).onConflict(['tenant_id', 'site_code', 'person_code']).merge(['report_section', 'is_promoter', 'is_active', 'updated_by', 'updated_at']);
      const n = await this.aplicarLiga(trx, tenant, e, userId, [], 'dado de alta por RH desde el reloj');
      await this.asentar(trx, tenant, userId, 'alta_desde_reloj', { site_code: e.site_code, codigo: e.codigo, seccion: v.seccion, promotora: b.promotora === true, enrolamientos: n });
      return { user_id: userId, nombre: v.nombre, enrolamientos: n };
    });
  }
}
