/**
 * ⭐ `[CGA-A.65]` **La hoja de gastos de zona** — lo que hoy es el Excel «Formato de autorización de
 * gastos 1.0» (área «ZONA MORELIA», «Gastos diarios»), armado solo desde Kepler. Edgar, 2026-10-29:
 * *«no queremos impresiones, solo quiero que se automatice el proceso tanto del excel como a la hora
 * de pagar»*.
 *
 * ── Qué es una hoja (medido el 2026-10-29 contra dos hojas en papel y el banco) ────────────────
 * Los pagos que la zona hizo con el efectivo de su venta (Kepler `X-D-26` contra su `0011`), de
 * TODAS sus sucursales en una sola hoja. Se repone con UN retiro de CAOS (el total en billetes; el
 * cajón pone el resto) y un depósito por el total, que le devuelve a la sucursal lo que tomó de su
 * venta. Las dos hojas en papel (venta del 20 y del 23) cuadran al centavo con Kepler, y seis
 * hojas de octubre cuadran al centavo con su depósito en el banco.
 */

/** Las zonas que se reponen por hoja. Una zona sin hoja sigue por la reposición por sucursal. */
export type ClaveZonaHoja = 'morelia' | 'canindo';

export interface ZonaHojaGastos {
  clave: ClaveZonaHoja;
  /** Como lo dice el área de la hoja: «Zona Morelia». */
  nombre: string;
  /** Servidores de Kepler, en el orden de la hoja en papel: Abastos antes que Madero. */
  sucursales: readonly string[];
  /**
   * Primer día de pago (`c9`) que entra a la hoja. Lo anterior ya se repuso con hojas en papel y
   * sigue en la ventana de reposición. Se fija el día que la hoja entra a producción.
   */
  desde: string;
}

export const ZONAS_HOJA_GASTOS: readonly ZonaHojaGastos[] = Object.freeze([
  { clave: 'morelia', nombre: 'Zona Morelia', sucursales: ['08', '07'], desde: '2026-10-29' },
  // Edgar, 2026-10-29: Canindo con los mismos parámetros. Su «Gastos generales» sólo trae gastos.
  { clave: 'canindo', nombre: 'Zona Canindo', sucursales: ['06'], desde: '2026-10-29' },
]);

export function zonaDeSucursal(sucursal: string): ZonaHojaGastos | null {
  return ZONAS_HOJA_GASTOS.find((z) => z.sucursales.includes(sucursal)) ?? null;
}

/**
 * Proveedor de contado o gasto, por la clave del beneficiario en Kepler (`kdm1.c10`): `C…` es un
 * acreedor —el pago queda aplicado a su compra (`X-A-20`) y la mercancía SÍ entró con su orden de
 * entrada— y `G…` es un gasto (caja chica, combustible). Medido en octubre: 76 de 76 pagos `C…`
 * de la hoja aplicados a su compra. Sin clave, se dice; no se adivina.
 */
export type ClaseRenglonHoja = 'proveedor' | 'gasto' | 'sin_clave';

export function claseDeClave(clave: string | null | undefined): ClaseRenglonHoja {
  const c = String(clave ?? '').trim().toUpperCase();
  return c.startsWith('C') ? 'proveedor' : c.startsWith('G') ? 'gasto' : 'sin_clave';
}

/** Un pago de Kepler en la hoja. */
export interface RenglonHoja {
  /** `sucursal|doc_tipo|folio|0011`: la misma llave que el libro de Caja General. */
  origen_ref: string;
  sucursal: string;
  doc_tipo: string;
  folio: string;
  /** Día de pago (`c9`). */
  fecha_pago: string;
  fecha_captura: string | null;
  beneficiario: string | null;
  /** Clave del beneficiario en Kepler (`c10`). */
  clave: string | null;
  /** Centro de costo en Kepler (`c12`). */
  centro: string | null;
  clase: ClaseRenglonHoja;
  importe: number;
}

export interface SubtotalHoja {
  renglones: number;
  total: number;
}

/** Lo que Caja General hace al pagar: sacar de CAOS, completar con el cajón y depositar. */
export interface InstruccionPagoHoja {
  /** Lo que se saca de CAOS: el total en billetes que da la máquina. */
  retiro: number;
  /** Lo que pone el cajón para llegar al total. */
  cajon: number;
  /** Lo que se deposita: el total de la hoja. */
  deposito: number;
  /** Lo que se escribe en la referencia del retiro de CAOS, para que se ligue solo. */
  referencia: string | null;
}

/**
 * Por qué un pago de la zona con su efectivo NO va en la hoja, por su centro de costo (`c12`) o su
 * referencia (`c11`). Medido el 2026-10-29: con estas cuatro exclusiones, seis hojas de octubre
 * salen al centavo de su depósito en el banco (con «sólo el centro 007», cuatro).
 */
export type MotivoFueraDeHoja = 'nomina' | 'apoyo_proveedores' | 'comisiones' | 'compra_registrada';

export const MOTIVO_FUERA_DE_HOJA_TEXTO: Readonly<Record<MotivoFueraDeHoja, string>> = Object.freeze({
  nomina: 'Nómina: se repone con su propio retiro',
  apoyo_proveedores: 'Apoyo a proveedores (Capitán de marca, bonos)',
  comisiones: 'Comisiones de ventas',
  compra_registrada: 'Pago de una compra registrada en Kepler',
});

/** La hoja que se está llenando sola: los pagos de la zona que todavía no van en ninguna hoja. */
export interface HojaAbierta {
  zona: ClaveZonaHoja;
  nombre: string;
  desde: string;
  renglones: RenglonHoja[];
  total: number;
  por_sucursal: Array<SubtotalHoja & { sucursal: string }>;
  por_clase: Array<SubtotalHoja & { clase: ClaseRenglonHoja }>;
  /** Los pagos de la zona que no van en la hoja, cada uno con su motivo: se ven, no se esconden. */
  fuera: Array<RenglonHoja & { motivo: MotivoFueraDeHoja }>;
  /** `null` = la hoja está vacía. */
  instruccion: InstruccionPagoHoja | null;
  /** Edad del dato de Kepler. `null` = sin medir. */
  datos_al: string | null;
}

/** El folio que se escribe en la referencia del retiro: «HG-12». */
export function folioHoja(numero: number): string {
  return `HG-${numero}`;
}

/**
 * El folio de hoja que trae una referencia de CAOS (texto libre: «gnf morelia HG-12», «hg 12»).
 * Más de un folio distinto en la misma referencia no se elige: se devuelve `null`.
 */
export function leerFolioHoja(ref: string | null | undefined): number | null {
  const vistos = new Set<number>();
  for (const m of String(ref ?? '').matchAll(/(?:^|[^a-z0-9])hg\s*-?\s*(\d{1,6})(?![0-9])/gi)) vistos.add(Number(m[1]));
  return vistos.size === 1 ? [...vistos][0] : null;
}
