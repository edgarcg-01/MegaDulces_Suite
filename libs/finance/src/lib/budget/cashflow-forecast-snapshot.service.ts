import { Injectable, Inject, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Knex } from 'knex';
import { KNEX_NEW_DB } from '@megadulces/platform-core';
import { cobranzaPrevista } from '../customer-ledger/cobranza-prevista';
import { deudaPrevista } from '../creditor-statements/deuda-prevista';

const MEGA = '00000000-0000-0000-0000-00000000d01c';
const HORIZONTE_DIAS = 56;

/**
 * `[TES.12]` **Cierra el lazo: guarda lo que el pronóstico dijo, para poder contrastarlo.**
 *
 * El flujo de efectivo proyectaba cada vez que alguien abría la pantalla y **no dejaba rastro**.
 * Sin registro de lo que dijimos, nadie puede comparar lo proyectado contra lo ocurrido — y un
 * pronóstico que nunca se contrasta no mejora: es una opinión con formato de cifra.
 *
 * El «ocurrido» ya existía y está al día, derivado del ODS en las dos piernas
 * (`analytics.erp_collections` y `analytics.erp_supplier_payments`). Lo único que faltaba era el
 * otro lado de la resta. Esto lo escribe.
 *
 * ⛔ **Guarda la COBERTURA junto con la cifra, y no es un adorno.** Medido el 2026-10-09: el
 * cobro real ronda **$10M por semana** y el proyectado **$1.5M** — el pronóstico ve ~1/6 de lo
 * que entra **por construcción**, porque agenda por vencimiento y los $55M ya vencidos viajan
 * declarados sin fecha. Un back-test que reste esas dos series publica **−80 % de «error»** que
 * en realidad mide **alcance**, no puntería. Sin el campo de cobertura en la misma fila, las dos
 * series son universos distintos y la resta no significa nada.
 *
 * ⚠️ **Idempotente por día.** Vuelve a correr y pisa la foto del día (`ON CONFLICT`), no la
 * duplica: una semana proyectada dos veces el mismo día no son dos observaciones.
 */
@Injectable()
export class CashflowForecastSnapshotService {
  private readonly logger = new Logger(CashflowForecastSnapshotService.name);

  constructor(@Inject(KNEX_NEW_DB) private readonly knex: Knex) {}

  /** 04:10 MX — después de que la cartera tomó su foto (03:xx) y antes de la jornada. */
  @Cron('0 10 4 * * *', { timeZone: 'America/Mexico_City' })
  async snapshotDiario(): Promise<void> {
    await this.tomarFoto();
  }

  /**
   * Toma la foto del pronóstico vigente y la guarda por semana.
   * Devuelve cuántas semanas quedaron escritas (0 = no se pudo, y se declara en el latido).
   */
  async tomarFoto(): Promise<{ semanas: number; motivo: string | null }> {
    const t0 = Date.now();
    let semanas = 0;
    let motivo: string | null = null;

    try {
      const hoy = new Date().toISOString().slice(0, 10);
      const hasta = new Date(Date.now() + HORIZONTE_DIAS * 86400000).toISOString().slice(0, 10);

      await this.knex.transaction(async (trx) => {
        await trx.raw('SET LOCAL app.tenant_id = ?', [MEGA]);

        const cob = await cobranzaPrevista(trx, MEGA, hoy, hasta);
        const deu = await deudaPrevista(trx, MEGA, hoy, hasta);

        // Unión de semanas: una semana con cobro y sin pago (o al revés) es una observación
        // válida, no un hueco. Intersectar perdería justo las semanas asimétricas.
        const porSemana = new Map<string, { c: number; p: number }>();
        for (const b of cob.porSemana) porSemana.set(b.bucket, { c: b.monto, p: 0 });
        for (const b of deu.porSemana) {
          const prev = porSemana.get(b.bucket);
          if (prev) prev.p = b.monto; else porSemana.set(b.bucket, { c: 0, p: b.monto });
        }

        const filas = [...porSemana.entries()].map(([semana, v]) => ({
          tenant_id: MEGA,
          tomado_el: hoy,
          semana,
          horizonte_dias: Math.round((Date.parse(semana) - Date.parse(hoy)) / 86400000),
          cobros_proyectado: v.c,
          pagos_proyectado: v.p,
          cobro_cobertura_pct: cob.cobertura.pct_en_ventana,
          pago_cobertura_pct: deu.cobertura.pct_en_ventana,
          cobro_vencido_fuera: cob.cobertura.vencido_fuera,
          pago_vencido_fuera: deu.cobertura.vencido_fuera,
          cobro_as_of: cob.as_of,
          // ⚠️ El ODS no publica frescura en `kdxe`: va NULL, no `now()`. Fabricarlo diría
          // «recién medido» sobre un dato de antigüedad no verificada (ADR-056).
          pago_as_of: deu.as_of,
        }));

        if (!filas.length) {
          motivo = 'el pronóstico no devolvió ni una semana: no hay nada que fotografiar';
          return;
        }

        await trx('finance.cashflow_forecast')
          .insert(filas)
          .onConflict(['tenant_id', 'tomado_el', 'semana'])
          .merge([
            'cobros_proyectado', 'pagos_proyectado', 'horizonte_dias',
            'cobro_cobertura_pct', 'pago_cobertura_pct',
            'cobro_vencido_fuera', 'pago_vencido_fuera', 'cobro_as_of', 'pago_as_of',
          ]);
        semanas = filas.length;
      });
    } catch (e) {
      motivo = e instanceof Error ? e.message.slice(0, 400) : String(e);
      this.logger.error(`foto del pronóstico NO tomada: ${motivo}`);
    }

    await this.latir(semanas, Date.now() - t0, motivo);
    return { semanas, motivo };
  }

  /**
   * Latido de ENTREGA (ADR-053): mide **semanas escritas**, no «el job corrió». Su umbral va en
   * `CRON_JOBS` (`cashflow_forecast_snapshot`) o el sensor cae en el `cfg ? classify : 'ok'`
   * que da verde incondicional.
   *
   * ⚠️ Cero semanas es ERROR, no un día tranquilo: si el pronóstico no devolvió nada, el lazo
   * se queda sin el lado que esta clase existe para guardar.
   */
  private async latir(semanas: number, ms: number, motivo: string | null): Promise<void> {
    try {
      const error = motivo
        ? motivo
        : semanas === 0
          ? 'cero semanas fotografiadas: el pronóstico no devolvió baldes'
          : null;
      await this.knex('analytics.cron_runs')
        .insert({
          tenant_id: MEGA,
          job_key: 'cashflow_forecast_snapshot',
          label: 'Foto diaria del pronóstico de flujo',
          last_start: this.knex.fn.now(),
          last_finish: this.knex.fn.now(),
          status: error ? 'error' : 'ok',
          rows_affected: semanas,
          duration_ms: ms,
          note: error ? null : `${semanas} semana(s) proyectadas y guardadas`,
          error,
          host: 'worker',
          updated_at: this.knex.fn.now(),
        })
        .onConflict(['tenant_id', 'job_key'])
        .merge(['label', 'last_start', 'last_finish', 'status', 'rows_affected',
          'duration_ms', 'note', 'error', 'host', 'updated_at']);
    } catch (e) {
      // El latido nunca rompe al que late — pero tampoco se calla. Un `catch {}` mudo en el
      // medidor es el modo de falla que la Fase OBS vino a cerrar: el que avisa deja de avisar
      // y nadie se entera de que dejó.
      this.logger.error(
        `latido cashflow_forecast_snapshot NO escrito (el tablero conserva la marca anterior): ${
          e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}
