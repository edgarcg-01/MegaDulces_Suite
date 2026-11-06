import type {
  ConstanciaSituacionFiscal, LecturaConstancia, RegimenDeConstancia, RegimenFiscalOpcion, TipoPersona,
} from '@megadulces/contracts';
import { agruparRenglones, leerTextoPdf, unirTrozos, type Renglon } from './pdf-texto';
import { normalizarClaveFiscal, validarCurp, validarRfc } from './identidad-fiscal';

/**
 * `[ALC.1.1]` Lector de la **Constancia de Situación Fiscal** (CSF) del SAT.
 *
 * Plan: [`FASE_ALC_ALTA_DE_CLIENTES.md`](../../../../../docs/IMPLEMENTACION/FASES/FASE_ALC_ALTA_DE_CLIENTES.md) §9 C1.
 *
 * Determinista y por rótulo: lee lo que el SAT imprimió y **nada más**. Lo que no encuentra queda
 * en `null` y se dice en `faltantes`; nunca se rellena. ⛔ La constancia **no se exige** para
 * facturar (CFF 83 fr. IX, 2026): esto sólo ahorra teclear; la captura a mano vale lo mismo.
 *
 * Medido el 2026-11-04 sobre dos constancias reales (persona física con dos regímenes; persona
 * moral con número interior): rótulo en negritas partido palabra por palabra, valor en la misma
 * altura, tabla de regímenes con fecha de inicio y de fin. Las pruebas usan constancias sintéticas
 * con ese mismo acomodo (las reales traen datos personales y el repo es público).
 *
 * Los tipos viven en `@megadulces/contracts` (`http/alta-clientes.contract.ts`): los comparten la
 * API y la pantalla.
 */

// ── Rótulos ─────────────────────────────────────────────────────────────────────────────────
type Campo =
  | 'rfc' | 'curp' | 'nombre' | 'primer_apellido' | 'segundo_apellido' | 'razon_social' | 'regimen_capital'
  | 'nombre_comercial' | 'inicio_operaciones' | 'estatus_padron' | 'ultimo_cambio_estado' | 'codigo_postal'
  | 'tipo_vialidad' | 'vialidad' | 'numero_exterior' | 'numero_interior' | 'colonia' | 'localidad' | 'municipio'
  | 'entidad' | 'entre_calle' | 'y_calle';

const ROTULOS: Array<[Campo, string]> = [
  ['rfc', 'RFC:'],
  ['curp', 'CURP:'],
  ['nombre', 'Nombre (s):'],
  ['primer_apellido', 'Primer Apellido:'],
  ['segundo_apellido', 'Segundo Apellido:'],
  ['razon_social', 'Denominación/Razón Social:'],
  ['regimen_capital', 'Régimen Capital:'],
  ['nombre_comercial', 'Nombre Comercial:'],
  ['inicio_operaciones', 'Fecha inicio de operaciones:'],
  ['estatus_padron', 'Estatus en el padrón:'],
  ['ultimo_cambio_estado', 'Fecha de último cambio de estado:'],
  ['codigo_postal', 'Código Postal:'],
  ['tipo_vialidad', 'Tipo de Vialidad:'],
  ['vialidad', 'Nombre de Vialidad:'],
  ['numero_exterior', 'Número Exterior:'],
  ['numero_interior', 'Número Interior:'],
  ['colonia', 'Nombre de la Colonia:'],
  ['localidad', 'Nombre de la Localidad:'],
  ['municipio', 'Nombre del Municipio o Demarcación Territorial:'],
  ['entidad', 'Nombre de la Entidad Federativa:'],
  ['entre_calle', 'Entre Calle:'],
  ['y_calle', 'Y Calle:'],
];

const ACENTOS: Record<string, string> = { a: '[aá]', e: '[eé]', i: '[ií]', o: '[oó]', u: '[uúü]', n: '[nñ]' };
/** Rótulo → regex que tolera acentos, mayúsculas y espacios de más o de menos. */
function regexDeRotulo(rotulo: string): RegExp {
  const cuerpo = rotulo
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .split('')
    .map((ch) => {
      const l = ch.toLowerCase();
      if (ACENTOS[l]) return ACENTOS[l];
      if (/\s/.test(ch)) return '\\s*';
      return ch.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    })
    .join('');
  // «Y Calle:» no debe encontrarse dentro de otra palabra.
  return new RegExp(`(?<![A-Za-zÁÉÍÓÚÑáéíóúñ])${cuerpo}`, 'giu');
}
const REGEX_ROTULOS = ROTULOS.map(([campo, r]) => ({ campo, re: regexDeRotulo(r) }));

const MESES: Record<string, number> = {
  ENERO: 1, FEBRERO: 2, MARZO: 3, ABRIL: 4, MAYO: 5, JUNIO: 6, JULIO: 7, AGOSTO: 8,
  SEPTIEMBRE: 9, SETIEMBRE: 9, OCTUBRE: 10, NOVIEMBRE: 11, DICIEMBRE: 12,
};
const iso = (y: number, m: number, d: number): string | null => {
  const f = new Date(Date.UTC(y, m - 1, d));
  return f.getUTCFullYear() === y && f.getUTCMonth() === m - 1 && f.getUTCDate() === d
    ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null;
};
/** «05 DE AGOSTO DE 2002» → `2002-08-05`. */
export function fechaEnLetra(s: string | null | undefined): string | null {
  const m = /(\d{1,2})\s+DE\s+([A-ZÁÉÍÓÚ]+)\s+DE\s+(\d{4})/i.exec(String(s ?? '').toUpperCase());
  if (!m) return null;
  const mes = MESES[m[2].normalize('NFD').replace(/[̀-ͯ]/g, '')];
  return mes ? iso(Number(m[3]), mes, Number(m[1])) : null;
}
/** «17/09/2020» → `2020-09-17`. */
export function fechaConDiagonales(s: string | null | undefined): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(s ?? '').trim());
  return m ? iso(Number(m[3]), Number(m[2]), Number(m[1])) : null;
}

const limpio = (s: string | undefined | null): string | null => {
  const v = String(s ?? '').replace(/\s+/g, ' ').trim();
  return v ? v : null;
};

// ── Renglones con la posición de cada carácter ─────────────────────────────────────────────
interface RenglonConPosiciones { r: Renglon; texto: string; xs: number[] }

/** El renglón con la x de cada carácter (para saber en qué columna cae una segunda línea). */
function unir(r: Renglon): RenglonConPosiciones {
  return { r, ...unirTrozos(r.trozos) };
}

interface Etiqueta { campo: Campo; inicio: number; fin: number; x: number }
function etiquetasDe(rp: RenglonConPosiciones): Etiqueta[] {
  const out: Etiqueta[] = [];
  for (const { campo, re } of REGEX_ROTULOS) {
    re.lastIndex = 0;
    for (let m = re.exec(rp.texto); m; m = re.exec(rp.texto)) out.push({ campo, inicio: m.index, fin: m.index + m[0].length, x: rp.xs[m.index] ?? 0 });
  }
  // Un rótulo contenido en otro más largo (no debería pasar) se descarta.
  return out
    .sort((a, b) => a.inicio - b.inicio || b.fin - a.fin)
    .filter((e, i, arr) => !arr.some((o, j) => j !== i && o.inicio <= e.inicio && o.fin >= e.fin && (o.fin - o.inicio) > (e.fin - e.inicio)));
}

const ES_ENCABEZADO = /^(P[aá]gina\s*\[|Datos del domicilio|Datos de Identificaci|Actividades Econ|Reg[ií]menes:|Obligaciones:)/i;

/**
 * Lee la constancia a partir de sus renglones (salida de `agruparRenglones`). Pura: no abre
 * archivos. `leerConstanciaPdf` es la puerta para un PDF.
 */
export function leerConstanciaDeRenglones(renglones: Renglon[]): LecturaConstancia {
  const rps = renglones.map(unir);
  const todo = rps.map((x) => x.texto).join('\n');
  if (!/CONSTANCIA\s+DE\s+SITUACI[OÓ]N\s+FISCAL/i.test(todo)) {
    return { ok: false, motivo: 'no_es_constancia', detalle: 'El PDF no es una Constancia de Situación Fiscal del SAT.' };
  }

  const valores = new Map<Campo, string>();
  const fin = rps.findIndex((x) => /^Actividades\s+Econ[oó]micas/i.test(x.texto.trim()));
  const zona = fin >= 0 ? rps.slice(0, fin) : rps;
  let ultimas: Etiqueta[] = [];
  let ultimoY: number | null = null;
  let ultimaPagina = 0;
  for (const rp of zona) {
    const ets = etiquetasDe(rp);
    if (ets.length) {
      ets.forEach((e, i) => {
        const hasta = i + 1 < ets.length ? ets[i + 1].inicio : rp.texto.length;
        if (!valores.has(e.campo)) valores.set(e.campo, rp.texto.slice(e.fin, hasta));
      });
      ultimas = ets;
      ultimoY = rp.r.y;
      ultimaPagina = rp.r.pagina;
      continue;
    }
    // Sin rótulo: ¿es la segunda línea de un valor largo del renglón de arriba?
    const texto = rp.texto.trim();
    // Una segunda línea queda a ~1.2 × el tamaño de letra; el siguiente renglón de la tabla, a ~2.7 ×.
    const pegado = ultimoY !== null && rp.r.pagina === ultimaPagina && ultimoY - rp.r.y < 2 * (rp.r.trozos[0]?.tamano || 8);
    if (!ultimas.length || !pegado || ES_ENCABEZADO.test(texto)) { if (ES_ENCABEZADO.test(texto)) ultimas = []; continue; }
    const porColumna = new Map<Campo, string[]>();
    for (const t of rp.r.trozos) {
      const e = [...ultimas].filter((u) => u.x <= t.x + 2).pop() ?? ultimas[0];
      porColumna.set(e.campo, [...(porColumna.get(e.campo) ?? []), t.texto.trim()]);
    }
    for (const [campo, partes] of porColumna) valores.set(campo, `${valores.get(campo) ?? ''} ${partes.join(' ')}`);
    ultimoY = rp.r.y;
  }

  const v = (c: Campo) => limpio(valores.get(c));
  const rfc = normalizarClaveFiscal(v('rfc'));
  if (!rfc) return { ok: false, motivo: 'sin_rfc', detalle: 'La constancia no trae el renglón «RFC:».' };

  // Emisión: «MORELIA , MICHOACAN DE OCAMPO A 28 DE ENERO» + «DE 2026», en los renglones después del rótulo.
  let emitida_el: string | null = null, lugar_emision: string | null = null;
  const iEm = rps.findIndex((x) => /Lugar\s+y\s+Fecha\s+de\s+Emisi[oó]n/i.test(x.texto));
  if (iEm >= 0) {
    // Sólo la columna del recuadro de emisión: a la misma altura, a la izquierda, vive el recuadro de
    // la cédula («Nombre, denominación o razón social»), que se intercalaría entre «JUNIO» y «DE 2026».
    const xRecuadro = rps[iEm].r.trozos[0]?.x ?? 0;
    const tramo = rps.slice(iEm + 1, iEm + 8)
      .filter((x) => (x.r.trozos[0]?.x ?? 0) >= xRecuadro - 100)
      .map((x) => x.texto).join(' ');
    const m = /([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ .]*?\s*,\s*[A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ .]*?)\s+A\s+(\d{1,2}\s+DE\s+[A-ZÁÉÍÓÚ]+\s+DE\s+\d{4})/.exec(tramo);
    if (m) { lugar_emision = limpio(m[1].replace(/\s+,/, ',')); emitida_el = fechaEnLetra(m[2]); }
  }
  const idCif = /idCIF:\s*(\d+)/i.exec(todo)?.[1] ?? null;

  // Regímenes: entre «Regímenes:» y «Obligaciones:».
  const regimenes: RegimenDeConstancia[] = [];
  const iReg = rps.findIndex((x) => /^Reg[ií]menes:/i.test(x.texto.trim()));
  const iObl = rps.findIndex((x, i) => i > iReg && /^Obligaciones:/i.test(x.texto.trim()));
  if (iReg >= 0) {
    for (const rp of rps.slice(iReg + 1, iObl > iReg ? iObl : undefined)) {
      const t = rp.texto.replace(/\s+/g, ' ').trim();
      if (!t || /^P[aá]gina\s*\[/i.test(t) || /^R[eé]gimen\s+Fecha\s+Inicio/i.test(t)) continue;
      const m = /^(.*?)\s*(\d{2}\/\d{2}\/\d{4})(?:\s+(\d{2}\/\d{2}\/\d{4}))?$/.exec(t);
      if (m) regimenes.push({ descripcion: m[1].trim(), desde: fechaConDiagonales(m[2]), hasta: fechaConDiagonales(m[3]), vigente: true });
      else if (regimenes.length) regimenes[regimenes.length - 1].descripcion += ` ${t}`;
    }
  }
  for (const r of regimenes) r.vigente = !r.hasta || (emitida_el !== null && r.hasta > emitida_el);

  const curp = normalizarClaveFiscal(v('curp')) || null;
  const tipo: TipoPersona = v('razon_social') || rfc.length === 12 ? 'moral' : 'fisica';
  const nombre_fiscal = tipo === 'moral'
    ? (v('razon_social') ?? '')
    : [v('nombre'), v('primer_apellido'), v('segundo_apellido')].filter(Boolean).join(' ');

  const constancia: ConstanciaSituacionFiscal = {
    tipo, rfc, curp,
    nombre: v('nombre'), primer_apellido: v('primer_apellido'), segundo_apellido: v('segundo_apellido'),
    razon_social: v('razon_social'), regimen_capital: v('regimen_capital'), nombre_comercial: v('nombre_comercial'),
    nombre_fiscal,
    estatus_padron: v('estatus_padron'),
    inicio_operaciones: fechaEnLetra(v('inicio_operaciones')),
    ultimo_cambio_estado: fechaEnLetra(v('ultimo_cambio_estado')),
    domicilio: {
      codigo_postal: v('codigo_postal'), tipo_vialidad: v('tipo_vialidad'), vialidad: v('vialidad'),
      numero_exterior: v('numero_exterior'), numero_interior: v('numero_interior'), colonia: v('colonia'),
      localidad: v('localidad'), municipio: v('municipio'), entidad: v('entidad'),
      entre_calle: v('entre_calle'), y_calle: v('y_calle'),
    },
    regimenes, emitida_el, lugar_emision, id_cif: idCif,
  };

  // Lo que falta y lo que no cuadra se DICE; no se corrige en silencio.
  const faltantes: string[] = [];
  if (!nombre_fiscal) faltantes.push(tipo === 'moral' ? 'razón social' : 'nombre');
  if (!constancia.domicilio.codigo_postal) faltantes.push('código postal');
  if (!regimenes.some((r) => r.vigente)) faltantes.push('régimen vigente');
  if (!emitida_el) faltantes.push('fecha de emisión');

  const avisos: string[] = [];
  const vr = validarRfc(rfc);
  if (!vr.ok) avisos.push(`El RFC impreso no pasa la validación: ${vr.mensaje}`);
  if (tipo === 'fisica' && curp) { const vc = validarCurp(curp); if (!vc.ok) avisos.push(`La CURP impresa no pasa la validación: ${vc.mensaje}`); }
  if (constancia.estatus_padron && !/^ACTIVO$/i.test(constancia.estatus_padron)) {
    avisos.push(`Estatus en el padrón: ${constancia.estatus_padron} (no ACTIVO).`);
  }
  if (constancia.domicilio.codigo_postal && !/^\d{5}$/.test(constancia.domicilio.codigo_postal)) {
    avisos.push(`El código postal «${constancia.domicilio.codigo_postal}» no tiene 5 dígitos.`);
  }
  if (regimenes.filter((r) => r.vigente).length > 1) {
    avisos.push('Tiene más de un régimen vigente: hay que elegir con cuál se le factura.');
  }
  return { ok: true, constancia, faltantes, avisos };
}

/** Puerta para un PDF: extrae el texto y lee la constancia. Nunca lanza. */
export async function leerConstanciaPdf(bytes: Uint8Array): Promise<LecturaConstancia> {
  const texto = await leerTextoPdf(bytes);
  if (!texto.ok) return { ok: false, motivo: texto.motivo, detalle: texto.detalle };
  return leerConstanciaDeRenglones(agruparRenglones(texto.trozos, 1));
}

// ── Régimen: descripción de la constancia → clave del catálogo del SAT ─────────────────────
export type RegimenDeCatalogo = RegimenFiscalOpcion;

const normalRegimen = (s: string): string =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/^regimen( de( las| los)?)? /, '');

/**
 * La constancia escribe «Régimen de las Personas Físicas con Actividades Empresariales y
 * Profesionales»; el catálogo `c_RegimenFiscal`, «Personas Físicas con Actividades Empresariales y
 * Profesionales» (612). El catálogo llega como parámetro —en producción, el del ODS
 * (`kepler_ods.kdfe33satrf`)— para no inventar uno aquí. Sin coincidencia única → `null`.
 */
export function claveDeRegimen(descripcion: string, catalogo: RegimenDeCatalogo[]): RegimenDeCatalogo | null {
  const d = normalRegimen(descripcion);
  if (!d) return null;
  const exactos = catalogo.filter((c) => normalRegimen(c.descripcion) === d);
  if (exactos.length === 1) return exactos[0];
  const contenidos = catalogo.filter((c) => { const n = normalRegimen(c.descripcion); return n.length > 8 && (d.includes(n) || n.includes(d)); });
  return contenidos.length === 1 ? contenidos[0] : null;
}
