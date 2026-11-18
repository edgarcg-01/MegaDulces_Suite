import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { MiradaAlAviso, PgListenService } from '@megadulces/platform-core';
import { ResultadoDelLazo, SolicitudGastoService } from './solicitud-gasto.service';

/** El canal que avisan `tg_solicitud_suite_ins`/`_upd` sobre `kepler_ods.kdm1` (migración 20261118085331). */
export const CANAL_SOLICITUD = 'solicitud_gasto_kepler';
/**
 * Lo que se espera tras el primer aviso antes de mirar: junta la cabecera y su reescritura de la misma pasada de la
 * ingesta. El lazo cuesta milisegundos (las huérfanas, 12 ms medidos en prod el 2026-11-17); la espera la fija la
 * frescura: el vale se entera de su folio o de su cancelación ~5 s después de que el ODS la recibe.
 */
export const ESPERA_SOLICITUD_MS = 5_000;

/**
 * `[PGP.122]` R1 por EVENTO (anexo S §17.6). Edgar, 2026-11-10: «ningún cron».
 *
 * Los disparadores de `kepler_ods.kdm1` avisan `solicitud_gasto_kepler` cuando llega una X-A-15 con la marca de la
 * Suite o le cambia el estado. Este servicio junta los avisos (`MiradaAlAviso`) y corre `SolicitudGastoService.lazo()`:
 * `written → seen_in_ods`, la cancelación en Kepler llega al vale, las huérfanas. No hay cola: el lazo lee el estado de
 * verdad, así que un aviso perdido no pierde nada — mira también al arrancar y cada vez que el `LISTEN` vuelve.
 *
 * ⚠️ El ciclo de 5 min de `SolicitudGastoService` SIGUE como árbitro (y para reintentar escrituras y revisar contadores):
 * lo que él todavía encuentre es lo que el aviso no vio, y su latido lo dice. Se retira del lazo con 30 días en cero.
 *
 * Sólo escucha en el worker (`WORKER=true`). Se apaga entero con `DISABLE_SOLICITUD_POR_EVENTO=true`.
 */
@Injectable()
export class SolicitudPorEventoService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SolicitudPorEventoService.name);
  private mirada: MiradaAlAviso | null = null;
  private dejarDeEscuchar: (() => void) | null = null;
  private dejarDeVolver: (() => void) | null = null;
  private avisos = 0;

  constructor(
    private readonly solicitudes: SolicitudGastoService,
    private readonly listen: PgListenService,
  ) {}

  onModuleInit(): void {
    if (process.env.DISABLE_SOLICITUD_POR_EVENTO === 'true') { this.logger.log('solicitud por evento APAGADA (DISABLE_SOLICITUD_POR_EVENTO)'); return; }
    if (process.env.WORKER !== 'true') { this.logger.log(`no escucho ${CANAL_SOLICITUD}: este proceso no es el worker (WORKER distinto de true)`); return; }
    this.mirada = new MiradaAlAviso(
      ESPERA_SOLICITUD_MS,
      async () => String(this.avisos),
      async () => { await this.pasar(); },
      (e) => this.logger.error(`solicitud por evento: la pasada falló: ${(e as Error)?.message} — el árbitro de 5 min la vuelve a intentar`),
    );
    try {
      this.dejarDeEscuchar = this.listen.escuchar(CANAL_SOLICITUD, () => { this.avisos++; this.mirada?.avisar(); });
      this.dejarDeVolver = this.listen.alConectar(() => this.mirada?.avisar());
      this.logger.log(`escuchando ${CANAL_SOLICITUD} (sin reloj): el lazo de la solicitud de gasto escrita en Kepler`);
    } catch (e: unknown) {
      this.logger.error(`no se pudo escuchar ${CANAL_SOLICITUD}: ${(e as Error)?.message} — sólo queda el árbitro de 5 min`);
    }
    this.mirada.avisar(); // la primera mirada: lo que cambió con el proceso abajo
  }

  onModuleDestroy(): void {
    this.dejarDeEscuchar?.();
    this.dejarDeEscuchar = null;
    this.dejarDeVolver?.();
    this.dejarDeVolver = null;
    this.mirada?.detener();
    this.mirada = null; // un aviso que llegue tarde ya no agenda nada
  }

  /** Una pasada del lazo; al log sólo si movió algo o hay algo que ver. */
  async pasar(): Promise<ResultadoDelLazo> {
    const r = await this.solicitudes.lazo();
    if (r.vistos_en_ods || r.canceladas_en_kepler || r.huerfanas.length || r.canceladas_firmadas || r.sin_ver_30min) {
      this.logger.log(`solicitud por evento: ${r.vistos_en_ods} vistas en el ODS · ${r.canceladas_en_kepler} canceladas en Kepler`
        + ` (${r.canceladas_firmadas} con el vale firmado) · ${r.huerfanas.length} sin vale · ${r.sin_ver_30min} sin ver tras 30 min`);
    }
    return r;
  }
}
