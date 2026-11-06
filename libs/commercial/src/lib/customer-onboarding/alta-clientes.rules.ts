import {
  CASILLAS_KEPLER,
  type EstadoSolicitudAlta,
  type HallazgoAlta,
  type RegimenFiscalOpcion,
  type SolicitudAlta,
  type SolicitudAltaBody,
} from '@megadulces/contracts';
import { rfcYCurpCoinciden, validarCurp, validarRfc } from '@megadulces/platform-core';
import { recortesDe } from './ficha-kepler';

/**
 * `[ALC.1.2]` Las reglas de una solicitud de alta, puras: las corre el servidor al guardar y la
 * misma respuesta pinta la pantalla. `bloquea` impide guardar; `aviso` se muestra y deja seguir.
 *
 * Lo que necesita la base (¿el CP existe en el catálogo del SAT?, ¿vendedor/grupo/zona existen en
 * la sucursal?) llega ya resuelto en `contexto`: aquí no se consulta nada.
 */
export interface ContextoRevision {
  regimenes: RegimenFiscalOpcion[];
  /** `null` = no se pudo consultar el catálogo de CP (se declara, no se da por bueno ni por malo). */
  cp_existe: boolean | null;
  vendedor_existe: boolean | null;
  grupo_existe: boolean | null;
  zona_existe: boolean | null;
}

const REGIMEN_CAPITAL_AL_FINAL = /\b(S\.?\s?A\.?(\s?P\.?\s?I\.?)?\s?(DE\s)?C\.?\s?V\.?|S\.?\s?DE\s?R\.?\s?L\.?(\s?DE\s?C\.?\s?V\.?)?|S\.?\s?C\.?|A\.?\s?C\.?|S\.?\s?A\.?)\s*$/i;
const CORREO = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function pideCredito(b: Pick<SolicitudAltaBody, 'credito_solicitado' | 'plazo_dias' | 'descuento_pct'>): boolean {
  return Number(b.credito_solicitado ?? 0) > 0 || Number(b.plazo_dias ?? 0) > 0 || Number(b.descuento_pct ?? 0) > 0;
}

/** De contado entra directo a «lista para Kepler»; con crédito, plazo o descuento espera su firma. */
export function estadoInicial(b: SolicitudAltaBody): EstadoSolicitudAlta {
  return pideCredito(b) ? 'credito_por_aprobar' : 'lista_para_kepler';
}

export function revisarSolicitud(b: SolicitudAltaBody, ctx: ContextoRevision): HallazgoAlta[] {
  const h: HallazgoAlta[] = [];
  const bloquea = (campo: string, mensaje: string) => h.push({ campo, gravedad: 'bloquea', mensaje });
  const aviso = (campo: string, mensaje: string) => h.push({ campo, gravedad: 'aviso', mensaje });

  if (!String(b.branch ?? '').trim()) bloquea('branch', 'Falta la sucursal donde se da de alta.');

  const r = validarRfc(b.rfc);
  if (!r.ok) bloquea('rfc', r.mensaje);
  else if (r.generico) aviso('rfc', 'Es el RFC genérico: a este cliente no se le puede facturar a su nombre.');
  else if (r.tipo !== b.tipo_persona) {
    bloquea('tipo_persona', `El RFC es de persona ${r.tipo === 'fisica' ? 'física (13)' : 'moral (12)'} y se capturó como ${b.tipo_persona}.`);
  }

  const curp = String(b.curp ?? '').trim();
  if (b.tipo_persona === 'moral' && curp) bloquea('curp', 'Una persona moral no tiene CURP.');
  if (b.tipo_persona === 'fisica' && curp) {
    const c = validarCurp(curp);
    if (!c.ok) bloquea('curp', c.mensaje);
    else if (r.ok && !r.generico && !rfcYCurpCoinciden(b.rfc, curp)) {
      aviso('curp', 'RFC y CURP no empiezan igual (los 10 primeros caracteres): revisa que sean de la misma persona.');
    }
  }

  const nombre = String(b.nombre_fiscal ?? '').trim();
  if (!nombre) bloquea('nombre_fiscal', 'Falta el nombre o la razón social.');
  else if (b.tipo_persona === 'moral' && REGIMEN_CAPITAL_AL_FINAL.test(nombre)) {
    aviso('nombre_fiscal', 'El CFDI 4.0 pide la razón social sin el régimen de capital («SA DE CV» va aparte).');
  }

  const reg = ctx.regimenes.find((x) => x.clave === String(b.regimen_fiscal ?? '').trim());
  if (!b.regimen_fiscal) bloquea('regimen_fiscal', 'Falta el régimen fiscal con el que se le factura.');
  else if (!reg) bloquea('regimen_fiscal', `El régimen «${b.regimen_fiscal}» no está en el catálogo del SAT.`);
  else if (b.tipo_persona === 'fisica' ? !reg.persona_fisica : !reg.persona_moral) {
    bloquea('regimen_fiscal', `El régimen ${reg.clave} (${reg.descripcion}) no es para persona ${b.tipo_persona}.`);
  }

  const cp = String(b.codigo_postal_fiscal ?? '').trim();
  if (!/^\d{5}$/.test(cp)) bloquea('codigo_postal_fiscal', 'El código postal fiscal lleva 5 dígitos.');
  else if (ctx.cp_existe === false) bloquea('codigo_postal_fiscal', `El código postal ${cp} no está en el catálogo del SAT.`);
  else if (ctx.cp_existe === null) aviso('codigo_postal_fiscal', 'No se pudo revisar el código postal contra el catálogo del SAT.');

  const f = b.ficha;
  if (!f) bloquea('ficha', 'Falta la ficha de Kepler.');
  else {
    if (!String(f.nombre ?? '').trim()) bloquea('ficha.nombre', 'La ficha de Kepler necesita el nombre.');
    if (String(f.rfc ?? '').trim().toUpperCase() !== String(b.rfc ?? '').trim().toUpperCase()) {
      bloquea('ficha.rfc', 'El RFC de la ficha de Kepler no es el mismo que el RFC fiscal.');
    }
    if (f.codigo_postal && !/^\d{5}$/.test(String(f.codigo_postal))) bloquea('ficha.codigo_postal', 'El código postal de la ficha lleva 5 dígitos.');
    if (f.email && !CORREO.test(String(f.email).trim())) bloquea('ficha.email', 'El correo no tiene forma de correo.');
    for (const x of recortesDe(f)) {
      aviso(`ficha.${x.casilla}`, `${CASILLAS_KEPLER[x.casilla].rotulo}: Kepler guarda ${x.largo} caracteres; quedaría «${x.cabe}».`);
    }
  }

  const credito = Number(b.credito_solicitado ?? 0), plazo = Number(b.plazo_dias ?? 0), desc = Number(b.descuento_pct ?? 0);
  if (!Number.isFinite(credito) || credito < 0) bloquea('credito_solicitado', 'El límite de crédito no puede ser negativo.');
  if (!Number.isInteger(plazo) || plazo < 0) bloquea('plazo_dias', 'El plazo es un número entero de días.');
  if (!Number.isFinite(desc) || desc < 0 || desc > 100) bloquea('descuento_pct', 'El descuento va de 0 a 100 %.');
  if (credito > 0 && plazo === 0) aviso('plazo_dias', 'Pide crédito sin plazo: Crédito y Cobranza lo va a preguntar.');

  const catalogos: Array<[keyof ContextoRevision, string, string | null | undefined]> = [
    ['vendedor_existe', 'vendedor_code', b.vendedor_code], ['grupo_existe', 'grupo_code', b.grupo_code], ['zona_existe', 'zona_code', b.zona_code],
  ];
  for (const [k, campo, valor] of catalogos) {
    if (valor && ctx[k] === false) bloquea(campo, `«${valor}» no existe en esa sucursal de Kepler.`);
  }
  if (!b.vendedor_code || !b.grupo_code || !b.zona_code) {
    aviso('kepler', 'Vendedor, grupo y zona los pide Kepler: si no se eligen aquí, se eligen al capturarla allá.');
  }
  return h;
}

export const bloquea = (h: HallazgoAlta[]): boolean => h.some((x) => x.gravedad === 'bloquea');

/** Lo que trae la ficha de Kepler al ligar (`kdud`: `c3`, `c10`, `c15`, `c16`, `c17`). */
export interface FichaKeplerLeida {
  nombre: string;
  rfc: string | null;
  limite: string | number | null;
  plazo: string | number | null;
  descuento: string | number | null;
}

const n = (v: unknown): number => { const x = Number(String(v ?? '').replace(/[^0-9.-]/g, '')); return Number.isFinite(x) ? x : 0; };
const pesos = (v: number): string => `$${v.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * `[ALC.2.5]` Al ligar: ¿lo que se capturó en Kepler es lo que se aprobó? Kepler manda en el crédito
 * (es donde se cobra), así que la Suite NO lo corrige: deja la diferencia escrita en la solicitud
 * para que se vea. De contado o con crédito rechazado, lo esperado es 0 / 0 días / 0 %.
 */
export function diferenciaDeCredito(
  s: Pick<SolicitudAlta, 'credito'>,
  k: FichaKeplerLeida,
): string | null {
  const c = s.credito?.decision === 'aprobado' ? s.credito : null;
  const ok = !!c;
  const esperado = { limite: c?.credito_aprobado ?? 0, plazo: c?.plazo_aprobado ?? 0, desc: c?.descuento_aprobado ?? 0 };
  const kepler = { limite: n(k.limite), plazo: n(k.plazo), desc: n(k.descuento) };
  if (Math.abs(kepler.limite - esperado.limite) < 0.005 && kepler.plazo === esperado.plazo && Math.abs(kepler.desc - esperado.desc) < 0.005) return null;
  return `Al ligar: Kepler tiene límite ${pesos(kepler.limite)}, plazo ${kepler.plazo} días y descuento ${kepler.desc} %; `
    + `${ok ? 'lo aprobado' : 'lo esperado (de contado)'} era ${pesos(esperado.limite)}, ${esperado.plazo} días y ${esperado.desc} %.`;
}
