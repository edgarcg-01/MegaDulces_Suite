/**
 * `[IC.25]` El kardex compartido (Existencia negativa + Diferencias).
 *
 * El caso que lo originó, con sus números de prod (2026-11-10): el 83816 en Padre Hidalgo llegó el
 * 8-oct (+150), se vendió hasta 0 el 19-oct, salió un embarque de 30 el 6-nov SIN existencia, bajó a
 * −145 con mostrador y la recepción del 9-nov (+150) lo dejó otra vez en 0. La foto diaria pintaba 0
 * todo ese tramo; el kardex tiene que DECIR que estuvo en −145 aunque hoy marque 0.
 */
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { of, throwError } from 'rxjs';
import type { KardexNegativoResponse, RenglonKardex } from '@megadulces/contracts';

import { KardexProductoComponent } from './kardex-producto.component';
import { AlmacenMovimientosService } from '../almacen-movimientos.service';

const PH = '8eb1a11d-5953-47e4-9d6c-a884c9baf0c5';

function renglon(dia: string, nombre: string, piezas: number, saldo: number, familia: RenglonKardex['familia'], folio: string | null = null): RenglonKardex {
  return { dia, doc: 'U-D-10', sub: 1, nombre, folio, documentos: 1, piezas, importe: null, unidad: 'PAQ', factor: 5, familia, saldo };
}

const KARDEX_83816_PH: KardexNegativoResponse = {
  cuadra: true, diferencia: 0, cruce: null, salidas_desde_cruce: [], pistas: [],
  renglones: [
    renglon('2026-10-08', 'Recepción Traspaso Suc', 150, 150, 'traspaso_entra', '0000410'),
    renglon('2026-10-19', 'Ticket Contado Caja 3', -150, 0, 'venta'),
    renglon('2026-11-06', 'Embarque Sucursal', -30, -30, 'embarque', '0003730'),
    renglon('2026-11-08', 'Ticket Contado Caja 5', -115, -145, 'venta'),
    renglon('2026-11-09', 'Recepción Traspaso Suc', 150, 5, 'traspaso_entra', '0000625'),
    renglon('2026-11-09', 'Ticket Contado Caja 3', -5, 0, 'venta'),
  ],
  warehouse_id: PH, sucursal: 'Padre Hidalgo', sku: '83816', producto: 'CHIDAS LOCO MIX (73GR) /5',
  existencia_kepler: 0, desde: '2026-10-08', saldo_inicial: 0, renglones_omitidos: 0,
};

describe('KardexProductoComponent · [IC.25]', () => {
  let llamadas: Array<[string, string]>;
  let respuesta: () => ReturnType<AlmacenMovimientosService['negativeKardex']>;

  function montar(sku = '83816') {
    TestBed.configureTestingModule({
      imports: [KardexProductoComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: AlmacenMovimientosService, useValue: {
          negativeKardex: (wh: string, s: string) => { llamadas.push([wh, s]); return respuesta(); },
        } },
      ],
    });
    const f = TestBed.createComponent(KardexProductoComponent);
    f.componentRef.setInput('warehouseId', PH);
    f.componentRef.setInput('sku', sku);
    f.componentRef.setInput('encabezado', true);
    f.detectChanges();
    return f;
  }

  beforeEach(() => {
    llamadas = [];
    respuesta = () => of(KARDEX_83816_PH);
  });

  it('dice el saldo más bajo aunque hoy esté en 0 (no se lee como «nunca faltó»)', async () => {
    const f = montar();
    await f.whenStable();
    f.detectChanges();
    expect(llamadas).toEqual([[PH, '83816']]);
    expect(f.componentInstance.minimo()).toEqual({ saldo: -145, dia: '2026-11-08' });
    const txt = (f.nativeElement as HTMLElement).textContent ?? '';
    expect(txt).toContain('CHIDAS LOCO MIX (73GR) /5');
    expect(txt).toContain('cerró en');
    expect(txt).toContain('-145');
    expect(txt).toContain('Control: los movimientos suman 0');
  });

  it('el mínimo es al CIERRE del día: no depende del orden de los movimientos dentro del día', async () => {
    // Así lo lista el reporte de Kepler el 9-nov: el ticket ANTES de la recepción (−150 un rato).
    // kdm2 no guarda la hora, así que ese −150 no se puede afirmar; el cierre del día (0) sí.
    const [r0, r1, r2, r3] = KARDEX_83816_PH.renglones;
    respuesta = () => of({ ...KARDEX_83816_PH, renglones: [r0, r1, r2, r3,
      renglon('2026-11-09', 'Ticket Contado Caja 3', -5, -150, 'venta'),
      renglon('2026-11-09', 'Recepción Traspaso Suc', 150, 0, 'traspaso_entra', '0000625'),
    ] });
    const f = montar();
    await f.whenStable();
    expect(f.componentInstance.minimo()).toEqual({ saldo: -145, dia: '2026-11-08' });
  });

  it('vuelve a pedir el kardex cuando cambia el producto', async () => {
    const f = montar();
    await f.whenStable();
    f.componentRef.setInput('sku', '78231');
    f.detectChanges();
    await f.whenStable();
    expect(llamadas).toEqual([[PH, '83816'], [PH, '78231']]);
  });

  it('un 400 dice su motivo; cualquier otro error, el genérico — y nunca un kardex vacío', async () => {
    respuesta = () => throwError(() => ({ status: 400, error: { message: 'Esa sucursal no está en tu alcance.' } }));
    const f = montar();
    await f.whenStable();
    expect(f.componentInstance.error()).toBe('Esa sucursal no está en tu alcance.');
    expect(f.componentInstance.kardex()).toBeNull();

    respuesta = () => throwError(() => ({ status: 500 }));
    f.componentInstance.reintentar();
    expect(f.componentInstance.error()).toBe('No se pudo leer el kardex de Kepler.');
  });

  it('sin movimientos lo dice en llano', async () => {
    respuesta = () => of({ ...KARDEX_83816_PH, renglones: [], desde: null });
    const f = montar();
    await f.whenStable();
    f.detectChanges();
    expect((f.nativeElement as HTMLElement).textContent).toContain('Kepler no tiene movimientos de este producto en esta sucursal.');
    expect(f.componentInstance.minimo()).toBeNull();
  });
});
