/**
 * `[PQ.130]` **Leer una columna de `purchase_requisitions` que puede no existir todavía, sin pagar la
 * fila entera.**
 *
 * `[RQ.15]` leía estas columnas con `to_jsonb(r) ->> 'col'` para que la bandeja no se cayera con un
 * 42703 si el código llegaba a prod antes que su migración. La defensa era buena; el costo no:
 * Postgres arma el JSON de la fila COMPLETA por cada columna pedida, y lo hace para TODAS las
 * requisiciones antes de ordenar y cortar la página (no considera caro `to_jsonb`). Medido en prod
 * el 2026-11-18 con 2,978 requisiciones: renglones 518–647 ms y resumen 610–700 ms; con la columna
 * sola, 20–25 ms y 17–21 ms, respuesta idéntica.
 *
 * `to_jsonb(r.col) #>> '{}'` da el MISMO texto que `to_jsonb(r) ->> 'col'` para cualquier tipo
 * (fechas en ISO con `T`, booleanos `true`/`false`): comprobado en prod sobre las 2,978, cero
 * diferencias en las dos direcciones, 1,599 de ellas con `rejected_at`. Si la columna no existe,
 * `NULL::text` — lo mismo que daba `->>` sobre una llave ausente.
 */
export const RQ_COLUMNAS_OPCIONALES = [
  'oc_sucursal', 'oc_folio', 'kepler_sucursal', 'kepler_folio', 'kepler_error',
  'requested_by_branch', 'rejection_reason', 'rejected_at',
] as const;
export type RqColumnaOpcional = (typeof RQ_COLUMNAS_OPCIONALES)[number];

/**
 * Arma el lector: `opc('kepler_folio')` → SQL que vale el texto de la columna, o `NULL::text` si la
 * columna no está en `existentes`. ⛔ Sólo acepta nombres de la lista: el resultado se interpola en
 * SQL, así que un nombre fuera de ella es un error de programación y truena, no se escapa.
 */
export function lectorColumnaOpcional(existentes: ReadonlySet<string>, alias = 'r'): (col: RqColumnaOpcional) => string {
  return (col) => {
    if (!(RQ_COLUMNAS_OPCIONALES as readonly string[]).includes(col)) {
      throw new Error(`[PQ.130] columna opcional desconocida: ${String(col)}`);
    }
    return existentes.has(col) ? `to_jsonb(${alias}.${col}) #>> '{}'` : 'NULL::text';
  };
}
