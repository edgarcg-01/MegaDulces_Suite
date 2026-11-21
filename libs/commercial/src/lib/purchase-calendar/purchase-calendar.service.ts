import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Knex } from 'knex';
import type {
  CalendarioCompras, FueraDeCicloDto, GuardarReglaDto, GuardarReglaRespuesta, MarcarRevisionDto, PropuestasCalendario,
} from '@megadulces/contracts';
import { ScopeService, TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import {
  CalendarioError, darDeBaja, fueraDeCiclo, guardarRegla, leerCalendario, leerPropuestas, marcar, type Quien,
} from './purchase-calendar.repo';

/** El error del dominio, en el código HTTP que la pantalla sabe leer (con su mensaje en español). */
export function traducir(e: unknown): never {
  if (e instanceof CalendarioError) {
    if (e.tipo === 'no_encontrada') throw new NotFoundException(e.message);
    if (e.tipo === 'conflicto') throw new ConflictException(e.message);
    if (e.tipo === 'fuera_de_alcance') throw new ForbiddenException(e.message);
    throw new BadRequestException(e.message);
  }
  throw e;
}

/** `[PQ.3.6]` El área de alcance (`[ZN.8]`): la de Pedido, para que una regla escrita para Compras valga igual en los dos. */
const AREA = 'compras';

/** Quién escribe, como lo arma el controlador; el alcance lo agrega el servicio. */
export type Sesion = Omit<Quien, 'escribe'>;

/**
 * `[PQ.3.4]` Compras › Calendario de compras (anexo C §10). Sin caché: las reglas y las marcas cambian
 * a mano y la actividad de Kepler se lee fresca (≈ 0.5 s con todas las claves, medido 2026-11-20).
 *
 * `[PQ.3.6]` Cada quien ve y escribe sólo las reglas que caben en sus sucursales (`ScopeService`, área
 * `compras`): el encargado, las de su sucursal (`own`); quien tiene `all`, todas. El alcance se resuelve
 * FUERA de `tk.run` porque `ScopeService` usa su propia conexión.
 */
@Injectable()
export class PurchaseCalendarService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly scope: ScopeService,
  ) {}

  /** Las sucursales que lee y en las que escribe; `null` = todas. */
  private async alcance(): Promise<{ lee: string[] | null; escribe: string[] | null }> {
    const s = await this.scope.current(AREA);
    return { lee: this.scope.intersect(s, 'warehouse'), escribe: this.scope.intersectWrite(s, 'warehouse') };
  }

  private async conAlcance(sesion: Sesion): Promise<Quien> {
    return { ...sesion, escribe: (await this.alcance()).escribe };
  }

  async calendario(): Promise<CalendarioCompras> {
    const tenant = this.tenantCtx.requireTenantId();
    const { lee } = await this.alcance();
    return this.tk.run((trx: Knex.Transaction) => leerCalendario(trx, tenant, lee));
  }

  propuestas(): Promise<PropuestasCalendario> {
    const tenant = this.tenantCtx.requireTenantId();
    return this.tk.run((trx: Knex.Transaction) => leerPropuestas(trx, tenant));
  }

  async guardarRegla(sesion: Sesion, dto: GuardarReglaDto): Promise<GuardarReglaRespuesta> {
    const tenant = this.tenantCtx.requireTenantId();
    const quien = await this.conAlcance(sesion);
    return this.tk.run((trx: Knex.Transaction) => guardarRegla(trx, tenant, quien, dto)).catch(traducir);
  }

  async darDeBaja(sesion: Sesion, id: string): Promise<{ id: string }> {
    const tenant = this.tenantCtx.requireTenantId();
    const quien = await this.conAlcance(sesion);
    return this.tk.run((trx: Knex.Transaction) => darDeBaja(trx, tenant, quien, id)).catch(traducir);
  }

  async fueraDeCiclo(sesion: Sesion, id: string, dto: FueraDeCicloDto): Promise<{ id: string }> {
    const tenant = this.tenantCtx.requireTenantId();
    const quien = await this.conAlcance(sesion);
    return this.tk.run((trx: Knex.Transaction) => fueraDeCiclo(trx, tenant, quien, id, dto)).catch(traducir);
  }

  async marcar(sesion: Sesion, id: string, dto: MarcarRevisionDto): Promise<{ id: string; accion: 'creada' | 'corregida' }> {
    const tenant = this.tenantCtx.requireTenantId();
    const quien = await this.conAlcance(sesion);
    return this.tk.run((trx: Knex.Transaction) => marcar(trx, tenant, quien, id, dto)).catch(traducir);
  }
}
