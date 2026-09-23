import { Injectable, Logger } from '@nestjs/common';
import { WebSocketGateway, WebSocketServer, OnGatewayConnection, OnGatewayDisconnect } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { Permission, isPlatformAdminRole } from '@megadulces/platform-core';

/**
 * Lo que cambió en la caja. **No transporta los movimientos**: dice "andá a buscar" y con qué
 * firma, para que la pantalla sepa si lo que tiene ya está viejo sin traerse la lista de nuevo.
 */
export interface CajaEvent {
  /** `feed` = llegó movimiento de Kepler · `libro` = alguien guardó/confirmó acá. */
  origen: 'feed' | 'libro';
  /** Firma del corte de caja: si no cambió, la pantalla no vuelve a pedir nada. */
  filas: number | null;
  max_folio: string | null;
  max_captura: string | null;
  /** Cuándo se refrescó la fuente (no cuándo se emitió esto). */
  datos_al: string | null;
  emitted_at: string;
}

/**
 * CG.23.2 — Gateway de Caja General. Namespace `/caja`, path HTTP `/reports/socket.io`
 * (el mismo `ReportsIoAdapter` que el resto). Handshake con JWT en `auth.token`; el socket
 * entra a la room `tenant:<id>`.
 *
 * ⚠️ **Gateway propio y no reuso de `BancosGateway`, a propósito.** Aquél exige
 * `FINANCE_BANK_VER` o `FINANCE_AI_CHAT`, y un cajero no tiene ninguno de los dos: para
 * reusarlo habría que ensanchar su compuerta, que se puso justo para tapar que *"CUALQUIER
 * usuario autenticado —un vendedor, un repartidor— podía escucharlo"*. Aflojar una compuerta de
 * seguridad para ahorrarse un archivo es cambiar una deuda barata por una cara.
 *
 * Igual que allá: el permiso sale del **snapshot del JWT**, así que un permiso revocado después
 * del login aplica al reconectar el socket, no al instante.
 */
@WebSocketGateway({ namespace: '/caja', cors: { origin: '*', credentials: true } })
@Injectable()
export class CajaGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(CajaGateway.name);

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
    const allowed = isPlatformAdminRole(payload?.role_name)
      || perms[Permission.FINANCE_CAJA_VER] === true;
    if (!allowed) {
      this.logger.warn(`Reject ${client.id}: ${payload?.username || '?'} sin lectura de Caja General`);
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
  emitChange(tenantId: string, ev: Omit<CajaEvent, 'emitted_at'>): void {
    if (!this.server) return;
    const full: CajaEvent = { ...ev, emitted_at: new Date().toISOString() };
    this.server.to(`tenant:${tenantId}`).emit('caja_changed', full);
  }

  /** Cuántos sockets escuchan ese tenant. Sirve para no hacer trabajo que nadie mira. */
  oyentes(tenantId: string): number {
    return this.tenantSockets.get(tenantId)?.size ?? 0;
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
