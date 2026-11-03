import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Knex } from 'knex';
import { TenantKnexService, TenantContextService, isPlatformAdminRole } from '@megadulces/platform-core';
import {
  PENDIENTES_SUCURSAL_TOPE_FILAS,
  type AtribuirPendienteRequest,
  type ColaSucursal,
  type ResponsablePendiente,
  type SucursalPendientesAlmacen,
  type SucursalPendientesResponse,
} from '@megadulces/contracts';
import { CommercialReplenishmentService } from './commercial-replenishment.service';
import { AutoabastoPedidoService } from './autoabasto-pedido.service';
import { COLAS_SUCURSAL, COLAS_VIENE, FUERA_DE_PENDIENTES, LLAVE_VIENE, colasDeViene, type ColaDef } from './sucursal-pendientes.registry';
import { SUCURSALES_DEL_ALMACEN_SQL, envolver } from './sucursal-pendientes.sql';

/** El área de alcance de la pantalla: la misma que Autoabasto (el selector de almacenes). */
const AREA = 'almacen';
const TABLA = 'commercial.sucursal_pendiente_responsables';
const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface QuienPidePendientes {
  sub?: string;
  username?: string;
  role_name?: string;
  roles_frescos?: string[];
  permissions?: Record<string, boolean>;
}

interface FilaSql { clave: string | null; folio: string | null; detalle: string | null; monto: unknown; total: number; dias: number | null }
interface FilaResp { cola: string; clave: string; user_id: string; nombre: string | null; created_at: Date | string }

/**
 * `[AB.45]`/`[AB.46]` **Pendientes de sucursal**: todas las colas de la Suite con trabajo de UNA sucursal.
 *
 * `[AB.46]` Edgar (2026-11-03): «darle acceso a cada persona con la sucursal a la MISMA información … para
 * que todos puedan atribuirse el resolver los pendientes». Por eso:
 *  · toda la sucursal ve TODAS las colas (antes cada cola viajaba sólo con su llave); `puede_abrir` dice
 *    a quién se le pinta «Resolver» (la llave de la pantalla dueña: sin ella, el enlace rebota);
 *  · cualquiera con el módulo se atribuye un pendiente («yo lo resuelvo») y lo puede soltar.
 * Qué sucursal ve cada quien lo decide su ALCANCE (área Almacén): con sucursal en su ficha, la suya;
 * oficinas, el selector.
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

  private async almacenEnAlcance(warehouseId: string | undefined): Promise<SucursalPendientesAlmacen> {
    const almacen = (await this.almacenes()).find((a) => a.id === warehouseId);
    if (!almacen) throw new ForbiddenException('Ese almacén no está dentro de tu alcance.');
    return almacen;
  }

  async pendientes(warehouseId: string | undefined, quien: QuienPidePendientes | undefined): Promise<SucursalPendientesResponse> {
    const almacen = await this.almacenEnAlcance(warehouseId);
    const tenantId = this.tenantCtx.requireTenantId();
    const admin = esAdmin(quien);
    const tiene = (p: string) => admin || quien?.permissions?.[p] === true;
    const puedeAbrir = (c: { anyOf: readonly string[]; allOf?: readonly string[] }) => c.anyOf.some(tiene) && (c.allOf ?? []).every(tiene);

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
    // el de la más lenta, no la suma. Con «lo que te va a llegar» y los responsables son a lo más 5
    // conexiones del pool.
    const tandas: ColaDef[][] = [...COLAS_SUCURSAL.filter((d) => d.pesada).map((d) => [d]), COLAS_SUCURSAL.filter((d) => !d.pesada)];

    const [resultados, viene, responsables] = await Promise.all([
      Promise.all(tandas.map((t) => this.correr(t, binds))).then((r) => r.flat()),
      // `viene` recibe el `code` del almacén, igual que en Autoabasto (`almacenEnAlcance`).
      this.colasViene({ id: almacen.id, code, name: almacen.name }),
      this.responsables(almacen.id),
    ]);

    const yo = quien?.sub ?? null;
    const colas = [...viene, ...resultados].map((c) => {
      const def = COLAS_SUCURSAL.find((d) => d.id === c.id);
      return {
        ...c,
        puede_abrir: def ? puedeAbrir(def) : tiene(LLAVE_VIENE),
        filas: c.filas.map((f) => {
          const r = responsables.get(`${c.id}\u0000${f.clave}`);
          return {
            ...f,
            responsable: r
              ? { user_id: r.user_id, nombre: r.nombre || 'Alguien', desde: new Date(r.created_at).toISOString(), soy_yo: !!yo && r.user_id === yo }
              : null,
          };
        }),
      };
    });

    return { almacen, generado_en: new Date().toISOString(), colas, fuera: [...FUERA_DE_PENDIENTES] };
  }

  /** `[AB.46]` «Yo lo resuelvo». Un pendiente tiene a lo más un responsable vivo. */
  async atribuir(body: AtribuirPendienteRequest | undefined, quien: QuienPidePendientes | undefined): Promise<ResponsablePendiente> {
    const { almacen, cola, clave, yo } = await this.validar(body, quien);
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx: Knex.Transaction) => {
      await this.exigeTabla(trx);
      const { rows } = await trx.raw(
        `INSERT INTO ${TABLA} (tenant_id, warehouse_id, cola, clave, user_id, nombre, created_by, updated_by)
         VALUES (:t, :wh, :cola, :clave, :yo,
                 (SELECT COALESCE(NULLIF(btrim(u.nombre), ''), u.username) FROM identity.users u WHERE u.id = :yo), :yo, :yo)
         ON CONFLICT (tenant_id, warehouse_id, cola, clave) WHERE deleted_at IS NULL DO NOTHING
         RETURNING user_id, nombre, created_at`,
        { t: tenantId, wh: almacen.id, cola, clave, yo },
      );
      const fila = (rows as FilaResp[])[0] ?? (await this.vivo(trx, tenantId, almacen.id, cola, clave));
      if (!fila) throw new ConflictException('No se pudo registrar: inténtalo de nuevo.');
      if (fila.user_id !== yo) throw new ConflictException(`Ya lo está resolviendo ${fila.nombre || 'otra persona'}.`);
      return { user_id: fila.user_id, nombre: fila.nombre || 'Tú', desde: new Date(fila.created_at).toISOString(), soy_yo: true };
    });
  }

  /** `[AB.46]` Soltar un pendiente. Sólo quien lo tiene (o un administrador de plataforma). */
  async soltar(body: AtribuirPendienteRequest | undefined, quien: QuienPidePendientes | undefined): Promise<{ ok: true }> {
    const { almacen, cola, clave, yo } = await this.validar(body, quien);
    const tenantId = this.tenantCtx.requireTenantId();
    const admin = esAdmin(quien);
    return this.tk.run(async (trx: Knex.Transaction) => {
      await this.exigeTabla(trx);
      const vivo = await this.vivo(trx, tenantId, almacen.id, cola, clave);
      if (!vivo) throw new NotFoundException('Nadie tiene ese pendiente.');
      if (vivo.user_id !== yo && !admin) throw new ForbiddenException(`Lo tiene ${vivo.nombre || 'otra persona'}: sólo esa persona lo puede soltar.`);
      await trx.raw(
        `UPDATE ${TABLA} SET deleted_at = now(), deleted_by = :yo, updated_at = now(), updated_by = :yo
          WHERE tenant_id = :t AND warehouse_id = :wh AND cola = :cola AND clave = :clave AND deleted_at IS NULL`,
        { t: tenantId, wh: almacen.id, cola, clave, yo },
      );
      return { ok: true as const };
    });
  }

  private async validar(body: AtribuirPendienteRequest | undefined, quien: QuienPidePendientes | undefined) {
    const yo = quien?.sub;
    if (!yo || !UUID_RX.test(yo)) throw new ForbiddenException('No se identificó a la persona.');
    if (!body?.warehouse_id || !UUID_RX.test(body.warehouse_id)) throw new BadRequestException('Falta el almacén.');
    const cola = String(body.cola ?? '').trim();
    const clave = String(body.clave ?? '').trim();
    const colas = new Set([...COLAS_SUCURSAL.map((c) => c.id), ...COLAS_VIENE]);
    if (!colas.has(cola)) throw new BadRequestException('Esa cola no existe.');
    if (!clave || clave.length > 200) throw new BadRequestException('Falta el pendiente.');
    // El alcance de la persona decide en qué sucursal puede atribuirse algo (el mismo que para verla).
    const almacen = await this.almacenEnAlcance(body.warehouse_id);
    return { almacen, cola, clave, yo };
  }

  private async vivo(trx: Knex.Transaction, t: string, wh: string, cola: string, clave: string): Promise<FilaResp | null> {
    const { rows } = await trx.raw(
      `SELECT cola, clave, user_id::text AS user_id, nombre, created_at FROM ${TABLA}
        WHERE tenant_id = :t AND warehouse_id = :wh AND cola = :cola AND clave = :clave AND deleted_at IS NULL`,
      { t, wh, cola, clave },
    );
    return (rows as FilaResp[])[0] ?? null;
  }

  private async tablaLista(trx: Knex.Transaction): Promise<boolean> {
    const { rows } = await trx.raw(`SELECT to_regclass('${TABLA}') IS NOT NULL AS ok`);
    return !!rows?.[0]?.ok;
  }

  private async exigeTabla(trx: Knex.Transaction): Promise<void> {
    if (!(await this.tablaLista(trx))) {
      throw new ServiceUnavailableException('Atribuirse pendientes todavía no está disponible: falta aplicar su migración.');
    }
  }

  /** Los responsables vivos del almacén. Sin la tabla (migración sin aplicar) no hay responsables: se lee igual. */
  private responsables(warehouseId: string): Promise<Map<string, FilaResp>> {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx: Knex.Transaction) => {
      const mapa = new Map<string, FilaResp>();
      if (!(await this.tablaLista(trx))) return mapa;
      const { rows } = await trx.raw(
        `SELECT cola, clave, user_id::text AS user_id, nombre, created_at FROM ${TABLA}
          WHERE tenant_id = :t AND warehouse_id = :wh AND deleted_at IS NULL`,
        { t: tenantId, wh: warehouseId },
      );
      for (const r of rows as FilaResp[]) mapa.set(`${r.cola}\u0000${r.clave}`, r);
      return mapa;
    });
  }

  /** Una tanda de colas en una transacción. Una consulta que falla se DECLARA (`no_medido`), no se vuelve cero. */
  private correr(defs: ColaDef[], binds: Record<string, string>): Promise<ColaSucursal[]> {
    if (!defs.length) return Promise.resolve([]);
    return this.tk.run(async (trx: Knex.Transaction) => {
      const out: ColaSucursal[] = [];
      for (const d of defs) {
        const base = {
          id: d.id, grupo: d.grupo, de: d.de, label: d.label, accion: d.accion, ruta: d.ruta,
          query: d.query ? d.query(binds['suc'] || null) : null, ventana: d.ventana, puede_abrir: false,
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
              clave: String(f.clave ?? f.folio ?? ''),
              responsable: null,
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
        accion: 'Captura la recepción en Kepler', ruta: '/almacen/autoabasto', query: null, ventana: 'últimos 30 días', puede_abrir: false,
        estado: 'no_medido', motivo: 'No se pudo leer lo que te va a llegar.', total: 0, mas_viejo_dias: null, filas: [],
      }];
    }
  }
}

function esAdmin(quien: QuienPidePendientes | undefined): boolean {
  const roles = quien?.roles_frescos ?? (quien?.role_name ? [quien.role_name] : []);
  return roles.some((r) => isPlatformAdminRole(r));
}
