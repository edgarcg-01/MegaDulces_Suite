import { Injectable, Logger } from '@nestjs/common';
import { WebSocketGateway, WebSocketServer, OnGatewayConnection, OnGatewayDisconnect, SubscribeMessage, MessageBody, ConnectedSocket } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { Permission, isPlatformAdminRole } from '@megadulces/platform-core';
import {
  decidirTomar, decidirEntregar, nuevoCodigo, normalizarCodigo, roomDeFirma, VIDA_MS,
  type ContextoFirma, type FalloVinculo, type MarcaPc, type SocketEnRoom,
} from './caja-firma-remota.engine';
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

  // ⛔⛔ `[CG.68b]` ACA VIVIA UN `Map` DE EMPAREJAMIENTOS, y lo justifique con "produccion corre
  // UN solo prod-api" citando el runbook. Medido contra prod el 2026-10-08: prod corre en k3s
  // con `api 2/2` desde hacia siete dias, asi que la PC y el telefono caian en pods distintos y
  // el codigo "no existia" la mitad de las veces.
  //
  // ⭐ El arreglo no fue mover el Map a Redis: fue NO TENER MAPA. El emparejamiento vive en las
  // ROOMS de Socket.IO, que el adaptador de Redis (verificado ACTIVO en el log del pod) comparte
  // entre pods junto con el `data` de cada socket. `fetchSockets()` ve a la PC este donde este.

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
    // `[CG.68]` Un vinculo con una sola punta no sirve: se le DICE al que queda. Sin el aviso,
    // la PC se queda esperando una firma que nadie va a mandar.
    //
    // ⚠️ No hay nada que "cerrar": socket.io saca al socket de sus rooms solo, y con el se va el
    // emparejamiento. Lo unico que falta es el aviso.
    const cod: string | null = client.data?.firma?.codigo ?? client.data?.firmaTel ?? null;
    if (cod && t) {
      this.server?.to(roomDeFirma(t, cod)).emit('firma:cortada', { codigo: cod });
    }
  }

  // ══ `[CG.68]` LA FIRMA DESDE EL TELEFONO DEL MOSTRADOR ══════════════════════════════════
  //
  // Edgar: *"si esto lo estoy usando en pc, como hago que esto se envie a mi telefono para que
  // se firme?"*. Tres mensajes, y el PNG viaja por una room de DOS -- nunca por la del tenant,
  // que es la que tiene a todas las cajas de la empresa adentro.

  /**
   * La PC pide un codigo. Exige GESTIONAR: pedir la firma es parte de capturar.
   *
   * ⭐ El emparejamiento se GUARDA EN EL PROPIO SOCKET de la PC (`client.data.firma`). Con el
   * adaptador de Redis, `fetchSockets()` de otro pod trae ese `data`: eso es lo que hace que
   * funcione con N replicas sin que el servidor tenga un almacen.
   */
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

    // ⚠️ Si esta PC ya tenia un codigo abierto, SALE de esa room antes de abrir otro: si no,
    // quedaria esperando en dos y la firma de un pedido viejo entraria al nuevo.
    const previo: string | null = client.data?.firma?.codigo ?? null;
    if (previo) client.leave(roomDeFirma(tenantId, previo));

    const codigo = nuevoCodigo();
    const marca: MarcaPc = { codigo, ctx: limpio, creado: Date.now() };
    client.data = { ...client.data, firma: marca };
    client.join(roomDeFirma(tenantId, codigo));
    return { ok: true, codigo, vida_ms: VIDA_MS };
  }

  /**
   * La PC cancela el pedido.
   *
   * ⚠️ Sin esto el codigo seguia reclamable los 3 minutos completos aunque el cajero ya lo
   * hubiera cancelado: la pantalla lo ignoraba (compara el codigo) pero el telefono podia
   * tomarlo y ver el contexto del efectivo de un pedido que ya no existe.
   */
  @SubscribeMessage('firma:cerrar')
  cerrarFirma(@ConnectedSocket() client: Socket): { ok: boolean } {
    const tenantId = client.data?.tenantId as string | undefined;
    const cod: string | null = client.data?.firma?.codigo ?? null;
    if (tenantId && cod) {
      this.server?.to(roomDeFirma(tenantId, cod)).emit('firma:cortada', { codigo: cod });
      client.leave(roomDeFirma(tenantId, cod));
    }
    client.data = { ...client.data, firma: null };
    return { ok: true };
  }

  /** El telefono teclea el codigo. Solo VER: aportar evidencia no es escribir el libro. */
  @SubscribeMessage('firma:tomar')
  async tomarFirma(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { codigo?: string },
  ): Promise<{ ok: boolean; ctx?: ContextoFirma; error?: FalloVinculo | 'sin_tenant' }> {
    const tenantId = client.data?.tenantId as string | undefined;
    if (!tenantId) return { ok: false, error: 'sin_tenant' };

    const cod = normalizarCodigo(body?.codigo);
    const room = roomDeFirma(tenantId, cod);
    const r = decidirTomar(await this.fotoDeRoom(room), cod, tenantId, Date.now());
    if (!r.ok || !r.v) return { ok: false, error: r.fallo };

    client.data = { ...client.data, firmaTel: cod };
    client.join(room);
    // Se le avisa a la PC que el telefono ya esta del otro lado: sin esto, el cajero no sabe si
    // el codigo se tecleo bien y lo vuelve a dictar.
    this.server?.to(room).emit('firma:tomada', { codigo: cod, por: client.data?.username ?? null });
    return { ok: true, ctx: r.v.ctx };
  }

  /** El telefono entrega la firma. El PNG se VALIDA aca tambien. */
  @SubscribeMessage('firma:enviar')
  async enviarFirma(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { codigo?: string; png?: string; nombre?: string },
  ): Promise<{ ok: boolean; error?: FalloVinculo | 'sin_tenant' | 'no_es_firma' }> {
    const tenantId = client.data?.tenantId as string | undefined;
    if (!tenantId) return { ok: false, error: 'sin_tenant' };

    const cod = normalizarCodigo(body?.codigo);
    const room = roomDeFirma(tenantId, cod);
    const r = decidirEntregar(await this.fotoDeRoom(room), cod, tenantId, client.id, Date.now());
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

    this.server?.to(room).emit('firma:recibida', {
      codigo: cod,
      png: firma.png,
      nombre: body?.nombre ? String(body.nombre).slice(0, 120) : null,
      // ⭐ El monto que se le MOSTRO a quien firmo. La pantalla lo compara con el de ahora: si
      // el cajero lo cambio despues, la firma dejo de corresponder.
      monto_firmado: r.v.ctx.monto,
      por: client.data?.username ?? null,
    });
    // Un solo envio por emparejamiento: el telefono suelta la room, asi que un segundo intento
    // cae en 'no_es_suyo' en vez de pisar la firma que ya llego.
    client.leave(room);
    client.data = { ...client.data, firmaTel: null };
    return { ok: true };
  }

  /**
   * La foto de los sockets de una room, como DATO.
   *
   * ⭐ `fetchSockets()` con el adaptador de Redis consulta a TODOS los pods y trae el `data` de
   * cada socket. Es la pieza que hace que el emparejamiento funcione con `api 2/2` sin que el
   * servidor guarde nada. Sin adaptador devuelve solo los locales — y entonces el telefono ve
   * `no_existe`, que es un mensaje honesto, no un silencio.
   */
  private async fotoDeRoom(room: string): Promise<SocketEnRoom[]> {
    if (!this.server) return [];
    try {
      const socks = await this.server.in(room).fetchSockets();
      return socks.map((x) => ({
        id: x.id,
        tenantId: (x.data?.tenantId as string | undefined) ?? null,
        pc: (x.data?.firma as MarcaPc | undefined) ?? null,
        telefono: (x.data?.firmaTel as string | undefined) ?? null,
      }));
    } catch (e) {
      // ⚠️ Se declara: si el adaptador falla, la decision va a decir 'no_existe' y la persona
      // va a revisar el codigo en vano. Queda en el log para que se pueda distinguir.
      this.logger.warn('[CG.68] no se pudo leer la room ' + room + ': ' + (e as Error).message);
      return [];
    }
  }

  /**
   * Empuja el cambio a la room del tenant. Best-effort: nunca bloquea ni tira al llamador.
   *
   * ⚠️ `[CG.68b]` Este metodo desaparecio sin que nadie lo notara cuando reescribi los
   * handlers de la firma: el reemplazo cortaba desde el primer handler hasta `oyentes`, y
   * `emitChange` vivia EN MEDIO. Lo agarro el typecheck de `libs/finance` -- dos llamadores se
   * quedaron sin metodo. Una reescritura por posicion se lleva lo que no estaba mirando.
   */
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
