import { BadRequestException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import type { PresaleSellerOrder, SellerDayRecap, VisitMonitorVendor } from '@megadulces/contracts';
import { relojMx } from '../warehouse-orders/warehouse-orders.engine';
import { VisitMonitorService } from '../commercial-vendor-routes/visit-monitor.service';
import { PresalePickingService } from './presale-picking.service';
import { type FilaPedidoDelDia, armarRecuento } from './recuento-dia.engine';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;
const MX = `AT TIME ZONE 'America/Mexico_City'`;

/**
 * `[MCP.19]` El recuento del día de un vendedor. Lo piden él (su día) y su supervisor (el de alguien
 * de su equipo) y reciben lo MISMO.
 *
 * ⛔ Quién puede ver a quién lo decide el monitoreo de visitas (`[MCP.3.7]`: tú y tu equipo; god-mode
 * a quien tuvo ruta o visitas ese día). Para otra persona se le pregunta primero, y si contesta que
 * no, no se lee nada más (fail-closed). Para uno mismo, si el monitoreo falla, el resto sale igual y
 * las visitas se declaran no medidas.
 */
@Injectable()
export class SellerDayRecapService {
  private readonly logger = new Logger(SellerDayRecapService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly picking: PresalePickingService,
    private readonly visitas: VisitMonitorService,
  ) {}

  async recap(userIdParam?: string, dateParam?: string): Promise<SellerDayRecap> {
    const me = this.tenantCtx.get()?.userId;
    if (!me) throw new UnauthorizedException('Sin usuario en la sesión.');
    const userId = (userIdParam ?? '').trim() || me;
    if (!UUID_RE.test(userId)) throw new BadRequestException('user_id inválido');
    const hoy = relojMx(new Date()).fecha;
    const fecha = (dateParam ?? '').trim() || hoy;
    if (!FECHA_RE.test(fecha) || Number.isNaN(Date.parse(`${fecha}T00:00:00Z`))) {
      throw new BadRequestException('date debe ser YYYY-MM-DD');
    }
    if (fecha > hoy) throw new BadRequestException('Ese día todavía no llega.');

    // 1) Las visitas, y para otra persona también la puerta.
    let visitas: VisitMonitorVendor | null = null;
    let visitasError: string | null = null;
    try {
      const r = await this.visitas.monitor(fecha, userId);
      visitas = r.vendors.find((v) => v.user_id === userId) ?? null;
      if (!visitas) visitasError = 'Sin ruta ni visitas ese día.';
    } catch (e) {
      if (userId !== me) throw e;
      visitasError = 'No se pudieron leer las visitas.';
      this.logger.warn(`[MCP.19] visitas de ${userId} el ${fecha}: ${(e as Error).message}`);
    }

    // 2) Sus pedidos de ese día: los creados ese día, más los borradores y cancelados que se tocaron ese día.
    const { nombre, pedidos } = await this.tk.run(async (trx) => {
      const u = await trx('identity.users').where({ id: userId }).first('nombre');
      const { rows } = await trx.raw(
        `SELECT o.id, o.code, o.customer_id, c.name AS customer_name, o.status, o.total, o.created_at,
                o.group_id, o.cancellation_reason
           FROM commercial.orders o
           LEFT JOIN commercial.customers c ON c.id = o.customer_id AND c.tenant_id = o.tenant_id
          WHERE o.tenant_id = ? AND o.user_id = ? AND o.deleted_at IS NULL
            AND ((o.created_at ${MX})::date = ?::date
                 OR (o.status = 'draft' AND (o.updated_at ${MX})::date = ?::date)
                 OR (o.status = 'cancelled' AND (coalesce(o.cancelled_at, o.updated_at) ${MX})::date = ?::date))
          ORDER BY o.created_at, o.code`,
        [this.tenantCtx.requireTenantId(), userId, fecha, fecha, fecha],
      );
      return { nombre: (u?.nombre as string | undefined) ?? null, pedidos: rows as FilaPedidoDelDia[] };
    });

    // 3) Qué pasó con lo que llegó a la mesa: el mismo armado que «Mis pedidos».
    const ids = pedidos.filter((p) => p.status === 'confirmed' || p.status === 'fulfilled').map((p) => p.id);
    let avance: PresaleSellerOrder[] | null = null;
    let avanceError: string | null = null;
    try {
      avance = await this.picking.avanceDe(ids);
    } catch (e) {
      avanceError = 'No se pudo leer el surtido.';
      this.logger.warn(`[MCP.19] surtido de ${userId} el ${fecha}: ${(e as Error).message}`);
    }

    return armarRecuento({ fecha, hoy, userId, nombre, pedidos, avance, avanceError, visitas, visitasError });
  }
}
