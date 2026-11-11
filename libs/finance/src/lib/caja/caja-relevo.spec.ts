/**
 * `[CGA-A.44]` — Pruebas de «qué ya saldó el Control» y de las fechas del relevo.
 *
 * Lo que importa probar es que la cola y el Cuadre casen IGUAL: si la cola diera por saldado algo
 * que el Cuadre no, ese documento desaparecería de las dos pantallas sin que nadie lo hubiera
 * capturado. Por eso las negativas.
 */
import {
  casadosPorControl, casadosPorControlConRezago, casadosPorControlDespues, diaAnterior, diaVecinalDeKepler, inicioDelMes,
  leeTextoDelControl, type ControlConTexto, type KeplerConLugar, type MovDelDia,
} from './caja-relevo';
import { CUADRE_TOLERANCIA_PESOS } from './caja-cuadre.engine';

const c = (key: string, importe: number, fecha: string, dir: 'in' | 'out' = 'in'): MovDelDia => ({ key, importe, fecha, dir });

describe('fechas del relevo', () => {
  it('inicio del mes y día anterior, también cruzando mes', () => {
    expect(inicioDelMes('2026-10-12')).toBe('2026-10-01');
    expect(diaAnterior('2026-10-12')).toBe('2026-10-11');
    expect(diaAnterior('2026-11-01')).toBe('2026-10-31');
  });
});

describe('casadosPorControl', () => {
  it('casa con el Control del MISMO día y dirección, dentro de la tolerancia', () => {
    // Caso real: 01-002 U-A-5 0000003 $26,536.61 contra «Ventas Canindo 03/10 RD502» $26,536.50.
    const s = casadosPorControl(
      [c('1|23360', 26536.5, '2026-10-07')],
      [c('06-002|U-A-5|0000003|0011', 26536.61, '2026-10-07')],
    );
    expect([...s]).toEqual(['06-002|U-A-5|0000003|0011']);
  });

  it('NEGATIVA: el mismo importe OTRO día no se da por saldado (el Cuadre es por día)', () => {
    // Caso real: Morelia 07 U-A-5 0000009 $11,244.37 (05-oct) que el Control anotó el 07-oct.
    const s = casadosPorControl(
      [c('1|23381', 11244.37, '2026-10-07')],
      [c('07|U-A-5|0000009|0011', 11244.37, '2026-10-05')],
    );
    expect(s.size).toBe(0);
  });

  it('NEGATIVA: un ingreso del Control no salda un gasto de Kepler del mismo importe', () => {
    const s = casadosPorControl(
      [c('1|1', 10105, '2026-10-09', 'in')],
      [c('06|X-D-26|0000161|0011', 10105, '2026-10-09', 'out')],
    );
    expect(s.size).toBe(0);
  });

  it('NEGATIVA: fuera de la tolerancia del Cuadre no casa', () => {
    const s = casadosPorControl(
      [c('1|1', 1000, '2026-10-02')],
      [c('K|1', 1000 + CUADRE_TOLERANCIA_PESOS + 0.01, '2026-10-02')],
    );
    expect(s.size).toBe(0);
  });

  it('un renglón del Control salda UN solo documento aunque haya dos iguales', () => {
    const s = casadosPorControl(
      [c('1|1', 500, '2026-10-02')],
      [c('A|U-A-5|1|0011', 500, '2026-10-02'), c('B|U-A-5|1|0011', 500, '2026-10-02')],
    );
    expect(s.size).toBe(1);
  });
});

/**
 * `[CGA-A.73]` Lo que el Control anotó días después. Los casos son de prod (era Control, 1–11 oct);
 * cada negativa rompe UNA cosa que la regla dice que importa — las mismas que el control negativo
 * medido contra prod el 2026-11-11 (ruta vecina, lugar cambiado, día corrido, importe corrido: 0).
 */
describe('leeTextoDelControl', () => {
  it('lee la ruta y el día de la venta como los escribía el Control', () => {
    expect(leeTextoDelControl('Ventas Canindo 05/10 RD501', '2026-10-07')).toEqual({ ruta: '501', dia: '2026-10-05', morelia: false, vecinal: false });
    expect(leeTextoDelControl('Ventas PH 09/10RD 28', '2026-10-09').ruta).toBe('28');
    expect(leeTextoDelControl('Ventas RD 07/10 502', '2026-10-09').ruta).toBe('502');
    expect(leeTextoDelControl('ventas Rutas Morelia 01/10', '2026-10-07')).toMatchObject({ ruta: null, morelia: true, dia: '2026-10-01' });
    expect(leeTextoDelControl('Ventas RutaVecinal  02/10', '2026-10-06')).toMatchObject({ vecinal: true, dia: '2026-10-02' });
  });

  it('NEGATIVA: «RD 07/10» es el día, no la ruta 7', () => {
    expect(leeTextoDelControl('Ventas RD 07/10', '2026-10-09').ruta).toBeNull();
  });

  it('NEGATIVA: «RV15» de Morelia no es venta vecinal', () => {
    expect(leeTextoDelControl('Ventas Morelia RV15 06/10', '2026-10-08')).toMatchObject({ morelia: true, vecinal: false });
  });

  it('el día sin año que caería después del renglón es del año anterior', () => {
    expect(leeTextoDelControl('Ventas 30/12 RD22', '2027-01-03').dia).toBe('2026-12-30');
  });
});

describe('diaVecinalDeKepler', () => {
  it('saca el día del concepto de la venta vecinal', () => {
    expect(diaVecinalDeKepler('VENTAS 2-10-2026 RV CANDY Y DO')).toBe('2026-10-02');
    expect(diaVecinalDeKepler('VENTAS RV 6-10-2026')).toBe('2026-10-06');
  });
  it('NEGATIVA: un depósito que no es vecinal no tiene día de venta vecinal', () => {
    expect(diaVecinalDeKepler('DEPOSITO EFECTIVO CAJA GENERAL 2-10-2026')).toBeNull();
  });
});

describe('casadosPorControlDespues', () => {
  const ctl = (key: string, importe: number, fecha: string, texto: string): ControlConTexto => ({ key, importe, fecha, dir: 'in', texto });
  const kep = (key: string, importe: number, fecha: string, o: Partial<KeplerConLugar> = {}): KeplerConLugar =>
    ({ key, importe, fecha, dir: 'in', ruta: null, morelia: false, concepto: null, ...o });
  // Caso real: Canindo ruta 501, cobro del 06-oct; el Control lo anotó el 07 como venta del 05.
  const r501 = kep('06-001|U-A-5|0000004|0011', 17263.05, '2026-10-06', { ruta: '501' });
  const c501 = ctl('1|23355', 17263, '2026-10-07', 'Ventas Canindo 05/10 RD501');

  it('ruta: la misma ruta, la venta hasta 3 días antes y el Control de 0 a 4 días después', () => {
    expect([...casadosPorControlDespues([c501], [r501]).keys()]).toEqual([r501.key]);
  });

  it('NEGATIVA: la ruta vecina no casa aunque el importe sea igual', () => {
    expect(casadosPorControlDespues([ctl('1|1', 17263, '2026-10-07', 'Ventas Canindo 05/10 RD502')], [r501]).size).toBe(0);
  });

  it('NEGATIVA: el Control ANTES del documento no lo salda', () => {
    expect(casadosPorControlDespues([{ ...c501, fecha: '2026-10-05' }], [r501]).size).toBe(0);
  });

  it('NEGATIVA: más de 4 días después ya no es el mismo cobro', () => {
    expect(casadosPorControlDespues([{ ...c501, fecha: '2026-10-11' }], [r501]).size).toBe(0);
  });

  it('NEGATIVA: dos renglones posibles para el mismo cobro: no se decide', () => {
    expect(casadosPorControlDespues([c501, { ...c501, key: '1|99' }], [r501]).size).toBe(0);
  });

  it('NEGATIVA: sólo el importe (sin ruta en el texto) no basta', () => {
    expect(casadosPorControlDespues([ctl('1|23410', 20669.5, '2026-10-09', 'Ventas RD 07/10')],
      [kep('06-001|U-A-5|0000005|0011', 20669.55, '2026-10-08', { ruta: '501' })]).size).toBe(0);
  });

  it('Morelia: el depósito de una sucursal de Morelia y el Control dice «Morelia»', () => {
    const k = kep('07|U-A-5|0000009|0011', 11244.37, '2026-10-05', { morelia: true });
    expect(casadosPorControlDespues([ctl('1|23381', 11244.37, '2026-10-07', 'ventas Rutas Morelia 01/10')], [k]).size).toBe(1);
    // NEGATIVA: el mismo renglón sin «Morelia» no salda un depósito de Morelia.
    expect(casadosPorControlDespues([ctl('1|23381', 11244.37, '2026-10-07', 'ventas Rutas 01/10')], [k]).size).toBe(0);
  });

  it('vecinal: la venta del día, partida en DOS renglones del Control, salda el documento por la suma', () => {
    const k = kep('01|U-A-5|0000001|0011', 32095.01, '2026-10-02', { concepto: 'VENTAS 2-10-2026 RV CANDY Y DO' });
    const r = casadosPorControlDespues([
      ctl('1|23339', 25142, '2026-10-06', 'Ventas RV 02/10'),
      ctl('1|23340', 6953, '2026-10-06', 'Ventas RutaVecinal  02/10'),
    ], [k]);
    expect(r.get(k.key)).toEqual(['1|23339', '1|23340']);
  });

  it('NEGATIVA vecinal: los renglones de OTRO día de venta no suman', () => {
    const k = kep('01|U-A-5|0000001|0011', 32095.01, '2026-10-02', { concepto: 'VENTAS 2-10-2026 RV CANDY Y DO' });
    expect(casadosPorControlDespues([
      ctl('1|23339', 25142, '2026-10-06', 'Ventas RV 03/10'),
      ctl('1|23340', 6953, '2026-10-06', 'Ventas RutaVecinal  03/10'),
    ], [k]).size).toBe(0);
  });
});

describe('casadosPorControlConRezago', () => {
  const ctlRow = (mov_id: string, ingreso: number, fecha: string, nombre_cliente: string) => ({ tipo_dto: 1, mov_id, fecha, ingreso, gasto: 0, nombre_cliente, concepto: null });
  const cobro = (sucursal: string, folio: string, importe: number, fecha: string, truck: string) =>
    ({ sucursal, doc_tipo: 'U-A-5', folio, clave_banco: '0011', fecha, importe, signo: 1, concepto: null, truck });

  it('el MISMO día casa primero y ese renglón ya no sirve para otro cobro días después', () => {
    // Un solo renglón del Control del 07 y dos cobros de la ruta 501 (06 y 07) por el mismo importe.
    const r = casadosPorControlConRezago(
      [ctlRow('23355', 17263, '2026-10-07', 'Ventas Canindo 05/10 RD501')],
      [],
      [cobro('06-001', '0000004', 17263.05, '2026-10-06', 'ruta_501'), cobro('06-001', '0000005', 17263.05, '2026-10-07', 'ruta_501')],
    );
    expect([...r.llaves]).toEqual(['06-001|U-A-5|0000005|0011']);
    expect(r.despues).toBe(0);
  });

  it('lo suelto del mismo día lo toma la regla de días después', () => {
    const r = casadosPorControlConRezago(
      [ctlRow('23355', 17263, '2026-10-07', 'Ventas Canindo 05/10 RD501')],
      [],
      [cobro('06-001', '0000004', 17263.05, '2026-10-06', 'ruta_501')],
    );
    expect([...r.llaves]).toEqual(['06-001|U-A-5|0000004|0011']);
    expect(r.despues).toBe(1);
  });
});
