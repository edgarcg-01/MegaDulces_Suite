import { describe, expect, it } from 'vitest';
import { CONFIANZA_GRUPO, CONFIANZA_GRUPO_ACREEDOR, PASE_GRUPO, PASE_GRUPO_ACREEDOR, paseDelGrupo } from './recon-pase-grupo';
import { PASES_DEBILES } from './estado-de-cuenta/motor-de-categoria';

/**
 * `[BFU.7.12]` El pase 4 (por grupo): el grupo de UN acreedor el mismo día deja de ser débil. Caso de prod (nov-2026):
 * una transferencia al proveedor que Tesorería capturó en Kepler en 2–3 pagos `X-D-26`, mismo acreedor y misma fecha.
 */
const doc = (acreedor: string | null, fecha: string | null) => ({ acreedor, fecha });
const FUERTE = { pase: PASE_GRUPO_ACREEDOR, confianza: CONFIANZA_GRUPO_ACREEDOR };
const DEBIL = { pase: PASE_GRUPO, confianza: CONFIANZA_GRUPO };

describe('[BFU.7.12] paseDelGrupo', () => {
  it('un acreedor, todos los documentos del mismo día que el banco → pase fuerte', () => {
    expect(paseDelGrupo('2026-11-20', [doc('C0123', '2026-11-20'), doc('C0123', '2026-11-20')])).toEqual(FUERTE);
    expect(paseDelGrupo('2026-11-20', [doc('C0123', '2026-11-20'), doc('C0123', '2026-11-20'), doc('C0123', '2026-11-20')])).toEqual(FUERTE);
  });
  it('a un día (la fecha valor del banco) sigue siendo el mismo pago', () => {
    expect(paseDelGrupo('2026-11-20', [doc('C0123', '2026-11-19'), doc('C0123', '2026-11-21')])).toEqual(FUERTE);
  });
  it('el espacio de más en el código del acreedor no lo vuelve otro', () => {
    expect(paseDelGrupo('2026-11-20', [doc('C0123 ', '2026-11-20'), doc(' C0123', '2026-11-20')])).toEqual(FUERTE);
  });
  it('⛔ [negativa] acreedores mezclados: la suma salió por casualidad → débil', () => {
    expect(paseDelGrupo('2026-11-20', [doc('C0123', '2026-11-20'), doc('C0999', '2026-11-20')])).toEqual(DEBIL);
  });
  it('⛔ [negativa] un documento a más de un día → débil, aunque sea el mismo acreedor', () => {
    expect(paseDelGrupo('2026-11-20', [doc('C0123', '2026-11-20'), doc('C0123', '2026-11-22')])).toEqual(DEBIL);
    expect(paseDelGrupo('2026-11-20', [doc('C0123', '2026-11-20'), doc('C0123', '2026-11-18')])).toEqual(DEBIL);
  });
  it('⛔ [negativa] sin acreedor o sin fecha no se puede afirmar nada → débil', () => {
    expect(paseDelGrupo('2026-11-20', [doc('C0123', '2026-11-20'), doc(null, '2026-11-20')])).toEqual(DEBIL);
    expect(paseDelGrupo('2026-11-20', [doc('C0123', '2026-11-20'), doc('', '2026-11-20')])).toEqual(DEBIL);
    expect(paseDelGrupo('2026-11-20', [doc('C0123', '2026-11-20'), doc('C0123', null)])).toEqual(DEBIL);
    expect(paseDelGrupo('', [doc('C0123', '2026-11-20'), doc('C0123', '2026-11-20')])).toEqual(DEBIL);
  });
  it('⛔ [negativa] un solo documento no es un grupo', () => {
    expect(paseDelGrupo('2026-11-20', [doc('C0123', '2026-11-20')])).toEqual(DEBIL);
  });
  it('el motor de categoría decide con el pase fuerte y NO con el débil (el contrato con `PASES_DEBILES`)', () => {
    expect(PASES_DEBILES.has(PASE_GRUPO)).toBe(true);
    expect(PASES_DEBILES.has(PASE_GRUPO_ACREEDOR)).toBe(false);
  });
});
