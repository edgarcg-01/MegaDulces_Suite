import type { AlcanceDeLaBase, FaltanteSolicitud, FaltanteSolicitudId, FuenteDelDato } from '@megadulces/contracts';

/**
 * `[PGP.123]` S.13 — Las reglas de texto y de foco de «Registrar o pedir un gasto», puras para poder probarlas sin
 * montar la pantalla. Nacen de la prueba visual de la bandeja del SAT (anexo S §14, hallazgos H1, H19 y H20).
 * `[PGP.122]` S.17 — y las del orden nuevo (anexo S §15): qué se dice sin base, la línea del plazo y qué reemplaza
 * «Usar esta factura».
 */

const MIENTRAS = 'Mientras, captura en Kepler y usa «Tengo un folio de Kepler».';

/** S.17 (DS27) — Qué se dice cuando no hay base donde pedir, según cómo la decidió el servidor. */
export function sinBaseTexto(alcance: AlcanceDeLaBase | null | undefined): string {
  switch (alcance) {
    case 'sin_almacen': return `Tu ficha no tiene almacén asignado: pídele a Sistemas que te asigne los tuyos. ${MIENTRAS}`;
    case 'ninguna': return `Tu usuario no tiene almacenes para pedir gastos. ${MIENTRAS}`;
    case 'una': return `La solicitud en la Suite todavía no está abierta en tu almacén. ${MIENTRAS}`;
    case 'varias': return `La solicitud en la Suite todavía no está abierta en tus almacenes. ${MIENTRAS}`;
    default: return `La solicitud en la Suite todavía no está abierta en ninguna base. ${MIENTRAS}`;
  }
}

/**
 * S.17 (DS30) — La línea del plazo, en llano: cuándo se paga y desde dónde se contó. `dias` `null` = «otra fecha».
 * Un plazo vencido se pide para hoy y se dice cuándo venció (el servidor descarta una fecha de pago pasada).
 */
export function textoDelPlazo(p: { dias: number | null; fecha: string | null; vencio: string | null; desde: 'documento' | 'hoy'; fechaLarga: (iso: string) => string }): string {
  if (p.dias === 0) return 'De contado: se pide para hoy.';
  if (!p.fecha) return 'Elige la fecha de pago.';
  if (p.vencio) return `Venció el ${p.fechaLarga(p.vencio)} (${p.dias} días después del documento): se pide para hoy.`;
  if (p.dias === null) return `Se paga el ${p.fechaLarga(p.fecha)}.`;
  return `Se paga el ${p.fechaLarga(p.fecha)}: ${p.dias} días después ${p.desde === 'documento' ? 'del documento' : 'de hoy'}.`;
}

/** Un renglón en captura (lo que va a kdm6). */
export interface RenglonEnCaptura { concepto: string | null; proyecto: string | null; departamento: string | null; importe: number | null }

export const FUENTE_TEXTO: Record<FuenteDelDato, string> = {
  cfdi: 'de la factura del SAT', ticket: 'leído del comprobante', habito: 'como la última vez', catalogo: 'del catálogo de Kepler',
  sesion: 'de tu sesión', persona: 'lo escribiste tú',
};

/** «a», «a y b», «a, b y c»; antes de «i»/«hi» la conjunción es «e» («departamento e importe»). */
export function enLista(xs: readonly string[]): string {
  if (xs.length <= 1) return xs[0] ?? '';
  const ultimo = xs[xs.length - 1];
  const y = /^h?i(?!e)/i.test(ultimo) ? 'e' : 'y';
  return `${xs.slice(0, -1).join(', ')} ${y} ${ultimo}`;
}

const CAMPOS_DEL_RENGLON = ['concepto', 'proyecto', 'departamento', 'importe'] as const;

/**
 * H1 — De dónde salió cada campo del renglón `n`, en una línea: «Concepto, proyecto y departamento: como la última
 * vez · importe: de la factura del SAT». Antes el renglón entero decía «de la factura del SAT» aunque el concepto, el
 * proyecto y el área salieran del hábito: el rótulo le decía a la persona que no hacía falta revisar justo lo que
 * tenía que revisar. Lo que escribió la persona no se rotula. `null` si ningún campo lo llenó la Suite.
 */
export function origenDelRenglon(fuentes: Readonly<Record<string, FuenteDelDato>>, n: number): string | null {
  const grupos = new Map<string, string[]>();
  for (const campo of CAMPOS_DEL_RENGLON) {
    const f = fuentes[`${campo}_${n}`];
    if (!f || f === 'persona') continue;
    const texto = FUENTE_TEXTO[f];
    grupos.set(texto, [...(grupos.get(texto) ?? []), campo]);
  }
  if (!grupos.size) return null;
  const linea = [...grupos].map(([texto, campos]) => `${enLista(campos)}: ${texto}`).join(' · ');
  return linea.charAt(0).toUpperCase() + linea.slice(1);
}

/** El comprobante que hay capturado, para decir qué reemplazaría «Usar esta factura» (S.17, DS29). */
export interface ComprobanteEnCurso {
  archivo: { live?: boolean } | null;
  folio: string;
  /** La factura del SAT que ya usa la solicitud, si alguna. */
  uuid: string | null;
  fuentes: Readonly<Record<string, FuenteDelDato>>;
}

/**
 * S.17 (DS29) — Lo que «Usar esta factura» REEMPLAZA del comprobante ya capturado, nombrado con lo que de verdad hay
 * (S.13 H19: el diálogo decía «la foto» sin foto). El proveedor y lo que puso su hábito (concepto, área, forma de pago)
 * NO cuentan: con el orden nuevo, elegir al proveedor y luego su factura es el camino normal, y preguntar por eso sería
 * un clic que sólo confirma. Vacío = se usa sin preguntar.
 */
export function loQueReemplaza(c: ComprobanteEnCurso, uuidNueva: string): string[] {
  const yo = (campo: string) => c.fuentes[campo] === 'persona';
  const otraFactura = !!c.uuid && c.uuid !== uuidNueva;
  return [
    c.archivo ? (c.archivo.live ? 'la foto' : 'el archivo') : null,
    otraFactura ? 'la otra factura del SAT' : null,
    // El folio que vino de la otra factura ya se nombró arriba; el escrito o leído del ticket, aquí.
    c.folio && !otraFactura && c.fuentes['folio'] !== 'cfdi' ? 'el folio' : null,
    yo('fecha') ? 'la fecha' : null,
    yo('importe_1') ? 'el importe' : null,
    yo('iva') ? 'el IVA' : null,
  ].filter((x): x is string => !!x);
}

/**
 * Dónde vive cada faltante en la pantalla, y en qué orden se recorre. S.17 (Francisco, 2026-11-16): 1 la base →
 * 2 el proveedor → 3 el comprobante → 4 qué es y cuánto → 5 cómo se paga (forma, plazo e información de pago). Los del
 * renglón se resuelven aparte: van al primer campo vacío de SU renglón.
 * `Record` cerrado: un faltante nuevo en el contrato no compila hasta tener su lugar.
 */
const LUGAR_DEL_FALTANTE: Record<FaltanteSolicitudId, { orden: number; id: string }> = {
  acreedor: { orden: 20, id: 'pg-acreedor' },
  alcance: { orden: 21, id: 'pg-acreedor' },
  comprobante: { orden: 30, id: 'pg-doc-t' },
  fecha_documento: { orden: 31, id: 'pg-fecha' },
  motivo_fecha: { orden: 32, id: 'pg-motivo-fecha' },
  evidencia: { orden: 33, id: 'pg-doc-t' },
  renglones: { orden: 40, id: 'pg-que' },
  renglon: { orden: 41, id: 'pg-que' },
  importe: { orden: 41, id: 'pg-que' },
  iva: { orden: 45, id: 'pg-iva' },
  forma_pago: { orden: 50, id: 'pg-como' },
  forma_pago_detalle: { orden: 51, id: 'pg-detalle' },
  pago_cuenta: { orden: 60, id: 'pg-cuenta' },
  pago_banco: { orden: 61, id: 'pg-banco' },
  pago_correo: { orden: 62, id: 'pg-correo' },
};

/**
 * H20 — El id del PRIMER campo que falta, en el orden de la pantalla; `null` si no falta nada. Después de «Registrar»
 * el foco iba siempre a «Qué es y cuánto», aunque ya estuviera lleno y lo que faltara fuera la forma de pago.
 */
export function campoQueFalta(faltan: readonly FaltanteSolicitud[], renglones: readonly RenglonEnCaptura[]): string | null {
  let primero: { orden: number; id: string } | null = null;
  for (const f of faltan) {
    const n = Number(/^Renglón (\d+)$/.exec(f.label)?.[1] ?? 0);
    let lugar = LUGAR_DEL_FALTANTE[f.id];
    if (n) {
      const i = n - 1;
      const r = renglones[i];
      // La cuenta fuera de alcance es del concepto; si no, el primer campo vacío del renglón, de izquierda a derecha.
      const id = f.id === 'alcance' || !r?.concepto ? `pg-con-${i}` : !r.proyecto ? `pg-pro-${i}` : !r.departamento ? `pg-dep-${i}` : `pg-imp-${i}`;
      lugar = { orden: 41 + n / 1000, id };
    }
    if (!primero || lugar.orden < primero.orden) primero = lugar;
  }
  return primero?.id ?? null;
}
