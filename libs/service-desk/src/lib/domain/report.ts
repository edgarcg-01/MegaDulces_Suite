/**
 * `[MS.3.5]` El reporte de la Mesa de Servicio. Función PURA sobre las filas de tickets. ADR-081.
 *
 * Responde lo que la coordinación necesita para decidir: ¿se está cumpliendo el SLA?, ¿cuánto tardamos en
 * contestar y en resolver?, ¿dónde se concentran los problemas?, ¿qué se repite? No toca la base ni el reloj: la
 * lectura vive en `reports.service.ts` y `ahora` se inyecta (una prueba que depende de `Date.now()` cambia con el
 * calendario).
 *
 * ── Lo que NO hace, a propósito ──────────────────────────────────────────────────────────────
 *  · **No mide a las personas.** No hay ranking por asignado: con un equipo de dos o tres, «quién resolvió más»
 *    es una comparación injusta que se vuelve la métrica, y el reporte existe para mejorar el SERVICIO.
 *  · **No dibuja ceros.** Un cumplimiento sin tickets que juzgar es `null`, no 0 %; un tiempo sin muestras es
 *    `null`, no 0 minutos. `en_plazo` (todavía no vence) y `sin_plazo` se cuentan APARTE del cumplimiento:
 *    mezclarlos lo inflaría con lo que aún no se puede juzgar.
 *  · **No usa los marcadores del barrido** (`sla_*_breached_at`): ese cron corre cada 5 min y puede estar parado.
 *    El incumplimiento se calcula acá contra el plazo del propio ticket, así el reporte no depende de que otro
 *    proceso haya corrido.
 *
 * ── Cómo se juzga un plazo ───────────────────────────────────────────────────────────────────
 *  · primera respuesta: cumplida si `first_responded_at <= first_response_due_at`. Que un ticket se asigne SOLO
 *    por una regla NO es una respuesta (queda en null hasta que alguien actúa), así que un ticket auto-asignado que
 *    nadie ha tocado cuenta como incumplido en cuanto vence — es justo lo que se quiere ver.
 *  · resolución: cumplida si `resolved_at <= due_at` (el `due_at` ya trae empujadas las pausas del solicitante).
 *  · los CANCELADOS salen de los dos: un ticket que se cancela no se «incumplió».
 *  · los tiempos usan el reloj de la política de SU prioridad (hábil o corrido) y, en la resolución, descuentan lo
 *    que estuvo en espera del solicitante (`paused_minutes`, que ya viene en minutos de esa misma política).
 */
import type {
  SdPriority,
  SdReportBranchRow,
  SdReportCategoryRow,
  SdReportPriorityRow,
  SdReportRecurringRow,
  SdReportResponse,
  SdReportTiming,
  SdSlaCompliance,
} from '@megadulces/contracts';
import { SD_PRIORITIES } from '@megadulces/contracts';
import { clockMinutesBetween, type BusinessCalendar } from './business-clock';
import type { PoliticaSla } from './sla';

export interface FilaReporte {
  priority: SdPriority;
  category_id: string;
  category_name: string;
  warehouse_code: string | null;
  status: string;
  created_at: Date | string;
  first_responded_at: Date | string | null;
  first_response_due_at: Date | string | null;
  resolved_at: Date | string | null;
  due_at: Date | string | null;
  paused_minutes: number | string;
  reopened_count: number | string;
}

export interface ConfigReporte {
  calendar: BusinessCalendar;
  policies: Readonly<Record<SdPriority, PoliticaSla>>;
}

/** Cuántas veces tiene que repetirse una categoría en una sucursal para llamarse «recurrente». */
export const MIN_RECURRENTE = 3;
export const TOPE_RECURRENTES = 10;
export const TOPE_CATEGORIAS = 15;

const ms = (d: Date | string | null | undefined): number | null => (d ? new Date(d).getTime() : null);
const pct = (num: number, den: number): number | null => (den > 0 ? Math.round((num / den) * 1000) / 10 : null);

/** Percentil por rango más cercano sobre una muestra; `null` si no hay muestra (nunca 0). */
export function percentil(muestra: readonly number[], p: number): number | null {
  if (!muestra.length) return null;
  const orden = [...muestra].sort((a, b) => a - b);
  const idx = Math.min(orden.length - 1, Math.max(0, Math.ceil((p / 100) * orden.length) - 1));
  return orden[idx];
}

export function tiempos(muestra: readonly number[]): SdReportTiming {
  return { n: muestra.length, p50: percentil(muestra, 50), p90: percentil(muestra, 90) };
}

type Veredicto = 'cumplido' | 'incumplido' | 'en_plazo' | 'sin_plazo';

/** Juzga un plazo: `hecho` es cuándo se cumplió (o `null` si todavía no), `plazo` cuándo vencía. */
export function juzgarPlazo(hecho: number | null, plazo: number | null, ahora: number): Veredicto {
  if (plazo === null) return 'sin_plazo';
  if (hecho !== null) return hecho <= plazo ? 'cumplido' : 'incumplido';
  return ahora > plazo ? 'incumplido' : 'en_plazo';
}

class Cuenta {
  cumplidos = 0;
  incumplidos = 0;
  en_plazo = 0;
  sin_plazo = 0;
  sumar(v: Veredicto): void {
    if (v === 'cumplido') this.cumplidos++;
    else if (v === 'incumplido') this.incumplidos++;
    else if (v === 'en_plazo') this.en_plazo++;
    else this.sin_plazo++;
  }
  dto(): SdSlaCompliance {
    return {
      cumplidos: this.cumplidos,
      incumplidos: this.incumplidos,
      en_plazo: this.en_plazo,
      sin_plazo: this.sin_plazo,
      cumplimiento_pct: pct(this.cumplidos, this.cumplidos + this.incumplidos),
    };
  }
}

export interface OpcionesReporte {
  desde: string;
  hasta: string;
  ahora: number;
  truncado: boolean;
  /** `warehouse_code` → nombre. Se inyecta para que esta función no dependa de un catálogo de sucursales. */
  nombreSucursal: (code: string) => string | null;
}

export function armarReporte(filas: readonly FilaReporte[], cfg: ConfigReporte, o: OpcionesReporte): SdReportResponse {
  const totalCuenta = { primera: new Cuenta(), resolucion: new Cuenta() };
  const porPrioridad = new Map<SdPriority, { creados: number; resueltos: number; p: Cuenta; r: Cuenta; tp: number[]; tr: number[] }>();
  for (const pr of SD_PRIORITIES) porPrioridad.set(pr, { creados: 0, resueltos: 0, p: new Cuenta(), r: new Cuenta(), tp: [], tr: [] });
  const porCategoria = new Map<string, { name: string; creados: number; resueltos: number; incumplidos: number; reabiertos: number; tr: number[] }>();
  const porSucursal = new Map<string, { code: string | null; creados: number; resueltos: number; incumplidos: number }>();
  const repetidas = new Map<string, { category_id: string; category_name: string; code: string | null; n: number }>();

  let resueltos = 0;
  let abiertos = 0;
  let cancelados = 0;
  let reabiertos = 0;
  let sinPoliticaDePrioridad = 0;

  for (const f of filas) {
    const creado = ms(f.created_at) as number;
    const esCancelado = f.status === 'cancelado';
    const esResuelto = f.resolved_at !== null && f.resolved_at !== undefined;
    const reab = Number(f.reopened_count) > 0;
    if (esCancelado) cancelados++;
    else if (esResuelto) resueltos++;
    else abiertos++;
    if (reab) reabiertos++;

    const pr = porPrioridad.get(f.priority);
    const pol = cfg.policies[f.priority];
    if (!pr || !pol) {
      sinPoliticaDePrioridad++;
      continue;
    }
    pr.creados++;
    if (esResuelto && !esCancelado) pr.resueltos++;

    // Categoría, sucursal y recurrentes cuentan TODOS los creados (también los cancelados: son demanda).
    const cat = porCategoria.get(f.category_id) ?? { name: f.category_name, creados: 0, resueltos: 0, incumplidos: 0, reabiertos: 0, tr: [] };
    cat.creados++;
    if (reab) cat.reabiertos++;
    porCategoria.set(f.category_id, cat);
    const claveSuc = f.warehouse_code ?? '';
    const suc = porSucursal.get(claveSuc) ?? { code: f.warehouse_code ?? null, creados: 0, resueltos: 0, incumplidos: 0 };
    suc.creados++;
    porSucursal.set(claveSuc, suc);
    const claveRep = `${f.category_id}|${claveSuc}`;
    const rep = repetidas.get(claveRep) ?? { category_id: f.category_id, category_name: f.category_name, code: f.warehouse_code ?? null, n: 0 };
    rep.n++;
    repetidas.set(claveRep, rep);

    if (esCancelado) continue; // un ticket cancelado no «incumplió» nada

    const respondido = ms(f.first_responded_at);
    const vPrimera = juzgarPlazo(respondido, ms(f.first_response_due_at), o.ahora);
    pr.p.sumar(vPrimera);
    totalCuenta.primera.sumar(vPrimera);
    if (respondido !== null) pr.tp.push(clockMinutesBetween(new Date(creado), new Date(respondido), pol.clock, cfg.calendar));

    const resuelto = esResuelto ? (ms(f.resolved_at) as number) : null;
    const vRes = juzgarPlazo(resuelto, ms(f.due_at), o.ahora);
    pr.r.sumar(vRes);
    totalCuenta.resolucion.sumar(vRes);
    if (vRes === 'incumplido') {
      cat.incumplidos++;
      suc.incumplidos++;
    }
    if (resuelto !== null) {
      cat.resueltos++;
      suc.resueltos++;
      // Descuenta lo que estuvo en espera del solicitante: no es tiempo de quien atiende. Nunca negativo.
      const bruto = clockMinutesBetween(new Date(creado), new Date(resuelto), pol.clock, cfg.calendar);
      const neto = Math.max(0, bruto - Number(f.paused_minutes || 0));
      pr.tr.push(neto);
      cat.tr.push(neto);
    }
  }

  const por_prioridad: SdReportPriorityRow[] = SD_PRIORITIES.map((p) => {
    const x = porPrioridad.get(p) as NonNullable<ReturnType<typeof porPrioridad.get>>;
    return { priority: p, creados: x.creados, resueltos: x.resueltos, primera_respuesta: x.p.dto(), resolucion: x.r.dto(), t_primera_respuesta: tiempos(x.tp), t_resolucion: tiempos(x.tr) };
  }).reverse(); // urgente primero: es lo que más importa mirar

  const por_categoria: SdReportCategoryRow[] = [...porCategoria.entries()]
    .map(([category_id, c]) => ({ category_id, name: c.name, creados: c.creados, resueltos: c.resueltos, resolucion_incumplidos: c.incumplidos, reabiertos: c.reabiertos, t_resolucion: tiempos(c.tr) }))
    .sort((a, b) => b.creados - a.creados || a.name.localeCompare(b.name))
    .slice(0, TOPE_CATEGORIAS);

  const por_sucursal: SdReportBranchRow[] = [...porSucursal.values()]
    .map((s) => ({ warehouse_code: s.code, warehouse_name: s.code ? o.nombreSucursal(s.code) : null, creados: s.creados, resueltos: s.resueltos, resolucion_incumplidos: s.incumplidos }))
    .sort((a, b) => b.creados - a.creados || String(a.warehouse_code).localeCompare(String(b.warehouse_code)));

  const recurrentes: SdReportRecurringRow[] = [...repetidas.values()]
    .filter((r) => r.n >= MIN_RECURRENTE)
    .map((r) => ({ category_id: r.category_id, category_name: r.category_name, warehouse_code: r.code, warehouse_name: r.code ? o.nombreSucursal(r.code) : null, n: r.n }))
    .sort((a, b) => b.n - a.n || a.category_name.localeCompare(b.category_name))
    .slice(0, TOPE_RECURRENTES);

  const no_medido: string[] = [
    'Quién resolvió más o menos: el reporte mide el servicio, no a las personas.',
    'Satisfacción de quien reportó: la mesa no la pregunta todavía.',
  ];
  if (sinPoliticaDePrioridad > 0) no_medido.push(`${sinPoliticaDePrioridad} ticket(s) con una prioridad sin política de SLA configurada: quedan fuera de los plazos y de los tiempos.`);
  if (o.truncado) no_medido.push('El periodo trae más tickets de los que el reporte calcula: los números son de los más recientes. Acorta el periodo para verlos completos.');

  return {
    periodo: { desde: o.desde, hasta: o.hasta },
    medido_at: new Date(o.ahora).toISOString(),
    truncado: o.truncado,
    totales: { creados: filas.length, resueltos, abiertos, cancelados, reabiertos, reabiertos_pct: pct(reabiertos, filas.length) },
    primera_respuesta: totalCuenta.primera.dto(),
    resolucion: totalCuenta.resolucion.dto(),
    por_prioridad,
    por_categoria,
    por_sucursal,
    recurrentes,
    no_medido,
  };
}
