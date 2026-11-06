/**
 * `[ALC.1.2]` Identidad fiscal mexicana: RFC y CURP, con su dígito verificador.
 *
 * Plan: [`FASE_ALC_ALTA_DE_CLIENTES.md`](../../../../../docs/IMPLEMENTACION/FASES/FASE_ALC_ALTA_DE_CLIENTES.md) §9 C1.
 *
 * Funciones puras, sin red ni base. Atrapan el error de captura (una letra cambiada, un mes 13,
 * una homoclave inventada) — **no** dicen que el contribuyente exista ante el SAT: eso es D4 del
 * plan y queda fuera.
 *
 * ── Por qué aquí y no en cada módulo ─────────────────────────────────────────────────────────
 * Ya había cinco expresiones regulares de RFC sueltas (`commercial-vendor-routes`,
 * `logistics-fleet`, `fiscal/listas`, `hr/talent/registro`, `purchase-book`), ninguna con el
 * dígito verificador. ADR-056: el primitivo vive en `libs/`, compartido.
 *
 * ── Los dos algoritmos (públicos, del SAT y de RENAPO) ───────────────────────────────────────
 * - **RFC**: cada carácter vale su posición en `0-9 A-N & O-Z (espacio) Ñ`; al de persona moral
 *   (12) se le antepone un espacio para que mida 13. Suma de valor × (13 − i) sobre los 12
 *   primeros; `11 − suma mod 11` → `11` = `0`, `10` = `A`.
 * - **CURP**: cada carácter vale su posición en `0-9 A-N Ñ O-Z`; suma de valor × (18 − i) sobre
 *   los 17 primeros; `(10 − suma mod 10) mod 10`.
 * Verificados el 2026-11-04 contra dos constancias reales del SAT (una de persona física con su
 * CURP, una de persona moral) que NO se versionan; en las pruebas sólo van RFC públicos. Segundo
 * testigo, el maestro de clientes de Kepler (prod, sólo lectura, mismo día): de los 760 RFC
 * distintos con la forma correcta, **736 (96.8 %) cuadran** con el verificador — si el algoritmo
 * estuviera mal cuadraría ~1 de cada 11 —; los 24 restantes son capturas con un carácter cambiado.
 */
import type { TipoPersona } from '@megadulces/contracts';

/** RFC genéricos del SAT: público en general y extranjero. Estructuralmente válidos. */
export const RFC_GENERICOS: ReadonlySet<string> = new Set(['XAXX010101000', 'XEXX010101000']);

const RFC_FORMA = /^([A-ZÑ&]{3,4})(\d{2})(\d{2})(\d{2})([A-Z\d]{2})([\dA])$/;
const CURP_FORMA = /^([A-Z][AEIOUX][A-Z]{2})(\d{2})(\d{2})(\d{2})([HMX])([A-Z]{2})([B-DF-HJ-NP-TV-Z]{3})([A-Z\d])(\d)$/;

/** Entidades de nacimiento de la CURP (RENAPO). `NE` = nacido en el extranjero. */
const ENTIDADES_CURP = new Set([
  'AS', 'BC', 'BS', 'CC', 'CL', 'CM', 'CS', 'CH', 'DF', 'DG', 'GT', 'GR', 'HG', 'JC', 'MC', 'MN',
  'MS', 'NT', 'NL', 'OC', 'PL', 'QT', 'QR', 'SP', 'SL', 'SR', 'TC', 'TS', 'TL', 'VZ', 'YN', 'ZS', 'NE',
]);

const ALFABETO_RFC = '0123456789ABCDEFGHIJKLMN&OPQRSTUVWXYZ Ñ';
const ALFABETO_CURP = '0123456789ABCDEFGHIJKLMNÑOPQRSTUVWXYZ';

/** Mayúsculas, sin espacios, guiones ni puntos. `null` / `undefined` → `''`. */
export function normalizarClaveFiscal(raw: unknown): string {
  return String(raw ?? '').toUpperCase().replace(/[\s\-.]/g, '');
}

/** ¿`AAMMDD` es una fecha que existe? El siglo no se sabe: se acepta si existe en 19xx o 20xx. */
function fechaExiste(aa: string, mm: string, dd: string): boolean {
  const m = Number(mm), d = Number(dd);
  if (m < 1 || m > 12 || d < 1) return false;
  return [1900, 2000].some((siglo) => {
    const y = siglo + Number(aa);
    return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
  });
}

/** Dígito verificador que le corresponde a los 11 (moral) o 12 (física) primeros caracteres. */
export function digitoVerificadorRfc(sinVerificador: string): string {
  const base = sinVerificador.length === 11 ? ` ${sinVerificador}` : sinVerificador;
  let suma = 0;
  for (let i = 0; i < 12; i++) {
    const v = ALFABETO_RFC.indexOf(base[i]);
    suma += (v < 0 ? 0 : v) * (13 - i);
  }
  const r = 11 - (suma % 11);
  return r === 11 ? '0' : r === 10 ? 'A' : String(r);
}

/** Dígito verificador que le corresponde a los 17 primeros caracteres de una CURP. */
export function digitoVerificadorCurp(sinVerificador: string): string {
  let suma = 0;
  for (let i = 0; i < 17; i++) {
    const v = ALFABETO_CURP.indexOf(sinVerificador[i]);
    suma += (v < 0 ? 0 : v) * (18 - i);
  }
  return String((10 - (suma % 10)) % 10);
}

export type MotivoRfcInvalido = 'vacio' | 'formato' | 'fecha' | 'verificador';

export type ResultadoRfc =
  | { ok: true; rfc: string; tipo: TipoPersona; generico: boolean }
  | { ok: false; rfc: string; motivo: MotivoRfcInvalido; mensaje: string; verificador_esperado?: string };

export function validarRfc(raw: unknown): ResultadoRfc {
  const rfc = normalizarClaveFiscal(raw);
  if (!rfc) return { ok: false, rfc, motivo: 'vacio', mensaje: 'Falta el RFC.' };
  if (RFC_GENERICOS.has(rfc)) return { ok: true, rfc, tipo: 'fisica', generico: true };
  const m = RFC_FORMA.exec(rfc);
  if (!m || (rfc.length !== 12 && rfc.length !== 13)) {
    return {
      ok: false, rfc, motivo: 'formato',
      mensaje: 'El RFC no tiene la forma del SAT: 4 letras + fecha + 3 (persona física, 13) o 3 letras + fecha + 3 (persona moral, 12).',
    };
  }
  if (!fechaExiste(m[2], m[3], m[4])) {
    return { ok: false, rfc, motivo: 'fecha', mensaje: `La fecha del RFC (${m[2]}${m[3]}${m[4]}) no existe.` };
  }
  const esperado = digitoVerificadorRfc(rfc.slice(0, -1));
  if (esperado !== rfc.slice(-1)) {
    return {
      ok: false, rfc, motivo: 'verificador', verificador_esperado: esperado,
      mensaje: 'El último carácter del RFC no cuadra con los demás: casi siempre es una letra o un número mal copiado.',
    };
  }
  return { ok: true, rfc, tipo: rfc.length === 13 ? 'fisica' : 'moral', generico: false };
}

export type MotivoCurpInvalida = 'vacio' | 'formato' | 'fecha' | 'entidad' | 'verificador';

export type ResultadoCurp =
  | { ok: true; curp: string }
  | { ok: false; curp: string; motivo: MotivoCurpInvalida; mensaje: string };

export function validarCurp(raw: unknown): ResultadoCurp {
  const curp = normalizarClaveFiscal(raw);
  if (!curp) return { ok: false, curp, motivo: 'vacio', mensaje: 'Falta la CURP.' };
  const m = CURP_FORMA.exec(curp);
  if (!m) return { ok: false, curp, motivo: 'formato', mensaje: 'La CURP no tiene la forma de RENAPO (18 caracteres).' };
  if (!fechaExiste(m[2], m[3], m[4])) {
    return { ok: false, curp, motivo: 'fecha', mensaje: `La fecha de nacimiento de la CURP (${m[2]}${m[3]}${m[4]}) no existe.` };
  }
  if (!ENTIDADES_CURP.has(m[6])) {
    return { ok: false, curp, motivo: 'entidad', mensaje: `La entidad de nacimiento «${m[6]}» de la CURP no existe.` };
  }
  if (digitoVerificadorCurp(curp.slice(0, 17)) !== curp.slice(-1)) {
    return {
      ok: false, curp, motivo: 'verificador',
      mensaje: 'El último dígito de la CURP no cuadra con los demás: casi siempre es un carácter mal copiado.',
    };
  }
  return { ok: true, curp };
}

/**
 * ¿RFC de persona física y CURP son de la misma persona? Comparten los 10 primeros caracteres
 * (iniciales + fecha). ⚠️ Es un **aviso**, no un bloqueo: RENAPO y el SAT sustituyen distinto las
 * palabras altisonantes, así que hay casos legítimos donde difieren.
 */
export function rfcYCurpCoinciden(rfc: unknown, curp: unknown): boolean {
  const r = normalizarClaveFiscal(rfc), c = normalizarClaveFiscal(curp);
  return r.length === 13 && c.length === 18 && r.slice(0, 10) === c.slice(0, 10);
}
