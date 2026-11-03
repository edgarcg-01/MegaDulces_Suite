import { Injectable, OnDestroy, signal } from '@angular/core';
import { ESC_POS_ESTADO, EstadoGaveta, calibrarGaveta, escPosAbrirGaveta, leerEstadoGaveta } from './caja-motor';

/**
 * [PDV.34] La gaveta de la caja, conectada a la impresora de tickets (el cajón va al puerto RJ11 de
 * la impresora). El navegador habla con la impresora por **Web Serial** (Chrome/Edge): manda el pulso
 * de apertura y le pregunta el estado del cajón con DLE EOT 1 cada {@link CADA_MS}.
 *
 * ⚠️ Sirve sólo si la impresora aparece como puerto COM (serial, USB-serial o «puerto COM virtual» de
 * su driver). Una impresora USB con driver de impresora de Windows no la ve el navegador: ahí hace
 * falta un agente local (D-I3, según el censo PDV.6). La caja lo declara («sin conectar»), no lo finge.
 *
 * Cómo se calibra: al conectar se lee el nivel, se abre la gaveta y se vuelve a leer; si cambió, el de
 * antes era «cerrada» ({@link calibrarGaveta}). Así no hay que saber si el cajón es «normalmente
 * abierto» o «normalmente cerrado», ni confiar en que alguien lo cerró antes de conectar.
 */
const CADA_MS = 300;
/** Sin respuesta en este tiempo, la impresora está conectada pero no reporta el cajón. */
const SIN_RESPUESTA_MS = 1500;
/** Tiempo para ver el cambio de nivel tras el pulso (en Yurécuaro se vio a los ~1.3 s). */
const CICLO_MS = 3000;
const LLAVE = 'md-caja-gaveta';

interface PuertoSerial {
  open(o: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
}
interface SerialNavegador {
  requestPort(): Promise<PuertoSerial>;
  getPorts(): Promise<PuertoSerial[]>;
}
interface Config { nivelCerrada: boolean; baud: number; pin: 0 | 1 }

@Injectable({ providedIn: 'root' })
export class GavetaService implements OnDestroy {
  private readonly serial = (globalThis.navigator as unknown as { serial?: SerialNavegador } | undefined)?.serial ?? null;
  /** El navegador no trae Web Serial (Firefox, Safari, o sin HTTPS): no hay forma de manejar la gaveta desde acá. */
  readonly soportado = !!this.serial;
  readonly estado = signal<EstadoGaveta>('desconectada');
  /** Desde cuándo está abierta (ms), para avisar si se queda abierta. */
  readonly abiertaDesde = signal<number | null>(null);

  private puerto: PuertoSerial | null = null;
  private escritor: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private lector: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ultimaRespuesta = 0;
  private ultimoByte: number | null = null;
  private config: Config | null = this.leerConfig();

  /** Al entrar a la caja: si esta computadora ya autorizó la impresora, se reconecta sola (sin clic). */
  async reconectar(): Promise<void> {
    if (!this.serial || !this.config || this.puerto) return;
    const [p] = await this.serial.getPorts().catch(() => [] as PuertoSerial[]);
    if (p) await this.abrirPuerto(p, this.config.baud).catch(() => this.cerrarPuerto());
  }

  /**
   * Conectar por primera vez: el navegador pide elegir el puerto (necesita el clic de la persona) y se
   * calibra con la gaveta cerrada. Devuelve el porqué si no se pudo.
   */
  async conectar(baud = 9600): Promise<string | null> {
    if (!this.serial) return 'Este navegador no puede manejar la gaveta: usa Chrome o Edge.';
    let p: PuertoSerial;
    try { p = await this.serial.requestPort(); } catch { return 'No se eligió la impresora.'; }
    await this.cerrarPuerto();
    try { await this.abrirPuerto(p, baud); } catch (e) { return 'No se pudo abrir el puerto: ' + ((e as Error)?.message || 'ocupado por otro programa'); }
    this.config = null;
    const antes = await this.esperarByte(SIN_RESPUESTA_MS);
    if (antes === null) {
      this.config = { nivelCerrada: false, baud, pin: 0 };
      this.guardarConfig();
      return 'La impresora no contesta el estado del cajón: la caja abrirá la gaveta, pero no sabrá si está cerrada.';
    }
    // Calibración por ciclo (calibrarGaveta): se abre y se mira si el nivel cambió.
    await this.escritor?.write(escPosAbrirGaveta(0)).catch(() => undefined);
    const c = calibrarGaveta(antes, await this.esperarByte(CICLO_MS, (b) => ((b ^ antes) & 0x04) !== 0));
    if (c === 'sin_cambio') {
      await this.cerrarPuerto();
      return 'La gaveta no cambió al mandarle abrir. Si estaba abierta, ciérrala y vuelve a conectar; si sí se abrió, este cajón no avisa si está cerrado.';
    }
    this.config = { nivelCerrada: c.nivelCerrada, baud, pin: 0 };
    this.guardarConfig();
    this.ultimaRespuesta = Date.now();
    this.fijar('abierta');
    return null;
  }

  /** Manda el pulso. No marca «abierta» por adelantado: eso lo dice el sensor (o, sin sensor, nadie). */
  async abrir(): Promise<void> {
    if (!this.escritor || !this.config) return;
    await this.escritor.write(escPosAbrirGaveta(this.config.pin)).catch(() => this.cerrarPuerto());
  }

  ngOnDestroy(): void { void this.cerrarPuerto(); }

  private async abrirPuerto(p: PuertoSerial, baud: number): Promise<void> {
    await p.open({ baudRate: baud });
    this.puerto = p;
    this.escritor = p.writable?.getWriter() ?? null;
    this.lector = p.readable?.getReader() ?? null;
    this.ultimaRespuesta = Date.now();
    this.estado.set('sin_sensor');
    void this.leer();
    this.timer = setInterval(() => this.consultar(), CADA_MS);
  }

  private async cerrarPuerto(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try { await this.lector?.cancel(); } catch { /* ya estaba cerrado */ }
    try { this.lector?.releaseLock(); this.escritor?.releaseLock(); } catch { /* idem */ }
    try { await this.puerto?.close(); } catch { /* idem */ }
    this.puerto = this.lector = this.escritor = null;
    this.estado.set('desconectada');
    this.abiertaDesde.set(null);
  }

  private consultar(): void {
    if (!this.escritor) return;
    void this.escritor.write(ESC_POS_ESTADO).catch(() => this.cerrarPuerto());
    if (Date.now() - this.ultimaRespuesta > SIN_RESPUESTA_MS) this.fijar('sin_sensor');
  }

  private async leer(): Promise<void> {
    while (this.lector) {
      let r: ReadableStreamReadResult<Uint8Array>;
      try { r = await this.lector.read(); } catch { await this.cerrarPuerto(); return; }
      if (r.done) { await this.cerrarPuerto(); return; }
      for (const b of r.value ?? []) {
        this.ultimoByte = b;
        const e = this.config ? leerEstadoGaveta(b, this.config.nivelCerrada) : null;
        if (e) { this.ultimaRespuesta = Date.now(); this.fijar(e); }
      }
    }
  }

  /** Espera una respuesta válida de DLE EOT 1 (y que cumpla `y`, si se da). */
  private async esperarByte(ms: number, y: (b: number) => boolean = () => true): Promise<number | null> {
    this.ultimoByte = null;
    const hasta = Date.now() + ms;
    while (Date.now() < hasta) {
      if (this.ultimoByte !== null && (this.ultimoByte & 0x93) === 0x12 && y(this.ultimoByte)) return this.ultimoByte;
      await new Promise((r) => setTimeout(r, 50));
    }
    return null;
  }

  private fijar(e: EstadoGaveta): void {
    if (this.estado() === e) return;
    this.estado.set(e);
    this.abiertaDesde.set(e === 'abierta' ? Date.now() : null);
  }

  private leerConfig(): Config | null {
    try { const v = localStorage.getItem(LLAVE); return v ? (JSON.parse(v) as Config) : null; } catch { return null; }
  }
  private guardarConfig(): void {
    try { localStorage.setItem(LLAVE, JSON.stringify(this.config)); } catch { /* sin almacenamiento: se recalibra al conectar */ }
  }
}
