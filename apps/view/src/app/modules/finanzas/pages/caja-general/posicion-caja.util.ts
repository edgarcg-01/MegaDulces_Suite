import type { EstadoPosicion, PosicionRubro } from '@megadulces/contracts';
import { dmy } from '../finanzas-format';

/**
 * ⭐ `[CGS.55]` Cómo se dice un rubro de lo que hay en caja (`GET /cash-ledger/posicion`). Lo leen
 * DOS pantallas —Arqueos (la tarjeta de cada rubro) y Caja Fuerte (la de la caja fuerte)— y antes
 * se contradecían: Arqueos decía «$83,650.00, calculado» y Caja Fuerte «sin medir» del mismo dato.
 * Una sola lectura, aquí.
 */
export interface RenglonDesglose { monto: string | null; texto: string }

export function etiquetaPosicion(e: EstadoPosicion): string {
  return ({ medido: 'Contado', derivado: 'Calculado', parcial: 'Calculado, incompleto', imposible: 'No se puede afirmar', no_medido: 'Sin medir' } as const)[e];
}

/** `3 movimientos`, `1 movimiento`: el número con su palabra, sin «(s)». */
export function plural(n: number, uno: string, varios: string): string { return `${n} ${n === 1 ? uno : varios}`; }

/**
 * De dónde sale la cifra del rubro, renglón por renglón: el último conteo, lo que entró y salió
 * después, y una línea con cuándo y en qué. Los rubros que la Suite no mueve sólo tienen el conteo.
 * `fmt` pone el dinero y `cuando` la fecha: los pone quien pinta.
 */
export function desgloseRubro(r: PosicionRubro, fmt: (n: number) => string, cuando: (iso: string) => string): RenglonDesglose[] {
  const u = r.ultimo;
  if (!u) return [];
  const deDonde = `${u.at ? cuando(u.at) + ' · ' : ''}${u.fuente.replace(/\s*\(.*\)$/, '')}`;
  if (!r.desde) {
    const out: RenglonDesglose[] = [{ monto: null, texto: `contado el ${deDonde}${u.tipo_cambio != null ? ` · a ${u.tipo_cambio} por dólar` : ''}` }];
    // `[CGS.59]` Cheques y papeles: el total se abre documento por documento.
    if (r.piezas) {
      if (!r.piezas.length) out.push({ monto: null, texto: 'no había ninguno' });
      for (const p of r.piezas) out.push({ monto: fmt(p.monto), texto: `${p.texto} · en caja desde el ${dmy(p.desde)}` });
    }
    return out;
  }
  const cf = r.rubro === 'caja_fuerte';
  const out: RenglonDesglose[] = [
    { monto: u.monto === null ? 'sin medir' : fmt(u.monto), texto: cf ? 'último arqueo' : 'último conteo' },
  ];
  const { entra, sale, detalle } = r.desde;
  if (Math.abs(entra) < 0.005 && Math.abs(sale) < 0.005) {
    out.push({ monto: null, texto: 'sin movimientos desde entonces' });
  } else {
    out.push({ monto: `+ ${fmt(entra)}`, texto: cf ? 'depositado' : 'entró' });
    out.push({ monto: `− ${fmt(sale)}`, texto: cf ? 'dispensado' : 'salió' });
  }
  // Del detalle del servidor sólo el conteo: lo demás («la caja fuerte dio $X») ya es el «entró».
  const movs = /(\d+) movimiento/.exec(detalle)?.[1];
  out.push({ monto: null, texto: `${deDonde}${!cf && movs ? ' · ' + plural(Number(movs), 'movimiento', 'movimientos') + ' del libro' : ''}` });
  return out;
}
