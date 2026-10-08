import { Injectable, OnDestroy, computed, inject, signal } from '@angular/core';
import { Observable, firstValueFrom, timeout } from 'rxjs';
import type { AndenPaqueteOffline } from '@megadulces/contracts';
import { ErpOrderMatch, FolioYaRecibido, ReceivingSession, ReceivingSessionService } from '../receiving-session.service';
import { ReceivingAuditorService } from '../receiving-auditor.service';
import { ANDEN_STORE } from './anden-offline.store';
import {
  MAX_INTENTOS_500,
  OpAnden,
  TOPE,
  ValeGuardado,
  conCapturaEnviada,
  emparejarRenglones,
  esFallaDeRed,
  esSinRed,
  esLocal,
  motivoDe,
  nuevaLlave,
  superponer,
} from './anden-offline';

/** Lo que pasó al mandar la cola de UN vale: la pantalla lo dice y, si lo tiene abierto, lo recarga. */
export interface EnvioVale {
  key: string;
  sessionId: string | null;
  /** La base nueva (lo que dice el servidor), si se pudo mandar todo. */
  vale: ReceivingSession | null;
  avisos: string[];
  /** El servidor rechazó algo: el vale queda detenido hasta que alguien lo mire. */
  error: string | null;
}

/** Una operación nueva, antes de que la cola le ponga id, orden y estado (por cada tipo de la unión). */
type SinMeta<T> = T extends unknown ? Omit<T, 'id' | 'seq' | 'creadoEn' | 'intentos' | 'estado' | 'error'> : never;
export type OpNueva = SinMeta<OpAnden>;

/** Cada cuánto se reintenta sola la cola cuando hay pendientes (el caso "hay red, pero mala"). */
const REINTENTO_MS = 30_000;

/**
 * `[WMS-REC.20]` **La cola del Andén**: guarda lo que se hizo sin red y lo manda en cuanto se puede.
 *
 * Cómo manda: vale por vale, cada vale en el orden en que se hizo (abrir → fechar → cerrar renglón
 * → cerrar). Dos tipos de falla, tratadas distinto a propósito:
 *  - **de red** (sin respuesta, 5xx, 401…): se detiene TODO y se reintenta después, sin perder nada;
 *  - **de negocio** (el servidor dijo que no: almacén congelado, folio ya recibido y cerrado…): se
 *    detiene SÓLO ese vale y queda a la vista con su motivo. Reintentarlo a ciegas no lo arreglaría.
 *
 * Cada envío exitoso se aplica a la base del vale ANTES de sacarlo de la cola: si después se cae la
 * red, el equipo no "olvida" lo que ya mandó (y no invita a fecharlo otra vez).
 */
@Injectable({ providedIn: 'root' })
export class AndenOfflineService implements OnDestroy {
  private readonly store = inject(ANDEN_STORE);
  private readonly sessions = inject(ReceivingSessionService);
  private readonly auditor = inject(ReceivingAuditorService);

  /** Lo que sabe el equipo de su conexión. Se baja también cuando un envío falla por red. */
  readonly online = signal(typeof navigator !== 'undefined' ? navigator.onLine !== false : true);
  readonly enviando = signal(false);
  /** Espejo de la cola guardada. */
  readonly ops = signal<OpAnden[]>([]);
  readonly pendientes = computed(() => this.ops().filter((o) => o.estado === 'pendiente').length);
  readonly conError = computed(() => this.ops().filter((o) => o.estado === 'error'));
  /** Vales con algo en la cola: sus escrituras nuevas también van a la cola, para no saltarse el orden. */
  readonly valesEnCola = computed(() => new Set(this.ops().map((o) => o.valeKey)));
  /** El último envío de cada vale, para la pantalla. */
  readonly ultimoEnvio = signal<EnvioVale | null>(null);

  private enCurso: Promise<void> | null = null;
  private seq = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly alVolver = () => {
    this.online.set(true);
    void this.flush();
  };
  private readonly alIrse = () => this.online.set(false);

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.alVolver);
      window.addEventListener('offline', this.alIrse);
      this.timer = setInterval(() => {
        if (this.pendientes() > 0) void this.flush();
      }, REINTENTO_MS);
    }
    void this.recargarOps();
  }

  ngOnDestroy(): void {
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.alVolver);
      window.removeEventListener('offline', this.alIrse);
    }
    if (this.timer) clearInterval(this.timer);
  }

  /** Un envío falló por red: lo que sigue va directo a la cola, sin esperar otro timeout. */
  marcarSinRed(): void {
    this.online.set(false);
  }

  /** Un pedido al servidor SÍ respondió: hay red. Si había algo por mandar, se manda. */
  marcarConRed(): void {
    if (this.online()) return;
    this.online.set(true);
    if (this.pendientes() > 0) void this.flush();
  }

  /** ¿Las escrituras de este vale tienen que ir a la cola? */
  usaCola(valeKey: string | null | undefined): boolean {
    return !this.online() || esLocal(valeKey) || (!!valeKey && this.valesEnCola().has(valeKey));
  }

  // ── Paquetes ────────────────────────────────────────────────────────────

  /** Baja y guarda el paquete de una sucursal. Mejor esfuerzo: si falla, queda el anterior. */
  async bajarPaquete(sucursal: string): Promise<AndenPaqueteOffline | null> {
    try {
      const p = await espera(this.sessions.offlinePack(sucursal), TOPE.captura);
      await this.store.guardarPaquete(p);
      return p;
    } catch {
      return null;
    }
  }

  paquete(sucursal: string): Promise<AndenPaqueteOffline | null> {
    return this.store.paquete(sucursal);
  }

  paquetes(): Promise<AndenPaqueteOffline[]> {
    return this.store.paquetes();
  }

  // ── Vales ───────────────────────────────────────────────────────────────

  valesGuardados(): Promise<ValeGuardado[]> {
    return this.store.vales();
  }

  /**
   * Lo que el servidor dijo de un vale pasa a ser su base. Se guarda bajo la llave que YA tenga
   * (un vale abierto sin red se llama `local:…` aunque ya exista allá), para no duplicarlo.
   */
  async registrarDetalle(vale: ReceivingSession, extra: { sucursal?: string | null; erp?: ErpOrderMatch | null } = {}): Promise<void> {
    const previo = (await this.store.valePorSesion(vale.id)) ?? (await this.store.vale(vale.id));
    await this.store.guardarVale({
      key: previo?.key ?? vale.id,
      sessionId: vale.id,
      vale,
      mapa: previo?.mapa ?? {},
      sucursal: extra.sucursal ?? previo?.sucursal ?? null,
      erp: extra.erp ?? previo?.erp ?? null,
      actualizado: new Date().toISOString(),
    });
  }

  /** Guarda un vale abierto SIN red, armado del paquete. */
  async guardarValeLocal(vale: ReceivingSession, extra: { sucursal: string | null; erp: ErpOrderMatch | null }): Promise<void> {
    await this.store.guardarVale({
      key: vale.id, sessionId: null, vale, mapa: {}, sucursal: extra.sucursal, erp: extra.erp,
      actualizado: new Date().toISOString(),
    });
  }

  /** La llave con que el equipo guarda un vale: la suya local, o el id del servidor. */
  async llaveDe(id: string): Promise<string> {
    if (esLocal(id)) return id;
    return (await this.store.valePorSesion(id))?.key ?? id;
  }

  /** El id del servidor de un vale (abierto o no sin red). `null` si todavía no se manda. */
  async sesionDe(key: string): Promise<string | null> {
    if (!esLocal(key)) return key;
    return (await this.store.vale(key))?.sessionId ?? null;
  }

  /** Lo que se ve de un vale: su base con lo que falta mandar encima. `null` si el equipo no lo tiene. */
  async vista(idOKey: string): Promise<ReceivingSession | null> {
    const key = await this.llaveDe(idOKey);
    const g = await this.store.vale(key);
    if (!g) return null;
    const ops = (await this.store.ops()).filter((o) => o.valeKey === key);
    return superponer(g.vale, ops, g.mapa);
  }

  /** Lo que falta mandar, aplicado encima de un detalle del servidor recién llegado. */
  async superponerCola(vale: ReceivingSession): Promise<ReceivingSession> {
    const key = await this.llaveDe(vale.id);
    const g = await this.store.vale(key);
    const ops = (await this.store.ops()).filter((o) => o.valeKey === key);
    return ops.length ? superponer(vale, ops, g?.mapa ?? {}) : vale;
  }

  /** Una escritura que SÍ llegó: se aplica a la base para no depender de volver a pedir el detalle. */
  async anotarCapturaEnviada(sessionId: string, lineaId: string, cantidad: number, retenida: boolean): Promise<void> {
    const g = await this.store.valePorSesion(sessionId);
    if (!g || !lineaId) return;
    await this.store.guardarVale({ ...g, vale: conCapturaEnviada(g.vale, lineaId, cantidad, retenida), actualizado: new Date().toISOString() });
  }

  // ── Cola ────────────────────────────────────────────────────────────────

  async encolar(op: OpNueva): Promise<void> {
    const completa = {
      ...op,
      id: nuevaLlave(),
      seq: Date.now() * 1000 + (this.seq++ % 1000),
      creadoEn: new Date().toISOString(),
      intentos: 0,
      estado: 'pendiente',
    } as OpAnden;
    await this.store.guardarOp(completa);
    await this.recargarOps();
    if (this.online()) void this.flush();
  }

  /** Vuelve a intentar un vale detenido por un rechazo (después de arreglar la causa). */
  async reintentar(key: string): Promise<void> {
    for (const o of (await this.store.ops()).filter((x) => x.valeKey === key && x.estado === 'error'))
      await this.store.guardarOp({ ...o, estado: 'pendiente', error: undefined });
    await this.recargarOps();
    this.online.set(true);
    await this.flush();
  }

  /**
   * Tira lo que falta mandar de un vale. Es la única salida cuando el servidor no lo va a aceptar
   * nunca (otra persona ya lo recibió y lo cerró). Lo capturado se pierde: la pantalla lo pregunta.
   */
  async descartar(key: string): Promise<void> {
    for (const o of (await this.store.ops()).filter((x) => x.valeKey === key)) await this.store.borrarOp(o.id);
    const g = await this.store.vale(key);
    if (g && !g.sessionId) await this.store.borrarVale(key);
    await this.recargarOps();
  }

  /** Manda lo pendiente. Si ya hay un envío en curso, espera a ese en vez de empezar otro. */
  flush(): Promise<void> {
    if (!this.enCurso) {
      this.enCurso = this.mandar().finally(() => {
        this.enCurso = null;
      });
    }
    return this.enCurso;
  }

  private async mandar(): Promise<void> {
    this.enviando.set(true);
    try {
      const todas = (await this.store.ops()).sort((a, b) => a.seq - b.seq);
      const porVale = new Map<string, OpAnden[]>();
      for (const o of todas) porVale.set(o.valeKey, [...(porVale.get(o.valeKey) ?? []), o]);
      for (const [key, lista] of porVale) {
        // Un vale detenido por un rechazo no se toca hasta que alguien lo mire.
        if (lista.some((o) => o.estado === 'error')) continue;
        const r = await this.mandarVale(key, lista);
        if (r === 'sin_red') {
          // No se alcanzó el servidor: los demás vales tampoco van a pasar. Se para todo.
          this.online.set(false);
          break;
        }
        // Contestó (aunque sea con un error que se reintenta): hay red, se sigue con el siguiente vale.
        this.online.set(true);
      }
    } finally {
      this.enviando.set(false);
      await this.recargarOps();
    }
  }

  private async mandarVale(key: string, lista: OpAnden[]): Promise<'ok' | 'sin_red' | 'reintentar' | 'rechazo'> {
    let g = await this.store.vale(key);
    const avisos: string[] = [];
    for (const op of lista) {
      try {
        if (!g) throw Object.assign(new Error('El equipo ya no tiene la base de este vale.'), { status: 410 });
        g = await this.mandarOp(op, g, avisos);
        await this.store.guardarVale({ ...g, actualizado: new Date().toISOString() });
        await this.store.borrarOp(op.id);
      } catch (e) {
        // Un 500 se reintenta, pero no para siempre: si el servidor falla igual cada vez, no es la red.
        const terco = (e as { status?: number })?.status === 500 && op.intentos + 1 >= MAX_INTENTOS_500;
        if (esFallaDeRed(e) && !terco) {
          await this.store.guardarOp({ ...op, intentos: op.intentos + 1 });
          if (avisos.length) this.ultimoEnvio.set({ key, sessionId: g?.sessionId ?? null, vale: null, avisos, error: null });
          return esSinRed(e) ? 'sin_red' : 'reintentar';
        }
        const error = motivoDe(e, ACCION[op.tipo]);
        await this.store.guardarOp({ ...op, intentos: op.intentos + 1, estado: 'error', error });
        this.ultimoEnvio.set({ key, sessionId: g?.sessionId ?? null, vale: null, avisos, error });
        return 'rechazo';
      }
    }
    // Todo mandado: si la última fue una captura, se pide el detalle para traer el veredicto real.
    if (g?.sessionId && lista[lista.length - 1]?.tipo === 'fechar') {
      try {
        const d = await espera(this.sessions.detail(g.sessionId), TOPE.lectura);
        g = { ...g, vale: d };
        await this.store.guardarVale({ ...g, actualizado: new Date().toISOString() });
      } catch {
        /* la base ya trae lo mandado aplicado; el detalle llega en la próxima lectura */
      }
    }
    this.ultimoEnvio.set({ key, sessionId: g?.sessionId ?? null, vale: g?.vale ?? null, avisos, error: null });
    return 'ok';
  }

  /** Manda UNA operación y devuelve la base actualizada. Lanza si falla (el que llama clasifica). */
  private async mandarOp(op: OpAnden, g: ValeGuardado, avisos: string[]): Promise<ValeGuardado> {
    switch (op.tipo) {
      case 'abrir': {
        let s: ReceivingSession;
        try {
          s = await espera(this.sessions.open(op.dto), TOPE.escritura);
        } catch (e) {
          // Otra persona abrió el mismo documento mientras este equipo estaba sin red. Si su vale
          // sigue abierto, lo de este equipo se suma a ESE vale; si ya lo cerró, no hay a dónde.
          const prev = folioYaRecibido(e);
          if (!prev || prev.status === 'closed') throw e;
          s = await espera(this.sessions.detail(prev.id), TOPE.lectura);
          avisos.push(`Ya lo había abierto otra persona (${prev.folio}): lo de este equipo se sumó a ese vale.`);
        }
        return { ...g, sessionId: s.id, vale: s, mapa: emparejarRenglones(g.vale.lines ?? [], s.lines ?? []) };
      }
      case 'fechar': {
        const sid = requiereSesion(g);
        const linea = op.lineaId ? (g.mapa[op.lineaId] ?? (esLocal(op.lineaId) ? '' : op.lineaId)) : '';
        if (op.lineaId && !linea)
          avisos.push('Un renglón ya no está en el vale de Kepler: su caducidad se guardó como captura suelta.');
        const cap = await espera(
          this.auditor.evaluate({ ...op.payload, source_ref: g.vale.folio, receiving_line_id: linea || undefined }),
          TOPE.captura,
        );
        if (cap.verdict === 'red') avisos.push(`${cap.product_name || cap.sku || 'Un producto'} quedó retenido: un supervisor lo tiene que liberar.`);
        return { ...g, sessionId: sid, vale: linea ? conCapturaEnviada(g.vale, linea, Number(op.payload.quantity), cap.verdict === 'red') : g.vale };
      }
      case 'renglon': {
        const sid = requiereSesion(g);
        const s = await espera(this.sessions.setLine(sid, g.mapa[op.lineaId] ?? op.lineaId, { received_qty: op.received_qty }), TOPE.escritura);
        return { ...g, vale: s };
      }
      case 'cerrar': {
        const sid = requiereSesion(g);
        try {
          const s = await espera(this.sessions.close(sid), TOPE.escritura);
          const n = s.claims?.raised ?? 0;
          if (n > 0) avisos.push(`Al cerrar se levantaron ${n} reclamo(s); se siguen en Compras › Reclamos.`);
          return { ...g, vale: s };
        } catch (e) {
          // Ya estaba cerrado (otra persona, o un envío anterior cuya respuesta se perdió): es lo que se quería.
          if ((e as { status?: number })?.status === 409 && /closed|cerrad/i.test(motivoDe(e, ''))) {
            return { ...g, vale: await espera(this.sessions.detail(sid), TOPE.lectura) };
          }
          throw e;
        }
      }
    }
  }

  private async recargarOps(): Promise<void> {
    try {
      this.ops.set(await this.store.ops());
    } catch {
      /* sin almacenamiento local: la cola se ve vacía, pero no tumba la pantalla */
    }
  }
}

const ACCION: Record<OpAnden['tipo'], string> = {
  abrir: 'abrir el vale',
  fechar: 'guardar la caducidad',
  renglon: 'cerrar el renglón',
  cerrar: 'cerrar el vale',
};

/** Un pedido con tope: si no contesta a tiempo, falla como falla la red (y se reintenta). */
function espera<T>(o: Observable<T>, ms: number): Promise<T> {
  return firstValueFrom(o.pipe(timeout(ms)));
}

function requiereSesion(g: ValeGuardado): string {
  if (!g.sessionId) throw Object.assign(new Error('El vale todavía no se abrió en el servidor.'), { status: 409 });
  return g.sessionId;
}

/** El 409 de "este folio ya tiene vale", con el vale con el que choca. */
function folioYaRecibido(e: unknown): FolioYaRecibido | null {
  const x = e as { status?: number; error?: { error?: string; previous?: FolioYaRecibido } } | null;
  return x?.status === 409 && x.error?.error === 'folio_ya_recibido' && x.error.previous ? x.error.previous : null;
}
