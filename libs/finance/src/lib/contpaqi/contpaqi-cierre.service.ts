import { Injectable, Logger } from '@nestjs/common';
import {
  TenantKnexService, TenantContextService, evalInput, composeFreshness,
} from '@megadulces/platform-core';
import {
  clasificarKpi, umbralPara, ORDEN_KPI_ESTADO,
  type KpiEstado, type KpiUmbral, type Freshness, type Coverage,
} from '@megadulces/contracts';

/**
 * `[CPA.0]` — **El semáforo de cierre contable: qué mes está asentado en ContPAQi y cuál no.**
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────────────────────
 * Medido contra prod el 2026-10-10: **septiembre-2026 no tiene póliza de compras**. Se pagaron
 * $30,334,529 a proveedores y se registraron $0 de compras; el pasivo `2120` cayó de $109.9 M a
 * $51.7 M sin que nadie comprara menos. **Nadie se enteró.** Se encontró con una consulta a mano,
 * el día 10 y por casualidad. Esto es lo que lo habría gritado el día 1.
 *
 * ── ⭐ Lo que este servicio NO hace: inventar un clasificador ───────────────────────────────
 * El veredicto lo emite `clasificarKpi()` de `[CDRP.2]`, contra un umbral que vive en
 * `analytics.kpi_thresholds`. Es deliberado y es la regla de ADR-056: *un primitivo inventado en
 * una fase no cierra la fase*. Acá ya había un clasificador bien hecho, con sus cinco estados y
 * su prueba negativa; escribir el sexto habría sido el sexto.
 *
 * Y de ahí sale la propiedad que importa: **sin umbral registrado el estado es `sin_meta`, nunca
 * `ok`**. Ése es el `cfg ? classify : 'ok'` que la Fase VP encontró dando verde incondicional a
 * tres matvistas del sell-out.
 *
 * ── Las tres reglas propias, y por qué cada una ─────────────────────────────────────────────
 *  1. ⭐ **El mes en curso NO se juzga.** Está incompleto por definición: el día 3 de cualquier
 *     mes, compras va en cero porque todavía no pasó el mes, no porque falte la póliza. Un
 *     tablero que se pone rojo todos los días 1 enseña a ignorarlo, y entonces el mes que de
 *     verdad falta no lo ve nadie. Sale `sin_medir` con motivo, **no `bad`**.
 *  2. ⛔ **El provisional no cuenta como asentado.** La vista ya lo excluye de la señal; acá sólo
 *     se publica aparte. Medido: octubre trae $36.8 M de ventas fechadas en el futuro — si
 *     entraran, el mes se vería cerrado sin estarlo.
 *  3. ⚠️ **El peor estado del mes manda en el encabezado**, usando `ORDEN_KPI_ESTADO`, que pone
 *     `ok` al final a propósito: un tablero ordenado por estado no puede esconder lo que nadie
 *     puede juzgar.
 *
 * ── ⚠️ Rendimiento, declarado y no escondido ────────────────────────────────────────────────
 * La vista mide **938 ms** contra prod hoy, por encima del gate de 500 ms. ~450 ms de eso son el
 * `Seq Scan` de `fiscal.cfdis` (460 MB de heap porque carga `xml`/`pdf`/`raw`), y lo cierra el
 * índice cubriente de la migración `..._cfdis_indice_mes_cubriente`, que **va fuera de horario**.
 * Hasta entonces el servicio devuelve `query_ms` y la pantalla lo muestra: un tiempo que molesta
 * y se ve es un problema; uno que molesta y no se ve es una sorpresa.
 */

/** Lo que la vista publica por (mes × familia), antes de clasificar. */
interface FilaCierre {
  anio_mes: string;
  familia: string;
  etiqueta: string;
  senal_cuentas: string;
  senal: string;
  senal_renglones: number;
  provisional: string | null;
  testigo: string | null;
  testigo_fuente: string | null;
  cobertura_base: 'testigo' | 'historia';
  mediana_6m: string | null;
  cobertura: string | null;
  periodo_estado: 'cerrado' | 'en_curso';
  data_as_of: string | null;
}

export interface FamiliaCierre {
  familia: string;
  etiqueta: string;
  senal_cuentas: string;
  senal: number;
  senal_renglones: number;
  provisional: number | null;
  testigo: number | null;
  testigo_fuente: string | null;
  cobertura_base: 'testigo' | 'historia';
  mediana_6m: number | null;
  cobertura: number | null;
  estado: KpiEstado;
  motivo: string | null;
  escala_a: string | null;
  /** El umbral que se aplicó, para que la pantalla pueda explicar el color sin adivinarlo. */
  umbral: { target: number; warn_at: number; escalate_at: number } | null;
}

export interface MesCierre {
  anio_mes: string;
  periodo_estado: 'cerrado' | 'en_curso';
  /** El peor de sus familias (`ORDEN_KPI_ESTADO`): lo que se pinta en el renglón del mes. */
  estado: KpiEstado;
  /** Cuántas familias hay en cada estado, para el resumen sin tener que recorrer el detalle. */
  conteo: Record<KpiEstado, number>;
  familias: FamiliaCierre[];
}

export interface RespuestaCierre {
  meses: MesCierre[];
  freshness: Freshness;
  coverage: Coverage;
  /** Milisegundos reales de la consulta. Se publica aunque incomode (ver cabecera). */
  query_ms: number;
}

const PREFIJO_KPI = 'cierre_contable.';
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
      const filas = (await trx('analytics.v_contpaqi_cierre_mensual')
        .whereBetween('anio_mes', [desde, hasta])
        .orderBy([{ column: 'anio_mes', order: 'desc' }, { column: 'familia', order: 'asc' }])
      ) as unknown as FilaCierre[];

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

    // Los umbrales llegan de Postgres como `string` (numeric). `clasificarKpi` compara números:
    // sin esto, '0.50' >= 0.9045 haría comparación de TEXTO y el semáforo mentiría en silencio.
    const reglas: KpiUmbral[] = umbrales.map((u) => ({
      kpi_key: String(u.kpi_key),
      position_code: (u.position_code as string | null) ?? null,
      period: u.period as KpiUmbral['period'],
      target: Number(u.target),
      warn_at: Number(u.warn_at),
      escalate_at: Number(u.escalate_at),
      direction: u.direction as KpiUmbral['direction'],
      escalate_to: (u.escalate_to as string | null) ?? null,
      source: String(u.source),
      manual_lock: Boolean(u.manual_lock),
      auto_tuned_at: (u.auto_tuned_at as string | null) ?? null,
    }));

    const porMes = new Map<string, MesCierre>();
    let dataAsOf: string | null = null;

    for (const f of filas) {
      if (f.data_as_of && (!dataAsOf || f.data_as_of > dataAsOf)) dataAsOf = f.data_as_of;

      const umbral = umbralPara(reglas, PREFIJO_KPI + f.familia, null, 'mes');
      const cobertura = f.cobertura === null ? null : Number(f.cobertura);

      // Regla 1: el mes en curso no se juzga. Se declara, que no es lo mismo que aprobarlo.
      const veredicto = f.periodo_estado === 'en_curso'
        ? {
            estado: 'sin_medir' as KpiEstado,
            motivo: 'Mes en curso: todavía no terminó, así que no se puede decir si está asentado.',
            escala_a: null,
          }
        : clasificarKpi(cobertura, umbral);

      const fam: FamiliaCierre = {
        familia: f.familia,
        etiqueta: f.etiqueta,
        senal_cuentas: f.senal_cuentas,
        senal: Number(f.senal),
        senal_renglones: f.senal_renglones,
        provisional: f.provisional === null ? null : Number(f.provisional),
        testigo: f.testigo === null ? null : Number(f.testigo),
        testigo_fuente: f.testigo_fuente,
        cobertura_base: f.cobertura_base,
        mediana_6m: f.mediana_6m === null ? null : Number(f.mediana_6m),
        cobertura,
        estado: veredicto.estado,
        motivo: veredicto.motivo,
        escala_a: veredicto.escala_a,
        umbral: umbral
          ? { target: umbral.target, warn_at: umbral.warn_at, escalate_at: umbral.escalate_at }
          : null,
      };

      let mes = porMes.get(f.anio_mes);
      if (!mes) {
        mes = {
          anio_mes: f.anio_mes,
          periodo_estado: f.periodo_estado,
          estado: 'sin_medir',
          conteo: { ok: 0, warn: 0, bad: 0, sin_meta: 0, sin_medir: 0 },
          familias: [],
        };
        porMes.set(f.anio_mes, mes);
      }
      mes.familias.push(fam);
      mes.conteo[fam.estado] += 1;
    }

    // Regla 3: el encabezado del mes lo manda el PEOR de sus familias.
    const meses = [...porMes.values()];
    for (const m of meses) {
      m.estado = m.familias.reduce<KpiEstado>(
        (peor, f) => (ORDEN_KPI_ESTADO[f.estado] < ORDEN_KPI_ESTADO[peor] ? f.estado : peor),
        'ok',
      );
    }

    const sinUmbral = new Set(
      filas.filter((f) => !umbralPara(reglas, PREFIJO_KPI + f.familia, null, 'mes')).map((f) => f.familia),
    );
    const familiasVistas = new Set(filas.map((f) => f.familia));

    return {
      meses,
      // La frescura es la del carril que alimenta la señal. ⚠️ No se mide con `now()`: eso diría
      // "recién medido" por el solo hecho de haber contestado (Fase VP, 21 de 24 píldoras).
      freshness: composeFreshness([
        evalInput('contpaqi', 'Pólizas de ContPAQi (carril @1 min)', dataAsOf, HORAS_FRESCURA),
      ]),
      coverage: {
        measured: familiasVistas.size > 0,
        pct: familiasVistas.size === 0
          ? null
          : +(((familiasVistas.size - sinUmbral.size) / familiasVistas.size) * 100).toFixed(1),
        note: [
          `Cubre ${familiasVistas.size} familias contables; nómina depende de la Fase RH y el resto `
          + 'del libro (pagos sueltos, reclasificaciones) no tiene señal propia todavía.',
          sinUmbral.size
            ? `⛔ SIN UMBRAL registrado: ${[...sinUmbral].join(', ')} — salen "sin_meta", no verdes.`
            : 'Las familias medidas tienen umbral registrado con procedencia.',
        ].join(' '),
      },
      query_ms,
    };
  }
}

/** `YYYY-MM` de una fecha, en hora local del servidor (TZ del backend: America/Mexico_City). */
function mesDe(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** `YYYY-MM` n meses antes. Aritmética sobre el número de mes, sin `Date` para no cruzar husos. */
function mesMenos(mes: string, n: number): string {
  const [y, m] = mes.split('-').map(Number);
  const total = y * 12 + (m - 1) - n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
}
