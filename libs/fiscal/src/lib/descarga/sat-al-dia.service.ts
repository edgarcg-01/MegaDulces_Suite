import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Knex } from 'knex';
import { CANAL_FUENTE_KEPLER, KNEX_NEW_DB, MiradaAlAviso, PgListenService, TenantKnexService, todayMx } from '@megadulces/platform-core';
import { FiscalJob, JobQueueService } from '../jobs/job-queue.service';
import { JobRunnerService } from '../jobs/job-runner.service';
import { DescargaService } from './descarga.service';
import { decidirAlDia, type SolicitudPrevia } from './al-dia';

export const JOB_AL_DIA = 'sat.al_dia';
export const ROLES_AL_DIA = ['recibidas', 'emitidas'] as const;
type Rol = (typeof ROLES_AL_DIA)[number];

/** Lo que se espera tras el primer aviso de Kepler antes de mirar: los avisos de en medio se absorben. */
const ESPERA_MS = 60_000;

/**
 * `[PGP.110c]` **La Suite se pone al día con el SAT sola, sin reloj.** Edgar, 2026-11-12.
 *
 * ── Qué la dispara ──────────────────────────────────────────────────────────────────────────────────
 * El SAT no avisa cuando aparece un CFDI. Lo que sí avisa es Kepler: `caja_fuente` suena con cada
 * documento que cambia de verdad en `kepler_ods.kdm1` (ventas, compras, caja), y cada documento de Kepler
 * es un CFDI que existe o va a existir en el SAT. El primer aviso del día encola UN job `sat.al_dia` por
 * RFC y rol, con llave por día: los demás avisos de ese día no encolan nada. Un día sin movimiento en
 * Kepler no le pregunta nada al SAT. Al arrancar el proceso mira una vez (NOTIFY no se guarda).
 *
 * ── Qué pide ────────────────────────────────────────────────────────────────────────────────────────
 * Lo decide `decidirAlDia` (función pura, con sus pruebas): desde el último día cubierto hasta hoy, una
 * a la vez, y nada si una solicitud dejó días sin cubrir. El porqué de cada regla está en `al-dia.ts`.
 * Lo que decidió queda en `fiscal.jobs.result`; si está frenada, además lo dice el log en `warn`.
 *
 * Sólo escucha en el worker (`WORKER=true`), como el apareo de entradas (`GoodsReceiptTwinsService`).
 * Se apaga con `DISABLE_SAT_AL_DIA=true`.
 */
@Injectable()
export class SatAlDiaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SatAlDiaService.name);
  private mirada: MiradaAlAviso | null = null;
  private dejarDeEscuchar: (() => void) | null = null;

  constructor(
    @Inject(KNEX_NEW_DB) private readonly knex: Knex,
    private readonly tk: TenantKnexService,
    private readonly runner: JobRunnerService,
    private readonly jobs: JobQueueService,
    private readonly descarga: DescargaService,
    private readonly listen: PgListenService,
  ) {}

  onModuleInit(): void {
    // El handler va en todo proceso; la cola la drena sólo el que corre los crons (el worker).
    this.runner.register(JOB_AL_DIA, (j) => this.ponerAlDia(j));
    if (process.env.DISABLE_SAT_AL_DIA === 'true') { this.logger.log('descarga automática del SAT APAGADA (DISABLE_SAT_AL_DIA)'); return; }
    if (process.env.WORKER !== 'true') { this.logger.log(`no escucho ${CANAL_FUENTE_KEPLER}: este proceso no es el worker (WORKER distinto de true)`); return; }
    // La firma es el día: cambia una vez al día, así que el trabajo corre con el primer aviso de cada día.
    this.mirada = new MiradaAlAviso(
      ESPERA_MS,
      async () => todayMx(),
      async (cambio) => { if (cambio) await this.encolarHoy(); },
      (e) => this.logger.error(`descarga automática del SAT: no se pudo encolar: ${(e as Error)?.message}`),
    );
    try {
      this.dejarDeEscuchar = this.listen.escuchar(CANAL_FUENTE_KEPLER, () => this.mirada?.avisar());
      this.logger.log(`escuchando ${CANAL_FUENTE_KEPLER} (sin reloj): pide al SAT lo nuevo una vez al día`);
    } catch (e: unknown) {
      this.logger.error(`no se pudo escuchar ${CANAL_FUENTE_KEPLER}: ${(e as Error)?.message} — la descarga automática NO va a correr`);
    }
    this.mirada.avisar();
  }

  onModuleDestroy(): void {
    this.dejarDeEscuchar?.();
    this.dejarDeEscuchar = null;
    this.mirada?.detener();
  }

  /** Un job por tenant, RFC con e.firma vigente y rol, con llave del día: re-encolar el mismo día no duplica. */
  async encolarHoy(): Promise<number> {
    const hoy = todayMx();
    const tenants: string[] = await this.knex('public.tenants').where({ activo: true }).pluck('id');
    let n = 0;
    for (const tenantId of tenants) {
      const rfcs: string[] = await this.tk.run(tenantId, async (trx) => trx('fiscal.sat_credentials')
        .where({ active: true })
        .andWhere((q) => q.whereNull('cer_valid_to').orWhere('cer_valid_to', '>=', hoy))
        .pluck('rfc'));
      for (const rfc of rfcs) {
        for (const rol of ROLES_AL_DIA) {
          await this.jobs.enqueue(tenantId, {
            queue: 'sat', type: JOB_AL_DIA, payload: { rfc, rol },
            dedupKey: `${JOB_AL_DIA}:${rfc}:${rol}:${hoy}`, maxAttempts: 3,
          });
          n++;
        }
      }
    }
    return n;
  }

  /** El job: lee las solicitudes previas de ese RFC y rol, decide, y si toca, pide. Corre en el scope del tenant. */
  async ponerAlDia(job: FiscalJob): Promise<Record<string, unknown>> {
    const { rfc, rol } = job.payload as { rfc: string; rol: Rol };
    const hoy = todayMx();
    // Las fechas son `date`: se leen como texto en SQL para no depender de la zona horaria del proceso.
    const previas = await this.tk.run(async (trx) => (await trx.raw(`
      SELECT estado, codigo_estado,
             to_char(fecha_ini, 'YYYY-MM-DD') AS fecha_ini, to_char(fecha_fin, 'YYYY-MM-DD') AS fecha_fin,
             to_char(created_at AT TIME ZONE 'America/Mexico_City', 'YYYY-MM-DD') AS creada,
             packages_total, packages_done
        FROM fiscal.download_requests
       WHERE rfc_solicitante = ? AND rol = ? AND tipo_solicitud = 'CFDI'`, [rfc, rol])).rows as SolicitudPrevia[]);
    const d = decidirAlDia(previas, hoy);
    if (d.accion === 'pedir') {
      const { id } = await this.descarga.crear({ rfcSolicitante: rfc, rol, tipo: 'CFDI', fechaIni: d.desde, fechaFin: d.hasta });
      this.logger.log(`descarga automática: ${rol} del ${d.desde} al ${d.hasta} → solicitud ${id}`);
      return { ...d, rol, solicitud: id };
    }
    if (d.accion === 'frenada') this.logger.warn(`descarga automática de ${rol} FRENADA (${d.motivo}): ${d.detalle}`);
    return { ...d, rol };
  }
}
