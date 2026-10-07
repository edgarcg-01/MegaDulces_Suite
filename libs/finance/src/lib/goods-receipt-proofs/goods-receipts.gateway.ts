import { Injectable, Logger } from '@nestjs/common';
import { WebSocketGateway, WebSocketServer, OnGatewayConnection, OnGatewayDisconnect } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { Permission, isPlatformAdminRole } from '@megadulces/platform-core';

export interface NewReceiptsEvent {
  count: number;
  sample: { sucursal: string; folio: string; proveedor: string | null }[];
  emitted_at: string;
}

/**
 * RE.10 — Gateway WS de nuevas órdenes de entrada. Path HTTP `/reports/socket.io`
 * (ReportsIoAdapter en main.ts), namespace `/goods-receipts`. Handshake: JWT en
 * `auth.token`; el socket se une a la room `tenant:<id>`. `GoodsReceiptsWatcherService`
 * empuja `new_receipts` a la room cuando aparecen órdenes nuevas en el espejo. Cliente
 * sin token o inválido → desconecta (patrón de AlertsGateway).
 */
@WebSocketGateway({ namespace: '/goods-receipts', cors: { origin: '*', credentials: true } })
@Injectable()
export class GoodsReceiptsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(GoodsReceiptsGateway.name);

  @WebSocketServer() server: Server;
  private tenantSockets = new Map<string, Set<string>>();

  constructor(private readonly jwtService: JwtService) {}

  async handleConnection(client: Socket): Promise<void> {
    const token = this.extractToken(client);
    if (!token) { client.emit('auth_error', { reason: 'missing_token' }); client.disconnect(true); return; }
    let payload: any;
    try { payload = this.jwtService.verify(token); }
    catch (e: any) { this.logger.warn(`Reject ${client.id}: JWT inválido (${e.message})`); client.emit('auth_error', { reason: 'invalid_token' }); client.disconnect(true); return; }
    const tenantId = payload?.tenant_id;
    if (!tenantId) { client.emit('auth_error', { reason: 'no_tenant_in_token' }); client.disconnect(true); return; }
    // COMM.8 — mismo cierre que en /bancos y /cobranza: antes bastaba un JWT válido
    // del tenant, así que CUALQUIER usuario autenticado (un vendedor, un repartidor)
    // podía escuchar este canal. Se exige el permiso de LECTURA de la pantalla que
    // lo consume, e `isPlatformAdminRole` replica el god-mode del RolesGuard (sin eso
    // el superusuario quedaba fuera de su propio tablero). Se lee el snapshot del JWT:
    // un permiso revocado después del login aplica al reconectar, no al instante.
    // Esta bandeja vive en el proyecto Compras, así que el gate es el suyo.
    const perms = (payload?.permissions || {}) as Record<string, boolean>;
    const allowed = isPlatformAdminRole(payload?.role_name)
      || perms[Permission.COMPRAS_ENTRADAS_VER] === true;
    if (!allowed) {
      this.logger.warn(`Reject ${client.id}: ${payload?.username || '?'} sin permiso de lectura de entradas`);
      client.emit('auth_error', { reason: 'forbidden' });
      client.disconnect(true);
      return;
    }
    client.join(`tenant:${tenantId}`);
    client.data = { tenantId, username: payload.username };
    if (!this.tenantSockets.has(tenantId)) this.tenantSockets.set(tenantId, new Set());
    this.tenantSockets.get(tenantId)!.add(client.id);
    client.emit('connected', { tenant_id: tenantId });
  }

  handleDisconnect(client: Socket): void {
    const t = client.data?.tenantId;
    if (t) this.tenantSockets.get(t)?.delete(client.id);
  }

  /** ¿Hay al menos un cliente conectado del tenant? (el watcher evita emitir al vacío). */
  hasClients(tenantId: string): boolean {
    return (this.tenantSockets.get(tenantId)?.size || 0) > 0;
  }

  emitNewReceipts(tenantId: string, payload: NewReceiptsEvent): void {
    if (!this.server) return;
    this.server.to(`tenant:${tenantId}`).emit('new_receipts', payload);
    this.logger.debug(`new_receipts x${payload.count} → tenant:${tenantId}`);
  }

  private extractToken(client: Socket): string | null {
    const a = client.handshake?.auth?.token;
    if (typeof a === 'string' && a.length > 10) return a;
    const h = client.handshake?.headers?.authorization;
    if (typeof h === 'string') { const [s, t] = h.split(' '); if (s === 'Bearer' && t) return t; }
    const q = client.handshake?.query?.token;
    if (typeof q === 'string' && q.length > 10) return q;
    return null;
  }
}
