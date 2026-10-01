import type { ColaRow } from './motor-margen.service';

/** `[PR.V3]` Una fila de la cola: una celda sola, o un grupo de plazas con la misma decisión. */
export interface FilaCola {
  key: string;
  /** La representativa: la plaza de mayor monto del grupo. */
  row: ColaRow;
  /** Vacío si no es grupo. */
  hijos: ColaRow[];
  plazas: number;
  monto: number | null;
}

/**
 * `[PR.V3]` Agrupa la cola por SKU **cuando la decisión es la misma** — misma acción y mismo
 * precio. Si la acción difiere entre plazas no son la misma decisión y van separadas.
 *
 * ⚠️ **Agrupa sólo lo que vino en esta página.** El servidor manda el top por dinero (límite
 * 200), así que las plazas chicas del mismo SKU pueden quedar fuera. Por eso la pantalla rotula
 * «en N plazas **de esta lista**»: prometer «en N plazas» a secas sería un total falso.
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
      Math.abs(Number(b.monto_en_juego_mxn ?? 0)) - Math.abs(Number(a.monto_en_juego_mxn ?? 0)));
    const medibles = orden.filter((x) => x.monto_en_juego_mxn !== null);
    filas.push({
      key,
      row: orden[0],
      hijos: orden.length > 1 ? orden : [],
      plazas: orden.length,
      monto: medibles.length
        ? medibles.reduce((acc, x) => acc + Number(x.monto_en_juego_mxn), 0)
        : null,
    });
  }

  return filas.sort((a, b) => Math.abs(b.monto ?? 0) - Math.abs(a.monto ?? 0));
}
