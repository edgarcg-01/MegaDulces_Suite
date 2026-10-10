import { Injectable, Logger } from '@nestjs/common';
import {
  TenantKnexService, TenantContextService, evalInput, composeFreshness,
} from '@megadulces/platform-core';
import type { Freshness, Coverage } from '@megadulces/contracts';
import {
  armarCierre, familiasSinUmbral, normalizarUmbrales, mesDe, mesMenos, PREFIJO_KPI,
  type FilaCierreCruda, type MesCierre,
} from './cierre.engine';

/**
 * `[CPA.0]` — **El semáforo de cierre contable: la I/O alrededor de la regla.**
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────────────────────
 * Medido contra prod el 2026-10-10: **septiembre-2026 no tiene póliza de compras**. Se pagaron
 * $30,334,529 a proveedores y se registraron $0 de compras; el pasivo `2120` cayó de $109.9 M a
 * $51.7 M sin que nadie comprara menos. **Nadie se enteró.** Se encontró con una consulta a mano,
 * el día 10 y por casualidad. Esto es lo que lo habría gritado el día 1.
 *
 * ── Qué hace, y qué NO ──────────────────────────────────────────────────────────────────────
 * Acá sólo hay tres cosas: leer la vista, leer los umbrales y componer la procedencia. **Toda la
 * regla vive en `cierre.engine.ts`**, que es puro y tiene su propio candado — mismo reparto que
 * `cuadre.engine.ts` / `contpaqi-cuadre.service.ts` (`[CP.8.10]`).
 *
 * ⭐ Y el veredicto no es de esta fase: lo emite `clasificarKpi()` de `[CDRP.2]` contra un umbral
 * de `analytics.kpi_thresholds`. Es ADR-056: *un primitivo inventado en una fase no cierra la
 * fase*. Acá ya había un clasificador bien hecho con sus cinco estados y su prueba negativa;
 * escribir el sexto habría sido el sexto. De ahí sale la propiedad que importa: **sin umbral
 * registrado el estado es `sin_meta`, nunca `ok`** — el `cfg ? classify : 'ok'` que la Fase VP
 * encontró dando verde incondicional a tres matvistas del sell-out.
 *
 * ── ⚠️ Rendimiento, declarado y no escondido ────────────────────────────────────────────────
 * La vista mide **938 ms** contra prod hoy, por encima del gate de 500 ms. ~450 ms de eso son el
 * `Seq Scan` de `fiscal.cfdis` (460 MB de heap porque carga `xml`/`pdf`/`raw`), y lo cierra el
 * índice cubriente de la migración `..._cfdis_indice_mes_cubriente`, que **va fuera de horario**.
 * Hasta entonces el servicio devuelve `query_ms` y la pantalla lo muestra: un tiempo que molesta
 * y se ve es un problema; uno que molesta y no se ve es una sorpresa.
 */

export type { FamiliaCierre, MesCierre } from './cierre.engine';

export interface RespuestaCierre {
  meses: MesCierre[];
  freshness: Freshness;
  coverage: Coverage;
  /** Milisegundos reales de la consulta. Se publica aunque incomode (ver cabecera). */
  query_ms: number;
}

const VISTA = 'analytics.v_contpaqi_cierre_mensual';
/** El carril `contpaqi` corre @1 min; 6 h de tolerancia es holgado y deja ver una caída real. */
const HORAS_FRESCURA = 6;

@Injectable()
export class ContpaqiCierreService {
  private readonly logger = new Logger(ContpaqiCierreService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /**
   * El semáforo, de `desde` a `hasta` (`YYYY-MM`). Por omisión, los últimos 13 meses: doce para
   * comparar y el que corre.
   *
   * ⚠️ El filtro se aplica **afuera** de la vista a propósito. La mediana de 6 meses de `gastos` y
   * `nomina` se calcula dentro con la historia completa; empujar el filtro hacia adentro la
   * dejaría sin meses que promediar justo en el borde de la ventana.
   */
  async cierre(opts: { desde?: string; hasta?: string } = {}): Promise<RespuestaCierre> {
    this.tenantCtx.requireTenantId();

    const hasta = opts.hasta ?? mesDe(new Date());
    const desde = opts.desde ?? mesMenos(hasta, 12);

    const t0 = Date.now();
    const { filas, umbrales } = await this.tk.run(async (trx) => {
      const filas = (await trx(VISTA)
        .whereBetween('anio_mes', [desde, hasta])
        .orderBy([{ column: 'anio_mes', order: 'desc' }, { column: 'familia', order: 'asc' }])
      ) as unknown as Array<FilaCierreCruda & { data_as_of: string | null }>;

      const umbrales = (await trx('analytics.kpi_thresholds')
        .whereNull('deleted_at')
        .where('kpi_key', 'like', `${PREFIJO_KPI}%`)
        .select(
          'kpi_key', 'position_code', 'period', 'target', 'warn_at', 'escalate_at',
          'direction', 'escalate_to', 'source', 'manual_lock', 'auto_tuned_at',
        )) as unknown as Array<Record<string, unknown>>;

      return { filas, umbrales };
    });
    const query_ms = Date.now() - t0;

    const reglas = normalizarUmbrales(umbrales);
    const meses = armarCierre(filas, reglas);

    const sinUmbral = familiasSinUmbral(filas, reglas);
    const familias = new Set(filas.map((f) => f.familia));
    const dataAsOf = filas.reduce<string | null>(
      (max, f) => (f.data_as_of && (!max || f.data_as_of > max) ? f.data_as_of : max), null,
    );

    return {
      meses,
      // La frescura es la del carril que alimenta la señal. ⚠️ No se mide con `now()`: eso diría
      // "recién medido" por el solo hecho de haber contestado (Fase VP, 21 de 24 píldoras).
      freshness: composeFreshness([
        evalInput('contpaqi', 'Pólizas de ContPAQi (carril @1 min)', dataAsOf, HORAS_FRESCURA),
      ]),
      coverage: {
        measured: familias.size > 0,
        pct: familias.size === 0
          ? null
          : +(((familias.size - sinUmbral.length) / familias.size) * 100).toFixed(1),
        note: [
          `Cubre ${familias.size} familias contables; nómina depende de la Fase RH y el resto `
          + 'del libro (pagos sueltos, reclasificaciones) no tiene señal propia todavía.',
          sinUmbral.length
            ? `⛔ SIN UMBRAL registrado: ${sinUmbral.join(', ')} — salen "sin_meta", no verdes.`
            : 'Las familias medidas tienen umbral registrado con procedencia.',
        ].join(' '),
      },
      query_ms,
    };
  }
}
