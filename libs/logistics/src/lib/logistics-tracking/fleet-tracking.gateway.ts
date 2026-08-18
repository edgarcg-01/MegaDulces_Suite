import { Injectable, Logger } from '@nestjs/common';
import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';

/**
 * LT.8 — Gateway WS para rastreo de flota en vivo (namespace `/fleet`).
 *
 * Empuja la última posición de cada tracker a los clientes del tenant apenas el
 * poller sincroniza con el proveedor (MagniTracking) — la trazabilidad se mueve
 * "al momento" en el mapa, sin que el frontend haga polling.
 *
 * Path HTTP: `/reports/socket.io` (mismo adapter que los demás gateways).
 * Handshake: `auth: { token: <JWT> }`. Sin token / token inválido → disconnect.
 * Cada socket se une a la room `tenant:<tenant_id>`; el server emite `fleet:live`.
 */
@WebSocketGateway({
  namespace: '/fleet',
  cors: { origin: '*', credentials: true },
})
@Injectable()
export class FleetTrackingGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(FleetTrackingGateway.name);

  @WebSocketServer()
  server: Server;

  private tenantSockets: Map<string, Set<string>> = new Map();

  constructor(private readonly jwtService: JwtService) {}

  handleConnection(client: Socket): void {
    const token = this.extractToken(client);
    if (!token) {
      client.emit('auth_error', { reason: 'missing_token' });
      client.disconnect(true);
      return;
    }
    let payload: any;
    try {
      payload = this.jwtService.verify(token);
    } catch (e: any) {
      client.emit('auth_error', { reason: 'invalid_token' });
      client.disconnect(true);
      return;
    }
    const tenantId = payload?.tenant_id;
    if (!tenantId) {
      client.emit('auth_error', { reason: 'no_tenant_in_token' });
      client.disconnect(true);
      return;
    }
    const room = `tenant:${tenantId}`;
    client.join(room);
    client.data = { tenantId, userId: payload.sub, username: payload.username };
    if (!this.tenantSockets.has(tenantId)) this.tenantSockets.set(tenantId, new Set());
    this.tenantSockets.get(tenantId)!.add(client.id);
    this.logger.debug(`Connected ${client.id} → tenant=${tenantId} (room=${room})`);
    client.emit('connected', { tenant_id: tenantId, room });
  }

  handleDisconnect(client: Socket): void {
    const tenantId = client.data?.tenantId;
    if (tenantId) this.tenantSockets.get(tenantId)?.delete(client.id);
  }

  /** Empuja el snapshot de flota en vivo a todos los clientes del tenant. */
  emitLive(tenantId: string, payload: { trackers: any[]; synced_at: string; positions: number }): void {
    if (!this.server) return;
    const clients = this.tenantSockets.get(tenantId)?.size || 0;
    if (!clients) return; // nadie escuchando → no gastes
    this.server.to(`tenant:${tenantId}`).emit('fleet:live', payload);
    this.logger.debug(`fleet:live → tenant=${tenantId} (${payload.trackers.length} trackers, ${clients} clientes)`);
  }

  getStats() {
    const stats: Record<string, number> = {};
    for (const [t, s] of this.tenantSockets) stats[t] = s.size;
    return { tenants: stats, total_sockets: Array.from(this.tenantSockets.values()).reduce((s, x) => s + x.size, 0) };
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
