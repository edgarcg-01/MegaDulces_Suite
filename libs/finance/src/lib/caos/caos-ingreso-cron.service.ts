import { Injectable, Inject, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Knex } from 'knex';
import { KNEX_NEW_DB, TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import { diaMxDeInstante } from '@megadulces/contracts';
import { CaosIngresoReconService } from './caos-ingreso-recon.service';
import { atribuirDeposito } from './caos-deposito-grano';

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
    // `[CGP-L.6]` Para escribir el grano con el tenant fijado: la tabla tiene RLS FORZADO.
    private readonly tk: TenantKnexService,
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

    /**
     * ⛔ `[CGP-L.6]` El grano ya no se traga su error. Antes `clasificarGranos` devolvía 0 ante
     * cualquier falla y el latido decía «0 clasificados»: medido contra la base como `app_runtime`,
     * la escritura la RECHAZABA el RLS en cada corrida y nadie lo veía. Ahora el motivo va al latido
     * (estado `error`). Sigue sin tumbar la atribución de cobros, que ya corrió arriba.
     */
    let granos = 0;
    try {
      granos = await this.clasificarGranos();
    } catch (e) {
      const m = e instanceof Error ? e.message.slice(0, 300) : 'fallo sin mensaje';
      this.logger.error(`[CG.58.6] no se pudo clasificar el grano: ${m}`);
      motivo = motivo ? `${motivo} · grano: ${m}` : `grano: ${m}`;
    }

    await this.latir(cubiertos, pendientes, Date.now() - t0, motivo, granos);
    return { cubiertos, pendientes, motivo };
  }

  /**
   * ⭐ `[CG.58.6]` Lee el `ref` de los depósitos que todavía no tienen veredicto y escribe el
   * **grano** al que su texto permite atribuirlos.
   *
   * Va en el mismo carril que la atribución de cobros a propósito: son las dos mitades de la
   * misma pregunta —*de qué cobros es este efectivo* y *de qué ruta viene*— y separarlas en dos
   * crones deja que una se quede atrás sin que se note.
   *
   * ⚠️ Sólo escribe los que NO tienen fila viva. No re-clasifica: si mañana el motor mejora, la
   * re-clasificación es una decisión aparte (borrar el veredicto viejo) y no un efecto lateral
   * de que el cron corra.
   */
  private async clasificarGranos(): Promise<number> {
    /**
     * `[CGP-L.6]` Leer y escribir en UNA transacción con el tenant fijado. `finance.caos_deposito_grano`
     * tiene RLS FORZADO: por la conexión cruda la escritura se rechazaba, y la LECTURA del
     * `NOT EXISTS` veía la tabla vacía —así que volvía a elegir depósitos ya clasificados y chocaba
     * contra `cdg_un_deposito`—. Lo destapó la segunda corrida de la prueba contra la base.
     */
    return this.tk.run(MEGA, async (trx) => {
      const nuevos: Array<{ device: string; external_id: string; occurred_at: Date; total: string; ref: string | null }> =
        await trx('analytics.caos_cash_movements as m')
          .where('m.tenant_id', MEGA)
          .where('m.type_id', 0)
          .whereNotExists(function (this: Knex.QueryBuilder) {
            this.select(1).from('finance.caos_deposito_grano as g')
              .whereRaw('g.tenant_id = m.tenant_id AND g.caos_device = m.device '
                + 'AND g.caos_external_id = m.external_id AND g.deleted_at IS NULL');
          })
          .select('m.device', 'm.external_id', 'm.occurred_at', 'm.total', 'm.ref')
          .limit(5000);
      if (!nuevos.length) return 0;

      const filas = nuevos.map((d) => {
        // `[CGP-L.5]` El día de NEGOCIO del depósito (México), no el de UTC.
        const dia = diaMxDeInstante(d.occurred_at) ?? '';
        const a = atribuirDeposito(d.ref, dia);
        return {
          tenant_id: MEGA,
          caos_device: d.device,
          caos_external_id: d.external_id,
          grano: a.grano,
          ruta: a.ruta,
          plaza: a.plaza,
          business_date: a.fecha,
          ref_leido: d.ref,
          motivo: a.motivo,
          monto: d.total,
        };
    });
    for (let i = 0; i < filas.length; i += 500) {
      await trx('finance.caos_deposito_grano').insert(filas.slice(i, i + 500));
    }
    this.logger.log(`[CG.58.6] ${filas.length} depósito(s) clasificados por grano`);
    return filas.length;
    });
  }

  private async latir(cubiertos: number, pendientes: number, ms: number, motivo: string | null, granos: number): Promise<void> {
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
          note: error ? null : `${cubiertos} depósito(s) atribuidos · ${pendientes} sin respaldo · ${granos} clasificado(s) por grano`,
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
