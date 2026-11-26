import { BadRequestException } from '@nestjs/common';
import { REFERENCIA_MAX } from './ajuste-abono.armador';
import { desenlace, referenciaDe, serieCfdiDe, tipoSerieDe, validarCierre } from './ajuste-abono.service';

/**
 * `[GP.R.3]` Lo que se puede probar sin base del cierre de restos. Cada guarda con su **prueba negativa** (regla 12):
 * si alguien la quita, una de éstas se pone roja. Lo que toca Postgres o Kepler se prueba en
 * `database/tests/test-newdb-ajuste-abono-registro.js` y en el ensayo de `ops/prod/ensayo-ajuste-abono/`.
 */
const base = { cliente: 'C2043', motivo: 'resto de centavos del cobro del 20-nov', facturas: [{ doc_code: 'UD0801', folio: '0000470' }] };

describe('[GP.R.3] validarCierre', () => {
  it('acepta lo que manda la pantalla y normaliza', () => {
    const d = validarCierre('08', base);
    // ⭐ La pantalla manda el doc_code que ya vio; el tipo y la serie los DERIVA el servidor.
    expect(d).toEqual({
      sucursal: '08', cliente: 'C2043', motivo: base.motivo,
      facturas: [{ doc_code: 'UD0801', folio: '0000470', tipo: 8, serie: 1 }],
    });
  });

  it('negativo: sucursal que no es de dos dígitos', () => {
    for (const s of ['8', '', '008', 'AB']) expect(() => validarCierre(s, base)).toThrow(BadRequestException);
    expect(validarCierre('08', base).sucursal).toBe('08');                                   // el control
  });

  it('negativo: sin cliente, sin motivo o sin facturas no se cierra nada', () => {
    expect(() => validarCierre('08', { ...base, cliente: '  ' })).toThrow(/UN cliente/);
    expect(() => validarCierre('08', { ...base, motivo: '' })).toThrow(/motivo/);
    expect(() => validarCierre('08', { ...base, facturas: [] })).toThrow(/al menos una factura/);
  });

  it('negativo: un motivo larguísimo no entra (la columna del registro lo acota)', () => {
    expect(() => validarCierre('08', { ...base, motivo: 'x'.repeat(201) })).toThrow(/caracteres/);
    expect(validarCierre('08', { ...base, motivo: 'x'.repeat(200) }).motivo.length).toBe(200);  // el control
  });

  it('negativo: la misma factura dos veces aplicaría su resto doble', () => {
    expect(() => validarCierre('08', { ...base, facturas: [base.facturas[0], base.facturas[0]] })).toThrow(/dos veces/);
  });

  it('negativo: un doc_code que no es de Kepler, o un folio imposible', () => {
    for (const doc_code of ['', 'UD08', 'XX0801', 'ud0801', 'UD08011']) {
      expect(() => validarCierre('08', { ...base, facturas: [{ doc_code, folio: '1' }] })).toThrow(/documento inválido/);
    }
    expect(() => validarCierre('08', { ...base, facturas: [{ doc_code: 'UD0801', folio: '' }] })).toThrow(/folio/);
    expect(() => validarCierre('08', { ...base, facturas: [{ doc_code: 'UD0801', folio: 'x'.repeat(21) }] })).toThrow(/folio/);
    expect(validarCierre('08', { ...base, facturas: [{ doc_code: 'UD1301', folio: '7' }] }).facturas[0].tipo).toBe(13);  // el control
  });
});

describe('[GP.R.3] la liga con Kepler y con el CFDI', () => {
  /** Medido el 2026-11-25: los 260 restos vivos son `UD0801` (220), `UD1301` (37) y `UD1201` (3). */
  it('doc_code → tipo y serie del documento de Kepler', () => {
    expect(tipoSerieDe('UD0801')).toEqual({ tipo: 8, serie: 1 });
    expect(tipoSerieDe('UD1301')).toEqual({ tipo: 13, serie: 1 });
    expect(tipoSerieDe('UD1201')).toEqual({ tipo: 12, serie: 1 });
    for (const malo of ['', 'UD08', 'XX0801', 'UD08011', 'ud0801']) expect(tipoSerieDe(malo)).toBeNull();
  });

  /** La liga se PROBÓ contra prod: 400 de 400 facturas de Kepler encontraron su CFDI por serie y folio. */
  it('la serie del CFDI es la sucursal pegada al doc_code', () => {
    expect(serieCfdiDe('08', 'UD0801')).toBe('08UD0801');
    expect(serieCfdiDe('01', 'UD0801')).toBe('01UD0801');
  });
});

describe('[GP.R.3] la referencia de idempotencia', () => {
  /** ⛔ `kdm1.c11` es `varchar(20)`: el primer ensayo murió con «el valor es demasiado largo». */
  it('cabe en 20 caracteres, hoy y dentro de muchos años', () => {
    for (const t of [Date.now(), 0, 4102444800000, Number.MAX_SAFE_INTEGER]) {
      expect(referenciaDe('08', t).length).toBeLessThanOrEqual(REFERENCIA_MAX);
    }
  });

  it('empieza con RC y la sucursal, y dos clics seguidos no dan la misma', () => {
    expect(referenciaDe('08', 1764086400000)).toMatch(/^RC08/);
    expect(referenciaDe('08', 1764086400000)).not.toBe(referenciaDe('08', 1764086400001));
  });
});

describe('[GP.R.3] desenlace', () => {
  const kepler = { sucursal: '08', folio: '0000002', facturas: 1, total: 7.2, saldos: [] };

  it('escrito y ya_estaba se distinguen (repetir el clic no miente)', () => {
    expect(desenlace({ estado: 'escrito', kepler })).toEqual({ estado: 'escrito', mensaje: 'Cerrado en Kepler con el Ajuste Abono 0000002.', reintentable: false });
    expect(desenlace({ estado: 'escrito', ya_estaba: true, kepler }).estado).toBe('ya_estaba');
  });

  it('apagado NO se reintenta; un rechazo reintentable sí', () => {
    expect(desenlace({ estado: 'apagado', motivo: 'La escritura está apagada' })).toEqual({ estado: 'apagado', mensaje: 'La escritura está apagada', reintentable: false });
    expect(desenlace({ estado: 'rechazado', motivo: 'timeout', reintentable: true }).reintentable).toBe(true);
    expect(desenlace({ estado: 'rechazado', motivo: 'es deuda, no redondeo', reintentable: false }).reintentable).toBe(false);
  });
});
