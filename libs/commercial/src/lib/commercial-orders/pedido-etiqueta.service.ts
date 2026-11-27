import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash } from 'node:crypto';
import {
  TenantContextService, TenantKnexService, jwtVerifyOptions, origenPublicoParaEnlace, requireJwtSecret,
} from '@megadulces/platform-core';
import {
  type FirmaEtiquetaPedido, type PedidoPublico, type RenglonPedidoPublico, folioDeLectura, ligaDePedido, pasoDelPedido,
} from '@megadulces/contracts';

/**
 * Lo que viaja firmado en la liga. `t` lo separa de cualquier otro token de la Suite. Nombres cortos y sin `iat` a
 * propósito: cada carácter engorda el QR, y el QR se imprime en papel térmico (medido: 294 caracteres = módulos de
 * medio milímetro a 38 mm).
 */
interface TokenEtiqueta { t: 'pe'; tn: string; f: string }

/** Cuánto abre la liga desde que se imprime (D2 del MCP.36): un pedido se entrega en días. */
export const VIGENCIA_LIGA_DIAS = 30;

const LIGA_NO_SIRVE = 'Esta etiqueta ya no abre el pedido. Pide al almacén que la vuelva a imprimir.';

/** Dinero de Postgres (`numeric` llega como texto) a número; lo que no es número, `null` (nunca 0 inventado). */
const num = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));
const dia = (v: unknown): string | null => {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const m = /^\d{4}-\d{2}-\d{2}/.exec(String(v));
  return m ? m[0] : null;
};

/**
 * `[MCP.36]` La liga del QR de la etiqueta del pedido: abre el pedido en cualquier celular, con o sin usuario.
 *
 * Decisión de Edgar (comunicada por David, 2026-11-25): «para todos sin excepciones», con montos. La autoridad es la
 * firma de la liga, igual que el enlace del estado de cuenta del cliente (`customer-deposits.service.ts`), con dos
 * diferencias a propósito:
 *  - **Otra clave.** Se deriva de la de sesión con un propósito propio: una liga de etiqueta NUNCA pasa por una
 *    sesión (el guard de sesión la rechaza, porque no la firmó su clave), aunque alguien la pegue como `Bearer`.
 *  - **Vence** a los `VIGENCIA_LIGA_DIAS` días: la bolsa anda en la camioneta y el celular de cualquiera.
 *
 * El pedido se lee con RLS en la empresa que trae la firma (`tenantCtx.run` + `tk.run`): sin conexión de administrador.
 * Se devuelve una lista CERRADA de campos (nunca `o.*`): ids internos, usuarios y CFDI no salen.
 */
@Injectable()
export class PedidoEtiquetaService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly jwt: JwtService,
  ) {}

  private clave(): string {
    return createHash('sha256').update(`${requireJwtSecret()}|mcp36|pedido-etiqueta`).digest('hex');
  }

  /** La firma para imprimir (Surtir y Revisión). El pedido tiene que existir en la empresa de quien imprime. */
  async firmar(folioLeido: string, origen?: string): Promise<FirmaEtiquetaPedido> {
    const folio = folioDeLectura(folioLeido);
    if (!folio) throw new BadRequestException('Ese folio no es de un pedido de la Suite.');
    const tenantId = this.tenantCtx.requireTenantId();
    const existe = await this.tk.run((trx) =>
      trx('commercial.orders').where({ code: folio }).whereNull('deleted_at').first('id'));
    if (!existe) throw new NotFoundException(`No encontré el pedido ${folio}.`);
    const payload: TokenEtiqueta = { t: 'pe', tn: tenantId, f: folio };
    const k = this.jwt.sign(payload, { secret: this.clave(), expiresIn: `${VIGENCIA_LIGA_DIAS}d`, algorithm: 'HS256', noTimestamp: true });
    const liga = ligaDePedido(origenPublicoParaEnlace(origen), folio, k);
    if (!liga) throw new BadRequestException('No se pudo armar la liga del pedido.');
    const vence = new Date(Date.now() + VIGENCIA_LIGA_DIAS * 86_400_000).toISOString();
    return { folio, k, liga, vence };
  }

  /** Verifica la firma contra el folio de la liga. Cualquier falla, la misma respuesta: no se da pista. */
  private resolver(folioLeido: string, k: string): { tenantId: string; folio: string; vence: string | null } {
    const folio = folioDeLectura(folioLeido);
    if (!folio || !k) throw new ForbiddenException(LIGA_NO_SIRVE);
    let p: TokenEtiqueta & { exp?: number };
    try {
      p = this.jwt.verify<TokenEtiqueta & { exp?: number }>(k, { secret: this.clave(), ...jwtVerifyOptions });
    } catch {
      throw new ForbiddenException(LIGA_NO_SIRVE);
    }
    if (p?.t !== 'pe' || !p.tn || p.f !== folio) throw new ForbiddenException(LIGA_NO_SIRVE);
    return { tenantId: p.tn, folio, vence: typeof p.exp === 'number' ? new Date(p.exp * 1000).toISOString() : null };
  }

  /** El pedido de la liga, para la pantalla pública `/pedido/:folio`. */
  async leer(folioLeido: string, k: string): Promise<PedidoPublico> {
    const { tenantId, folio, vence } = this.resolver(folioLeido, k);
    return this.tenantCtx.run({ tenantId, username: `etiqueta:${folio}` }, () => this.tk.run(async (trx) => {
      const o = await trx('commercial.orders as o')
        .leftJoin('commercial.customers as c', 'c.id', 'o.customer_id')
        .leftJoin('commercial.warehouses as w', 'w.id', 'o.warehouse_id')
        .leftJoin('public.users as u', 'u.id', 'o.user_id')
        .leftJoin('commercial.presale_picks as pp', function () {
          this.on('pp.order_id', '=', 'o.id').andOn('pp.tenant_id', '=', 'o.tenant_id');
        })
        .where('o.code', folio)
        .whereNull('o.deleted_at')
        .first(
          'o.id', 'o.code', 'o.status', 'o.created_at', 'o.requested_delivery_date', 'o.currency',
          'o.subtotal', 'o.tax_total', 'o.total', 'o.basket_discount_amount',
          'c.name as cliente', 'w.name as sucursal',
          trx.raw(`coalesce(nullif(btrim(u.nombre), ''), u.username) AS vendedor`),
          'pp.started_at as pick_started_at', 'pp.finished_at as pick_finished_at', 'pp.outcome as pick_outcome',
          'pp.reviewed_at as reviewed_at',
        );
      // Firma buena y pedido que ya no está (borrado): se dice así, no como «la liga no sirve».
      if (!o) throw new NotFoundException(`El pedido ${folio} ya no está en la Suite.`);
      const filas = await trx('commercial.order_lines as ol')
        .leftJoin('public.products as p', 'p.id', 'ol.product_id')
        .where('ol.order_id', o.id)
        .orderBy('ol.line_number')
        .select('p.nombre as producto', 'p.sku as sku', 'ol.quantity', 'ol.qty_unit', 'ol.unit_price', 'ol.line_total');
      const renglones: RenglonPedidoPublico[] = filas.map((r: Record<string, unknown>) => ({
        producto: String(r['producto'] ?? 'Producto sin nombre'),
        sku: r['sku'] == null ? null : String(r['sku']),
        cantidad: num(r['quantity']) ?? 0,
        unidad: r['qty_unit'] == null ? null : String(r['qty_unit']),
        precio: num(r['unit_price']),
        importe: num(r['line_total']),
      }));
      return {
        folio: String(o.code),
        paso: pasoDelPedido({
          status: o.status, pick_started_at: o.pick_started_at, pick_finished_at: o.pick_finished_at,
          pick_outcome: o.pick_outcome, reviewed_at: o.reviewed_at,
        }),
        cliente: o.cliente ?? null,
        vendedor: o.vendedor ?? null,
        sucursal: o.sucursal ?? null,
        entrega: dia(o.requested_delivery_date),
        creado: iso(o.created_at),
        renglones,
        subtotal: num(o.subtotal),
        descuento: num(o.basket_discount_amount),
        impuestos: num(o.tax_total),
        total: num(o.total),
        moneda: o.currency ?? null,
        liga_vence: vence,
      };
    }));
  }
}
