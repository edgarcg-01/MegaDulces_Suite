/**
 * `[PVI.12]` — El **crecimiento año-contra-año** del presupuesto de ventas, en una función PURA.
 *
 * ── Por qué este bloque y no otro ────────────────────────────────────────────────────────────
 *
 * Es la regla que decide el supuesto de crecimiento con el que se arma TODO el plan: hoy gobierna
 * **$604,775,116** de meta en el ejercicio vivo. Vivía adentro de `proposeGrowth`, enredada con
 * cuatro consultas a la base, y su única cobertura era un smoke DB-direct contra datos de
 * producción — que verifica lo que HAY, no lo que la regla HACE. Un smoke contra prod no puede
 * construir el caso límite: una entidad exactamente en el umbral, un periodo abierto, una base en
 * cero, un canal sin ninguna entidad comparable. Acá sí.
 *
 * ── La regla, y lo que costó aprenderla ──────────────────────────────────────────────────────
 *
 * ⛔ Una entidad entra al YoY **sólo si vendió en los DOS años**, medido por **cobertura de
 * periodos**, no por `monto > 0` sobre el agregado del canal. El criterio viejo tenía dos huecos y
 * los dos mentían hacia arriba:
 *
 *   1. una plaza que **nace** en el año nuevo sumaba a `b` sin contraparte en `a`;
 *   2. `> 0` no es un umbral: bastaba **una fila**.
 *
 * Medido contra prod el 2026-10-08: `mostrador:03` (8ESQ) pasó de **$230,601 a $39,240,479** con
 * venta en **1 de 9** periodos de 2025 — y pareaba. Esa sola entidad aportaba **24.28 pp** de los
 * 21.46 % que el canal publicaba; con el pareo correcto el canal **cae a −2.82 %**.
 *
 * ⭐ Una base casi-cero no es una base. Lo que así se publica es **cobertura del pipeline entrando
 *    al fact**, no negocio. `VERDAD_ABSOLUTA` §24.
 *
 * ── Lo que la función conserva a propósito ───────────────────────────────────────────────────
 *
 * `cobertura.growth_pct_todo` guarda el número VIEJO (todas las entidades) al lado del nuevo. Las
 * dos cifras contestan preguntas distintas y **ninguna es «la» verdad sin decir cuál se preguntó**;
 * publicar una sin la otra fue exactamente la forma del defecto. Y el periodo **abierto** se
 * excluye junto con los posteriores: una fracción de periodo comparada contra un periodo entero es
 * la misma trampa que el mes en curso le costó al motor de gastos (`VERDAD_ABSOLUTA` §22.5).
 */
import type { CoberturaYoY, CrecCanal } from './budget-sales-plan.service';

/** Una fila del real por entidad × año × periodo. */
export interface FilaReal {
  entity_key: string;
  channel: string;
  year: number;
  period: number;
  monto: number;
}

export interface EntradaCrecimiento {
  rows: FilaReal[];
  /** Primer periodo de `y1` que NO cerró. `null` = todos cerrados. Él y los posteriores se excluyen. */
  abierto: number | null;
  /** Año anterior (base) y año reciente (comparado). */
  y0: number;
  y1: number;
  /** Vocabulario de canales, tal como lo declara el backend (NUNCA una lista literal: `[VSO.8]`). */
  canales: string[];
  /** Respaldo para un canal cuyo YoY no se pudo calcular. */
  defaultGrowth: number;
}

export interface SalidaCrecimiento {
  by_channel: Record<string, CrecCanal>;
  global: {
    growth_pct: number;
    basis: 'yoy_paired' | 'default';
    paired_periods: number;
    periodos_abiertos_excluidos: number;
    cobertura: CoberturaYoY;
  };
  /** Cuántos periodos tiene que cubrir una entidad, EN CADA AÑO, para ser comparable. */
  min_periodos_entidad: number;
}

/** periodos apareados mínimos para confiar en un YoY (menos = tendencia no confiable → default).
 *  Protege la rampa: con un año anterior parcial, un YoY sobre 1-2 periodos da números absurdos. */
export const MIN_PAIRED_PERIODS = 4;

/** Fracción de los periodos CERRADOS que una entidad tiene que cubrir, en CADA año, para parear.
 *  No es un número redondo elegido a gusto: con 9 periodos cerrados exige 8, y es lo que deja
 *  afuera a `mostrador:03` (1 de 9) sin excluir a una entidad que faltó un solo periodo. */
export const MIN_ENTITY_COVERAGE = 0.8;

const round2 = (n: number) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const round4 = (n: number) => Math.round((Number(n) + Number.EPSILON) * 10000) / 10000;

export function calcularCrecimiento(e: EntradaCrecimiento): SalidaCrecimiento {
  const { rows, abierto, y0, y1, canales, defaultGrowth: def } = e;

  // Los periodos que SÍ cerraron: el denominador de la cobertura exigida.
  const periodosCerrados = new Set<number>();
  for (const r of rows) if (abierto == null || r.period < abierto) periodosCerrados.add(r.period);
  const minPeriodosEntidad = Math.max(MIN_PAIRED_PERIODS, Math.ceil(periodosCerrados.size * MIN_ENTITY_COVERAGE));

  // #periodos CON VENTA por año y por entidad. `monto > 0`: un periodo en cero no es cobertura.
  const cobPorEntidad = new Map<string, { a: number; b: number }>();
  for (const r of rows) {
    if (abierto != null && r.period >= abierto) continue;
    if (!(r.monto > 0)) continue;
    const c = cobPorEntidad.get(r.entity_key) || { a: 0, b: 0 };
    if (r.year === y0) c.a++; else if (r.year === y1) c.b++;
    cobPorEntidad.set(r.entity_key, c);
  }
  const esComparable = (ek: string) => {
    const c = cobPorEntidad.get(ek);
    return !!c && c.a >= minPeriodosEntidad && c.b >= minPeriodosEntidad;
  };

  const yoy = (pred: (channel: string) => boolean) => {
    const comp = new Map<number, { a: number; b: number }>();  // sólo entidades comparables
    const todo = new Map<number, { a: number; b: number }>();  // todas (el número viejo, declarado)
    const dentro = new Set<string>(), fuera = new Set<string>();
    let excluidoY1 = 0;
    for (const r of rows) {
      if (!pred(r.channel)) continue;
      const ok = esComparable(r.entity_key);
      (ok ? dentro : fuera).add(r.entity_key);
      for (const m of ok ? [comp, todo] : [todo]) {
        const c = m.get(r.period) || { a: 0, b: 0 };
        if (r.year === y0) c.a += r.monto; else if (r.year === y1) c.b += r.monto;
        m.set(r.period, c);
      }
      if (!ok && r.year === y1 && (abierto == null || r.period < abierto)) excluidoY1 += r.monto;
    }
    const sumar = (m: Map<number, { a: number; b: number }>) => {
      let a = 0, bb = 0, paired = 0, abiertos = 0;
      for (const [p, c] of m) {
        if (abierto != null && p >= abierto) { abiertos++; continue; } // ni el abierto ni los posteriores
        if (c.a > 0 && c.b > 0) { a += c.a; bb += c.b; paired++; }
      }
      return { a, bb, paired, abiertos };
    };
    const sc = sumar(comp), st = sumar(todo);
    const cobertura: CoberturaYoY = {
      entidades_comparables: dentro.size,
      entidades_excluidas: fuera.size,
      excluido_monto_y1: round2(excluidoY1),
      min_periodos_entidad: minPeriodosEntidad,
      growth_pct_todo: st.paired >= MIN_PAIRED_PERIODS && st.a > 0 ? round4((st.bb - st.a) / st.a) : null,
    };
    const growth_pct = sc.paired >= MIN_PAIRED_PERIODS && sc.a > 0 ? round4((sc.bb - sc.a) / sc.a) : null;
    return { growth_pct, paired: sc.paired, abiertos: sc.abiertos, cobertura };
  };

  const g = yoy(() => true);
  const global = g.growth_pct != null
    ? { growth_pct: g.growth_pct, basis: 'yoy_paired' as const, paired_periods: g.paired, periodos_abiertos_excluidos: g.abiertos, cobertura: g.cobertura }
    : { growth_pct: def, basis: 'default' as const, paired_periods: 0, periodos_abiertos_excluidos: 0, cobertura: g.cobertura };

  const by_channel: Record<string, CrecCanal> = {};
  for (const ch of canales) {
    const c = yoy((x) => x === ch);
    if (c.growth_pct != null) by_channel[ch] = { growth_pct: c.growth_pct, basis: 'yoy_paired', paired_periods: c.paired, years_used: [y0, y1], cobertura: c.cobertura };
    else if (global.basis === 'yoy_paired') by_channel[ch] = { growth_pct: global.growth_pct, basis: 'global', paired_periods: global.paired_periods, years_used: [y0, y1], cobertura: c.cobertura };
    else by_channel[ch] = { growth_pct: def, basis: 'default', paired_periods: 0, years_used: [], cobertura: c.cobertura };
  }

  return { by_channel, global, min_periodos_entidad: minPeriodosEntidad };
}
