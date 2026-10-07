import { Injectable, Logger } from '@nestjs/common';
import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { Alert } from './alerts.types';

/**
 * Gateway WS para alertas commerciales.
 *
 * Path HTTP: `/reports/socket.io` (configurado en main.ts ReportsIoAdapter).
 * Namespace: `/alerts`.
 *
 * Connection flow:
 *   1. Client conecta con `auth: { token: <JWT> }` en io({}).
 *   2. Gateway extrae JWT, verifica, lee `tenant_id` del payload.
 *   3. Socket se une a room `tenant:<tenant_id>` automáticamente.
 *   4. Server emite con `server.to('tenant:'+id).emit('alert', payload)`.
 *
 * Cliente sin auth o con JWT inválido se desconecta inmediatamente (1008).
 */
@WebSocketGateway({
  namespace: '/alerts',
  cors: { origin: '*', credentials: true },
})
@Injectable()
export class AlertsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(AlertsGateway.name);

  @WebSocketServer()
  server: Server;

  // tenant_id → set de socketIds conectados (debugging + métrica)
  private tenantSockets: Map<string, Set<string>> = new Map();

  constructor(private readonly jwtService: JwtService) {}

  async handleConnection(client: Socket): Promise<void> {
    const token = this.extractToken(client);
    if (!token) {
      this.logger.warn(`Reject ${client.id}: sin Bearer token`);
      client.emit('auth_error', { reason: 'missing_token' });
      client.disconnect(true);
      return;
    }

    let payload: any;
    try {
      payload = this.jwtService.verify(token);
    } catch (e: any) {
      this.logger.warn(`Reject ${client.id}: JWT inválido (${e.message})`);
      client.emit('auth_error', { reason: 'invalid_token' });
      client.disconnect(true);
      return;
    }

    const tenantId = payload?.tenant_id;
    if (!tenantId) {
      this.logger.warn(`Reject ${client.id}: sin tenant_id en payload`);
      client.emit('auth_error', { reason: 'no_tenant_in_token' });
      client.disconnect(true);
      return;
    }

    const room = `tenant:${tenantId}`;
    client.join(room);
    /**
     * `[GX.26]` Y su cuarto PROPIO. Hasta aca toda alerta iba a todo el tenant, que
     * sirve para «se cayo un feed» y no sirve para «TU vale fue rechazado»: eso es de
     * una persona, y mandarselo a los 166 es ruido para 165 y una fuga para el dueño.
     *
     * ⚠️ La llave es el USERNAME porque es lo que el token trae -- `full_name` NO esta
     * en el JWT (verificado decodificando uno). Y da la casualidad de que es tambien lo
     * que termina en `expense_proofs.created_by`, que hace `full_name || username`.
     * Si algun dia el token llevara `full_name`, esos dos valores se separarian y los
     * avisos dejarian de llegar EN SILENCIO: por eso se unen los dos cuartos.
     */
    const personales = [payload.username, payload.full_name].filter(Boolean) as string[];
    for (const quien of personales) client.join(`u:${tenantId}:${quien}`);
    client.data = {
      tenantId,
      userId: payload.sub,
      username: payload.username,
      roleName: payload.role_name,
    };

    if (!this.tenantSockets.has(tenantId)) this.tenantSockets.set(tenantId, new Set());
    this.tenantSockets.get(tenantId)!.add(client.id);

    this.logger.log(
      `Connected ${client.id} → tenant=${tenantId} user=${payload.username} (room=${room})`,
    );
    client.emit('connected', { tenant_id: tenantId, room });
  }

  handleDisconnect(client: Socket): void {
    const tenantId = client.data?.tenantId;
    if (tenantId) {
      this.tenantSockets.get(tenantId)?.delete(client.id);
      this.logger.debug(`Disconnect ${client.id} (tenant=${tenantId})`);
    }
  }

  /**
   * Emite un alert a TODOS los clientes del tenant. Usado por AlertsService.
   */
  emitToTenant(tenantId: string, alert: Alert): void {
    const room = `tenant:${tenantId}`;
    if (!this.server) {
      this.logger.warn(`emitToTenant skipped: server no inicializado todavía`);
      return;
    }
    this.server.to(room).emit('alert', alert);
    this.logger.debug(
      `Emitted ${alert.type} (${alert.severity}) to ${room} (clients=${this.tenantSockets.get(tenantId)?.size || 0})`,
    );
  }

  /**
   * `[GX.26]` Emite a UNA persona del tenant. Si no hay nadie conectado con ese nombre
   * el mensaje se pierde, y eso es correcto: es un aviso en vivo, no una bandeja. Lo que
   * quedo registrado es el estado del expediente, que la persona ve en su historial.
   */
  emitToUser(tenantId: string, quien: string, alert: Alert): void {
    if (!this.server || !quien) {
      this.logger.warn(`emitToUser skipped: ${!this.server ? "server no inicializado" : "sin destinatario"}`);
      return;
    }
    const room = `u:${tenantId}:${quien}`;
    this.server.to(room).emit('alert', alert);
    this.logger.debug(`Emitted ${alert.type} (${alert.severity}) to ${room}`);
  }

  /** Métricas para health/ops. */
  getStats() {
    const stats: Record<string, number> = {};
    for (const [tenantId, sockets] of this.tenantSockets) {
      stats[tenantId] = sockets.size;
    }
    return { tenants: stats, total_sockets: Array.from(this.tenantSockets.values()).reduce((s, x) => s + x.size, 0) };
  }

  private extractToken(client: Socket): string | null {
    // Preferred: auth payload (io({auth:{token}}))
    const fromAuth = client.handshake?.auth?.token;
    if (typeof fromAuth === 'string' && fromAuth.length > 10) return fromAuth;
    // Fallback: Authorization header
    const authHeader = client.handshake?.headers?.authorization;
    if (typeof authHeader === 'string') {
      const [scheme, token] = authHeader.split(' ');
      if (scheme === 'Bearer' && token) return token;
    }
    // Fallback: query param ?token=...
    const fromQuery = client.handshake?.query?.token;
    if (typeof fromQuery === 'string' && fromQuery.length > 10) return fromQuery;
    return null;
  }
}
