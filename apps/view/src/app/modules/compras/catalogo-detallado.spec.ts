import type { FichaProducto } from './catalogo-productos.service';
import type { FlujoDetalle, LoteCaducidad, PlazaFlujo } from './productos-flujo.service';
import {
  GRUPOS_DETALLADO, OPCIONES_DETALLADO, cantidadCompuesta, celdaMes, comoVaLaVenta, comprasTexto, conteoDetallado, etiquetasTexto,
  factoresDe, loteTexto, margenReal, noMedibleDetallado, queHacer, sucursalesDetalladas,
} from './catalogo-detallado';

// Mazapán: base PAQ, caja de 20 PAQ.
const FACTORES = [{ unidad: 'PAQ', factorBase: 1 }, { unidad: 'CJA', factorBase: 20 }];
const PER = { hoy: '2026-10-26', mesIni: '2026-10-01', prevIni: '2026-09-01', prevFin: '2026-09-27', dias: 26 };

const FICHA = {
  unidadBase: 'PAQ',
  unidades: [
    { unidad: 'PAQ', equivale: null, factorBase: 1, precio: 84.5, mayoreo: null },
    { unidad: 'CJA', equivale: { cantidad: 20, unidad: 'PAQ' }, factorBase: 20, precio: null, mayoreo: null },
  ],
  sucursales: [
    { codigo: '01', nombre: 'PADRE HIDALGO', vendidoMes: { monto: 12000, unidadesBase: 142 }, existenciaBase: 1305 },
    { codigo: '04', nombre: 'YURECUARO', vendidoMes: { monto: 3000, unidadesBase: 35 }, existenciaBase: 0 },
    { codigo: '05', nombre: 'LA PIEDAD', vendidoMes: null, existenciaBase: 0 },
    { codigo: '06', nombre: 'CANINDO', vendidoMes: null, existenciaBase: null },
  ],
} as unknown as FichaProducto;

const plaza = (plaza: string, over: Partial<PlazaFlujo> = {}): PlazaFlujo => ({
  plaza, nombre: null, mes: 0, mes_anterior_mismo: 0, mes_anterior_total: 0, variacion: null, venta_dia: 0, unidades_dia: 0,
  ultima_venta: null, dias_sin_venta: null, existencia: null, existencia_duda: null, existencia_usada: null, cobertura_dias: null,
  estado: 'se_mueve', motivo: '', escalera: null, inmovilizado: null, ...over,
});

describe('Detallado › el menú «Mostrar»', () => {
  it('agrupado como la maqueta: qué hacer, para cuidar hoy y catálogo (los 4 de Sencillo + sin proveedor)', () => {
    expect(GRUPOS_DETALLADO.map((g) => g.titulo)).toEqual(['Qué hacer', 'Para cuidar hoy', 'Catálogo']);
    expect(OPCIONES_DETALLADO.map((o) => o.label)).toEqual([
      'Comprar', 'Mover entre sucursales', 'Esperar', 'Le sobra', 'No comprar',
      'Líderes con pendiente', 'No se venden', 'Por caducar o caducado', 'Productos nuevos',
      'Todos', 'Con varios códigos', 'Sin código de barras', 'Alguna unidad sin precio', 'Sin proveedor asignado',
    ]);
  });

  it('⛔ un conteo null dice «sin medir» y no se puede elegir; un 0 medido es 0 y sí', () => {
    const l = { conteos: { comprar: null, todos: 11008, sin_codigo: 0 } } as never;
    expect(conteoDetallado(l, 'comprar')).toBe('sin medir');
    expect(noMedibleDetallado(l, 'comprar')).toBe(true);
    expect(conteoDetallado(l, 'todos')).toBe('11,008');
    expect(conteoDetallado(l, 'sin_codigo')).toBe('0');
    expect(noMedibleDetallado(l, 'sin_codigo')).toBe(false);
    expect(conteoDetallado(null, 'todos')).toBe('');
  });
});

describe('Detallado › «Este mes» del renglón', () => {
  it('monto con la flecha y el % contra los mismos días; la explicación dice los días del mes anterior', () => {
    const c = celdaMes({ mes: 138483, mesAnterior: 261288, variacion: -0.47 }, PER);
    expect(c).toMatchObject({ texto: '$138,483', tipo: 'monto', variacion: { texto: '▼ 47%', tono: 'baja' } });
    expect(c.titulo).toBe('Contra los mismos días de septiembre (1 al 26): $261,288');
    expect(celdaMes({ mes: 100, mesAnterior: 50, variacion: 1 }, PER).variacion).toEqual({ texto: '▲ 100%', tono: 'sube' });
  });

  it('⛔ sin venta medida dice «Sin venta»; sin medir dice «Sin dato»; ninguno pinta $0', () => {
    expect(celdaMes({ mes: 0, mesAnterior: 0, variacion: null }, PER)).toMatchObject({ texto: 'Sin venta', tipo: 'sin_venta', variacion: null });
    expect(celdaMes({ mes: null, mesAnterior: null, variacion: null }, PER)).toMatchObject({ texto: 'Sin dato', tipo: 'sin_dato' });
  });
});

describe('Ficha detallada › cantidades compuestas', () => {
  it('en cajas y paquetes; cero o nada es null (quien pinta lo dice)', () => {
    expect(cantidadCompuesta(1305, FACTORES, 'PAQ')).toBe('65 CJA 5 PAQ');
    expect(cantidadCompuesta(0, FACTORES, 'PAQ')).toBeNull();
    expect(cantidadCompuesta(null, FACTORES, 'PAQ')).toBeNull();
    expect(cantidadCompuesta(7, [], 'PZA')).toBe('7 PZA');
  });

  it('Qué hacer: el veredicto del motor y los traspasos compuestos con los nombres legibles', () => {
    const q = queHacer({ resumen: { compra: {
      veredicto: 'traspasar', titulo: 'No comprar: mover entre sucursales', motivos: ['Sobra en Padre Hidalgo'], impacto: [],
      traspasos: [{ desde: '01', desde_nombre: 'PADRE HIDALGO', hacia: '04', hacia_nombre: null, cantidad: 45 }],
      cobertura_dias: 40, se_acaba: null, venta_en_riesgo_dia: 0, inmovilizado: null,
    } } } as unknown as FlujoDetalle, FACTORES, 'PAQ');
    expect(q).toMatchObject({ etiqueta: 'Mover entre sucursales', titulo: 'No comprar: mover entre sucursales', motivos: ['Sobra en Padre Hidalgo'] });
    expect(q.traspasos).toEqual([{ cantidad: '2 CJA 5 PAQ', desde: 'Padre Hidalgo', hacia: 'Sucursal 04' }]);
  });

  it('etiquetas de la ficha: las del renglón, en el mismo orden', () => {
    expect(etiquetasTexto({ lider: 4, nuevo: 'Nuevo · día 12', caducidad: 'pronto' }).map((e) => e.texto))
      .toEqual(['Líder #4', 'Nuevo · día 12', 'Caduca pronto']);
    expect(etiquetasTexto(null)).toEqual([]);
  });
});

describe('Ficha detallada › dónde se mueve y dónde se estancó', () => {
  it('⭐ vendido y existencia de la ficha (compuestos), «Sin vender» del motor; el CEDIS entra desde el motor', () => {
    const d = { criterio: { ventanaHistoria: 120 }, plazas: [
      plaza('01', { dias_sin_venta: 0 }), plaza('04', { dias_sin_venta: 3, estado: 'agotado' }),
      plaza('00', { nombre: 'CEDIS', mes: 5000, existencia: 400, dias_sin_venta: 1 }),
    ] } as unknown as FlujoDetalle;
    const xs = sucursalesDetalladas(FICHA, d);
    expect(xs.map((x) => x.codigo)).toEqual(['01', '04', '06', '00']);
    expect(xs[0]).toMatchObject({ nombre: 'Padre Hidalgo', monto: '$12,000', unidades: '7 CJA 2 PAQ', existencia: { tipo: 'cantidad', texto: '65 CJA 5 PAQ' }, sinVender: 'Hoy vendió' });
    expect(xs[1]).toMatchObject({ existencia: { tipo: 'agotado', texto: 'Agotado' }, sinVender: '3 días' });
    // [negativa] Canindo no se midió: se dice «Sin dato», no se esconde ni se pinta 0.
    expect(xs[2]).toMatchObject({ monto: null, vendidoMedido: false, existencia: { tipo: 'sin_dato' }, sinVender: 'Más de 120 días' });
    expect(xs[3]).toMatchObject({ nombre: 'Cedis', monto: '$5,000', existencia: { texto: '20 CJA' }, sinVender: '1 día' });
  });

  it('[negativa] una sucursal que ni vende ni tiene (y el motor no ve) no se lista: no lo maneja', () => {
    const xs = sucursalesDetalladas(FICHA, null);
    expect(xs.some((x) => x.codigo === '05')).toBe(false);
  });
});

describe('Ficha detallada › ¿cómo va la venta este mes?', () => {
  it('▲ vende más: la frase dice cuánto lleva y cuánto más; dos barras con su monto', () => {
    const c = comoVaLaVenta(15000, 12000, 0.25, PER);
    expect(c).toMatchObject({ tono: 'sube', flecha: '▲', titulo: 'Vende más que el mes pasado' });
    expect(c.frase).toBe('Del 1 al 26 lleva $15,000: $3,000 más que en los mismos días de septiembre.');
    expect(c.barras).toEqual([
      { etiqueta: 'Octubre (1 al 26)', monto: '$15,000', pct: 100, clase: 'act' },
      { etiqueta: 'Septiembre (1 al 26)', monto: '$12,000', pct: 80, clase: 'ant' },
    ]);
  });

  it('▼ vende menos, = vende igual con menos de 5 %, sin venta y empezó a venderse', () => {
    expect(comoVaLaVenta(9000, 12000, -0.25, PER)).toMatchObject({ tono: 'baja', titulo: 'Vende menos que el mes pasado',
      frase: 'Del 1 al 26 lleva $9,000: $3,000 menos que en los mismos días de septiembre.' });
    expect(comoVaLaVenta(12300, 12000, 0.03, PER)).toMatchObject({ tono: 'igual', flecha: '=', titulo: 'Vende igual que el mes pasado' });
    // [negativa] 5 % justos ya NO es «igual».
    expect(comoVaLaVenta(12600, 12000, 0.05, PER).tono).toBe('sube');
    expect(comoVaLaVenta(0, 0, null, PER)).toMatchObject({ tono: 'igual', titulo: 'Sin venta' });
    expect(comoVaLaVenta(500, 0, null, PER).titulo).toBe('Empezó a venderse');
    expect(comoVaLaVenta(0, 800, -1, PER).frase).toBe('Del 1 al 26 no se ha vendido; en los mismos días de septiembre llevaba $800.');
  });

  it('un 31 contra un mes de 30: la barra del mes anterior dice hasta el 30', () => {
    const c = comoVaLaVenta(1, 1, 0, { hoy: '2026-10-31', prevIni: '2026-09-01', prevFin: '2026-10-01' });
    expect(c.barras[1].etiqueta).toBe('Septiembre (1 al 30)');
  });
});

describe('Ficha detallada › margen, compras y lotes', () => {
  it('margen real con la venta sin impuestos; «el costo cubre» sólo bajo 99.5 %', () => {
    const t = (cob: number | null, pct: number | null = 13.6) => ({ total: { venta_neta: 10500, real: { pct, utilidad: 1, cobertura: cob, nota: null } } }) as never;
    expect(margenReal(t(0.82))).toMatchObject({ margen: '13.6%', venta: '$10,500', cubre: 'el costo cubre el 82 %' });
    expect(margenReal(t(0.996))?.cubre).toBeNull();
    expect(margenReal(t(1, null))?.margen).toBe('Sin medir');
    expect(margenReal({ total: null } as never)).toBeNull();
  });

  it('compras: lo comprado compuesto si todas sus unidades se conocen; si no, tal cual por unidad', () => {
    const c = { desde: '2026-07-29', dias: 90, entradas: 3, primera: '2026-08-02', costo_visible: true,
      comprado: [{ unidad: 'CJA', cantidad: 10 }, { unidad: 'PAQ', cantidad: 5 }],
      ultima: { fecha: '2026-10-21', sucursal: '01', nombreSucursal: 'PADRE HIDALGO', cantidad: 4, unidad: 'CJA', costo: 1250 } };
    expect(comprasTexto(c, FACTORES, 'PAQ')).toMatchObject({
      entradas: 3, comprado: '10 CJA 5 PAQ', primera: '2 ago', ultima: '21 oct · Padre Hidalgo', costoUltima: { monto: '$1,250.00', unidad: 'CJA' },
    });
    expect(comprasTexto({ ...c, comprado: [{ unidad: 'BTO', cantidad: 2 }] }, FACTORES, 'PAQ').comprado).toBe('2 BTO');
    // [negativa] sin permiso de costo el servidor manda null: no hay costo que pintar.
    expect(comprasTexto({ ...c, ultima: { ...c.ultima, costo: null } }, FACTORES, 'PAQ').costoUltima).toBeNull();
  });

  it('lotes: «Caducó … / hace N días» o «Caduca … / en N días», con lo registrado compuesto', () => {
    const l = (dias: number, caduca: string) => ({ plaza: '01', nombre: 'PADRE HIDALGO', lote: 'L1', caduca, dias, registrado: 45 }) as LoteCaducidad;
    expect(loteTexto(l(-21, '2026-10-05'), FACTORES, 'PAQ')).toMatchObject({ caduca: 'Caducó 5 oct', cuando: 'hace 21 días', tono: 'bad', cantidad: '2 CJA 5 PAQ' });
    expect(loteTexto(l(20, '2026-11-15'), FACTORES, 'PAQ')).toMatchObject({ caduca: 'Caduca 15 nov', cuando: 'en 20 días', tono: 'warn' });
    expect(loteTexto(l(90, '2027-01-24'), FACTORES, 'PAQ').tono).toBe('ok');
  });

  it('factores: de las unidades de la ficha (Number() a lo que llegue como texto)', () => {
    expect(factoresDe({ unidades: [{ unidad: 'CJA', factorBase: '20' as unknown as number }] } as never)).toEqual([{ unidad: 'CJA', factorBase: 20 }]);
    expect(factoresDe(null)).toEqual([]);
  });
});
