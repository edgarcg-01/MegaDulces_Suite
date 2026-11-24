import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Knex } from 'knex';
import { TenantContextService, TenantKnexService, branchKeyFilterSql, branchKeySql, todayMx } from '@megadulces/platform-core';
import type {
  HrAltaPersonaBody, HrArchivarPersonaBody, HrBajaLoteBody, HrBajaLoteResultadoDto, HrBajaPlazaBody, HrBajaPlazaDto, HrBajaResultadoDto,
  HrCatalogosFichaDto, HrFichaPersonaDto, HrFichaPlazaBody, HrFichaPlazaDto, HrLigarBody, HrLigarResultadoDto, HrNombrePorConfirmarDto,
  HrNombresPorConfirmarResponse, HrPersonaBuscadaDto, HrPosiblesBajasResponse, HrSinPersonaDto, HrSinPersonaResponse, HrSinPlazasDto,
} from '@megadulces/contracts';
import { esRelojDesconocido, nombreParaReloj } from './logic/relojes';
import { TIPOS_INCIDENCIA } from './logic/incidencias';
import {
  candidatosPara, clasificarPosiblesBajas, diasParaBaja, nombrePorConfirmar, normalizarNombre, usernameAlta, validarAlta, validarFicha,
  type CuentaPersona,
} from './logic/personas';

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
/** `[RH.14.6]` Las incidencias que justifican no venir (las mismas que excusan una falta en el reporte). */
const TIPOS_QUE_JUSTIFICAN = TIPOS_INCIDENCIA.filter((t) => t.excusaFalta && t.tipo !== 'horas_extra').map((t) => t.tipo);
const ETIQUETA_TIPO = new Map(TIPOS_INCIDENCIA.map((t) => [t.tipo, t.etiqueta]));
const LOTE_MAX = 200;
/**
 * Plazas ACTIVAS de una persona: un código suyo ligado en un reloj de una plaza activa y su ficha ahí no está de baja (sin
 * ficha cuenta como activa: así la mide el reporte). Toma la persona por `?` (user_id); excluye la plaza `?` si se da.
 */
const SQL_PLAZAS_ACTIVAS = `
  SELECT DISTINCT d.site_code
    FROM hr.device_enrollments x
    JOIN hr.attendance_devices d ON d.tenant_id = x.tenant_id AND d.id = x.device_id
    LEFT JOIN hr.attendance_sites s ON s.tenant_id = d.tenant_id AND s.code = d.site_code
    LEFT JOIN hr.person_site_profiles p ON p.tenant_id = x.tenant_id AND p.site_code = d.site_code
                                       AND p.person_code = COALESCE(x.person_code, x.device_user_id)
   WHERE x.tenant_id = ? AND x.user_id = ? AND d.site_code IS NOT NULL
     AND COALESCE(s.is_active, true) AND COALESCE(p.is_active, true)`;
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

  /**
   * La persona ligada a ese código en la plaza, bloqueada (dos de RH a la vez no se pisan); null si no hay. Sin DISTINCT:
   * Postgres no lo deja junto con FOR UPDATE; el mismo dueño sale una vez por reloj y se junta aquí.
   */
  private async duenoDe(trx: Knex.Transaction, tenant: string, site: string, codigo: string): Promise<{ id: string; nombre: string | null; role_name: string; status: string | null } | null> {
    const filas: Array<{ id: string; nombre: string | null; role_name: string; status: string | null }> = (await trx.raw(`
      SELECT u.id, u.nombre, u.role_name, u.status
        FROM hr.device_enrollments x
        JOIN hr.attendance_devices d ON d.tenant_id = x.tenant_id AND d.id = x.device_id
        JOIN identity.users u ON u.tenant_id = x.tenant_id AND u.id = x.user_id
       WHERE x.tenant_id = ? AND d.site_code = ? AND COALESCE(x.person_code, x.device_user_id) = ? AND x.user_id IS NOT NULL
         FOR UPDATE OF u`, [tenant, site, codigo])).rows;
    const duenos = [...new Map(filas.map((f) => [f.id, f])).values()];
    if (duenos.length > 1) {
      throw new ConflictException(`El código ${codigo} de esta plaza está ligado a ${duenos.length} personas: desliga al que no es en Relojes antes de seguir.`);
    }
    return duenos[0] ?? null;
  }

  /** `[RH.7.2]` La papelera de una plaza: quién está de baja, desde cuándo, por qué, y si sigue checando. */
  async bajas(siteCode: string): Promise<HrBajaPlazaDto[]> {
    const site = String(siteCode ?? '').trim();
    if (!site) throw new BadRequestException('Falta la plaza.');
    return this.run(async (trx, tenant) => {
      const filas: Array<Record<string, unknown>> = (await trx.raw(`
        SELECT p.person_code, p.report_section, p.is_promoter, p.source, p.updated_at,
               own.user_id, u.nombre, ev.created_at AS ev_at, ev.detalle->>'motivo' AS motivo, ev.actor_username,
               lg.ultima, COALESCE(lg.desde_baja, 0) AS desde_baja
          FROM hr.person_site_profiles p
          LEFT JOIN LATERAL (
            SELECT x.user_id FROM hr.device_enrollments x
              JOIN hr.attendance_devices d ON d.tenant_id = x.tenant_id AND d.id = x.device_id
             WHERE x.tenant_id = p.tenant_id AND d.site_code = p.site_code
               AND COALESCE(x.person_code, x.device_user_id) = p.person_code AND x.user_id IS NOT NULL
             LIMIT 1) own ON true
          LEFT JOIN identity.users u ON u.tenant_id = p.tenant_id AND u.id = own.user_id
          LEFT JOIN LATERAL (
            SELECT e.created_at, e.detalle, e.actor_username FROM identity.user_events e
             WHERE e.tenant_id = p.tenant_id AND e.user_id = own.user_id AND e.event = 'baja_en_plaza'
               AND e.detalle->>'site_code' = p.site_code AND e.detalle->>'codigo' = p.person_code
             ORDER BY e.created_at DESC LIMIT 1) ev ON true
          -- Sólo los últimos 30 días (como «Por identificar» de Mega Talento): lo que importa es si SIGUE checando.
          LEFT JOIN LATERAL (
            SELECT max(l.punched_at) AS ultima,
                   count(*) FILTER (WHERE l.punched_at > COALESCE(ev.created_at, p.updated_at))::int AS desde_baja
              FROM hr.device_enrollments x
              JOIN hr.attendance_devices d ON d.tenant_id = x.tenant_id AND d.id = x.device_id
              JOIN hr.attendance_logs l ON l.tenant_id = x.tenant_id AND l.device_id = x.device_id AND l.device_user_id = x.device_user_id
             WHERE x.tenant_id = p.tenant_id AND d.site_code = p.site_code
               AND COALESCE(x.person_code, x.device_user_id) = p.person_code
               AND l.punched_at >= now() - interval '30 days') lg ON true
         WHERE p.tenant_id = ? AND p.site_code = ? AND NOT p.is_active
         ORDER BY COALESCE(ev.created_at, p.updated_at) DESC
         LIMIT 500`, [tenant, site])).rows;
      const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null);
      return filas.map((f) => {
        const conAsiento = !!f['ev_at'];
        return {
          person_code: String(f['person_code']),
          user_id: (f['user_id'] as string | null) ?? null,
          nombre: (f['nombre'] as string | null) ?? null,
          seccion: (f['report_section'] as string | null) ?? null,
          promotora: f['is_promoter'] === true,
          desde: iso(conAsiento ? f['ev_at'] : f['updated_at']),
          motivo: (f['motivo'] as string | null) ?? null,
          por: (f['actor_username'] as string | null) ?? null,
          origen: conAsiento || f['source'] !== 'mega_talento' ? 'suite' as const : 'mega_talento' as const,
          ultima_checada: iso(f['ultima']),
          checadas_desde_baja: Number(f['desde_baja'] ?? 0),
        };
      });
    });
  }

  /**
   * `[RH.7.2]` Baja EN UNA PLAZA (no de la persona: quien rota sigue activo en las otras). Deja de contar en el reporte
   * de esa plaza —sin faltas de quien ya se fue— y pasa a su papelera, de donde se reactiva. Exige motivo, y sólo para
   * un código ligado a una persona (lo que no es nadie se ignora en Relojes). No borra la huella del reloj físico.
   */
  async darDeBaja(b: HrBajaPlazaBody): Promise<HrBajaResultadoDto> {
    const { site, codigo } = this.plazaYCodigo(b);
    const motivo = this.motivoDeBaja(b?.motivo);
    return this.run(async (trx, tenant) => {
      const dueno = await this.bajaEn(trx, tenant, site, codigo, motivo);
      const sin = await this.sinPlazas(trx, tenant, dueno);
      return { ok: true as const, ...(sin ? { sin_plazas: sin } : {}) };
    });
  }

  private motivoDeBaja(v: unknown): string {
    const motivo = String(v ?? '').replace(/\s+/g, ' ').trim();
    if (motivo.length < 5) throw new BadRequestException('Escribe por qué se da de baja (al menos 5 letras).');
    return motivo;
  }

  /** La baja de UN código en la plaza, dentro de la transacción que se le dé. Devuelve a su dueño. */
  private async bajaEn(trx: Knex.Transaction, tenant: string, site: string, codigo: string, motivo: string): Promise<{ id: string; nombre: string | null; role_name: string; status: string | null }> {
    const dueno = await this.duenoDe(trx, tenant, site, codigo);
    if (!dueno) throw new ConflictException('Ese código no está ligado a nadie: en Relojes se liga o se ignora.');
    const antes = await trx('hr.person_site_profiles').where({ tenant_id: tenant, site_code: site, person_code: codigo }).forUpdate().first('is_active');
    if (antes && antes.is_active === false) throw new ConflictException('Ya está de baja en esta plaza.');
    const q = this.quien();
    await trx('hr.person_site_profiles').insert({
      tenant_id: tenant, site_code: site, person_code: codigo, is_active: false, source: 'suite', updated_by: q.id,
    }).onConflict(['tenant_id', 'site_code', 'person_code']).merge({ is_active: false, updated_by: q.id, updated_at: trx.fn.now() });
    await this.asentar(trx, tenant, dueno.id, 'baja_en_plaza', { site_code: site, codigo, motivo: motivo.slice(0, 300) });
    return dueno;
  }

  /** `[RH.14.1]` Si la persona ya no tiene ninguna plaza activa (y no está archivada), lo dice. */
  private async sinPlazas(trx: Knex.Transaction, tenant: string, p: { id: string; nombre: string | null; role_name: string; status: string | null }): Promise<HrSinPlazasDto | null> {
    if (p.status === 'terminated') return null;
    const activas = (await trx.raw(SQL_PLAZAS_ACTIVAS, [tenant, p.id])).rows.length;
    return activas ? null : { user_id: p.id, nombre: p.nombre, archivable: p.role_name === ROL_SIN_ACCESO };
  }

  /**
   * `[RH.14.6]` Varias bajas en una plaza con el mismo motivo. Cada una en su propio punto de guardado: la que falla no
   * deshace a las demás y se devuelve con su razón, para que la pantalla la deje seleccionada.
   */
  async darDeBajaLote(b: HrBajaLoteBody): Promise<HrBajaLoteResultadoDto> {
    const site = String(b?.site_code ?? '').trim();
    if (!site) throw new BadRequestException('Falta la plaza.');
    const codigos = Array.isArray(b?.person_codes) ? [...new Set(b.person_codes.map((c) => String(c).trim()).filter(Boolean))] : [];
    if (!codigos.length) throw new BadRequestException('Elige al menos a una persona.');
    if (codigos.length > LOTE_MAX) throw new BadRequestException(`Son demasiadas de una vez (máximo ${LOTE_MAX}).`);
    const motivo = this.motivoDeBaja(b?.motivo);
    return this.run(async (trx, tenant) => {
      const out: HrBajaLoteResultadoDto = { dados_de_baja: [], fallaron: [], sin_plazas: [] };
      const duenos = new Map<string, { id: string; nombre: string | null; role_name: string; status: string | null }>();
      for (const codigo of codigos) {
        try {
          const d = await trx.transaction((sp) => this.bajaEn(sp, tenant, site, codigo, motivo));
          duenos.set(d.id, d);
          out.dados_de_baja.push(codigo);
        } catch (e) {
          out.fallaron.push({ person_code: codigo, error: e instanceof Error ? e.message : String(e) });
        }
      }
      for (const d of duenos.values()) {
        const sin = await this.sinPlazas(trx, tenant, d);
        if (sin) out.sin_plazas.push(sin);
      }
      return out;
    });
  }

  /**
   * `[RH.14.1]` Archivar a la persona (Edgar, D3 del 18-nov): `status = 'terminated'`. Sólo a quien no tiene acceso a la
   * Suite (a una cuenta con acceso la da de baja Sistemas) y ya no tiene ninguna plaza activa. Se deshace solo: si RH la
   * reactiva en una plaza, vuelve a estar activa.
   */
  async archivar(b: HrArchivarPersonaBody): Promise<{ ok: true }> {
    const userId = String(b?.user_id ?? '');
    if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new BadRequestException('Falta la persona.');
    const motivo = String(b?.motivo ?? '').replace(/\s+/g, ' ').trim();
    if (motivo.length < 5) throw new BadRequestException('Escribe por qué se archiva (al menos 5 letras).');
    return this.run(async (trx, tenant) => {
      const u = await trx('identity.users').where({ tenant_id: tenant, id: userId }).whereNull('deleted_at').forUpdate()
        .first('id', 'nombre', 'role_name', 'status');
      if (!u) throw new NotFoundException('Esa persona no existe en la Suite.');
      if (u.role_name !== ROL_SIN_ACCESO) throw new ConflictException(`${u.nombre ?? 'Esta persona'} tiene acceso a la Suite: la da de baja Sistemas en Administración › Personas.`);
      if (u.status === 'terminated') throw new ConflictException('Ya está archivada.');
      const activas = (await trx.raw(SQL_PLAZAS_ACTIVAS, [tenant, userId])).rows as Array<{ site_code: string }>;
      if (activas.length) throw new ConflictException(`Sigue activa en ${activas.length === 1 ? 'una plaza' : `${activas.length} plazas`}: dala de baja ahí antes de archivarla.`);
      await trx('identity.users').where({ tenant_id: tenant, id: userId })
        .update({ status: 'terminated', terminated_at: trx.fn.now(), updated_at: trx.fn.now() });
      await this.asentar(trx, tenant, userId, 'persona_archivada', { motivo: motivo.slice(0, 300), status_antes: u.status });
      return { ok: true as const };
    });
  }

  /**
   * `[RH.14.6]` Quién lleva `dias` o más sin checar en la plaza (o nunca checó) y sigue activo ahí. No se propone a
   * quien tiene una incidencia que justifica la ausencia en ese tramo: se cuenta aparte, con la incidencia.
   */
  async posiblesBajas(siteCode: string, diasPedidos?: unknown): Promise<HrPosiblesBajasResponse> {
    const site = String(siteCode ?? '').trim();
    if (!site) throw new BadRequestException('Falta la plaza.');
    const dias = diasParaBaja(diasPedidos);
    return this.run(async (trx, tenant) => {
      const filas: Array<Record<string, unknown>> = (await trx.raw(`
        WITH cod AS (
          SELECT COALESCE(e.person_code, e.device_user_id) AS code, min(e.user_id::text)::uuid AS user_id,
                 count(DISTINCT e.user_id) AS duenos
            FROM hr.device_enrollments e
            JOIN hr.attendance_devices d ON d.tenant_id = e.tenant_id AND d.id = e.device_id
           WHERE e.tenant_id = ? AND d.site_code = ? AND e.user_id IS NOT NULL AND COALESCE(e.match_status, '') <> 'ignorado'
           GROUP BY 1),
        ult AS (
          SELECT COALESCE(e.person_code, e.device_user_id) AS code, max(l.punched_at) AS ultima
            FROM hr.device_enrollments e
            JOIN hr.attendance_devices d ON d.tenant_id = e.tenant_id AND d.id = e.device_id
            JOIN hr.attendance_logs l ON l.tenant_id = e.tenant_id AND l.device_id = e.device_id AND l.device_user_id = e.device_user_id
           WHERE e.tenant_id = ? AND d.site_code = ?
           GROUP BY 1)
        SELECT cod.code, cod.user_id, u.nombre, p.report_section, p.is_promoter, ult.ultima
          FROM cod
          JOIN identity.users u ON u.tenant_id = ? AND u.id = cod.user_id AND u.deleted_at IS NULL AND u.status IN ('active', 'invited')
          LEFT JOIN hr.person_site_profiles p ON p.tenant_id = ? AND p.site_code = ? AND p.person_code = cod.code
          LEFT JOIN ult ON ult.code = cod.code
         WHERE cod.duenos = 1 AND COALESCE(p.is_active, true)
           AND (ult.ultima IS NULL OR ult.ultima < now() - make_interval(days => ?))`,
      [tenant, site, tenant, site, tenant, tenant, site, dias])).rows;
      const base = filas.map((f) => ({
        codigo: String(f['code']), user_id: String(f['user_id']), nombre: (f['nombre'] as string | null) ?? null,
        seccion: (f['report_section'] as string | null) ?? null, promotora: f['is_promoter'] === true,
        ultima: f['ultima'] ? new Date(f['ultima'] as string).toISOString() : null,
      }));
      const incs: Array<{ codigo: string; desde: string; hasta: string; etiqueta: string }> = base.length
        ? ((await trx.raw(`
            SELECT person_code, incident_type, to_char(date_from, 'YYYY-MM-DD') AS desde, to_char(date_to, 'YYYY-MM-DD') AS hasta
              FROM hr.attendance_incidents
             WHERE tenant_id = ? AND site_code = ? AND person_code = ANY(?) AND incident_type = ANY(?)
               AND status NOT IN ('anulada', 'rechazada')`,
          [tenant, site, base.map((b) => b.codigo), TIPOS_QUE_JUSTIFICAN])).rows as Array<Record<string, string>>)
          .map((r) => ({ codigo: r['person_code'], desde: r['desde'], hasta: r['hasta'], etiqueta: ETIQUETA_TIPO.get(r['incident_type']) ?? r['incident_type'] }))
        : [];
      // `ultima` llega en UTC: para comparar contra días de pared se pasa a su día en México.
      const conDia = base.map((b) => ({ ...b, ultima: b.ultima ? this.diaMx(b.ultima) : null, ultimaIso: b.ultima }));
      const { proponer, explicadas } = clasificarPosiblesBajas(conDia, incs, { dias, hoy: todayMx() });
      const otras = await this.otrasPlazasActivas(trx, tenant, site, [...proponer, ...explicadas].map((x) => x.user_id));
      const dto = (x: (typeof conDia)[number] & { diasSinChecar?: number | null }) => ({
        person_code: x.codigo, user_id: x.user_id, nombre: x.nombre, seccion: x.seccion, promotora: x.promotora,
        ultima_checada: x.ultimaIso, dias_sin_checar: x.diasSinChecar ?? null, otras_plazas_activas: otras.get(x.user_id) ?? 0,
      });
      return {
        site_code: site, dias,
        filas: proponer.map(dto),
        explicadas: explicadas.map((x) => ({ ...dto(x), incidencia: x.incidencia })),
      };
    });
  }

  private diaMx(iso: string): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
  }

  /** Por persona, en cuántas plazas activas está ADEMÁS de `site`. */
  private async otrasPlazasActivas(trx: Knex.Transaction, tenant: string, site: string, userIds: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!userIds.length) return out;
    const rows: Array<{ user_id: string; n: number }> = (await trx.raw(`
      SELECT x.user_id, count(DISTINCT d.site_code)::int AS n
        FROM hr.device_enrollments x
        JOIN hr.attendance_devices d ON d.tenant_id = x.tenant_id AND d.id = x.device_id
        LEFT JOIN hr.attendance_sites s ON s.tenant_id = d.tenant_id AND s.code = d.site_code
        LEFT JOIN hr.person_site_profiles p ON p.tenant_id = x.tenant_id AND p.site_code = d.site_code
                                           AND p.person_code = COALESCE(x.person_code, x.device_user_id)
       WHERE x.tenant_id = ? AND x.user_id = ANY(?::uuid[]) AND d.site_code IS NOT NULL AND d.site_code <> ?
         AND COALESCE(s.is_active, true) AND COALESCE(p.is_active, true)
       GROUP BY 1`, [tenant, [...new Set(userIds)], site])).rows;
    for (const r of rows) out.set(String(r.user_id), Number(r.n));
    return out;
  }

  /**
   * `[RH.14.3]` La ficha completa de una persona en una plaza: cómo está en cada reloj (para ver el número y el apodo junto
   * al nombre de la Suite), su ficha de la plaza y lo que es de la persona.
   */
  async ficha(siteCode: string, personCode: string): Promise<HrFichaPersonaDto> {
    const { site, codigo } = this.plazaYCodigo({ site_code: siteCode, person_code: personCode });
    return this.run(async (trx, tenant) => {
      const relojes: Array<Record<string, unknown>> = (await trx.raw(`
        SELECT x.user_id, x.device_user_id, x.device_name, d.label, d.serial_number
          FROM hr.device_enrollments x
          JOIN hr.attendance_devices d ON d.tenant_id = x.tenant_id AND d.id = x.device_id
         WHERE x.tenant_id = ? AND d.site_code = ? AND COALESCE(x.person_code, x.device_user_id) = ? AND d.is_active
         ORDER BY (x.user_id IS NULL), d.label`, [tenant, site, codigo])).rows;
      const perfil = await trx('hr.person_site_profiles').where({ tenant_id: tenant, site_code: site, person_code: codigo })
        .first('report_section', 'is_promoter', 'is_active');
      if (!relojes.length && !perfil) throw new NotFoundException('Ese código no tiene ficha ni reloj en esta plaza.');
      const userId = (relojes.find((r) => r['user_id'])?.['user_id'] as string | undefined) ?? null;
      const u = userId
        ? await trx('identity.users as u')
          .leftJoin('trade.zones as z', function () { this.on('z.tenant_id', '=', 'u.tenant_id').andOn('z.id', '=', 'u.zona_id'); })
          .where({ 'u.tenant_id': tenant, 'u.id': userId })
          .first('u.nombre', 'u.role_name', 'u.status', 'u.department_code', 'u.position_code', 'u.warehouse_code', 'z.name as zona_nombre')
        : null;
      const plazas = userId ? (await trx.raw(SQL_PLAZAS_ACTIVAS, [tenant, userId])).rows.length : 0;
      return {
        site_code: site, person_code: codigo, user_id: userId, nombre: u?.nombre ?? null,
        con_acceso: !!u && u.role_name !== ROL_SIN_ACCESO, status: u?.status ?? null,
        activa_en_plaza: perfil?.is_active !== false, seccion: perfil?.report_section ?? null, promotora: perfil?.is_promoter === true,
        departamento_code: u?.department_code ?? null, puesto_code: u?.position_code ?? null, sucursal_code: u?.warehouse_code ?? null,
        zona_nombre: u?.zona_nombre ?? null,
        relojes: relojes.map((r) => ({
          device_label: (r['label'] as string | null) ?? null, serial_number: String(r['serial_number']),
          device_user_id: String(r['device_user_id']), nombre_reloj: (r['device_name'] as string | null) ?? null,
        })),
        nombre_para_reloj: u?.nombre ? nombreParaReloj(u.nombre) || null : null,
        nombre_por_confirmar: u ? nombrePorConfirmar(u.nombre, relojes.map((r) => r['device_name'] as string | null)) : null,
        plazas_activas: plazas,
      };
    });
  }

  /** `[RH.14.5]` Lo que se elige en la ficha: el mismo catálogo que usa Administración › Personas. */
  async catalogos(): Promise<HrCatalogosFichaDto> {
    return this.run(async (trx, tenant) => {
      const [departamentos, puestos, sucursales] = await Promise.all([
        trx('identity.departments').where({ tenant_id: tenant }).whereNull('deleted_at').orderBy('orden', 'asc').select('code', 'name'),
        trx('identity.positions').where({ tenant_id: tenant }).whereNull('deleted_at').orderBy('orden', 'asc').select('code', 'name', 'department_code'),
        trx('commercial.warehouses as w')
          .leftJoin('trade.zones as z', function () { this.on('z.tenant_id', '=', 'w.tenant_id').andOn('z.id', '=', 'w.zone_id'); })
          .where({ 'w.tenant_id': tenant }).whereNull('w.deleted_at').whereRaw(branchKeyFilterSql('w')).orderByRaw('1')
          .select(trx.raw(`${branchKeySql('w')} AS code`), 'w.name', 'z.name as zone_name'),
      ]);
      return {
        departamentos: departamentos.map((d: { code: string; name: string }) => ({ code: d.code, name: d.name })),
        puestos: puestos.map((p: { code: string; name: string; department_code: string | null }) => ({ code: p.code, name: p.name, department_code: p.department_code ?? null })),
        sucursales: sucursales.map((s: { code: string; name: string; zone_name: string | null }) => ({ code: s.code, name: s.name, zone_name: s.zone_name ?? null })),
      };
    });
  }

  /**
   * `[RH.14.4]` Personas activas cuyo nombre es un apodo: el mismo que su reloj o de menos de 3 palabras (con o sin acceso
   * a la Suite: el nombre lo corrige RH a cualquiera). Una fila por PERSONA (aunque cheque en varias plazas), con sus
   * plazas para guardar y mandar al reloj.
   */
  async nombresPorConfirmar(siteCode?: string): Promise<HrNombresPorConfirmarResponse> {
    const site = String(siteCode ?? '').trim() || null;
    return this.run(async (trx, tenant) => {
      const filas: Array<Record<string, unknown>> = (await trx.raw(`
        SELECT u.id AS user_id, u.nombre, d.site_code, COALESCE(s.name, d.site_code) AS site_name,
               COALESCE(x.person_code, x.device_user_id) AS codigo, max(x.device_name) AS apodo, max(x.last_seen_at) AS visto
          FROM hr.device_enrollments x
          JOIN hr.attendance_devices d ON d.tenant_id = x.tenant_id AND d.id = x.device_id
          LEFT JOIN hr.attendance_sites s ON s.tenant_id = d.tenant_id AND s.code = d.site_code
          JOIN identity.users u ON u.tenant_id = x.tenant_id AND u.id = x.user_id AND u.deleted_at IS NULL
                               AND u.status IN ('active', 'invited') AND u.kind IN ('interno', 'externo')
          LEFT JOIN hr.person_site_profiles p ON p.tenant_id = x.tenant_id AND p.site_code = d.site_code
                                             AND p.person_code = COALESCE(x.person_code, x.device_user_id)
         WHERE x.tenant_id = ? AND d.site_code IS NOT NULL AND COALESCE(s.is_active, true) AND COALESCE(p.is_active, true)
         GROUP BY 1, 2, 3, 4, 5`, [tenant])).rows;
      const porPersona = new Map<string, { nombre: string; apodos: string[]; plazas: HrNombrePorConfirmarDto['plazas']; visto: string | null }>();
      for (const f of filas) {
        const id = String(f['user_id']);
        const p = porPersona.get(id) ?? { nombre: String(f['nombre'] ?? ''), apodos: [], plazas: [], visto: null };
        if (f['apodo']) p.apodos.push(String(f['apodo']));
        p.plazas.push({ site_code: String(f['site_code']), site_name: String(f['site_name']), person_code: String(f['codigo']) });
        const v = f['visto'] ? new Date(f['visto'] as string).toISOString() : null;
        if (v && (!p.visto || v > p.visto)) p.visto = v;
        porPersona.set(id, p);
      }
      const salida: HrNombrePorConfirmarDto[] = [];
      for (const [id, p] of porPersona) {
        if (site && !p.plazas.some((x) => x.site_code === site)) continue;
        const motivo = nombrePorConfirmar(p.nombre, p.apodos);
        if (!motivo) continue;
        // La plaza pedida va primero: ahí se guarda el nombre.
        const plazas = site ? [...p.plazas.filter((x) => x.site_code === site), ...p.plazas.filter((x) => x.site_code !== site)] : p.plazas;
        salida.push({ user_id: id, nombre: p.nombre, motivo, nombre_reloj: p.apodos[0] ?? null, plazas, visto_en_reloj: p.visto });
      }
      salida.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
      return { filas: salida, total: salida.length };
    });
  }

  /** `[RH.7.2]` La regresa al reporte de la plaza. */
  async reactivar(b: HrBajaPlazaBody): Promise<{ ok: true }> {
    const { site, codigo } = this.plazaYCodigo(b);
    const motivo = String(b?.motivo ?? '').replace(/\s+/g, ' ').trim();
    return this.run(async (trx, tenant) => {
      const antes = await trx('hr.person_site_profiles').where({ tenant_id: tenant, site_code: site, person_code: codigo }).forUpdate().first('is_active');
      if (!antes || antes.is_active !== false) throw new ConflictException('No está de baja en esta plaza.');
      const dueno = await this.duenoDe(trx, tenant, site, codigo);
      const q = this.quien();
      await trx('hr.person_site_profiles').where({ tenant_id: tenant, site_code: site, person_code: codigo })
        .update({ is_active: true, updated_by: q.id, updated_at: trx.fn.now() });
      if (dueno) await this.asentar(trx, tenant, dueno.id, 'reactivado_en_plaza', { site_code: site, codigo, ...(motivo ? { motivo: motivo.slice(0, 300) } : {}) });
      // `[RH.14.1]` Archivada y sin acceso: reactivarla en una plaza la regresa también como persona (si no, el reporte
      // la seguiría dejando fuera). A una cuenta con acceso no se le toca el estado: eso es de Sistemas.
      if (dueno && dueno.status === 'terminated' && dueno.role_name === ROL_SIN_ACCESO) {
        await trx('identity.users').where({ tenant_id: tenant, id: dueno.id }).update({ status: 'invited', terminated_at: null, updated_at: trx.fn.now() });
        await this.asentar(trx, tenant, dueno.id, 'persona_reactivada', { site_code: site, codigo });
      }
      return { ok: true as const };
    });
  }

  private plazaYCodigo(b: { site_code?: unknown; person_code?: unknown }): { site: string; codigo: string } {
    const site = String(b?.site_code ?? '').trim();
    const codigo = String(b?.person_code ?? '').trim();
    if (!site || !codigo) throw new BadRequestException('Faltan la plaza y el código.');
    return { site, codigo };
  }

  /**
   * `[RH.7.1]` Corrige la ficha de una persona EN UNA PLAZA: sección del reporte, promotora y su nombre completo. Sin esto,
   * después del corte, quien entró sin sección frena el cierre de cada semana (`[RH.1.6b]`) y RH sólo podría forzarlo con
   * motivo. Cada cambio deja su «antes y después» en `identity.user_events`.
   *
   * `[RH.14.4]` El nombre, a cualquiera (antes sólo a `sin_acceso`). `[RH.14.5]` Departamento, puesto y sucursal, sólo a
   * quien no tiene acceso: los de una cuenta con acceso los administra Sistemas en `/admin/personas`.
   */
  async editarFicha(b: HrFichaPlazaBody): Promise<HrFichaPlazaDto> {
    const site = String(b?.site_code ?? '').trim();
    const codigo = String(b?.person_code ?? '').trim();
    if (!site || !codigo) throw new BadRequestException('Faltan la plaza y el código.');
    const v = validarFicha(b ?? {});
    if ('error' in v) throw new BadRequestException(v.error);
    return this.run(async (trx, tenant) => {
      let dueno = await this.duenoDe(trx, tenant, site, codigo);
      const antes = await trx('hr.person_site_profiles').where({ tenant_id: tenant, site_code: site, person_code: codigo })
        .forUpdate().first('report_section', 'is_promoter', 'is_active');
      const dePersona = v.departamento_code !== undefined || v.puesto_code !== undefined || v.sucursal_code !== undefined;
      // `[RH.20.1]` (David, 2026-11-24: «quiero que a todos se les pueda modificar aunque no estén en la Suite») Un código
      // del reloj que no es de nadie ya no frena la ficha: lo de la persona (nombre, departamento, puesto, sucursal) se
      // guarda DANDO DE ALTA a la persona sin acceso, el mismo alta de Relojes, y luego se aplica lo demás. Sin nombre
      // completo y sección no hay alta (las mismas reglas que en Relojes).
      if (!dueno && (v.nombre !== undefined || dePersona)) {
        dueno = await this.altaPorCodigo(trx, tenant, site, codigo, {
          nombre: v.nombre, seccion: v.seccion ?? antes?.report_section ?? undefined, promotora: v.promotora ?? antes?.is_promoter === true,
        });
      }
      if (!antes && !dueno && !(await this.hayReloj(trx, tenant, site, codigo))) {
        throw new NotFoundException('Ese código no tiene ficha ni reloj en esta plaza.');
      }
      if (v.nombre !== undefined || dePersona) {
        if (!dueno) throw new ConflictException('Ese código no está ligado a nadie: ligalo o dalo de alta en Relojes, y ahí va su nombre.');
        // `[RH.14.4]` El NOMBRE lo corrige RH a cualquiera (Edgar, 18-nov: «algunos me dejan cambiar su nombre y otros no»):
        // no da ni quita acceso a nada, y queda en la bitácora. Departamento, puesto y sucursal NO: con acceso, la sucursal y
        // la zona definen lo que la persona ve, y eso es de Sistemas (D2).
        if (dePersona && dueno.role_name !== ROL_SIN_ACCESO) {
          throw new ConflictException(`${dueno.nombre ?? 'Esta persona'} tiene acceso a la Suite: su departamento, puesto y sucursal los cambia Sistemas en Administración › Personas.`);
        }
      }
      // `[RH.14.5]` Lo de la persona: cada código tiene que existir en su catálogo; la zona sale de la sucursal.
      const cambiosPersona: Record<string, string | null> = {};
      let personaAntes: Record<string, string | null> | null = null;
      if (dePersona && dueno) {
        personaAntes = await trx('identity.users').where({ tenant_id: tenant, id: dueno.id })
          .first('department_code', 'position_code', 'warehouse_code', 'zona_id') as Record<string, string | null>;
        if (v.departamento_code !== undefined) {
          if (v.departamento_code && !(await trx('identity.departments').where({ tenant_id: tenant, code: v.departamento_code }).whereNull('deleted_at').first('code'))) {
            throw new BadRequestException('Ese departamento no existe.');
          }
          cambiosPersona['department_code'] = v.departamento_code;
        }
        if (v.puesto_code !== undefined) {
          if (v.puesto_code && !(await trx('identity.positions').where({ tenant_id: tenant, code: v.puesto_code }).whereNull('deleted_at').first('code'))) {
            throw new BadRequestException('Ese puesto no existe.');
          }
          cambiosPersona['position_code'] = v.puesto_code;
        }
        if (v.sucursal_code !== undefined) {
          let zona: string | null = null;
          if (v.sucursal_code) {
            const w = await trx('commercial.warehouses as w').where({ 'w.tenant_id': tenant }).whereNull('w.deleted_at')
              .whereRaw(`${branchKeySql('w')} = ?`, [v.sucursal_code]).first('w.zone_id');
            if (!w) throw new BadRequestException('Esa sucursal no existe.');
            zona = (w.zone_id as string | null) ?? null;
          }
          cambiosPersona['warehouse_code'] = v.sucursal_code;
          cambiosPersona['zona_id'] = zona;
        }
      }
      const q = this.quien();
      const ficha = {
        report_section: v.seccion ?? antes?.report_section ?? null,
        is_promoter: v.promotora ?? antes?.is_promoter ?? false,
      };
      await trx('hr.person_site_profiles').insert({
        tenant_id: tenant, site_code: site, person_code: codigo, ...ficha, is_active: antes?.is_active ?? true,
        source: 'suite', updated_by: q.id,
      }).onConflict(['tenant_id', 'site_code', 'person_code'])
        .merge({ ...ficha, updated_by: q.id, updated_at: trx.fn.now() });
      const cambiosUsuario: Record<string, unknown> = { ...cambiosPersona };
      if (v.nombre !== undefined && dueno && v.nombre !== dueno.nombre) cambiosUsuario['nombre'] = v.nombre;
      if (dueno && Object.keys(cambiosUsuario).length) {
        await trx('identity.users').where({ tenant_id: tenant, id: dueno.id }).update({ ...cambiosUsuario, updated_at: trx.fn.now() });
      }
      if (dueno) {
        await this.asentar(trx, tenant, dueno.id, 'ficha_plaza_editada', {
          site_code: site, codigo,
          antes: { nombre: dueno.nombre, seccion: antes?.report_section ?? null, promotora: antes?.is_promoter ?? false,
            ...(personaAntes ? Object.fromEntries(Object.keys(cambiosPersona).map((k) => [k, personaAntes?.[k] ?? null])) : {}) },
          despues: { nombre: v.nombre ?? dueno.nombre, seccion: ficha.report_section, promotora: ficha.is_promoter, ...cambiosPersona },
        });
      }
      return {
        site_code: site, person_code: codigo, seccion: ficha.report_section, promotora: ficha.is_promoter,
        nombre: v.nombre ?? dueno?.nombre ?? null,
      };
    });
  }

  async alta(id: string, b: HrAltaPersonaBody): Promise<HrLigarResultadoDto> {
    const v = validarAlta(b ?? {});
    if ('error' in v) throw new BadRequestException(v.error);
    return this.run(async (trx, tenant) => {
      const e = await this.tomar(trx, tenant, id);
      if (e.user_id) throw new ConflictException('Ese código ya está ligado a una persona.');
      const { userId, n } = await this.crearYLigar(trx, tenant, e, v, b.promotora === true);
      return { user_id: userId, nombre: v.nombre, enrolamientos: n };
    });
  }

  /** ¿El código checa en algún reloj activo de la plaza? */
  private async hayReloj(trx: Knex.Transaction, tenant: string, site: string, codigo: string): Promise<boolean> {
    return (await trx.raw(`
      SELECT 1 FROM hr.device_enrollments x
        JOIN hr.attendance_devices d ON d.tenant_id = x.tenant_id AND d.id = x.device_id
       WHERE x.tenant_id = ? AND d.site_code = ? AND COALESCE(x.person_code, x.device_user_id) = ? LIMIT 1`,
    [tenant, site, codigo])).rows.length > 0;
  }

  /**
   * `[RH.20.1]` El alta desde la FICHA de Asistencia (por plaza y código, no por enrolamiento): toma un enrolamiento sin
   * dueño de ese código en la plaza y da de alta a la persona sin acceso, igual que «Dar de alta» en Relojes.
   */
  private async altaPorCodigo(trx: Knex.Transaction, tenant: string, site: string, codigo: string,
    b: { nombre?: string; seccion?: string; promotora: boolean }): Promise<{ id: string; nombre: string | null; role_name: string; status: string | null }> {
    if (b.nombre === undefined) throw new BadRequestException('No está en la Suite: escribe su nombre completo para darla de alta.');
    const v = validarAlta({ nombre: b.nombre, seccion: b.seccion });
    if ('error' in v) throw new BadRequestException(`No está en la Suite y se da de alta al guardar. ${v.error}`);
    const fila = (await trx.raw(`
      SELECT x.id FROM hr.device_enrollments x
        JOIN hr.attendance_devices d ON d.tenant_id = x.tenant_id AND d.id = x.device_id
       WHERE x.tenant_id = ? AND d.site_code = ? AND COALESCE(x.person_code, x.device_user_id) = ? AND x.user_id IS NULL
       ORDER BY d.is_active DESC, x.last_seen_at DESC NULLS LAST LIMIT 1`, [tenant, site, codigo])).rows[0] as { id: string } | undefined;
    if (!fila) throw new ConflictException('Ese código no está en ningún reloj de esta plaza: no hay a quién dar de alta.');
    const e = await this.tomar(trx, tenant, String(fila.id));
    const { userId } = await this.crearYLigar(trx, tenant, e, v, b.promotora);
    return { id: userId, nombre: v.nombre, role_name: ROL_SIN_ACCESO, status: 'invited' };
  }

  /** Crea a la persona sin acceso, le hace su ficha en la plaza y le liga el código en los relojes de la plaza. */
  private async crearYLigar(trx: Knex.Transaction, tenant: string, e: Enrolamiento, v: { nombre: string; seccion: string }, promotora: boolean): Promise<{ userId: string; n: number }> {
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
      // `source` 'suite': sin él la columna toma su valor por omisión, 'mega_talento', y una ficha hecha aquí diría que
      // vino de la carga (`[RH.7.1]`). En el choque no se toca: la de la carga sigue diciendo de dónde vino.
      is_promoter: promotora, is_active: true, source: 'suite', updated_by: q.id,
    }).onConflict(['tenant_id', 'site_code', 'person_code']).merge(['report_section', 'is_promoter', 'is_active', 'updated_by', 'updated_at']);
    const n = await this.aplicarLiga(trx, tenant, e, userId, [], 'dado de alta por RH desde el reloj');
    await this.asentar(trx, tenant, userId, 'alta_desde_reloj', { site_code: e.site_code, codigo: e.codigo, seccion: v.seccion, promotora, enrolamientos: n });
    return { userId, n };
  }
}
