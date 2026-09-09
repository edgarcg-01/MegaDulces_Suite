import { Injectable, Logger } from '@nestjs/common';
import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { LabelPricesChanged, LiveTicket, StoreAlert } from './store.types';

/**
 * Gateway WS del proyecto Tienda (monitor de tickets en vivo).
 *
 * Path HTTP: `/reports/socket.io` (ReportsIoAdapter en main.ts, compartido).
 * Namespace: `/store`.
 *
 * Flujo: cliente conecta con `auth:{token:<JWT>}` → se valida y se une al room
 * `tenant:<tenant_id>`. El StoreService emite `ticket` y `alert` a ese room.
 * Cliente sin token / JWT inválido se desconecta (igual que AlertsGateway).
 */
@WebSocketGateway({ namespace: '/store', cors: { origin: '*', credentials: true } })
@Injectable()
export class StoreGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(StoreGateway.name);

  @WebSocketServer()
  server: Server;

  private tenantSockets: Map<string, Set<string>> = new Map();

  constructor(private readonly jwtService: JwtService) {}

  async handleConnection(client: Socket): Promise<void> {
    const token = this.extractToken(client);
    if (!token) { client.emit('auth_error', { reason: 'missing_token' }); client.disconnect(true); return; }
    let payload: any;
    try { payload = this.jwtService.verify(token); }
    catch (e: any) { client.emit('auth_error', { reason: 'invalid_token' }); client.disconnect(true); return; }
    const tenantId = payload?.tenant_id;
    if (!tenantId) { client.emit('auth_error', { reason: 'no_tenant_in_token' }); client.disconnect(true); return; }

    // Scoping por sucursal: si el JWT trae warehouse_code, el usuario SOLO se une
    // al room de su sucursal (`tenant:<id>:wh:<code>`) → nunca recibe tickets de
    // otras. Sin warehouse_code (rol global) → room del tenant completo (todas).
    const warehouse: string | undefined = payload?.warehouse_code || undefined;
    const room = warehouse ? `tenant:${tenantId}:wh:${warehouse}` : `tenant:${tenantId}`;
    client.join(room);
    // Room PERSONAL, además del de sucursal: "haz tu arqueo" es un aviso dirigido a
    // UNA cajera, no a la tienda. Mandarlo al room de sucursal se lo mostraría a
    // todas y en dos días nadie lo miraría. El username ES el código de cajera de
    // Kepler, así que la llave del aviso y la del turno son la misma.
    if (payload?.username) client.join(`tenant:${tenantId}:user:${String(payload.username).toUpperCase()}`);
    // `[TDA.1]` Room de TODO el tenant, además del de sucursal. Hace falta porque los dos de arriba
    // son EXCLUYENTES: quien tiene `warehouse_code` entra sólo al room de su sucursal y NO al del
    // tenant. Para un ticket eso está bien (es de una sucursal), pero el precio de etiqueta es UNA
    // fila por producto para toda la red — emitirlo a `tenant:<id>` se saltearía exactamente al
    // personal de tienda, que es quien imprime.
    client.join(`tenant:${tenantId}:all`);
    client.data = { tenantId, userId: payload.sub, username: payload.username, warehouse };
    if (!this.tenantSockets.has(tenantId)) this.tenantSockets.set(tenantId, new Set());
    this.tenantSockets.get(tenantId)!.add(client.id);
    this.logger.log(`Connected ${client.id} → ${room} user=${payload.username}`);
    client.emit('connected', { tenant_id: tenantId, room, warehouse: warehouse ?? null });
  }

  handleDisconnect(client: Socket): void {
    const tenantId = client.data?.tenantId;
    if (tenantId) this.tenantSockets.get(tenantId)?.delete(client.id);
  }

  emitTicket(tenantId: string, ticket: LiveTicket): void {
    if (!this.server) return;
    // Room del tenant (usuarios globales) + room de la sucursal (usuarios scopeados).
    this.server.to(`tenant:${tenantId}`).emit('ticket', ticket);
    if (ticket.warehouse_code) {
      this.server.to(`tenant:${tenantId}:wh:${ticket.warehouse_code}`).emit('ticket', ticket);
    }
  }

  emitAlert(tenantId: string, alert: StoreAlert): void {
    if (!this.server) return;
    this.server.to(`tenant:${tenantId}`).emit('alert', alert);
    const wh = alert?.data?.warehouse_code;
    if (wh) this.server.to(`tenant:${tenantId}:wh:${wh}`).emit('alert', alert);
  }

  /**
   * `[TDA.1]` — El precio de etiqueta de estos productos cambió en Kepler.
   *
   * Va al room de TODO el tenant porque el precio de etiqueta es una fila por producto para toda la
   * red (`commercial.product_label_prices` tiene UNIQUE por `(tenant_id, product_id)`, no por
   * sucursal), así que el cambio le importa a cualquier pantalla que tenga ese producto en cola.
   *
   * Lo dispara el hop-2 de `feeds-ingest` vía `POST /store/live/label-prices-changed`: es el mismo
   * camino máquina-a-máquina del poller de tickets, con el mismo `x-store-ingest-key`.
   */
  emitLabelPricesChanged(tenantId: string, payload: LabelPricesChanged): void {
    if (!this.server) return;
    this.server.to(`tenant:${tenantId}:all`).emit('label_prices_changed', payload);
  }

  /**
   * Aviso dirigido a una cajera por su código de Kepler. Best-effort: si no está
   * conectada no pasa nada — el turno igual la espera en la pantalla y, si nadie
   * cuenta, el vencimiento lo levanta el supervisor. Esto acorta el tiempo, no
   * reemplaza el control.
   */
  emitToCajero(tenantId: string, cajeroCode: string, evento: string, payload: unknown): void {
    if (!this.server || !cajeroCode) return;
    this.server.to(`tenant:${tenantId}:user:${cajeroCode.toUpperCase()}`).emit(evento, payload);
  }

  getStats() {
    const stats: Record<string, number> = {};
    for (const [t, s] of this.tenantSockets) stats[t] = s.size;
    return { tenants: stats, total_sockets: Array.from(this.tenantSockets.values()).reduce((a, x) => a + x.size, 0) };
  }

  private extractToken(client: Socket): string | null {
    const fromAuth = client.handshake?.auth?.token;
    if (typeof fromAuth === 'string' && fromAuth.length > 10) return fromAuth;
    const authHeader = client.handshake?.headers?.authorization;
    if (typeof authHeader === 'string') {
      const [scheme, token] = authHeader.split(' ');
      if (scheme === 'Bearer' && token) return token;
    }
    const fromQuery = client.handshake?.query?.token;
    if (typeof fromQuery === 'string' && fromQuery.length > 10) return fromQuery;
    return null;
  }
}
