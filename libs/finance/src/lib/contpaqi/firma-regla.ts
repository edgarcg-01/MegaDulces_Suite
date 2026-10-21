/**
 * `[CP.8.51]` — **La firma de una regla de cuenta: qué se puede firmar, y con qué.**
 *
 * El 39 % de los egresos de banco no sale de póliza porque su categoría no tiene cuenta firmada
 * (`sin_regla`). Elegir esa cuenta es **criterio contable**: se midió dos veces que no se deriva
 * (§19.1, §24.2 de `FASE_CP8`). Así que el sistema no la elige — la propone como indicio y el
 * contador la firma. Esta función decide si una firma es válida; no decide la cuenta.
 *
 * ⛔ **La forma la dicta el dato (D4 del plan de aterrizaje).** Sólo una regla `por_categoria` se
 * firma eligiendo UNA cuenta. Las otras formas no tienen una cuenta que elegir:
 *
 *   por_proveedor  → la cuenta la decide cada PROVEEDOR: se resuelve con alias, no aquí.
 *   por_sucursal   → la decide la PLAZA, y el movimiento bancario no trae centro de costo.
 *   sin_medir      → nadie midió todavía cómo la asienta contabilidad: firmarla sería adivinar.
 *   no_aplica      → ya se decidió que no genera póliza.
 *
 * Y `por_categoria` significa —por cómo la mide el derivador— *«el asiento real carga a 52\*»*.
 * Por eso la cuenta tiene que ser de gasto `52`: una firma a un banco o a un proveedor cuadraría
 * igual y no se vería hasta la balanza.
 */

export interface ReglaFirmable {
  categoria_code: string;
  tipo_regla: string;
  estado: string;
}

export interface CuentaCatalogo {
  codigo: string;
  nombre: string;
  afectable: number | boolean | null;
  es_baja: boolean | null;
}

export const PREFIJO_GASTO = '52';

const MOTIVO_NO_FIRMABLE: Record<string, string> = {
  por_proveedor: 'la cuenta la decide cada proveedor: se resuelve confirmando alias, no con una cuenta para toda la categoría',
  por_sucursal: 'la cuenta la decide la plaza, y el movimiento bancario no trae centro de costo: falta el dato, no la firma',
  sin_medir: 'nadie ha medido cómo la asienta contabilidad: firmarla con una cuenta sería adivinar',
  no_aplica: 'ya se decidió que no genera póliza',
};

/** ¿Se puede firmar con una cuenta? Si no, por qué — dicho para quien lo va a leer. */
export function esFirmable(r: ReglaFirmable): { firmable: true } | { firmable: false; motivo: string } {
  if (r.tipo_regla === 'por_categoria') return { firmable: true };
  return { firmable: false, motivo: MOTIVO_NO_FIRMABLE[r.tipo_regla] ?? `forma «${r.tipo_regla}» sin firma definida` };
}

/** Valida una firma. Devuelve el motivo exacto del rechazo: quien firma tiene que poder corregir. */
export function validarFirma(p: {
  regla: ReglaFirmable | null;
  cuenta: string;
  catalogo: CuentaCatalogo | null;
  por: string;
}): { ok: true } | { ok: false; motivo: string } {
  if (!p.regla) return { ok: false, motivo: 'la categoría no tiene regla en contpaqi.account_rules' };
  const f = esFirmable(p.regla);
  if (!f.firmable) return { ok: false, motivo: `«${p.regla.categoria_code}» no se firma con una cuenta: ${f.motivo}` };
  if (!p.por) return { ok: false, motivo: 'una firma sin autor no es una firma' };
  const cuenta = String(p.cuenta ?? '').trim();
  if (!/^\d{10}$/.test(cuenta)) return { ok: false, motivo: `«${cuenta}» no es una cuenta de ContPAQi (10 dígitos)` };
  if (!cuenta.startsWith(PREFIJO_GASTO)) {
    return { ok: false, motivo: `la cuenta ${cuenta} no es de gasto (${PREFIJO_GASTO}*): una regla por categoría carga a gasto` };
  }
  if (!p.catalogo) return { ok: false, motivo: `la cuenta ${cuenta} no existe en el catálogo de ContPAQi` };
  if (!(p.catalogo.afectable === true || Number(p.catalogo.afectable) === 1)) {
    return { ok: false, motivo: `la cuenta ${cuenta} (${p.catalogo.nombre}) es de mayor, no afectable: ContPAQi no la acepta en un renglón` };
  }
  if (p.catalogo.es_baja) return { ok: false, motivo: `la cuenta ${cuenta} (${p.catalogo.nombre}) está dada de baja en ContPAQi` };
  return { ok: true };
}

/** Revocar sólo tiene sentido sobre lo firmado. */
export function validarRevocacion(r: ReglaFirmable | null, por: string): { ok: true } | { ok: false; motivo: string } {
  if (!r) return { ok: false, motivo: 'la categoría no tiene regla en contpaqi.account_rules' };
  if (r.estado !== 'aprobada') return { ok: false, motivo: `«${r.categoria_code}» no está firmada (está en ${r.estado})` };
  if (!por) return { ok: false, motivo: 'una revocación sin autor no se acepta' };
  return { ok: true };
}
