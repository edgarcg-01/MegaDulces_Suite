import { Injectable, forwardRef, Inject } from '@nestjs/common';
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
        console.warn('[WS] Connection rejected: no token');
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

      console.log(`[WS] Client connected: ${user.username} (${user.sub}), scope: ${scope.type}, rooms: ${rooms.join(', ')}`);
    } catch (error) {
      console.warn('[WS] Connection rejected: invalid token', error.message);
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
    client.join(room);
  }

  @SubscribeMessage('leave')
  handleLeave(@ConnectedSocket() client: Socket, @MessageBody() room: string) {
    client.leave(room);
  }

  private getRoomsForScope(scope: { type: string; userId: string }, user: any): string[] {
    const rooms = ['reports:global'];

    if (scope.type === 'own' || scope.type === 'team') {
      rooms.push(`reports:own:${user.sub}`);
    }

    if (scope.type === 'team') {
      rooms.push(`reports:team:${user.sub}`);
    }

    return rooms;
  }

  getConnectedUserScopes(): Array<{ type: 'own' | 'team' | 'all'; userId: string }> {
    return Array.from(this.userScopes.values());
  }
}

@Injectable()
export class EventsService {
  private batchBuffer: BatchedEvent[] = [];
  private batchTimer: NodeJS.Timeout | null = null;
  private readonly BATCH_DELAY_MS = 2000;

  onCaptureChange: (() => Promise<void>) | null = null;

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

    if (created.length > 0) {
      if (created.length === 1) {
        this.gateway.server.emit('capture:created', created[0].payload);
        const p = created[0].payload as CaptureEventPayload;
        this.gateway.server.to(`reports:own:${p.userId}`).emit('capture:created', p);
      } else {
        this.gateway.server.emit('capture:created', {
          type: 'capture:created',
          batch: true,
          count: created.length,
          events: created.map(e => e.payload),
        });
      }
    }

    if (synced.length > 0) {
      if (synced.length === 1) {
        this.gateway.server.emit('capture:synced', synced[0].payload);
        const p = synced[0].payload as CaptureEventPayload;
        this.gateway.server.to(`reports:own:${p.userId}`).emit('capture:synced', p);
      } else {
        this.gateway.server.emit('capture:synced', {
          type: 'capture:synced',
          batch: true,
          count: synced.length,
          events: synced.map(e => e.payload),
        });
      }
    }

    if (deleted.length > 0) {
      if (deleted.length === 1) {
        this.gateway.server.emit('capture:deleted', deleted[0].payload);
        const p = deleted[0].payload as CaptureEventPayload;
        this.gateway.server.to(`reports:own:${p.userId}`).emit('capture:deleted', p);
      } else {
        this.gateway.server.emit('capture:deleted', {
          type: 'capture:deleted',
          batch: true,
          count: deleted.length,
          events: deleted.map(e => e.payload),
        });
      }
    }

    const totalEvents = events.length;
    console.log(`[WS] Flushed batch: ${created.length} created, ${synced.length} synced, ${deleted.length} deleted (${totalEvents} total)`);

    if (this.onCaptureChange) {
      await this.onCaptureChange();
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

    this.gateway.server.emit('metrics:updated', payload);

    console.log(`[WS] Emitted metrics:updated with scope ${payload.scope}`);
  }

  emitMetricsUpdateToRoom(room: string, payload: MetricsUpdatePayload): void {
    if (!this.hasConnectedClients()) return;
    if (!this.gateway.server) return;

    this.gateway.server.to(room).emit('metrics:updated', payload);

    console.log(`[WS] Emitted metrics:updated to room ${room} with scope ${payload.scope}`);
  }
}