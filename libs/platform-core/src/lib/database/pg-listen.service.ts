import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Client } from 'pg';

/**
 * CG.23.2 — `LISTEN` de Postgres, en UN solo lugar.
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────────────────────
 * Medido el 2026-09-23: **el repo no tenía un solo `LISTEN` ni `NOTIFY`** (grep sobre `libs`,
 * `apps` y `database/importers`: cero). Todo lo que hoy se entera de que "llegó algo nuevo" lo
 * hace poleando con un watermark — `FinanceFeedScannerService` cada 30 min, `pollVisible` en
 * nueve pantallas. Eso alcanza para una campana; no alcanza para una caja, donde el pedido es
 * que el movimiento aparezca **al momento en que Kepler lo registra**.
 *
 * Como es el primer `LISTEN` del repo, vive acá y no dentro de la fase: ADR-056 — un primitivo
 * compartido vive en `libs/`, o queda declarado como deuda con nombre.
 *
 * ── Por qué una conexión DEDICADA y no el pool de Knex ──────────────────────────────────────
 * Una sesión que escucha queda ocupada mientras espera. Tomarla del pool de la app significa
 * retenerla para siempre y, peor, que el pool la recicle y **el `LISTEN` se pierda sin un solo
 * error**: la sesión nueva no hereda las suscripciones. Ésa es justo la forma de fallar que esta
 * clase existe para evitar — un canal mudo se lee igual que "no pasó nada".
 *
 * ── Lo que NO garantiza, y hay que saberlo ──────────────────────────────────────────────────
 * `NOTIFY` **no se persiste**: lo que se emite mientras nadie escucha se pierde, y punto. Por eso
 * esto NO puede ser el único camino del dato. Sirve para decir "andá a buscar", nunca para
 * transportar el dato en sí, y del otro lado siempre tiene que quedar un repaso lento que se
 * ponga al día solo. Quien consuma esto y apague su repaso está construyendo un silencio.
 */
@Injectable()
export class PgListenService implements OnModuleDestroy {
  private readonly logger = new Logger(PgListenService.name);
  private client: Client | null = null;
  private cerrando = false;
  private reintento: NodeJS.Timeout | null = null;
  /** canal → oyentes. Se guarda para poder re-suscribir TODO al reconectar. */
  private readonly canales = new Map<string, Set<(payload: string) => void>>();
  private intentos = 0;

  /**
   * Escucha un canal. Devuelve la función para dejar de escuchar.
   *
   * Es idempotente por canal: varios oyentes comparten un solo `LISTEN`.
   */
  escuchar(canal: string, oyente: (payload: string) => void): () => void {
    if (!/^[a-z_][a-z0-9_]*$/.test(canal)) {
      // El nombre del canal NO se puede parametrizar en `LISTEN` (va como identificador), así
      // que se valida acá en vez de interpolar lo que venga.
      throw new Error(`Canal de LISTEN inválido: "${canal}"`);
    }
    const nuevo = !this.canales.has(canal);
    if (nuevo) this.canales.set(canal, new Set());
    this.canales.get(canal)!.add(oyente);

    if (nuevo && this.client) this.suscribir(canal).catch(() => { /* lo reintenta el reconnect */ });
    this.asegurarConexion();

    return () => {
      const set = this.canales.get(canal);
      if (!set) return;
      set.delete(oyente);
      if (set.size === 0) {
        this.canales.delete(canal);
        this.client?.query(`UNLISTEN ${canal}`).catch(() => { /* best-effort */ });
      }
    };
  }

  private asegurarConexion(): void {
    if (this.client || this.cerrando || this.reintento) return;
    void this.conectar();
  }

  private async conectar(): Promise<void> {
    const cs = process.env.DATABASE_URL_NEW || process.env.DATABASE_URL;
    if (!cs) {
      // Sin cadena de conexión NO se lanza: el aviso es un extra y tumbar el arranque del API
      // por no poder escuchar sería peor que quedarse sin aviso. Se DICE, eso sí.
      this.logger.warn('Sin DATABASE_URL_NEW/DATABASE_URL: no hay avisos en vivo (LISTEN apagado).');
      return;
    }
    const c = new Client({
      connectionString: cs,
      ssl: cs.includes('localhost') || cs.includes('pg-prod') ? false : { rejectUnauthorized: false },
      application_name: 'pg-listen',
      // Sin keepalive, un NAT o un balanceador cortan una sesión que sólo espera — y como no
      // manda nada, nadie se entera hasta que hace falta el aviso que ya no va a llegar.
      keepAlive: true,
    });

    c.on('notification', (msg) => {
      const oyentes = this.canales.get(msg.channel);
      if (!oyentes) return;
      for (const o of oyentes) {
        try { o(msg.payload ?? ''); }
        catch (e) { this.logger.warn(`oyente de ${msg.channel} falló: ${(e as Error)?.message}`); }
      }
    });
    c.on('error', (e) => {
      this.logger.warn(`conexión de LISTEN caída: ${e?.message}`);
      this.client = null;
      c.end().catch(() => { /* ya está cayéndose */ });
      this.programarReintento();
    });

    try {
      await c.connect();
      this.client = c;
      this.intentos = 0;
      // Re-suscribir TODO: una reconexión con la lista vacía deja el canal mudo para siempre.
      for (const canal of this.canales.keys()) await this.suscribir(canal);
      this.logger.log(`LISTEN activo en ${this.canales.size} canal(es).`);
    } catch (e: unknown) {
      this.logger.warn(`no se pudo abrir la conexión de LISTEN: ${(e as Error)?.message}`);
      this.client = null;
      this.programarReintento();
    }
  }

  private async suscribir(canal: string): Promise<void> {
    await this.client?.query(`LISTEN ${canal}`);
  }

  private programarReintento(): void {
    if (this.cerrando || this.reintento) return;
    // Retroceso exponencial con techo de 30 s: reintentar cada segundo contra una base caída
    // suma carga justo cuando menos aguanta.
    const espera = Math.min(30000, 1000 * 2 ** Math.min(this.intentos++, 5));
    this.reintento = setTimeout(() => { this.reintento = null; void this.conectar(); }, espera);
    this.reintento.unref?.();
  }

  async onModuleDestroy(): Promise<void> {
    this.cerrando = true;
    if (this.reintento) { clearTimeout(this.reintento); this.reintento = null; }
    await this.client?.end().catch(() => { /* cerrando igual */ });
    this.client = null;
  }
}
