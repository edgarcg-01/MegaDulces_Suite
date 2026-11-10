import { compararContraElLibro, type RenglonComparable } from './contra-el-libro';

// Importes inventados (el repo es público). Cuenta que abre en 1,000.00.
let n = 0;
const r = (fecha: string, ent: number, sal: number, saldo: number | null, concepto = ''): RenglonComparable =>
  ({ id: `r${++n}`, fecha, amount_in: ent, amount_out: sal, running_balance: saldo, concepto });

const BANCO = [
  r('2026-10-01', 500, 0, 1500), r('2026-10-01', 0, 200, 1300),
  r('2026-10-02', 0, 3.51, 1296.49), r('2026-10-02', 0, 0.56, 1295.93),
  r('2026-10-03', 100, 0, 1395.93), // último día: abierto
];

describe('[CB.60] compararContraElLibro', () => {
  it('el libro copiado del banco, en otro orden: los días cerrados cuadran y el último queda abierto', () => {
    const libro = [r('2026-10-01', 0, 200, 1300), r('2026-10-01', 500, 0, 1500), r('2026-10-02', 0, 0.56, 1295.93), r('2026-10-02', 0, 3.51, 1296.49)];
    const c = compararContraElLibro(BANCO, libro);
    expect(c.dias.map((d) => d.veredicto)).toEqual(['cuadra', 'cuadra', 'abierto']);
    expect(c.resumen).toMatchObject({ cuadra: 2, difiere: 0, abierto: 1, solo_banco: 0, solo_libro: 0 });
  });

  it('[negativa] un movimiento que el libro no tiene: el día difiere y lo nombra', () => {
    // El libro llega al 03: el 02 ya no es su último día (si lo fuera, quedaría «a medias», abajo).
    const libro = [r('2026-10-01', 500, 0, 1500), r('2026-10-01', 0, 200, 1300), r('2026-10-02', 0, 3.51, 1296.49), r('2026-10-03', 100, 0, 1396.49)];
    const d = compararContraElLibro(BANCO, libro).dias[1];
    expect(d.veredicto).toBe('difiere');
    expect(d.solo_banco).toEqual([expect.objectContaining({ lado: 'sale', importe: 0.56 })]);
  });

  it('[negativa] mismos importes pero el saldo del libro no cierra igual: difiere', () => {
    const libro = [r('2026-10-01', 500, 0, 1500), r('2026-10-01', 0, 200, 1310)];
    expect(compararContraElLibro(BANCO, libro).dias[0].veredicto).toBe('difiere');
  });

  it('[negativa] un renglón de más en el libro: difiere y lo nombra del lado del libro', () => {
    const libro = [r('2026-10-01', 500, 0, 1500), r('2026-10-01', 0, 200, 1300), r('2026-10-01', 0, 50, 1250)];
    const d = compararContraElLibro(BANCO, libro).dias[0];
    expect(d.veredicto).toBe('difiere');
    expect(d.solo_libro.map((x) => x.importe)).toEqual([50]);
  });

  it('el libro lo anotó otro día (±3): cuenta como pareado, declarado como fecha distinta', () => {
    const libro = [r('2026-10-01', 500, 0, 1500), r('2026-10-03', 0, 200, null)];
    const d = compararContraElLibro(BANCO, libro).dias[0];
    expect(d.solo_banco).toEqual([]);
    expect(d.fecha_distinta).toBe(1);
    expect(d.veredicto).toBe('difiere'); // el saldo del día ya no puede cerrar igual
  });

  it('el libro no llega a ese día: sin libro, no difiere', () => {
    const c = compararContraElLibro(BANCO, [r('2026-10-01', 500, 0, 1500), r('2026-10-01', 0, 200, 1300)]);
    expect(c.dias.map((d) => d.veredicto)).toEqual(['cuadra', 'sin_libro', 'abierto']);
  });

  describe('el libro subido antes de cerrar su último día', () => {
    // Banco: 01, 02 (dos movimientos) y 03 (abierto). El libro llega al 02 con UNO de los dos.
    const libroHasta02 = () => [r('2026-10-01', 500, 0, 1500), r('2026-10-01', 0, 200, 1300), r('2026-10-02', 0, 3.51, 1296.49)];

    it('su último día con renglones de menos no cuenta en contra: sin libro, declarado a medias', () => {
      const d = compararContraElLibro(BANCO, libroHasta02()).dias[1];
      expect(d).toMatchObject({ veredicto: 'sin_libro', libro_a_medias: true });
      expect(d.solo_banco.map((x) => x.importe)).toEqual([0.56]);
    });

    it('[negativa] si el libro ya tiene un día posterior, ese mismo faltante SÍ difiere', () => {
      const d = compararContraElLibro(BANCO, [...libroHasta02(), r('2026-10-03', 100, 0, 1396.49)]).dias[1];
      expect(d).toMatchObject({ veredicto: 'difiere', libro_a_medias: false });
    });

    it('[negativa] un renglón que el banco no tiene, aun en el último día del libro, difiere', () => {
      const d = compararContraElLibro(BANCO, [...libroHasta02(), r('2026-10-02', 0, 9, 1287.49)]).dias[1];
      expect(d.veredicto).toBe('difiere');
    });

    it('una fecha absurda del libro (año mal capturado) no lo hace parecer al día', () => {
      const d = compararContraElLibro(BANCO, [...libroHasta02(), r('2027-08-06', 1, 0, 1)]).dias[1];
      expect(d.libro_a_medias).toBe(true);
    });
  });

  it('un renglón del banco en $0.00 (comisión exenta de BanBajío) no se compara ni rompe el cierre; se declara', () => {
    const banco = [...BANCO.slice(0, 2), r('2026-10-01', 0, 0, 1300, 'Comisión por Transferencia - Envío'), BANCO[4]];
    const libro = [r('2026-10-01', 500, 0, 1500), r('2026-10-01', 0, 200, 1300), r('2026-10-03', 100, 0, 1400)];
    const c = compararContraElLibro(banco, libro);
    expect(c.dias[0]).toMatchObject({ veredicto: 'cuadra', solo_banco: [] });
    expect(c.renglones_en_cero).toBe(1);
  });

  describe('cierre que no se puede afirmar (el banco asienta fuera de orden)', () => {
    // Un cargo fechado el 02 cuyo saldo viene ANTES que el resto del día: dos «finales» en la cadena.
    const banco = [
      r('2026-10-02', 0, 100, 900), r('2026-10-02', 50, 0, 1050), r('2026-10-02', 0, 30, 1020),
      r('2026-10-03', 10, 0, 1030),
    ];

    it('todo casa y TODOS los saldos son los mismos: cuadra, declarado «por saldos»', () => {
      const libro = [r('2026-10-02', 0, 30, 1020), r('2026-10-02', 0, 100, 900), r('2026-10-02', 50, 0, 1050)];
      const d = compararContraElLibro(banco, libro).dias[0];
      expect(d.cierre_banco).toBeNull();
      expect(d).toMatchObject({ veredicto: 'cuadra', cuadre_por: 'saldos' });
    });

    it('[negativa] los mismos importes con un saldo distinto en el libro: difiere', () => {
      const libro = [r('2026-10-02', 0, 30, 1020), r('2026-10-02', 0, 100, 901), r('2026-10-02', 50, 0, 1050)];
      expect(compararContraElLibro(banco, libro).dias[0]).toMatchObject({ veredicto: 'difiere', cuadre_por: null });
    });

    it('con cierre afirmable se sigue juzgando por el cierre', () => {
      const libro = [r('2026-10-01', 500, 0, 1500), r('2026-10-01', 0, 200, 1300)];
      expect(compararContraElLibro(BANCO, libro).dias[0]).toMatchObject({ veredicto: 'cuadra', cuadre_por: 'cierre' });
    });
  });

  describe('[CB.61] sucursal sin el libro', () => {
    // Cuatro días de la misma terminal: el 01 y el 02 enseñan (se cree a partir de 2 vistas), el 03 y el 04 se deducen.
    const venta = (fecha: string, saldo: number) => ({ ...r(fecha, 100, 0, saldo, 'VENTAS DEBITO/100000001 TERMINALES PUNTO DE VENTA') });
    const conS = (x: RenglonComparable, sucursal: string | null) => ({ ...x, sucursal });

    it('deduce con lo aprendido de días ANTERIORES y lo compara con la S del libro', () => {
      const banco = [venta('2026-10-01', 1100), venta('2026-10-02', 1200), venta('2026-10-03', 1300), venta('2026-10-04', 1400)];
      const libro = [conS(venta('2026-10-01', 1100), '40'), conS(venta('2026-10-02', 1200), '40'), conS(venta('2026-10-03', 1300), '40'), conS(venta('2026-10-04', 1400), '42')];
      const s = compararContraElLibro(banco, libro).sucursales;
      // 01 y 02: aún no hay 2 vistas → sin señal · 03: coincide · 04: la terminal dice 40 y el libro 42 → distinta
      expect(s).toMatchObject({ con_sucursal_libro: 4, deducidas: 2, coinciden: 1, sin_senal: 2 });
      expect(s.distintas).toEqual([expect.objectContaining({ fecha: '2026-10-04', banco: '40', por: 'terminal', libro: '42' })]);
    });

    it('[negativa] no aprende del mismo día: un día solo nunca se confirma a sí mismo', () => {
      const banco = [venta('2026-10-01', 1100), venta('2026-10-01', 1200)];
      const libro = [conS(venta('2026-10-01', 1100), '40'), conS(venta('2026-10-01', 1200), '40')];
      expect(compararContraElLibro(banco, libro).sucursales).toMatchObject({ con_sucursal_libro: 2, deducidas: 0, sin_senal: 2 });
    });
  });

  describe('[CB.61] categoría sin el libro', () => {
    const conCat = (x: RenglonComparable, categoria: string | null, doc_tipo: string | null = null) => ({ ...x, categoria, doc_tipo });
    // Sombra de prueba: depósito = cobranza; retiro de 3.51 = comisión; con documento N-A-26 = traspaso.
    const sombra = (b: RenglonComparable, par: RenglonComparable) => ({
      categoria: par.doc_tipo === 'N-A-26' ? 'traspaso_entre_cuentas' : Number(b.amount_in) > 0 ? 'cobranza' : Number(b.amount_out) === 3.51 ? 'comision_bancaria' : 'sin_clasificar',
      por: par.doc_tipo ? 'documento' : 'banco',
    });

    it('cuenta cada par, también el del día abierto, y nombra los que difieren con las dos categorías', () => {
      const libro = [
        conCat(r('2026-10-01', 500, 0, 1500), 'cobranza'), conCat(r('2026-10-01', 0, 200, 1300), 'nomina', 'N-A-26'),
        conCat(r('2026-10-02', 0, 3.51, 1296.49), 'comision_bancaria'), conCat(r('2026-10-02', 0, 0.56, 1295.93), 'iva_acreditable'),
        conCat(r('2026-10-03', 100, 0, 1395.93), null),
      ];
      const k = compararContraElLibro(BANCO, libro, sombra).categorias;
      expect(k).toMatchObject({ pareados: 5, coinciden: 2, difieren: 1, sin_categoria: 1, libro_sin_categoria: 1 });
      expect(k.distintas).toEqual([
        expect.objectContaining({ importe: 200, banco: 'traspaso_entre_cuentas', por: 'documento', libro: 'nomina' }),
        expect.objectContaining({ importe: 0.56, banco: 'sin_clasificar', libro: 'iva_acreditable' }),
      ]);
    });

    it('[negativa] la sombra NO lee la categoría del libro: un libro con otra categoría sale como distinto', () => {
      const libro = [conCat(r('2026-10-01', 500, 0, 1500), 'devolucion_spei')];
      expect(compararContraElLibro(BANCO, libro, sombra).categorias).toMatchObject({ pareados: 1, coinciden: 0, difieren: 1 });
    });

    it('sin clasificador no se juzga la categoría (cero pares, no «todo coincide»)', () => {
      expect(compararContraElLibro(BANCO, [conCat(r('2026-10-01', 500, 0, 1500), 'cobranza')]).categorias.pareados).toBe(0);
    });
  });
});
