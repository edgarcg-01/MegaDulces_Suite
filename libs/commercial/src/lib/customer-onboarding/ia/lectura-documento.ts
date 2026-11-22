import type {
  ConstanciaSituacionFiscal,
  HallazgoAlta,
  OpcionCatalogo,
  RegimenFiscalOpcion,
  UsoCfdiOpcion,
} from '@megadulces/contracts';
import { claveDeRegimen, normalizarClaveFiscal, validarCurp, validarRfc } from '@megadulces/platform-core';
import { CAMPOS_LEIDOS, TIPOS_DOCUMENTO_ALTA, type CampoLeido, type TipoDocumentoAlta } from './lectura-documento.schema';

/**
 * `[ALC.4.2]` Lo que copió el modelo → una propuesta de alta, revisada por código (C1, pura).
 *
 * ⛔ El modelo sólo COPIA. Aquí se decide:
 *  - el RFC y la CURP pasan por su dígito verificador (`validarRfc`/`validarCurp`): uno que no cuadra se
 *    propone igual —la persona lo corrige mirando la foto— pero con su aviso, y al guardar bloquea;
 *  - régimen, uso de CFDI y forma de pago se buscan en el catálogo del SAT que trae Kepler; lo que no
 *    se encuentra queda vacío con su aviso, nunca «el más parecido»;
 *  - «pago con tarjeta» sin decir crédito o débito NO se adivina: queda vacío y se pregunta.
 * El vacío es ausente (regla 11), y un relleno («N/A», «DESCONOCIDO») también.
 */

export interface RegimenLeido {
  descripcion: string;
  /** `null` = el documento no dice si sigue vigente. */
  vigente: boolean | null;
}

export interface LecturaDocumentoIA {
  tipo_documento: TipoDocumentoAlta;
  legible: 'si' | 'parcial' | 'no';
  tipo_persona: 'fisica' | 'moral' | null;
  /** Sólo los campos que trajeron algo. */
  campos: Partial<Record<CampoLeido, string>>;
  regimenes: RegimenLeido[];
  dudosos: CampoLeido[];
  avisos: string[];
}

const RELLENOS = new Set([
  'N/A', 'NA', 'N A', 'NULL', 'NONE', '-', '--', '?', 'DESCONOCIDO', 'SIN DATO', 'NO APLICA', 'NO VISIBLE', 'ILEGIBLE', 'NO SE VE',
]);
const limpio = (v: unknown): string => {
  const t = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
  return RELLENOS.has(t.toUpperCase()) ? '' : t;
};

/**
 * La respuesta del modelo → la lectura, comprobando su forma. Lo que no tenga la forma del esquema
 * invalida la lectura (`null`): no se adivina qué quiso decir.
 */
export function lecturaDocumentoDesdeModelo(x: unknown): LecturaDocumentoIA | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  const legible = o['legible'];
  if (legible !== 'si' && legible !== 'parcial' && legible !== 'no') return null;
  const tipo = (TIPOS_DOCUMENTO_ALTA as readonly string[]).includes(String(o['tipo_documento']))
    ? (o['tipo_documento'] as TipoDocumentoAlta) : 'otro';
  const campos: Partial<Record<CampoLeido, string>> = {};
  for (const c of CAMPOS_LEIDOS) {
    if (typeof o[c] !== 'string' && o[c] !== undefined) return null;
    const v = limpio(o[c]);
    if (v) campos[c] = v;
  }
  const regimenes: RegimenLeido[] = [];
  if (!Array.isArray(o['regimenes'])) return null;
  for (const r of o['regimenes'] as unknown[]) {
    const rr = (r ?? {}) as Record<string, unknown>;
    const d = limpio(rr['descripcion']);
    if (d) regimenes.push({ descripcion: d, vigente: rr['vigente'] === 'si' ? true : rr['vigente'] === 'no' ? false : null });
  }
  const dudosos = (Array.isArray(o['dudosos']) ? o['dudosos'] : [])
    .filter((d): d is CampoLeido => (CAMPOS_LEIDOS as readonly string[]).includes(String(d)));
  const avisos = (Array.isArray(o['avisos']) ? o['avisos'] : []).map(limpio).filter(Boolean).slice(0, 8);
  const tp = o['tipo_persona'];
  return {
    tipo_documento: tipo, legible, tipo_persona: tp === 'fisica' || tp === 'moral' ? tp : null,
    campos, regimenes, dudosos: [...new Set(dudosos)], avisos,
  };
}

// ── Catálogos del SAT ────────────────────────────────────────────────────────────────────────

/** Para comparar textos: sin acentos, mayúsculas, sin puntuación. */
export const plano = (s: unknown): string => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toUpperCase().replace(/[^A-Z0-9Ñ ]/g, ' ').replace(/\s+/g, ' ').trim();

interface Opcion { clave: string; descripcion: string }

/**
 * Texto del documento → clave del catálogo: primero por la clave escrita («G03 Gastos en general»),
 * luego por la descripción exacta, y al final por una descripción contenida que sea la ÚNICA. Dos
 * candidatas = ninguna (no se elige «la más parecida»).
 */
export function claveDeCatalogo(texto: unknown, opciones: Opcion[], patronClave: RegExp): string | null {
  const t = plano(texto);
  if (!t) return null;
  const porClave = t.match(patronClave)?.[0];
  if (porClave && opciones.some((o) => o.clave === porClave)) return porClave;
  const exacta = opciones.find((o) => plano(o.descripcion) === t);
  if (exacta) return exacta.clave;
  const contenidas = opciones.filter((o) => {
    const d = plano(o.descripcion);
    return d.length >= 5 && (t.includes(d) || (t.length >= 5 && d.includes(t)));
  });
  return contenidas.length === 1 ? contenidas[0].clave : null;
}

const PATRON_USO = /\b(G0[1-3]|I0[1-8]|D(0[1-9]|10)|S01|CP01|CN01)\b/;
const PATRON_FORMA = /\b\d{2}\b/;

export function usoCfdiDeTexto(texto: unknown, usos: UsoCfdiOpcion[]): string | null {
  return claveDeCatalogo(texto, usos, PATRON_USO);
}

/** `ambigua` = dice «tarjeta» sin decir crédito o débito: el SAT las distingue (04 / 28) y no se adivina. */
export function formaPagoDeTexto(texto: unknown, formas: OpcionCatalogo[]): { clave: string | null; ambigua: boolean } {
  const t = plano(texto);
  if (!t) return { clave: null, ambigua: false };
  const porClave = t.match(PATRON_FORMA)?.[0];
  if (porClave && formas.some((f) => f.clave === porClave)) return { clave: porClave, ambigua: false };
  if (/\bTARJETA\b/.test(t) && !/\b(CREDITO|DEBITO|SERVICIOS?)\b/.test(t)) return { clave: null, ambigua: true };
  return { clave: claveDeCatalogo(t, formas.map((f) => ({ clave: f.clave, descripcion: f.nombre })), PATRON_FORMA), ambigua: false };
}

/** «612 - Personas Físicas…» → 612; si no trae clave, por su descripción (`claveDeRegimen`). */
export function regimenDeTexto(texto: unknown, regimenes: RegimenFiscalOpcion[]): RegimenFiscalOpcion | null {
  const t = String(texto ?? '').trim();
  const codigo = /^\s*(\d{3})\b/.exec(t)?.[1];
  if (codigo) {
    const r = regimenes.find((x) => x.clave === codigo);
    if (r) return r;
  }
  return t ? claveDeRegimen(t.replace(/^\s*\d{3}\s*[-–.:]?\s*/, ''), regimenes) : null;
}

// ── La propuesta ─────────────────────────────────────────────────────────────────────────────

export interface CatalogosDeLectura {
  regimenes: RegimenFiscalOpcion[];
  usos: UsoCfdiOpcion[];
  formas: OpcionCatalogo[];
}

export interface PropuestaDesdeDocumento {
  constancia: ConstanciaSituacionFiscal;
  /** Claves de los regímenes vigentes que se encontraron en el catálogo. */
  regimenes_vigentes: string[];
  uso_cfdi: string | null;
  forma_pago: string | null;
  email: string | null;
  telefono: string | null;
  /** Lo que no tiene casilla y sirve a quien revisa (clave en el sistema anterior, método de pago). */
  comentario: string | null;
  hallazgos: HallazgoAlta[];
  faltantes: string[];
}

/** El campo que copió el modelo → la casilla de la pantalla donde se pinta su aviso. */
const CASILLA_DE: Partial<Record<CampoLeido, string>> = {
  rfc: 'rfc', curp: 'curp', nombres: 'nombre_fiscal', primer_apellido: 'nombre_fiscal', segundo_apellido: 'nombre_fiscal',
  razon_social: 'nombre_fiscal', codigo_postal: 'codigo_postal_fiscal', tipo_vialidad: 'ficha.direccion_1',
  vialidad: 'ficha.direccion_1', numero_exterior: 'ficha.direccion_1', numero_interior: 'ficha.direccion_1',
  colonia: 'ficha.direccion_2', localidad: 'ficha.direccion_2', municipio: 'ficha.direccion_2', entidad: 'ficha.estado',
  email: 'ficha.email', telefono: 'ficha.telefono_1', uso_cfdi: 'uso_cfdi', forma_pago: 'forma_pago',
};
const ROTULO_DE: Partial<Record<CampoLeido, string>> = {
  rfc: 'el RFC', curp: 'la CURP', nombres: 'el nombre', primer_apellido: 'el primer apellido', segundo_apellido: 'el segundo apellido',
  razon_social: 'la razón social', codigo_postal: 'el código postal', vialidad: 'la calle', numero_exterior: 'el número exterior',
  colonia: 'la colonia', municipio: 'el municipio', entidad: 'el estado', email: 'el correo', telefono: 'el teléfono',
  uso_cfdi: 'el uso de CFDI', forma_pago: 'la forma de pago',
};
const QUE_ES: Record<TipoDocumentoAlta, string> = {
  constancia_sat: 'una constancia del SAT', factura_cfdi: 'una factura', captura_de_sistema: 'la captura de otro sistema',
  etiqueta_o_nota: 'una etiqueta o nota', identificacion: 'una identificación', otro: 'un documento',
};
/** «una constancia del SAT», «la captura de otro sistema»… para decirle a la persona qué se leyó. */
export const queEs = (t: TipoDocumentoAlta): string => QUE_ES[t] ?? QUE_ES.otro;

const CORREO = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const fechaIso = (v: string | undefined): string | null => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

export function propuestaDesdeLectura(l: LecturaDocumentoIA, cat: CatalogosDeLectura): PropuestaDesdeDocumento {
  const c = l.campos;
  const h: HallazgoAlta[] = [];
  const aviso = (campo: string, mensaje: string) => h.push({ campo, gravedad: 'aviso', mensaje });

  // RFC y CURP: se proponen como se leyeron; el dígito verificador dice si se les puede creer.
  const rfc = normalizarClaveFiscal(c.rfc ?? '');
  const r = validarRfc(rfc);
  if (!rfc) aviso('rfc', 'Ningún archivo trae el RFC: si el cliente no tiene, elige «Sin RFC».');
  else if (!r.ok) aviso('rfc', `La IA leyó «${rfc}», pero ${r.mensaje.charAt(0).toLowerCase()}${r.mensaje.slice(1)} Compáralo con el documento.`);
  const tipo = r.ok ? r.tipo : l.tipo_persona ?? 'fisica';
  const curp = tipo === 'fisica' ? normalizarClaveFiscal(c.curp ?? '') : '';
  if (curp) {
    const k = validarCurp(curp);
    if (!k.ok) aviso('curp', `La IA leyó la CURP «${curp}», pero ${k.mensaje.charAt(0).toLowerCase()}${k.mensaje.slice(1)}`);
  }

  const mayus = (v: string | undefined) => (v ?? '').toUpperCase();
  const nombreFisica = [c.nombres, c.primer_apellido, c.segundo_apellido].map(mayus).filter(Boolean).join(' ');
  const nombre_fiscal = (tipo === 'moral' ? mayus(c.razon_social) || nombreFisica : nombreFisica || mayus(c.razon_social))
    .replace(/\s+/g, ' ').trim();

  const regimenes = l.regimenes.map((x) => ({ descripcion: x.descripcion, desde: null, hasta: null, vigente: x.vigente !== false }));
  const vigentes = [...new Set(regimenes.filter((x) => x.vigente)
    .map((x) => regimenDeTexto(x.descripcion, cat.regimenes)?.clave).filter((x): x is string => !!x))];
  const sinCatalogo = regimenes.filter((x) => x.vigente && !regimenDeTexto(x.descripcion, cat.regimenes));
  for (const x of sinCatalogo) aviso('regimen_fiscal', `El régimen «${x.descripcion}» no se encontró en el catálogo del SAT: elígelo a mano.`);

  const uso = usoCfdiDeTexto(c.uso_cfdi, cat.usos);
  if (c.uso_cfdi && !uso) aviso('uso_cfdi', `El documento dice «${c.uso_cfdi}» de uso de CFDI y no está en el catálogo del SAT: elígelo.`);
  const forma = formaPagoDeTexto(c.forma_pago, cat.formas);
  if (forma.ambigua) aviso('forma_pago', `El documento dice «${c.forma_pago}»: pregúntale si es tarjeta de crédito (04) o de débito (28).`);
  else if (c.forma_pago && !forma.clave) aviso('forma_pago', `La forma de pago «${c.forma_pago}» no está en el catálogo del SAT: elígela.`);

  const email = c.email ? c.email.toLowerCase().replace(/\s+/g, '') : null;
  if (email && !CORREO.test(email)) aviso('ficha.email', `La IA leyó el correo «${email}»: no tiene forma de correo, revísalo.`);
  const telefono = c.telefono ? c.telefono.replace(/\D/g, '') || null : null;

  for (const d of l.dudosos) {
    aviso(CASILLA_DE[d] ?? 'documento', `La IA no leyó con seguridad ${ROTULO_DE[d] ?? `«${d}»`}: compáralo con el documento.`);
  }
  if (l.legible === 'parcial') aviso('documento', 'Parte de lo que se subió no se pudo leer: revisa lo que quedó vacío.');
  for (const a of l.avisos) aviso('documento', a);

  const notas = [
    c.clave_en_otro_sistema ? `Clave en el sistema anterior: ${c.clave_en_otro_sistema}` : '',
    c.metodo_pago ? `Método de pago en el documento: ${c.metodo_pago}` : '',
  ].filter(Boolean);

  const faltantes = [
    !rfc ? 'el RFC' : '', !nombre_fiscal ? 'el nombre' : '', !c.codigo_postal ? 'el código postal' : '',
  ].filter(Boolean);

  const constancia: ConstanciaSituacionFiscal = {
    tipo, rfc, curp: curp || null,
    nombre: c.nombres ? mayus(c.nombres) : null,
    primer_apellido: c.primer_apellido ? mayus(c.primer_apellido) : null,
    segundo_apellido: c.segundo_apellido ? mayus(c.segundo_apellido) : null,
    razon_social: c.razon_social ? mayus(c.razon_social) : null,
    regimen_capital: c.regimen_capital ? mayus(c.regimen_capital) : null,
    nombre_comercial: c.nombre_comercial ? mayus(c.nombre_comercial) : null,
    nombre_fiscal,
    estatus_padron: null, inicio_operaciones: null, ultimo_cambio_estado: null,
    domicilio: {
      codigo_postal: (c.codigo_postal ?? '').replace(/\D/g, '').slice(0, 5) || null,
      tipo_vialidad: c.tipo_vialidad ?? null, vialidad: c.vialidad ?? null,
      numero_exterior: c.numero_exterior ?? null, numero_interior: c.numero_interior ?? null,
      colonia: c.colonia ?? null, localidad: c.localidad ?? null, municipio: c.municipio ?? null,
      entidad: c.entidad ?? null, entre_calle: c.entre_calle ?? null, y_calle: c.y_calle ?? null,
    },
    regimenes,
    emitida_el: fechaIso(c.fecha_emision),
    lugar_emision: null,
    id_cif: null,
  };
  return {
    constancia, regimenes_vigentes: vigentes, uso_cfdi: uso, forma_pago: forma.clave, email, telefono,
    comentario: notas.length ? notas.join(' · ') : null, hallazgos: h, faltantes,
  };
}

// ── La medición: qué corrigió la persona ─────────────────────────────────────────────────────

/** Lo que la máquina puso en la pantalla, guardado en la lectura (`proposal`) para comparar al crear. */
export interface PropuestaGuardada {
  tipo_persona: 'fisica' | 'moral';
  rfc: string;
  curp: string;
  nombre_fiscal: string;
  regimen_fiscal: string;
  codigo_postal_fiscal: string;
  uso_cfdi: string;
  forma_pago: string;
  ficha: Record<string, string>;
  /** RFC de la constancia del SAT leída SIN IA; `null` = no hubo. Con él, el RFC no se cambia al crear. */
  rfc_oficial: string | null;
  emitida_el: string | null;
  que_se_leyo: string | null;
  /** La lectura del PDF oficial tal cual (la que antes guardaba `constancia_reading`). */
  lectura_oficial: unknown;
}

export interface CapturaComparada {
  rfc: string;
  curp?: string | null;
  nombre_fiscal: string;
  regimen_fiscal: string;
  codigo_postal_fiscal: string;
  uso_cfdi?: string | null;
  forma_pago?: string | null;
  ficha: Record<string, string>;
}

export interface Correcciones {
  /** Lo que la máquina propuso y la persona cambió: el error de la lectura. */
  corregidos: string[];
  /** Lo que la máquina dejó vacío y la persona llenó: lo que la lectura no trajo. */
  completados: string[];
}

/** Casilla por casilla, comparando sin acentos ni puntuación (una coma de más no es un error de la IA). */
export function correccionesDe(p: PropuestaGuardada, g: CapturaComparada): Correcciones {
  const pares: Array<[string, unknown, unknown]> = [
    ['rfc', p.rfc, g.rfc], ['curp', p.curp, g.curp], ['nombre_fiscal', p.nombre_fiscal, g.nombre_fiscal],
    ['regimen_fiscal', p.regimen_fiscal, g.regimen_fiscal], ['codigo_postal_fiscal', p.codigo_postal_fiscal, g.codigo_postal_fiscal],
    ['uso_cfdi', p.uso_cfdi, g.uso_cfdi], ['forma_pago', p.forma_pago, g.forma_pago],
    ...Object.keys({ ...p.ficha, ...g.ficha }).map((k): [string, unknown, unknown] => [`ficha.${k}`, p.ficha[k], g.ficha[k]]),
  ];
  const corregidos: string[] = [], completados: string[] = [];
  for (const [campo, propuesto, guardado] of pares) {
    const a = plano(propuesto), b = plano(guardado);
    if (a && a !== b) corregidos.push(campo);
    else if (!a && b) completados.push(campo);
  }
  return { corregidos, completados };
}

/**
 * Una constancia leída sin IA (el PDF del SAT con texto) GANA sobre lo que leyó el modelo: es el
 * documento oficial, leído carácter por carácter. La IA sólo llena lo que la constancia no trae, y
 * si las dos dicen cosas distintas de RFC o nombre, se avisa (¿son del mismo cliente?).
 */
export function fusionarConConstancia(
  oficial: ConstanciaSituacionFiscal, ia: ConstanciaSituacionFiscal,
): { constancia: ConstanciaSituacionFiscal; hallazgos: HallazgoAlta[] } {
  const h: HallazgoAlta[] = [];
  if (ia.rfc && oficial.rfc && ia.rfc !== oficial.rfc) {
    h.push({ campo: 'rfc', gravedad: 'aviso', mensaje: `La constancia dice ${oficial.rfc} y las fotos ${ia.rfc}: ¿son del mismo cliente? Se usa el de la constancia.` });
  }
  if (ia.nombre_fiscal && oficial.nombre_fiscal && plano(ia.nombre_fiscal) !== plano(oficial.nombre_fiscal)) {
    h.push({ campo: 'nombre_fiscal', gravedad: 'aviso', mensaje: `La constancia dice «${oficial.nombre_fiscal}» y las fotos «${ia.nombre_fiscal}»: se usa el de la constancia.` });
  }
  const dom = { ...oficial.domicilio };
  for (const k of Object.keys(dom) as Array<keyof typeof dom>) if (!dom[k] && ia.domicilio[k]) dom[k] = ia.domicilio[k];
  return {
    constancia: {
      ...oficial,
      curp: oficial.curp ?? ia.curp,
      nombre_comercial: oficial.nombre_comercial ?? ia.nombre_comercial,
      domicilio: dom,
      regimenes: oficial.regimenes.length ? oficial.regimenes : ia.regimenes,
    },
    hallazgos: h,
  };
}
