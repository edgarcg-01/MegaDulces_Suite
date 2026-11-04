import { Inject, Injectable, Logger } from '@nestjs/common';
import { KNEX_NEW_DB_ADMIN, Permission, TenantContextService } from '@megadulces/platform-core';
import {
  ordenarSenales, torreDeLlave, warehouseDisplayRank, warehouseName,
  type CaidaKepler, type CarrilTorre, type EstadoSenal, type SenalTorre, type ServidorKepler,
  type TorreDesarrollo, type TorreSistemas,
} from '@megadulces/contracts';
import type { Knex } from 'knex';
import { commitDelBuild } from '../../build-info';
import { DbHealthService, type DbHealthReport, type SourceHealth } from './db-health.service';

/**
 * `[TOR.2.1]`/`[TOR.2.2]` Las dos torres de control. No miden nada nuevo: reparten lo que ya miden
 * `db-health` (sus ~150 fuentes y latidos) y los catálogos de Postgres entre **Sistemas** (lo que
 * llega de Kepler y de otros servidores) y **Desarrollo** (nuestra plataforma), y agregan lo que
 * ninguna pantalla decía: caídas por servidor, si las alertas salen de la pantalla, la entrega.
 *
 * ⛔ Todo lo que no se pudo leer viaja `null` / `no_medido`; nunca 0 ni verde (ADR-056).
 */

/** Los 9 servidores Kepler, en el orden de `kepler-branches.js`. */
const CODIGOS_KEPLER = ['00', '01', '02', '03', '04', '05', '06', '07', '08'];
/** Un latido de servidor más viejo que esto ya no dice nada del presente (el poller late cada ~4 min). */
const LATIDO_VIGENTE_MS = 20 * 60 * 1000;
/** El repo es público: GitHub responde sin credencial (60 consultas/h por IP; se cachea 5 min). */
const REPO = process.env.TORRE_GITHUB_REPO || 'edgarcg-01/MegaDulces_Suite';

const ESTADO_DE: Record<SourceHealth['status'], EstadoSenal> = { ok: 'ok', warn: 'riesgo', critical: 'falla', unknown: 'no_medido' };
const PALABRA_DE: Record<EstadoSenal, string> = { ok: 'al día', riesgo: 'atrasado', falla: 'en falla', no_medido: 'no medido' };
const PESO: Record<EstadoSenal, number> = { falla: 3, riesgo: 2, no_medido: 1, ok: 0 };

/** Carriles de Sistemas que se agrupan en una tarjeta (el resto va a la bandeja si falla). */
const GRUPOS_SISTEMAS: { clave: string; nombre: string; llaves: string[] }[] = [
  { clave: 'replica-ods', nombre: 'Réplica → ODS', llaves: ['ods_live_mirror', 'ods_live_hot', 'ods_live_caja'] },
  { clave: 'completitud', nombre: 'Completitud del ODS', llaves: ['cdc_reconcile', 'cdc_reconcile_chicas', 'cdc_reconcile_ancho', 'cdc_reconcile_full'] },
  { clave: 'caja-general', nombre: 'Caja General (.mdb)', llaves: ['caja_general_replica_all', 'caja_general_ship'] },
  { clave: 'camionetas', nombre: 'Camionetas', llaves: ['rd_route_push_dia', 'route_collections', 'route_sales'] },
  { clave: 'relojes', nombre: 'Relojes checadores', llaves: ['hr_attendance_ingest', 'hr_attendance_agent'] },
  { clave: 'gps', nombre: 'GPS de flota', llaves: ['fleet_gps', 'fleet_positions'] },
];

interface Alerta { id: string; first_seen_at: string; acknowledged_at: string | null }
interface Refs { main: string | null; sellado: string | null; soltado: string | null; sin_soltar: number | null }

@Injectable()
export class TorresService {
  private readonly logger = new Logger(TorresService.name);
  private reporteCache: { at: number; p: Promise<DbHealthReport> } | null = null;
  private refsCache: { at: number; v: Refs } | null = null;
  private tieneDetail: boolean | null = null;

  constructor(
    @Inject(KNEX_NEW_DB_ADMIN) private readonly knex: Knex | null,
    private readonly tenantCtx: TenantContextService,
    private readonly salud: DbHealthService,
  ) {}

  /** Las dos torres se refrescan cada minuto por persona: el reporte pesado se comparte 20 s. */
  private reporte(): Promise<DbHealthReport> {
    if (!this.reporteCache || Date.now() - this.reporteCache.at > 20_000) {
      const p = this.salud.getReport();
      p.catch(() => { this.reporteCache = null; });
      this.reporteCache = { at: Date.now(), p };
    }
    return this.reporteCache.p;
  }

  private async alertasAbiertas(tenantId: string): Promise<Map<string, Alerta>> {
    const m = new Map<string, Alerta>();
    try {
      const rows = await this.knex!('analytics.db_health_alerts')
        .where({ tenant_id: tenantId }).whereNull('resolved_at')
        .select('id', 'source_key', 'first_seen_at', 'acknowledged_at');
      for (const r of rows as Array<Alerta & { source_key: string }>) {
        m.set(r.source_key, { id: r.id, first_seen_at: new Date(r.first_seen_at).toISOString(), acknowledged_at: r.acknowledged_at });
      }
    } catch (e) { this.logger.warn(`torres: alertas ilegibles: ${(e as Error).message}`); }
    return m;
  }

  private senalDeFuente(s: SourceHealth, alerta: Alerta | undefined): SenalTorre {
    const estado = ESTADO_DE[s.status];
    return {
      clave: s.key, que: s.label, porque: s.note || `cadencia esperada: ${s.cadence}`,
      estado, texto_estado: PALABRA_DE[estado],
      desde: alerta?.first_seen_at ?? s.last_update ?? null,
      dueno: null, alerta_id: alerta?.id ?? null, vista: !!alerta?.acknowledged_at,
    };
  }

  private carril(clave: string, nombre: string, miembros: SourceHealth[]): CarrilTorre {
    if (!miembros.length) return { clave, nombre, estado: 'no_medido', texto_estado: 'no medido', lineas: ['Ningún carril de este grupo reporta'] };
    const estado = miembros.map((m) => ESTADO_DE[m.status]).reduce((a, b) => (PESO[b] > PESO[a] ? b : a), 'ok' as EstadoSenal);
    return {
      clave, nombre, estado, texto_estado: PALABRA_DE[estado],
      lineas: miembros.map((m) => `${m.label}: ${PALABRA_DE[ESTADO_DE[m.status]]}${m.note ? ` · ${m.note}` : ''}`.slice(0, 220)),
    };
  }

  // ── Sistemas ────────────────────────────────────────────────────────────────────────────
  async sistemas(): Promise<TorreSistemas> {
    const verificado_al = new Date().toISOString();
    if (!this.knex) {
      return { verificado_al, servidores: [], caidas: null, atender: [], otros: [], avisos: null, mesa: null };
    }
    const tenantId = this.tenantCtx.requireTenantId();
    const [rep, alertas, latidos, horario, caidas, avisos, mesa] = await Promise.all([
      this.reporte(), this.alertasAbiertas(tenantId), this.latidosServidor(tenantId), this.horarioDeHoy(),
      this.caidas30d(tenantId), this.avisos(tenantId), this.mesa(tenantId),
    ]);
    const fuentes = rep.sources.filter((s) => torreDeLlave(s.key) === 'sistemas');

    const servidores = CODIGOS_KEPLER.map((codigo) => this.servidor(codigo, latidos, horario, caidas))
      .sort((a, b) => (PESO[b.estado] - PESO[a.estado]) || (warehouseDisplayRank(a.codigo) - warehouseDisplayRank(b.codigo)));

    const enGrupo = new Set(GRUPOS_SISTEMAS.flatMap((g) => g.llaves));
    const atender: SenalTorre[] = fuentes
      .filter((s) => !s.key.startsWith('kepler_server_') && (s.status === 'warn' || s.status === 'critical'))
      .map((s) => this.senalDeFuente(s, alertas.get(s.key)));
    if (mesa && mesa.abiertos > 0) {
      atender.push({
        clave: 'mesa-servicio', que: 'Mesa de Servicio', porque: `${mesa.asignados} asignados y ${mesa.en_espera} en espera`,
        estado: 'riesgo', texto_estado: `${mesa.abiertos} abiertos`, desde: null, dueno: null, alerta_id: null, vista: false,
      });
    }
    if (servidores.length && servidores.every((s) => s.disco_retenido_bytes == null)) {
      atender.push({
        clave: 'disco-servidores', que: 'Disco de los servidores Kepler',
        porque: 'Si md deja de leer, cada servidor guarda lo pendiente hasta llenar su disco y tirar la caja. Se mide cuando la sonda de los servidores corre en producción',
        estado: 'no_medido', texto_estado: 'no medido', desde: null, dueno: null, alerta_id: null, vista: false,
      });
    }

    const otros = GRUPOS_SISTEMAS.map((g) => this.carril(g.clave, g.nombre, fuentes.filter((s) => g.llaves.includes(s.key))));
    const resto = fuentes.filter((s) => !s.key.startsWith('kepler_server_') && !enGrupo.has(s.key));
    const restoMal = resto.filter((s) => s.status === 'warn' || s.status === 'critical').length;
    otros.push({
      clave: 'resto', nombre: 'Demás carriles de entrada',
      estado: restoMal ? 'riesgo' : 'ok', texto_estado: restoMal ? `${restoMal} con problema` : 'al día',
      lineas: [`${resto.length} carriles (feeds de Kepler, ContPAQi, CAOS, existencias)`, restoMal ? 'Los que fallan están en «Atender»' : 'Ninguno con problema'],
    });
    otros.push({ clave: 'escritorio-249', nombre: 'Escritorio .249', estado: 'no_medido', texto_estado: 'no medido', lineas: ['Windows con sesión iniciada; por aquí pasan CEDIS, Wincaja y el push de las camionetas'] });

    return { verificado_al, servidores, caidas: caidas?.lista ?? null, atender: ordenarSenales(atender), otros, avisos, mesa };
  }

  private servidor(
    codigo: string,
    latidos: { servidores: Map<string, { status: string; error: string | null; note: string | null; last_finish: string | null; detail: Record<string, unknown> | null }>; poller: { status: string; error: string | null; last_finish: string | null } | null },
    horario: Map<string, { abre: string; cierra: string }> | null,
    caidas: { porSucursal: Map<string, { n: number; max: number }> } | null,
  ): ServidorKepler {
    const l = latidos.servidores.get(codigo);
    const d = (l?.detail ?? null) as Record<string, number | string | boolean | null> | null;
    const vigente = (iso: string | null | undefined) => !!iso && Date.now() - Date.parse(iso) < LATIDO_VIGENTE_MS;
    let estado: EstadoSenal = 'no_medido';
    let texto = 'sin latido';
    let falla: string | null = null;
    if (l && vigente(l.last_finish)) {
      if (l.status === 'error') {
        estado = 'falla';
        falla = l.error;
        texto = d?.['tipo_falla'] === 'inalcanzable' ? 'no responde' : d?.['tipo_falla'] === 'lento' ? 'lento' : d?.['responde'] === false ? 'no responde' : 'con falla';
      } else { estado = 'ok'; texto = 'responde'; }
    } else if (latidos.poller && vigente(latidos.poller.last_finish)) {
      // Antes de que la sonda por servidor corra en producción: lo que dice la consulta de tienda en vivo.
      const re = new RegExp(`(^| · )${codigo} [^:·]+: ([^·]*)`);
      const m = re.exec(latidos.poller.error || '');
      if (m) { estado = 'falla'; falla = m[2].trim(); texto = /EHOSTUNREACH|ECONNREFUSED|ENETUNREACH/i.test(m[2]) ? 'no responde' : /timeout/i.test(m[2]) ? 'lento' : 'con falla'; }
      else { estado = 'ok'; texto = 'responde'; }
    }
    const num = (k: string) => (d && d[k] != null && Number.isFinite(Number(d[k])) ? Number(d[k]) : null);
    const h = horario?.get(codigo) ?? null;
    const c = caidas?.porSucursal.get(codigo);
    return {
      codigo, nombre: warehouseName(codigo) || codigo, estado, texto_estado: texto, falla,
      replica_s: num('replica_s'), errores_replica: num('errores_replica'), disco_retenido_bytes: num('retenido_max_bytes'),
      sin_tope_wal: d && typeof d['sin_tope_wal'] === 'boolean' ? (d['sin_tope_wal'] as boolean) : null,
      tablas_publicadas: num('publicadas'), arranque: d && typeof d['arranque'] === 'string' ? (d['arranque'] as string) : null,
      abre: h?.abre ?? null, cierra: h?.cierra ?? null,
      caidas_30d: caidas ? (c?.n ?? 0) : null, caida_mas_larga_min: caidas ? (c?.max ?? 0) : null,
      ultimo_latido: l?.last_finish ?? null,
    };
  }

  private async latidosServidor(tenantId: string) {
    const servidores = new Map<string, { status: string; error: string | null; note: string | null; last_finish: string | null; detail: Record<string, unknown> | null }>();
    let poller: { status: string; error: string | null; last_finish: string | null } | null = null;
    try {
      if (this.tieneDetail === null) {
        const r = await this.knex!.raw(`SELECT 1 FROM information_schema.columns
          WHERE table_schema='analytics' AND table_name='cron_runs' AND column_name='detail'`);
        this.tieneDetail = r.rows.length > 0;
      }
      const { rows } = await this.knex!.raw(
        `SELECT job_key, status, error, note, last_finish, ${this.tieneDetail ? 'detail' : 'NULL::jsonb AS detail'}
           FROM analytics.cron_runs
          WHERE tenant_id = ? AND (job_key LIKE 'kepler\\_server\\_%' OR job_key = 'store_poller')`, [tenantId]);
      for (const r of rows as Array<{ job_key: string; status: string; error: string | null; note: string | null; last_finish: Date | null; detail: Record<string, unknown> | null }>) {
        const lf = r.last_finish ? new Date(r.last_finish).toISOString() : null;
        if (r.job_key === 'store_poller') poller = { status: r.status, error: r.error, last_finish: lf };
        else servidores.set(r.job_key.replace('kepler_server_', ''), { status: r.status, error: r.error, note: r.note, last_finish: lf, detail: r.detail });
      }
    } catch (e) { this.logger.warn(`torres: latidos de servidor ilegibles: ${(e as Error).message}`); }
    return { servidores, poller };
  }

  /**
   * `[TOR.0.10]` El horario de HOY por sucursal, derivado de su venta: los mismos días de la semana
   * de las 8 semanas anteriores (mediana de la primera y la última venta). Mismo criterio que el
   * sensor «sucursal congelada». `null` = no se pudo leer.
   */
  private async horarioDeHoy(): Promise<Map<string, { abre: string; cierra: string }> | null> {
    try {
      const { rows } = await this.knex!.raw(`
        WITH w AS (SELECT (now() AT TIME ZONE 'America/Mexico_City')::date AS hoy),
        hist AS (
          SELECT k.sucursal, k.c9::date AS dia, min(k.c62::time) AS primera, max(k.c62::time) AS ultima
            FROM kepler_ods.kdm1 k, w
           WHERE k.c2='U' AND k.c3='D' AND k.c4=10 AND k.c62 ~ '^[0-9]{1,2}:[0-9]{2}'
             AND k.c9::date IN (w.hoy - 7, w.hoy - 14, w.hoy - 21, w.hoy - 28, w.hoy - 35, w.hoy - 42, w.hoy - 49, w.hoy - 56)
           GROUP BY 1, 2)
        SELECT sucursal, to_char(percentile_disc(0.5) WITHIN GROUP (ORDER BY primera), 'HH24:MI') AS abre,
               to_char(percentile_disc(0.5) WITHIN GROUP (ORDER BY ultima), 'HH24:MI') AS cierra
          FROM hist GROUP BY 1 HAVING count(*) >= 3`);
      const m = new Map<string, { abre: string; cierra: string }>();
      for (const r of rows as Array<{ sucursal: string; abre: string; cierra: string }>) {
        // CEDIS (00) no vende al público: su «horario» no significa nada y no se publica.
        if (r.sucursal !== '00') m.set(String(r.sucursal).trim(), { abre: r.abre, cierra: r.cierra });
      }
      return m;
    } catch (e) { this.logger.warn(`torres: horario ilegible: ${(e as Error).message}`); return null; }
  }

  /** `[TOR.0.8]` Caídas por servidor (vista `v_kepler_server_episodes`). `null` si la vista no está. */
  private async caidas30d(tenantId: string): Promise<{ lista: CaidaKepler[]; porSucursal: Map<string, { n: number; max: number }> } | null> {
    try {
      const reg = await this.knex!.raw(`SELECT to_regclass('analytics.v_kepler_server_episodes') AS t`);
      if (!reg.rows[0]?.t) return null;
      const { rows } = await this.knex!.raw(`
        SELECT sucursal, desde, hasta, minutos::float AS minutos, tipo
          FROM analytics.v_kepler_server_episodes
         WHERE tenant_id = ? AND desde > now() - interval '30 days'
         ORDER BY desde DESC`, [tenantId]);
      const lista: CaidaKepler[] = [];
      const porSucursal = new Map<string, { n: number; max: number }>();
      for (const r of rows as Array<{ sucursal: string; desde: Date; hasta: Date; minutos: number; tipo: CaidaKepler['tipo'] }>) {
        const p = porSucursal.get(r.sucursal) ?? { n: 0, max: 0 };
        p.max = Math.max(p.max, Number(r.minutos));
        if (Number(r.minutos) >= 10) {
          p.n++;
          lista.push({ codigo: r.sucursal, desde: new Date(r.desde).toISOString(), hasta: new Date(r.hasta).toISOString(), minutos: Number(r.minutos), tipo: r.tipo });
        }
        porSucursal.set(r.sucursal, p);
      }
      return { lista, porSucursal };
    } catch (e) { this.logger.warn(`torres: caídas ilegibles: ${(e as Error).message}`); return null; }
  }

  /** ¿Las alertas salen de la pantalla? Medido el 2026-11-04: 633 en 30 días, 0 avisadas. */
  private async avisos(tenantId: string): Promise<TorreSistemas['avisos']> {
    try {
      const r = await this.knex!('analytics.db_health_alerts').where({ tenant_id: tenantId })
        .where('first_seen_at', '>', this.knex!.raw(`now() - interval '30 days'`))
        .select(this.knex!.raw('count(*)::int AS abiertas'), this.knex!.raw('count(last_notified_at)::int AS notificadas')).first();
      const x = r as { abiertas?: number; notificadas?: number } | undefined;
      return { abiertas_30d: Number(x?.abiertas) || 0, notificadas_30d: Number(x?.notificadas) || 0 };
    } catch (e) { this.logger.warn(`torres: avisos ilegibles: ${(e as Error).message}`); return null; }
  }

  private async mesa(tenantId: string): Promise<TorreSistemas['mesa']> {
    try {
      const reg = await this.knex!.raw(`SELECT to_regclass('servicedesk.requests') AS t`);
      if (!reg.rows[0]?.t) return null;
      const r = await this.knex!('servicedesk.requests').where({ tenant_id: tenantId }).whereNull('deleted_at')
        .whereRaw('coalesce(is_test, false) = false').whereNotIn('status', ['cerrado', 'resuelto'])
        .select(this.knex!.raw('count(*)::int AS abiertos'),
          this.knex!.raw(`count(*) FILTER (WHERE status = 'asignado')::int AS asignados`),
          this.knex!.raw(`count(*) FILTER (WHERE status = 'en_espera')::int AS en_espera`)).first();
      const x = r as { abiertos?: number; asignados?: number; en_espera?: number } | undefined;
      return { abiertos: Number(x?.abiertos) || 0, asignados: Number(x?.asignados) || 0, en_espera: Number(x?.en_espera) || 0 };
    } catch (e) { this.logger.warn(`torres: mesa ilegible: ${(e as Error).message}`); return null; }
  }

  // ── Desarrollo ──────────────────────────────────────────────────────────────────────────
  async desarrollo(): Promise<TorreDesarrollo> {
    const verificado_al = new Date().toISOString();
    const corriendo = commitDelBuild();
    const arriba_desde = new Date(Date.now() - process.uptime() * 1000).toISOString();
    if (!this.knex) {
      return {
        verificado_al, atender: [], carriles: [],
        entrega: { main: null, sellado: null, soltado: null, corriendo, arriba_desde, sin_soltar: null, migraciones_pendientes: null },
      };
    }
    const tenantId = this.tenantCtx.requireTenantId();
    const [rep, alertas, refs, motor, lentas, sinRepartir, corridas, arranquePg] = await Promise.all([
      this.reporte(), this.alertasAbiertas(tenantId), this.refs(), this.salud.getEngineReport(),
      this.consultasLentas(), this.permisosSinRepartir(tenantId), this.corridas7d(tenantId), this.arranquePostgres(),
    ]);
    const fuentes = rep.sources.filter((s) => torreDeLlave(s.key) === 'desarrollo');
    const por = (k: string) => rep.sources.find((s) => s.key === k);

    // Migraciones pendientes: sólo se saben cuando el despliegue las encuentra y lo dice en su latido.
    const autoDeploy = por('auto_deploy');
    const mPend = /(\d+)\s+migraci/i.exec(autoDeploy?.note || '');

    const atender: SenalTorre[] = fuentes
      .filter((s) => s.status === 'warn' || s.status === 'critical')
      .map((s) => this.senalDeFuente(s, alertas.get(s.key)));
    if (lentas != null && lentas > 0) {
      atender.push({ clave: 'consultas-lentas', que: 'Consultas lentas', porque: `${lentas} tipos de consulta tardan más de 500 ms en promedio desde el último arranque de la base`, estado: 'riesgo', texto_estado: `${lentas} lentas`, desde: arranquePg, dueno: null, alerta_id: null, vista: false });
    }
    if (sinRepartir != null && sinRepartir.length > 0) {
      atender.push({ clave: 'permisos-sin-repartir', que: 'Permisos sin repartir', porque: `Ningún puesto los tiene: ${sinRepartir.slice(0, 6).join(', ')}${sinRepartir.length > 6 ? '…' : ''}`, estado: 'riesgo', texto_estado: `${sinRepartir.length} sin puesto`, desde: null, dueno: null, alerta_id: null, vista: false });
    }
    atender.push({ clave: 'errores-app', que: 'Errores de la aplicación', porque: 'No hay fuente de excepciones por endpoint: falta confirmar si Sentry está prendido en producción', estado: 'no_medido', texto_estado: 'no medido', desde: null, dueno: null, alerta_id: null, vista: false });

    const respaldos = this.carril('respaldos', 'Respaldos', ['backup_prod', 'pgbackrest_backup', 'respaldo_fuera'].map(por).filter((x): x is SourceHealth => !!x));
    const conteo = (e: EstadoSenal) => fuentes.filter((s) => ESTADO_DE[s.status] === e).length;
    const fallasSuite = conteo('falla');
    const carriles: CarrilTorre[] = [
      respaldos,
      {
        clave: 'suite', nombre: 'Carriles de la suite',
        estado: fallasSuite ? 'falla' : conteo('riesgo') ? 'riesgo' : 'ok',
        texto_estado: fallasSuite ? `${fallasSuite} en falla` : conteo('riesgo') ? `${conteo('riesgo')} atrasados` : 'al día',
        lineas: [
          `${fuentes.length} carriles y sondas · ${conteo('riesgo')} atrasados · ${conteo('no_medido')} sin medir`,
          corridas ? `${corridas.fallas.toLocaleString('es-MX')} corridas fallidas de ${corridas.total.toLocaleString('es-MX')} en 7 días (todas las torres)` : 'corridas de 7 días: no medido',
        ],
      },
      {
        clave: 'base', nombre: 'Base de datos',
        estado: motor.error ? 'no_medido' : (lentas ?? 0) > 0 ? 'riesgo' : ESTADO_DE[motor.overall],
        texto_estado: motor.error ? 'no medido' : (lentas ?? 0) > 0 ? 'consultas lentas' : PALABRA_DE[ESTADO_DE[motor.overall]],
        lineas: motor.error ? [`No se pudo leer el motor: ${motor.error}`] : [
          `${motor.database.size_pretty} · ${motor.metrics.find((m) => m.key === 'connections')?.display ?? 'conexiones: no medido'}`,
          lentas == null ? 'consultas lentas: no medido' : `${lentas} consultas con media de más de 500 ms`,
          arranquePg ? `Postgres arrancó ${this.fechaMx(arranquePg)}` : 'arranque de Postgres: no medido',
        ],
      },
      {
        clave: 'vida', nombre: 'Vida',
        estado: ESTADO_DE[por('tunel_cloudflared')?.status ?? 'unknown'] === 'falla' ? 'falla' : 'ok',
        texto_estado: ESTADO_DE[por('tunel_cloudflared')?.status ?? 'unknown'] === 'falla' ? 'túnel caído' : 'responde',
        lineas: [
          `API: ${corriendo} · arriba desde ${this.fechaMx(arriba_desde)}`,
          `Túnel: ${PALABRA_DE[ESTADO_DE[por('tunel_cloudflared')?.status ?? 'unknown']]}${por('tunel_cloudflared')?.note ? ` · ${por('tunel_cloudflared')!.note}` : ''}`,
          'Pods de k3s: no medido',
        ],
      },
      this.carril('disco', 'Disco de md', ['vigia_disco', 'poda_disco', 'poda_registro'].map(por).filter((x): x is SourceHealth => !!x)),
      { clave: 'errores', nombre: 'Errores de la app', estado: 'no_medido', texto_estado: 'no medido', lineas: ['Sin fuente de excepciones por endpoint', 'Pendiente: confirmar Sentry en producción'] },
    ];

    return {
      verificado_al,
      entrega: {
        main: refs.main, sellado: refs.sellado, soltado: refs.soltado, corriendo, arriba_desde,
        sin_soltar: refs.sin_soltar, migraciones_pendientes: mPend ? Number(mPend[1]) : null,
      },
      atender: ordenarSenales(atender),
      carriles,
    };
  }

  private fechaMx(iso: string): string {
    return new Date(iso).toLocaleString('es-MX', { timeZone: 'America/Mexico_City', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  }

  /**
   * `main`, `ci-green` (sellado) y `prod-release` (soltado), leídos de GitHub y cacheados 5 min.
   * Si GitHub no contesta, los tres van `null`: la pantalla dice «no medido», no inventa.
   */
  private async refs(): Promise<Refs> {
    if (this.refsCache && Date.now() - this.refsCache.at < 5 * 60_000) return this.refsCache.v;
    const vacio: Refs = { main: null, sellado: null, soltado: null, sin_soltar: null };
    try {
      const r = await fetch(`https://api.github.com/repos/${REPO}/git/matching-refs/heads/`, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'megadulces-torre' }, signal: AbortSignal.timeout(4000),
      });
      if (!r.ok) throw new Error(`GitHub ${r.status}`);
      const lista = (await r.json()) as Array<{ ref: string; object: { sha: string } }>;
      const sha = (n: string) => lista.find((x) => x.ref === `refs/heads/${n}`)?.object.sha ?? null;
      const v: Refs = { main: sha('main'), sellado: sha('ci-green'), soltado: sha('prod-release'), sin_soltar: null };
      if (v.sellado && v.soltado) {
        if (v.sellado === v.soltado) v.sin_soltar = 0;
        else {
          const c = await fetch(`https://api.github.com/repos/${REPO}/compare/${v.soltado}...${v.sellado}`, {
            headers: { accept: 'application/vnd.github+json', 'user-agent': 'megadulces-torre' }, signal: AbortSignal.timeout(4000),
          });
          if (c.ok) v.sin_soltar = Number(((await c.json()) as { ahead_by?: number }).ahead_by ?? null);
        }
      }
      const corto = (s: string | null) => (s ? s.slice(0, 9) : null);
      const out: Refs = { main: corto(v.main), sellado: corto(v.sellado), soltado: corto(v.soltado), sin_soltar: v.sin_soltar };
      this.refsCache = { at: Date.now(), v: out };
      return out;
    } catch (e) {
      this.logger.warn(`torres: refs de GitHub ilegibles: ${(e as Error).message}`);
      this.refsCache = { at: Date.now(), v: vacio };
      return vacio;
    }
  }

  /** Tipos de consulta con media > 500 ms (`pg_stat_statements`, en el schema donde esté instalada). */
  private async consultasLentas(): Promise<number | null> {
    try {
      const s = await this.knex!.raw(`SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'pg_stat_statements'`);
      const sch = s.rows[0]?.nspname as string | undefined;
      if (!sch || !/^[a-z_][a-z0-9_]*$/.test(sch)) return null;
      const r = await this.knex!.raw(`SELECT count(*)::int AS n FROM ${sch}.pg_stat_statements WHERE mean_exec_time > 500`);
      return Number(r.rows[0]?.n ?? null);
    } catch (e) { this.logger.warn(`torres: pg_stat_statements ilegible: ${(e as Error).message}`); return null; }
  }

  /** Regla 20: permisos declarados que ningún puesto vivo tiene (fuera de los de plataforma). */
  private async permisosSinRepartir(tenantId: string): Promise<string[] | null> {
    try {
      const { rows } = await this.knex!.raw(`
        SELECT DISTINCT e.k FROM identity.role_permissions rp, jsonb_each(rp.permissions) AS e(k, v)
         WHERE rp.tenant_id = ? AND rp.deleted_at IS NULL AND coalesce(rp.activo, true)
           AND NOT coalesce(rp.is_platform_admin, false) AND rp.role_name NOT LIKE 'retirado\\_%'
           AND e.v = 'true'::jsonb`, [tenantId]);
      const otorgados = new Set((rows as Array<{ k: string }>).map((r) => r.k));
      return (Object.values(Permission) as string[]).filter((p) => !otorgados.has(p)).sort();
    } catch (e) { this.logger.warn(`torres: permisos ilegibles: ${(e as Error).message}`); return null; }
  }

  private async corridas7d(tenantId: string): Promise<{ total: number; fallas: number } | null> {
    try {
      const { rows } = await this.knex!.raw(`
        SELECT count(*)::int AS total, count(*) FILTER (WHERE status <> 'ok')::int AS fallas
          FROM analytics.cron_run_log WHERE tenant_id = ? AND finished_at > now() - interval '7 days'`, [tenantId]);
      return { total: Number(rows[0]?.total) || 0, fallas: Number(rows[0]?.fallas) || 0 };
    } catch (e) { this.logger.warn(`torres: bitácora ilegible: ${(e as Error).message}`); return null; }
  }

  private async arranquePostgres(): Promise<string | null> {
    try {
      const { rows } = await this.knex!.raw(`SELECT pg_postmaster_start_time() AS t`);
      return rows[0]?.t ? new Date(rows[0].t).toISOString() : null;
    } catch { return null; }
  }
}
