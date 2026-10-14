import { Injectable, Inject, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Knex } from 'knex';
import { KNEX_NEW_DB, TenantContextService } from '@megadulces/platform-core';
import { CaosIngresoReconService } from './caos-ingreso-recon.service';

const MEGA = '00000000-0000-0000-0000-00000000d01c';

/**
 * ⭐⭐ `[CG.58.5]` — **La atribución del efectivo de la caja fuerte corre SOLA.**
 *
 * Edgar, 2026-10-14: *"no apretemos ningún botón, que sea automático. automatizar esto es lo más
 * visible."*
 *
 * ── Por qué existe esta clase y no un botón ─────────────────────────────────────────────────
 *
 * `[CG.58]` (el conciliador) estaba **construido, probado y desplegado desde el 7-oct**, con su
 * motor y el candado `ux_caos_atrib_cobro_vivo` que impide en la base reusar un cobro. Y
 * `finance.caos_ingreso_atribucion` tenía **cero filas**, porque no tenía quién lo llamara: ni
 * botón, ni cron, ni enganche al arqueo. Mismo patrón que la Fase IC — *no faltaba módulo,
 * faltaba que se usara*.
 *
 * ⚠️ Yo había puesto un botón, apoyado en el precedente `[VEC.5]` (*lo que escribe a demanda lo
 * dispara quien va a mirar el resultado*). Edgar lo revirtió, y el motivo es bueno: un botón que
 * alguien tiene que acordarse de apretar **vuelve a quedarse en cero**, que es exactamente de
 * donde venimos. La atribución es determinista y acotada por su piso de fecha; no necesita
 * criterio humano, necesita constancia.
 *
 * ── Lo que lo hace seguro de automatizar, y conviene tenerlo escrito ────────────────────────
 *
 *  · **Es idempotente.** `conciliar()` descuenta lo ya atribuido antes de repartir, así que
 *    correrlo cada hora no duplica tramos. El candado de la base lo respalda.
 *  · **Tiene piso de fecha propio** (`2026-05-27`, el primer depósito que existe), y acota las
 *    DOS piernas — depósitos y cobros. Sin él, un FIFO consumiría el backlog de cobros que
 *    arranca en jul-2025, o sea 15 meses ANTES de que la caja fuerte existiera.
 *  · **Sólo agrega.** No borra ni reescribe atribuciones vivas.
 *
 * ── Latido de ENTREGA, no de ejecución (ADR-053) ────────────────────────────────────────────
 *
 * Mide **depósitos cubiertos**, no «el job corrió». ⚠️ Su umbral va en `CRON_JOBS`
 * (`caos_ingreso_conciliar`) o el sensor de `db-health` cae en el `cfg ? classify : 'ok'` que da
 * verde incondicional — el mismo modo de falla que la Fase VP midió sobre tres matvistas del
 * sell-out.
 *
 * ⛔ **Cero depósitos atribuidos NO es error por sí solo**, y acá está la diferencia con sus
 * hermanos: una vez que el backlog quedó repartido, lo normal es que una corrida no encuentre
 * nada nuevo. Lo que SÍ es error es que queden depósitos **pendientes** y la corrida no haya
 * podido cubrir ninguno: eso significa que el efectivo entró y ningún cobro lo explica.
 */
@Injectable()
export class CaosIngresoCronService {
  private readonly logger = new Logger(CaosIngresoCronService.name);

  constructor(
    @Inject(KNEX_NEW_DB) private readonly knex: Knex,
    private readonly recon: CaosIngresoReconService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /**
   * Cada hora en punto. ⚠️ No es nocturno a propósito: el efectivo entra durante el día y el
   * sell-out de la caja se mira en el día. Una atribución que sólo se entera de madrugada hace
   * que la pantalla publique «sin respaldo» toda la jornada sobre depósitos que sí tenían cobro.
   */
  @Cron('0 5 * * * *', { timeZone: 'America/Mexico_City' })
  async cadaHora(): Promise<void> {
    await this.correr();
  }

  /**
   * Corre el reparto y late. Nunca tira: un fallo del carril no puede tumbar el worker, y el
   * motivo viaja al latido en vez de perderse en un log.
   */
  async correr(): Promise<{ cubiertos: number; pendientes: number; motivo: string | null }> {
    const t0 = Date.now();
    let cubiertos = 0;
    let pendientes = 0;
    let motivo: string | null = null;

    try {
      /**
       * ⚠️ El servicio resuelve el tenant por `TenantContextService`, que en una petición HTTP
       * lo pone el interceptor. Acá NO hay petición: el cron corre en el worker, fuera de
       * cualquier request, así que hay que abrir el alcance a mano o `requireTenantId()` revienta.
       * Es el mismo patrón del refresco nocturno de recomendaciones (Fase D.4).
       */
      const r = await this.tenantCtx.run({ tenantId: MEGA }, () => this.recon.conciliar(null, {}));
      cubiertos = r.cubiertos ?? 0;
      pendientes = r.sin_respaldo ?? 0;
    } catch (e) {
      motivo = e instanceof Error ? e.message.slice(0, 300) : 'fallo sin mensaje';
      this.logger.error(`[CG.58.5] la atribución de CAOS falló: ${motivo}`);
    }

    await this.latir(cubiertos, pendientes, Date.now() - t0, motivo);
    return { cubiertos, pendientes, motivo };
  }

  private async latir(cubiertos: number, pendientes: number, ms: number, motivo: string | null): Promise<void> {
    try {
      /**
       * ⛔ El veredicto NO es «cubiertos === 0». Con el backlog ya repartido, cero es el estado
       * normal de una corrida. Error es que haya depósitos SIN RESPALDO y ninguno se haya podido
       * cubrir: ahí el efectivo entró y ningún cobro lo explica, que es justo lo que este carril
       * existe para hacer visible.
       */
      const error = motivo ?? (pendientes > 0 && cubiertos === 0
        ? `${pendientes} depósito(s) sin respaldo y ninguno cubierto en esta corrida`
        : null);
      await this.knex('analytics.cron_runs')
        .insert({
          tenant_id: MEGA,
          job_key: 'caos_ingreso_conciliar',
          label: 'Atribución del efectivo de la caja fuerte a cobros de Kepler',
          last_start: this.knex.fn.now(),
          last_finish: this.knex.fn.now(),
          status: error ? 'error' : 'ok',
          rows_affected: cubiertos,
          duration_ms: ms,
          note: error ? null : `${cubiertos} depósito(s) atribuidos · ${pendientes} sin respaldo`,
          error,
          host: 'worker',
          updated_at: this.knex.fn.now(),
        })
        .onConflict(['tenant_id', 'job_key'])
        .merge(['label', 'last_start', 'last_finish', 'status', 'rows_affected',
          'duration_ms', 'note', 'error', 'host', 'updated_at']);
    } catch (e) {
      // El latido es observabilidad: que falle no puede tumbar el carril que vigila.
      this.logger.warn(`[CG.58.5] no se pudo escribir el latido: ${e instanceof Error ? e.message : e}`);
    }
  }
}
