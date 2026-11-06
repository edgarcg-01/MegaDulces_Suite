import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { ComprasOcAbiertasComponent } from './compras-oc-abiertas.component';
import { ComprasService, type OpenOcRow } from '../compras.service';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';

/**
 * `[PQ.84]` OC abiertas: encontrar UNA orden por folio, por la requisición de la que salió o por
 * proveedor, y filtrar por origen. Se prueba montada: que el filtro mueva la tabla Y el contador.
 */
const fila = (folio: string, proveedor: string, requisicion: OpenOcRow['requisicion']): OpenOcRow => ({
  almacen: '00', folio, fecha_oc: '2026-11-04', proveedor, estatus: 'N', dias: 2, lineas: 3, valor: 1000,
  prob: 90, seguimiento: null, estado_cadena: null, pendiente_en_erp: true, requisicion,
});
const ROWS: OpenOcRow[] = [
  fila('0007296', 'EFFEM MEXICO INC. Y COMPAÑÍAS EN N.C DE CV', { id: 'r1', folio: 'RQ-2026-02055', kepler: '0003143' }),
  fila('0000332', 'RICO PAY MORELIA', null),
  fila('0000331', 'BOTANAS MICHOACAN', null),
];

describe('[PQ.84] OC abiertas — buscar y filtrar por origen', () => {
  const montar = async () => {
    await TestBed.configureTestingModule({
      imports: [ComprasOcAbiertasComponent],
      providers: [
        provideRouter([]),
        { provide: ComprasService, useValue: {
          filters: () => of({ warehouses: [] }),
          openPurchaseOrders: () => of({ rows: ROWS, total: 3, mostradas: 3, truncado: false, total_minimo: false, total_valor: 3000, valor_esperado: 2700, viejas: 0, valor_viejas: 0 }),
        } },
        { provide: AuthService, useValue: { user: () => ({ permissions: {} }) } },
        { provide: PermissionsService, useValue: { isAdmin: () => false, has: () => false, hasAny: () => false } },
      ],
    }).compileComponents();
    const fix = TestBed.createComponent(ComprasOcAbiertasComponent);
    fix.detectChanges();
    return fix;
  };

  it('⛔ por la RQ de la que salió encuentra su OC (y el contador lo dice)', async () => {
    const fix = await montar();
    const c = fix.componentInstance;
    c.fBuscar.set('2055');
    fix.detectChanges();
    expect(c.filas().map((o) => o.folio)).toEqual(['0007296']);
    expect((fix.nativeElement as HTMLElement).querySelector('.oa-count')?.textContent).toMatch(/1\s+filtradas de 3/);
  });

  it('por proveedor sin acentos; vacío vuelve a todas', async () => {
    const c = (await montar()).componentInstance;
    c.fBuscar.set('botanas');
    expect(c.filas().map((o) => o.folio)).toEqual(['0000331']);
    c.fBuscar.set('');
    expect(c.filas()).toHaveLength(3);
  });

  it('el origen filtra y sus opciones dicen cuántas hay', async () => {
    const c = (await montar()).componentInstance;
    expect(c.origenOpts().map((o) => o.label)).toEqual(['Requisición de la Suite (1)', 'Requisición de Kepler (0)', 'Sin requisición (2)']);
    c.fOrigen.set('sin');
    expect(c.filas().map((o) => o.folio)).toEqual(['0000332', '0000331']);
  });

  it('«Quitar los filtros» también quita la búsqueda y el origen', async () => {
    const c = (await montar()).componentInstance;
    c.fBuscar.set('effem'); c.fOrigen.set('suite');
    c.limpiarFiltros();
    expect(c.fBuscar()).toBe('');
    expect(c.fOrigen()).toBe('');
  });
});
