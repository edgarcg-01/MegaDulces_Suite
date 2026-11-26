/**
 * `[BFU.7.12]` **El pase 4 de la conciliación de tesorería (por grupo): cuándo un grupo SÍ dice qué es.**
 *
 * El pase 4 casa UN movimiento del banco con N documentos de Kepler de la misma cuenta y dirección cuya suma da el
 * importe (±5 centavos), buscando entre hasta 30 candidatos de ±10 días. Con 30 candidatos hay millones de
 * combinaciones: una suma exacta puede salir por casualidad, y por eso el motor de categoría lo trata como débil
 * (`PASES_DEBILES`) y no decide con él.
 *
 * ⛔ El hueco (Bancos › Movimientos, salidas de Tesorería, nov-2026): 12 retiros ya casados con Kepler se
 * quedaban «sin clasificar» con motivo `pareo_debil`. En los 12, los 2–3 pagos `X-D-26` del grupo eran del MISMO
 * acreedor y de la MISMA fecha que el retiro: una transferencia que Tesorería capturó en Kepler en varios pagos.
 * Sobre todos los grupos casados hasta hoy (169): 120 del mismo acreedor y mismo día, 25 del mismo acreedor en otro
 * día, 14 con acreedores mezclados, 10 sin acreedor.
 *
 * Arreglo, angosto a propósito: el grupo es fuerte SÓLO si todos sus documentos traen acreedor, es el mismo, y cada
 * uno está a ≤ 1 día del movimiento. Lo demás sigue débil. Aunque el folio exacto de un grupo así fuera otro, el
 * acreedor es el mismo, y con él la categoría.
 */

/** El nombre del pase débil de siempre: el motor de categoría no decide con él. */
export const PASE_GRUPO = 'motor-tes-group';
/** El grupo de UN acreedor el mismo día: no está en `PASES_DEBILES`, el motor sí decide con él. */
export const PASE_GRUPO_ACREEDOR = 'motor-tes-group-acreedor';
export const CONFIANZA_GRUPO = 0.55;
export const CONFIANZA_GRUPO_ACREEDOR = 0.8;
/** Distancia máxima, en días, de cada documento del grupo al movimiento del banco. */
export const DIAS_GRUPO_ACREEDOR = 1;

export interface DocumentoDelGrupo {
  /** Código del acreedor en Kepler (`entidad_code`); sin él no se puede afirmar que es el mismo. */
  acreedor: string | null | undefined;
  /** Fecha del documento `YYYY-MM-DD`. */
  fecha: string | null | undefined;
}

const dia = (s: string) => Date.parse(`${s.slice(0, 10)}T12:00:00Z`);

/** El pase y la confianza con que se guarda un grupo ya elegido por la suma. */
export function paseDelGrupo(fechaDelBanco: string, docs: readonly DocumentoDelGrupo[]): { pase: string; confianza: number } {
  const debil = { pase: PASE_GRUPO, confianza: CONFIANZA_GRUPO };
  if (docs.length < 2 || !fechaDelBanco) return debil;
  const acreedores = new Set<string>();
  for (const d of docs) {
    const a = (d.acreedor ?? '').trim();
    if (!a || !d.fecha) return debil;
    acreedores.add(a);
    if (Math.abs(dia(d.fecha) - dia(fechaDelBanco)) / 86400000 > DIAS_GRUPO_ACREEDOR) return debil;
  }
  return acreedores.size === 1 ? { pase: PASE_GRUPO_ACREEDOR, confianza: CONFIANZA_GRUPO_ACREEDOR } : debil;
}
