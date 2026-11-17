import type { PickerWaveLine } from '@megadulces/contracts';

/**
 * `[GP.RF.33]` Qué hacer con lo que se escaneó en Surtir (decisión de Edgar, 2026-11-17: «escanear marca
 * Completo»). El lector teclea el código y manda Enter.
 *
 * Sólo se marca solo cuando se SABE que lo escaneado es la presentación pedida: el renglón trae los
 * códigos de cada presentación de Kepler (`presentaciones`). Si el código es de otra presentación del
 * mismo producto (la caja cuando el pedido es en paquetes) se AVISA y no se marca: contar cajas como
 * paquetes es surtir de más o de menos. Sin ese dato (Telemarketing, servidor anterior) no se marca nada
 * solo: la pantalla hace lo de antes (filtra y pone el foco en «Completo»).
 */
export type LecturaDeEscaneo =
  | { tipo: 'completo'; linea: PickerWaveLine }
  | { tipo: 'otra_presentacion'; linea: PickerWaveLine; escaneada: string; pedida: string }
  | { tipo: 'ya_marcado'; linea: PickerWaveLine }
  | { tipo: 'varios' }
  | null;

/** La unidad en que se cuenta el renglón: la de la hoja si la hay; si no, la del pedido. */
export function unidadDelRenglon(l: Pick<PickerWaveLine, 'qty_presentacion' | 'unidad_presentacion' | 'qty_unit'>): string {
  const u = l.qty_presentacion != null && l.unidad_presentacion ? l.unidad_presentacion : (l.qty_unit ?? '');
  return u.trim().toUpperCase();
}

export function leerEscaneo(codigo: string, lineas: readonly PickerWaveLine[]): LecturaDeEscaneo {
  const c = codigo.trim();
  if (!c) return null;
  const con = lineas
    .map((l) => ({ l, p: (l.presentaciones ?? []).find((x) => x.codigos.includes(c)) }))
    .filter((x): x is { l: PickerWaveLine; p: { unit: string; codigos: string[] } } => !!x.p);
  if (!con.length) return null;
  const pendientes = con.filter((x) => x.l.status === 'pendiente');
  if (!pendientes.length) return { tipo: 'ya_marcado', linea: con[0].l };
  // Dos renglones pendientes del mismo producto: no se adivina cuál.
  if (pendientes.length > 1) return { tipo: 'varios' };
  const { l, p } = pendientes[0];
  const pedida = unidadDelRenglon(l);
  if (p.unit.trim().toUpperCase() !== pedida) return { tipo: 'otra_presentacion', linea: l, escaneada: p.unit, pedida };
  return { tipo: 'completo', linea: l };
}

/**
 * `[GP.RF.34]` Los renglones en el orden del recorrido del almacén: primero los que tienen ubicación, por
 * su orden; los que no tienen, al final y en el orden en que venían. Estable: lo empatado no se mueve.
 */
export function ordenarPorRecorrido(lineas: readonly PickerWaveLine[]): PickerWaveLine[] {
  const sinLugar = (l: PickerWaveLine) => (l.bin_code ? 0 : 1);
  const orden = (l: PickerWaveLine) => l.orden_recorrido ?? Number.MAX_SAFE_INTEGER;
  return [...lineas].sort((a, b) =>
    sinLugar(a) - sinLugar(b) || orden(a) - orden(b) || (a.bin_code ?? '').localeCompare(b.bin_code ?? ''));
}
