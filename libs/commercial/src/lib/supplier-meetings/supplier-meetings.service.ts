import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Knex } from 'knex';
import type { AgendaCitas, AgendarReunionDto, DetalleReunion, OpcionesCitas, ProveedoresCitas, ReunionGuardada } from '@megadulces/contracts';
import { TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import { CitasError } from './supplier-meetings.domain';
import { agendar, buscarProveedores, cancelar, confirmar, editar, escribirMinuta, leerAgenda, leerDetalle, leerOpciones, type Quien } from './supplier-meetings.repo';

/** El error del dominio, en el código HTTP que la pantalla sabe leer (con su mensaje en español). */
export function traducir(e: unknown): never {
  if (e instanceof CitasError) {
    if (e.tipo === 'no_encontrada') throw new NotFoundException(e.message);
    if (e.tipo === 'conflicto') throw new ConflictException(e.message);
    throw new BadRequestException(e.message);
  }
  throw e;
}

/**
 * `[PQ.3.8]` Compras › Proveedores › Citas (anexo C §9.1, §10.15). Una sola agenda para Compras, Mercadotecnia y
 * Tesorería (DC9, DC41): sin alcance por sucursal, porque la reunión es con el proveedor, no con una tienda. Sin caché:
 * las reuniones cambian a mano.
 */
@Injectable()
export class SupplierMeetingsService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  agenda(semana?: string | null): Promise<AgendaCitas> {
    const tenant = this.tenantCtx.requireTenantId();
    return this.tk.run((trx: Knex.Transaction) => leerAgenda(trx, tenant, semana)).catch(traducir);
  }

  detalle(id: string): Promise<DetalleReunion> {
    const tenant = this.tenantCtx.requireTenantId();
    return this.tk.run((trx: Knex.Transaction) => leerDetalle(trx, tenant, id)).catch(traducir);
  }

  opciones(): Promise<OpcionesCitas> {
    const tenant = this.tenantCtx.requireTenantId();
    return this.tk.run((trx: Knex.Transaction) => leerOpciones(trx, tenant));
  }

  proveedores(q?: string | null): Promise<ProveedoresCitas> {
    const tenant = this.tenantCtx.requireTenantId();
    return this.tk.run((trx: Knex.Transaction) => buscarProveedores(trx, tenant, q));
  }

  agendar(quien: Quien, dto: AgendarReunionDto): Promise<ReunionGuardada> {
    const tenant = this.tenantCtx.requireTenantId();
    return this.tk.run((trx: Knex.Transaction) => agendar(trx, tenant, quien, dto)).catch(traducir);
  }

  editar(quien: Quien, id: string, dto: AgendarReunionDto): Promise<ReunionGuardada> {
    const tenant = this.tenantCtx.requireTenantId();
    return this.tk.run((trx: Knex.Transaction) => editar(trx, tenant, quien, id, dto)).catch(traducir);
  }

  confirmar(quien: Quien, id: string): Promise<{ id: string }> {
    const tenant = this.tenantCtx.requireTenantId();
    return this.tk.run((trx: Knex.Transaction) => confirmar(trx, tenant, quien, id)).catch(traducir);
  }

  minuta(quien: Quien, id: string, dto: unknown): Promise<{ id: string }> {
    const tenant = this.tenantCtx.requireTenantId();
    return this.tk.run((trx: Knex.Transaction) => escribirMinuta(trx, tenant, quien, id, dto)).catch(traducir);
  }

  cancelar(quien: Quien, id: string, dto: unknown): Promise<{ id: string }> {
    const tenant = this.tenantCtx.requireTenantId();
    return this.tk.run((trx: Knex.Transaction) => cancelar(trx, tenant, quien, id, dto)).catch(traducir);
  }
}
