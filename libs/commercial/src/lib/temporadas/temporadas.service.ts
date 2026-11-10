import { BadRequestException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { Knex } from 'knex';
import type {
  CandidatosTemporada, ConfirmarFechasTemporadaDto, ConfirmarFechasTemporadaRespuesta, DecisionesTemporadaDto,
  DecisionesTemporadaRespuesta, TemporadasVista,
} from '@megadulces/contracts';
import { TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import {
  calcularFilas, confirmarFechas, guardarDecisiones, leerCabecera, leerTemporadas, TemporadasError, unirDecisiones,
  type FilasCalculadas, type Quien,
} from './temporadas.repo';

/**
 * `[PQ.94]` Los candidatos tardan ~0.4-1.6 s por temporada-año (vista sobre el sell-out canónico, plan §19.11): más de
 * los 500 ms de la regla. Se guarda SÓLO lo que propone la venta; la cabecera (fechas, estado) y las decisiones se
 * leen frescas en cada consulta.
 *
 * ⭐ La llave lleva las FECHAS de la ventana. Prod corre 2 réplicas de la API (`ops/k3s/41-redis-worker-api.yaml`):
 *    con la llave sólo por id, corregir las fechas en una réplica dejaba a la otra sirviendo la ventana vieja hasta
 *    6 h, y un GET que empezó antes de la corrección volvía a guardar el cálculo viejo (revisión independiente,
 *    hallazgo 1). Con las fechas en la llave, un cálculo viejo no vuelve a coincidir con nadie.
 * Una ventana cuyo mes siguiente ya cerró no cambia: se guarda 6 h. Una en curso, 10 min.
 */
export const CACHE_CERRADA_MS = 6 * 60 * 60 * 1000;
export const CACHE_ABIERTA_MS = 10 * 60 * 1000;
const CACHE_MAX = 64;

interface Guardado {
  readonly filas: FilasCalculadas;
  readonly cerrada: boolean;
  readonly at: number;
}

/** ¿Sigue vigente lo guardado? Pura, para probarla sin reloj. */
export function vigente(g: { cerrada: boolean; at: number } | undefined, ahora: number): boolean {
  if (!g) return false;
  return ahora - g.at < (g.cerrada ? CACHE_CERRADA_MS : CACHE_ABIERTA_MS);
}

/** La llave de lo guardado: tenant, temporada-año y su ventana. Pura. */
export function llaveCandidatos(tenant: string, c: { season_date_id: string; sale_from: string; sale_to: string }): string {
  return `${tenant}:${c.season_date_id}:${c.sale_from}:${c.sale_to}`;
}

function traducir(e: unknown): never {
  if (e instanceof TemporadasError) {
    throw e.tipo === 'no_encontrada' ? new NotFoundException(e.message) : new BadRequestException(e.message);
  }
  throw e;
}

@Injectable()
export class TemporadasService {
  private readonly cache = new Map<string, Guardado>();

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  temporadas(): Promise<TemporadasVista> {
    const tenant = this.tenantCtx.requireTenantId();
    return this.tk.run((trx: Knex.Transaction) => leerTemporadas(trx, tenant));
  }

  async candidatos(seasonDateId: string): Promise<CandidatosTemporada> {
    const tenant = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx: Knex.Transaction) => {
      const cab = await leerCabecera(trx, tenant, seasonDateId);
      if (!cab) throw new NotFoundException('No encontramos esa temporada.');
      const llave = llaveCandidatos(tenant, cab);
      let g = this.cache.get(llave);
      if (!vigente(g, Date.now())) {
        const filas = await calcularFilas(trx, tenant, seasonDateId).catch((e: { code?: string }) => {
          // 55000 = la vista materializada de la venta no está poblada (pasa en bases de prueba). Se DICE,
          // no se devuelve como un vacío que parezca «sin candidatos» ni como un 500 sin explicación.
          if (e?.code === '55000') {
            throw new ServiceUnavailableException('La venta oficial no está cargada en esta base: no se pueden calcular los productos que propone. En producción sí lo está.');
          }
          throw e;
        });
        g = { filas, cerrada: cab.ventana_cerrada, at: Date.now() };
        if (this.cache.size >= CACHE_MAX) this.cache.delete(this.cache.keys().next().value as string);
        this.cache.set(llave, g);
      }
      return unirDecisiones(trx, tenant, cab, (g as Guardado).filas, new Date((g as Guardado).at).toISOString());
    });
  }

  decidir(quien: Quien, seasonId: string, dto: DecisionesTemporadaDto): Promise<DecisionesTemporadaRespuesta> {
    const tenant = this.tenantCtx.requireTenantId();
    return this.tk.run((trx: Knex.Transaction) => guardarDecisiones(trx, tenant, quien, seasonId, dto)).catch(traducir);
  }

  confirmarFechas(quien: Quien, seasonDateId: string, dto: ConfirmarFechasTemporadaDto): Promise<ConfirmarFechasTemporadaRespuesta> {
    const tenant = this.tenantCtx.requireTenantId();
    // No hace falta borrar la caché: si cambian las fechas, cambia la llave (y en la otra réplica también).
    return this.tk.run((trx: Knex.Transaction) => confirmarFechas(trx, tenant, quien, seasonDateId, dto)).catch(traducir);
  }
}
