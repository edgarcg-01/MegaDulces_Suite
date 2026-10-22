import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import type { PedidoNegociacionDto } from '@megadulces/contracts';
import { PedidoNegociacionDetalleComponent } from './pedido-negociacion-detalle.component';

/**
 * `[RA-NEG.3]` El detalle de la negociación DENTRO del pedido. Pedido del PM (2026-10-22): «si quiero ver
 * historial o descuentos me saca del pedido […] y desglósame un poco más qué es el costo estándar».
 * Números de 70056 La Rosa Mazapán medidos en prod ese día.
 */
const DTO: PedidoNegociacionDto = {
  product_id: 'p-70056', sku: '70056', unidad_base: 'PAQ', base_por_caja: 16,
  costo: { estandar_base: 78.595625, reposicion_base: 82.68, precio_ficha: 102.94, impuesto_pct: 8, precio_igual_en_todas: true,
    margen_ficha_pct: 21.27, precio_conserva_margen: 108.29, impacto_30d: 17735.76, sucursales_afectadas: ['01'] },
  pagado: { desde: '2025-10-22', hasta: '2026-10-22',
    meses: [{ mes: '2026-01', base: 2400, promedio: 89, min: 84.88, max: 89.3 }, { mes: '2026-10', base: 6320, promedio: 81.7, min: 78.6, max: 82.68 }],
    ultimo: null, minimo: null, total_base: 52368, total_valor: 4455190.69, renglones: 81, renglones_sin_unidad: 0, renglones_atipicos: 0,
    al_estandar_reciente: [],
    entradas: [{ fecha: '2026-10-21', sucursal: '06', base: 960, costo_base: 78.595 }, { fecha: '2026-10-19', sucursal: '01', base: 160, costo_base: 82.68 },
      { fecha: '2026-07-21', sucursal: '00', base: 368, costo_base: 82.68 }] },
  proveedor: { supplier_id: 's', nombre: 'DISTRIBUIDORA DE LA ROSA SA DE CV', compras_12m: 81143559.22, recepciones_12m: 618,
    descuento_pago_12m: 3131340.22, descuento_notas_12m: 2092748.91, descuento_pct: 6.44,
    pronto_pago: { tasa: 0.0709, fuente: 'observed', pagos: 136, sin_descuento: 43, monto_sin_descuento: 20049786.69, estimado_perdido: 1421529.88,
      ultimo_sin_descuento: '2026-09-21', ultimos_sin_descuento: [{ fecha: '2026-09-21', folio: '0001234', sucursal: '00', monto: 100000 }] },
    plazo_dias: 20, plazo_base: 'factura', plazo_kepler: [], tiempo_entrega_dias: null, reclamos: { del_proveedor: 0, en_la_base: 0 } },
  generado_at: '2026-10-22T12:00:00Z',
};

function montar(d: PedidoNegociacionDto, vista: 'historial' | 'descuentos') {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ imports: [PedidoNegociacionDetalleComponent], providers: [provideZonelessChangeDetection()] });
  const f = TestBed.createComponent(PedidoNegociacionDetalleComponent);
  f.componentRef.setInput('d', d);
  f.componentRef.setInput('vista', vista);
  f.detectChanges();
  return f;
}
const texto = (f: ReturnType<typeof montar>) => ((f.nativeElement as HTMLElement).textContent || '').replace(/\s+/g, ' ');

describe('[RA-NEG.3] detalle de la negociación, sin salir del pedido', () => {
  it('explica el costo estándar con la fórmula de ESTE producto, y la fórmula cuadra con la ficha', () => {
    const f = montar(DTO, 'historial');
    const t = texto(f);
    expect(t).toContain('capturado la ficha del producto en Kepler');
    expect(t).toContain('Es el que fija el precio');
    expect(f.componentInstance.formula()).toBe('$78.60 × 1.2127 × 1.08 = $102.94 (la ficha dice $102.94)');   // CONTROL: cuadra
  });

  it('dice cuánto más pagas que el estándar y los dos márgenes', () => {
    const t = texto(montar(DTO, 'historial'));
    expect(t).toContain('Hoy pagas 5.2 % más que el estándar');
    expect(t).toContain('21.3 %');
    expect(t).toContain('15.3 %');
  });

  it('las entradas una por una, por NOMBRE de sucursal, y lo de oficinas no se llama CEDIS', () => {
    const f = montar(DTO, 'historial');
    const t = texto(f);
    expect(t).toContain('Canindo');
    expect(t).toContain('Padre Hidalgo');
    expect(t).toContain('oficinas');
    expect(t).not.toContain('CEDIS');
    expect(f.componentInstance.vsEstTxt(78.595)).toBe('igual');
    expect(f.componentInstance.vsEstTxt(82.68)).toBe('+5.2 %');
  });

  it('descuentos: lo obtenido, lo que no se tomó (tasa observada, dicho) y los pagos', () => {
    const t = texto(montar(DTO, 'descuentos'));
    expect(t).toContain('43 salieron sin descuento');
    expect(t).toContain('OBSERVADA');
    expect(t).toContain('0001234');
  });

  it('⛔ sin permiso de Descuentos la lista NO se pinta vacía: se dice', () => {
    const sin = { ...DTO, proveedor: { ...DTO.proveedor!, pronto_pago: { ...DTO.proveedor!.pronto_pago!, ultimos_sin_descuento: null } } };
    const t = texto(montar(sin, 'descuentos'));
    expect(t).toContain('La lista de pagos la ve quien tiene permiso de Descuentos');
    expect(t).not.toContain('0001234');
  });
});
