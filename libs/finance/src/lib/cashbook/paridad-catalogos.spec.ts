import { createRequire } from 'node:module';
import * as path from 'node:path';
import { BILLETES_USD, DENOMINACIONES_MXN, EVENTOS_SIEMPRE_AUTORIZADOS, EVENTOS_LIBRO } from '@megadulces/contracts';
import { CUENTAS_FIJAS } from './reglas';

/**
 * `[LE.2.2]` — PARIDAD: la base (`cashbook`, sembrado por la migración `20261027111930`) y el código
 * (`libs/contracts`, `reglas.ts`) tienen que decir lo mismo. Si no, un billete válido en uno se
 * rechaza en el otro, o una cuenta fija nace con otra forma y `open_account` la rechaza.
 */
type Den = [string, string, number, string];
type Cta = [string, string, string, string, boolean, boolean, string];
const MIGRACION = path.resolve(__dirname, '../../../../../database/migrations-newdb/20261027111930_le1_cashbook_libro_de_partida_doble.js');
const { CATALOGOS } = createRequire(__filename)(MIGRACION) as {
  CATALOGOS: { DENOMINACIONES: Den[]; CUENTAS_BASE: Cta[]; SIEMPRE_AUTORIZA: string[] };
};

describe('[LE.2.2] paridad base ↔ código', () => {
  it('las denominaciones: misma llave, mismo valor, misma familia, en las dos monedas', () => {
    const base = CATALOGOS.DENOMINACIONES.map(([m, k, v, f]) => `${m}|${k}|${v}|${f}`).sort();
    const codigo = [
      ...DENOMINACIONES_MXN.map((d) => `MXN|${d.key}|${Math.round(d.valor * 100)}|${d.familia}`),
      ...BILLETES_USD.map((d) => `USD|${d.key}|${Math.round(d.valor * 100)}|${d.familia}`),
    ].sort();
    expect(base).toEqual(codigo);
  });

  it('las cuentas fijas: misma forma en la siembra y en las reglas', () => {
    const base = CATALOGOS.CUENTAS_BASE.map(([code, name, clase, cur, piezas, neg, testigo]) =>
      JSON.stringify({ code, name, class: clase, currency: cur, tracks_pieces: piezas, allows_negative: neg, witness: testigo })).sort();
    const codigo = Object.values(CUENTAS_FIJAS).map((c) =>
      JSON.stringify({ code: c.code, name: c.name, class: c.class, currency: c.currency, tracks_pieces: c.tracks_pieces, allows_negative: c.allows_negative, witness: c.witness })).sort();
    expect(base).toEqual(codigo);
  });

  it('los eventos que siempre autoriza otra persona son los mismos, y existen en el catálogo', () => {
    expect([...CATALOGOS.SIEMPRE_AUTORIZA].sort()).toEqual([...EVENTOS_SIEMPRE_AUTORIZADOS].sort());
    for (const e of EVENTOS_SIEMPRE_AUTORIZADOS) expect(EVENTOS_LIBRO).toContain(e);
  });
});
