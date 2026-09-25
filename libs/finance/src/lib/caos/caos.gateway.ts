import { Injectable, Logger } from '@nestjs/common';
import { WebSocketGateway, WebSocketServer, OnGatewayConnection, OnGatewayDisconnect } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { Permission, isPlatformAdminRole } from '@megadulces/platform-core';

/** Aviso de que el espejo de CAOS cambió. Lleva la FIRMA (conteo + max id + suma), no las filas. */
export interface CaosEvent {
  device: string | null;
  filas: number | null;
  max_id: number | null;
  firma?: string | null;
  datos_al: string | null;
  emitted_at: string;
}

/**
 * CS.2 — Gateway de CAOS. Namespace `/caos`, path `/reports/socket.io` (mismo ReportsIoAdapter).
 * Handshake JWT en `auth.token`; exige `FINANCE_CAOS_VER` (o rol platform-admin). El permiso sale
 * del snapshot del JWT, así que un permiso recién repartido aplica al reconectar. Gateway propio y
 * no reuso del de `/caja` a propósito: distinto permiso, distinto circuito de efectivo.
 */
@WebSocketGateway({ namespace: '/caos', cors: { origin: '*', credentials: true } })
@Injectable()
export class CaosGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(CaosGateway.name);

  @WebSocketServer() server: Server;
  private tenantSockets = new Map<string, Set<string>>();

  constructor(private readonly jwtService: JwtService) {}

  async handleConnection(client: Socket): Promise<void> {
    const token = this.extractToken(client);
    if (!token) { client.emit('auth_error', { reason: 'missing_token' }); client.disconnect(true); return; }
    let payload: any;
    try { payload = this.jwtService.verify(token); }
    catch (e: any) {
      this.logger.warn(`Reject ${client.id}: JWT inválido (${e.message})`);
      client.emit('auth_error', { reason: 'invalid_token' }); client.disconnect(true); return;
    }
    const tenantId = payload?.tenant_id;
    if (!tenantId) { client.emit('auth_error', { reason: 'no_tenant_in_token' }); client.disconnect(true); return; }

    const perms = (payload?.permissions || {}) as Record<string, boolean>;
    const allowed = isPlatformAdminRole(payload?.role_name) || perms[Permission.FINANCE_CAOS_VER] === true;
    if (!allowed) {
      this.logger.warn(`Reject ${client.id}: ${payload?.username || '?'} sin lectura de CAOS`);
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

  /** Empuja el cambio a la room del tenant. Best-effort: nunca bloquea ni tira al llamador. */
  emitChange(tenantId: string, ev: Omit<CaosEvent, 'emitted_at'>): void {
    if (!this.server) return;
    const full: CaosEvent = { ...ev, emitted_at: new Date().toISOString() };
    this.server.to(`tenant:${tenantId}`).emit('caos_changed', full);
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
