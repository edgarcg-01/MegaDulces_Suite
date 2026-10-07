import { Injectable, Logger } from '@nestjs/common';
import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';

/**
 * Gateway WS para monitoreo de inventario físico en tiempo real (Fase I.7).
 *
 * Path HTTP: `/reports/socket.io` (mismo io server que /alerts y /reports).
 * Namespace: `/inventory`.
 *
 * Flujo:
 *   1. El supervisor conecta con `auth: { token: <JWT> }`.
 *   2. Se une al room `tenant:<tenant_id>`.
 *   3. Emite `watch` con { folio_id } → se une a `tenant:<t>:folio:<id>`.
 *   4. El service emite eventos (count/session/phase/interruption) a ese room
 *      → el supervisor refresca su tablero al instante.
 *
 * Eventos son de SOLO LECTURA para el supervisor: el contador no recibe nada
 * (no rompe el conteo ciego — el monitoreo es del lado supervisor).
 */
export interface InventoryMonitorEvent {
  type: 'count' | 'session' | 'phase' | 'interruption';
  folio_id: string;
  at: string;
  [k: string]: any;
}

@WebSocketGateway({
  namespace: '/inventory',
  cors: { origin: '*', credentials: true },
})
@Injectable()
export class InventoryMonitorGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(InventoryMonitorGateway.name);

  @WebSocketServer()
  server: Server;

  constructor(private readonly jwtService: JwtService) {}

  async handleConnection(client: Socket): Promise<void> {
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
    client.join(`tenant:${tenantId}`);
    client.data = { tenantId, userId: payload.sub, username: payload.username, roleName: payload.role_name };
    client.emit('connected', { tenant_id: tenantId });
  }

  handleDisconnect(): void {
    /* socket.io limpia los rooms solo */
  }

  /** El supervisor pide seguir un folio específico → se une a su room. */
  @SubscribeMessage('watch')
  watch(@ConnectedSocket() client: Socket, @MessageBody() body: { folio_id?: string }) {
    const tenantId = client.data?.tenantId;
    const folioId = body?.folio_id;
    if (!tenantId || !folioId) return { ok: false };
    // Salir de cualquier folio previo para no recibir eventos cruzados.
    for (const room of client.rooms) {
      if (room.startsWith(`tenant:${tenantId}:folio:`)) client.leave(room);
    }
    client.join(`tenant:${tenantId}:folio:${folioId}`);
    return { ok: true, watching: folioId };
  }

  /** Emite un evento del folio a los supervisores que lo están mirando. */
  emitFolioEvent(tenantId: string, folioId: string, event: InventoryMonitorEvent): void {
    if (!this.server || !tenantId || !folioId) return;
    this.server.to(`tenant:${tenantId}:folio:${folioId}`).emit('inventory_event', event);
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
