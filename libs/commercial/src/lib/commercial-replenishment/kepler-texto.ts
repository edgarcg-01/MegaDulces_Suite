/**
 * `[KR.16]` Número → texto como Kepler lo guarda en sus columnas `varchar` de importe y cantidad (`c57`, `c56`, `c51`):
 * sin relleno, hasta dos decimales, sin ceros de sobra. Medido: `791`, `373.76`, `1083`.
 * Vive aparte (`[PQ.160]`) para que la regla pura de editar OC lo use sin arrastrar el adaptador del sink.
 */
export const textoKepler = (v: number): string => String(Math.round((Number(v) || 0) * 100) / 100);
