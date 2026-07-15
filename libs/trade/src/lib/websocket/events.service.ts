import { Injectable, Logger } from '@nestjs/common';
import { WebSocketGateway, SubscribeMessage, MessageBody, ConnectedSocket, WebSocketServer, OnGatewayConnection, OnGatewayDisconnect } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { getDataScope } from '@megadulces/platform-core';

export interface CaptureEventPayload {
  type: 'capture:created' | 'capture:synced' | 'capture:deleted';
  captureId: string;
  userId: string;
  /**
   * tenant_id snapshot del JWT del usuario que generó el evento. CRÍTICO
   * para multi-tenant: las rooms WS se prefijan con tenant para que un
   * admin con `scope='all'` SOLO reciba eventos de su propio tenant.
   */
  tenantId: string;
  capturedByUsername: string;
  zonaCaptura: string;
  fecha: string;
  stats: any;
  scoreFinalPct?: number;
}

export interface CaptureDeletedPayload {
  type: 'capture:deleted';
  captureId: string;
  userId: string;
  tenantId: string;
}

export interface MetricsUpdatePayload {
  type: 'metrics:updated';
  scope: 'own' | 'team' | 'global';
  summary: any;
  dailyScores: any;
}

interface BatchedEvent {
  eventType: 'capture:created' | 'capture:synced' | 'capture:deleted';
  payload: CaptureEventPayload | CaptureDeletedPayload;
}

/** Alerta de campo (detenido demasiado / sin señal) para el cockpit en vivo. */
export interface FieldAlertPayload {
  type: 'idle' | 'offline';
  tenantId: string;
  userId: string;
  supervisorId?: string;
  username: string;
  minutes: number;
  lat?: number;
  lng?: number;
  at: string;
}

/** Última posición de un usuario de campo, reemitida en vivo a supervisores. */
export interface LivePingPayload {
  type: 'route_ping';
  tenantId: string;
  userId: string;
  username?: string;
  routeId?: string | null;
  lat: number;
  lng: number;
  capturedAt: string;
  speedMps?: number | null;
  accuracyM?: number | null;
  source?: string;
}

/** Builders centralizados para los nombres de rooms (single source of truth). */
export const reportsRooms = {
  own: (tenantId: string, userId: string) => `reports:t:${tenantId}:own:${userId}`,
  team: (tenantId: string, userId: string) => `reports:t:${tenantId}:team:${userId}`,
  global: (tenantId: string) => `reports:t:${tenantId}:global`,
};

@WebSocketGateway({
  namespace: '/reports',
  cors: {
    origin: '*',
    credentials: true,
  },
})
@Injectable()
export class ReportsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(ReportsGateway.name);

  @WebSocketServer()
  server: Server;

  /**
   * Snapshot por socket conectado. Keyed por `socket.id` (no por `user.sub`)
   * para evitar el leak de stale-reconnect: cuando un usuario se reconecta
   * con un id nuevo antes del disconnect del viejo, el id viejo se queda en
   * el map del Map<userSub, Set<socketId>> y nunca se libera. Llevamos un
   * snapshot por socket y derivamos los stats per-user de ahí.
   */
  private sessions: Map<
    string,
    {
      sub: string;
      username: string;
      tenantId: string;
      scope: 'own' | 'team' | 'all';
    }
  > = new Map();

  constructor(private readonly jwtService: JwtService) {}

  get connectedClientCount(): number {
    if (!this.server) return 0;
    try {
      const sockets = this.server.sockets;
      return sockets instanceof Map ? sockets.size : Object.keys(sockets).length;
    } catch {
      return 0;
    }
  }

  async handleConnection(client: Socket) {
    try {
      const token = client.handshake.auth?.token || client.handshake.query?.token;

      if (!token) {
        this.logger.warn('Connection rejected: no token');
        client.emit('auth_error', { reason: 'no_token' });
        client.disconnect(true);
        return;
      }

      const payload = this.jwtService.verify(token);

      // tenant_id es OBLIGATORIO desde el cutover multi-tenant. Sin él no
      // podemos prefixar rooms y un admin con scope='all' vería capturas
      // de otros tenants.
      if (!payload.tenant_id) {
        this.logger.warn(`Connection rejected: JWT sin tenant_id (sub=${payload.sub})`);
        client.emit('auth_error', { reason: 'missing_tenant' });
        client.disconnect(true);
        return;
      }

      const user = {
        sub: payload.sub,
        username: payload.username,
        role_name: payload.role_name,
        tenant_id: payload.tenant_id,
        permissions: payload.permissions || {},
        rules: payload.rules || [],
      };

      (client as any).user = user;

      const scope = getDataScope(user);
      const rooms = this.getRoomsForScope(scope, user);

      rooms.forEach((room) => client.join(room));

      this.sessions.set(client.id, {
        sub: user.sub,
        username: user.username,
        tenantId: user.tenant_id,
        scope: scope.type,
      });

      this.logger.log(
        `Client connected: ${user.username} (${user.sub}) tenant=${user.tenant_id} scope=${scope.type} rooms=${rooms.join(',')}`,
      );
    } catch (error) {
      this.logger.warn(`Connection rejected: invalid token (${error.message})`);
      client.emit('auth_error', { reason: 'invalid_token' });
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket) {
    this.sessions.delete(client.id);
  }

  // ── Live tracking: registro de "observados" on-demand ──────────────────
  // Cuando un supervisor abre el mapa y observa a un usuario, marcamos a ese
  // user como watched por un TTL. El device lo descubre en la RESPUESTA de su
  // POST /reports/route-pings (piggyback, sin socket en el device) y sube su
  // cadencia. Sin nadie observando, los devices bajan solos a modo económico.
  private static readonly WATCH_TTL_MS = 120_000;
  private readonly watched = new Map<string, number>(); // `${tenant}:${userId}` → expiresAt

  /** Segundos restantes de observación para un usuario (0 = nadie observa). */
  watchRemainingSec(tenantId: string, userId: string): number {
    const exp = this.watched.get(`${tenantId}:${userId}`);
    if (!exp) return 0;
    const ms = exp - Date.now();
    if (ms <= 0) { this.watched.delete(`${tenantId}:${userId}`); return 0; }
    return Math.ceil(ms / 1000);
  }

  @SubscribeMessage('tracking:watch')
  handleTrackingWatch(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: unknown,
  ): { ok: boolean } {
    const user = (client as any).user;
    if (!user?.tenant_id) return { ok: false };
    // Solo supervisores/admin (scope team|all) pueden observar a otros.
    const scope = getDataScope(user);
    if (scope.type === 'own') return { ok: false };
    const ids = (body as any)?.userIds;
    if (!Array.isArray(ids)) return { ok: false };
    const exp = Date.now() + ReportsGateway.WATCH_TTL_MS;
    for (const id of ids) {
      if (typeof id === 'string' && id.length > 0 && id.length <= 64) {
        this.watched.set(`${user.tenant_id}:${id}`, exp);
      }
    }
    // Limpieza oportunista de expirados para que el Map no crezca sin fin.
    if (this.watched.size > 500) {
      const now = Date.now();
      for (const [k, e] of this.watched) if (e <= now) this.watched.delete(k);
    }
    return { ok: true };
  }

  @SubscribeMessage('join')
  handleJoin(@ConnectedSocket() client: Socket, @MessageBody() room: unknown) {
    // Validación de tipo: el body llega via socket.io, podría ser cualquier cosa.
    if (typeof room !== 'string' || room.length === 0 || room.length > 200) {
      return { ok: false, reason: 'invalid_room' };
    }
    const user = (client as any).user;
    if (!user || !this.canJoinRoom(user, room)) {
      this.logger.warn(`Join rejected: user ${user?.username ?? '?'} → room ${room}`);
      return { ok: false, reason: 'forbidden' };
    }
    client.join(room);
    return { ok: true };
  }

  @SubscribeMessage('leave')
  handleLeave(@ConnectedSocket() client: Socket, @MessageBody() room: unknown) {
    if (typeof room !== 'string' || room.length === 0 || room.length > 200) {
      return { ok: false, reason: 'invalid_room' };
    }
    client.leave(room);
    return { ok: true };
  }

  /**
   * Decide qué rooms se asignan automáticamente al usuario al conectar.
   * Todas prefijadas con `reports:t:<tenantId>:` para aislamiento multi-tenant.
   * - `reports:t:<tenant>:global` SOLO si scope='all' (REPORTES_VER_GLOBAL).
   * - `reports:t:<tenant>:team:<sub>` solo si scope='team' (supervisor).
   * - `reports:t:<tenant>:own:<sub>` para todos los usuarios autenticados.
   */
  private getRoomsForScope(scope: { type: string }, user: { sub: string; tenant_id: string }): string[] {
    const rooms: string[] = [reportsRooms.own(user.tenant_id, user.sub)];

    if (scope.type === 'team') {
      rooms.push(reportsRooms.team(user.tenant_id, user.sub));
    }

    if (scope.type === 'all') {
      rooms.push(reportsRooms.global(user.tenant_id));
    }

    return rooms;
  }

  /**
   * Valida si un usuario puede unirse a un room arbitrario vía `join` event.
   * El nombre del room DEBE incluir el tenant del usuario — no se aceptan
   * rooms de otro tenant aunque coincidan el formato.
   */
  private canJoinRoom(user: { sub: string; tenant_id: string; rules?: any[] }, room: string): boolean {
    const scope = getDataScope(user);
    const allowed = this.getRoomsForScope(scope, user);
    return allowed.includes(room);
  }

  /**
   * Devuelve un snapshot dedup por (tenantId, type, userId) de las sesiones
   * activas. Lo usa `ReportsService.runMetricsBroadcast` para iterar y emitir
   * métricas per-tenant + per-scope.
   */
  getConnectedUserScopes(): Array<{
    type: 'own' | 'team' | 'all';
    userId: string;
    tenantId: string;
    username: string;
  }> {
    const dedup = new Map<
      string,
      { type: 'own' | 'team' | 'all'; userId: string; tenantId: string; username: string }
    >();
    for (const s of this.sessions.values()) {
      const key = `${s.tenantId}:${s.scope}:${s.sub}`;
      if (dedup.has(key)) continue;
      dedup.set(key, {
        type: s.scope,
        userId: s.sub,
        tenantId: s.tenantId,
        username: s.username,
      });
    }
    return Array.from(dedup.values());
  }
}

@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);
  private batchBuffer: BatchedEvent[] = [];
  private batchTimer: NodeJS.Timeout | null = null;
  private readonly BATCH_DELAY_MS = 2000;

  onCaptureChange: ((affectedUserIds: string[]) => Promise<void>) | null = null;

  constructor(private readonly gateway: ReportsGateway) {}

  get isServerReady(): boolean {
    return !!this.gateway.server;
  }

  getConnectedUserScopes(): Array<{
    type: 'own' | 'team' | 'all';
    userId: string;
    tenantId: string;
    username: string;
  }> {
    return this.gateway.getConnectedUserScopes();
  }

  /** Segundos restantes de observación on-demand para un usuario (0 = nadie). */
  watchRemainingSec(tenantId: string, userId: string): number {
    return this.gateway.watchRemainingSec(tenantId, userId);
  }

  private hasConnectedClients(): boolean {
    return this.gateway.connectedClientCount > 0;
  }

  private scheduleBatchFlush(): void {
    if (this.batchTimer) return;

    this.batchTimer = setTimeout(() => {
      this.flushBatch();
    }, this.BATCH_DELAY_MS);
  }

  private async flushBatch(): Promise<void> {
    this.batchTimer = null;

    if (this.batchBuffer.length === 0) return;

    const events = [...this.batchBuffer];
    this.batchBuffer = [];

    if (!this.gateway.server) return;

    const created = events.filter(e => e.eventType === 'capture:created');
    const synced = events.filter(e => e.eventType === 'capture:synced');
    const deleted = events.filter(e => e.eventType === 'capture:deleted');

    // Multi-tenant: los eventos van SOLO a rooms scoped por tenant del payload.
    //  - `reports:t:<tenant>:global` (admins scope='all' DE ESE tenant)
    //  - `reports:t:<tenant>:own:<userId>` (el capturista dueño)
    // Nunca cross-tenant: un evento con tenantId=A jamás llega a sockets de tenant B.
    const emitToScoped = (
      eventName: 'capture:created' | 'capture:synced' | 'capture:deleted',
      list: BatchedEvent[],
    ) => {
      if (list.length === 0) return;

      // Agrupar por tenantId para emitir a las rooms de cada tenant por separado.
      const byTenant = new Map<string, BatchedEvent[]>();
      for (const ev of list) {
        const tenantId = (ev.payload as any)?.tenantId;
        if (!tenantId) {
          this.logger.warn(
            `Dropping ${eventName} sin tenantId — posible bug en el caller (captureId=${(ev.payload as any)?.captureId})`,
          );
          continue;
        }
        if (!byTenant.has(tenantId)) byTenant.set(tenantId, []);
        byTenant.get(tenantId)!.push(ev);
      }

      for (const [tenantId, tenantEvents] of byTenant) {
        const globalRoom = reportsRooms.global(tenantId);

        if (tenantEvents.length === 1) {
          const p = tenantEvents[0].payload as any;
          this.gateway.server.to(globalRoom).emit(eventName, p);
          if (p?.userId) {
            this.gateway.server.to(reportsRooms.own(tenantId, p.userId)).emit(eventName, p);
          }
        } else {
          const batchPayload = {
            type: eventName,
            batch: true,
            count: tenantEvents.length,
            events: tenantEvents.map((e) => e.payload),
          };
          this.gateway.server.to(globalRoom).emit(eventName, batchPayload);
          const byOwner = new Map<string, any[]>();
          for (const ev of tenantEvents) {
            const ownerId = (ev.payload as any)?.userId;
            if (!ownerId) continue;
            if (!byOwner.has(ownerId)) byOwner.set(ownerId, []);
            byOwner.get(ownerId)!.push(ev.payload);
          }
          for (const [ownerId, ownEvents] of byOwner) {
            this.gateway.server
              .to(reportsRooms.own(tenantId, ownerId))
              .emit(eventName, {
                type: eventName,
                batch: true,
                count: ownEvents.length,
                events: ownEvents,
              });
          }
        }
      }
    };

    emitToScoped('capture:created', created);
    emitToScoped('capture:synced', synced);
    emitToScoped('capture:deleted', deleted);

    const totalEvents = events.length;
    this.logger.log(`Flushed batch: ${created.length} created, ${synced.length} synced, ${deleted.length} deleted (${totalEvents} total)`);

    if (this.onCaptureChange) {
      const affectedUserIds = Array.from(
        new Set(
          events
            .map((e) => (e.payload as any)?.userId)
            .filter((u): u is string => typeof u === 'string' && u.length > 0),
        ),
      );
      await this.onCaptureChange(affectedUserIds);
    }
  }

  emitCaptureCreated(payload: CaptureEventPayload): void {
    if (!this.hasConnectedClients()) return;

    this.batchBuffer.push({ eventType: 'capture:created', payload });
    this.scheduleBatchFlush();
  }

  emitCaptureSynced(payload: CaptureEventPayload): void {
    if (!this.hasConnectedClients()) return;

    this.batchBuffer.push({ eventType: 'capture:synced', payload });
    this.scheduleBatchFlush();
  }

  emitCaptureDeleted(payload: CaptureDeletedPayload): void {
    if (!this.hasConnectedClients()) return;

    this.batchBuffer.push({ eventType: 'capture:deleted', payload });
    this.scheduleBatchFlush();
  }

  /**
   * Emite métricas a la room global de UN tenant (admins scope='all' de ese tenant).
   * Multi-tenant: el tenantId del caller delimita estrictamente la audiencia.
   */
  emitMetricsToGlobal(tenantId: string, payload: MetricsUpdatePayload): void {
    if (!this.hasConnectedClients()) return;
    if (!this.gateway.server) return;
    const room = reportsRooms.global(tenantId);
    this.gateway.server.to(room).emit('metrics:updated', payload);
    this.logger.debug(`Emitted metrics:updated to ${room}`);
  }

  /**
   * Emite métricas a un usuario específico (scope='own' o 'team') dentro de
   * SU tenant. La combinación (tenantId, scope, userId) determina la room.
   */
  emitMetricsToUser(
    tenantId: string,
    scope: 'own' | 'team',
    userId: string,
    payload: MetricsUpdatePayload,
  ): void {
    if (!this.hasConnectedClients()) return;
    if (!this.gateway.server) return;
    const room = scope === 'team'
      ? reportsRooms.team(tenantId, userId)
      : reportsRooms.own(tenantId, userId);
    this.gateway.server.to(room).emit('metrics:updated', payload);
    this.logger.debug(`Emitted metrics:updated to ${room}`);
  }

  // ── Live tracking ──────────────────────────────────────────────────────
  // Reemite la última posición de un usuario de campo a los supervisores del
  // tenant (room global) + al propio usuario. Coalescing por usuario: a lo más
  // 1 emisión cada PING_EMIT_THROTTLE_MS, conservando SIEMPRE la última posición
  // (trailing) para no perder el fix más reciente. Protege el WS sin atrasar el
  // mapa más que el throttle.
  private readonly PING_EMIT_THROTTLE_MS = 4000;
  private readonly pingThrottle = new Map<
    string,
    { lastEmit: number; timer: NodeJS.Timeout | null; pending: LivePingPayload | null }
  >();

  /** Alerta de campo a supervisores: room global (scope all) + equipo del supervisor. */
  emitFieldAlert(payload: FieldAlertPayload): void {
    if (!payload?.tenantId || !this.gateway.server) return;
    this.gateway.server.to(reportsRooms.global(payload.tenantId)).emit('field_alert', payload);
    if (payload.supervisorId)
      this.gateway.server.to(reportsRooms.team(payload.tenantId, payload.supervisorId)).emit('field_alert', payload);
  }

  /**
   * HIQ.5 — Nudge de Horus al COLABORADOR: cuando el supervisor aprueba un coaching
   * o una tarea, el vendedor recibe el aviso EN VIVO en su room propia (la app de
   * vendedor escucha `horus:nudge`). Best-effort: el pull (`/supervisor-ai/field/*`)
   * es la vía durable; esto solo adelanta el aviso si está conectado.
   */
  emitFieldNudge(payload: {
    tenantId: string;
    userId: string;
    kind: 'coaching' | 'task';
    title: string;
    refId?: string | null;
  }): boolean {
    if (!payload?.tenantId || !payload?.userId || !this.gateway.server) return false;
    this.gateway.server
      .to(reportsRooms.own(payload.tenantId, payload.userId))
      .emit('horus:nudge', { ...payload, at: new Date().toISOString() });
    return true;
  }

  emitRoutePing(payload: LivePingPayload): void {
    if (!payload?.tenantId || !payload?.userId) return;
    if (!this.gateway.server) return;
    if (!this.hasConnectedClients()) return;

    const key = `${payload.tenantId}:${payload.userId}`;
    const now = Date.now();
    const state = this.pingThrottle.get(key) ?? { lastEmit: 0, timer: null, pending: null };

    const flush = (p: LivePingPayload) => {
      const s = this.pingThrottle.get(key);
      if (s) { s.lastEmit = Date.now(); s.pending = null; s.timer = null; }
      this.gateway.server.to(reportsRooms.global(p.tenantId)).emit('route_ping', p);
      this.gateway.server.to(reportsRooms.own(p.tenantId, p.userId)).emit('route_ping', p);
    };

    const elapsed = now - state.lastEmit;
    if (elapsed >= this.PING_EMIT_THROTTLE_MS && !state.timer) {
      this.pingThrottle.set(key, { ...state, pending: null });
      flush(payload);
      return;
    }
    // Dentro de la ventana: guardar como pendiente y programar trailing flush.
    state.pending = payload;
    if (!state.timer) {
      state.timer = setTimeout(
        () => { const s = this.pingThrottle.get(key); if (s?.pending) flush(s.pending); },
        Math.max(0, this.PING_EMIT_THROTTLE_MS - elapsed),
      );
    }
    this.pingThrottle.set(key, state);
  }
}