import { Injectable, Logger } from '@nestjs/common';
import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { LiveTicket, StoreAlert } from './store.types';

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

  getStats() {
    const stats: Record<string, number> = {};
    for (const [t, s] of this.tenantSockets) stats[t] = s.size;
    return { tenants: stats, total_sockets: [...this.tenantSockets.values()].reduce((a, x) => a + x.size, 0) };
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
