import type { AdjustmentForEntradaRow } from './compras.service';

/**
 * `[RE.81]` El encabezado de «Ajustes del proveedor»: lo ligado por Kepler a ESTA entrada y lo que
 * sólo coincide por proveedor + fecha se cuentan aparte. «21 candidatos» mezclaba la nota exacta
 * (0000118 de la entrada 0000545 de Morelia Abastos) con el resto.
 */
export function explainsResumen(rows: ReadonlyArray<Pick<AdjustmentForEntradaRow, 'match'>>): string {
  const exactos = rows.filter((r) => r.match === 'exacto').length;
  const candidatos = rows.length - exactos;
  const partes: string[] = [];
  if (exactos) partes.push(`${exactos} ${exactos === 1 ? 'exacto' : 'exactos'}`);
  if (candidatos) partes.push(`${candidatos} ${candidatos === 1 ? 'candidato' : 'candidatos'}`);
  return partes.join(' · ');
}
