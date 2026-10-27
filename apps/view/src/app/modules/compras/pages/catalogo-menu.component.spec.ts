import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { CATALOGO_TABS } from '../catalogo-tabs';
import { CATALOGO_OCULTAS, CatalogoMenuComponent, gruposDelMenu, opcionActual } from './catalogo-menu.component';

/**
 * El menú «Ver» del catálogo: reemplaza la fila de pestañas. Lo que se defiende: agrupa por para qué sirve,
 * NO ofrece las cuatro pantallas vacías, respeta el permiso igual que app-page-tabs (Costos sólo con permiso
 * de costo), no pierde una pestaña nueva que nadie agrupó, y se maneja con teclado.
 */
@Component({ standalone: true, template: '' })
class VaciaComponent {}

const todas = () => true;
const etiquetas = (g: ReturnType<typeof gruposDelMenu>) => g.map((x) => [x.titulo, x.opciones.map((o) => o.label)]);

describe('gruposDelMenu', () => {
  it('⭐ agrupa en Productos · Precios y costos · Por corregir, cada opción con su descripción', () => {
    const g = gruposDelMenu(CATALOGO_TABS, todas);
    expect(etiquetas(g)).toEqual([
      ['Productos', ['Productos', 'Productos nuevos']],
      ['Precios y costos', ['Precios', 'Costos', 'Reportes']],
      ['Por corregir', ['Códigos', 'No registrados', 'Mantenimiento']],
    ]);
    expect(g[0].opciones[0].descripcion).toBe('Buscar un producto, sus unidades y precio');
    expect(g.flatMap((x) => x.opciones).every((o) => !!o.descripcion)).toBe(true);
  });

  it('⛔ no ofrece las cuatro vacías: Resumen, Solicitudes, Incidencias, Listas de precios', () => {
    const rutas = gruposDelMenu(CATALOGO_TABS, todas).flatMap((x) => x.opciones.map((o) => o.route));
    for (const r of CATALOGO_OCULTAS) expect(rutas).not.toContain(r);
    const labels = gruposDelMenu(CATALOGO_TABS, todas).flatMap((x) => x.opciones.map((o) => o.label));
    for (const l of ['Resumen', 'Solicitudes', 'Incidencias', 'Listas de precios']) expect(labels).not.toContain(l);
  });

  it('respeta el permiso: sin el del costo, Costos no aparece (y un grupo sin opciones no se pinta)', () => {
    const g = gruposDelMenu(CATALOGO_TABS, (t) => t.permission !== Permission.COMPRAS_COSTO_ESTANDAR_VER);
    expect(g[1].opciones.map((o) => o.label)).toEqual(['Precios', 'Reportes']);
    expect(gruposDelMenu(CATALOGO_TABS, () => false)).toEqual([]);
  });

  it('una pestaña nueva que nadie agrupó no se pierde: cae en «Más»', () => {
    const g = gruposDelMenu([...CATALOGO_TABS, { label: 'Nueva', route: '/compras/catalogo/nueva' }], todas);
    expect(g[g.length - 1]).toEqual({ titulo: 'Más', opciones: [{ label: 'Nueva', route: '/compras/catalogo/nueva', descripcion: null }] });
  });

  it('la opción actual: la ruta exacta, o la más larga que la contiene (sin query)', () => {
    const ops = gruposDelMenu(CATALOGO_TABS, todas).flatMap((x) => x.opciones);
    expect(opcionActual(ops, '/compras/catalogo')?.label).toBe('Productos');
    expect(opcionActual(ops, '/compras/catalogo/precios?suc=01')?.label).toBe('Precios');
    expect(opcionActual(ops, '/compras/catalogo/costos/123')?.label).toBe('Costos');
    expect(opcionActual(ops, '/otra')).toBeNull();
  });
});

describe('CatalogoMenuComponent', () => {
  async function montar(permisos: Record<string, boolean>, admin = false) {
    await TestBed.configureTestingModule({
      imports: [CatalogoMenuComponent],
      providers: [
        provideRouter([{ path: '**', component: VaciaComponent }]),
        { provide: AuthService, useValue: { user: () => ({ sub: 'u-1', permissions: permisos }) } },
        { provide: PermissionsService, useValue: { isAdmin: () => admin, has: () => true } },
      ],
    }).compileComponents();
    await TestBed.inject(Router).navigateByUrl('/compras/catalogo');
    const fix = TestBed.createComponent(CatalogoMenuComponent);
    fix.detectChanges();
    await fix.whenStable();
    fix.detectChanges();
    return fix;
  }
  afterEach(() => TestBed.resetTestingModule());
  const txt = (e: Element | null) => (e?.textContent ?? '').replace(/\s+/g, ' ').trim();

  it('⭐ botón «Ver: Productos», con aria-haspopup/expanded; al abrir pinta los grupos y marca la actual', async () => {
    const fix = await montar({ [Permission.COMMERCIAL_PRODUCTS_VER]: true });
    const el = fix.nativeElement as HTMLElement;
    const btn = el.querySelector('.cm-btn') as HTMLButtonElement;
    expect(txt(btn.querySelector('.cm-eti'))).toBe('Ver');
    expect(txt(btn.querySelector('.cm-actual'))).toBe('Productos');
    expect(btn.getAttribute('aria-haspopup')).toBe('menu');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    btn.click();
    fix.detectChanges();
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(Array.from(el.querySelectorAll('.cm-g')).map(txt)).toEqual(['Productos', 'Precios y costos', 'Por corregir']);
    expect(txt(el.querySelector('.cm-op.is-on b'))).toBe('Productos');
    expect(el.querySelector('.cm-op.is-on')?.getAttribute('aria-current')).toBe('page');
  });

  it('respeta el permiso como app-page-tabs: sin permiso de costo no hay Costos; manage:all ve todo', async () => {
    const sin = await montar({ [Permission.COMMERCIAL_PRODUCTS_VER]: true });
    (sin.nativeElement.querySelector('.cm-btn') as HTMLButtonElement).click();
    sin.detectChanges();
    expect(Array.from(sin.nativeElement.querySelectorAll('.cm-op b')).map(txt)).not.toContain('Costos');
    TestBed.resetTestingModule();
    const admin = await montar({}, true);
    (admin.nativeElement.querySelector('.cm-btn') as HTMLButtonElement).click();
    admin.detectChanges();
    expect(Array.from(admin.nativeElement.querySelectorAll('.cm-op b')).map(txt)).toContain('Costos');
  });

  it('⭐ teclado: flechas recorren, Esc cierra y devuelve el foco al botón; clic fuera cierra', async () => {
    const fix = await montar({ [Permission.COMMERCIAL_PRODUCTS_VER]: true });
    const el = fix.nativeElement as HTMLElement;
    document.body.appendChild(el);
    const btn = el.querySelector('.cm-btn') as HTMLButtonElement;
    btn.click();
    fix.detectChanges();
    await new Promise((r) => setTimeout(r));
    const ops = Array.from(el.querySelectorAll('.cm-op')) as HTMLElement[];
    expect(document.activeElement).toBe(ops[0]);
    const menu = el.querySelector('.cm-menu') as HTMLElement;
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(ops[1]);
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(document.activeElement).toBe(ops[ops.length - 1]);
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fix.detectChanges();
    expect(el.querySelector('.cm-menu')).toBeNull();
    expect(document.activeElement).toBe(btn);
    btn.click();
    fix.detectChanges();
    document.body.click();
    fix.detectChanges();
    expect(el.querySelector('.cm-menu')).toBeNull();
    el.remove();
  });

  it('elegir una opción navega a su ruta y cierra', async () => {
    const fix = await montar({ [Permission.COMMERCIAL_PRODUCTS_VER]: true });
    const router = TestBed.inject(Router);
    (fix.nativeElement.querySelector('.cm-btn') as HTMLButtonElement).click();
    fix.detectChanges();
    const precios = Array.from(fix.nativeElement.querySelectorAll('.cm-op') as NodeListOf<HTMLAnchorElement>).find((a) => txt(a.querySelector('b')) === 'Precios')!;
    expect(precios.getAttribute('href')).toBe('/compras/catalogo/precios');
    precios.click();
    await fix.whenStable();
    fix.detectChanges();
    expect(router.url).toBe('/compras/catalogo/precios');
    expect(fix.nativeElement.querySelector('.cm-menu')).toBeNull();
    expect(txt(fix.nativeElement.querySelector('.cm-actual'))).toBe('Precios');
  });
});
