import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { Observable, of, throwError } from 'rxjs';
import type { MeContext } from '@megadulces/contracts';
import { MiTrabajoComponent } from './mi-trabajo.component';
import { AuthService, JwtPayload } from '../../core/services/auth.service';
import { PermissionsService } from '../../core/services/permissions.service';
import { MeContextService } from '../../core/services/me-context.service';
import { DataScopeService, MyScope } from '../../core/services/data-scope.service';
import { Permission } from '../../core/constants/permissions';

/**
 * `[SN.3]` — Lo que la PANTALLA hace por persona, no lo que el mapa devuelve (eso ya lo prueba
 * `suite-map.spec.ts` en `libs/contracts`). Acá se comprueba lo que se vuelve un rebote, una
 * mentira o un callejón sin salida:
 *
 *  · el almacenista con UNA puerta entra directo (paridad con la landing vieja) — y con `stay`
 *    se queda y ve su fila;
 *  · permisos `sin_cargar` pintan skeleton, no "no tienes nada" (ADR-056: dos `{}` distintos);
 *  · cero puertas con permisos cargados = estado DECLARADO, sin el redirect ciego a captures;
 *  · el error de red del contexto es un error, no "Sin puesto asignado";
 *  · el puesto NULL se declara, no se inventa desde el rol;
 *  · las filas son enlaces reales (`<a href>`): teclado, ctrl+clic, botón medio.
 */

const CTX_BASE: MeContext = {
  user_id: 'u1',
  username: 'qa',
  nombre: 'Persona de Prueba',
  role_name: 'almacenista',
  kind: 'interno',
  warehouse_code: '03',
  zona: null,
  department: { code: 'almacen', name: 'Almacén' },
  position: { code: 'almacenista', name: 'Almacenista' },
};

const SCOPE_BASE: MyScope = {
  user_id: 'u1',
  role_name: 'almacenista',
  dimensions: {
    warehouse: { mode: 'own', modeWrite: 'own', source: 'role', options: [{ value: '03', label: '8 ESQUINAS' }] },
    zone: { mode: 'all', modeWrite: 'all', source: 'role', options: [] },
  },
};

interface Montaje {
  perms?: Permission[];
  role?: string;
  cargado?: boolean;
  ctx$?: Observable<MeContext>;
  scope$?: Observable<MyScope | null>;
  stay?: boolean;
}

const con = (...p: Permission[]): Record<string, boolean> => Object.fromEntries(p.map((k) => [k, true]));

describe('MiTrabajoComponent · lo que ve cada persona', () => {
  let fix: ComponentFixture<MiTrabajoComponent>;
  let navigate: jest.SpyInstance;
  const html = () => (fix.nativeElement as HTMLElement).textContent ?? '';
  const q = <T extends Element>(sel: string) => (fix.nativeElement as HTMLElement).querySelectorAll<T>(sel);

  async function montar(m: Montaje = {}) {
    const permisos = con(...(m.perms ?? []));
    const role = m.role ?? 'almacenista';
    const user = signal<JwtPayload | null>({ sub: 'u1', username: 'qa', role_name: role, permissions: permisos, exp: 0, iat: 0 });
    const perms = new PermissionsService();
    if (m.cargado !== false) perms.load(permisos, role, 'jwt');

    if (m.stay) window.history.replaceState({ stay: true }, '', '/projects');
    else window.history.replaceState(null, '', '/projects');

    await TestBed.configureTestingModule({
      imports: [MiTrabajoComponent],
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: AuthService, useValue: { user, logout: jest.fn() } },
        { provide: PermissionsService, useValue: perms },
        { provide: MeContextService, useValue: { mine: () => m.ctx$ ?? of(CTX_BASE), reset: jest.fn() } },
        { provide: DataScopeService, useValue: { mine: () => m.scope$ ?? of(SCOPE_BASE) } },
      ],
    }).compileComponents();

    const router = TestBed.inject(Router);
    navigate = jest.spyOn(router, 'navigate').mockResolvedValue(true);
    fix = TestBed.createComponent(MiTrabajoComponent);
    fix.detectChanges();
    await fix.whenStable();
    fix.detectChanges();
  }

  afterEach(() => {
    window.history.replaceState(null, '', '/');
  });

  it('el almacenista (RECIBIR + SUPERVISAR) tiene UNA puerta → entra directo a /almacen', async () => {
    await montar({ perms: [Permission.COMMERCIAL_INVENTORY_RECIBIR, Permission.COMMERCIAL_INVENTORY_SUPERVISAR] });
    expect(navigate).toHaveBeenCalledWith(['/almacen']);
  });

  it('…pero si pidió QUEDARSE (state.stay) no navega, y ve su fila con los módulos que sí abre', async () => {
    await montar({ perms: [Permission.COMMERCIAL_INVENTORY_RECIBIR, Permission.COMMERCIAL_INVENTORY_SUPERVISAR], stay: true });
    expect(navigate).not.toHaveBeenCalled();
    const filas = q<HTMLAnchorElement>('a.mt-row');
    expect(filas.length).toBe(1);
    expect(filas[0].textContent).toContain('Almacén');
    expect(filas[0].textContent).toContain('Recepción');
    // Es un enlace de verdad: href puesto por routerLink.
    expect(filas[0].getAttribute('href')).toBe('/almacen');
    // Y no ofrece lo que no puede abrir.
    expect(html()).not.toContain('Compras');
  });

  it('permisos sin_cargar → skeleton, NO "no tienes nada", y no navega', async () => {
    await montar({ perms: [], cargado: false });
    expect(q('.ls-sk').length).toBeGreaterThan(0);
    expect(html()).not.toContain('Tu cuenta no tiene ningún espacio');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('cero puertas con permisos cargados → estado DECLARADO con salida, sin redirect a captures', async () => {
    await montar({ perms: [], role: 'piso_tienda' });
    expect(navigate).not.toHaveBeenCalled();
    expect(html()).toContain('Tu cuenta no tiene ningún espacio asignado');
    expect(html()).toContain('qa (piso_tienda)');
    expect(html()).toContain('Cerrar sesión');
  });

  it('la cuenta de kiosco (HR_ATTENDANCE_CHECAR, sin pantalla) cae al estado declarado', async () => {
    await montar({ perms: [Permission.HR_ATTENDANCE_CHECAR], role: 'checador_kiosco' });
    expect(navigate).not.toHaveBeenCalled();
    expect(html()).toContain('Tu cuenta no tiene ningún espacio asignado');
    expect(q('a.mt-row').length).toBe(0);
  });

  it('el admin de plataforma ve los 6 espacios (4 activos + 2 propuestos con su P-xx) y los planned sólo declarados', async () => {
    await montar({ perms: [], role: 'superadmin' });
    expect(navigate).not.toHaveBeenCalled();
    expect(q('section.mt-space').length).toBe(6);
    expect(html()).toContain('Propuesta · P-03');
    expect(html()).toContain('Propuesta · P-06');
    expect(html()).toContain('Configuración de la suite');
    // Los planned no son sección: son una línea al pie.
    expect(q('#espacio-recursos-humanos').length).toBe(0);
    expect(html()).toContain('Espacios del mapa sin funciones todavía');
    expect(html()).toContain('Operación por zonas');
    expect(html()).toContain('Recursos Humanos');
    // Con ≥3 espacios aparecen los atajos.
    expect(q('a.mt-chip').length).toBe(6);
  });

  it('el vendedor no ve el back-office de Ventas aunque tenga la clave', async () => {
    await montar({ perms: [Permission.COMMERCIAL_ORDERS_VER, Permission.COMMERCIAL_EXPIRY_VER], role: 'vendedor', stay: true });
    const hrefs = Array.from(q<HTMLAnchorElement>('a.mt-row')).map((a) => a.getAttribute('href'));
    expect(hrefs).not.toContain('/comercial');
    // …pero sí lo que sí es suyo (caducidades abre Punto de Venta y Almacén).
    expect(hrefs).toEqual(expect.arrayContaining(['/tienda', '/almacen']));
    expect(html()).toContain('Punto de Venta');
  });

  it('la línea secundaria lista los módulos de ESA persona, con +N cuando hay más de 5', async () => {
    await montar({ perms: [], role: 'superadmin' });
    const finanzas = Array.from(q<HTMLAnchorElement>('a.mt-row')).find((a) => a.getAttribute('href') === '/finanzas');
    expect(finanzas).toBeTruthy();
    expect(finanzas!.textContent).toMatch(/Bancos/);
    expect(finanzas!.textContent).toMatch(/· \+\d+/);
  });

  it('Mi contexto: persona, puesto, alcance (de me/scope) y periodo', async () => {
    await montar({ perms: [Permission.COMMERCIAL_INVENTORY_RECIBIR], stay: true });
    expect(html()).toContain('Persona de Prueba');
    expect(html()).toContain('Almacenista');
    expect(html()).toContain('Sucursales: 8 ESQUINAS');
    expect(html()).toContain('Zonas: todas las zonas');
    expect(html()).toContain('Ficha: sucursal 03');
    expect(html()).toMatch(/Periodo/);
    expect(html()).toContain('corte por definir (P-11)');
  });

  it('puesto NULL → "Sin puesto asignado" (declarado, nunca derivado del rol)', async () => {
    await montar({ perms: [Permission.COMMERCIAL_INVENTORY_RECIBIR], stay: true, ctx$: of({ ...CTX_BASE, position: null, department: null }) });
    expect(html()).toContain('Sin puesto asignado');
    expect(html()).not.toContain('Almacenista');
  });

  it('alcance no resoluble se declara como "sin determinar", no como "sin alcance"', async () => {
    await montar({
      perms: [Permission.COMMERCIAL_INVENTORY_RECIBIR], stay: true,
      scope$: of({ ...SCOPE_BASE, dimensions: { warehouse: { mode: 'own', modeWrite: 'own', source: 'role', options: [], resolvable: false } } }),
    });
    expect(html()).toContain('sin determinar (ficha incompleta)');
    expect(html()).not.toContain('sin alcance');
  });

  it('error de red en el contexto → banner de error, NUNCA "Sin puesto asignado"', async () => {
    await montar({ perms: [Permission.COMMERCIAL_INVENTORY_RECIBIR], stay: true, ctx$: throwError(() => ({ status: 0 })) });
    expect(html()).toContain('No se pudo cargar tu contexto');
    expect(html()).toContain('Sin conexión');
    expect(html()).not.toContain('Sin puesto asignado');
    // Y la operación sigue disponible: el contexto caído no esconde las puertas.
    expect(q('a.mt-row').length).toBe(1);
  });

  it('la cabecera de Dirección NO se estrena: lo pendiente se declara con sus P-xx', async () => {
    await montar({ perms: [], role: 'superadmin' });
    expect(html()).not.toContain('Esto ve Dirección General');
    expect(html()).toContain('Pendiente de definición');
    expect(html()).toContain('P-06');
    expect(html()).toContain('P-01');
  });
});
