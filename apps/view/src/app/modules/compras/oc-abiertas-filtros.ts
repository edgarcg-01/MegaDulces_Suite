/**
 * `[PQ.84]` Los filtros de `/compras/oc-abiertas` que encuentran UNA orden, sin Angular, para probarlos.
 *
 * La pantalla filtraba por antigüedad, sucursal, «por qué sigue abierta» y seguimiento: sirve para
 * revisar el montón, pero no para contestar la pregunta con la que llega el comprador —«¿qué pasó con
 * la RQ-2026-02269?», «¿dónde quedó lo de EFFEM?», «la OC 7296»—. Eso pide buscar por folio de la OC,
 * por la requisición de la que salió (la de la Suite o la de Kepler) y por proveedor.
 */
import type { OpenOcRow } from './compras.service';

/** De dónde salió la orden: de una requisición de la Suite, de una de Kepler, o de ninguna. */
export type OrigenOc = 'suite' | 'kepler' | 'sin';
export const ORIGEN_OC_LABEL: Readonly<Record<OrigenOc, string>> = {
  suite: 'Requisición de la Suite',
  kepler: 'Requisición de Kepler',
  sin: 'Sin requisición',
};

export function origenOc(o: Pick<OpenOcRow, 'requisicion'>): OrigenOc {
  if (o.requisicion?.folio) return 'suite';
  if (o.requisicion?.kepler) return 'kepler';
  return 'sin';
}

const sinAcentos = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const digitos = (s: string | null | undefined) => (s ?? '').replace(/\D/g, '');

/**
 * ¿La orden coincide con lo que se escribió?
 *  · Sólo dígitos: el FINAL del folio de la OC, de la RQ de la Suite o de la requisición de Kepler
 *    («7296» encuentra la OC 0007296; «2269», la que salió de RQ-2026-02269).
 *  · Texto: el proveedor o el folio de la RQ, sin importar acentos ni mayúsculas («effem», «rq-2026-02269»).
 */
export function coincideOc(o: Pick<OpenOcRow, 'folio' | 'proveedor' | 'requisicion'>, termino: string): boolean {
  const t = termino.trim();
  if (!t) return true;
  if (/^\d+$/.test(t)) {
    const fin = t.replace(/^0+(?=\d)/, '');
    return [o.folio, o.requisicion?.folio, o.requisicion?.kepler].some((f) => {
      const d = digitos(f);
      return !!d && (d.endsWith(t) || d.replace(/^0+(?=\d)/, '').endsWith(fin));
    });
  }
  const q = sinAcentos(t);
  return [o.proveedor, o.requisicion?.folio, o.folio].some((f) => !!f && sinAcentos(f).includes(q));
}
