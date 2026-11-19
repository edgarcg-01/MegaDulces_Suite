import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ProductLocationDetail, ProductLocationsList, WarehouseLocationRow } from '@megadulces/contracts';
import { AlmacenUbicacionesAsignacionComponent } from './almacen-ubicaciones-asignacion.component';
import { AlmacenUbicacionesCatalogoService } from '../almacen-ubicaciones-catalogo.service';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { UsoService } from '../../../core/services/uso.service';
import { Permission } from '../../../core/constants/permissions';

/**
 * `[UB.RF.11]` «Ubicar productos» montada de verdad (plantilla + signals) con el servidor simulado. Se
 * prueba como la usa la persona: escribe (o el lector «teclea») en el ÚNICO campo y Enter. Incluye lo
 * que cubría el censo de UB.3b (que ahora es este mismo campo) y lo nuevo de la pantalla rehecha.
 */

const PH = { id: 'w-ph', code: '01', name: 'Padre Hidalgo' };
const ROW = (code: string, p: Partial<WarehouseLocationRow> = {}): WarehouseLocationRow => ({
  id: 'b-' + code, warehouse_id: PH.id, warehouse_code: '01', code, label: null, familia: 'ubicacion', zona: code[0] as 'B' | 'T',
  pasillo: code[1], rack: Number(code.slice(2, 4)), nivel: Number(code[4]), tipo: code[0] === 'B' ? 'surtido' : 'tienda_piso',
  estado: 'activa', motivo_estado: null, pick_sequence: 1, renglones_con_cantidad: 0, updated_at: '2026-11-19T00:00:00Z', ...p,
});
const DETALLE = (asignaciones: ProductLocationDetail['asignaciones'] = []): ProductLocationDetail => ({
  warehouse: PH, product: { id: 'p-07302', sku: '07302', nombre: 'AVILA MAZAPAN 40' }, ficha_kepler: true, aviso: null, asignaciones,
  presentaciones: [
    { peldano: 1, rotulo: 'PAQ', factor: 1, fuente: 'base', codigos: ['7502212930012'], es_caja: false },
    { peldano: 2, rotulo: 'CJA', factor: 20, fuente: 'capturado', codigos: ['C07302'], es_caja: true },
  ],
});
const LISTA = (p: Partial<ProductLocationsList> = {}): ProductLocationsList => ({
  warehouse: PH, ficha_kepler: true, universo: 9050, total: 9042, sin_ubicacion: 9042, con_tienda: 8, con_venta: 3039, ubicaciones_bodega: 0,
  orden: 'venta', limit: 50, offset: 0,
  filas: [
    { product_id: 'p-02009', sku: '02009', nombre: 'BUBBALOO TUTI-FRUTI 239.7GR/47', surtido_fijo: [], asignaciones: 1, lugares: [{ papel: 'exhibicion_tienda', code: 'TA011', presentacion: 1, rotulo: 'PAQ' }] },
    { product_id: 'p-07302', sku: '07302', nombre: 'AVILA MAZAPAN 40', surtido_fijo: [], asignaciones: 0, lugares: [] },
  ],
  ...p,
});

let gestiona = true;
function montar(opts: { ubicaciones?: WarehouseLocationRow[]; detalle?: ProductLocationDetail; lista?: ProductLocationsList; crearFalla?: HttpErrorResponse } = {}) {
  const api = {
    list: vi.fn(() => of({ alcance: { almacenes: [PH] }, warehouse: PH, resumen: {}, ubicaciones: opts.ubicaciones ?? [ROW('BA053'), ROW('BA021'), ROW('TA011')] })),
    // Buscar: «02009» es el BUBBALOO; cualquier otra lectura (clave o código de barras) es el AVILA, como el servidor.
    products: vi.fn((_w: string, o: { q: string }) => of(o.q ? LISTA({ total: 1, filas: [LISTA().filas[o.q === '02009' ? 0 : 1]] }) : (opts.lista ?? LISTA()))),
    productDetail: vi.fn(() => of(opts.detalle ?? DETALLE())),
    createAssignment: vi.fn((b: { presentacion: number; papel: string; bin_code: string }) =>
      opts.crearFalla ? throwError(() => opts.crearFalla) : of({ id: 'a-' + b.presentacion + b.bin_code, code: b.bin_code, presentacion: b.presentacion, papel: b.papel })),
    updateAssignment: vi.fn((id: string, b: { bin_code: string }) => of({ id, code: b.bin_code })),
    removeAssignment: vi.fn((id: string) => of({ id, quitada: true })),
    create: vi.fn((b: { code: string; tipo: string }) => of(ROW(b.code, { tipo: b.tipo as WarehouseLocationRow['tipo'] }))),
  };
  const uso = { reportarIncidente: vi.fn() };
  TestBed.configureTestingModule({
    imports: [AlmacenUbicacionesAsignacionComponent],
    providers: [
      provideRouter([]),
      { provide: AlmacenUbicacionesCatalogoService, useValue: api },
      { provide: AuthService, useValue: { user: () => ({ permissions: gestiona ? { [Permission.ALMACEN_UBICACIONES_GESTIONAR]: true } : {} }) } },
      { provide: PermissionsService, useValue: { isAdmin: () => false, has: () => false } },
      { provide: UsoService, useValue: uso },
    ],
  });
  const fix = TestBed.createComponent(AlmacenUbicacionesAsignacionComponent);
  fix.detectChanges();
  const c = fix.componentInstance;
  const el = fix.nativeElement as HTMLElement;
  const pausa = async () => {
    await fix.whenStable();
    for (let i = 0; i < 8; i++) await Promise.resolve();
    fix.detectChanges();
  };
  const leer = async (v: string) => {
    c.entrada.set(v);
    c.leer();
    await pausa();
  };
  const texto = () => el.textContent?.replace(/\s+/g, ' ') ?? '';
  const boton = (t: RegExp) => Array.from(el.querySelectorAll('button')).find((b) => t.test((b.textContent ?? '').replace(/\s+/g, ' '))) as HTMLButtonElement | undefined;
  const clic = async (t: RegExp) => {
    const b = boton(t);
    if (!b) throw new Error(`no hay botón ${t}`);
    b.click();
    await pausa();
  };
  return { fix, c, api, uso, leer, texto, boton, clic, pausa };
}

describe('[UB.RF.11] Ubicar productos', () => {
  beforeEach(() => {
    gestiona = true;
    TestBed.resetTestingModule();
    try { localStorage.clear(); } catch { /* sin almacenamiento */ }
  });

  // ── La lista ────────────────────────────────────────────────────────────────────────────────

  it('⭐ la cola pide «por ubicar» por venta y las cifras dicen lo que cuentan (nunca «% ya ubicado»)', async () => {
    const { api, texto, pausa } = montar();
    await pausa();
    expect(api.products).toHaveBeenCalledWith(PH.id, expect.objectContaining({ filtro: 'sin_ubicacion', orden: 'venta', offset: 0 }));
    expect(texto()).toContain('Por ubicar · lo más vendido primero');
    // Las cifras con sus rótulos verdaderos: tienda Y bodega, y de qué universo salen.
    expect(texto()).toContain('Con lugar para surtir');
    expect(texto()).toContain('Con lugar en tienda');
    expect(texto()).toContain('Se vendieron en 30 días');
    expect(texto()).toContain('De 9,050 productos de Padre Hidalgo; van primero los que más se vendieron en los últimos 30 días.');
    // El rótulo que causó la pregunta de WhatsApp ya no existe.
    expect(texto()).not.toMatch(/% ya ubicado/);
  });

  it('⭐ la tarjeta dice en palabras dónde está: tienda TA011 y bodega «falta»', async () => {
    const { fix, pausa } = montar();
    await pausa();
    const card = (fix.nativeElement as HTMLElement).querySelector('.ub-card')!;
    expect(card.tagName).toBe('BUTTON');
    expect(card.textContent?.replace(/\s+/g, ' ')).toContain('BUBBALOO TUTI-FRUTI 239.7GR/47 02009 Tienda TA011 · Bodega falta');
  });

  it('sin ubicaciones de bodega, lo dice arriba y cómo se crean', async () => {
    const { texto, pausa } = montar();
    await pausa();
    expect(texto()).toContain('Padre Hidalgo todavía no tiene ubicaciones de bodega');
  });

  it('NEGATIVA: sin venta registrada la lista no promete «lo más vendido» y lo dice (no «0 se venden»)', async () => {
    const { texto, pausa } = montar({ lista: LISTA({ con_venta: null, ubicaciones_bodega: 3 }) });
    await pausa();
    expect(texto()).not.toContain('lo más vendido primero');
    expect(texto()).toContain('sin venta registrada aquí: van por nombre');
    expect(texto()).not.toContain('todavía no tiene ubicaciones de bodega');
  });

  it('«Ver más» agrega la página siguiente: el total publicado se puede recorrer', async () => {
    const { api, clic, pausa } = montar();
    await pausa();
    await clic(/Ver más/);
    expect(api.products).toHaveBeenLastCalledWith(PH.id, expect.objectContaining({ offset: 2 }));
  });

  // ── Producto primero ────────────────────────────────────────────────────────────────────────

  it('⭐ producto por su clave y después su ubicación: pregunta la presentación, asigna y ofrece Deshacer', async () => {
    const { c, api, leer, texto, clic } = montar();
    await leer('07302');
    expect(c.modo()).toBe('producto');
    expect(texto()).toContain('AVILA MAZAPAN 40');
    expect(texto()).toContain('Bodega falta');
    await leer('BA053');
    expect(texto()).toContain('¿qué presentación?');
    await clic(/^\s*PAQ\s*$/);
    expect(api.createAssignment).toHaveBeenCalledWith({ warehouse_id: PH.id, product_id: 'p-07302', presentacion: 1, papel: 'surtido_fijo', bin_code: 'BA053' });
    expect(texto()).toContain('AVILA MAZAPAN 40 · PAQ en bodega BA053.');
    await clic(/Deshacer/);
    expect(api.removeAssignment).toHaveBeenCalledWith('a-1BA053');
  });

  it('el código de barras de la caja abre el producto con la caja señalada: la ubicación va a la caja sin preguntar', async () => {
    const { api, leer } = montar();
    await leer('C07302');
    await leer('BA053');
    expect(api.createAssignment).toHaveBeenCalledWith(expect.objectContaining({ presentacion: 2, papel: 'surtido_fijo', bin_code: 'BA053' }));
  });

  it('«Poner lugar» señala la presentación: la siguiente ubicación va a ella', async () => {
    const { api, leer, clic } = montar();
    await leer('07302');
    await clic(/Poner lugar/); // el primero: tienda del PAQ
    await leer('TA011');
    expect(api.createAssignment).toHaveBeenCalledWith(expect.objectContaining({ presentacion: 1, papel: 'exhibicion_tienda', bin_code: 'TA011' }));
  });

  it('⭐ una ubicación que no existe se crea en el acto y se asigna (lo que faltaba en Padre Hidalgo)', async () => {
    const { api, leer, texto, clic } = montar();
    await leer('7502212930012');
    await leer('BB011');
    expect(texto()).toContain('BB011 no existe en Padre Hidalgo.');
    await clic(/Crear BB011 y asignar/);
    expect(api.create).toHaveBeenCalledWith({ warehouse_id: PH.id, code: 'BB011', tipo: 'surtido' });
    expect(api.createAssignment).toHaveBeenCalledWith(expect.objectContaining({ presentacion: 1, papel: 'surtido_fijo', bin_code: 'BB011' }));
  });

  it('si ya tiene lugar fijo en otra ubicación, ofrece moverlo (no crea un segundo) y Deshacer lo regresa', async () => {
    const otra = { id: 'a-vieja', bin_id: 'b-BA021', code: 'BA021', zona: 'B' as const, estado: 'activa' as const, presentacion: 1 as const, presentacion_rotulo: 'PAQ', papel: 'surtido_fijo' as const, min_qty: null, max_qty: null };
    const { api, leer, clic, texto } = montar({ detalle: DETALLE([otra]) });
    await leer('7502212930012');
    await leer('BA053');
    expect(api.createAssignment).not.toHaveBeenCalled();
    expect(texto()).toContain('ya tiene lugar fijo de surtido en BA021');
    await clic(/Moverlo a BA053/);
    expect(api.updateAssignment).toHaveBeenCalledWith('a-vieja', { bin_code: 'BA053' });
    await clic(/Deshacer/);
    expect(api.updateAssignment).toHaveBeenLastCalledWith('a-vieja', { bin_code: 'BA021' });
  });

  // ── Ubicación primero («Aquí», el censo) ────────────────────────────────────────────────────

  it('⭐ ubicación primero: queda «Aquí» y cada producto escaneado va ahí con el papel de la ubicación', async () => {
    const { c, api, leer, texto } = montar();
    await leer('ta011');
    expect(c.aqui()?.code).toBe('TA011');
    await leer('7502212930012');
    expect(api.createAssignment).toHaveBeenCalledWith({ warehouse_id: PH.id, product_id: 'p-07302', presentacion: 1, papel: 'exhibicion_tienda', bin_code: 'TA011' });
    expect(texto()).toContain('AVILA MAZAPAN 40 07302 · PAQ');
    expect(c.modo()).toBe('lista');
  });

  it('las lecturas rápidas no se pierden ni se pegan: entran a una fila y se procesan en orden', async () => {
    const { c, api, pausa } = montar();
    c.entrada.set('BA053'); c.leer();
    c.entrada.set('7502212930012'); c.leer();
    c.entrada.set('C07302'); c.leer();
    expect(c.entrada()).toBe('');
    await pausa(); await pausa();
    expect(api.createAssignment.mock.calls.map((x) => x[0].presentacion)).toEqual([1, 2]);
  });

  it('NEGATIVA: una ubicación de recepción no queda como «Aquí» y no asigna nada', async () => {
    const { c, api, leer, texto } = montar({ ubicaciones: [ROW('BR011', { tipo: 'recepcion' })] });
    await leer('BR011');
    expect(c.aqui()).toBeNull();
    expect(texto()).toContain('ahí no va el lugar de un producto');
    expect(api.createAssignment).not.toHaveBeenCalled();
  });

  // ── Rechazos y permisos ─────────────────────────────────────────────────────────────────────

  it('⭐ un rechazo se dice en palabras y deja su motivo en el canal de incidentes', async () => {
    const falla = new HttpErrorResponse({ status: 409, error: { message: 'Esta presentación ya tiene lugar fijo de surtido' } });
    const { uso, leer, texto } = montar({ crearFalla: falla });
    await leer('7502212930012');
    await leer('BA053');
    expect(texto()).toContain('Esta presentación ya tiene lugar fijo de surtido');
    expect(uso.reportarIncidente).toHaveBeenCalledWith('ubicar_rechazado', expect.objectContaining({ accion: 'asignar', status: 409, motivo: 'Esta presentación ya tiene lugar fijo de surtido', code: 'BA053' }));
  });

  it('NEGATIVA: lo que se guarda bien no reporta incidente', async () => {
    const { uso, leer } = montar();
    await leer('7502212930012');
    await leer('BA053');
    expect(uso.reportarIncidente).not.toHaveBeenCalled();
  });

  it('sin permiso de gestionar: busca y ve, pero no ubica (ni «Poner lugar», ni crea)', async () => {
    gestiona = false;
    const { api, leer, texto, boton } = montar();
    await leer('BA053');
    expect(texto()).toContain('Para ubicar productos se necesita el permiso de gestionar ubicaciones');
    await leer('07302');
    expect(boton(/Poner lugar/)).toBeUndefined();
    expect(api.create).not.toHaveBeenCalled();
    expect(api.createAssignment).not.toHaveBeenCalled();
  });
});
