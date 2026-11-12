import { filasDetalle, filasIncentivo, filasRanking } from './mkt-ranking-pdf';
import { moverSemana, pct, textoSemana, IncentivoConResultado, ParticipanteRanking, RankingSemana } from './mkt-ranking.service';
import { armarFilas, bajaHasta, cambios, estadoPromo } from './pages/mkt-ranking-promos.component';
import { dtoDeForm } from './pages/mkt-incentivos.component';

const semana = { lunes: '2026-11-02', domingo: '2026-11-08', numero: 45, hasta: '2026-11-08', en_curso: false };

const part = (over: Partial<ParticipanteRanking>): ParticipanteRanking => ({
  clave: '01|', warehouse_code: '01', warehouse_name: 'Padre Hidalgo', vendor_code: '', nombre: 'Padre Hidalgo',
  lugar: 1, puntaje: 0.875, con_objetivo: 4, sin_objetivo: 1, cumplidas: 2, sin_venta: 1,
  promos: [
    { promo_id: 'a', code: '09066', mecanica: '3 leches = gratis 1', objetivo: 10, objetivo_fuente: 'fijo', venta: 26, cubrimiento: 1, existencia: 10, descripcion_distinta: false,
      productos: [{ sku: '99891', nombre: 'LECHE ENTERA 1L', unidades: 78, cajas: 6.5 }, { sku: '99893', nombre: 'LECHE DESLACTOSADA 1L', unidades: 5, cajas: null }],
      productos_metodo: 'ticket_y_nombre' as const, productos_nota: '' },
    { promo_id: 'b', code: '00229', mecanica: '2 exh Turín', objetivo: null, objetivo_fuente: null, venta: 9, cubrimiento: null, existencia: null, descripcion_distinta: true,
      productos: [], productos_metodo: 'sin_identificar' as const, productos_nota: '' },
  ],
  ...over,
});

describe('[MKT.11] textos de la semana', () => {
  it('«Semana 45 · 2 al 8 de nov»; si cruza de mes, los dos meses', () => {
    expect(textoSemana(semana)).toBe('Semana 45 · 2 al 8 nov');
    expect(textoSemana({ ...semana, lunes: '2026-10-26', domingo: '2026-11-01', numero: 44 })).toBe('Semana 44 · 26 oct al 1 nov');
    expect(textoSemana({ ...semana, en_curso: true })).toContain('(en curso)');
  });
  it('moverse de semana y el porcentaje; nulo es guion, no cero', () => {
    expect(moverSemana('2026-11-02', -1)).toBe('2026-10-26');
    expect(pct(0.875)).toBe('88 %');
    expect(pct(null)).toBe('—');
  });
});

describe('[MKT.12] filas del PDF', () => {
  it('⭐ el ranking: quien no tiene objetivos va sin lugar y lo dice (no «0 %»)', () => {
    const r = { participantes: [part({}), part({ nombre: 'Yurécuaro', lugar: null, puntaje: null, con_objetivo: 0, sin_objetivo: 3 })] } as RankingSemana;
    const f = filasRanking(r);
    expect(f[0]).toEqual(['1', 'Padre Hidalgo', '88 %', '2 de 4', '1', '1']);
    expect(f[1].slice(0, 3)).toEqual(['-', 'Yurécuaro', 'Sin objetivos']);
  });

  it('el detalle: sin objetivo se escribe; el código reutilizado se avisa; la existencia sólo en mostrador', () => {
    const d = filasDetalle(part({}), true);
    expect(d[0][0]).toBe('09066');
    expect(d[0].slice(2)).toEqual(['10', '26', '100 %', '10']);
    expect(d[1][1]).toContain('cambió de promoción en Kepler');
    expect(d[1][2]).toBe('Sin objetivo');
    expect(filasDetalle(part({}), false)[0]).toHaveLength(5);
  });

  it('[MKT.15] bajo cada promo, su producto con piezas y cajas; sin factor o sin producto, se DICE', () => {
    const d = filasDetalle(part({}), true);
    const lineas = d[0][1].split(String.fromCharCode(10));
    expect(lineas).toEqual([
      '3 leches = gratis 1',
      'LECHE ENTERA 1L (99891): 78 pz · 6.5 cj',
      'LECHE DESLACTOSADA 1L (99893): 5 pz · sin factor de caja',
    ]);
    expect(d[1][1]).toContain('Producto sin identificar');
  });

  it('el pago de un incentivo lleva su total y declara lo que no tiene factor', () => {
    const i = {
      total_semana: 62.5, total_acumulado: 112.5,
      resultados: [{ warehouse_code: '08', warehouse_name: 'Morelia Abastos', vendor_code: 'v', vendor_name: 'TLMKT DEMO', canal: 'mayoreo',
        semana_cantidad: 1.25, acumulado_cantidad: 2.25, acumulado_unidades: 2.25, acumulado_pago: 112.5, semana_pago: 62.5, sin_resolver: 3 }],
    } as unknown as IncentivoConResultado;
    const f = filasIncentivo(i);
    expect(f[0][3]).toContain('+3 sin factor');
    expect(f[f.length - 1][1]).toBe('Total');
    expect(f[f.length - 1][5]).toContain('112.50');
  });
});

describe('[MKT.11] objetivos de una promoción', () => {
  it('mostrador: una fila por sucursal aunque nadie haya vendido; con su sugerido y lo guardado', () => {
    const filas = armarFilas('mostrador', ['01', '02'],
      [{ warehouse_code: '01', canal: 'mostrador', vendor_code: '', objetivo_semanal: 12, fuente: 'manual' }],
      [{ promo_id: 'p', warehouse_code: '02', canal: 'mostrador', vendor_code: '', vendor_name: '', sugerido: 7, semanas_historia: 4 }]);
    expect(filas.map((f) => [f.nombre, f.guardado, f.sugerido, f.valor])).toEqual([['Padre Hidalgo', 12, null, 12], ['La Piedad Abastos', null, 7, null]]);
  });

  it('otros canales: sólo vendedores con historia u objetivo, con su nombre', () => {
    const filas = armarFilas('ruta', ['01'], [],
      [{ promo_id: 'p', warehouse_code: '01', canal: 'ruta', vendor_code: '01:R21', vendor_name: 'RUTA 21', sugerido: 3, semanas_historia: 2 }]);
    expect(filas).toHaveLength(1);
    expect(filas[0].nombre).toBe('RUTA 21');
  });

  it('⭐ sólo se manda lo que cambió; vaciar = quitar (no 0); [MKT.17] todo lo guardado es FIJO', () => {
    const base = armarFilas('mostrador', ['01', '02', '03'],
      [{ warehouse_code: '01', canal: 'mostrador', vendor_code: '', objetivo_semanal: 12, fuente: 'manual' }],
      [{ promo_id: 'p', warehouse_code: '02', canal: 'mostrador', vendor_code: '', vendor_name: '', sugerido: 7, semanas_historia: 4 }]);
    expect(cambios('mostrador', base)).toEqual([]);
    base[0].valor = null; // quitar el de Padre Hidalgo
    base[1].valor = 7;    // fijar el mismo número que el dinámico: queda fijo (ya no se recalcula)
    base[2].valor = 5;    // capturar a mano
    expect(cambios('mostrador', base)).toEqual([
      { warehouse_code: '01', canal: 'mostrador', vendor_code: '', objetivo_semanal: null, fuente: 'manual' },
      { warehouse_code: '02', canal: 'mostrador', vendor_code: '', objetivo_semanal: 7, fuente: 'manual' },
      { warehouse_code: '03', canal: 'mostrador', vendor_code: '', objetivo_semanal: 5, fuente: 'manual' },
    ]);
    // Sin escribir nada no se manda nada: la fila sin objetivo fijo sigue con el dinámico.
    const intacta = armarFilas('mostrador', ['02'], [], [{ promo_id: 'p', warehouse_code: '02', canal: 'mostrador', vendor_code: '', vendor_name: '', sugerido: 7, semanas_historia: 4 }]);
    expect(intacta[0].valor).toBeNull();
    expect(cambios('mostrador', intacta)).toEqual([]);
  });

  it('estado de la promo y dar de baja = terminar ayer', () => {
    expect(estadoPromo({ activo: true, vigencia_desde: '2026-10-01', vigencia_hasta: null }, '2026-11-11')).toBe('activa');
    expect(estadoPromo({ activo: true, vigencia_desde: '2026-10-01', vigencia_hasta: '2026-11-01' }, '2026-11-11')).toBe('vencida');
    expect(estadoPromo({ activo: true, vigencia_desde: '2026-12-01', vigencia_hasta: null }, '2026-11-11')).toBe('programada');
    expect(estadoPromo({ activo: false, vigencia_desde: '2026-10-01', vigencia_hasta: null }, '2026-11-11')).toBe('inactiva');
    expect(bajaHasta('2026-11-01')).toBe('2026-10-31');
  });
});

describe('[MKT.14] formulario de incentivo', () => {
  const ok = {
    id: null, nombre: 'Súper Sport', tipo: 'por_caja' as const, pago: 50, base_monto: null, completo: false,
    productos: [{ sku: '95304', nombre: 'CHOC SUPER SPORTS 1KG' }], desde: new Date(2026, 9, 19), hasta: null,
    canales: ['ruta' as const], sucursales: [] as string[],
  };

  it('arma la regla tal cual; todas las sucursales = sin filtro', () => {
    expect(dtoDeForm(ok)).toMatchObject({ tipo: 'por_caja', pago: 50, skus: ['95304'], vigencia_desde: '2026-10-19', redondeo: 'proporcional', warehouse_codes: null });
  });

  it('[negativas] dice en palabras qué falta', () => {
    expect(dtoDeForm({ ...ok, pago: 0 })).toBe('Indica cuánto se paga.');
    expect(dtoDeForm({ ...ok, tipo: 'por_monto' })).toBe('Indica cada cuántos pesos se paga.');
    expect(dtoDeForm({ ...ok, productos: [] })).toBe('Elige al menos un producto.');
    expect(dtoDeForm({ ...ok, canales: [] })).toBe('Elige al menos un canal.');
    expect(dtoDeForm({ ...ok, hasta: new Date(2026, 8, 1) })).toBe('La fecha de fin es anterior a la de inicio.');
  });

  it('el exhibidor colocado no pide productos', () => {
    expect(typeof dtoDeForm({ ...ok, tipo: 'por_captura', productos: [] })).toBe('object');
  });
});
