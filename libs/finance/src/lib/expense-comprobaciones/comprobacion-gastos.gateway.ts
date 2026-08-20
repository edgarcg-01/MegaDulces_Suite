import { Injectable, Logger } from '@nestjs/common';
import { WebSocketGateway, WebSocketServer, OnGatewayConnection, OnGatewayDisconnect } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { Permission, isPlatformAdminRole } from '@megadulces/platform-core';

/** Un cambio en una comprobación de gasto (lo dispara una acción de un usuario). */
export interface ComprobacionGastoEvent {
  action: 'captured' | 'validated' | 'rejected' | 'correction_requested';
  sucursal: string | null;
  folio_gasto: string;
  status: string | null;
  proveedor: string | null;
  importe: number | null;
  actor: string | null;
  emitted_at: string;
}

/**
 * GX.8 (Fase 2) — Gateway WS de comprobación de gastos. Path HTTP `/reports/socket.io`
 * (ReportsIoAdapter), namespace `/comprobacion-gastos`. Handshake: JWT en `auth.token`;
 * el socket se une a la room `tenant:<id>`.
 *
 * Por qué existe: cuando un CAPTURISTA sube un comprobante, el AUTORIZADOR debe verlo
 * llegar sin refrescar (toast + recarga). El service empuja `comprobacion_changed` en
 * captura/validación/rechazo/corrección. Exige permiso de lectura de la bandeja (no solo
 * un JWT válido). Sin token o inválido → desconecta (patrón de CobranzaGateway).
 */
@WebSocketGateway({ namespace: '/comprobacion-gastos', cors: { origin: '*', credentials: true } })
@Injectable()
export class ComprobacionGastosGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(ComprobacionGastosGateway.name);

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
    // Solo el autorizador (bandeja de revisión) recibe el aviso. Incluye god-mode.
    const perms = (payload?.permissions || {}) as Record<string, boolean>;
    const allowed = isPlatformAdminRole(payload?.role_name)
      || perms[Permission.FINANCE_EXPENSES_VER] === true
      || perms[Permission.FINANCE_EXPENSES_COMPROBAR] === true;
    if (!allowed) {
      this.logger.warn(`Reject ${client.id}: ${payload?.username || '?'} sin permiso de comprobación de gastos`);
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

  emitChange(tenantId: string, ev: Omit<ComprobacionGastoEvent, 'emitted_at'>): void {
    if (!this.server) return;
    const full: ComprobacionGastoEvent = { ...ev, emitted_at: new Date().toISOString() };
    this.server.to(`tenant:${tenantId}`).emit('comprobacion_changed', full);
    this.logger.debug(`${ev.action} ${ev.folio_gasto} → tenant:${tenantId}`);
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
