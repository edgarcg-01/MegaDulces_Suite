import {
  claseDeClave, folioHoja, leerFolioHoja, pagableConBilletesCaos,
  type ClaseRenglonHoja, type HojaAbierta, type InstruccionPagoHoja, type MotivoFueraDeHoja,
  type RenglonHoja, type ZonaHojaGastos,
} from '@megadulces/contracts';
import { redondea2 } from './caja-lote.engine';

/**
 * ⭐ `[CGA-A.65]` La hoja de gastos de zona — el motor. Puro: decide qué pago va en la hoja, cuánto
 * se saca de CAOS y se deposita, y reconoce el retiro y el depósito de cada hoja.
 *
 * Edgar, 2026-10-29: *«no queremos impresiones, solo quiero que se automatice el proceso tanto del
 * excel como a la hora de pagar»*. La hoja que hoy se llena a mano en Excel (área «ZONA MORELIA»)
 * se arma sola con los pagos de Kepler; se reponen con un retiro de CAOS y un depósito por el total.
 */

/** Un pago de la zona tal como lo trae la consulta (`numeric` llega como texto: se convierte aquí). */
export interface PagoDeZona {
  origen_ref: string;
  sucursal: string;
  doc_tipo: string;
  folio: string;
  fecha_pago: string;
  fecha_captura: string | null;
  beneficiario: string | null;
  clave: string | null;
  centro: string | null;
  referencia: string | null;
  importe: number | string;
}

/**
 * Por qué un pago NO va en la hoja, o `null` si va. Medido el 2026-10-29: con estas cuatro
 * exclusiones, seis hojas de octubre salen al centavo de su depósito en el banco; con «sólo el
 * centro 007», cuatro (quien captura a veces deja el centro vacío o usa el 004, y esos pagos SÍ
 * iban en la hoja). El pago de una compra registrada se mira antes que el centro: en Morelia el
 * centro 003 «Comisiones ventas» también se usa para pagar mercancía («C-237»).
 */
export function motivoFueraDeHoja(centro: string | null | undefined, referencia: string | null | undefined): MotivoFueraDeHoja | null {
  const c = String(centro ?? '').trim();
  if (c === '009') return 'nomina';
  if (c === '002') return 'apoyo_proveedores';
  if (/^(C-|COMPRA)/i.test(String(referencia ?? '').trim())) return 'compra_registrada';
  if (c === '003') return 'comisiones';
  return null;
}

/**
 * Cómo se paga una hoja: de CAOS sale lo que la máquina da en billetes, el cajón completa y se
 * deposita el total. (Las hojas en papel se repusieron igual: el retiro abajo del total y el cajón
 * con la diferencia, de $1.00 a $196.03.)
 */
export function instruccionDePago(total: number, numero: number | null): InstruccionPagoHoja {
  const t = redondea2(total);
  const retiro = pagableConBilletesCaos(t);
  return { retiro, cajon: redondea2(t - retiro), deposito: t, referencia: numero == null ? null : folioHoja(numero) };
}

const CLASES: readonly ClaseRenglonHoja[] = ['proveedor', 'gasto', 'sin_clave'];

/**
 * La hoja abierta de una zona: lo que hoy se teclea en Excel. En el orden de la hoja en papel
 * (Abastos antes que Madero, por día de pago y folio), con lo que NO va y por qué.
 */
export function armarHojaAbierta(zona: ZonaHojaGastos, pagos: readonly PagoDeZona[], datosAl: string | null): HojaAbierta {
  const orden = (s: string) => {
    const i = zona.sucursales.indexOf(s);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const renglones: RenglonHoja[] = [];
  const fuera: HojaAbierta['fuera'] = [];
  const vistos = new Set<string>();
  const ordenados = [...pagos].sort((a, b) => orden(a.sucursal) - orden(b.sucursal)
    || a.fecha_pago.localeCompare(b.fecha_pago) || a.folio.localeCompare(b.folio));
  for (const p of ordenados) {
    // Sólo la zona, y cada pago una vez: la consulta ya lo cuida; aquí no se confía en eso.
    if (!zona.sucursales.includes(p.sucursal) || vistos.has(p.origen_ref)) continue;
    vistos.add(p.origen_ref);
    const r: RenglonHoja = {
      origen_ref: p.origen_ref, sucursal: p.sucursal, doc_tipo: p.doc_tipo, folio: p.folio,
      fecha_pago: p.fecha_pago, fecha_captura: p.fecha_captura, beneficiario: p.beneficiario,
      clave: p.clave, centro: p.centro, clase: claseDeClave(p.clave), importe: redondea2(Number(p.importe)),
    };
    const motivo = motivoFueraDeHoja(p.centro, p.referencia);
    if (motivo) fuera.push({ ...r, motivo });
    else renglones.push(r);
  }
  const suma = (xs: RenglonHoja[]) => redondea2(xs.reduce((a, x) => a + x.importe, 0));
  const total = suma(renglones);
  return {
    zona: zona.clave, nombre: zona.nombre, desde: zona.desde, renglones, total,
    // Todas las sucursales de la zona, también la que no pagó nada: el universo se declara.
    por_sucursal: zona.sucursales.map((s) => {
      const xs = renglones.filter((r) => r.sucursal === s);
      return { sucursal: s, renglones: xs.length, total: suma(xs) };
    }),
    por_clase: CLASES.map((c) => {
      const xs = renglones.filter((r) => r.clase === c);
      return { clase: c, renglones: xs.length, total: suma(xs) };
    }).filter((x) => x.renglones > 0),
    fuera,
    instruccion: renglones.length ? instruccionDePago(total, null) : null,
    datos_al: datosAl,
  };
}

// ── Al pagar: el retiro y el depósito de cada hoja ────────────────────────────────────────────

export interface RetiroCaosHoja {
  device: string;
  external_id: number;
  occurred_at: string;
  ref: string | null;
  total: number;
}

/** Los retiros de CAOS cuya referencia nombra la hoja («gnf morelia HG-12»). Uno es lo normal. */
export function retirosDeHoja(numero: number, retiros: readonly RetiroCaosHoja[]): RetiroCaosHoja[] {
  return retiros.filter((r) => leerFolioHoja(r.ref) === numero);
}

export interface DepositoBancoHoja {
  id: string;
  /** Día del movimiento en el estado de cuenta. */
  dia: string;
  importe: number;
}

/** Monedas: el depósito de las hojas medidas difirió de su total entre −$0.19 y +$0.01. */
export const TOLERANCIA_DEPOSITO_HOJA = 0.5;
/** El depósito llegó el mismo día del retiro o hasta dos días después en las hojas medidas. */
export const DIAS_DEPOSITO_HOJA = 7;

export type DepositoDeHoja =
  | { estado: 'encontrado'; ids: string[]; suma: number }
  | { estado: 'ambiguo'; opciones: number }
  | { estado: 'no_encontrado' };

const diasEntre = (a: string, b: string) => (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000;

/**
 * El depósito de una hoja: UNO o DOS depósitos de la cuenta de reposición, del día `desde` (el del
 * retiro) a siete días después, que suman el total ± $0.50. Medido el 2026-10-29 sobre siete hojas
 * de octubre y la cuenta donde se depositaron (69 depósitos): encuentra seis, cada una con una sola
 * combinación; con el total corrido de ±$1,000 a ±$20,000 (control) se equivoca 2 de 280 veces
 * (0.7 %). Con tres partes encuentra lo mismo y se equivoca 2.5 %: por eso dos. Más de una
 * combinación posible no se elige. La hoja del 14/10 se depositó en seis partes: ésa la liga una
 * persona.
 */
export function depositoDeHoja(total: number, desde: string, depositos: readonly DepositoBancoHoja[]): DepositoDeHoja {
  const t = redondea2(total);
  const c = depositos.filter((d) => {
    const x = diasEntre(desde, d.dia);
    return x >= 0 && x <= DIAS_DEPOSITO_HOJA;
  });
  const cuadra = (s: number) => Math.abs(redondea2(s) - t) <= TOLERANCIA_DEPOSITO_HOJA + 0.000001;
  const opciones: DepositoBancoHoja[][] = [];
  for (let i = 0; i < c.length; i++) {
    if (cuadra(c[i].importe)) opciones.push([c[i]]);
    for (let j = i + 1; j < c.length; j++) if (cuadra(c[i].importe + c[j].importe)) opciones.push([c[i], c[j]]);
  }
  if (!opciones.length) return { estado: 'no_encontrado' };
  if (opciones.length > 1) return { estado: 'ambiguo', opciones: opciones.length };
  const [o] = opciones;
  return { estado: 'encontrado', ids: o.map((d) => d.id), suma: redondea2(o.reduce((a, d) => a + d.importe, 0)) };
}
