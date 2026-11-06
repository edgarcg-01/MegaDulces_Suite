import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import type { DetalleIncidenciaMovimiento, ExcepcionMovimientoItem, MovimientosExcepcionesResponse } from '@megadulces/contracts';
import { AlmacenIncidenciasComponent } from './almacen-incidencias.component';
import { AlmacenMovimientosService } from '../almacen-movimientos.service';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';

/**
 * `[MX.0.6]` La compra capturada en la unidad equivocada, en `/almacen/incidencias`.
 *
 * El caso real (2026-11-05): 8 Esquinas, orden de entrada X-A-40 0001062, 59059 NARANJA BOLI CHICO
 * en 800 PAQ a $0.5067 cuando fueron 40 PAQ: la existencia quedó 760 arriba y el pedido de Compras
 * se bloqueó en toda la red. Lo que se prueba: que la fila diga qué entró y qué debió entrar, que la
 * franja cuente el tipo nuevo, y que el panel use columnas de compra (no «salió/llegó») con centavos.
 */
const DOC = { warehouse_id: 'w03', doc_code: 'EntryOr1', doc_serie: '1', folio: '0001062' };
const COMPRA: ExcepcionMovimientoItem = {
  tipo: 'compra', excepciones: ['unidad_cruzada'], fecha: '2026-10-02', documento: DOC, documentos: [DOC], ajuste: null,
  origen: { warehouse_id: 'w03', nombre: '8 Esquinas', folio: '0001062', doc_code: 'EntryOr1', doc_serie: '1' },
  destino: null, piezas_enviadas: null, piezas_recibidas: 800, delta_piezas: -760, importe: -7701.84,
  unidad_importe: 'costo_compra', lineas_sin_importe: 0, dias: 34,
  donde: 'NARANJA BOLI CHICO /20: entraron 800 PAQ a $0.51; por su costo eran 40 (800 ÷ 20)', productos_con_error: 1, resolucion: null,
};
const resp = (universo: Record<string, number>): MovimientosExcepcionesResponse => ({
  range: { from: '2026-10-01', to: '2026-11-05' },
  totals: {
    items: 1, por_excepcion: { unidad_cruzada: { n: 1, importe: 7701.84 } },
    importe_por_unidad: { valor_traspaso: 0, precio_venta: 0, mixta: 0, costo_compra: 7701.84, sin_unidad: 0 },
    universo: universo as MovimientosExcepcionesResponse['totals']['universo'], resueltas: 0,
  },
  capped: false, page: 1, pageSize: 50, total: 1, rows: [COMPRA],
});
const DETALLE: DetalleIncidenciaMovimiento = {
  documento: { warehouse_id: 'w03', nombre: '8 Esquinas', doc_code: 'EntryOr1', doc_serie: '1', folio: '0001062', fecha: '2026-10-02' },
  contraparte: null, destino: null, excepciones: ['unidad_cruzada'], donde: COMPRA.donde,
  renglones: [{
    sku: '59059', producto: 'NARANJA BOLI CHICO /20', salida: null, recepcion: null, delta: -760, importe: 405.36,
    importe_diferencia: -7701.84, sin_costo: false, estado: 'unidad_cruzada', con_error: true,
    entrada: { unidad: 'PAQ', capturado: 800, costo_capturado: 0.5067, costo_proveedor: 9.31, razon: 0.0544, factor: 20, sentido: 'inflada', probable: 40 },
  }],
  resolucion: null, motivos: [], documentos: [DOC],
};

describe('[MX.0.6] la compra con la unidad equivocada en Incidencias', () => {
  let fix: ComponentFixture<AlmacenIncidenciasComponent>;
  const montar = async (r: MovimientosExcepcionesResponse) => {
    await TestBed.configureTestingModule({
      imports: [AlmacenIncidenciasComponent],
      providers: [
        provideRouter([]),
        { provide: AlmacenMovimientosService, useValue: { exceptions: () => of(r), exceptionDetail: () => of(DETALLE) } },
        { provide: AuthService, useValue: { user: () => ({ permissions: {} }) } },
        { provide: PermissionsService, useValue: { isAdmin: () => false } },
      ],
    }).compileComponents();
    fix = TestBed.createComponent(AlmacenIncidenciasComponent);
    fix.detectChanges();
    return fix.nativeElement as HTMLElement;
  };
  const texto = (el: Element | null) => (el?.textContent || '').replace(/\s+/g, ' ').trim();

  it('⛔ la fila dice que es una compra, lo capturado → lo que dice su costo, y cuánto entró de más', async () => {
    const el = await montar(resp({ traspasos: 10, ajustes: 2, compras: 5 }));
    const fila = texto(el.querySelector('tbody tr'));
    expect(fila).toContain('Unidad equivocada');
    expect(fila).toContain('Compra');
    expect(fila).toContain('entraron 800 PAQ a $0.51; por su costo eran 40');
    expect(fila).toMatch(/800 → 40/);
    expect(fila).toContain('de más 760');
    expect(fila).toContain('a costo de compra');
  });

  it('la franja cuenta el tipo nuevo, y el universo suma las compras revisadas', async () => {
    await montar(resp({ traspasos: 10, ajustes: 2, compras: 5 }));
    const k = fix.componentInstance.kpis();
    expect(k.find((x) => x.label === 'Unidad equivocada')?.value).toBe(1);
    expect(k.find((x) => x.label === 'Pendientes')?.sub).toMatch(/de 17 documentos revisados/);
    expect(fix.componentInstance.unidadResumen()).toContain('a costo de compra');
  });

  it('⛔ con una API anterior (sin `compras` en el universo) el conteo no se vuelve NaN', async () => {
    await montar(resp({ traspasos: 10, ajustes: 2 }));
    expect(fix.componentInstance.kpis().find((x) => x.label === 'Pendientes')?.sub).toMatch(/de 12 documentos revisados/);
  });

  it('⛔ el panel usa columnas de compra (no «Salió/Llegó»), con centavos y dónde se corrige', async () => {
    const el = await montar(resp({ traspasos: 10, ajustes: 2, compras: 5 }));
    fix.componentInstance.revisar(COMPRA);
    fix.detectChanges();
    const ths = [...document.querySelectorAll('.inc-peek-tabla th')].map((t) => texto(t));
    expect(ths).toEqual(['Producto', 'Capturado', 'Por su costo', 'Diferencia']);
    const fila = texto(document.querySelector('.inc-peek-tabla tbody tr'));
    expect(fila).toContain('800 PAQ');
    expect(fila).toMatch(/a \$0\.51/);           // con centavos: redondeado a pesos diría $1
    expect(fila).toMatch(/proveedor \$9\.31/);
    expect(fila).toContain('-760');
    expect(texto(document.querySelector('.inc-peek-donde'))).toContain('Se corrige en Kepler: orden de entrada X-A-40 0001062 de 8 Esquinas');
    expect(fix.componentInstance.tituloPeek()).toBe('Orden de entrada 0001062');
    expect(el).toBeTruthy();
  });
});
