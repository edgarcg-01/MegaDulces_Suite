import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Knex } from 'knex';
import { KNEX_NEW_DB, TenantContextService } from '@megadulces/platform-core';
import { SupplierPaymentProofsService } from './supplier-payment-proofs.service';
import { veredictoPasada, notaPasada, pasadaVacia, type ResultadoRelectura } from './relectura.engine';

/**
 * `[AT.1]` — **Los comprobantes de pago se clasifican y se validan solos.**
 *
 * ## Lo que estaba pasando, medido en prod el 2026-10-12
 *
 * El auto-validador de `[PC.6]` **funciona**: firmó 82 de las 83 validaciones de octubre. Lo que
 * no existía era que corriera **solo**. Las dos únicas formas de dispararlo eran adjuntar un
 * comprobante nuevo (`attach`) o apretar el botón «Volver a comparar», y el resultado se ve en la
 * cola:
 *
 * | | medido |
 * |---|---|
 * | Comprobantes de pago `recibido` | **1,259** |
 * | Validaciones **humanas** de toda la historia | **9** (`superoot` 4, `superuser` 5) |
 * | Órdenes de entrada sin validar desde el 1-sep | **647** |
 * | Filas de `analytics.cron_runs` para este módulo | **ninguna** |
 *
 * ⭐⭐ Y lo más caro: **920 de los 926 comprobantes sin resolver entraron el mismo día**
 * (2026-08-05, una sola carga). Un rezago que nació de golpe y que nadie podía drenar apretando
 * un botón que procesa de a 500 y no desbloquea ninguno.
 *
 * ## ⛔ Lo que este carril NO hace
 *
 * No valida nada por su cuenta: llama a `relectura()`, que llama a `decidirAutomatico()`, que es
 * la regla de `[PC.6]` con sus cinco guardas intactas. **La decisión la toma el cruce exacto
 * contra Kepler**, no este cron y no el modelo de visión. Este archivo sólo quita la obligación
 * de que alguien se acuerde de pedirlo — que es lo que Edgar pidió para Presupuestos en `[VE.3]`:
 * *«todo presupuesto debe funcionar en automático; botones innecesarios son innecesarios»*. El
 * botón se queda: lo que desaparece es que el número dependa de él.
 *
 * ⛔ Tampoco rechaza, ni cierra, ni toca un comprobante que una persona ya decidió.
 *
 * ## Cómo falla
 *
 * El latido mide **entrega** (ADR-053): lecturas que el servidor firmó, comprobantes clasificados
 * y validados — no «la pasada corrió». Una pasada que revisa 25 y relee 0 reporta `error`, que es
 * justo lo que `run-prod-feeds` hacía mal al declarar `ok` con 6 de 53 pasos caídos.
 *
 * ⚠️ Su umbral tiene que estar en `CRON_JOBS` (`pagos_relectura`) o `db-health` lo clasifica con
 * el `cfg ? classify : 'ok'` que la Fase VP midió dando **verde incondicional**.
 */

/** El tenant al que se le escribe el latido. `analytics.cron_runs` es tabla de plataforma. */
const MEGA = '00000000-0000-0000-0000-00000000d01c';

/** Quién queda como autor de lo que hace el carril. Se distingue de una persona a propósito. */
const AUTOR = 'autopilot';

@Injectable()
export class PagosAutopilotService {
  private readonly logger = new Logger(PagosAutopilotService.name);
  private running = false;

  constructor(
    @Inject(KNEX_NEW_DB) private readonly knex: Knex,
    private readonly svc: SupplierPaymentProofsService,
    @Optional() private readonly tenantCtx?: TenantContextService,
  ) {}

  /**
   * Cada 20 minutos. La cadencia la fija el REZAGO, no el gusto: con 25 por pasada son 1,800 al
   * día, o sea que los 1,199 atrasados se drenan en menos de un día y después el carril corre
   * casi siempre en vacío, que es el estado al que tiende.
   *
   * ⚠️ `timeZone` explícito: un `@Cron` sin él usa el reloj del contenedor, que es UTC.
   */
  @Cron('0 */20 * * * *', { timeZone: 'America/Mexico_City' })
  async scheduled(): Promise<void> {
    if (process.env.ENABLE_PAGOS_AUTOPILOT === 'false') return;
    // Una pasada dura minutos (I/O contra el modelo). Si la anterior sigue viva, se salta: dos
    // pasadas en paralelo leerían el MISMO lote y pagarían dos veces la misma lectura.
    if (this.running) { this.logger.warn('Skip: una pasada sigue en curso'); return; }
    await this.run().catch((e) => this.logger.error(`pagos autopilot: ${e?.message ?? e}`));
  }

  /**
   * Una pasada. Pública porque la pantalla la puede pedir ahora: el automático no quita la
   * posibilidad de pedirla, quita la obligación de pedirla para que el trabajo exista.
   */
  async run(): Promise<ResultadoRelectura> {
    this.running = true;
    let r: ResultadoRelectura = pasadaVacia();
    try {
      // ⛔⛔ ESTO TIENE QUE CORRER DENTRO DEL CONTEXTO DE TENANT. `finance.supplier_payment_proofs`
      // tiene RLS, y un `@Cron` no tiene request: sin `app.tenant_id` la consulta no falla,
      // devuelve CERO FILAS — y el cero se lee como «la cola está vacía». Es la falla canónica de
      // este repo (ADR-056) y la que dejó al piloto de Presupuestos recorriendo «0/0 ejercicios»
      // con dos en la tabla. `SupplierPaymentProofsService` usa `tk.run()`, que fija el tenant,
      // pero lo LEE del AsyncLocalStorage: hay que abrirlo acá.
      r = await this.conTenant(MEGA, async () => {
        // `[AT.2]` **Primero re-comparar, después releer.** `recheck()` no baja archivos ni llama
        // al modelo: recalcula las cuatro señales de los `recibido` que YA tienen lectura firmable
        // contra lo que Kepler dice hoy. Es barato y arregla dos cosas que de otro modo quedan
        // esperando que alguien se acuerde de apretar un botón:
        //
        //  · ⛔ **una regla que cambia.** `[AT.2]` aflojó `chequeoProveedor` y destrabó 17
        //    comprobantes ya releídos — y el carril NO los habría vuelto a mirar, porque sólo
        //    toma los que **no** tienen lectura firmable. Sin esto hacía falta un clic manual
        //    después de cada cambio de regla, que es exactamente el modo de falla que esta fase
        //    existe para borrar.
        //  · **Kepler corregido a mano**: si alguien arregla allá la fecha o el banco del pago,
        //    el comprobante se valida solo en la pasada siguiente.
        //
        // ⚠️ Su resultado NO entra en el latido: el latido mide la ENTREGA de la relectura
        // (lecturas que el servidor firmó). Mezclar los dos conteos haría que una pasada que no
        // releyó nada se viera sana porque `recheck` revalidó algo. Se registra en el log.
        // ⚠️ `try/catch`, NO `.catch()` sobre la promesa: si la llamada truena de forma
        // SÍNCRONA, `.catch()` ni se encadena y la excepción se lleva puesta toda la pasada.
        // Lo destapó una prueba del doble; en producción sería un cambio de firma del servicio.
        let re: { validados: number } | null = null;
        try {
          re = await this.svc.recheck();
        } catch (e) {
          this.logger.warn(`recheck previo: ${(e as Error)?.message ?? e}`);
        }
        if (re?.validados) this.logger.log(`recheck: ${re.validados} validados al re-comparar con Kepler`);
        return this.svc.relectura();
      });
    } catch (e) {
      r.errores.push((e as Error)?.message ?? String(e));
    } finally {
      this.running = false;
    }
    await this.latir(r);
    return r;
  }

  /** Abre el contexto de tenant para que `tk.run()` encuentre a quién mirar. */
  private async conTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    const ctx = this.tenantCtx as unknown as { run?: (s: unknown, f: () => Promise<T>) => Promise<T> } | undefined;
    if (!ctx?.run) return fn();
    return ctx.run({ tenantId, userId: null, username: AUTOR }, fn);
  }

  /** Latido de ENTREGA. Nunca rompe al que late. */
  private async latir(r: ResultadoRelectura): Promise<void> {
    try {
      await this.knex('analytics.cron_runs')
        .insert({
          tenant_id: MEGA,
          job_key: 'pagos_relectura',
          label: 'Comprobantes de pago: relectura y auto-validación',
          last_start: this.knex.fn.now(),
          last_finish: this.knex.fn.now(),
          status: veredictoPasada(r),
          rows_affected: r.releidos,
          duration_ms: r.ms,
          note: notaPasada(r),
          error: r.errores.length ? r.errores.join(' | ').slice(0, 500) : null,
          // ⚠️ Se LEE, no se afirma. En prod el `api` corre con `DISABLE_CRONS=true` y los
          // `@Cron` viven en el `worker` (ADR-043): un `host: 'api'` escrito a mano manda a
          // buscar el log al contenedor equivocado el día que esto falle.
          host: process.env.WORKER === 'true' ? 'worker' : 'api',
          updated_at: this.knex.fn.now(),
        })
        .onConflict(['tenant_id', 'job_key'])
        .merge(['label', 'last_start', 'last_finish', 'status', 'rows_affected', 'duration_ms', 'note', 'error', 'host', 'updated_at']);
    } catch (e) {
      this.logger.warn(`latido pagos_relectura: ${(e as Error)?.message ?? e}`);
    }
  }
}
