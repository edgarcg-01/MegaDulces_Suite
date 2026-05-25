import { Injectable, Logger } from '@nestjs/common';
import { WebSocketGateway, SubscribeMessage, MessageBody, ConnectedSocket, WebSocketServer, OnGatewayConnection, OnGatewayDisconnect } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { getDataScope } from '../../shared/ability/data-scope';

export interface CaptureEventPayload {
  type: 'capture:created' | 'capture:synced' | 'capture:deleted';
  captureId: string;
  userId: string;
  capturedByUsername: string;
  zonaCaptura: string;
  fecha: string;
  stats: any;
  scoreFinalPct?: number;
}

export interface MetricsUpdatePayload {
  type: 'metrics:updated';
  scope: 'own' | 'team' | 'global';
  summary: any;
  dailyScores: any;
}

interface BatchedEvent {
  eventType: 'capture:created' | 'capture:synced' | 'capture:deleted';
  payload: CaptureEventPayload | { type: 'capture:deleted'; captureId: string; userId: string };
}

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

  private userSockets: Map<string, Set<string>> = new Map();
  private userScopes: Map<string, { type: 'own' | 'team' | 'all'; userId: string; username: string }> = new Map();

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
        client.disconnect(true);
        return;
      }

      const payload = this.jwtService.verify(token);
      const user = {
        sub: payload.sub,
        username: payload.username,
        role_name: payload.role_name,
        permissions: payload.permissions || {},
        rules: payload.rules || [],
      };

      (client as any).user = user;

      const scope = getDataScope(user);
      const rooms = this.getRoomsForScope(scope, user);

      rooms.forEach((room) => client.join(room));

      if (!this.userSockets.has(user.sub)) {
        this.userSockets.set(user.sub, new Set());
      }
      this.userSockets.get(user.sub)!.add(client.id);

      this.userScopes.set(user.sub, {
        type: scope.type,
        userId: user.sub,
        username: user.username,
      });

      this.logger.log(`Client connected: ${user.username} (${user.sub}) scope=${scope.type} rooms=${rooms.join(',')}`);
    } catch (error) {
      this.logger.warn(`Connection rejected: invalid token (${error.message})`);
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket) {
    const user = (client as any).user;
    if (user) {
      const sockets = this.userSockets.get(user.sub);
      if (sockets) {
        sockets.delete(client.id);
        if (sockets.size === 0) {
          this.userSockets.delete(user.sub);
          this.userScopes.delete(user.sub);
        }
      }
    }
  }

  @SubscribeMessage('join')
  handleJoin(@ConnectedSocket() client: Socket, @MessageBody() room: string) {
    // Solo permitir unirse a rooms para los que el usuario tiene scope.
    // Sin esta validación cualquier cliente podría suscribirse a `reports:global`
    // y recibir métricas de toda la organización.
    const user = (client as any).user;
    if (!user || !this.canJoinRoom(user, room)) {
      this.logger.warn(`Join rejected: user ${user?.username ?? '?'} → room ${room}`);
      return;
    }
    client.join(room);
  }

  @SubscribeMessage('leave')
  handleLeave(@ConnectedSocket() client: Socket, @MessageBody() room: string) {
    client.leave(room);
  }

  /**
   * Decide qué rooms se asignan automáticamente al usuario al conectar.
   * - `reports:global` SOLO si el scope es 'all' (REPORTES_VER_GLOBAL).
   * - `reports:team:<sub>` solo si el scope es 'team' (supervisor).
   * - `reports:own:<sub>` para todos los usuarios autenticados.
   */
  private getRoomsForScope(scope: { type: string; userId: string }, user: any): string[] {
    const rooms: string[] = [`reports:own:${user.sub}`];

    if (scope.type === 'team') {
      rooms.push(`reports:team:${user.sub}`);
    }

    if (scope.type === 'all') {
      rooms.push('reports:global');
    }

    return rooms;
  }

  /**
   * Valida si un usuario puede unirse a un room arbitrario vía `join` event.
   * Solo se aceptan rooms que el usuario tendría asignados automáticamente.
   */
  private canJoinRoom(user: { sub: string; rules?: any[] }, room: string): boolean {
    const scope = getDataScope(user);
    const allowed = this.getRoomsForScope(scope, user);
    return allowed.includes(room);
  }

  getConnectedUserScopes(): Array<{ type: 'own' | 'team' | 'all'; userId: string }> {
    return Array.from(this.userScopes.values());
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

  getConnectedUserScopes(): Array<{ type: 'own' | 'team' | 'all'; userId: string }> {
    return this.gateway.getConnectedUserScopes();
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

    // Los eventos de captura se emiten SOLO a:
    //  - `reports:global` (admins con scope 'all')
    //  - `reports:own:<userId>` (el capturista dueño)
    // NUNCA con server.emit (que iría a todo el namespace y leakearía
    // actividad de un colaborador a todos los demás colaboradores).
    const emitToScoped = (
      eventName: 'capture:created' | 'capture:synced' | 'capture:deleted',
      list: BatchedEvent[],
    ) => {
      if (list.length === 0) return;

      if (list.length === 1) {
        const p = list[0].payload as any;
        this.gateway.server.to('reports:global').emit(eventName, p);
        if (p?.userId) {
          this.gateway.server.to(`reports:own:${p.userId}`).emit(eventName, p);
        }
      } else {
        const batchPayload = {
          type: eventName,
          batch: true,
          count: list.length,
          events: list.map((e) => e.payload),
        };
        // Globals reciben el batch completo
        this.gateway.server.to('reports:global').emit(eventName, batchPayload);
        // Cada owner solo recibe los eventos propios
        const byOwner = new Map<string, any[]>();
        for (const ev of list) {
          const ownerId = (ev.payload as any)?.userId;
          if (!ownerId) continue;
          if (!byOwner.has(ownerId)) byOwner.set(ownerId, []);
          byOwner.get(ownerId)!.push(ev.payload);
        }
        for (const [ownerId, ownEvents] of byOwner) {
          this.gateway.server
            .to(`reports:own:${ownerId}`)
            .emit(eventName, { type: eventName, batch: true, count: ownEvents.length, events: ownEvents });
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

  emitCaptureDeleted(payload: { type: 'capture:deleted'; captureId: string; userId: string }): void {
    if (!this.hasConnectedClients()) return;

    this.batchBuffer.push({ eventType: 'capture:deleted', payload });
    this.scheduleBatchFlush();
  }

  emitMetricsUpdate(payload: MetricsUpdatePayload): void {
    if (!this.hasConnectedClients()) return;
    if (!this.gateway.server) return;

    // Solo emitir a quienes tienen el scope correspondiente — antes era
    // `server.emit(...)` que iba a todo el namespace.
    const room =
      payload.scope === 'global'
        ? 'reports:global'
        : payload.scope === 'team'
          ? null // los emits por team van por emitMetricsUpdateToRoom con userId
          : null;
    if (!room) {
      this.logger.warn(`emitMetricsUpdate sin room para scope=${payload.scope}; ignorado`);
      return;
    }
    this.gateway.server.to(room).emit('metrics:updated', payload);
    this.logger.debug(`Emitted metrics:updated to ${room} with scope ${payload.scope}`);
  }

  emitMetricsUpdateToRoom(room: string, payload: MetricsUpdatePayload): void {
    if (!this.hasConnectedClients()) return;
    if (!this.gateway.server) return;

    this.gateway.server.to(room).emit('metrics:updated', payload);

    this.logger.debug(`Emitted metrics:updated to room ${room} with scope ${payload.scope}`);
  }
}