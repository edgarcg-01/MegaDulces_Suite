import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Knex } from 'knex';
import type { AplicacionCosto, DecisionCostoGuardada, GuardarDecisionCostoDto } from '@megadulces/contracts/http/application-cost';
import { ScopeService, TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import { CostoAplicadoError, guardarDecision, leerAplicacion, type Quien } from './application-cost.repo';

/** El error del dominio, en el código HTTP que la pantalla sabe leer (con su mensaje en español). */
export function traducir(e: unknown): never {
  if (e instanceof CostoAplicadoError) {
    if (e.tipo === 'no_encontrado') throw new NotFoundException(e.message);
    if (e.tipo === 'conflicto') throw new ConflictException(e.message);
    throw new BadRequestException(e.message);
  }
  throw e;
}

const SUCURSAL = /^[0-9A-Za-z]{1,4}$/;
const FOLIO = /^[0-9A-Za-z-]{1,20}$/;
const SUBTIPO = /^\d{1,4}$/;

/** La llave de Kepler que llega en la URL o en el cuerpo, revisada ANTES de tocar la base (un `::numeric` con basura es un 500). */
function exigirLlave(sucursal: unknown, folio: unknown): { sucursal: string; folio: string } {
  const s = typeof sucursal === 'string' ? sucursal.trim() : '';
  const f = typeof folio === 'string' ? folio.trim() : '';
  if (!SUCURSAL.test(s)) throw new BadRequestException('La sucursal no es válida.');
  if (!FOLIO.test(f)) throw new BadRequestException('El folio no es válido.');
  return { sucursal: s, folio: f };
}

/**
 * `[PQ.157]` C2 — validar el costo al aplicar (anexo R §3d–§3e). Leer: los renglones de una aplicación con su
 * decisión y su antecedente. Escribir: la decisión de un renglón (accept · claim · promotion).
 *
 * El alcance por sucursal es el mismo que el de Revisión de facturas (`ScopeService`, área por defecto): leer exige
 * poder VER la sucursal y decidir, poder ESCRIBIR en ella. Se resuelve FUERA de `tk.run` porque `ScopeService` usa su
 * propia conexión.
 */
@Injectable()
export class ApplicationCostService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly scope: ScopeService,
  ) {}

  async aplicacion(sucursal: string, folio: string): Promise<AplicacionCosto> {
    const k = exigirLlave(sucursal, folio);
    await this.scope.assertCanRead('warehouse', k.sucursal);
    const tenant = this.tenantCtx.requireTenantId();
    try {
      return await this.tk.run((trx: Knex.Transaction) => leerAplicacion(trx, tenant, k.sucursal, k.folio));
    } catch (e) {
      return traducir(e);
    }
  }

  async decidir(quien: Quien, dto: GuardarDecisionCostoDto): Promise<DecisionCostoGuardada> {
    if (!dto || typeof dto !== 'object') throw new BadRequestException('Falta la decisión.');
    const k = exigirLlave(dto.sucursal, dto.folio);
    const subtipo = String(dto.subtipo ?? '').trim();
    if (!SUBTIPO.test(subtipo)) throw new BadRequestException('El subtipo no es válido.');
    if (!Number.isInteger(dto.renglon) || dto.renglon <= 0) throw new BadRequestException('El renglón no es válido.');
    if (typeof dto.reason !== 'string') throw new BadRequestException('Escribe por qué.');
    await this.scope.assertCanWrite('warehouse', k.sucursal);
    const tenant = this.tenantCtx.requireTenantId();
    try {
      return await this.tk.run((trx: Knex.Transaction) =>
        guardarDecision(trx, tenant, quien, { ...dto, sucursal: k.sucursal, folio: k.folio, subtipo }));
    } catch (e) {
      return traducir(e);
    }
  }
}
