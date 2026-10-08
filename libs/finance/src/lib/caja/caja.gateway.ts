import { Injectable, Logger } from '@nestjs/common';
import { WebSocketGateway, WebSocketServer, OnGatewayConnection, OnGatewayDisconnect, SubscribeMessage, MessageBody, ConnectedSocket } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { Permission, isPlatformAdminRole } from '@megadulces/platform-core';
import { VinculosFirma, VIDA_MS, type ContextoFirma, type FalloVinculo } from './caja-firma-remota.engine';
import { revisarFirma } from './caja-firma.engine';

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

  /**
   * `[CG.68]` Los emparejamientos PC <-> telefono vivos. En memoria, y el motor explica hasta
   * donde alcanza: produccion corre UN solo prod-api. Con dos replicas esto se rompe en
   * silencio y el arreglo es mover el mapa a Redis, que ya esta en el stack.
   */
  private readonly vinculos = new VinculosFirma();

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
    // `[CG.68]` El permiso de ESCRITURA se guarda al conectar: pedir una firma es parte de
    // capturar (exige GESTIONAR), pero firmar no lo es. El telefono del mostrador se le pasa a
    // otras personas, asi que entra con el permiso minimo: VER alcanza para aportar evidencia.
    const puedeGestionar = isPlatformAdminRole(payload?.role_name)
      || perms[Permission.FINANCE_CAJA_GESTIONAR] === true;
    client.data = { tenantId, username: payload.username, puedeGestionar };
    if (!this.tenantSockets.has(tenantId)) this.tenantSockets.set(tenantId, new Set());
    this.tenantSockets.get(tenantId)!.add(client.id);
    client.emit('connected', { tenant_id: tenantId });
  }

  handleDisconnect(client: Socket): void {
    const t = client.data?.tenantId;
    if (t) this.tenantSockets.get(t)?.delete(client.id);
    // `[CG.68]` Un vinculo con una sola punta no sirve: se cierra, y se le DICE al que queda.
    // Sin el aviso, la PC se queda esperando una firma que nadie va a mandar.
    for (const v of this.vinculos.soltarSocket(client.id)) {
      this.server?.to(this.vinculos.room(v)).emit('firma:cortada', { codigo: v.codigo });
    }
  }

  // ══ `[CG.68]` LA FIRMA DESDE EL TELEFONO DEL MOSTRADOR ══════════════════════════════════
  //
  // Edgar: *"si esto lo estoy usando en pc, como hago que esto se envie a mi telefono para que
  // se firme?"*. Tres mensajes, y el PNG viaja por una room de DOS -- nunca por la del tenant,
  // que es la que tiene a todas las cajas de la empresa adentro.

  /** La PC pide un codigo. Exige GESTIONAR: pedir la firma es parte de capturar. */
  @SubscribeMessage('firma:abrir')
  abrirFirma(
    @ConnectedSocket() client: Socket,
    @MessageBody() ctx: ContextoFirma,
  ): { ok: boolean; codigo?: string; vida_ms?: number; error?: string } {
    const tenantId = client.data?.tenantId as string | undefined;
    if (!tenantId) return { ok: false, error: 'sin_tenant' };
    if (!client.data?.puedeGestionar) return { ok: false, error: 'sin_permiso' };

    // ⚠️ Se queda SOLO con los cuatro campos del contexto. Si se guardara el cuerpo entero, la
    // PC podria empujarle al telefono cualquier cosa que despues la pantalla del telefono pinte.
    const limpio: ContextoFirma = {
      tipo: String(ctx?.tipo ?? ''),
      monto: Number(ctx?.monto) || 0,
      beneficiario: ctx?.beneficiario ? String(ctx.beneficiario).slice(0, 120) : null,
      documento: ctx?.documento ? String(ctx.documento).slice(0, 60) : null,
    };

    let v;
    try { v = this.vinculos.abrir(tenantId, client.id, limpio, client.data?.username ?? null); }
    catch { return { ok: false, error: 'sin_codigo_libre' }; }

    client.join(this.vinculos.room(v));
    return { ok: true, codigo: v.codigo, vida_ms: VIDA_MS };
  }

  /** El telefono teclea el codigo. Solo VER: aportar evidencia no es escribir el libro. */
  @SubscribeMessage('firma:tomar')
  tomarFirma(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { codigo?: string },
  ): { ok: boolean; ctx?: ContextoFirma; error?: FalloVinculo | 'sin_tenant' } {
    const tenantId = client.data?.tenantId as string | undefined;
    if (!tenantId) return { ok: false, error: 'sin_tenant' };

    const r = this.vinculos.reclamar(String(body?.codigo ?? ''), tenantId, client.id);
    if (!r.ok || !r.v) return { ok: false, error: r.fallo };

    client.join(this.vinculos.room(r.v));
    // Se le avisa a la PC que el telefono ya esta del otro lado: sin esto, el cajero no sabe si
    // el codigo se tecleo bien y lo vuelve a dictar.
    this.server?.to(this.vinculos.room(r.v)).emit('firma:tomada', {
      codigo: r.v.codigo, por: client.data?.username ?? null,
    });
    return { ok: true, ctx: r.v.ctx };
  }

  /** El telefono entrega la firma. El PNG se VALIDA aca tambien. */
  @SubscribeMessage('firma:enviar')
  enviarFirma(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { codigo?: string; png?: string; nombre?: string },
  ): { ok: boolean; error?: FalloVinculo | 'sin_tenant' | 'no_es_firma' } {
    const tenantId = client.data?.tenantId as string | undefined;
    if (!tenantId) return { ok: false, error: 'sin_tenant' };

    const r = this.vinculos.entregar(String(body?.codigo ?? ''), tenantId, client.id);
    if (!r.ok || !r.v) return { ok: false, error: r.fallo };

    // ⛔ Se revisa ACA tambien, y no solo al guardar: el telefono es un cliente como cualquier
    // otro. Mandar la basura por el canal y descubrirla recien en el POST dejaria a la pantalla
    // de la caja diciendo "firmado" sobre algo que el servidor despues va a tirar.
    const firma = revisarFirma(r.v.ctx.tipo, body?.png);
    if (!firma.png) {
      this.logger.warn(
        '[CG.68] firma rechazada en el canal (' + firma.descartada + ') · ' + client.data?.username,
      );
      return { ok: false, error: 'no_es_firma' };
    }

    this.server?.to(this.vinculos.room(r.v)).emit('firma:recibida', {
      codigo: r.v.codigo,
      png: firma.png,
      nombre: body?.nombre ? String(body.nombre).slice(0, 120) : null,
      // ⭐ El monto que se le MOSTRO a quien firmo. La pantalla lo compara con el de ahora: si
      // el cajero lo cambio despues, la firma dejo de corresponder.
      monto_firmado: r.v.ctx.monto,
      por: client.data?.username ?? null,
    });
    return { ok: true };
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
