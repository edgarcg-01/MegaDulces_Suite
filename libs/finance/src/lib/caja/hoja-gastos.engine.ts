import {
  DIAS_RETIRO_HOJA, TOPE_CAJON_HOJA, ZONAS_HOJA_GASTOS, claseDeClave, folioHoja, leerFolioHoja, pagableConBilletesCaos,
  type ClaseRenglonHoja, type HojaAbierta, type InstruccionPagoHoja, type MotivoFueraDeHoja,
  type RenglonHoja, type RetiroParaHoja, type ZonaHojaGastos,
} from '@megadulces/contracts';
import { redondea2 } from './caja-lote.engine';

/**
 * ⭐ `[CGA-A.65]` La hoja de gastos de zona — el motor. Puro: decide qué pago va en la hoja (y qué
 * pago sólo se paga con ella), cuánto se saca de CAOS, qué retiro la paga entera y si su depósito
 * ya llegó.
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
  /**
   * Si ya está en el libro de Caja General y de dónde salió: ligado a un retiro (`caos`), del
   * cajón (`cajon`), o capturado sin decirlo (`sin_origen`). `null` = todavía no está en el libro.
   */
  en_libro: 'caos' | 'cajon' | 'sin_origen' | null;
  cg_folio: string | null;
  /** Ya va en una hoja vigente (cerrada, aprobada o pagada). */
  en_hoja: boolean;
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
  const pagadosAparte: HojaAbierta['pagados_aparte'] = [];
  const vistos = new Set<string>();
  const ordenados = [...pagos].sort((a, b) => orden(a.sucursal) - orden(b.sucursal)
    || a.fecha_pago.localeCompare(b.fecha_pago) || a.folio.localeCompare(b.folio));
  for (const p of ordenados) {
    // Sólo la zona, y cada pago una vez: la consulta ya lo cuida; aquí no se confía en eso. Lo que
    // ya va en una hoja vigente está en ESA hoja, no en la abierta.
    if (!zona.sucursales.includes(p.sucursal) || vistos.has(p.origen_ref) || p.en_hoja) continue;
    vistos.add(p.origen_ref);
    const r: RenglonHoja = {
      origen_ref: p.origen_ref, sucursal: p.sucursal, doc_tipo: p.doc_tipo, folio: p.folio,
      fecha_pago: p.fecha_pago, fecha_captura: p.fecha_captura, beneficiario: p.beneficiario,
      clave: p.clave, centro: p.centro, clase: claseDeClave(p.clave), importe: redondea2(Number(p.importe)),
    };
    const motivo = motivoFueraDeHoja(p.centro, p.referencia);
    // Lo que no es reposición va abajo con su motivo, aunque ya esté en el libro.
    if (motivo) fuera.push({ ...r, motivo });
    // Lo que ya salió del cajón o de un retiro sin hoja, también abajo: ya está pagado.
    else if (p.en_libro === 'cajon' || p.en_libro === 'caos') pagadosAparte.push({ ...r, como: p.en_libro, cg_folio: p.cg_folio });
    // Lo capturado sin decir de dónde salió SÍ va en la hoja: al pagarla se liga a su retiro.
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
    pagados_aparte: pagadosAparte,
    instruccion: renglones.length ? instruccionDePago(total, null) : null,
    datos_al: datosAl,
  };
}

// ── El candado: qué pago sólo se paga con su hoja aprobada ────────────────────────────────────

/** Lo que el candado necesita saber de un pago de Kepler: de qué sucursal, de qué día y qué es. */
export interface PagoParaCandado {
  sucursal: string;
  fecha_pago: string;
  centro: string | null;
  referencia: string | null;
}

/**
 * ⛔ ¿Este pago SÓLO se paga con su hoja aprobada? Sí, si es de una zona que se repone por hoja, de su
 * día de arranque en adelante, y va en la hoja (no es nómina, apoyo a proveedores, comisiones ni
 * pago de compra registrada). Devuelve la zona, o `null` si el pago sigue su camino de siempre.
 *
 * Edgar, 2026-10-29: *«si no está aprobada no se puede pagar»*. La MISMA regla que arma la hoja
 * (`motivoFueraDeHoja`), en un solo lugar: si el candado y la hoja decidieran distinto, quedaría
 * un pago que ni entra a la hoja ni se puede pagar suelto.
 */
export function requisitoDeHoja(p: PagoParaCandado): ZonaHojaGastos | null {
  const zona = ZONAS_HOJA_GASTOS.find((z) => z.sucursales.includes(p.sucursal));
  if (!zona || !p.fecha_pago || p.fecha_pago.slice(0, 10) < zona.desde) return null;
  return motivoFueraDeHoja(p.centro, p.referencia) ? null : zona;
}

// ── Al pagar: el retiro que paga la hoja entera ───────────────────────────────────────────────

export type CuadreRetiro =
  | { ok: true; cajon: number }
  | { ok: false; motivo: 'mayor' | 'corto' | 'vacio'; texto: string };

const pesos = (v: number) => `$${v.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * ¿Este retiro paga la hoja entera? Sí, si no pasa de la hoja (lo que sobrara quedaría sin
 * explicar) y lo que falta lo pone el cajón, menos de `TOPE_CAJON_HOJA`. Así se pagaron las 5
 * hojas de octubre que tuvieron retiro: el cajón puso de $1.00 a $196.03.
 */
export function cuadreDelRetiro(totalHoja: number, retiro: number): CuadreRetiro {
  const t = redondea2(totalHoja);
  const r = redondea2(retiro);
  if (!(r > 0)) return { ok: false, motivo: 'vacio', texto: 'Ese retiro no tiene dinero libre.' };
  if (r > t + 0.005) {
    return { ok: false, motivo: 'mayor', texto: `El retiro (${pesos(r)}) es mayor que la hoja (${pesos(t)}): sobrarían ${pesos(redondea2(r - t))} sin explicar.` };
  }
  const cajon = redondea2(t - r);
  if (cajon >= TOPE_CAJON_HOJA - 0.005) {
    return { ok: false, motivo: 'corto', texto: `Al retiro (${pesos(r)}) le faltan ${pesos(cajon)} para la hoja: el cajón pone menos de ${pesos(TOPE_CAJON_HOJA)}.` };
  }
  return { ok: true, cajon };
}

/** Un retiro de CAOS todavía sin nada ligado, candidato a pagar una hoja. */
export interface RetiroLibreHoja {
  device: string;
  external_id: number;
  /** Día de negocio (México). */
  dia: string;
  occurred_at: string;
  ref: string | null;
  total: number;
}

/**
 * Los retiros que pagan la hoja entera, de `desde` (su último pago) a `hasta` + `DIAS_RETIRO_HOJA`.
 * Primero el que trae el folio de la hoja en su referencia, después el que deja menos al cajón.
 * Uno solo es la propuesta; la confirma una persona (el control con totales corridos encuentra un
 * candidato falso 1 % de las veces: no se liga solo).
 */
export function retirosQueCuadran(
  totalHoja: number, numero: number | null, desde: string, hasta: string, retiros: readonly RetiroLibreHoja[],
): RetiroParaHoja[] {
  const limite = new Date(Date.parse(`${hasta}T00:00:00Z`) + DIAS_RETIRO_HOJA * 86400000).toISOString().slice(0, 10);
  const out: Array<RetiroParaHoja & { folio: boolean; occurred_at: string }> = [];
  for (const r of retiros) {
    if (r.dia < desde || r.dia > limite) continue;
    const c = cuadreDelRetiro(totalHoja, r.total);
    if (!c.ok) continue;
    out.push({ device: r.device, external_id: r.external_id, ref: r.ref, total: redondea2(r.total), dia: r.dia, cajon: c.cajon,
      folio: numero != null && leerFolioHoja(r.ref) === numero, occurred_at: r.occurred_at });
  }
  return out
    .sort((a, b) => Number(b.folio) - Number(a.folio) || a.cajon - b.cajon
      || a.occurred_at.localeCompare(b.occurred_at) || a.external_id - b.external_id)
    .map(({ folio: _f, occurred_at: _o, ...r }) => r);
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
