import { completaElConcepto, huellaDe, marcarYaCargados, repetidosEntreArchivos, type RenglonGuardado, type RenglonNuevo } from './renglones-repetidos';
import { cuadreDeLaDescarga } from './cuadre-de-la-descarga';

// Importes inventados (el repo es público), con la forma de BBVA: el depósito del 14 llega sin referencia y, en la
// descarga siguiente, con ella.
const h = (fecha: string, abono: number, saldo: number) => huellaDe({ fecha, cargo_centavos: 0, abono_centavos: abono * 100, saldo_centavos: saldo * 100 });
const G1: RenglonGuardado = { id: 'g1', line_key: 'k-sin-ref', huella: h('2026-11-14', 100, 1100), concept: 'DEPOSITO EN EFECTIVO/' };
const G2: RenglonGuardado = { id: 'g2', line_key: 'k-otro', huella: h('2026-11-14', 50, 1150), concept: 'VENTAS DEBITO/1' };

describe('[BFU.3.4] marcarYaCargados: el mismo renglón aunque el banco le cambie el concepto', () => {
  it('casa por llave y, lo que sobra, por huella; lo nuevo de verdad entra', () => {
    const nuevos: RenglonNuevo[] = [
      { llave: 'k-con-ref', huella: G1.huella, concepto: 'DEPOSITO EN EFECTIVO/0000001' },
      { llave: 'k-otro', huella: G2.huella, concepto: 'VENTAS DEBITO/1' },
      { llave: 'k-nuevo', huella: h('2026-11-15', 10, 1160), concepto: 'VENTAS DEBITO/2' },
    ];
    const m = marcarYaCargados(nuevos, [G1, G2]);
    expect(m.map((x) => x.existe)).toEqual([true, true, false]);
    expect(m[0].mismo_que?.id).toBe('g1');
    expect(m[1].mismo_que).toBeNull();
  });

  it('⛔ cuenta como multiconjunto: dos iguales en el archivo contra uno guardado → entra uno', () => {
    const dos: RenglonNuevo[] = [
      { llave: 'a', huella: G1.huella, concepto: 'X' },
      { llave: 'b', huella: G1.huella, concepto: 'Y' },
    ];
    expect(marcarYaCargados(dos, [G1]).map((x) => x.existe)).toEqual([true, false]);
  });

  it('[negativa] sin la huella (sólo la llave) el depósito con referencia entraba como nuevo: el defecto del 19-nov', () => {
    const conRef: RenglonNuevo = { llave: 'k-con-ref', huella: 'otra-huella', concepto: 'DEPOSITO EN EFECTIVO/0000001' };
    expect(marcarYaCargados([conRef], [G1])[0].existe).toBe(false);
  });
});

describe('[BFU.3.4] completaElConcepto', () => {
  it('sólo cuando el texto nuevo EXTIENDE al guardado', () => {
    expect(completaElConcepto('DEPOSITO EN EFECTIVO/', 'DEPOSITO EN EFECTIVO/0000001')).toBe(true);
    expect(completaElConcepto('deposito  en efectivo/', 'DEPOSITO EN EFECTIVO/0000001')).toBe(true);
    expect(completaElConcepto('DEPOSITO EN EFECTIVO/0000001', 'DEPOSITO EN EFECTIVO/')).toBe(false);
    expect(completaElConcepto('VENTAS DEBITO/1', 'COMISION/1')).toBe(false);
  });
});

describe('[BFU.3.4] repetidosEntreArchivos y el cuadre', () => {
  const linea = (archivo: string, abono: number, saldo: number) => ({ archivo, huella: h('2026-11-14', abono, saldo), importe_centavos: abono * 100 });

  it('dos iguales DENTRO de un archivo no son repetidos; entre dos archivos, sí', () => {
    expect(repetidosEntreArchivos([linea('A', 100, 1100), linea('A', 100, 1100)])).toEqual({ renglones: 0, importe: 0 });
    expect(repetidosEntreArchivos([linea('A', 100, 1100), linea('B', 100, 1100), linea('B', 50, 1150)])).toEqual({ renglones: 1, importe: 100 });
  });

  const archivo = (desde: string, hasta: string, abre: number, cierra: number, subido: string) => ({ desde, hasta, abre, cierra, subido });
  const saldo = (archivo: string, abono: number, s: number) => ({ fecha: '2026-11-14', saldo: s, archivo, abono, cargo: 0 });

  it('⛔ una cuenta con renglones repetidos entre archivos NO cuadra, y lo dice con su importe', () => {
    const archivos = [archivo('2026-11-14', '2026-11-14', 1000, 1100, '1'), archivo('2026-11-14', '2026-11-15', 1000, 1150, '2')];
    const q = cuadreDeLaDescarga(archivos, [saldo('a1', 100, 1100), saldo('a2', 100, 1100), saldo('a2', 50, 1150)], { fecha: '2026-11-13', saldo: 1000 }, '2026-11-20');
    expect(q.cuadra).toBe(false);
    expect(q.repetidos).toEqual({ renglones: 1, importe: 100 });
    expect(q.motivo).toContain('1 renglón(es) de la descarga están dos veces');
    // control: sin el repetido, la misma cuenta cuadra
    const ok = cuadreDeLaDescarga(archivos, [saldo('a1', 100, 1100), saldo('a2', 50, 1150)], { fecha: '2026-11-13', saldo: 1000 }, '2026-11-20');
    expect(ok.cuadra).toBe(true);
    expect(ok.repetidos).toEqual({ renglones: 0, importe: 0 });
  });

  it('sin importes por renglón no se mide: repetidos = null, no cero', () => {
    const q = cuadreDeLaDescarga([archivo('2026-11-14', '2026-11-14', 1000, 1100, '1')], [{ fecha: '2026-11-14', saldo: 1100 }], null, '2026-11-20');
    expect(q.repetidos).toBeNull();
  });
});
