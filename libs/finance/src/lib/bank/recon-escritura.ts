import { createHash } from 'node:crypto';

/**
 * `[CB.74]` **La conciliación escribe sólo lo que cambió.**
 *
 * ⛔ El caso que lo trajo (medido en prod el 2026-11-17, sólo lectura): `finance.bank_recon_matches` llevaba
 * **24.1 millones de inserts y otros tantos deletes para 33,943 filas vivas**, y en 240 s se insertaron 26,328: los
 * pareos de octubre (mes cerrado) y de noviembre se borraban y se volvían a insertar IDÉNTICOS más o menos cada
 * minuto. `POST /match` tuvo 8 llamadas en 30 días: el que reescribía era el aviso (`[CB.53]`).
 *
 * El ciclo: el motor hacía `DELETE` + `INSERT` del periodo y ponía `updated_at = now()` en TODOS sus movimientos; la
 * firma del aviso mira `max(updated_at)` del lado banco, así que cada corrida movía la firma y la siguiente mirada
 * volvía a correr. Además el motor leía sin `ORDER BY`: el greedy dependía del orden físico, que cambia justo porque
 * cada corrida reescribe las filas.
 *
 * Con esta función el motor compara lo que va a dejar contra lo que ya hay y escribe la DIFERENCIA. Una corrida
 * repetida sobre el mismo dato no escribe nada, no mueve `updated_at` y la firma se queda quieta.
 */

/** Un pareo tal como vive en `finance.bank_recon_matches` (lo que se lee) o como lo arma el motor (lo que se escribe). */
export interface PareoFila {
  id?: string;
  bank_movement_id: string;
  kepler_sucursal?: string | null;
  kepler_doc_tipo?: string | null;
  kepler_doc_folio?: string | null;
  kepler_cuenta?: string | null;
  kepler_amount?: number | string | null;
  match_type?: string | null;
  match_confidence?: number | string | null;
  matched_by?: string | null;
}

/**
 * La llave COMPLETA de un pareo: todo lo que el motor decide. Si cambia cualquiera (otro documento, otro importe,
 * otra confianza, otro pase), el pareo se reescribe; si no, se queda como está.
 * El importe va en centavos y la confianza a dos decimales: `numeric` llega de `pg` como texto.
 */
export function llavePareo(r: PareoFila): string {
  const centavos = Math.round((Number(r.kepler_amount) || 0) * 100);
  const conf = Math.round((Number(r.match_confidence) || 0) * 100);
  return [r.bank_movement_id, r.kepler_sucursal ?? '', r.kepler_doc_tipo ?? '', r.kepler_doc_folio ?? '',
    r.kepler_cuenta ?? '', centavos, r.match_type ?? '', conf, r.matched_by ?? ''].join('|');
}

/** Huella de un conjunto de pareos: dos corridas con la misma huella dejaron exactamente lo mismo. */
export function huellaPareos(pareos: readonly PareoFila[]): string {
  const llaves = pareos.map(llavePareo).sort();
  return createHash('sha1').update(llaves.join('\n')).digest('hex').slice(0, 12);
}

export interface PlanEscritura<T extends PareoFila> {
  /** `id` de los pareos guardados que ya no salen. */
  borrar: string[];
  /** Pareos nuevos o que cambiaron (se insertan DESPUÉS de borrar: el índice único es por movimiento + documento). */
  insertar: T[];
  /** Movimientos que pasan a `matched` (hoy tienen otro estado). */
  aMatched: string[];
  /** Movimientos que pasan a `unmatched` (hoy tienen otro estado). */
  aUnmatched: string[];
  /** Pareos que ya estaban idénticos y no se tocan. */
  intactos: number;
}

/**
 * Qué hay que escribir para pasar de lo guardado a lo que dejó la corrida.
 *
 * @param guardados pareos que hoy existen para los movimientos del periodo (con su `id`).
 * @param nuevos    pareos que dejó la corrida, ya colapsados (uno por movimiento × documento).
 * @param estados   `recon_status` actual de cada movimiento del periodo que el motor evaluó.
 * @param casados   movimientos que la corrida dejó casados.
 *
 * El estado destino es el mismo que escribía el motor antes de `[CB.74]`: `matched` si casó, `unmatched` si no
 * (incluido lo que estaba `pending` o `ignored`). Lo único que cambia es que ya no se reescribe lo que ya está así.
 */
export function planEscritura<T extends PareoFila>(
  guardados: readonly PareoFila[],
  nuevos: readonly T[],
  estados: ReadonlyMap<string, string | null | undefined>,
  casados: ReadonlySet<string>,
): PlanEscritura<T> {
  const porLlave = new Map<string, PareoFila[]>();
  for (const g of guardados) {
    const k = llavePareo(g);
    const lista = porLlave.get(k);
    if (lista) lista.push(g); else porLlave.set(k, [g]);
  }
  const insertar: T[] = [];
  let intactos = 0;
  for (const n of nuevos) {
    const lista = porLlave.get(llavePareo(n));
    if (lista && lista.length) { lista.pop(); intactos++; } else insertar.push(n);
  }
  const borrar: string[] = [];
  for (const lista of Array.from(porLlave.values())) for (const g of lista) if (g.id) borrar.push(g.id);

  const aMatched: string[] = [], aUnmatched: string[] = [];
  for (const [id, estado] of Array.from(estados.entries())) {
    const destino = casados.has(id) ? 'matched' : 'unmatched';
    if (estado === destino) continue;
    (destino === 'matched' ? aMatched : aUnmatched).push(id);
  }
  return { borrar, insertar, aMatched, aUnmatched, intactos };
}
