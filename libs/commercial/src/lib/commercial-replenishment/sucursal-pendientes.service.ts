import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { Knex } from 'knex';
import { TenantKnexService, TenantContextService, isPlatformAdminRole } from '@megadulces/platform-core';
import {
  PENDIENTES_SUCURSAL_TOPE_FILAS,
  type ColaSucursal,
  type SucursalPendientesAlmacen,
  type SucursalPendientesResponse,
} from '@megadulces/contracts';
import { CommercialReplenishmentService } from './commercial-replenishment.service';
import { AutoabastoPedidoService } from './autoabasto-pedido.service';
import { COLAS_SUCURSAL, FUERA_DE_PENDIENTES, LLAVE_VIENE, colasDeViene, type ColaDef } from './sucursal-pendientes.registry';
import { SUCURSALES_DEL_ALMACEN_SQL, envolver } from './sucursal-pendientes.sql';

/** El área de alcance de la pantalla: la misma que Autoabasto (el selector de almacenes). */
const AREA = 'almacen';

export interface QuienPidePendientes {
  username?: string;
  role_name?: string;
  roles_frescos?: string[];
  permissions?: Record<string, boolean>;
}

interface FilaSql { folio: string | null; detalle: string | null; monto: unknown; total: number; dias: number | null }

/**
 * `[AB.45]` **Pendientes de la sucursal**: todas las colas de la Suite con trabajo de UNA sucursal.
 *
 * Sólo LEE. Las colas salen del registro (`sucursal-pendientes.registry.ts`), cada una con la llave
 * de la pantalla que la resuelve: a la persona sólo le viajan las que puede abrir. El almacén se
 * busca en la lista que la persona alcanza (no se confía en el query).
 */
@Injectable()
export class SucursalPendientesService {
  private readonly logger = new Logger(SucursalPendientesService.name);

  constructor(
    private readonly motor: CommercialReplenishmentService,
    private readonly pedidos: AutoabastoPedidoService,
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /** Los almacenes que la persona alcanza en el área Almacén, con su llave de sucursal. */
  async almacenes(): Promise<SucursalPendientesAlmacen[]> {
    const ws = (await this.motor.almacenes(AREA)) as Array<{ id: string; code: string; name: string }>;
    return this.pedidos.conLlaveDeSucursal(ws.map((w) => ({ id: w.id, code: w.code, name: w.name })));
  }

  async pendientes(warehouseId: string | undefined, quien: QuienPidePendientes | undefined): Promise<SucursalPendientesResponse> {
    const almacen = (await this.almacenes()).find((a) => a.id === warehouseId);
    if (!almacen) throw new ForbiddenException('Ese almacén no está dentro de tu alcance.');
    const tenantId = this.tenantCtx.requireTenantId();

    const roles = quien?.roles_frescos ?? (quien?.role_name ? [quien.role_name] : []);
    const admin = roles.some((r) => isPlatformAdminRole(r));
    const tiene = (p: string) => admin || quien?.permissions?.[p] === true;
    const visible = (c: ColaDef) => c.anyOf.some(tiene) && (c.allOf ?? []).every(tiene);

    const { code, kc, sucs } = await this.tk.run(async (trx: Knex.Transaction) => {
      const w = await trx('commercial.warehouses').where({ tenant_id: tenantId, id: almacen.id }).first('code', 'kepler_code');
      const s = await trx.raw(SUCURSALES_DEL_ALMACEN_SQL, { t: tenantId, wh: almacen.id });
      return {
        code: String(w?.code ?? '').trim(),
        kc: String(w?.kepler_code || w?.code || '').trim(),
        sucs: String(s.rows?.[0]?.sucs ?? '{}'),
      };
    });
    const binds = { t: tenantId, wh: almacen.id, suc: almacen.sucursal ?? '', kc, sucs };

    // Cada pesada en su conexión; las ligeras juntas en otra (~20 consultas de 1–40 ms). Así el total es
    // el de la más lenta, no la suma. Con «lo que te va a llegar» son a lo más 4 conexiones del pool.
    const defs = COLAS_SUCURSAL.filter(visible);
    const tandas: ColaDef[][] = [...defs.filter((d) => d.pesada).map((d) => [d]), defs.filter((d) => !d.pesada)];

    const [resultados, viene] = await Promise.all([
      Promise.all(tandas.map((t) => this.correr(t, binds))).then((r) => r.flat()),
      // `viene` recibe el `code` del almacén, igual que en Autoabasto (`almacenEnAlcance`).
      tiene(LLAVE_VIENE) ? this.colasViene({ id: almacen.id, code, name: almacen.name }) : Promise.resolve([] as ColaSucursal[]),
    ]);

    return {
      almacen,
      generado_en: new Date().toISOString(),
      colas: [...viene, ...resultados],
      fuera: [...FUERA_DE_PENDIENTES],
    };
  }

  /** Una tanda de colas en una transacción. Una consulta que falla se DECLARA (`no_medido`), no se vuelve cero. */
  private correr(defs: ColaDef[], binds: Record<string, string>): Promise<ColaSucursal[]> {
    if (!defs.length) return Promise.resolve([]);
    return this.tk.run(async (trx: Knex.Transaction) => {
      const out: ColaSucursal[] = [];
      for (const d of defs) {
        const base = {
          id: d.id, grupo: d.grupo, de: d.de, label: d.label, accion: d.accion, ruta: d.ruta,
          query: d.query ? d.query(binds['suc'] || null) : null, ventana: d.ventana,
        };
        try {
          await trx.raw('SAVEPOINT cola');
          const { rows } = await trx.raw(envolver(d.sql), binds);
          await trx.raw('RELEASE SAVEPOINT cola');
          const filas = rows as FilaSql[];
          out.push({
            ...base, estado: 'ok', total: filas.length ? Number(filas[0].total) : 0,
            mas_viejo_dias: filas.length && filas[0].dias != null ? Math.max(0, Number(filas[0].dias)) : null,
            filas: filas.slice(0, PENDIENTES_SUCURSAL_TOPE_FILAS).map((f) => ({
              folio: String(f.folio ?? ''),
              detalle: f.detalle ?? null,
              dias: f.dias == null ? null : Math.max(0, Number(f.dias)),
              monto: f.monto == null ? null : Number(f.monto),
            })),
          });
        } catch (e) {
          await trx.raw('ROLLBACK TO SAVEPOINT cola');
          this.logger.warn(`cola ${d.id} no se pudo medir: ${(e as Error).message}`);
          out.push({ ...base, estado: 'no_medido', motivo: 'No se pudo leer esta cola.', total: 0, mas_viejo_dias: null, filas: [] });
        }
      }
      return out;
    });
  }

  private async colasViene(almacen: { id: string; code: string; name: string }): Promise<ColaSucursal[]> {
    try {
      const r = await this.pedidos.viene(almacen);
      if (!r.pedidos_medidos && !r.documentos.length) return [];
      return colasDeViene(r.documentos, PENDIENTES_SUCURSAL_TOPE_FILAS);
    } catch (e) {
      this.logger.warn(`«lo que te va a llegar» no se pudo medir: ${(e as Error).message}`);
      return [{
        id: 'traspasos-sin-recibir', grupo: 'recibir', de: 'sucursal', label: 'Traspasos que te mandaron, sin recibir en Kepler',
        accion: 'Captura la recepción en Kepler', ruta: '/almacen/autoabasto', query: null, ventana: 'últimos 30 días',
        estado: 'no_medido', motivo: 'No se pudo leer lo que te va a llegar.', total: 0, mas_viejo_dias: null, filas: [],
      }];
    }
  }
}
