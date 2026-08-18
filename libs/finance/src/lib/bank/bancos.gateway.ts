import { Injectable, Logger } from '@nestjs/common';
import { WebSocketGateway, WebSocketServer, OnGatewayConnection, OnGatewayDisconnect } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';

/** Un cambio en el tablero de Bancos (import, sync del Sheet, conciliación o comprobante). */
export interface BancosEvent {
  action:
    | 'imported'            // se importó/actualizó un estado de cuenta (upload web o feed)
    | 'sheet_synced'        // se sincronizó el workbook maestro (Google Sheet: cron o botón)
    | 'matched'             // se corrió la conciliación banco ↔ Kepler
    | 'capture_new'         // llegó un comprobante de depósito (WhatsApp / web)
    | 'capture_validated'   // se validó un comprobante → ingreso nuevo en el libro
    | 'capture_rejected';   // se rechazó un comprobante
  period: string | null;   // YYYY-MM afectado (null = no aplica)
  detail: string | null;   // texto corto para el toast
  count: number | null;    // métrica opcional (movs importados, retiros casados, etc.)
  actor: string | null;    // quién lo disparó ('sheet-sync' = cron, null = sistema)
  emitted_at: string;
}

/**
 * Fase CB (WS) — Gateway de Bancos. Path HTTP `/reports/socket.io` (ReportsIoAdapter
 * en main.ts), namespace `/bancos`. Handshake: JWT en `auth.token`; el socket se une
 * a la room `tenant:<id>`. Cuando el feed importa un estado de cuenta, el cron sincroniza
 * el Sheet, se corre la conciliación o entra/valida/rechaza un comprobante, el service
 * empuja `bancos_changed` a la room → /finanzas/bancos se refresca solo sin recargar.
 * Sin token o inválido → desconecta (patrón AlertsGateway / PagosComprobantesGateway).
 */
@WebSocketGateway({ namespace: '/bancos', cors: { origin: '*', credentials: true } })
@Injectable()
export class BancosGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(BancosGateway.name);

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

  /** Empuja un cambio de Bancos a la room del tenant (best-effort; nunca bloquea). */
  emitChange(tenantId: string, ev: Omit<BancosEvent, 'emitted_at'>): void {
    if (!this.server) return;
    const full: BancosEvent = { ...ev, emitted_at: new Date().toISOString() };
    this.server.to(`tenant:${tenantId}`).emit('bancos_changed', full);
    this.logger.debug(`${ev.action} ${ev.period ?? ''} → tenant:${tenantId}`);
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
