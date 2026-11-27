import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Knex } from 'knex';
import type { AcuerdoGuardado, AcuerdosDeReunion, CapturarAcuerdoDto, ListaAcuerdos } from '@megadulces/contracts';
import { TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import type { Quien } from '../supplier-meetings/supplier-meetings.repo';
import { AcuerdosError } from './supplier-agreements.domain';
import { capturar, cerrar, editar, iniciar, leerDeReunion, leerLista } from './supplier-agreements.repo';

/** El error del dominio, en el código HTTP que la pantalla sabe leer (con su mensaje en español). */
export function traducir(e: unknown): never {
  if (e instanceof AcuerdosError) {
    if (e.tipo === 'no_encontrado') throw new NotFoundException(e.message);
    if (e.tipo === 'conflicto') throw new ConflictException(e.message);
    throw new BadRequestException(e.message);
  }
  throw e;
}

/**
 * `[PQ.3.10]` Compras › Proveedores › Acuerdos (anexo C §10.20, DC43–DC46, ADR-128). Una sola lista para Compras,
 * Mercadotecnia y Finanzas, como la agenda de Citas: sin alcance por sucursal. Sin caché: los acuerdos cambian a mano.
 */
@Injectable()
export class SupplierAgreementsService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  lista(): Promise<ListaAcuerdos> {
    const tenant = this.tenantCtx.requireTenantId();
    return this.tk.run((trx: Knex.Transaction) => leerLista(trx, tenant));
  }

  deReunion(meetingId: string): Promise<AcuerdosDeReunion> {
    const tenant = this.tenantCtx.requireTenantId();
    return this.tk.run((trx: Knex.Transaction) => leerDeReunion(trx, tenant, meetingId)).catch(traducir);
  }

  capturar(quien: Quien, meetingId: string, dto: CapturarAcuerdoDto): Promise<AcuerdoGuardado> {
    const tenant = this.tenantCtx.requireTenantId();
    return this.tk.run((trx: Knex.Transaction) => capturar(trx, tenant, quien, meetingId, dto)).catch(traducir);
  }

  editar(quien: Quien, id: string, dto: CapturarAcuerdoDto): Promise<AcuerdoGuardado> {
    const tenant = this.tenantCtx.requireTenantId();
    return this.tk.run((trx: Knex.Transaction) => editar(trx, tenant, quien, id, dto)).catch(traducir);
  }

  iniciar(quien: Quien, id: string): Promise<AcuerdoGuardado> {
    const tenant = this.tenantCtx.requireTenantId();
    return this.tk.run((trx: Knex.Transaction) => iniciar(trx, tenant, quien, id)).catch(traducir);
  }

  cumplir(quien: Quien, id: string, dto: unknown): Promise<AcuerdoGuardado> {
    const tenant = this.tenantCtx.requireTenantId();
    return this.tk.run((trx: Knex.Transaction) => cerrar(trx, tenant, quien, id, 'cumplir', dto)).catch(traducir);
  }

  cancelar(quien: Quien, id: string, dto: unknown): Promise<AcuerdoGuardado> {
    const tenant = this.tenantCtx.requireTenantId();
    return this.tk.run((trx: Knex.Transaction) => cerrar(trx, tenant, quien, id, 'cancelar', dto)).catch(traducir);
  }
}
