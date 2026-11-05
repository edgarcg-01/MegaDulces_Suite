/**
 * `[LE.6.8]` — **La hoja de reposición, como la ve la Ventanilla** (§5.1, §5.5). Pura.
 *
 * ⛔ No hay una regla nueva de qué pago va: es `armarHojaAbierta` del módulo de la hoja (CGA-A.65),
 * la misma que ya cuadró al centavo con el depósito del banco en seis hojas de octubre. §5.1 pide
 * UNA función de destino; duplicarla aquí sería la séptima pieza contestando la misma pregunta.
 *
 * Lo que agrega la Ventanilla, y nada más:
 *  · lo anterior a la apertura del libro NO entra: se cuenta aparte (`anteriores`) y lo reconstruye
 *    E3 (D-R2). Medido el 2026-11-04: la hoja abierta de Morelia traía 98 pagos del 12 al 25-oct
 *    ($653,707.64) que las hojas en papel ya repusieron; pedirlos otra vez los pagaría dos veces;
 *  · sin apertura no hay hoja (el libro no puede pagar nada todavía);
 *  · un pago que ya va en una orden de reposición (por firmar, vigente o usada) no vuelve a entrar.
 */
import { centavosATexto, pesosACentavos, type HojaDeReposicion, type PagoDeReposicion, type ZonaHojaGastos } from '@megadulces/contracts';
import { armarHojaAbierta, instruccionDePago, type PagoDeZona } from '../caja/hoja-gastos.engine';

const minor = (pesos: number | string): string => centavosATexto(pesosACentavos(Number(pesos).toFixed(2)));

function pago(p: { origen_ref: string; sucursal: string; folio: string; fecha_pago: string; beneficiario: string | null; importe: number | string },
  motivo?: string): PagoDeReposicion {
  return { origen_ref: p.origen_ref, sucursal: p.sucursal, folio: p.folio, fecha_pago: p.fecha_pago, beneficiario: p.beneficiario,
    importe_minor: minor(p.importe), ...(motivo ? { motivo } : {}) };
}

export function hojaDeReposicion(zona: ZonaHojaGastos, pagos: readonly PagoDeZona[], arranque: string | null,
  tomados: ReadonlySet<string>): HojaDeReposicion {
  const antes = arranque ? pagos.filter((p) => p.fecha_pago < arranque) : [...pagos];
  const anteriores = { n: antes.length, monto_minor: centavosATexto(antes.reduce((s, p) => s + pesosACentavos(Number(p.importe).toFixed(2)), 0n)) };
  const vacia: HojaDeReposicion = { zona: zona.clave, nombre: zona.nombre, sin_arranque: !arranque, renglones: [], total_minor: '0',
    maquina_minor: '0', cajon_minor: '0', fuera: [], anteriores };
  if (!arranque) return vacia;
  const h = armarHojaAbierta(zona, pagos.filter((p) => p.fecha_pago >= arranque && !tomados.has(p.origen_ref)), null);
  if (!h.renglones.length) return { ...vacia, fuera: h.fuera.map((f) => pago(f, f.motivo)) };
  const i = instruccionDePago(h.total, null);
  return {
    ...vacia,
    renglones: h.renglones.map((r) => pago(r)),
    total_minor: minor(h.total), maquina_minor: minor(i.retiro), cajon_minor: minor(i.cajon),
    fuera: h.fuera.map((f) => pago(f, f.motivo)),
  };
}
