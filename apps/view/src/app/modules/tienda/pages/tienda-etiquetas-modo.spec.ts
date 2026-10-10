import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { of } from 'rxjs';
import type { Freshness, PresentacionPrecio } from '@megadulces/contracts';
import { LabelModel } from '../components/label.component';
import { EtiquetasService, ResolveResult } from '../etiquetas.service';
import { VerificadorService } from '../verificador.service';
import { AuthService } from '../../../core/services/auth.service';
import { TiendaEtiquetasComponent } from './tienda-etiquetas.component';

if (typeof (globalThis as any).ResizeObserver === 'undefined') {
  (globalThis as any).ResizeObserver = class { observe(): void { /* jsdom */ } unobserve(): void { /* jsdom */ } disconnect(): void { /* jsdom */ } };
}

/**
 * `[ETQ-CAMBIOS.8]` Lo que llega desde «Cambios de precio»: los códigos y el precio que la persona
 * CONFIRMÓ (todos / pieza / paquete / caja). Se prueba la pantalla de la etiquetera, que es quien
 * lo aplica a cada producto al resolverlo.
 */
const FRESH: Freshness = { data_as_of: '2026-10-08T10:00:00Z', status: 'fresh', stale: false, age_human: '2 min', inputs: [] };

const pres = (unidad: string, origen: PresentacionPrecio['origen'], precio: number, factor = 1): PresentacionPrecio => ({
  unidad, factor, origen, contenido: null, precio_lista: precio,
  mayoreo_precio: null, mayoreo_desde: null, mayoreo_veredicto: 'sin_dato',
} as PresentacionPrecio);

const modelo = (sku: string, presentaciones: PresentacionPrecio[]): LabelModel => ({
  code: sku, product_id: `p-${sku}`, sku, name: `PRODUCTO ${sku}`, content: null,
  barcode: null, barcode_format: null,
  piece_price: presentaciones[0]?.precio_lista ?? 12.5, wholesale_piece_min_qty: null, wholesale_piece_price: null,
  pack_size: null, pack_price: null, wholesale_pack_price: null, wholesale_pack_min_qty: null,
  box_size: null, box_price: null, unit_base: 'PZA', sold_by_kg: false, presentaciones,
});

const CON_TRES = modelo('10001', [pres('PZA', 'base', 8.66), pres('PAQ', 'unidad2', 66.06, 8), pres('CJA', 'unidad3', 860.6, 112)]);
const SIN_CAJA = modelo('10002', [pres('PZA', 'base', 5), pres('PAQ', 'unidad2', 40, 8)]);

class EtiquetasStub {
  resolve(codes: string[]): ReturnType<EtiquetasService['resolve']> {
    const todos = [CON_TRES, SIN_CAJA];
    const r: ResolveResult = { labels: todos.filter((m) => codes.includes(m.sku!)), not_found: [], freshness: FRESH };
    return of(r);
  }
  search() { return of([]); }
}
class VerificadorStub { sucursales() { return of([]); } }

describe('TiendaEtiquetasComponent · el precio confirmado en «Cambios de precio»', () => {
  let fix: ComponentFixture<TiendaEtiquetasComponent>;
  let cmp: TiendaEtiquetasComponent;

  async function abrirCon(estado: unknown): Promise<void> {
    // El estado del router termina en `history.state`: así llegan los códigos desde la otra pestaña.
    history.replaceState(estado, '');
    await TestBed.configureTestingModule({
      imports: [TiendaEtiquetasComponent],
      providers: [
        provideRouter([]), provideHttpClient(), provideHttpClientTesting(),
        { provide: EtiquetasService, useValue: new EtiquetasStub() },
        { provide: VerificadorService, useValue: new VerificadorStub() },
        { provide: AuthService, useValue: { user: () => ({ warehouse_code: '01', username: 'qa' }), token: () => null } },
      ],
    }).compileComponents();
    fix = TestBed.createComponent(TiendaEtiquetasComponent);
    cmp = fix.componentInstance;
    fix.detectChanges();
    await fix.whenStable();
    await new Promise((r) => setTimeout(r, 0));
    fix.detectChanges();
  }
  afterEach(() => history.replaceState(null, ''));

  const heroDe = (sku: string): string | undefined => cmp.queue().find((it) => it.model.sku === sku)?.hero;

  it('⭐ «caja» pone la caja en grande, quita las otras presentaciones y DICE a quién no le tocó', async () => {
    await abrirCon({ codes: ['10001', '10002'], modo: 'caja' });
    expect(heroDe('10001')).toBe('CJA');
    // el 10002 no tiene caja: conserva su precio grande de siempre en vez de imprimir otra cosa
    expect(heroDe('10002')).not.toBe('CJA');
    expect(cmp.sections()).not.toContain('presentaciones');
    const t = cmp.msg()?.text ?? '';
    expect(t).toContain('precio en grande: caja');
    expect(t).toContain('sin caja');
    expect(t).toContain('10002');
  });

  it('«paquete» y «pieza» eligen su presentación', async () => {
    await abrirCon({ codes: ['10001', '10002'], modo: 'paquete' });
    expect(heroDe('10001')).toBe('PAQ');
    expect(heroDe('10002')).toBe('PAQ');
    expect(cmp.msg()?.text ?? '').not.toContain('sin paquete');
  });

  it('⛔ si a NINGÚN producto le toca la presentación pedida, no se le quita nada a la etiqueta: sólo se avisa', async () => {
    await abrirCon({ codes: ['10002'], modo: 'caja' }); // el 10002 no tiene caja
    expect(cmp.msg()?.text ?? '').toContain('sin caja');
    expect(cmp.msg()?.kind).toBe('warn');
    expect(cmp.sections()).toContain('presentaciones'); // sigue mostrando lo que tiene
  });

  it('«todos» no toca nada: mismo precio grande de siempre y «Otras presentaciones» sigue prendido', async () => {
    await abrirCon({ codes: ['10001', '10002'], modo: 'todos' });
    expect(cmp.sections()).toContain('presentaciones');
    expect(cmp.msg()?.text ?? '').not.toContain('precio en grande');
  });

  it('sin modo (llegada vieja) se comporta como «todos»', async () => {
    await abrirCon({ codes: ['10001'] });
    expect(cmp.sections()).toContain('presentaciones');
    // el stub resuelve siempre los dos productos; lo que importa es que SÍ se cargaron
    expect(cmp.queue().length).toBeGreaterThan(0);
  });

  it('⛔ un modo inventado se ignora: el historial del navegador lo puede escribir cualquiera', async () => {
    await abrirCon({ codes: ['10001'], modo: 'granel' });
    expect(cmp.sections()).toContain('presentaciones');
    expect(cmp.msg()?.text ?? '').not.toContain('precio en grande');
  });
});
