import type { DeudaProgramableResponse, DocumentoProgramable } from '@megadulces/contracts';

/**
 * `[PGP.6]` El reparto de «la deuda que todavía no está programada» — **lógica pura, sin knex**.
 *
 * Vive aparte del servicio por la razón de siempre en este repo: un doble de Knex no ejecuta SQL,
 * así que lo que se puede probar sin base es esto —los totales, la cobertura, el orden y el
 * recorte de la página—, no el `WHERE`. El SQL se ejerce contra prod con el guión de sólo
 * lectura, que lo lee del servicio.
 */

/** Redondeo a centavos. */
export const r2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * `[PGP.6]` Los nombres de los documentos de CxP de Kepler (`kdmm` con `c1='X'`, `c2='A'`).
 *
 * ⭐ **Va en código y no en un `JOIN`, y la razón se midió el 2026-10-22:** toda la deuda viva de
 * mercancía usa **tres** combinaciones de (tipo, sub) —`20/1` en 1,689 documentos, `10/1` en 35 y
 * `45/1` en 14— y el catálogo entero son 40 filas que no cambian. Unirlo por consulta costaba un
 * `LEFT JOIN` con cuatro casts sobre cada fila a cambio de un dato constante.
 *
 * ⚠️ Un tipo que no esté acá **no se inventa**: se muestra como «Documento N/M», igual que hace
 * `GRUPOS_KEPLER` en el motor del estado de cuenta con un grupo desconocido.
 */
export const NOMBRE_DOCUMENTO_CXP: Readonly<Record<string, string>> = {
  '5/1': 'Compra a crédito', '5/2': 'Compra contado',
  '6/1': 'Compra a crédito', '6/2': 'Compra contado',
  '9/3': 'Gastos de importación', '9/4': 'Gastos indirectos', '9/5': 'Gastos no deducibles',
  '10/1': 'Gastos', '11/1': 'Gastos por proyecto', '12/1': 'Gastos concepto proyecto',
  '12/2': 'Gastos de producción', '13/1': 'Gastos por departamento', '14/1': 'Gasto concepto-depto',
  '15/1': 'Solicitud de gasto', '15/2': 'Solicitud recibo de honorarios',
  '20/1': 'Aplica Orden Entrada',
  '25/1': 'Cheque devuelto', '27/1': 'Ajuste cargo general',
  '45/1': 'Nota cargo a proveedor', '45/2': 'Nota cargo sobre compras', '45/3': 'Nota cargo sin IVA',
  '46/1': 'Nota cargo CFDI',
  '50/1': 'Documento por pagar', '50/2': 'Carga inicial CxP',
};

export const nombreDocumento = (tipo: number, sub: number): string =>
  NOMBRE_DOCUMENTO_CXP[`${tipo}/${sub}`] ?? `Documento ${tipo}/${sub}`;

/** Una fila cruda del pendiente vivo, ya agrupada por documento. */
export interface FilaDeudaCruda {
  sucursal: string;
  proveedor: string;
  proveedor_nombre: string | null;
  doc_tipo: string | number;
  doc_sub: string | number;
  folio: string;
  vencimiento: string | null;
  dias_vencido: string | number | null;
  anterior_al_corte: boolean;
  pendiente: string | number;
  supplier_id: string | null;
  /** `true` si ese documento YA tiene obligación viva en el Calendario. */
  programado: boolean;
}

/**
 * ⭐ **El denominador es TODA la deuda viva, programada o no.** Si se contara sólo lo que falta,
 * `pct_programado` sería siempre 0 y no habría forma de ver el avance — el mismo criterio que
 * `[PGP.1]` con la cobertura de cuentas.
 *
 * ⛔ **Y la página declara si se topó.** `mostrados` + `hay_mas` existen porque una lista que
 * corta en N y no lo dice afirma que no hay más: el defecto que costó 148 filas invisibles
 * ($1,943,998.57) en el libro de Caja General.
 */
export function armarDeudaProgramable(
  rows: FilaDeudaCruda[],
  opts: { limit: number; al: string },
): DeudaProgramableResponse {
  const n = (v: unknown): number => Number(v ?? 0);

  const pendienteTotal = rows.reduce((a, x) => a + n(x.pendiente), 0);
  const programados = rows.filter((x) => x.programado);
  const pendienteProgramado = programados.reduce((a, x) => a + n(x.pendiente), 0);

  // Lo ofrecible: lo que NO está programado. Los que no resuelven al catálogo se cuentan aparte
  // porque no se les puede crear obligación — y se DECLARAN, no se descartan en silencio.
  const pendientes = rows.filter((x) => !x.programado);
  const sinCatalogo = pendientes.filter((x) => x.supplier_id == null);
  const ofrecibles = pendientes.filter((x) => x.supplier_id != null);

  const pagina = ofrecibles.slice(0, Math.max(opts.limit, 0));
  const documentos: DocumentoProgramable[] = pagina.map((x) => ({
    sucursal: x.sucursal,
    proveedor: String(x.proveedor ?? '').trim(),
    proveedor_nombre: x.proveedor_nombre ?? '',
    supplier_id: x.supplier_id,
    doc_tipo: Number(x.doc_tipo),
    doc_sub: Number(x.doc_sub),
    folio: String(x.folio ?? '').trim(),
    documento: nombreDocumento(Number(x.doc_tipo), Number(x.doc_sub)),
    vencimiento: x.vencimiento ? String(x.vencimiento).slice(0, 10) : null,
    dias_vencido: x.dias_vencido == null ? null : Number(x.dias_vencido),
    pendiente: r2(n(x.pendiente)),
    anterior_al_corte: !!x.anterior_al_corte,
  }));

  return {
    universo: {
      documentos_total: rows.length,
      pendiente_total: r2(pendienteTotal),
      documentos_programados: programados.length,
      pendiente_programado: r2(pendienteProgramado),
      pct_programado: pendienteTotal > 0 ? r2((pendienteProgramado / pendienteTotal) * 100) : 0,
      documentos_sin_catalogo: sinCatalogo.length,
      pendiente_sin_catalogo: r2(sinCatalogo.reduce((a, x) => a + n(x.pendiente), 0)),
      mostrados: documentos.length,
      hay_mas: ofrecibles.length > documentos.length,
      al: opts.al,
    },
    documentos,
  };
}
