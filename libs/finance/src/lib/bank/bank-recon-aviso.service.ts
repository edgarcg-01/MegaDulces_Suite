import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { KNEX_NEW_DB, latirCron, PgListenService, TenantContextService } from '@megadulces/platform-core';
import type { Knex } from 'knex';
import { CANAL_CAJA } from '../caja/caja-realtime.service';
import { FinanceBankService } from './finance-bank.service';
import {
  decidirCorrida, firmaVacia, periodosAEvaluar, textoFirma,
  type FirmaPeriodo,
} from './bank-recon-aviso.engine';

const MEGA = '00000000-0000-0000-0000-00000000d01c';

/** Con qué identidad firma la máquina lo que concilia; separable de lo que hizo una persona. */
const SVC_RECON = { id: '00000000-0000-0000-0000-0000000000cb', username: 'svc_conciliacion_bancos' };

/**
 * `[CB.53]` — **La conciliación corre cuando llega el dato, no cuando suena un reloj.**
 *
 * Pedido de Edgar, 2026-10-19: *«nada de crons»*. Hasta hoy el motor de conciliación
 * (`runMatch`) sólo corría **apretando un botón**: medido el 2026-10-21, el último pareo era de
 * la tarde anterior y octubre llevaba **62.9 % casado** contra el **89.1 %** de septiembre — no
 * porque el motor falle, sino porque nadie lo había vuelto a correr.
 *
 * ── Por qué un oyente y no un `@Cron` (lo que ya midió `[CG.197]` para Caja General) ────────
 *
 *     retraso        reloj: hasta su intervalo   ·  evento: segundos tras el cambio
 *     cuándo trabaja reloj: N veces al día       ·  evento: sólo si la fuente cambió
 *     costo          el mismo, haya o no cambios ·  sólo por cambio real
 *
 * ── El carril ya existe y ya corre en producción ────────────────────────────────────────────
 * `feeds-ingest` emite `pg_notify('caja_fuente', …)` cuando su UPSERT toca `kepler_ods.kdm1` o
 * `kdb1` — **las dos tablas de las que deriva `analytics.kepler_bank_movements`**, que es el
 * lado Kepler de la conciliación. No hay que construir el disparador: hay que subirse a él.
 *
 * ⭐ **Y acá, a diferencia de Caja, no hay que esperar ningún refresh:**
 * `kepler_bank_movements` es una **VISTA viva** (verificado en prod), no una matvista. Cuando
 * llega el aviso, el dato ya está. Caja tuvo que escuchar el aviso POSTERIOR al refresh porque
 * lee `mv_caja_movimientos`; ese problema no existe de este lado.
 *
 * ── Lo que cuesta una corrida, medido en prod (2026-10-21, sólo lectura) ────────────────────
 *   lado Kepler (ventana ±45 días):  2.41 s en frío · 1.01 s caliente · 12,429 filas
 *   lado banco (un periodo):         0.45 s · 3,943 filas
 * Por eso el aviso **no corre el motor directo**: espera a que la ráfaga de avisos termine
 * (`quiet`) y usa la firma del periodo para no repetir trabajo idéntico.
 *
 * ── ⚠️ El hueco, declarado (no lo descubras de nuevo) ───────────────────────────────────────
 * `caja_fuente` se dispara por los DOCUMENTOS (`kdm1`/`kdb1`). **La carga del estado de cuenta
 * no emite ningún aviso**, y tampoco lo hace el carril que escribe las pólizas `kdc2*` (entra
 * por hash y no avisa — es el mismo hueco `[CG.198]` de Caja). En la práctica eso se tapa solo
 * porque cada corrida re-evalúa el periodo ENTERO, no sólo lo nuevo: un estado de cuenta
 * cargado a las 10:00 lo recoge el primer aviso de Kepler que llegue después. Pero **no está
 * garantizado por construcción**, y ésa es la deuda: emitir el aviso también al terminar el
 * import del estado de cuenta.
 */
@Injectable()
export class BankReconPorAvisoService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BankReconPorAvisoService.name);
  private dejarDeEscuchar: (() => void) | null = null;
  private corriendo = false;
  /** Firma del último periodo procesado, por periodo. Vacío = todavía no corrió ninguno. */
  private readonly ultimaFirma = new Map<string, string>();
  private pendiente: NodeJS.Timeout | null = null;

  constructor(
    @Inject(KNEX_NEW_DB) private readonly knex: Knex,
    private readonly tenantCtx: TenantContextService,
    private readonly listen: PgListenService,
    private readonly bank: FinanceBankService,
  ) {}

  /**
   * ⛔ Opt-in explícito: **apagado salvo que valga exactamente `'true'`**, igual que el
   * autollenado de Caja y por la misma razón: `runMatch` **escribe** (`bank_recon_matches` y el
   * `recon_status` de cada movimiento). Un default encendido haría que desplegar fuera, por sí
   * solo, empezar a conciliar.
   */
  private get habilitado(): boolean {
    return String(process.env.ENABLE_BANK_RECON_AVISO ?? '').trim() === 'true';
  }

  /** Segundos de silencio antes de correr: colapsa la ráfaga de avisos en una sola corrida. */
  private get quietMs(): number {
    const v = Number(String(process.env.BANK_RECON_AVISO_QUIET_S ?? '').trim());
    return Number.isFinite(v) && v > 0 ? Math.min(v, 600) * 1000 : 60_000;
  }

  /**
   * Se engancha al aviso del carril. **Siempre se escucha, aun apagado**: así el log puede decir
   * «llegó un aviso y no corrí porque estoy apagado», que es la distinción que `[CG.195]` vino a
   * arreglar — un motor callado es indistinguible de uno roto.
   */
  onModuleInit(): void {
    /**
     * ⛔ **SÓLO EL WORKER ESCUCHA.** El mismo binario corre en el worker y en los pods de `api`
     * (medido en prod: **2 pods de `api` vivos** el 2026-10-21). Tres procesos suscritos al
     * mismo aviso son **tres corridas simultáneas** del mismo periodo, y desde afuera se ven
     * igual que una — es textual el defecto que `[CP.8.31]` dejó escrito para el cuadre de
     * ContPAQi. `WORKER` es el marcador que el propio repo ya usa (`QueueService.isWorker()`) y
     * está puesto únicamente en el worker.
     *
     * Se dice en el log en vez de callar: si mañana nadie concilia, la primera pregunta va a ser
     * «¿quién estaba escuchando?».
     */
    if (process.env.WORKER !== 'true') {
      this.logger.log(`no escucho ${CANAL_CAJA}: este proceso no es el worker (WORKER≠true)`);
      return;
    }
    try {
      this.dejarDeEscuchar = this.listen.escuchar(CANAL_CAJA, () => { this.programar(); });
      this.logger.log(
        `escuchando ${CANAL_CAJA} (sin reloj) · ${this.habilitado ? `ACTIVO, quiet ${this.quietMs / 1000}s` : 'APAGADO: no va a conciliar'}`,
      );
    } catch (e: unknown) {
      // ⛔ No tumba el arranque del worker: hay 50 trabajos más en este proceso. Se DICE, y el
      // latido se queda viejo, que es como db-health se entera.
      this.logger.error(
        `no se pudo escuchar ${CANAL_CAJA}: ${(e as Error)?.message} — la conciliación NO va a correr sola`,
      );
    }
  }

  onModuleDestroy(): void {
    this.dejarDeEscuchar?.();
    this.dejarDeEscuchar = null;
    if (this.pendiente) clearTimeout(this.pendiente);
    this.pendiente = null;
  }

  /**
   * Agenda la corrida tras `quiet` de silencio. Un lote de ingesta que emite diez avisos
   * seguidos produce **una** corrida, no diez: cada aviso corre el reloj de nuevo.
   */
  private programar(): void {
    if (this.pendiente) clearTimeout(this.pendiente);
    this.pendiente = setTimeout(() => {
      this.pendiente = null;
      void this.correr().catch((e: unknown) => {
        this.logger.error(`corrida por aviso falló: ${(e as Error)?.message}`);
      });
    }, this.quietMs);
    // `unref` para no sostener el proceso vivo sólo por este temporizador.
    this.pendiente.unref?.();
  }

  /** Expuesto para el candado y para un disparo a mano; no hay endpoint nuevo. */
  async correr(hoyMxOverride?: string): Promise<void> {
    const hoy = hoyMxOverride ?? new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
    for (const period of periodosAEvaluar(hoy)) {
      await this.correrPeriodo(period);
    }
  }

  private async correrPeriodo(period: string): Promise<void> {
    const t0 = Date.now();
    const firma = await this.firmaDe(period);
    const decision = decidirCorrida({
      habilitado: this.habilitado,
      corriendo: this.corriendo,
      firma,
      ultimaFirma: this.ultimaFirma.get(period) ?? '',
    });
    if (!decision.correr) {
      this.logger.log(`${period}: no corro — ${decision.motivo}: ${decision.detalle}`);
      return;
    }

    this.corriendo = true;
    try {
      this.logger.log(`${period}: conciliando — ${decision.detalle}`);
      /**
       * ⛔ **SIN ESTE SCOPE NO HAY TENANT Y NADA FUNCIONA.** Esto corre por un aviso de Postgres,
       * nunca dentro de un request, así que no hay `TenantContextInterceptor` que haya fijado el
       * contexto. `runMatch` pide `requireTenantId()` y `TenantKnexService` inyecta
       * `app.tenant_id` leyéndolo de acá. Sin el scope, la lectura no devuelve error: devuelve
       * CERO filas, que se lee como «no había nada que conciliar».
       */
      const r = await this.tenantCtx.run(
        { tenantId: MEGA, userId: SVC_RECON.id, username: SVC_RECON.username },
        () => this.bank.runMatch(period),
      );
      this.ultimaFirma.set(period, textoFirma(firma));
      const casados = Number((r as Record<string, unknown>)?.['matched'] ?? 0);
      await latirCron(this.knex, {
        jobKey: 'bank_recon_aviso',
        label: 'Bancos: la conciliación corre al llegar el dato, no por reloj',
        tenantId: MEGA,
        rowsAffected: casados,
        durationMs: Date.now() - t0,
        note: `${period} · ${decision.detalle}`,
        /**
         * Cero es un resultado legítimo acá, y hay que decir por qué o el latido lo marca
         * `error`: llegó dato nuevo y ninguno encontró pareja TODAVÍA. Es lo normal cuando el
         * movimiento del banco entra días antes de que Kepler capture el documento (mediana
         * 2–5 días, máximo 19 medido en octubre).
         */
        ceroEsOk: 'dato nuevo sin pareja todavía: el lado Kepler se captura días después',
      });
      this.logger.log(`${period}: listo en ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    } finally {
      this.corriendo = false;
    }
  }

  /**
   * La firma del periodo: barata a propósito (dos agregados), porque corre en cada aviso y el
   * motor completo cuesta ~3 s. Mira los DOS lados — un estado de cuenta recién cargado mueve la
   * firma aunque Kepler no se haya movido.
   */
  private async firmaDe(period: string): Promise<FirmaPeriodo> {
    const [yy, mm] = period.split('-').map(Number);
    const ini = `${period}-01`;
    const fin = mm >= 12 ? `${yy + 1}-01-01` : `${yy}-${String(mm + 1).padStart(2, '0')}-01`;
    try {
      const kep = await this.knex('analytics.kepler_bank_movements')
        .where('tenant_id', MEGA).whereNotNull('account_label')
        .andWhere('fecha_efectiva', '>=', ini).andWhere('fecha_efectiva', '<', fin)
        .whereRaw('signo <> 0')
        .first<{ filas: string; ultima: Date | null; centavos: string | null }>(
          this.knex.raw(`count(*)::text AS filas, max(fecha_efectiva) AS ultima,
                         coalesce(round(sum(abs(importe)) * 100), 0)::text AS centavos`),
        );
      const banco = await this.knex('finance.bank_movements as bm')
        .join('finance.bank_statements as st', 'st.id', 'bm.statement_id')
        .where('st.period', period).whereNull('bm.deleted_at')
        .first<{ filas: string; ultimo: Date | null }>(
          this.knex.raw(`count(*)::text AS filas, max(bm.updated_at) AS ultimo`),
        );
      const iso = (v: Date | null | undefined): string => (v ? new Date(v).toISOString() : '');
      return {
        kepFilas: Number(kep?.filas ?? 0),
        kepUltima: iso(kep?.ultima),
        kepCentavos: Number(kep?.centavos ?? 0),
        bancoFilas: Number(banco?.filas ?? 0),
        bancoUltimo: iso(banco?.ultimo),
      };
    } catch (e: unknown) {
      // Una firma que no se pudo medir NO se finge igual a la anterior: eso dejaría al motor
      // dormido para siempre. Se devuelve la vacía, que decide `sin_datos` y lo dice en el log.
      this.logger.warn(`${period}: no pude medir la firma: ${(e as Error)?.message}`);
      return firmaVacia;
    }
  }
}
