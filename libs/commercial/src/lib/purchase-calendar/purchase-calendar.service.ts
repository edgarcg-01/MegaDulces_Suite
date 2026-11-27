import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Knex } from 'knex';
import type {
  AvisoCalendario, CalendarioCompras, DefinirOcasionalesDto, DefinirOcasionalesRespuesta, FueraDeCicloDto, GuardarReglaDto, GuardarReglaRespuesta,
  MarcarRevisionDto, PropuestasCalendario, ResponsablesCalendario,
} from '@megadulces/contracts';
import { ScopeService, TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import {
  CalendarioError, darDeBaja, definirOcasionales, fueraDeCiclo, guardarRegla, leerAviso, leerCalendario, leerPosiblesResponsables, leerPropuestas,
  marcar, type Quien, type ResponsableResuelto,
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
  private readonly logger = new Logger(PurchaseCalendarService.name);

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

  /**
   * `[PQ.3.24]` El aviso «Hoy te toca» de Pedido (DC35): el calendario de quien pregunta + los canales SIN regla de
   * los almacenes de su alcance (los mismos que recorta `worklist`, área `compras`). Si los canales fallan, el aviso
   * sale con `sin_regla.measured: false` y la causa queda aquí.
   */
  async aviso(): Promise<AvisoCalendario> {
    const tenant = this.tenantCtx.requireTenantId();
    const { lee } = await this.alcance();
    const almacenes = await this.scope.warehouseIds(undefined, 'compras/calendario/aviso', AREA);
    return this.tk.run((trx: Knex.Transaction) => leerAviso(trx, tenant, lee, almacenes, (e) =>
      this.logger.warn(`[PQ.3.24] ciclo por canal (proveedores sin regla) NO MEDIDO: ${String((e as Error)?.message ?? e).split(' - ').pop()}`)));
  }

  propuestas(): Promise<PropuestasCalendario> {
    const tenant = this.tenantCtx.requireTenantId();
    // `[PQ.3.14]` Si la actividad de 12 meses falla, la respuesta lo DECLARA (`dia_fijo.measured: false`) y aquí queda la causa.
    // `[PQ.3.18]` Igual con la compra de 12 meses del embudo (`embudo.measured: false`).
    return this.tk.run((trx: Knex.Transaction) => leerPropuestas(trx, tenant, (e, que) =>
      this.logger.warn(`${que === 'compra' ? '[PQ.3.18] peso del embudo' : '[PQ.3.14] día fijo por sucursal'} NO MEDIDO: ${String((e as Error)?.message ?? e).split(' - ').pop()}`)));
  }

  async guardarRegla(sesion: Sesion, dto: GuardarReglaDto): Promise<GuardarReglaRespuesta> {
    const tenant = this.tenantCtx.requireTenantId();
    const quien = await this.conAlcance(sesion);
    // `[PQ.3.22]` El alcance del responsable, fuera de la transacción (como el de quien escribe).
    const responsable = dto?.reviewer_user_id ? await this.alcanceDe(tenant, dto.reviewer_user_id) : undefined;
    return this.tk.run((trx: Knex.Transaction) => guardarRegla(trx, tenant, quien, dto, responsable)).catch(traducir);
  }

  /** `[PQ.3.22]` Dónde ESCRIBE una persona en Compras; si no se puede resolver, no se supone nada: se rechaza. */
  private async alcanceDe(tenant: string, userId: string): Promise<ResponsableResuelto> {
    try {
      const s = await this.scope.forUser(tenant, userId, undefined, AREA);
      return { userId, escribe: this.scope.intersectWrite(s, 'warehouse') };
    } catch (e) {
      this.logger.warn(`[PQ.3.22] alcance del responsable ${userId} NO RESUELTO: ${String((e as Error)?.message ?? e)}`);
      throw new BadRequestException('No pudimos saber qué sucursales ve la persona responsable: elige a otra o vuelve a intentar.');
    }
  }

  /**
   * `[PQ.3.22]` `GET /compras/calendario/responsables` (DC30): quién puede ser responsable de una regla, con las
   * sucursales donde escribe. La pantalla ofrece sólo a quien escribe en TODAS las sucursales de la regla, con la
   * misma cuenta que la API usa al guardar (`puedeSerResponsable` / `reglaEnAlcance`). Quien no se pudo resolver no
   * se ofrece y queda en el log (no se adivina su alcance).
   */
  async responsables(): Promise<ResponsablesCalendario> {
    const tenant = this.tenantCtx.requireTenantId();
    const filas = await this.tk.run((trx: Knex.Transaction) => leerPosiblesResponsables(trx, tenant));
    const personas: ResponsablesCalendario['personas'][number][] = [];
    for (const f of filas) {
      try {
        const s = await this.scope.forUser(tenant, f.user_id, f.role_name || undefined, AREA);
        personas.push({ user_id: f.user_id, nombre: f.nombre, puesto: f.role_name, sucursales: this.scope.intersectWrite(s, 'warehouse') });
      } catch (e) {
        this.logger.warn(`[PQ.3.22] posible responsable ${f.user_id} sin alcance resuelto, no se ofrece: ${String((e as Error)?.message ?? e)}`);
      }
    }
    return { personas };
  }

  /** `[PQ.3.18]` (c) Los ocasionales en bloque (DC27): regla «cada 180 días» y fuera de ciclo 26 semanas, en una transacción. */
  async definirOcasionales(sesion: Sesion, dto: DefinirOcasionalesDto): Promise<DefinirOcasionalesRespuesta> {
    const tenant = this.tenantCtx.requireTenantId();
    const quien = await this.conAlcance(sesion);
    return this.tk.run((trx: Knex.Transaction) => definirOcasionales(trx, tenant, quien, dto)).catch(traducir);
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
