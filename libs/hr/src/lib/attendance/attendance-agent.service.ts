import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { Knex } from 'knex';
import { TenantContextService, TenantKnexService, latirCron, tomarCandadoDeCron } from '@megadulces/platform-core';
import * as reader from './attendance-reader';
import { detectarEnDatos, type ResumenDeteccion } from './logic/detector';
import type { BorradorAlerta } from './logic/tipos';
import { hoyMexico, menosDias } from './logic/fechas';
import { DIAS_EX_TRABAJADOR } from './logic/asistencia-persona';

/**
 * Fase RH · `[RH.1.5]` — EL AGENTE DE ALERTAS DE ASISTENCIA trabaja solo.
 *
 * Traslado de `detector.ts` + `persistencia.ts` + `corredor.ts` de Mega Talento. Revisa cada
 * sitio de checado por su cuenta y deja BORRADORES (`sugerida_ia`) para que RH decida. No
 * aprueba, no avisa a nadie, no da de baja a nadie (regla 80/20, ADR-020/084).
 *
 * ══ LAS DOS TRAMPAS QUE ESQUIVA (medidas en Mega Talento) ══
 * 1. La ventana termina en el ÚLTIMO DÍA CON DATO de cada sitio, nunca hoy: con dos sitios sin
 *    descargar 11 días, "hasta hoy" eran 561 faltas de gente que sí fue a trabajar.
 * 2. Quien ya no viene no acumula faltas: se analiza hasta su última checada (21 días de silencio).
 *
 * ══ IDEMPOTENTE Y SIN PISAR A RH ══
 * El UPSERT sólo refresca filas que siguen en `sugerida_ia`; la reconciliación sólo borra
 * borradores `sugerida_ia` que ya no se detectan. Lo que RH aprobó, rechazó o descartó no se toca.
 *
 * ══ DÓNDE CORRE ══
 * `@Cron` en el WORKER (la API arranca con `DISABLE_CRONS=true`). Un candado de base por sitio
 * (`tomarCandadoDeCron`) evita que dos instancias analicen lo mismo a la vez (en Mega Talento la
 * reconciliación de una podía borrar lo que la otra acababa de escribir). Cada sitio en su propia
 * transacción: lo que falla en uno no frena al resto, y su error queda en
 * `hr.attendance_agent_runs` con el mensaje real.
 *
 * ══ APAGADO HASTA EL CORTE ══
 * Corre sólo con `ENABLE_HR_ATTENDANCE_AGENT=true`. Hasta el corte de asistencia (`[RH.1.8]`) la
 * fuente viva es Mega Talento; correrlo antes generaría alertas sobre datos que no son los de
 * operación. Apagado tampoco late: un latido sin su fila en `CRON_JOBS` se pinta verde sin
 * umbral (`cfg ? classify : 'ok'`). La fila de `CRON_JOBS` y el encendido van juntos, en el corte.
 */

export const AGENT_JOB_KEY = 'hr_attendance_agent';
/** Ventana rodante del análisis automático. La historia profunda se analiza a mano, con rango. */
export const VENTANA_AGENTE_DIAS = 45;

export const agenteEncendido = (): boolean => process.env['ENABLE_HR_ATTENDANCE_AGENT'] === 'true';

export interface ResultadoSitio {
  siteCode: string;
  saltada: boolean;
  desde?: string;
  hasta?: string;
  creadas?: number;
  actualizadas?: number;
  eliminadas?: number;
  pendientes?: number;
  omitidosEx?: number;
  error?: string;
}

export interface ResultadoAnalisis {
  resumen: ResumenDeteccion;
  borradores: { creadas: number; actualizadas: number; sinCambio: number; eliminadas: number };
}

const motivo = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 500);

@Injectable()
export class HrAttendanceAgentService {
  private readonly logger = new Logger(HrAttendanceAgentService.name);
  private running = false;

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /** Cada 30 minutos (el `AGENTE_CADA_MIN` de Mega Talento). */
  @Cron('0 */30 * * * *')
  async scheduled(): Promise<void> {
    if (!agenteEncendido()) return;
    if (this.running) {
      this.logger.warn('Skip: la pasada anterior sigue en curso');
      return;
    }
    this.running = true;
    try {
      const tenants: Array<{ id: string }> = await this.tk.global('identity.tenants').select('id');
      for (const t of tenants) await this.pasada(t.id, {}).catch((e) => this.logger.error(`pasada ${t.id}: ${motivo(e)}`));
    } finally {
      this.running = false;
    }
  }

  /**
   * Adelanta la revisión del tenant de quien llama (alguien acaba de descargar un reloj). Va por
   * el MISMO camino que el cron. `forzar` ignora la huella: re-analiza aunque nada se haya movido.
   */
  async revisarAhora(siteCode?: string): Promise<{ sitios: ResultadoSitio[]; latido: boolean }> {
    return this.pasada(this.tenantCtx.requireTenantId(), { siteCode, forzar: true });
  }

  /** Una pasada por los sitios de un tenant. Nunca lanza por un sitio: su fallo se anota. */
  async pasada(tenantId: string, op: { siteCode?: string; forzar?: boolean }): Promise<{ sitios: ResultadoSitio[]; latido: boolean }> {
    const t0 = Date.now();
    const hoy = hoyMexico();
    const todas = await this.tk.run(tenantId, (trx) => reader.ventanas(trx, hoy, VENTANA_AGENTE_DIAS));
    const objetivo = op.siteCode ? todas.filter((v) => v.site_code === op.siteCode) : todas;
    const previas = new Map<string, string>(
      (await this.tk.run(tenantId, (trx) => trx('hr.attendance_agent_runs').whereNull('error').select('site_code', 'fingerprint')))
        .map((r: { site_code: string; fingerprint: string }) => [r.site_code, r.fingerprint]));

    const sitios: ResultadoSitio[] = [];
    for (const v of objetivo) {
      const inicio = menosDias(v.ultimo, VENTANA_AGENTE_DIAS - 1);
      const desde = inicio > v.primero ? inicio : v.primero;
      const huella = `${v.ultimo}|${v.en_ventana}`;
      sitios.push(await this.revisarSitio(tenantId, {
        siteCode: v.site_code, desde, hasta: v.ultimo, primero: v.primero, ultimo: v.ultimo, huella,
      }, op.forzar ? undefined : previas.get(v.site_code)));
    }

    let latido = false;
    if (agenteEncendido()) {
      const fallas = sitios.filter((s) => s.error).map((s) => `${s.siteCode}: ${s.error}`);
      const entregado = sitios.reduce((a, s) => a + (s.creadas || 0) + (s.actualizadas || 0) + (s.eliminadas || 0), 0);
      latido = await latirCron(this.tk.global, {
        jobKey: AGENT_JOB_KEY, label: 'RH · agente de alertas de asistencia', tenantId,
        rowsAffected: entregado, durationMs: Date.now() - t0, fallas,
        note: `${sitios.length} sitio(s) · ${sitios.filter((s) => s.saltada).length} sin cambios · ${entregado} alerta(s) movidas`,
        ceroEsOk: 'ningún reloj trajo checadas nuevas desde la pasada anterior, o no hubo nada que alertar',
        host: 'worker',
      });
    }
    return { sitios, latido };
  }

  private async revisarSitio(
    tenantId: string,
    v: { siteCode: string; desde: string; hasta: string; primero: string; ultimo: string; huella: string },
    huellaPrevia?: string,
  ): Promise<ResultadoSitio> {
    const t0 = Date.now();
    const base = {
      site_code: v.siteCode, window_from: v.desde, window_to: v.hasta,
      first_data: v.primero, last_data: v.ultimo, fingerprint: v.huella,
    };
    try {
      return await this.tk.run(tenantId, async (trx) => {
        if (!(await tomarCandadoDeCron(trx, `${AGENT_JOB_KEY}:${tenantId}:${v.siteCode}`))) {
          return { siteCode: v.siteCode, saltada: true, error: undefined };
        }
        if (huellaPrevia && huellaPrevia === v.huella) {
          await this.anotar(trx, tenantId, { ...base, skipped: true, pending: await this.pendientes(trx, v.siteCode), duration_ms: Date.now() - t0 });
          return { siteCode: v.siteCode, saltada: true };
        }
        const r = await this.analizarEn(trx, tenantId, { siteCode: v.siteCode, desde: v.desde, hasta: v.hasta, excluirSilenciososDias: DIAS_EX_TRABAJADOR });
        const pending = await this.pendientes(trx, v.siteCode);
        // HANDOFF: aquí PARA el agente. Los borradores quedan en 'sugerida_ia' y RH decide.
        await this.anotar(trx, tenantId, {
          ...base, skipped: false, persons: r.resumen.empleadosAnalizados, ex_workers: r.resumen.exTrabajadoresOmitidos,
          created: r.borradores.creadas, updated: r.borradores.actualizadas, deleted: r.borradores.eliminadas,
          pending, duration_ms: Date.now() - t0,
        });
        return {
          siteCode: v.siteCode, saltada: false, desde: v.desde, hasta: v.hasta,
          creadas: r.borradores.creadas, actualizadas: r.borradores.actualizadas, eliminadas: r.borradores.eliminadas,
          pendientes: pending, omitidosEx: r.resumen.exTrabajadoresOmitidos,
        };
      });
    } catch (e) {
      const err = motivo(e);
      this.logger.error(`sitio ${v.siteCode} falló: ${err}`);
      await this.tk.run(tenantId, (trx) => this.anotar(trx, tenantId, { ...base, skipped: false, error: err, duration_ms: Date.now() - t0 }))
        .catch((e2) => this.logger.error(`no se pudo anotar el fallo de ${v.siteCode}: ${motivo(e2)}`));
      return { siteCode: v.siteCode, saltada: false, error: err };
    }
  }

  /**
   * Análisis de un rango arbitrario (historia profunda, después de recuperar meses de un reloj).
   * Por omisión NO le sigue marcando faltas a quien dejó de venir; `incluirExTrabajadores` lo
   * apaga para una auditoría retroactiva (ruidoso para la operación diaria).
   */
  async analizar(p: { siteCode: string; desde: string; hasta: string; incluirExTrabajadores?: boolean }): Promise<ResultadoAnalisis> {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(tenantId, (trx) => this.analizarEn(trx, tenantId, {
      siteCode: p.siteCode, desde: p.desde, hasta: p.hasta,
      excluirSilenciososDias: p.incluirExTrabajadores ? null : DIAS_EX_TRABAJADOR,
    }));
  }

  private async analizarEn(
    trx: Knex.Transaction, tenantId: string,
    p: { siteCode: string; desde: string; hasta: string; excluirSilenciososDias: number | null },
  ): Promise<ResultadoAnalisis> {
    // En serie: una transacción es UNA conexión (ver el reporte).
    const config = await reader.cargarConfig(trx, p.siteCode);
    const padron = await reader.padron(trx, p.siteCode);
    const horarios = await reader.horariosDelSitio(trx, p.siteCode);
    const checadas = await reader.checadasDelRango(trx, p.siteCode, p.desde, p.hasta);
    const corte = p.excluirSilenciososDias
      ? await reader.ultimaChecadaDeSilenciosos(trx, p.siteCode, p.excluirSilenciososDias)
      : new Map<string, string>();
    const { borradores, resumen } = detectarEnDatos({
      sucursalId: p.siteCode, desde: p.desde, hasta: p.hasta, config, hoy: hoyMexico(),
      personas: padron.personas, horarios, checadas, cortePorCodigo: corte,
    });
    const guardado = await this.guardarBorradores(trx, tenantId, borradores);
    const eliminadas = await this.reconciliar(trx, p.siteCode, p.desde, p.hasta, borradores);
    return { resumen, borradores: { ...guardado, eliminadas } };
  }

  /**
   * UPSERT idempotente: sólo refresca lo que sigue en `sugerida_ia`. La justificación sugerida
   * sólo se pone si estaba vacía (RH pudo haberla editado). `xmax = 0` distingue insertada de
   * actualizada; las que chocan con una ya decidida no regresan.
   */
  private async guardarBorradores(trx: Knex.Transaction, tenantId: string, borradores: BorradorAlerta[]):
    Promise<{ creadas: number; actualizadas: number; sinCambio: number }> {
    let creadas = 0, actualizadas = 0;
    for (let i = 0; i < borradores.length; i += 500) {
      const lote = borradores.slice(i, i + 500).map((b) => ({
        site_code: b.sucursalId, person_code: b.empleadoCodigo, person_name: b.empleadoNombre || null,
        work_date: b.fecha, rule: b.regla, severity: b.severidad, detail: b.detalle,
        evidence: b.evidencia || {}, suggested_justification: b.justificacionSugerida || null,
      }));
      const { rows } = await trx.raw<{ rows: Array<{ insertada: boolean }> }>(`
        INSERT INTO hr.attendance_alerts
          (tenant_id, site_code, person_code, person_name, work_date, rule, severity, detail, evidence, suggested_justification)
        SELECT ?::uuid, x.site_code, x.person_code, x.person_name, x.work_date::date, x.rule, x.severity, x.detail, x.evidence, x.suggested_justification
          FROM jsonb_to_recordset(?::jsonb) AS x(site_code text, person_code text, person_name text, work_date text,
               rule text, severity text, detail text, evidence jsonb, suggested_justification text)
        ON CONFLICT (tenant_id, site_code, person_code, work_date, rule) DO UPDATE SET
          person_name = EXCLUDED.person_name,
          severity    = EXCLUDED.severity,
          detail      = EXCLUDED.detail,
          evidence    = EXCLUDED.evidence,
          suggested_justification = COALESCE(NULLIF(hr.attendance_alerts.suggested_justification, ''), EXCLUDED.suggested_justification),
          analyzed_at = now()
        WHERE hr.attendance_alerts.status = 'sugerida_ia'
        RETURNING (xmax = 0) AS insertada`, [tenantId, JSON.stringify(lote)]);
      for (const r of rows) { if (r.insertada) creadas++; else actualizadas++; }
    }
    return { creadas, actualizadas, sinCambio: Math.max(0, borradores.length - creadas - actualizadas) };
  }

  /** Borra los borradores `sugerida_ia` del rango que ya no se detectan. Nunca toca lo decidido. */
  private async reconciliar(trx: Knex.Transaction, siteCode: string, desde: string, hasta: string, borradores: BorradorAlerta[]): Promise<number> {
    const claves = borradores.map((b) => ({ p: b.empleadoCodigo, f: b.fecha, r: b.regla }));
    const { rowCount } = await trx.raw(`
      DELETE FROM hr.attendance_alerts a
       WHERE a.site_code = ? AND a.work_date BETWEEN ?::date AND ?::date AND a.status = 'sugerida_ia'
         AND NOT EXISTS (
           SELECT 1 FROM jsonb_to_recordset(?::jsonb) AS k(p text, f text, r text)
            WHERE k.p = a.person_code AND k.f::date = a.work_date AND k.r = a.rule)`,
      [siteCode, desde, hasta, JSON.stringify(claves)]);
    return rowCount || 0;
  }

  private async pendientes(trx: Knex.Transaction, siteCode: string): Promise<number> {
    const r = await trx('hr.attendance_alerts').where({ site_code: siteCode, status: 'sugerida_ia' }).count<{ n: string }[]>('* as n');
    return Number(r[0]?.n || 0);
  }

  private async anotar(trx: Knex.Transaction, tenantId: string, fila: Record<string, unknown>): Promise<void> {
    const completa = {
      tenant_id: tenantId, persons: null, ex_workers: null, created: null, updated: null, deleted: null,
      pending: null, error: null, ...fila, ran_at: trx.fn.now(),
    };
    await trx('hr.attendance_agent_runs').insert(completa).onConflict(['tenant_id', 'site_code']).merge();
  }

  /** Lo que la pantalla necesita para decir «esto se revisó solo, hace X». */
  async estado(): Promise<Record<string, unknown>> {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(tenantId, async (trx) => {
      const corridas: Array<Record<string, unknown> & { site_code: string; first_data: string | null; window_from: string | null }> =
        await trx('hr.attendance_agent_runs').orderBy('site_code').select(
          'site_code', 'skipped', 'persons', 'ex_workers', 'created', 'updated', 'deleted', 'pending',
          'duration_ms', 'error', 'fingerprint',
          trx.raw(`to_char(window_from, 'YYYY-MM-DD') AS window_from`), trx.raw(`to_char(window_to, 'YYYY-MM-DD') AS window_to`),
          trx.raw(`to_char(first_data, 'YYYY-MM-DD') AS first_data`), trx.raw(`to_char(last_data, 'YYYY-MM-DD') AS last_data`),
          'ran_at');
      const pend: Array<{ site_code: string; n: number }> = await trx('hr.attendance_alerts')
        .where({ status: 'sugerida_ia' }).groupBy('site_code').select('site_code', trx.raw('count(*)::int AS n'));
      const porSitio = new Map(pend.map((r) => [r.site_code, r.n]));
      return {
        encendido: agenteEncendido(), cadaMin: 30, ventanaDias: VENTANA_AGENTE_DIAS, diasEx: DIAS_EX_TRABAJADOR,
        corriendo: this.running,
        pendientesTotal: [...porSitio.values()].reduce((a, b) => a + b, 0),
        sitios: corridas.map((r) => ({
          ...r,
          pending: porSitio.get(r.site_code) ?? r['pending'] ?? 0,
          // Historia que la ventana rodante NO cubre: se dice, no se esconde.
          historia_sin_cubrir: !!(r.first_data && r.window_from && r.first_data < r.window_from),
        })),
      };
    });
  }
}
