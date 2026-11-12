/**
 * `[RE.69]` → `[AX.22]` — **Correr un trabajo al llegar el dato, no por reloj.** Edgar, 2026-11-10:
 * «ningún cron».
 *
 * Nació en `libs/finance/.../entradas-por-aviso.ts` (apareo de entradas) y se mudó aquí cuando un
 * segundo dominio (`libs/commercial`, la revisión de facturas TM contra su embarque) lo necesitó:
 * un primitivo que usan dos dominios vive en `libs/` (ADR-056), no copiado en cada uno.
 *
 * `services/feeds-ingest/apply-handlers.js` emite `pg_notify('caja_fuente', …)` después del COMMIT de
 * cada UPSERT que cambia de verdad `kepler_ods.kdm1` (sin churn). Las vistas sobre `kdm1` son vivas:
 * cuando llega el aviso, el documento ya está.
 *
 * ── Por qué una firma y no correr con cada aviso (medido en prod, 2026-11-10) ───────────────────────
 * `caja_fuente` avisa por CUALQUIER documento de `kdm1` —ventas, caja, compras—: 15 avisos en 90 s en
 * horario hábil. El aviso sólo AGENDA una mirada (a lo más una por espera; los avisos de en medio se
 * absorben, y una ráfaga continua no la puede posponer para siempre), y la mirada calcula una firma
 * barata de lo que le importa a ese trabajo: si no cambió, no hay nada que hacer.
 *
 * ⚠️ `NOTIFY` no se persiste: lo que se emite mientras nadie escucha se pierde. Por eso cada proceso
 * mira una vez al arrancar (sin firma previa → corre), que recoge lo que pasó mientras estuvo abajo.
 */
export const CANAL_FUENTE_KEPLER = 'caja_fuente';

/**
 * Agenda `trabajo` al aviso: a lo más una mirada por espera, con la firma de antes y la de ahora. La firma
 * nueva se guarda sólo si el trabajo terminó bien: si falla, la siguiente mirada lo reintenta.
 */
export class MiradaAlAviso {
  private pendiente: ReturnType<typeof setTimeout> | null = null;
  private ultimaFirma: string | null = null;

  constructor(
    private readonly esperaMs: number,
    private readonly firma: () => Promise<string>,
    private readonly trabajo: (cambio: boolean) => Promise<void>,
    private readonly alFallar: (e: unknown) => void,
  ) {}

  /** Un aviso: agenda una mirada si no hay una ya agendada. */
  avisar(): void {
    if (this.pendiente) return;
    this.pendiente = setTimeout(() => {
      this.pendiente = null;
      this.mirar().catch(this.alFallar);
    }, this.esperaMs);
  }

  /** Mira ya: calcula la firma y corre el trabajo diciendo si cambió. */
  async mirar(): Promise<void> {
    const f = await this.firma();
    await this.trabajo(f !== this.ultimaFirma);
    this.ultimaFirma = f;
  }

  detener(): void {
    if (this.pendiente) clearTimeout(this.pendiente);
    this.pendiente = null;
  }
}
