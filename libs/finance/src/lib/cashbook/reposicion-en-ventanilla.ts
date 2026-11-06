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
 *  · un pago que ya va en una orden de reposición (por firmar, vigente o usada) no vuelve a entrar;
 *  · ⭐ `[LE.6.18]` cada pago con el veredicto de `veredictoDePago` (LE.2.13, el MISMO del pago suelto):
 *    lo detenido (gasto sin aprobar o rechazado…) sale a `detenidos` y no entra hasta arreglarse; y la
 *    hoja pide la firma de Tesorería SÓLO si algún pago no trae autorización (PM, 2026-11-06: *«¿por qué
 *    volver a confirmar una hoja que ya tiene todos los gastos aprobados?»*). Un pago sin veredicto
 *    (sin ODS: no medido) pide firma: lo no medido nunca sale como autorizado.
 */
import { centavosATexto, pesosACentavos, type HojaDeReposicion, type PagoDeReposicion, type ZonaHojaGastos } from '@megadulces/contracts';
import { armarHojaAbierta, instruccionDePago, type PagoDeZona } from '../caja/hoja-gastos.engine';
import { MOTIVO_BLOQUEO, veredictoDePago, type Respaldo } from './plan-de-pago';

/** `[LE.6.18]` Lo que dice `veredictoDePago` de un pago: si no puede salir, o si sale con la firma de Tesorería. */
export interface JuicioDePago { detenido: string | null; firma: string | null }

/**
 * `[LE.6.18]` El juicio de cada X-D-26 con lo que Kepler dice que paga (LE.2.13): el MISMO `veredictoDePago`
 * del pago suelto. La Ventanilla y la hoja de zona en Caja (`[LE.6.19]`) juzgan con esta función. Un
 * documento sin respaldo leído (`undefined`) pide firma: lo no medido nunca sale como autorizado.
 */
export function juiciosDePagos(
  pagos: ReadonlyArray<{ origen_ref: string; sucursal: string; doc_tipo: string; folio: string; importe: number | string }>,
  respaldos: ReadonlyMap<string, { respaldo: Respaldo | undefined }>,
): Map<string, JuicioDePago> {
  const out = new Map<string, JuicioDePago>();
  for (const p of pagos) {
    if (p.doc_tipo !== 'X-D-26') continue;
    const v = veredictoDePago(pesosACentavos(Number(p.importe).toFixed(2)), { yaOrdenado: false, yaPagado: false,
      respaldo: respaldos.get(`${p.sucursal}|${p.folio}`)?.respaldo });
    out.set(p.origen_ref, { detenido: v.bloqueo ? MOTIVO_BLOQUEO[v.bloqueo] : null, firma: v.requiereFirma ? v.motivoFirma : null });
  }
  return out;
}

const SIN_VEREDICTO: JuicioDePago = { detenido: null, firma: 'Kepler no se pudo leer: no consta qué autoriza el pago' };

const minor = (pesos: number | string): string => centavosATexto(pesosACentavos(Number(pesos).toFixed(2)));

function pago(p: { origen_ref: string; sucursal: string; folio: string; fecha_pago: string; beneficiario: string | null; importe: number | string },
  motivo?: string): PagoDeReposicion {
  return { origen_ref: p.origen_ref, sucursal: p.sucursal, folio: p.folio, fecha_pago: p.fecha_pago, beneficiario: p.beneficiario,
    importe_minor: minor(p.importe), ...(motivo ? { motivo } : {}) };
}

/** Los pagos que entrarían a la hoja de hoy: desde la apertura y sin orden viva. Son los que se juzgan. */
export function candidatosDeReposicion(pagos: readonly PagoDeZona[], arranque: string | null, tomados: ReadonlySet<string>): PagoDeZona[] {
  return arranque ? pagos.filter((p) => p.fecha_pago >= arranque && !tomados.has(p.origen_ref)) : [];
}

/** La frase de la firma: cuántos pagos la piden y por qué (el primer motivo; los demás suelen repetirlo). */
function motivoDeFirma(firmas: ReadonlyArray<string>): string | null {
  if (!firmas.length) return null;
  return `${firmas.length === 1 ? '1 pago no trae' : `${firmas.length} pagos no traen`} su autorización (${firmas[0]}): la firma Tesorería`;
}

export function hojaDeReposicion(zona: ZonaHojaGastos, pagos: readonly PagoDeZona[], arranque: string | null,
  tomados: ReadonlySet<string>, juicios: ReadonlyMap<string, JuicioDePago> = new Map()): HojaDeReposicion {
  const antes = arranque ? pagos.filter((p) => p.fecha_pago < arranque) : [...pagos];
  const anteriores = { n: antes.length, monto_minor: centavosATexto(antes.reduce((s, p) => s + pesosACentavos(Number(p.importe).toFixed(2)), 0n)) };
  const vacia: HojaDeReposicion = { zona: zona.clave, nombre: zona.nombre, sin_arranque: !arranque, renglones: [], total_minor: '0',
    maquina_minor: '0', cajon_minor: '0', fuera: [], detenidos: [], motivo_firma: null, anteriores };
  if (!arranque) return vacia;
  // Primero la regla de la hoja (qué es reposición); el veredicto sólo se aplica a lo que sí lo es.
  const abierta = armarHojaAbierta(zona, candidatosDeReposicion(pagos, arranque, tomados), null);
  const fuera = abierta.fuera.map((f) => pago(f, f.motivo));
  const juicio = (ref: string) => juicios.get(ref) ?? SIN_VEREDICTO;
  const detenidos = abierta.renglones.filter((r) => juicio(r.origen_ref).detenido);
  const salen = new Set(abierta.renglones.filter((r) => !juicio(r.origen_ref).detenido).map((r) => r.origen_ref));
  const h = salen.size === abierta.renglones.length ? abierta
    : armarHojaAbierta(zona, candidatosDeReposicion(pagos, arranque, tomados).filter((p) => salen.has(p.origen_ref)), null);
  const conDetenidos = { ...vacia, fuera, detenidos: detenidos.map((r) => pago(r, juicio(r.origen_ref).detenido as string)) };
  if (!h.renglones.length) return conDetenidos;
  const i = instruccionDePago(h.total, null);
  return {
    ...conDetenidos,
    renglones: h.renglones.map((r) => pago(r)),
    total_minor: minor(h.total), maquina_minor: minor(i.retiro), cajon_minor: minor(i.cajon),
    motivo_firma: motivoDeFirma(h.renglones.map((r) => juicio(r.origen_ref).firma).filter((m): m is string => !!m)),
  };
}
