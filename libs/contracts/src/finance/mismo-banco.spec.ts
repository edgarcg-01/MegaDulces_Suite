import { bancoCanonico, bancoSinCuentaNuestra, destinoSinClabe, faltaOrigenMismoBanco, origenesParaDestino, origenPropuesto } from './mismo-banco.contract';

/**
 * `[PGP.155]` VUMERSOFT se paga BBVA a BBVA con el número de cuenta: el origen sólo puede ser una cuenta BBVA
 * nuestra. Nombres de banco: los de `finance.bank_accounts` y los del catálogo de proveedor, medidos en prod.
 */
const VUM = { clabe: null, bank_name: 'BBVA' };
const NUESTRAS = [
  { id: 'bbva-5712', bank: 'BBVA', kind: 'bank' }, { id: 'bbva-6586', bank: 'BBVA', kind: 'bank' },
  { id: 'bte-3041', bank: 'BANORTE', kind: 'bank' }, { id: 'stdr-1604', bank: 'SANTANDER', kind: 'bank' },
  { id: 'caja', bank: 'CAJA', kind: 'cash' },
];

describe('[PGP.155] bancoCanonico — un banco con varios nombres', () => {
  it('reconoce los nombres de nuestras cuentas y los del catálogo de proveedor', () => {
    expect(bancoCanonico('BBVA')).toBe('BBVA');
    expect(bancoCanonico('bbva bancomer')).toBe('BBVA');
    expect(bancoCanonico('Bancomer')).toBe('BBVA');
    expect(bancoCanonico('BanBajío')).toBe('BBAJIO');
    expect(bancoCanonico('BBAJIO')).toBe('BBAJIO');
    expect(bancoCanonico('Citibanamex')).toBe('BANAMEX');
  });
  it('⛔ NEGATIVA — lo que no reconoce es null (no se adivina un banco)', () => {
    expect(bancoCanonico('BANCO X')).toBeNull();
    expect(bancoCanonico('')).toBeNull();
    expect(bancoCanonico(null)).toBeNull();
    expect(bancoCanonico('CAJA')).toBeNull();
  });
});

describe('[PGP.155] faltaOrigenMismoBanco — sin CLABE, el origen es del mismo banco', () => {
  it('⛔ NEGATIVA — a la cuenta BBVA sin CLABE desde Banorte no sale, y lo dice', () => {
    expect(faltaOrigenMismoBanco({ destino: VUM, origen: { bank: 'BANORTE', kind: 'bank' } })).toMatch(/sale sólo de una cuenta BBVA nuestra/);
  });
  it('desde una BBVA nuestra, sí', () => {
    expect(faltaOrigenMismoBanco({ destino: VUM, origen: { bank: 'BBVA', kind: 'bank' } })).toBeNull();
    expect(faltaOrigenMismoBanco({ destino: { clabe: '', bank_name: 'Bancomer' }, origen: { bank: 'BBVA', kind: 'bank' } })).toBeNull();
  });
  it('con CLABE (SPEI), sin destino del catálogo, desde caja o con un banco que no se reconoce: no se juzga', () => {
    expect(faltaOrigenMismoBanco({ destino: { clabe: '012180001234567899', bank_name: 'BBVA' }, origen: { bank: 'BANORTE', kind: 'bank' } })).toBeNull();
    expect(faltaOrigenMismoBanco({ destino: null, origen: { bank: 'BANORTE', kind: 'bank' } })).toBeNull();
    expect(faltaOrigenMismoBanco({ destino: VUM, origen: { bank: 'CAJA', kind: 'cash' } })).toBeNull();
    expect(faltaOrigenMismoBanco({ destino: { clabe: null, bank_name: 'BANCO X' }, origen: { bank: 'BANORTE', kind: 'bank' } })).toBeNull();
  });
  it('destinoSinClabe: 18 dígitos es CLABE; vacío o corto, no', () => {
    expect(destinoSinClabe({ clabe: '0121 8000 1234 5678 99' })).toBe(false);
    expect(destinoSinClabe({ clabe: null })).toBe(true);
    expect(destinoSinClabe(null)).toBe(false);
  });
  it('⛔ NEGATIVA [PGP.155.2] — una tarjeta de débito (16 dígitos) no ata al mismo banco: SPEI la acepta de cualquiera', () => {
    const tarjeta = { clabe: null, bank_name: 'BBVA', account_number: '4152 3137 1234 5678' };
    expect(destinoSinClabe(tarjeta)).toBe(false);
    expect(faltaOrigenMismoBanco({ destino: tarjeta, origen: { bank: 'BANORTE', kind: 'bank' } })).toBeNull();
    expect(destinoSinClabe({ clabe: null, account_number: '0123458796' })).toBe(true);   // cuenta de 10: sí ata
  });
});

describe('[PGP.155] origenesParaDestino — el diálogo ofrece sólo las del banco', () => {
  it('a la cuenta BBVA sin CLABE: de nuestros bancos sólo las BBVA; caja y factoraje se quedan, como en el servidor [PGP.155.2]', () => {
    expect(origenesParaDestino(NUESTRAS, VUM).map((o) => o.id)).toEqual(['bbva-5712', 'bbva-6586', 'caja']);
    // La misma regla que faltaOrigenMismoBanco: lo que la pantalla ofrece, el servidor lo acepta.
    for (const o of origenesParaDestino(NUESTRAS, VUM)) expect(faltaOrigenMismoBanco({ destino: VUM, origen: o })).toBeNull();
    for (const o of NUESTRAS.filter((x) => !origenesParaDestino(NUESTRAS, VUM).includes(x))) expect(faltaOrigenMismoBanco({ destino: VUM, origen: o })).not.toBeNull();
  });
  it('con CLABE, sin destino o con un banco que no se reconoce: todas', () => {
    expect(origenesParaDestino(NUESTRAS, { clabe: '012180001234567899', bank_name: 'BBVA' })).toHaveLength(5);
    expect(origenesParaDestino(NUESTRAS, null)).toHaveLength(5);
    expect(origenesParaDestino(NUESTRAS, { clabe: null, bank_name: 'BANCO X' })).toHaveLength(5);
  });
  it('⛔ NEGATIVA — si no tenemos cuenta de ese banco, no deja la lista vacía (el servidor dirá por qué)', () => {
    expect(origenesParaDestino(NUESTRAS, { clabe: null, bank_name: 'HSBC' })).toHaveLength(5);
  });
});

describe('[PGP.155.2] bancoSinCuentaNuestra — cuándo NO se puede transferir (para no decir «sólo se ofrecen ésas»)', () => {
  it('⛔ NEGATIVA — a una HSBC sin CLABE: no tenemos HSBC → lo dice', () => {
    expect(bancoSinCuentaNuestra(NUESTRAS, { clabe: null, bank_name: 'HSBC' })).toBe('HSBC');
  });
  it('a una BBVA sin CLABE (tenemos BBVA), con CLABE, tarjeta, banco que no se reconoce o sin destino: null', () => {
    expect(bancoSinCuentaNuestra(NUESTRAS, VUM)).toBeNull();
    expect(bancoSinCuentaNuestra(NUESTRAS, { clabe: '012180001234567899', bank_name: 'HSBC' })).toBeNull();
    expect(bancoSinCuentaNuestra(NUESTRAS, { clabe: null, bank_name: 'HSBC', account_number: '4152313712345678' })).toBeNull();
    expect(bancoSinCuentaNuestra(NUESTRAS, { clabe: null, bank_name: 'BANCO X' })).toBeNull();
    expect(bancoSinCuentaNuestra(NUESTRAS, null)).toBeNull();
  });
  it('⛔ NEGATIVA — la caja no cuenta como «tenemos de ese banco»', () => {
    expect(bancoSinCuentaNuestra([{ bank: 'BBVA', kind: 'cash' }], VUM)).toBe('BBVA');
  });
});

describe('[PGP.155] origenPropuesto — qué BBVA queda puesta (sin adivinar: [PGP.75])', () => {
  const BBVA = ['bbva-5712', 'bbva-6586'];
  it('se queda la que ya estaba si es BBVA; si no, la del día; si no, la de su historial', () => {
    expect(origenPropuesto({ actual: 'bbva-6586', sirven: BBVA, delDia: 'bbva-5712', historial: null })).toBe('bbva-6586');
    expect(origenPropuesto({ actual: 'bte-3041', sirven: BBVA, delDia: 'bbva-5712', historial: 'bbva-6586' })).toBe('bbva-5712');
    expect(origenPropuesto({ actual: 'bte-3041', sirven: BBVA, delDia: 'stdr-1604', historial: 'bbva-6586' })).toBe('bbva-6586');
  });
  it('⛔ NEGATIVA — con varias BBVA y nada que la decida, no elige ninguna (VUMERSOFT rota entre cuatro)', () => {
    expect(origenPropuesto({ actual: 'bte-3041', sirven: BBVA, delDia: 'stdr-1604', historial: null })).toBeNull();
  });
  it('con una sola cuenta de ese banco, ésa', () => {
    expect(origenPropuesto({ actual: null, sirven: ['bbva-5712'], delDia: null, historial: null })).toBe('bbva-5712');
  });
});
