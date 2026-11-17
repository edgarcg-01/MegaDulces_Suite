import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import type { ProductLocationDetail, WarehouseLocationRow } from '@megadulces/contracts';
import { UbicacionesCensoComponent } from './ubicaciones-censo.component';
import { AlmacenUbicacionesCatalogoService } from '../almacen-ubicaciones-catalogo.service';

/**
 * `[UB.3b]` El censo con lector, montado de verdad (plantilla + signals) y con el servidor simulado.
 * Se prueba como lo usa la persona: escribe (o el lector «teclea») en el campo y Enter.
 */

const PH = { id: 'w-ph', code: '01', name: 'Padre Hidalgo' };
const ROW = (code: string, p: Partial<WarehouseLocationRow> = {}): WarehouseLocationRow => ({
  id: 'b-' + code, warehouse_id: PH.id, warehouse_code: '01', code, label: null, familia: 'ubicacion', zona: code[0] as 'B' | 'T',
  pasillo: code[1], rack: Number(code.slice(2, 4)), nivel: Number(code[4]), tipo: code[0] === 'B' ? 'surtido' : 'tienda_piso',
  estado: 'activa', motivo_estado: null, pick_sequence: 1, renglones_con_cantidad: 0, updated_at: '2026-11-17T00:00:00Z', ...p,
});
const DETALLE = (asignaciones: ProductLocationDetail['asignaciones'] = []): ProductLocationDetail => ({
  warehouse: PH, product: { id: 'p-07302', sku: '07302', nombre: 'AVILA MAZAPAN 40' }, ficha_kepler: true, aviso: null, asignaciones,
  presentaciones: [
    { peldano: 1, rotulo: 'PAQ', factor: 1, fuente: 'base', codigos: ['7502212930012'], es_caja: false },
    { peldano: 2, rotulo: 'CJA', factor: 20, fuente: 'capturado', codigos: ['C07302'], es_caja: true },
  ],
});

function montar(opts: { ubicaciones?: WarehouseLocationRow[]; detalle?: ProductLocationDetail; crearFalla?: HttpErrorResponse } = {}) {
  const api = {
    list: vi.fn(() => of({ alcance: {}, warehouse: PH, resumen: {}, ubicaciones: opts.ubicaciones ?? [ROW('BA053'), ROW('BA021')] })),
    products: vi.fn(() => of({ total: 1, filas: [{ product_id: 'p-07302', sku: '07302', nombre: 'AVILA MAZAPAN 40', surtido_fijo: [], asignaciones: 0 }] })),
    productDetail: vi.fn(() => of(opts.detalle ?? DETALLE())),
    createAssignment: vi.fn((b: { presentacion: number; papel: string; bin_code: string }) =>
      opts.crearFalla ? throwError(() => opts.crearFalla) : of({ id: 'a-' + b.presentacion + b.bin_code, code: b.bin_code, presentacion: b.presentacion, papel: b.papel })),
    updateAssignment: vi.fn((id: string, b: { bin_code: string }) => of({ id, code: b.bin_code })),
    removeAssignment: vi.fn((id: string) => of({ id, quitada: true })),
    create: vi.fn((b: { code: string; tipo: string }) => of(ROW(b.code, { tipo: b.tipo as WarehouseLocationRow['tipo'] }))),
  };
  TestBed.configureTestingModule({ imports: [UbicacionesCensoComponent], providers: [{ provide: AlmacenUbicacionesCatalogoService, useValue: api }] });
  const fix = TestBed.createComponent(UbicacionesCensoComponent);
  fix.componentRef.setInput('warehouse', PH);
  fix.detectChanges();
  const el = fix.nativeElement as HTMLElement;
  const leer = async (v: string) => {
    fix.componentInstance.entrada.set(v);
    fix.componentInstance.leer();
    await fix.whenStable();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    fix.detectChanges();
  };
  const texto = () => el.textContent?.replace(/\s+/g, ' ') ?? '';
  const boton = (t: RegExp) => Array.from(el.querySelectorAll('button')).find((b) => t.test(b.textContent ?? '')) as HTMLButtonElement | undefined;
  return { fix, api, leer, texto, boton };
}

describe('[UB.3b] Censo con lector', () => {
  it('NEGATIVA: un producto antes que la ubicación no se asigna a ningún lado', async () => {
    const { api, leer, texto } = montar();
    await leer('7502212930012');
    expect(texto()).toContain('Primero escanea el cartel de la ubicación');
    expect(api.products).not.toHaveBeenCalled();
  });

  it('⭐ ubicación y producto: asigna la presentación del código, con el papel de la ubicación', async () => {
    const { api, leer, texto } = montar();
    await leer('ba053');
    expect(texto()).toContain('BA053');
    await leer('7502212930012');
    expect(api.createAssignment).toHaveBeenCalledWith({ warehouse_id: PH.id, product_id: 'p-07302', presentacion: 1, papel: 'surtido_fijo', bin_code: 'BA053' });
    expect(texto()).toContain('AVILA MAZAPAN 40 · PAQ → BA053');
    expect(texto()).toContain('Asignados en BA053 en este escaneo (1)');
  });

  it('el código de la caja asigna la caja', async () => {
    const { api, leer } = montar();
    await leer('BA053');
    await leer('C07302');
    expect(api.createAssignment).toHaveBeenCalledWith(expect.objectContaining({ presentacion: 2 }));
  });

  it('⭐ una ubicación que no existe se da de alta en el acto y queda lista para escanear', async () => {
    const { api, leer, texto, boton, fix } = montar();
    await leer('BC014');
    expect(texto()).toContain('BC014 no está dada de alta');
    boton(/Darla de alta como surtido/)!.click();
    await fix.whenStable();
    fix.detectChanges();
    expect(api.create).toHaveBeenCalledWith({ warehouse_id: PH.id, code: 'BC014', tipo: 'surtido' });
    expect(texto()).toContain('BC014 quedó dada de alta');
  });

  it('si ya tiene lugar fijo en otra ubicación, ofrece moverlo (no crea un segundo)', async () => {
    const otra = { id: 'a-viejo', bin_id: 'b-BA021', code: 'BA021', zona: 'B' as const, estado: 'activa' as const, presentacion: 1 as const, presentacion_rotulo: 'PAQ', papel: 'surtido_fijo' as const, min_qty: null, max_qty: null };
    const { api, leer, texto, boton, fix } = montar({ detalle: DETALLE([otra]) });
    await leer('BA053');
    await leer('7502212930012');
    expect(api.createAssignment).not.toHaveBeenCalled();
    expect(texto()).toContain('ya tiene lugar fijo de surtido en BA021');
    boton(/Moverlo a BA053/)!.click();
    await fix.whenStable();
    fix.detectChanges();
    expect(api.updateAssignment).toHaveBeenCalledWith('a-viejo', { bin_code: 'BA053' });
    expect(texto()).toContain('se movió de BA021 a BA053');
  });

  it('las lecturas rápidas no se pierden: se procesan en orden', async () => {
    const { api, fix } = montar();
    const c = fix.componentInstance;
    for (const v of ['BA053', '7502212930012', 'C07302']) { c.entrada.set(v); c.leer(); }
    await fix.whenStable();
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(api.createAssignment.mock.calls.map((x) => (x as unknown as [{ presentacion: number }])[0].presentacion)).toEqual([1, 2]);
  });

  it('NEGATIVA: una ubicación de recepción no recibe productos y no busca nada', async () => {
    const { api, leer, texto } = montar({ ubicaciones: [ROW('BA053', { tipo: 'recepcion' })] });
    await leer('BA053');
    await leer('7502212930012');
    expect(api.products).not.toHaveBeenCalled();
    expect(texto()).toContain('ahí no va el lugar de un producto');
  });

  it('el error del servidor se dice tal cual (y no se anota como asignado)', async () => {
    const falla = new HttpErrorResponse({ status: 409, error: { message: 'Esta presentación ya tiene lugar fijo de surtido: cámbiala en vez de agregar otra.' } });
    const { leer, texto } = montar({ crearFalla: falla });
    await leer('BA053');
    await leer('7502212930012');
    expect(texto()).toContain('cámbiala en vez de agregar otra');
    expect(texto()).toContain('Asignados en BA053 en este escaneo (0)');
  });
});
