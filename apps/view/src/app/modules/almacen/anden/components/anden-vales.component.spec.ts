import { ComponentFixture, TestBed } from '@angular/core/testing';
import { AndenValesComponent } from './anden-vales.component';
import { ErpOrderMatch, ErpPendingBranch } from '../../receiving-session.service';

/**
 * `[WMS-REC.17]` — **los vales de una sucursal: compras de hoy y traspasos en camino.**
 *
 * El reporte que lo originó: «CEDIS mandó mercancía a Padre Hidalgo y no aparece». Lo que se
 * cuida es que el traspaso SALGA, que diga de dónde viene y cómo va, y que al tocarlo se
 * emita el embarque (con su serie y su origen) y no una orden de entrada.
 */
const PH: ErpPendingBranch = {
  sucursal: '01', warehouse_id: 'wh-01', warehouse_code: '01', warehouse_name: 'Padre Hidalgo',
  pendientes: 2, compras: 1, traspasos: 1, ultimo: '2026-10-06', sin_almacen: false,
};

const embarque = (extra: Partial<ErpOrderMatch> = {}): ErpOrderMatch => ({
  sucursal: '00', folio: '0001048', serie: 2, receipt_date: '2026-10-04',
  proveedor_code: null, proveedor_nombre: 'CEDIS BPIRAPUATO', monto: 10670.88,
  warehouse_id: 'wh-01', warehouse_code: '01', warehouse_name: 'Padre Hidalgo',
  line_count: 3, service_count: 0,
  origin: { kind: 'transfer', isCedis: true, label: 'CEDIS', name: 'CEDIS BPIRAPUATO' },
  tipo: 'traspaso', fuente: 'embarque', recibido_kepler: null, dias_en_camino: 2,
  destino_code: 'TI001', destino_nombre: 'SUCURSAL PADRE HIDALGO',
  ...extra,
});

const compra: ErpOrderMatch = {
  sucursal: '01', folio: '0000412', receipt_date: '2026-10-06',
  proveedor_code: 'CD015', proveedor_nombre: 'DE LA ROSA', monto: 5000,
  warehouse_id: 'wh-01', warehouse_code: '01', warehouse_name: 'Padre Hidalgo',
  line_count: 12, service_count: 0,
  origin: { kind: 'supplier', isCedis: false, label: 'Proveedor', name: 'DE LA ROSA' },
  tipo: 'compra', fuente: 'orden_entrada',
};

describe('AndenValesComponent', () => {
  let fixture: ComponentFixture<AndenValesComponent>;
  const el = () => fixture.nativeElement as HTMLElement;
  const filas = () => Array.from(el().querySelectorAll<HTMLButtonElement>('button.va-row'));

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [AndenValesComponent] }).compileComponents();
    fixture = TestBed.createComponent(AndenValesComponent);
    fixture.componentRef.setInput('sucursal', PH);
  });

  it('⭐ el traspaso del CEDIS aparece, arriba y aparte de las compras', () => {
    fixture.componentRef.setInput('vales', [compra, embarque()]);
    fixture.detectChanges();
    const rows = filas();
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain('Embarque 0001048');
    expect(rows[0].textContent).toContain('CEDIS');
    expect(rows[0].classList.contains('va-row-tr')).toBe(true);
    expect(rows[1].textContent).toContain('0000412');
    expect(rows[1].classList.contains('va-row-tr')).toBe(false);
    const cabs = Array.from(el().querySelectorAll('.va-cab')).map((c) => c.textContent || '');
    expect(cabs[0]).toContain('Traspasos');
    expect(cabs[1]).toContain('Compras');
  });

  it('dice de dónde viene y cuándo salió', () => {
    fixture.componentRef.setInput('vales', [embarque()]);
    fixture.detectChanges();
    const t = filas()[0].textContent || '';
    expect(t).toContain('De CEDIS BPIRAPUATO');
    expect(t).toContain('salió hace 2 días');
    expect(t).toContain('3 renglones');
  });

  it('cómo va, en palabras de andén', () => {
    const cmp = fixture.componentInstance;
    expect(cmp.estado(embarque({ dias_en_camino: 0 }))).toBe('salió hoy');
    expect(cmp.estado(embarque({ dias_en_camino: 1 }))).toBe('salió ayer');
    expect(cmp.estado(embarque({ dias_en_camino: 3 }))).toBe('salió hace 3 días');
    expect(cmp.estado(embarque({ dias_en_camino: -1 }))).toBe('fechado a futuro en Kepler');
    // Que Kepler ya lo tenga NO quiere decir que tenga caducidad: se dice, no se esconde.
    expect(cmp.estado(embarque({ recibido_kepler: '2026-10-06' }))).toBe('Kepler ya registró la recepción');
  });

  it('tocar el traspaso emite EL EMBARQUE, con su serie y su origen', () => {
    fixture.componentRef.setInput('vales', [embarque()]);
    fixture.detectChanges();
    const emitidos: ErpOrderMatch[] = [];
    fixture.componentInstance.abrir.subscribe((x) => emitidos.push(x));
    filas()[0].click();
    expect(emitidos).toHaveLength(1);
    expect(emitidos[0]).toMatchObject({ fuente: 'embarque', sucursal: '00', serie: 2, folio: '0001048' });
  });

  it('sin traspasos, la lista de compras queda como siempre', () => {
    fixture.componentRef.setInput('vales', [compra]);
    fixture.detectChanges();
    expect(el().querySelectorAll('.va-row-tr').length).toBe(0);
    expect(el().querySelector('.va-cab')?.textContent).toContain('Elegí el vale');
  });

  it('una respuesta vieja (sin `fuente`) se lee como orden de entrada, no como traspaso', () => {
    const { fuente: _f, ...vieja } = compra;
    void _f;
    fixture.componentRef.setInput('vales', [vieja as ErpOrderMatch]);
    fixture.detectChanges();
    expect(fixture.componentInstance.compras()).toHaveLength(1);
    expect(fixture.componentInstance.traspasos()).toHaveLength(0);
  });
});
