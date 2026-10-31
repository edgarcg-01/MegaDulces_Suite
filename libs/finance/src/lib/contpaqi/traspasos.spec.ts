import { asientoCuadra } from './poliza-egreso';
import {
  armarTraspasosDelMes, contraparteDelConcepto, cuentasQueNombra, emparejarTraspasos, fechaDelEstado, ultimoDiaDelMes,
  type CuentaTraspaso, type PiernaTraspaso,
} from './traspasos';

/**
 * `[CP.8.92]` Candado del armador de traspasos. Puro: sin base, sin Nest.
 *
 * ⭐ El primer caso es el CONTROL POSITIVO: un traspaso limpio, con las dos piernas nombrándose, sale en UNA póliza
 * de Diario con la forma medida en sus pólizas. Sin él, un armador que no armara nada pasaría cada rechazo de abajo.
 * Las cuentas y números son de mentira (el repo es público).
 */
const CUENTAS: CuentaTraspaso[] = [
  { id: 'a', contpaqi: '1020010000', alias: 'BBVA 1111', etiqueta: '1111', nombre_contpaqi: 'BBVA CTA 0099991111' },
  { id: 'b', contpaqi: '1020020000', alias: 'BB 222', etiqueta: '222', nombre_contpaqi: 'BANCO BAJIO 0123456780222' },
  { id: 'c', contpaqi: '1020030000', alias: 'BTE 3330', etiqueta: '3330', nombre_contpaqi: 'BANORTE 9988773330' },
  { id: 'd', contpaqi: '1020040000', alias: 'STDR 4444', etiqueta: '4444', nombre_contpaqi: 'SANTANDER 5544444' },
  { id: 'x', contpaqi: null, alias: 'CAJA X', etiqueta: '5555', nombre_contpaqi: null },
];
let n = 0;
const sale = (cuenta_id: string, importe: number, fecha: string, concepto: string | null): PiernaTraspaso =>
  ({ id: `p${String(++n).padStart(3, '0')}`, fecha, cuenta_id, concepto, entra: 0, sale: importe });
const entra = (cuenta_id: string, importe: number, fecha: string, concepto: string | null): PiernaTraspaso =>
  ({ id: `p${String(++n).padStart(3, '0')}`, fecha, cuenta_id, concepto, entra: importe, sale: 0 });

describe('traspasos — el armado (CP.8.92)', () => {
  it('CONTROL: un traspaso limpio sale en UNA póliza de Diario, como las de ella', () => {
    const r = armarTraspasosDelMes('2026-09', [
      sale('a', 50000, '2026-09-01', 'TRASPASO A BB 222'),
      entra('b', 50000, '2026-09-01', 'TRASPASO ENTRE CTAS 1111'),
    ], CUENTAS);
    expect(r.sinArmar).toEqual([]);
    expect(r.polizas).toHaveLength(1);
    const p = r.polizas[0];
    expect(p.cuenta_origen).toBe('1020010000');
    expect(p.asiento).toEqual({
      tipo_poliza: 3, fecha: '2026-09-30', concepto: 'TRASPASOS ENTRE CUENTAS BBVA 1111', total: 50000,
      movimientos: [
        { cuenta: '1020020000', abono: false, importe: 50000, concepto: '', seg_negocio: 0 },
        { cuenta: '1020010000', abono: true, importe: 50000, concepto: '', seg_negocio: 0 },
      ],
    });
    expect(asientoCuadra(p.asiento)).toBe(true);
    expect(p.traspasos[0].evidencia).toBe(2);
  });

  it('una póliza por cuenta de ORIGEN: primero los cargos a las destino, después los abonos a la origen', () => {
    const r = armarTraspasosDelMes('2026-09', [
      sale('a', 100, '2026-09-02', 'TRASPASO A 222'), entra('b', 100, '2026-09-02', 'DE 1111'),
      sale('a', 200, '2026-09-03', 'TRASPASO A 3330'), entra('c', 200, '2026-09-03', 'DE 1111'),
      sale('b', 300, '2026-09-04', 'TRASPASO A 4444'), entra('d', 300, '2026-09-04', 'DE 222'),
    ], CUENTAS);
    expect(r.polizas.map((p) => p.cuenta_origen)).toEqual(['1020010000', '1020020000']);
    const a = r.polizas[0].asiento;
    expect(a.movimientos.map((m) => `${m.abono ? 'A' : 'C'} ${m.cuenta} ${m.importe}`)).toEqual([
      'C 1020020000 100', 'C 1020030000 200', 'A 1020010000 100', 'A 1020010000 200',
    ]);
    expect(a.total).toBe(300);
    expect(r.polizas[1].asiento.concepto).toBe('TRASPASOS ENTRE CUENTAS BB 222');
    for (const p of r.polizas) expect(asientoCuadra(p.asiento)).toBe(true);
  });

  it('el concepto nombra por la etiqueta, por la etiqueta truncada o por el final del número completo', () => {
    expect(contraparteDelConcepto('TRASPASO A BBVA 1111')).toBe('1111');
    expect(contraparteDelConcepto(' TRASPASO ENTRE CTAS 333 ')).toBe('333');
    expect(contraparteDelConcepto('TRASPASO ENTRE CUENTAS')).toBeNull();
    expect(contraparteDelConcepto(null)).toBeNull();
    expect([...cuentasQueNombra('1111', CUENTAS)]).toEqual(['a']);
    expect([...cuentasQueNombra('333', CUENTAS)]).toEqual(['c']); // «3330» truncada por el banco
    expect([...cuentasQueNombra('0222', CUENTAS)]).toEqual(['b']); // el final del número completo
    expect(cuentasQueNombra('9876', CUENTAS).size).toBe(0); // una referencia o una cuenta de fuera: no informa
  });

  it('⛔ un concepto que nombra OTRA cuenta descarta al candidato aunque el importe y el día coincidan', () => {
    const r = emparejarTraspasos([
      sale('a', 70000, '2026-09-05', 'TRASPASO A STDR 4444'),
      entra('b', 70000, '2026-09-05', null),
    ], CUENTAS);
    expect(r.traspasos).toEqual([]);
    expect(r.sinArmar.map((x) => x.motivo).sort()).toEqual(['entrada_sin_salida', 'salida_sin_entrada']);
  });

  it('una cita que no es de la Suite no informa: se empareja por importe y día, y lo dice', () => {
    const r = emparejarTraspasos([
      sale('a', 80000, '2026-09-05', 'TRASPASO REF 9876'),
      entra('b', 80000, '2026-09-05', null),
      sale('c', 1234, '2026-09-05', 'TRASPASO A 7777'),
    ], CUENTAS);
    expect(r.traspasos).toHaveLength(1);
    expect(r.traspasos[0].evidencia).toBe(0);
    const solo = r.sinArmar.find((x) => x.motivo === 'salida_sin_entrada');
    expect(solo?.detalle).toMatch(/«7777», que no es una cuenta de la Suite/);
  });

  it('a igual rango gana la evidencia: la entrada que nombra a la salida se queda con ella', () => {
    const r = emparejarTraspasos([
      sale('a', 5000, '2026-09-08', 'TRASPASO ENTRE CUENTAS'),
      entra('d', 5000, '2026-09-08', null),
      entra('b', 5000, '2026-09-08', 'TRASPASO DE 1111'),
    ], CUENTAS);
    expect(r.traspasos).toHaveLength(1);
    expect(r.traspasos[0].entrada.cuenta_id).toBe('b');
    expect(r.sinArmar.map((x) => x.motivo)).toEqual(['entrada_sin_salida']);
  });

  it('⛔ un empate que cambia la póliza se declara ambigua — y la pareja que «queda» también', () => {
    // Dos salidas (a, c) y dos entradas (b, d), mismo importe y día, sin conceptos: a→b,c→d o a→d,c→b dan pólizas distintas.
    const r = emparejarTraspasos([
      sale('a', 9000, '2026-09-10', null), sale('c', 9000, '2026-09-10', null),
      entra('b', 9000, '2026-09-10', null), entra('d', 9000, '2026-09-10', null),
    ], CUENTAS);
    expect(r.traspasos).toEqual([]);
    expect(r.sinArmar.map((x) => x.motivo)).toEqual(['ambigua', 'ambigua', 'ambigua', 'ambigua']);
  });

  it('un empate que NO cambia la póliza (las dos entradas en la misma cuenta) no es ambigüedad', () => {
    const r = emparejarTraspasos([
      sale('a', 9000, '2026-09-10', null), sale('a', 9000, '2026-09-10', null),
      entra('b', 9000, '2026-09-10', null), entra('b', 9000, '2026-09-10', null),
    ], CUENTAS);
    expect(r.traspasos).toHaveLength(2);
    expect(r.sinArmar).toEqual([]);
  });

  it('la ventana: un día de diferencia empareja, dos no (salvo que se pida)', () => {
    const piernas = [sale('a', 300, '2026-09-11', 'A 222'), entra('b', 300, '2026-09-13', 'DE 1111')];
    expect(emparejarTraspasos(piernas, CUENTAS).traspasos).toHaveLength(0);
    expect(emparejarTraspasos(piernas, CUENTAS, 2).traspasos).toHaveLength(1);
    const unDia = [sale('a', 301, '2026-09-11', 'A 222'), entra('b', 301, '2026-09-12', 'DE 1111')];
    expect(emparejarTraspasos(unDia, CUENTAS).traspasos).toHaveLength(1);
  });

  it('el traspaso es del mes de su SALIDA: el mes siguiente no lo arma ni reporta su entrada', () => {
    const piernas = [sale('a', 400, '2026-01-31', 'A 222'), entra('b', 400, '2026-02-01', 'DE 1111')];
    const ene = armarTraspasosDelMes('2026-01', piernas, CUENTAS);
    const feb = armarTraspasosDelMes('2026-02', piernas, CUENTAS);
    expect(ene.polizas).toHaveLength(1);
    expect(ene.polizas[0].asiento.fecha).toBe('2026-01-31');
    expect(feb.polizas).toEqual([]);
    expect(feb.sinArmar).toEqual([]);
  });

  it('⛔ una cuenta sin su cuenta de ContPAQi: el traspaso no se arma y sus dos piernas lo dicen', () => {
    const r = armarTraspasosDelMes('2026-09', [sale('a', 500, '2026-09-15', 'A 5555'), entra('x', 500, '2026-09-15', 'DE 1111')], CUENTAS);
    expect(r.polizas).toEqual([]);
    expect(r.sinArmar.map((x) => [x.motivo, x.detalle])).toEqual([
      ['cuenta_sin_mapear', 'sin su cuenta de ContPAQi: la destino'],
      ['cuenta_sin_mapear', 'sin su cuenta de ContPAQi: la destino'],
    ]);
  });

  it('⛔ una pierna que entra y sale a la vez, o ninguna, no es una pierna', () => {
    const r = emparejarTraspasos([
      { id: 'z1', fecha: '2026-09-16', cuenta_id: 'a', concepto: null, entra: 10, sale: 10 },
      { id: 'z2', fecha: '2026-09-16', cuenta_id: 'a', concepto: null, entra: 0, sale: 0 },
    ], CUENTAS);
    expect(r.sinArmar.map((x) => x.motivo)).toEqual(['importe_invalido', 'importe_invalido']);
  });

  it('el orden de entrada no cambia el resultado', () => {
    const piernas = [
      sale('a', 100, '2026-09-02', 'A 222'), entra('b', 100, '2026-09-02', 'DE 1111'),
      sale('c', 100, '2026-09-02', 'A 4444'), entra('d', 100, '2026-09-02', 'DE 3330'),
      sale('a', 9000, '2026-09-10', null), sale('c', 9000, '2026-09-10', null),
      entra('b', 9000, '2026-09-10', null), entra('d', 9000, '2026-09-10', null),
    ];
    const uno = armarTraspasosDelMes('2026-09', piernas, CUENTAS);
    const otro = armarTraspasosDelMes('2026-09', [...piernas].reverse(), CUENTAS);
    expect(otro.polizas).toEqual(uno.polizas);
    expect([...otro.sinArmar].sort((x, y) => x.id.localeCompare(y.id))).toEqual([...uno.sinArmar].sort((x, y) => x.id.localeCompare(y.id)));
  });

  it('⛔ CP.8.93: una fecha basura del estado de cuenta no se usa, y se reporta en el mes de SU estado', () => {
    // Medido: el estado de agosto trae movimientos fechados en 2027. Sin la regla, la pierna desaparecía sin decirse.
    const r = armarTraspasosDelMes('2026-08', [
      { ...sale('a', 600, '2027-08-06', 'A 222'), periodo: '2026-08' },
      { ...entra('b', 600, '2026-08-06', 'DE 1111'), periodo: '2026-08' },
    ], CUENTAS);
    expect(r.polizas).toEqual([]);
    expect(r.sinArmar.map((x) => [x.motivo, x.mes])).toEqual([
      ['fecha_fuera_del_estado', '2026-08'],
      ['entrada_sin_salida', '2026-08'],
    ]);
    expect(r.sinArmar[0].detalle).toMatch(/fechada 2027-08-06 en el estado de cuenta de 2026-08/);
  });

  it('el último día del mes anterior en el estado siguiente NO es basura: así cortan algunos bancos', () => {
    const r = armarTraspasosDelMes('2026-05', [
      { ...sale('a', 700, '2026-05-30', 'A 222'), periodo: '2026-06' },
      { ...entra('b', 700, '2026-05-30', 'DE 1111'), periodo: '2026-05' },
    ], CUENTAS);
    expect(r.sinArmar).toEqual([]);
    expect(r.polizas).toHaveLength(1);
  });

  it('la tolerancia del estado de cuenta: 7 días a cada lado del mes', () => {
    expect(fechaDelEstado('2026-05-30', '2026-06')).toBe(true);
    expect(fechaDelEstado('2026-07-07', '2026-06')).toBe(true);
    expect(fechaDelEstado('2026-07-08', '2026-06')).toBe(false);
    expect(fechaDelEstado('2026-05-24', '2026-06')).toBe(false);
    expect(fechaDelEstado('0206-02-25', '2026-02')).toBe(false); // el año mal capturado
    expect(fechaDelEstado('2026-01-01', '2026-10')).toBe(false); // el caso de CP.8.93
  });

  it('el último día del mes, con febrero bisiesto', () => {
    expect(ultimoDiaDelMes('2026-02')).toBe('2026-02-28');
    expect(ultimoDiaDelMes('2024-02')).toBe('2024-02-29');
    expect(ultimoDiaDelMes('2026-12')).toBe('2026-12-31');
  });
});
