import { Knex } from 'knex';

/**
 * `[RE.69]` — **El apareo de gemelas y el aviso de entradas nuevas corren al llegar el dato, no por reloj.**
 * Edgar, 2026-11-10: «ningún cron».
 *
 * Antes eran dos `@Cron` cada 5 minutos (`GoodsReceiptTwinsService` y `GoodsReceiptsWatcherService`, 576
 * corridas al día haya o no compras) más el barrido histórico diario de la ingesta. El dato ya avisa:
 * `services/feeds-ingest/apply-handlers.js` emite `pg_notify('caja_fuente', …)` después del COMMIT de cada
 * UPSERT que cambia de verdad `kepler_ods.kdm1` (sin churn), y `analytics.erp_goods_receipts` es una VISTA
 * viva sobre `kdm1`: cuando llega el aviso, la entrada ya está.
 *
 * ── Por qué una firma y no correr con cada aviso (medido en prod, 2026-11-10) ───────────────────────
 * `caja_fuente` avisa por CUALQUIER documento de `kdm1` —ventas, caja, compras—: 15 avisos en 90 s en horario
 * hábil. Aparear con cada uno (≈3 s, ventana de 45 días) costaría más que el cron. Así que el aviso sólo
 * AGENDA una mirada (a lo más una por `RECEIPTS_AVISO_S`, 30 s por defecto; los avisos de en medio se
 * absorben, y una ráfaga continua no la puede posponer para siempre), y la mirada calcula una firma barata
 * de las entradas de Kepler: si no cambió, no hay nada que aparear ni que anunciar. La firma cuesta 17 ms
 * (índice `ix_kdm1_compra_fecha`); la misma pregunta sobre la vista, 220 ms.
 *
 * ⚠️ La firma es un DETECTOR de cambio, no la definición de «entrada»: ésa es la vista. Mira las X-A-20 de
 * `kdm1` (de ahí sale la vista para Kepler). Lo que NO ve: las entradas de Wincaja (sucursales 30/32/50),
 * que no pasan por `kdm1`; se recogen en la siguiente mirada que dispare un cambio de Kepler.
 *
 * ⚠️ `NOTIFY` no se persiste: lo que se emite mientras nadie escucha se pierde. Por eso cada proceso mira
 * una vez al arrancar (sin firma previa → corre), que recoge lo que pasó mientras estuvo abajo.
 */
export const CANAL_FUENTE_KEPLER = 'caja_fuente';

/** Lo que se espera tras el primer aviso antes de mirar. Configurable con `RECEIPTS_AVISO_S` (1–600). */
export function esperaAvisoMs(): number {
  const v = Number(String(process.env.RECEIPTS_AVISO_S ?? '').trim());
  return Number.isFinite(v) && v > 0 ? Math.min(v, 600) * 1000 : 30_000;
}

/** Firma de las entradas de Kepler de los últimos `dias`: conteo, importe, folio máximo y canceladas. */
export async function firmaEntradas(knex: Knex, dias: number): Promise<string> {
  const r = await knex.raw<{ rows: { n: number; s: string; f: string | null; canc: number }[] }>(
    `SELECT count(*)::int AS n, COALESCE(sum(c16), 0)::text AS s, max(btrim(c6)) AS f,
            count(*) FILTER (WHERE c43 = 'C')::int AS canc
       FROM kepler_ods.kdm1
      WHERE c2 = 'X' AND c3 = 'A' AND c4 = 20 AND c9::date >= current_date - ?::int`,
    [dias],
  );
  const x = r.rows[0];
  return x ? `${x.n}|${x.s}|${x.f ?? ''}|${x.canc}` : '';
}

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
