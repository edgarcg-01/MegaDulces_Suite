/**
 * Fase RH · frente NE · `[NE.0.6]` — EL CENTRO SE PARTE EN DOS: SITIO FÍSICO Y ÁREA.
 *
 * Cierra el patrón *A3 «una columna con dos conceptos»*: el sistema actual guarda un solo texto
 * (`Sucursal`) que en realidad es **sitio × área** pegados — «Morelia Abastos TLMK» es el sitio
 * *Morelia Abastos* y el área *telemarketing*.
 *
 * ⛔ **No se copia la columna y no se inventa un catálogo**: la Suite ya tiene los dos ejes
 * (`hr.attendance_sites`, 12 sitios · `identity.departments`, 22 áreas). Esto sólo los liga.
 *
 * ── Lo medido el 2026-11-23 (sólo lectura; universo: la última semana cerrada, 254 personas) ──
 *  · **34 centros** de nómina. 204 de las 254 personas (80.3 %) ligan con un usuario de la Suite.
 *  · ⭐ **El SITIO se DERIVA**: mirando dónde checa de verdad cada persona, 30 de los 34 centros
 *    resuelven su sitio, **casi todos con 100 % de consenso**, cubriendo **248 de 254** personas.
 *  · ⛔ **El ÁREA NO se puede derivar.** El campo `department_code` de la Suite y el sufijo del
 *    nombre del centro coinciden en **21 de 28** casos comparables (75 %, contra **4.8 %** que daría
 *    el azar entre las 21 áreas en uso): miden lo mismo, **pero se contradicen en 1 de cada 4**.
 *    La peor es sustantiva: «Morelia Vecinal» tiene 3 personas que la Suite marca `ruta_directa`.
 *
 * → Por eso cada resolución **declara de dónde viene** (`derivado` · `propuesto` · `pendiente`).
 * Un área propuesta **no es un área confirmada**, y este módulo no deja confundirlas: la decisión
 * es de RH y hasta que exista se declara, no se dibuja.
 */

/** Código de `hr.attendance_sites`. */
export type CodigoDeSitio = string;
/** Código de `identity.departments`. */
export type CodigoDeArea = string;

/**
 * ⭐ De dónde sale cada mitad. Es lo que impide que una propuesta se vuelva verdad en silencio.
 *  · `derivado`  — medido contra un hecho independiente (dónde checa la gente).
 *  · `propuesto` — leído del nombre del centro; **espera a que RH lo confirme**.
 *  · `pendiente` — no se pudo establecer. No se adivina (ADR-056).
 */
export type Procedencia = 'derivado' | 'propuesto' | 'pendiente';

export interface MitadResuelta<T> {
  readonly valor: T | null;
  readonly procedencia: Procedencia;
  /** Obligatorio cuando NO es `derivado`: por qué, o qué falta para confirmarlo. */
  readonly nota?: string;
}

export interface CentroResuelto {
  /** El texto tal cual lo guarda el sistema actual. */
  readonly centro: string;
  readonly sitio: MitadResuelta<CodigoDeSitio>;
  readonly area: MitadResuelta<CodigoDeArea>;
  /** ⭐ Sólo cuando las DOS mitades están establecidas. Una propuesta sin confirmar no resuelve. */
  readonly completo: boolean;
}

export class CentroInvalido extends Error {}

/** Sufijos que el nombre del centro usa para decir el área. Medido sobre los 34 centros. */
const SUFIJOS: readonly (readonly [RegExp, CodigoDeArea])[] = [
  [/\btlmk\b/i, 'telemarketing'],
  [/\brd\b/i, 'ruta_directa'],
  [/vecinal(es)?\b/i, 'ruta_vecinal'],
  [/\bstaff\b/i, 'administracion'],
];

/**
 * El área que **declara el nombre** del centro, o `null` si el nombre no la dice.
 * ⚠️ Es una lectura de texto, no una medición: su resultado nace `propuesto`.
 */
export function areaSegunElNombre(centro: string): CodigoDeArea | null {
  if (typeof centro !== 'string') throw new CentroInvalido(`centro: se esperaba texto, llegó ${JSON.stringify(centro)}`);
  for (const [re, code] of SUFIJOS) if (re.test(centro)) return code;
  return null;
}

/** Dos escrituras del mismo centro no son dos centros. Medido: `Marcadotecnia` ≠ `Mercadotecnia`. */
export function claveDeCentro(centro: string): string {
  if (typeof centro !== 'string') throw new CentroInvalido(`centro: se esperaba texto, llegó ${JSON.stringify(centro)}`);
  return centro.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
}

/** El sitio que se DERIVÓ midiendo dónde checa la gente de ese centro. */
export interface SitioDerivado {
  readonly sitio: CodigoDeSitio;
  /** Qué proporción de la gente ligada de ese centro checa ahí (0–1). */
  readonly consenso: number;
  /** Sobre cuántas personas se midió. Un consenso de 100 % sobre 1 persona no es un consenso. */
  readonly base: number;
}

/** Debajo de esto, un consenso no alcanza para llamarlo derivado: queda pendiente con su nota. */
export const CONSENSO_MINIMO = 0.7;
export const BASE_MINIMA = 2;

/**
 * Parte un centro del sistema actual en sus dos mitades, **sin inventar ninguna**.
 *
 * @param derivados lo medido: centro (por `claveDeCentro`) → sitio derivado.
 * @param areasConfirmadas lo que RH ya confirmó: centro → área. Lo que no esté acá queda
 *        `propuesto` si el nombre la sugiere, y `pendiente` si ni eso.
 */
export function resuelveCentro(
  centro: string,
  derivados: ReadonlyMap<string, SitioDerivado>,
  areasConfirmadas: ReadonlyMap<string, CodigoDeArea> = new Map(),
): CentroResuelto {
  if (typeof centro !== 'string' || !centro.trim()) {
    throw new CentroInvalido(`centro: se esperaba un texto no vacío, llegó ${JSON.stringify(centro)}`);
  }
  const k = claveDeCentro(centro);

  const d = derivados.get(k);
  let sitio: MitadResuelta<CodigoDeSitio>;
  if (!d) {
    sitio = { valor: null, procedencia: 'pendiente', nota: 'nadie de este centro checa en un sitio conocido' };
  } else if (d.base < BASE_MINIMA) {
    sitio = { valor: null, procedencia: 'pendiente', nota: `derivado de ${d.base} persona(s): no alcanza para un consenso` };
  } else if (d.consenso < CONSENSO_MINIMO) {
    sitio = { valor: null, procedencia: 'pendiente', nota: `la gente de este centro checa en sitios distintos (consenso ${(d.consenso * 100).toFixed(0)} %)` };
  } else {
    sitio = { valor: d.sitio, procedencia: 'derivado' };
  }

  const confirmada = areasConfirmadas.get(k);
  let area: MitadResuelta<CodigoDeArea>;
  if (confirmada) {
    area = { valor: confirmada, procedencia: 'derivado' };
  } else {
    const delNombre = areaSegunElNombre(centro);
    area = delNombre
      ? { valor: delNombre, procedencia: 'propuesto', nota: 'leída del nombre del centro; falta que RH la confirme' }
      : { valor: null, procedencia: 'pendiente', nota: 'el nombre del centro no dice el área y RH no la ha confirmado' };
  }

  return {
    centro,
    sitio,
    area,
    completo: sitio.procedencia === 'derivado' && area.procedencia === 'derivado',
  };
}

export interface CoberturaDelCatalogo {
  readonly personas: number;
  readonly conSitio: number;
  readonly conArea: number;
  readonly completas: number;
  /** ⛔ Los centros que NO resuelven, con su motivo. Es la lista de trabajo, no un error. */
  readonly pendientes: readonly { readonly centro: string; readonly personas: number; readonly motivo: string }[];
}

/**
 * ⭐ El gate de `[NE.0.6]`: **ninguna persona del universo sin sitio y sin área**. Esta función
 * lo MIDE; no lo aprueba. Mientras `completas < personas`, la etapa no cierra.
 */
export function cubreElUniverso(
  universo: readonly { readonly centro: string; readonly personas: number }[],
  derivados: ReadonlyMap<string, SitioDerivado>,
  areasConfirmadas: ReadonlyMap<string, CodigoDeArea> = new Map(),
): CoberturaDelCatalogo {
  let personas = 0, conSitio = 0, conArea = 0, completas = 0;
  const pendientes: { centro: string; personas: number; motivo: string }[] = [];
  for (const u of universo) {
    const r = resuelveCentro(u.centro, derivados, areasConfirmadas);
    personas += u.personas;
    if (r.sitio.procedencia === 'derivado') conSitio += u.personas;
    if (r.area.procedencia === 'derivado') conArea += u.personas;
    if (r.completo) completas += u.personas;
    else {
      const faltan: string[] = [];
      if (r.sitio.procedencia !== 'derivado') faltan.push(`sitio: ${r.sitio.nota ?? 'sin establecer'}`);
      if (r.area.procedencia !== 'derivado') faltan.push(`área: ${r.area.nota ?? 'sin establecer'}`);
      pendientes.push({ centro: u.centro, personas: u.personas, motivo: faltan.join(' · ') });
    }
  }
  return { personas, conSitio, conArea, completas, pendientes };
}
