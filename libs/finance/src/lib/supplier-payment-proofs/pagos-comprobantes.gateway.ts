import { Injectable, Logger } from '@nestjs/common';
import { WebSocketGateway, WebSocketServer, OnGatewayConnection, OnGatewayDisconnect } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';

/** Un cambio en un comprobante de pago (lo dispara una acción de un usuario). */
export interface PaymentProofEvent {
  action: 'attached' | 'validated' | 'rejected' | 'bank_matched' | 'bank_unmatched';
  sucursal: string;
  doc_prefix: string | null;
  folio: string;
  status: string | null;        // estado del comprobante tras la acción (recibido/validado/rechazado)
  proveedor: string | null;
  monto: number | null;
  actor: string | null;
  emitted_at: string;
}

/**
 * Fase CC (extensión) — Gateway WS de comprobantes de pago a proveedor. Path HTTP
 * `/reports/socket.io` (ReportsIoAdapter en main.ts), namespace `/pagos-comprobantes`.
 * Handshake: JWT en `auth.token`; el socket se une a la room `tenant:<id>`. Cuando un
 * usuario adjunta / valida / rechaza / concilia un comprobante, el service empuja
 * `payment_proof_changed` a la room → capturista y revisor lo ven al momento sin
 * refrescar. Cliente sin token o inválido → desconecta (patrón de AlertsGateway).
 */
@WebSocketGateway({ namespace: '/pagos-comprobantes', cors: { origin: '*', credentials: true } })
@Injectable()
export class PagosComprobantesGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(PagosComprobantesGateway.name);

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

  emitChange(tenantId: string, ev: Omit<PaymentProofEvent, 'emitted_at'>): void {
    if (!this.server) return;
    const full: PaymentProofEvent = { ...ev, emitted_at: new Date().toISOString() };
    this.server.to(`tenant:${tenantId}`).emit('payment_proof_changed', full);
    this.logger.debug(`${ev.action} ${ev.doc_prefix} ${ev.sucursal}/${ev.folio} → tenant:${tenantId}`);
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
