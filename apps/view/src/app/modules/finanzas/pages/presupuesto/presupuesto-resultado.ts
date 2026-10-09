/**
 * `[PVI.16]` — **El ejercicio tiene dos lados, y todavía no puede decir un resultado.**
 *
 * ── Lo que la pantalla decía, y por qué engañaba ─────────────────────────────────────────────
 *
 * La tira de KPIs publicaba **«Egreso vigente $74.85M»** y **«Meta de ventas $604.78M»** como si
 * fueran cifras de mundos distintos. Medido en prod el 2026-10-09 sobre el ejercicio real
 * (`PRE-2027-002`):
 *
 *   gasto     14 partidas   $74,850,067
 *   ingreso   33 partidas  $604,775,116   ← «Ventas mostrador · 08», «Ventas mayoreo · 06», …
 *
 * y la suma de las 33 de ingreso **cuadra al peso** con la meta del plan de ventas
 * (`604,775,116 = 604,775,116`). O sea que no son dos mundos: son **los dos lados del mismo
 * ejercicio**, y uno de ellos no se veía como tal.
 *
 * ── Por qué NO se publica la resta ───────────────────────────────────────────────────────────
 *
 * ⛔ `ingreso − gasto` daría **$529.9M sobre $604.8M = 87.6 % de margen**, y es falso: las 14
 * partidas de gasto son **operativas** —sueldos, logística, venta, local, dirección, publicidad,
 * administrativos, tecnología, contables, papelería, mobiliario— y **ninguna es costo de ventas**.
 *
 * ⭐ Y eso no es una heurística sobre los nombres: es **estructural**. El `CHECK` de
 * `budget.budget_lines.line_type` admite SEIS tipos —
 * `ingreso · costo_ventas · gasto · compra_inventario · inversion · flujo` — y en toda la base
 * existen **sólo dos**: `gasto` e `ingreso`. El presupuesto **tiene el casillero del costo de
 * ventas y está vacío**. No es un hueco de diseño: es uno sin llenar, y se puede nombrar.
 *
 * ⇒ El resultado se devuelve `null` **con el motivo y con qué falta**, nunca una resta que el
 *   lector leería como utilidad. «No se puede medir» se declara (ADR-056).
 *
 * ── De dónde salen los datos ─────────────────────────────────────────────────────────────────
 *
 * De `GET budgets/:id/variance`, el roll-up por tipo de partida. ⭐ Ese endpoint existía **sin un
 * solo consumidor en pantalla** — el tercer caso de «construido y nunca cableado» que aparece hoy
 * en este módulo. Acá se usa para lo único que puede contestar de verdad con el ledger sin mover:
 * **qué lados del ejercicio existen y cuáles no**.
 */

/** Los seis tipos que el `CHECK` de la tabla admite, en el orden en que se leen. */
export const TIPOS_LEDGER = ['ingreso', 'costo_ventas', 'gasto', 'compra_inventario', 'inversion', 'flujo'] as const;
export type TipoLedger = typeof TIPOS_LEDGER[number];

/** Una fila del roll-up por tipo, tal como la devuelve `variance`. Los montos pueden venir como
 *  cadena: `sum()` de Postgres sobre `numeric` llega así por el driver. */
export interface FilaPorTipo {
  line_type: string;
  vigente?: number | string | null;
  reserved?: number | string | null;
  committed?: number | string | null;
  exercised?: number | string | null;
  paid?: number | string | null;
}

export interface LadoEjercicio {
  tipo: TipoLedger;
  /** `true` cuando el tipo TIENE partidas. Distingue «vale cero» de «no existe». */
  presente: boolean;
  vigente: number;
}

export interface ResultadoEjercicio {
  /** Los SEIS lados, siempre — los ausentes se declaran, no se omiten. */
  lados: LadoEjercicio[];
  /** Lo que el ejercicio planea ingresar. */
  ingreso: number;
  /** Lo que planea gastar, SIN costo de ventas. */
  egreso_operativo: number;
  /** ⛔ `null` mientras falte algún lado de la cuenta. NUNCA una resta parcial. */
  resultado: number | null;
  /** Qué tipos hacen falta para poder restar. Vacío cuando `resultado` no es null. */
  faltan: TipoLedger[];
}

/** Los tipos que la cuenta del resultado necesita sí o sí. */
const NECESARIOS: readonly TipoLedger[] = ['ingreso', 'costo_ventas', 'gasto'];

/** `0` salvo que venga un número de verdad. El driver manda `numeric` como cadena. */
const num = (v: unknown): number => {
  if (v == null) return 0;
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
};

export function resultadoEjercicio(filas: readonly FilaPorTipo[] | null | undefined): ResultadoEjercicio {
  const porTipo = new Map<string, number>();
  for (const f of filas ?? []) {
    if (!f?.line_type) continue;
    porTipo.set(f.line_type, num(porTipo.get(f.line_type)) + num(f.vigente));
  }

  const lados: LadoEjercicio[] = TIPOS_LEDGER.map((tipo) => ({
    tipo,
    presente: porTipo.has(tipo),
    vigente: num(porTipo.get(tipo)),
  }));

  const faltan = NECESARIOS.filter((t) => !porTipo.has(t));
  const ingreso = num(porTipo.get('ingreso'));
  const egresoOperativo = num(porTipo.get('gasto'));

  return {
    lados,
    ingreso,
    egreso_operativo: egresoOperativo,
    // ⛔ La resta SOLO cuando están los tres. Con el costo de ventas ausente, `ingreso - gasto`
    //    publicaría 87.6 % de margen sobre un ejercicio que no presupuestó lo que vende.
    resultado: faltan.length ? null : ingreso - num(porTipo.get('costo_ventas')) - egresoOperativo,
    faltan,
  };
}

/** Rótulo legible de un tipo de partida. */
export function tipoLabel(t: TipoLedger): string {
  return ({
    ingreso: 'Ingreso', costo_ventas: 'Costo de ventas', gasto: 'Gasto operativo',
    compra_inventario: 'Compra de inventario', inversion: 'Inversión', flujo: 'Flujo',
  } as Record<TipoLedger, string>)[t];
}

/**
 * Por qué no hay resultado, en una frase. `null` cuando sí lo hay.
 *
 * Dice **qué falta y qué pasaría si se restara igual**, porque «no se puede calcular» no deja
 * decidir y «falta el costo de ventas, sin él el margen saldría 87.6 %» sí.
 */
export function motivoSinResultado(r: ResultadoEjercicio): string | null {
  if (!r.faltan.length) return null;
  const nombres = r.faltan.map(tipoLabel).join(' y ');
  const falso = r.ingreso > 0 ? Math.round(((r.ingreso - r.egreso_operativo) / r.ingreso) * 1000) / 10 : null;
  const aviso = falso != null
    ? ` Restar sólo el gasto operativo publicaría ${falso} % de margen sobre un ejercicio que todavía no presupuestó lo que vende.`
    : '';
  return `El ejercicio no puede declarar un resultado: le falta ${nombres}.${aviso}`;
}
