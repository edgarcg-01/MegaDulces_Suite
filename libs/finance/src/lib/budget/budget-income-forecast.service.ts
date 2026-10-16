import { Injectable } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';
import type { IncomeForecastDay, IncomeForecastResponse } from '@megadulces/contracts';
import { ingresoPorDia, inhabilesDe, realHasta, versionVigente } from './income-forecast.sql';

/** Qué cuenta como ingreso real. La misma definición con la que se armó el estimado. */
const DEFINICION_REAL =
  'Lo clasificado como cobranza (venta cobrada) en el módulo de Bancos: cuentas bancarias = bancos, ' +
  'cuenta CAJA GENERAL = caja general. No cuenta traspasos entre cuentas propias, préstamos ni devoluciones.';

/** Primer día del mes de una fecha `YYYY-MM-DD`. */
const inicioDeMes = (f: string) => `${f.slice(0, 7)}-01`;

/**
 * `[PU.13]` **El estimado de ingresos por día, con lo real al lado.**
 *
 * El estimado es un dato propio (`budget.income_forecast_days`); lo real NO se copia: se suma en
 * el momento desde `finance.bank_movements` con la categoría `cobranza`, por tipo de cuenta. Así
 * la pantalla se pone al día sola conforme Tesorería carga los estados de cuenta.
 *
 * `[PU.14]` La consulta vive en `income-forecast.sql.ts` porque el Calendario de Pagos propone su
 * capacidad con la MISMA: lo que Finanzas ve aquí es lo que el calendario autoriza.
 *
 * ⚠️ `real` va en `null` después del último día cargado de cada canal (`real_hasta`): un día que
 * todavía no se carga no «entró cero».
 */
@Injectable()
export class BudgetIncomeForecastService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  async vigente(): Promise<IncomeForecastResponse> {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const tope = await realHasta(trx, tenantId);
      const version = await versionVigente(trx, tenantId);
      if (!version) {
        return {
          version: null,
          vacia_porque: 'No hay ningún estimado de ingresos vigente. Se carga como versión en budget.income_forecasts.',
          real_hasta: tope,
          dias: [],
          definicion_real: DEFINICION_REAL,
        };
      }
      const inhabiles = inhabilesDe(version);
      // Desde el día 1 del mes de `desde`: así el mes en curso se ve completo.
      const filas = await ingresoPorDia(trx, tenantId, version.id, inicioDeMes(version.desde), version.hasta, tope);
      const dias: IncomeForecastDay[] = filas.map((r) => ({
        fecha: r.fecha,
        dia_semana: r.dia_semana,
        semana: r.semana,
        semana_anio: r.semana_anio,
        inhabil: inhabiles.includes(r.fecha),
        bancos: { estimado: r.est.bancos, real: r.real.bancos },
        caja_general: { estimado: r.est.caja_general, real: r.real.caja_general },
      }));
      return { version, vacia_porque: null, real_hasta: tope, dias, definicion_real: DEFINICION_REAL };
    });
  }
}
