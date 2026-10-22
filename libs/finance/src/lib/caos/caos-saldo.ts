/**
 * `[CGA-A.33]` El saldo de la caja fuerte CAOS — qué suma, qué resta, y cómo se cuadra.
 *
 * ── De dónde salen los signos (medido, no supuesto) ─────────────────────────────────────────
 * Reproduciendo los movimientos **por denominación** desde un momento de máquina vacía, el
 * contenido predicho iguala —en las cinco denominaciones a la vez— lo que el equipo declara:
 *
 *     17-jun → vaciado del 7-jul    175 movs   $650,100 = $650,100   0 en las 5
 *     7-jul  → vaciado del 18-ago   294 movs   $418,360 = $418,360   0 en las 5
 *     30-sep → «Fin de Dia» 15-oct  126 movs   $279,110 = $279,110   0 en las 5
 *
 * y el 2026-10-20 el inventario de casetes del equipo (`getCounting`) dio $360,020.00, el mismo
 * vector que el replay desde el último vaciado. Con signos equivocados nada de eso cierra.
 * Detalle: `docs/IMPLEMENTACION/FASES/FASE_CGA_PLAN_IMPLEMENTACION.md` §11.2.1.
 *
 * ⛔ Lo que NO está decodificado se nombra como tal y no entra a ninguna suma:
 *  · `Cambio` — total $0 siempre; la dirección de cada denominación no se pudo probar.
 *  · `Contenido Modificado` — ajuste del registro del propio equipo, SIN denominaciones.
 *  · cualquier `type_id` que no esté en el mapa.
 */

export type CaosEfecto = 'suma' | 'resta' | 'foto' | 'indeterminado';

export interface CaosTipoEfecto {
  efecto: CaosEfecto;
  /** +1 suma · −1 resta · 0 no mueve o no se sabe. */
  signo: 1 | -1 | 0;
  /** Por qué, en una frase que se puede mostrar en pantalla. */
  motivo: string;
}

/** El mapa, por `type_id` de CAOS (`getConfiguration`). Única fuente: SQL y pantalla leen de acá. */
export const CAOS_EFECTO_POR_TIPO: Readonly<Record<number, CaosTipoEfecto>> = {
  0: { efecto: 'suma', signo: 1, motivo: 'Depósito: entra efectivo a la máquina.' },
  4: { efecto: 'resta', signo: -1, motivo: 'Dispensar: sale efectivo de la máquina.' },
  8: { efecto: 'suma', signo: 1, motivo: 'Dotar: se cargan casetes.' },
  5: { efecto: 'resta', signo: -1, motivo: 'Vaciar Stocks: se saca el contenido de los casetes.' },
  2: { efecto: 'foto', signo: 0, motivo: 'Fin de Dia: la máquina lee su propio contenido al cerrar el día; no mueve efectivo.' },
  7: { efecto: 'indeterminado', signo: 0, motivo: 'Cambio: total $0; la dirección por denominación no está probada.' },
  13: { efecto: 'indeterminado', signo: 0, motivo: 'Contenido Modificado: ajuste del registro del equipo, sin denominaciones.' },
};

const DESCONOCIDO: CaosTipoEfecto = {
  efecto: 'indeterminado', signo: 0, motivo: 'Tipo de movimiento sin decodificar.',
};

export function efectoDeTipo(typeId: number): CaosTipoEfecto {
  return CAOS_EFECTO_POR_TIPO[typeId] ?? DESCONOCIDO;
}

/** `CASE type_id WHEN … THEN signo … ELSE 0 END`, generado del mapa para que el SQL no lo copie. */
export function sqlSignoPorTipo(col = 'type_id'): string {
  const whens = Object.entries(CAOS_EFECTO_POR_TIPO)
    .map(([id, e]) => `WHEN ${Number(id)} THEN ${e.signo}`)
    .join(' ');
  return `(CASE ${col} ${whens} ELSE 0 END)`;
}

/** Ids cuyo efecto NO está decodificado (para declararlos aparte). */
export function tiposIndeterminados(): number[] {
  return Object.entries(CAOS_EFECTO_POR_TIPO)
    .filter(([, e]) => e.efecto === 'indeterminado')
    .map(([id]) => Number(id));
}

// ── ¿Ya está en Caja General? ───────────────────────────────────────────────────────────────

/**
 * `[CGA-A.41]` El folio de Caja General que registra un movimiento de CAOS, o `NULL`.
 *
 * La regla es la MISMA de la bandeja de Captura (`cash-ledger.service#caosCapturables`): está
 * registrado si el libro tiene una fila viva con `origen_tipo='caos'` y su identidad, **o** si
 * quedó enlazado a un gasto en `finance.caos_cash_links`. ⚠️ Deuda declarada: `caosCapturables`
 * todavía la escribe aparte; hasta que lea de acá, si una cambia la otra no se entera.
 *
 * `m` es el alias de `analytics.caos_cash_movements` en la consulta que la usa.
 */
export function sqlFolioCajaGeneral(m = 'm'): string {
  return `COALESCE(
    (SELECT l.folio FROM finance.cash_ledger l
      WHERE l.tenant_id = ${m}.tenant_id AND l.origen_tipo = 'caos'
        AND l.origen_ref = ${m}.device || '|' || ${m}.external_id
        AND l.deleted_at IS NULL AND l.estado <> 'cancelado'
      ORDER BY l.created_at LIMIT 1),
    (SELECT l.folio FROM finance.caos_cash_links k
       JOIN finance.cash_ledger l ON l.id = k.cash_ledger_id AND l.deleted_at IS NULL
      WHERE k.tenant_id = ${m}.tenant_id AND k.caos_device = ${m}.device
        AND k.caos_external_id = ${m}.external_id AND k.deleted_at IS NULL
      ORDER BY k.created_at LIMIT 1))`;
}

// ── El cuadre continuo: foto contra foto más movimientos ────────────────────────────────────

/** Billetes por denominación: `{ 500: 507, 200: 383, … }`. */
export type Vector = Record<string, number>;

export interface CaosFoto {
  id: string;
  after_external_id: number;
  captured_at: string | Date;
  por_denominacion: Vector;
}

export interface CaosMovDenom {
  external_id: number;
  type_id: number;
  total: number;
  /** cantidad por denominación TAL COMO la publica el equipo (sin signo de efecto aplicado). */
  por_denominacion: Vector;
}

export interface CaosParCuadre {
  desde_id: number;
  hasta_id: number;
  desde_at: string | Date;
  hasta_at: string | Date;
  movimientos: number;
  estado: 'cuadra' | 'descuadre' | 'no_verificable';
  /** foto − (foto anterior + movimientos), en pesos. 0 si cuadra. */
  diferencia: number;
  por_denominacion: { denom: number; diferencia: number }[];
  motivo?: string;
}

const importe = (v: Vector): number =>
  Math.round(Object.entries(v).reduce((s, [d, q]) => s + Number(d) * q, 0) * 100) / 100;

/** Un movimiento es ambiguo si su efecto no está decodificado o si su desglose no suma su total. */
function ambiguo(m: CaosMovDenom): string | null {
  const e = efectoDeTipo(m.type_id);
  if (e.efecto === 'indeterminado') return e.motivo;
  if (e.efecto === 'foto') return null;
  const suma = importe(m.por_denominacion);
  // ⚠️ El #1478 (Vaciar Stocks) declara $20 y su desglose suma $86,220: no se sabe cuál vale.
  if (Math.abs(suma - Math.abs(Number(m.total))) > 0.005) {
    return `el movimiento #${m.external_id} declara ${m.total} y su desglose suma ${suma}`;
  }
  return null;
}

/** Aplica los movimientos (en orden) a un vector. Devuelve el vector y los motivos de ambigüedad. */
export function aplicarMovimientos(base: Vector, movs: CaosMovDenom[]): { vector: Vector; ambiguos: string[] } {
  const v: Vector = { ...base };
  const ambiguos: string[] = [];
  for (const m of movs) {
    const a = ambiguo(m);
    if (a) ambiguos.push(a);
    const s = efectoDeTipo(m.type_id).signo;
    if (!s) continue;
    for (const [d, q] of Object.entries(m.por_denominacion)) v[d] = (v[d] ?? 0) + s * q;
  }
  return { vector: v, ambiguos };
}

/**
 * Cuadra cada foto contra la anterior más los movimientos que entraron entre las dos.
 *
 * ⛔ Un descuadre con un movimiento ambiguo en el tramo NO se publica como descuadre: se publica
 * como `no_verificable` con su motivo. Culpar a la máquina de lo que no sabemos decodificar es
 * inventar un faltante.
 */
export function cuadrarFotos(fotos: CaosFoto[], movs: CaosMovDenom[]): CaosParCuadre[] {
  const orden = [...fotos].sort((a, b) => a.after_external_id - b.after_external_id
    || new Date(a.captured_at).getTime() - new Date(b.captured_at).getTime());
  const porId = [...movs].sort((a, b) => a.external_id - b.external_id);
  const pares: CaosParCuadre[] = [];
  for (let i = 1; i < orden.length; i++) {
    const a = orden[i - 1];
    const b = orden[i];
    const tramo = porId.filter((m) => m.external_id > a.after_external_id && m.external_id <= b.after_external_id);
    const { vector: esperado, ambiguos } = aplicarMovimientos(a.por_denominacion, tramo);
    const denoms = new Set([...Object.keys(esperado), ...Object.keys(b.por_denominacion)]);
    const difs = [...denoms]
      .map((d) => ({ denom: Number(d), diferencia: (b.por_denominacion[d] ?? 0) - (esperado[d] ?? 0) }))
      .filter((x) => x.diferencia !== 0)
      .sort((x, y) => y.denom - x.denom);
    const diferencia = Math.round(difs.reduce((s, x) => s + x.denom * x.diferencia, 0) * 100) / 100;
    const estado = !difs.length ? 'cuadra' : ambiguos.length ? 'no_verificable' : 'descuadre';
    pares.push({
      desde_id: a.after_external_id, hasta_id: b.after_external_id,
      desde_at: a.captured_at, hasta_at: b.captured_at,
      movimientos: tramo.length, estado, diferencia, por_denominacion: difs,
      motivo: estado === 'no_verificable' ? ambiguos.join(' · ') : undefined,
    });
  }
  return pares;
}

export { importe as importeDeVector };
