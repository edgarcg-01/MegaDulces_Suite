/**
 * CS.3.3 — Pruebas del motor de propuesta caja⇄CAOS. Puras, sin DB (patrón caja-autofill.engine).
 *
 * El eje: que la señal MEDIDA mande (mismo día > ±días; ref que coincide; monto exacto) y que
 * NUNCA premie lo improbable (un retiro mayor que el gasto no es parte de ese gasto).
 */
import {
  norm, tokensRef, diasEntre, rutaDe, fechaNegocio, puntuarCaos, rankearCaos, ymd,
  type CaosCandidato, type GastoCtx, type PatronAprendido,
} from './caja-caos-match.engine';

const cand = (o: Partial<CaosCandidato> = {}): CaosCandidato => ({
  origen_ref: 'AST700-19758|1420', external_id: 1420, device: 'AST700-19758', type_label: 'Dispensar',
  fecha_valor: '2026-09-24', sucursal: '00', user_external: '003', ref: 'cueritos', monto: 20000,
  denominaciones: [{ denominacion: 500, piezas: 40 }], ...o,
});

describe('norm / tokensRef', () => {
  it('norm quita acentos, mayúsculas y puntuación', () => {
    expect(norm('Nómina, Canindo!')).toBe('nomina canindo');
  });
  it('tokensRef deja tokens >=4 y descarta palabras vacías', () => {
    expect(tokensRef('pagos cueritos')).toEqual(['cueritos']); // "pagos" es stopword
    expect(tokensRef('gnf ma')).toEqual([]);                    // ambos <4
    expect(tokensRef('lic omar')).toEqual(['omar']);            // "lic" <4, "omar" ok
  });
});

describe('ymd — el driver devuelve Date, no string (el bug que reventó la bandeja en prod)', () => {
  it('[EL BUG] un OBJETO Date (lo que pg devuelve para `date`/`timestamptz`) NO revienta: da YYYY-MM-DD', () => {
    // Antes: String(new Date('2026-09-27')) = "Sun Sep 27 2026 ..." -> slice(0,10) = "Sun Sep 27"
    // -> Date.parse NaN -> new Date(NaN).toISOString() TIRABA. Ahora se coacciona bien.
    expect(ymd(new Date('2026-09-27T00:00:00Z'))).toBe('2026-09-27');
  });
  it('un timestamptz con hora cae al día calendario correcto', () => {
    expect(ymd(new Date('2026-09-26T18:41:22Z'))).toBe('2026-09-26'); // 12:41 MX = 18:41Z, mismo día
  });
  it('string YYYY-MM-DD y timestamp ISO pasan a su parte de fecha', () => {
    expect(ymd('2026-09-27')).toBe('2026-09-27');
    expect(ymd('2026-09-27T13:05:00-06:00')).toBe('2026-09-27');
  });
  it('null/undefined y basura -> null (se declara, no se inventa)', () => {
    expect(ymd(null)).toBeNull();
    expect(ymd(undefined)).toBeNull();
    expect(ymd('Sun Sep 27')).toBeNull();          // el viejo String(Date).slice que causaba el NaN
    expect(ymd(new Date('no-es-fecha'))).toBeNull(); // Invalid Date
  });
  it('[regresión] construir la ventana desde Date-objects (como emparejarCaos) YA NO tira', () => {
    const rows = [{ fecha_valor: new Date('2026-09-27T00:00:00Z') }, { fecha_valor: new Date('2026-09-25T00:00:00Z') }];
    const fechas = rows.map((r) => ymd(r.fecha_valor)).filter((d): d is string => !!d).sort();
    const t0 = Date.parse(`${fechas[0]}T00:00:00Z`);
    const t1 = Date.parse(`${fechas[fechas.length - 1]}T00:00:00Z`);
    expect(() => new Date(t0 - 10 * 86400000).toISOString()).not.toThrow();
    expect(() => new Date(t1 + 3 * 86400000).toISOString()).not.toThrow();
    expect(fechas).toEqual(['2026-09-25', '2026-09-27']);
  });
});

describe('diasEntre', () => {
  it('mismo día = 0, consecutivo = 1', () => {
    expect(diasEntre('2026-09-24', '2026-09-24')).toBe(0);
    expect(diasEntre('2026-09-24', '2026-09-25')).toBe(1);
  });
});

describe('puntuarCaos — la señal medida manda', () => {
  it('mismo día + monto exacto + ref que coincide = confianza ALTA', () => {
    const g: GastoCtx = { monto: 20000, fecha: '2026-09-24', beneficiario: 'CUERITOS LUPITA', concepto: 'compra' };
    const r = puntuarCaos(g, cand());
    expect(r.confianza).toBe('alta');           // ref 40 + exacto 30 + registro mismo día 12 = 82
    expect(r.motivos).toContain('monto exacto');
    expect(r.motivos.some((m) => m.includes('cueritos'))).toBe(true);
  });

  it('[parcial] retiro MENOR que el gasto suma como "financia una parte" (el caso 20k de 25k)', () => {
    const g: GastoCtx = { monto: 25000, fecha: '2026-09-24', beneficiario: 'CUERITOS LUPITA' };
    const r = puntuarCaos(g, cand({ monto: 20000 }));
    expect(r.motivos).toContain('parte del arqueo');
    expect(r.score).toBeGreaterThan(0);
  });

  it('[negativa] un retiro MAYOR que el gasto se penaliza (no es parte de ese gasto)', () => {
    const g: GastoCtx = { monto: 5000, fecha: '2026-09-24', beneficiario: 'otro' };
    const chico = puntuarCaos(g, cand({ monto: 20000, ref: 'zzz' }));
    expect(chico.motivos).toContain('monto mayor que el movimiento');
  });

  it('[negativa] lejos en el tiempo y sin ninguna otra señal no llega a confianza', () => {
    const g: GastoCtx = { monto: null, fecha: '2026-09-24', beneficiario: 'nada que ver' };
    const r = puntuarCaos(g, cand({ fecha_valor: '2026-08-01', ref: 'zzz' }));
    expect(r.confianza).toBe('baja');
  });

  it('lo APRENDIDO sube la confianza del mismo ref', () => {
    const g: GastoCtx = { monto: null, fecha: '2026-09-25', beneficiario: '' };
    const base = puntuarCaos(g, cand({ fecha_valor: '2026-09-24' })); // ±1, sin ref-hit ni monto
    const aprendido = new Map<string, PatronAprendido>([
      ['cueritos', { ref_norm: 'cueritos', casos: 3, cuenta_tipica: '201', concepto_tipico: '001', beneficiario_tipico: 'CUERITOS' }],
    ]);
    const conApr = puntuarCaos(g, cand({ fecha_valor: '2026-09-24' }), aprendido);
    expect(conApr.score).toBeGreaterThan(base.score);
    expect(conApr.motivos.some((m) => m.includes('confirmado'))).toBe(true);
  });
});

describe('rutaDe — la ruta como llave (depósitos↔cobros)', () => {
  it('extrae la ruta de las formas de CAOS y de Kepler; null si no hay', () => {
    expect(rutaDe('rd28')).toBe(28);
    expect(rutaDe('ruta 21 09 26')).toBe(21);         // la ruta, no la fecha
    expect(rutaDe('r23')).toBe(23);
    expect(rutaDe('R.D. 28 PH Valadez')).toBe(28);    // norm "r d 28 ph"
    expect(rutaDe('VENTA RD 28 23-09-2026')).toBe(28);
    expect(rutaDe('RUTA 22')).toBe(22);
    expect(rutaDe('cueritos')).toBeNull();
    expect(rutaDe(null)).toBeNull();
  });
});

describe('puntuarCaos — el lado DEPÓSITO (ruta como llave)', () => {
  it('CS.3.6 — depósito ↔ cobro por RUTA + FECHA DE NEGOCIO + depósito≤cobro = confianza ALTA', () => {
    // Caso REAL medido (ruta 21): la venta del 19-09 se registra/deposita el 24, y el depósito es
    // PARTE del cobro (16,640 ≤ 19,026). La llave es ruta + fecha de negocio (del texto), no la de registro.
    const g: GastoCtx = { monto: 19026, fecha: '2026-09-24', beneficiario: 'R.D. 21 PH Urbano', concepto: 'VENTA RD 21 19-09-2026' };
    const dep = cand({ type_label: 'Deposito', ref: 'rd21 19/09', monto: 16640, fecha_valor: '2026-09-24', denominaciones: [] });
    const r = puntuarCaos(g, dep);
    expect(r.motivos).toContain('ruta 21');
    expect(r.motivos).toContain('fecha 19-09');
    expect(r.motivos).toContain('parte del arqueo');
    expect(r.confianza).toBe('alta');   // 45 ruta + 40 fecha + 15 parte + 12 registro = 112
  });

  it('fechaNegocio saca la fecha de negocio de ambos formatos y descarta la ruta', () => {
    expect(fechaNegocio('VENTA RD 21 19-09-2026')).toBe('19-09');
    expect(fechaNegocio('rd21 19/09')).toBe('19-09');
    expect(fechaNegocio('ruta 21 23 09 26')).toBe('23-09');   // 23-09, el 26 es año
    expect(fechaNegocio('ruta 21 09 26')).toBeNull();          // incompleto/ambiguo: no inventa
    expect(fechaNegocio('cueritos')).toBeNull();
  });

  it('[negativa] rutas DISTINTAS no dan el bono de ruta', () => {
    const g: GastoCtx = { monto: 14294, fecha: '2026-09-23', beneficiario: 'R.D. 21 PH Urbano', concepto: 'VENTA RD 21' };
    const dep = cand({ ref: 'rd28', monto: 99999, fecha_valor: '2026-09-23', denominaciones: [] });
    const r = puntuarCaos(g, dep);
    expect(r.motivos.some((m) => m.startsWith('ruta'))).toBe(false);
  });
});

describe('rankearCaos', () => {
  it('ordena por score y descarta los negativos', () => {
    const g: GastoCtx = { monto: 20000, fecha: '2026-09-24', beneficiario: 'CUERITOS LUPITA' };
    const lista = [
      cand({ external_id: 1, ref: 'cueritos', fecha_valor: '2026-09-24', monto: 20000 }),  // fuerte
      cand({ external_id: 2, ref: 'nomina', fecha_valor: '2026-07-01', monto: 999999 }),    // lejano + mayor => negativo
      cand({ external_id: 3, ref: 'zzz', fecha_valor: '2026-09-25', monto: 5000 }),         // ±1 + parcial
    ];
    const r = rankearCaos(g, lista);
    expect(r[0].external_id).toBe(1);                       // el más fuerte primero
    expect(r.some((c) => c.external_id === 2)).toBe(false); // el negativo se descarta
  });
});

/**
 * CS.3.7 — LO QUE EDGAR REPORTÓ, CONVERTIDO EN CANDADO.
 *
 * *"en el pago de nomina 41 se enlazó con un egreso de caos de la semana 40. la vinculación de
 * egresos con caos no está funcionando adecuadamente"*.
 *
 * Reproducido contra prod el 2026-10-12 con los datos reales de la bandeja, no con un ejemplo
 * inventado. Y el caso no era único: de las 207 propuestas vivas ese día,
 *
 *   · **40.1% estaban a más de 7 días** del gasto, con el motor documentando una ventana de ±7;
 *   · **sólo el 1.9% tenía el monto exacto** — el resto se apoyaba en «parte del arqueo», que se
 *     cumple con que el retiro sea menor que el gasto (un retiro de $500 contra $26,136 lo cumple);
 *   · **67 de las 122** donde los dos lados declaraban su fecha de negocio **se contradecían**, y
 *     salían igual como propuesta.
 *
 * ⚠️ Las 18 pruebas que ya existían pasaban todas. Probaban que la señal medida SUMA; ninguna
 * probaba que la ausencia de señal FRENE. Un motor que sólo sabe sumar siempre encuentra algo.
 */
describe('CS.3.7 — una palabra no identifica CUÁL', () => {
  it('⛔ el caso real: nómina de la semana 41 NO se lleva el retiro «nomina 40»', () => {
    // Datos exactos de prod: gasto X-D-26 0023009 (09-oct) y retiro CAOS 1497 (02-oct).
    const g: GastoCtx = { monto: 13651, fecha: '2026-10-09', beneficiario: 'NOMINA', concepto: '' };
    const c = cand({ external_id: 1497, ref: 'nomina 40', monto: 7000, fecha_valor: '2026-10-02' });
    const r = puntuarCaos(g, c);
    // Sigue puntuando (el concepto coincide de verdad), pero NO se propone solo.
    expect(r.confianza).toBe('baja');
    expect(r.motivos).toContain('no identifica cual: solo coincide el concepto');
  });

  it('⭐ [positiva] el mismo gasto SÍ se lleva el retiro del mismo día', () => {
    // Sin esto, un freno que rechazara todo también pasaría la prueba de arriba y dejaría la
    // función inservible sin que nada avise.
    const g: GastoCtx = { monto: 13651, fecha: '2026-10-09', beneficiario: 'NOMINA', concepto: '' };
    const c = cand({ external_id: 1555, ref: 'nomina', monto: 13651, fecha_valor: '2026-10-09' });
    const r = puntuarCaos(g, c);
    expect(r.confianza).not.toBe('baja');
  });

  it('⛔ dos fechas de negocio que se CONTRADICEN descalifican, no son indiferentes', () => {
    // Caso real de prod: el cobro dice 26-09 y el depósito dice 08-10. Antes salía 'media' por
    // «ruta 23 + parte del arqueo» — la llave decisiva decía que no y no restaba nada.
    const g: GastoCtx = { monto: 16226, fecha: '2026-09-29', beneficiario: 'R.D. 23 PH Hurtado', concepto: 'VENTA RD 23 26-09-2026' };
    const c = cand({ ref: 'r23 08 10 26', monto: 15430, fecha_valor: '2026-10-08', denominaciones: [] });
    const r = puntuarCaos(g, c);
    expect(r.confianza).toBe('baja');
    expect(r.motivos.some((m) => m.startsWith('la fecha no cuadra'))).toBe(true);
  });

  it('⭐ [positiva] la ruta con fecha de negocio que COINCIDE sigue siendo la señal fuerte', () => {
    // Es el caso que el motor midió al 98% y que esta corrección NO debe tocar: el cobro y el
    // depósito pueden registrarse con días de diferencia si su fecha de negocio es la misma.
    const g: GastoCtx = { monto: 21105, fecha: '2026-10-07', beneficiario: 'R.D. 21 PH Urbano', concepto: 'VENTA RD 21 01-10-2026' };
    const c = cand({ ref: 'ruta 21 01 10 26', monto: 20050, fecha_valor: '2026-10-01', denominaciones: [] });
    const r = puntuarCaos(g, c);
    expect(r.confianza).toBe('alta');
    expect(r.motivos).toContain('fecha 01-10');
  });

  it('⛔ la RUTA sola no alcanza: «rd 26» sale todos los días, es tan recurrente como «nomina»', () => {
    const g: GastoCtx = { monto: 24243, fecha: '2026-09-30', beneficiario: 'R.D. 26 PH García', concepto: '' };
    const c = cand({ ref: 'rd 26', monto: 17950, fecha_valor: '2026-09-10', denominaciones: [] });
    expect(puntuarCaos(g, c).confianza).toBe('baja');
  });

  it('⭐ [positiva] el monto EXACTO identifica la instancia aunque esté lejos', () => {
    const g: GastoCtx = { monto: 5200, fecha: '2026-09-29', beneficiario: 'OCOTE ACHONES', concepto: '' };
    const c = cand({ ref: 'rem ocote', monto: 5200, fecha_valor: '2026-08-26', denominaciones: [] });
    expect(puntuarCaos(g, c).confianza).not.toBe('baja');
  });

  it('⛔ «parte del arqueo» sola no propone: $500 no identifican un gasto de $26,136', () => {
    const g: GastoCtx = { monto: 26136, fecha: '2026-10-08', beneficiario: 'ROMPOPE SANTA SOFIA', concepto: '' };
    const c = cand({ ref: 'rompope', monto: 500, fecha_valor: '2026-08-20', denominaciones: [] });
    expect(puntuarCaos(g, c).confianza).toBe('baja');
  });
});
