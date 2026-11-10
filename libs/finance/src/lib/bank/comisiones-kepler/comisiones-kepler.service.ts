import { Injectable } from '@nestjs/common';
import { TenantKnexService, TenantContextService, todayMx } from '@megadulces/platform-core';
import { leerPropuesta, type PropuestaComisiones } from './comisiones-kepler.query';

/**
 * `[CB.62]` C2 de SÓLO LECTURA: la propuesta de las comisiones de la terminal que irían a Kepler, con lo que
 * Finanzas ya capturó a mano y lo que queda por revisar. No escribe en Kepler ni en la Suite.
 *
 * Pide sólo los dos globales de platform-core, como `EstadoDeCuentaService` (el candado de arranque lo cuenta).
 */
@Injectable()
export class ComisionesKeplerService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /** Los últimos `dias` (1–45, 14 por defecto) de la descarga del banco. Medido en prod: 143 ms con oct–nov. */
  async propuesta(dias = 14, hoy = todayMx()): Promise<PropuestaComisiones> {
    const tenantId = this.tenantCtx.requireTenantId();
    const ventana = Math.min(Math.max(1, Math.trunc(dias) || 14), 45);
    const d = new Date(`${hoy}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - ventana);
    const desde = d.toISOString().slice(0, 10);
    return this.tk.run((trx) => leerPropuesta(trx, tenantId, desde, hoy));
  }
}
