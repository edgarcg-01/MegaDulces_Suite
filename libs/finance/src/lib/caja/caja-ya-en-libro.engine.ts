import type { ComoYaEnLibro, YaEnLibro } from '@megadulces/contracts';

/**
 * ⭐ `[CGA-A.71]` **¿Este pendiente de Kepler ya entró al libro por otro camino?** — el motor. Puro.
 *
 * Edgar, 2026-11-09: la cola de Captura publicaba 88 pendientes. Medido en prod ese día (sólo
 * lectura): 19 ya estaban en el libro como depósitos de CAOS capturados SIN declarar el documento
 * —el hueco que `[CG.85]` dejó abierto: «mientras declarar el documento desde CAOS sea opcional, lo
 * que no se declare vuelve a duplicarse»— y 2 con la llave de otro documento. Confirmarlos desde la
 * cola mete el dinero dos veces (así se duplicó la ruta 23 del 13-oct).
 *
 * ⛔ No esconde nada: `[CG.85]` prohíbe ocultar por semejanza («un duplicado se ve y se corrige; un
 * movimiento escondido no»). Marca, y quien captura decide. Por eso sólo `deposito_ruta` es certeza
 * alta (la persona escribió la ruta y el día); lo demás casa por importe y dice «por confirmar».
 *
 * Una captura del libro explica UN solo pendiente: se recorren las reglas de la más fuerte a la más
 * débil y lo que ya se usó no vuelve a contar. Control negativo medido el 2026-11-09 sobre los 86
 * pendientes de ese día: con la ruta vecina, 0 de 56; con el importe corrido +$317, 0 de 66.
 */

export interface PendienteParaLibro {
  origen_ref: string;
  sucursal: string;
  doc_tipo: string;
  folio: string;
  /** Día del documento (YYYY-MM-DD). */
  fecha: string;
  monto: number;
  tipo: string;
  /** La ruta que afirma la vista (`ruta_23`), o `null`. */
  ruta: string | null;
}

export interface CapturaDelLibro {
  /** `finance.cash_ledger.id`: con él se liga (`[CGA-A.72]`). */
  id?: string | null;
  folio: string;
  /** Día del libro (YYYY-MM-DD). */
  fecha: string;
  monto: number;
  tipo: string;
  origen_tipo: string | null;
  origen_ref: string | null;
  declared_doc_ref: string | null;
  glosa: string | null;
}

/** CAOS no cuenta morralla: el depósito sale abajo del cobro por las monedas. Medido: hasta $35. */
export const TOLERANCIA_DEPOSITO_RUTA = 50;
/** Lo que casa sólo por importe tiene que ser el mismo, al peso. */
export const TOLERANCIA_IMPORTE_LIBRO = 1;
/** El depósito o la captura llegan después del documento: el lunes se capturó lo del viernes y sábado. */
export const DIAS_LIBRO_DESPUES = 3;
/** La misma llave en otra camioneta se capturó hasta cinco días después (CI-2026-00017). */
export const DIAS_OTRA_CAMIONETA = 7;

const dias = (a: string, b: string) => (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000;
const pad = (n: number) => String(n).padStart(2, '0');

/**
 * La ruta y el día que una persona escribió en la glosa: «rd21 10/10», «r23 15 10 26»,
 * «ruta 27  151026», «ruta22151026». El año sale del día del libro. `dia: null` = no lo escribió.
 */
export function rutaDeLaGlosa(glosa: string | null, diaLibro: string): { ruta: string; dia: string | null } | null {
  const g = glosa ?? '';
  // Pegada: «ruta22151026» = la ruta y el día sin espacios (ddmmaa).
  const pegada = /\b(?:rd|r|ruta)\s*(\d{2,3})(\d{6})\b/i.exec(g);
  const m = pegada ?? /\b(?:rd|r|ruta)\s*(\d{2,3})\b(.*)$/i.exec(g);
  if (!m) return null;
  const ruta = String(Number(m[1]));
  const resto = m[2] ?? '';
  const f = /^\s*(\d{1,2})\s*[/\s.-]\s*(\d{1,2})/.exec(resto) ?? /^\s*(\d{2})(\d{2})\d{2}\b/.exec(resto);
  if (!f) return { ruta, dia: null };
  const d = Number(f[1]);
  const mes = Number(f[2]);
  if (!(d >= 1 && d <= 31 && mes >= 1 && mes <= 12)) return { ruta, dia: null };
  let anio = Number(diaLibro.slice(0, 4));
  if (`${anio}-${pad(mes)}-${pad(d)}` > diaLibro && dias(diaLibro, `${anio}-${pad(mes)}-${pad(d)}`) > 1) anio -= 1;
  return { ruta, dia: `${anio}-${pad(mes)}-${pad(d)}` };
}

const rutaDelPendiente = (r: string | null) => {
  const m = /^ruta_(\d+)$/i.exec(String(r ?? '').trim());
  return m ? String(Number(m[1])) : null;
};
const partes = (ref: string | null) => String(ref ?? '').split('|');
const familia = (suc: string) => suc.split('-')[0];

/** A cada pendiente, la captura del libro que ya lo trae (o nada). Las llaves son `origen_ref`. */
export function yaEnElLibro(pendientes: readonly PendienteParaLibro[], libro: readonly CapturaDelLibro[]): Map<string, YaEnLibro> {
  const out = new Map<string, YaEnLibro>();
  const usadas = new Set<string>();
  const ingresos = pendientes.filter((p) => p.tipo === 'ingreso');
  const captu = libro.filter((l) => l.tipo === 'ingreso');
  const depositos = captu.filter((l) => l.origen_tipo === 'caos' && !l.declared_doc_ref);
  const cobros = captu.filter((l) => l.origen_tipo === 'cobro' && !!l.origen_ref);
  const despues = (p: PendienteParaLibro, l: CapturaDelLibro, max: number) => {
    const x = dias(p.fecha, l.fecha);
    return x >= 0 && x <= max;
  };
  const marca = (p: PendienteParaLibro, l: CapturaDelLibro, como: ComoYaEnLibro) => {
    usadas.add(l.folio);
    out.set(p.origen_ref, {
      como, certeza: como === 'deposito_ruta' ? 'alta' : 'por_confirmar',
      id: l.id ?? null, folio: l.folio, fecha: l.fecha, monto: l.monto, glosa: l.glosa,
    });
  };

  // 1 · La ruta y el día que escribió la persona: es identidad, no parecido.
  for (const p of ingresos) {
    const ruta = rutaDelPendiente(p.ruta);
    if (!ruta) continue;
    const c = depositos.filter((l) => {
      if (usadas.has(l.folio)) return false;
      const g = rutaDeLaGlosa(l.glosa, l.fecha);
      if (!g || g.ruta !== ruta || Math.abs(l.monto - p.monto) > TOLERANCIA_DEPOSITO_RUTA) return false;
      return g.dia ? g.dia === p.fecha : despues(p, l, DIAS_LIBRO_DESPUES);
    });
    if (c.length === 1) marca(p, c[0], 'deposito_ruta');
  }

  // 2 · El mismo documento e importe, capturado con la llave de otra camioneta de la misma sucursal.
  for (const p of ingresos) {
    if (out.has(p.origen_ref)) continue;
    const c = cobros.filter((l) => {
      if (usadas.has(l.folio) || l.origen_ref === p.origen_ref) return false;
      const [suc, doc, folio] = partes(l.origen_ref);
      return suc !== p.sucursal && familia(suc) === familia(p.sucursal) && doc === p.doc_tipo && folio === p.folio
        && Math.abs(l.monto - p.monto) <= TOLERANCIA_IMPORTE_LIBRO && despues(p, l, DIAS_OTRA_CAMIONETA);
    });
    if (c.length === 1) marca(p, c[0], 'otra_camioneta');
  }

  // 3 · La misma camioneta, el mismo día y el mismo importe, con otro folio.
  for (const p of ingresos) {
    if (out.has(p.origen_ref)) continue;
    const c = cobros.filter((l) => {
      if (usadas.has(l.folio) || l.origen_ref === p.origen_ref) return false;
      const [suc, doc, folio] = partes(l.origen_ref);
      return suc === p.sucursal && doc === p.doc_tipo && folio !== p.folio
        && l.fecha === p.fecha && Math.abs(l.monto - p.monto) <= 0.005;
    });
    if (c.length === 1) marca(p, c[0], 'otra_llave');
  }

  // 4 · Un depósito sin documento por el mismo importe, uno con uno. Si la glosa dice OTRA ruta u
  //     OTRO día, no: lo que la persona escribió contradice el parecido (aunque sea una errata, como
  //     «rd28 1/10» por el 10/10 — ésa se queda sin marca antes que afirmar sobre una contradicción).
  const cand = new Map<string, CapturaDelLibro[]>();
  const porDeposito = new Map<string, number>();
  for (const p of ingresos) {
    if (out.has(p.origen_ref)) continue;
    const ruta = rutaDelPendiente(p.ruta);
    const c = depositos.filter((l) => {
      if (usadas.has(l.folio) || Math.abs(l.monto - p.monto) > TOLERANCIA_IMPORTE_LIBRO || !despues(p, l, DIAS_LIBRO_DESPUES)) return false;
      const g = rutaDeLaGlosa(l.glosa, l.fecha);
      return !(g && ((ruta && g.ruta !== ruta) || (g.dia && g.dia !== p.fecha)));
    });
    cand.set(p.origen_ref, c);
    for (const l of c) porDeposito.set(l.folio, (porDeposito.get(l.folio) ?? 0) + 1);
  }
  for (const p of ingresos) {
    const c = cand.get(p.origen_ref);
    if (c?.length === 1 && porDeposito.get(c[0].folio) === 1 && !usadas.has(c[0].folio)) marca(p, c[0], 'deposito_importe');
  }
  return out;
}
