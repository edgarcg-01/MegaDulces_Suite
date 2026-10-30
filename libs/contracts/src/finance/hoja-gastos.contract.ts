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
 *
 * ── El fin: UN movimiento, ligado, y sólo si está aprobada ─────────────────────────────────────
 * Edgar, 2026-10-29: *«todo lo de reposición es que salga de un solo movimiento de CAOS. debería
 * pagarse todo con un solo movimiento y vincularse… lo que se paga con cajón o no es reposición va
 * abajo»* y *«tiene que estar aprobada, si no está aprobada no se puede pagar»*. Hasta entonces el
 * retiro de una hoja se ligaba a mano, renglón por renglón (21 capturas para «gnf 26/10»), y de
 * $981,690 en 8 retiros de Morelia en octubre sólo $152,020 quedaron ligados. Pagar la hoja es
 * UN acto: el retiro (o el cajón) explica todos sus pagos de una vez, y fuera de él un pago de la
 * hoja no entra al libro de Caja General.
 */

import { formatearDinero } from '../money/centavos';
import { DENOMINACIONES_MXN } from '../money/denominations';

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
  /**
   * La cuenta donde se deposita la reposición de la zona (`finance.bank_accounts`: banco y
   * `account_label`, como en el catálogo de bancos). Medido el 2026-10-29: buscar el depósito en
   * esa cuenta se equivoca 0.7 % en el control; en todas las cuentas, 17.5 %. `null` = no medida:
   * el depósito no se reconoce solo y se dice.
   */
  cuenta_deposito: { banco: string; terminacion: string } | null;
}

export const ZONAS_HOJA_GASTOS: readonly ZonaHojaGastos[] = Object.freeze([
  { clave: 'morelia', nombre: 'Zona Morelia', sucursales: ['08', '07'], desde: '2026-10-29',
    cuenta_deposito: { banco: 'SANTANDER', terminacion: '1604' } },
  // Edgar, 2026-10-29: Canindo con los mismos parámetros. Su «Gastos generales» sólo trae gastos, y
  // la cuenta de su reposición no está medida.
  { clave: 'canindo', nombre: 'Zona Canindo', sucursales: ['06'], desde: '2026-10-29', cuenta_deposito: null },
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

/**
 * Un pago de la zona que ya salió de Caja General SIN hoja: del cajón, o ligado a un retiro de CAOS
 * a mano. Edgar, 2026-10-29: *«lo que se paga con cajón o no es reposición va abajo»*.
 */
export interface RenglonPagadoAparte extends RenglonHoja {
  como: 'cajon' | 'caos';
  /** Folio de Caja General (`CG-2026-00512`). */
  cg_folio: string | null;
}

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
  /** Los que ya salieron del cajón o de un retiro sin hoja: van abajo, no en la hoja. */
  pagados_aparte: RenglonPagadoAparte[];
  /** `null` = la hoja está vacía. */
  instruccion: InstruccionPagoHoja | null;
  /** Edad del dato de Kepler. `null` = sin medir. */
  datos_al: string | null;
}

// ── La hoja cerrada, sus firmas y su pago ───────────────────────────────────────────────────────

/**
 * cerrada → aprobada → pagada; o cerrada → rechazada | cancelada. Edgar, 2026-10-29: *«tiene que
 * estar aprobada, si no está aprobada no se puede pagar»*.
 */
export type EstadoHojaGastos = 'cerrada' | 'aprobada' | 'rechazada' | 'cancelada' | 'pagada';

/**
 * Con qué se pagó la hoja. Lo normal es UN retiro de CAOS por la hoja entera (Edgar, 2026-10-29:
 * *«todo lo de reposición es que salga de un solo movimiento de CAOS»*); el cajón es la excepción
 * y se dice (2 de 7 hojas de octubre no tuvieron retiro).
 */
export type MedioPagoHoja = 'caos' | 'cajon';

/**
 * Lo más que pone el cajón cuando la hoja se paga con un retiro: el retiro se redondea hacia abajo a
 * lo que da la máquina. Medido en las 5 hojas de octubre pagadas con un retiro: de $1.00 a $196.03.
 */
export const TOPE_CAJON_HOJA = 500;

/**
 * Días después del último pago de la hoja (o de su aprobación, si fue después) en que se busca el
 * retiro que la cuadra. Medido el 2026-10-29: las 5 hojas con retiro lo tienen a 0–4 días, cada una
 * con UN solo candidato y es el correcto; con el total corrido ±$1,000…±$20,000 (control) aparece
 * un candidato 2 de 200 veces (1 %), y sin la ventana de días 24 de 200 (12 %).
 */
export const DIAS_RETIRO_HOJA = 7;

/** Un retiro de CAOS libre que paga la hoja entera: no pasa de la hoja y el cajón pone menos del tope. */
export interface RetiroParaHoja {
  device: string;
  external_id: number;
  ref: string | null;
  total: number;
  /** Día de negocio (México) del retiro. */
  dia: string;
  /** Lo que pondría el cajón: el total de la hoja menos el retiro. */
  cajon: number;
}

export type EstadoDepositoHoja = 'depositada' | 'ambiguo' | 'no_aparece' | 'sin_medir';

/** El pago de una hoja pagada: con qué salió, quién la pagó y si el depósito ya llegó a la cuenta de la zona. */
export interface PagoDeHojaGastos {
  medio: MedioPagoHoja;
  /** El retiro que la pagó; `null` si salió del cajón. */
  retiro: { device: string; external_id: number; ref: string | null; total: number; dia: string } | null;
  /** Lo que puso el cajón: la diferencia con el retiro, o la hoja entera. */
  cajon: number;
  /** Cómo se contó lo que salió del cajón; `null` si se pagó con retiro o antes de exigir el conteo. */
  conteo?: ConteoCajonHoja | null;
  /**
   * El conteo se registró DESPUÉS de pagar (la hoja salió del cajón antes de exigirlo, como HG-1):
   * quién lo trajo y cuándo. `null` si se contó al pagar o no hay conteo.
   */
  conteo_despues?: { por_nombre: string | null; at: string } | null;
  pagada_por_nombre: string | null;
  pagada_at: string;
  /**
   * Renglones de la hoja que todavía no entran al libro de Caja General: el lote no los pudo
   * confirmar (casi siempre, la cuenta del beneficiario). Se reintentan con «Capturar».
   */
  sin_capturar: number;
  deposito: {
    estado: EstadoDepositoHoja;
    /** Los depósitos que suman el total (una o dos partes), o `null`. */
    depositos: Array<{ id: string; dia: string; importe: number }> | null;
    /** Por qué no hay depósito todavía, en llano, cuando no lo hay. */
    nota: string | null;
  };
}

export interface HojaGastos {
  id: string;
  numero: number;
  /** «HG-12»: lo que se escribe en la referencia del retiro de CAOS. */
  folio: string;
  zona: ClaveZonaHoja;
  nombre_zona: string;
  venta_del_dia: string;
  estado: EstadoHojaGastos;
  total: number;
  renglones: RenglonHoja[];
  por_sucursal: Array<SubtotalHoja & { sucursal: string }>;
  cerrada_por: string;
  cerrada_por_nombre: string | null;
  cerrada_at: string;
  /** Quién la aprobó: por el id, para que la pantalla no ofrezca pagarla a esa misma persona. */
  aprobada_por: string | null;
  aprobada_por_nombre: string | null;
  aprobada_at: string | null;
  resuelta_por_nombre: string | null;
  resuelta_at: string | null;
  motivo: string | null;
  instruccion: InstruccionPagoHoja;
  /**
   * Sólo en la aprobada: los retiros de CAOS libres que la pagan entera (de su último pago a
   * `DIAS_RETIRO_HOJA` días). Uno solo es la propuesta; ninguno, que todavía no se saca.
   */
  retiros_que_cuadran: RetiroParaHoja[];
  /** Sólo en la pagada; `null` en las demás. */
  pago: PagoDeHojaGastos | null;
}

export interface HojasDeGastos {
  abiertas: HojaAbierta[];
  /** Las de los últimos 45 días y las que siguen sin depositarse, de la más nueva a la más vieja. */
  cerradas: HojaGastos[];
  /** `false` = la migración de las hojas no está aplicada: se ve la abierta, no se puede cerrar. */
  instalada: boolean;
  datos_al: string | null;
  caos_al: string | null;
}

export interface CerrarHojaInput {
  /** Los pagos que van en esta hoja (todos los de la abierta, o los que la persona dejó). */
  origen_refs: string[];
  /** La venta de la que salió el dinero (lo que el papel dice en Observaciones). */
  venta_del_dia: string;
  /** Llave de la pantalla: el doble clic no cierra dos hojas. */
  client_key: string;
}

export interface MotivoHojaInput {
  motivo: string;
}

/**
 * Pagar una hoja APROBADA: con UN retiro de CAOS (que la cuadre) o, por excepción, con el cajón.
 * Lo hace otra persona que quien la aprobó. Los importes los pone el servidor.
 */
export type PagarHojaInput =
  | { medio: 'caos'; device: string; external_id: number }
  | { medio: 'cajon'; conteo: ConteoCajonHoja };

/**
 * Traer el conteo de una hoja YA PAGADA con el cajón que no lo tiene (se pagó antes de exigirlo).
 * Edgar, 2026-10-30, sobre HG-1: el arqueo está en papel en Control, «hay que traer ese arqueo».
 * Una sola vez: con el conteo puesto, la hoja pagada vuelve a ser intocable.
 */
export interface RegistrarConteoHojaInput {
  conteo: ConteoCajonHoja;
}

/**
 * ⭐ Lo que salió del cajón, CONTADO. Edgar, 2026-10-30, al pagar HG-1 con el cajón sin que nada le
 * pidiera contar: *«cuando sea de cajón que se haga un arqueo»*. Piezas por denominación (claves de
 * `DENOMINACIONES_MXN`: `1000`…`20`, `20m`…`0.5`) y la morralla de menos de 50¢, que no tiene pieza.
 */
export interface ConteoCajonHoja {
  piezas: Record<string, number>;
  morralla: number;
}

export type VeredictoConteoCajon =
  | { ok: true; suma: number; piezas: Record<string, number>; morralla: number }
  | { ok: false; motivo: 'pieza' | 'morralla' | 'no_cuadra'; texto: string; suma: number | null };

/**
 * La regla del conteo, la MISMA en la pantalla y en el servidor: cada pieza es de una denominación
 * del catálogo y entera; la morralla, de 0 a 49¢; y todo suma exactamente lo que sale del cajón
 * (en centavos, sin flotantes). Las piezas en cero se ignoran.
 */
export function revisarConteoCajon(conteo: ConteoCajonHoja | null | undefined, total: number): VeredictoConteoCajon {
  const piezas: Record<string, number> = {};
  let suma = 0n;
  for (const [k, n] of Object.entries(conteo?.piezas ?? {})) {
    const d = DENOMINACIONES_MXN.find((x) => x.key === k);
    if (!d || !Number.isSafeInteger(n) || n < 0) {
      return { ok: false, motivo: 'pieza', texto: `«${k}: ${n}» no es un conteo: las piezas son enteras y de una denominación de pesos.`, suma: null };
    }
    if (n === 0) continue;
    piezas[k] = n;
    suma += BigInt(n) * BigInt(Math.round(d.valor * 100));
  }
  const m = Number(conteo?.morralla ?? 0);
  const mc = Math.round(m * 100);
  if (!Number.isFinite(m) || m < 0 || Math.abs(m * 100 - mc) > 1e-6 || mc >= 50) {
    return { ok: false, motivo: 'morralla', texto: 'La morralla es lo de menos de 50¢: de $0.00 a $0.49.', suma: null };
  }
  suma += BigInt(mc);
  const esperado = BigInt(Math.round(Number(total) * 100));
  const sumaPesos = Number(suma) / 100;
  if (suma !== esperado) {
    const dif = suma - esperado;
    return {
      ok: false, motivo: 'no_cuadra', suma: sumaPesos,
      texto: `El conteo suma ${formatearDinero(suma)} y del cajón salen ${formatearDinero(esperado)}: ${dif > 0n ? 'sobran' : 'faltan'} ${formatearDinero(dif > 0n ? dif : -dif)}.`,
    };
  }
  return { ok: true, suma: sumaPesos, piezas, morralla: mc / 100 };
}

/** El conteo en una línea, de la pieza mayor a la menor: «83 × $1,000 · 1 × $500 · morralla $0.39». */
export function textoConteoCajon(conteo: ConteoCajonHoja): string {
  const partes = DENOMINACIONES_MXN
    .filter((d) => (conteo.piezas[d.key] ?? 0) > 0)
    .map((d) => `${conteo.piezas[d.key]} × ${d.label}${d.key === '20m' ? ' (moneda)' : ''}`);
  if (Number(conteo.morralla) > 0) partes.push(`morralla ${formatearDinero(BigInt(Math.round(Number(conteo.morralla) * 100)))}`);
  return partes.join(' · ') || 'sin piezas';
}

/** Lo que pasó al pagar (o al reintentar la captura): la hoja como quedó y renglón por renglón. */
export interface PagoHojaResultado {
  hoja: HojaGastos;
  /** Renglones que ya estaban en el libro sin retiro y se ligaron al de la hoja. */
  ligados: number;
  /** Renglones que entraron al libro con este pago. */
  capturados: number;
  /** Los que no entraron, con su motivo: se reintentan con «Capturar». */
  sin_capturar: Array<{ origen_ref: string; motivo: string | null }>;
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
