import type { ColaRow, MontoUnidad } from './motor-margen.service';

/** `[PR.V3]` Una fila de la cola: una celda sola, o un grupo de plazas con la misma decisión. */
export interface FilaCola {
  key: string;
  /** La representativa: la plaza de mayor monto del grupo. */
  row: ColaRow;
  /** Vacío si no es grupo. */
  hijos: ColaRow[];
  plazas: number;
  /** `[PR.V10]` El dinero del grupo, EN SU UNIDAD (ver `unidad`). */
  monto: number | null;
  unidad: MontoUnidad | null;
}

/**
 * `[PR.V10]` El dinero de una celda en la unidad que la vista declara. Antes sólo se miraba
 * `monto_en_juego_mxn`, así que un grupo de `liberar_capital` mostraba el saldo de UNA plaza
 * rotulado como si fuera del grupo.
 */
export function montoDe(r: ColaRow): string | null {
  switch (r.monto_unidad) {
    case 'flujo_30d': return r.monto_en_juego_mxn;
    case 'saldo_existencia': return r.capital_inmovilizado_mxn;
    case 'venta_expuesta_30d': return r.venta_30d;
    default: return null;
  }
}

/**
 * ⛔ El orden de las unidades: flujo primero, después el saldo, después la venta expuesta. Es el
 * mismo que manda el servidor. Ordenar los grupos sólo por número volvería a mezclar unidades:
 * un saldo de $212,564 quedaría arriba de un flujo de $5,000.
 */
const RANGO: Record<string, number> = { flujo_30d: 0, saldo_existencia: 1, venta_expuesta_30d: 2 };
const rango = (u: MontoUnidad | null): number => (u ? RANGO[u] ?? 3 : 3);

/**
 * `[PR.V3]` Agrupa la cola por SKU **cuando la decisión es la misma** — misma acción y mismo
 * precio. Si la acción difiere entre plazas no son la misma decisión y van separadas.
 *
 * ⚠️ **Agrupa sólo lo que vino en esta página.** El servidor manda el top por dinero (límite
 * 200), así que las plazas chicas del mismo SKU pueden quedar fuera. Por eso la pantalla rotula
 * «en N plazas **de esta página**»: prometer «en N plazas» a secas sería un total falso.
 * Medido antes de decidirlo: la repetición en el top 100 real es del **19 %** y el grupo más
 * grande suma **$6,897** — no paga agrupar del lado del servidor.
 *
 * ⛔ `monto` es `null` cuando **ninguna** fila del grupo lo tiene, y NO cero: el motor distingue
 * «no se pudo medir» de «vale cero», y colapsar las dos es justo lo que ADR-056 prohíbe.
 */
export function agruparCola(rows: readonly ColaRow[]): FilaCola[] {
  const porClave = new Map<string, ColaRow[]>();
  for (const r of rows) {
    const k = `${r.sku}|${r.accion}|${r.precio_actual ?? ''}`;
    const l = porClave.get(k);
    if (l) l.push(r); else porClave.set(k, [r]);
  }

  const filas: FilaCola[] = [];
  for (const [key, grupo] of porClave) {
    const orden = [...grupo].sort((a, b) =>
      Math.abs(Number(montoDe(b) ?? 0)) - Math.abs(Number(montoDe(a) ?? 0)));
    const medibles = orden.filter((x) => montoDe(x) !== null);
    filas.push({
      key,
      row: orden[0],
      hijos: orden.length > 1 ? orden : [],
      plazas: orden.length,
      monto: medibles.length
        ? medibles.reduce((acc, x) => acc + Number(montoDe(x)), 0)
        : null,
      // La acción es la misma en todo el grupo (es parte de la llave), así que la unidad también.
      unidad: orden[0].monto_unidad ?? null,
    });
  }

  return filas.sort((a, b) =>
    rango(a.unidad) - rango(b.unidad) || Math.abs(b.monto ?? 0) - Math.abs(a.monto ?? 0));
}
