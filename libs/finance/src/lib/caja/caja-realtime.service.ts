import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PgListenService } from '@megadulces/platform-core';
import { CajaGateway } from './caja.gateway';

/** El canal de Postgres. Lo emite `database/importers/kepler/refresh-caja-matview.js`. */
export const CANAL_CAJA = 'caja_movimientos';

/**
 * CG.23.2 — El puente: `NOTIFY` de Postgres → WebSocket de la pantalla.
 *
 * ── Qué problema resuelve ───────────────────────────────────────────────────────────────────
 * Medido el 2026-09-23, la cadena completa de un movimiento de caja era:
 *
 *   Kepler sucursal → repl. lógica ────────────────── segundos
 *     → `ods-live-hot --watch=15` → `kepler_ods.kdm1` ── hasta 15 s
 *     → VISTA `analytics.kepler_bank_movements` ─────── 0 (es en vivo)
 *     → MATVIEW `analytics.mv_caja_movimientos` ─────── hasta 60 s (cron `* * * * *`)
 *     → pantalla ────────────────────────────────────── **∞**
 *
 * El último tramo era el peor y no estaba escrito en ningún lado: `cargarPendientes()` sólo
 * corría al entrar a la pantalla o después de guardar. Una caja abierta toda la mañana mostraba
 * la foto del momento en que se abrió, **sin ningún aviso de que estaba vieja**.
 *
 * ── Lo que este puente NO hace ──────────────────────────────────────────────────────────────
 * ⚠️ `LISTEN` **no acorta el carril**. Cambia "la pantalla nunca se entera" por "la pantalla se
 * entera en cuanto el dato existe", y nada más: el piso sigue siendo lo que tardan el carril del
 * ODS y el refresh del matview. Prometer "al segundo" sólo con esto sería vender un tramo por la
 * cadena entera.
 *
 * ── Por qué el aviso no trae los movimientos ────────────────────────────────────────────────
 * `NOTIFY` no se persiste: lo emitido mientras nadie escucha se pierde. Si el aviso trajera el
 * dato, un socket caído durante 3 s sería un movimiento que **nunca** aparece. Por eso el aviso
 * sólo trae la FIRMA del corte (filas, último folio, última captura): la pantalla compara contra
 * lo que ya tiene y va a buscar si difiere. El dato siempre viaja por HTTP, que sí se puede
 * repetir, y la pantalla mantiene además un repaso lento por si el socket se quedó mudo.
 */
@Injectable()
export class CajaRealtimeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CajaRealtimeService.name);
  private dejarDeEscuchar: (() => void) | null = null;

  constructor(
    private readonly listen: PgListenService,
    private readonly gateway: CajaGateway,
  ) {}

  onModuleInit(): void {
    try {
      this.dejarDeEscuchar = this.listen.escuchar(CANAL_CAJA, (payload) => this.reenviar(payload));
      this.logger.log(`Escuchando ${CANAL_CAJA} → WS /caja`);
    } catch (e: unknown) {
      // No tumba el arranque: sin avisos en vivo la pantalla sigue andando con su repaso lento.
      this.logger.warn(`No se pudo escuchar ${CANAL_CAJA}: ${(e as Error)?.message}`);
    }
  }

  onModuleDestroy(): void {
    this.dejarDeEscuchar?.();
    this.dejarDeEscuchar = null;
  }

  /**
   * Un aviso del refresh. El payload viene de FUERA del API (lo escribe el carril), así que se
   * trata como entrada no confiable: si no parsea o no trae tenant, se descarta con un aviso —
   * nunca se empuja a una room adivinada.
   */
  private reenviar(payload: string): void {
    let d: Record<string, unknown>;
    try { d = JSON.parse(payload || '{}'); }
    catch { this.logger.warn(`payload de ${CANAL_CAJA} no es JSON; descartado`); return; }

    const tenantId = typeof d['tenant_id'] === 'string' ? d['tenant_id'] : null;
    if (!tenantId) { this.logger.warn(`payload de ${CANAL_CAJA} sin tenant_id; descartado`); return; }

    this.gateway.emitChange(tenantId, {
      origen: 'feed',
      filas: Number.isFinite(Number(d['filas'])) ? Number(d['filas']) : null,
      max_folio: d['max_folio'] == null ? null : String(d['max_folio']),
      max_captura: d['max_captura'] == null ? null : String(d['max_captura']),
      datos_al: d['datos_al'] == null ? null : String(d['datos_al']),
    });
  }
}
