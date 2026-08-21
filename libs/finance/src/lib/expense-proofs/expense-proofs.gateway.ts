import { Injectable, Logger } from '@nestjs/common';
import { WebSocketGateway, WebSocketServer, OnGatewayConnection, OnGatewayDisconnect } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { Permission, isPlatformAdminRole } from '@megadulces/platform-core';

/** Un cambio en la solicitud de autorización de gasto (lo dispara la acción de un usuario). */
export interface ExpenseProofEvent {
  action: 'captured' | 'validated' | 'rejected';
  folio_solicitud: string;
  status: string | null;
  solicitante: string | null;
  importe: number | null;
  sucursal: string | null;
  actor: string | null;
  emitted_at: string;
}

/**
 * GX.7 — Gateway WS de solicitudes de gasto. Path HTTP `/reports/socket.io`
 * (ReportsIoAdapter), namespace `/expense-proofs`. Handshake: JWT en `auth.token`;
 * el socket se une a la room `tenant:<id>`.
 *
 * Por qué existe: es la misma necesidad que ya resolvía la comprobación de gastos —
 * el capturista sube el comprobante en una punta y el autorizador tiene que verlo
 * llegar sin refrescar—. Esta mitad del ciclo se había quedado sin el aviso, así que
 * la bandeja de solicitudes envejecía en pantalla sin que nadie lo notara.
 *
 * Exige permiso de lectura de la bandeja, no solo un JWT válido. Sin token o inválido
 * → desconecta. Calca a `ComprobacionGastosGateway`.
 */
@WebSocketGateway({ namespace: '/expense-proofs', cors: { origin: '*', credentials: true } })
@Injectable()
export class ExpenseProofsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(ExpenseProofsGateway.name);

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
    const perms = (payload?.permissions || {}) as Record<string, boolean>;
    const allowed = isPlatformAdminRole(payload?.role_name)
      || perms[Permission.FINANCE_EXPENSES_VER] === true
      || perms[Permission.FINANCE_EXPENSES_COMPROBAR] === true;
    if (!allowed) {
      this.logger.warn(`Reject ${client.id}: ${payload?.username || '?'} sin permiso de solicitudes de gasto`);
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

  emitChange(tenantId: string, ev: Omit<ExpenseProofEvent, 'emitted_at'>): void {
    if (!this.server) return;
    const full: ExpenseProofEvent = { ...ev, emitted_at: new Date().toISOString() };
    this.server.to(`tenant:${tenantId}`).emit('solicitud_changed', full);
    this.logger.debug(`${ev.action} ${ev.folio_solicitud} → tenant:${tenantId}`);
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
