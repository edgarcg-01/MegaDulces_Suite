import { Injectable, Logger } from '@nestjs/common';
import { WebSocketGateway, WebSocketServer, OnGatewayConnection, OnGatewayDisconnect } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { Permission, isPlatformAdminRole } from '@megadulces/platform-core';

/** Un cambio en un comprobante de cobranza (lo dispara una acción de un usuario). */
export interface CollectionDepositEvent {
  action: 'attached' | 'validated' | 'rejected' | 'bank_matched' | 'bank_unmatched';
  sucursal: string;
  folio: string;
  status: string | null;      // estado del comprobante tras la acción (recibido/validado/rechazado)
  cliente: string | null;
  monto: number | null;
  actor: string | null;
  emitted_at: string;
}

/**
 * COMM-P1 (Fase CC) — Gateway WS de comprobantes de cobranza. Path HTTP
 * `/reports/socket.io` (ReportsIoAdapter en main.ts), namespace `/cobranza`.
 * Handshake: JWT en `auth.token`; el socket se une a la room `tenant:<id>`.
 *
 * Por qué existe: la bandeja de cobranza es el gemelo de pagos-comprobantes —
 * mismo flujo capturista→revisor, misma expectativa de ver el cambio del otro sin
 * refrescar — y era la única de las dos sin WS. Cuando alguien adjunta / valida /
 * rechaza / concilia una ficha, el service empuja `collection_deposit_changed`.
 * Sin token o inválido → desconecta (patrón de PagosComprobantesGateway).
 */
@WebSocketGateway({ namespace: '/cobranza', cors: { origin: '*', credentials: true } })
@Injectable()
export class CobranzaGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(CobranzaGateway.name);

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
    // Los eventos llevan cliente/monto/folio de cobros: se exige el permiso de
    // lectura de la bandeja, no solo un JWT válido del tenant.
    // Incluye el god-mode del RolesGuard (isPlatformAdminRole): el superusuario no
    // lleva los permisos listados y quedaría fuera de su propia bandeja.
    const perms = (payload?.permissions || {}) as Record<string, boolean>;
    const allowed = isPlatformAdminRole(payload?.role_name)
      || perms[Permission.FINANCE_COLLECTIONS_VER] === true
      || perms[Permission.FINANCE_BANK_VER] === true;
    if (!allowed) {
      this.logger.warn(`Reject ${client.id}: ${payload?.username || '?'} sin permiso de lectura de cobranza`);
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

  emitChange(tenantId: string, ev: Omit<CollectionDepositEvent, 'emitted_at'>): void {
    if (!this.server) return;
    const full: CollectionDepositEvent = { ...ev, emitted_at: new Date().toISOString() };
    this.server.to(`tenant:${tenantId}`).emit('collection_deposit_changed', full);
    this.logger.debug(`${ev.action} ${ev.sucursal}/${ev.folio} → tenant:${tenantId}`);
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
