import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { Observable, of, throwError } from 'rxjs';
import type { MeContext, MeWork } from '@megadulces/contracts';
import { MiTrabajoComponent } from './mi-trabajo.component';
import { AuthService, JwtPayload } from '../../core/services/auth.service';
import { PermissionsService } from '../../core/services/permissions.service';
import { MeContextService } from '../../core/services/me-context.service';
import { DataScopeService, MyScope } from '../../core/services/data-scope.service';
import { Permission } from '../../core/constants/permissions';

/**
 * `[SN.3]` `[SN.8]` — Lo que la PANTALLA hace por persona, no lo que el mapa devuelve (eso ya lo
 * prueba `suite-map.spec.ts` en `libs/contracts`). Acá se comprueba lo que se vuelve un rebote,
 * una mentira o un callejón sin salida:
 *
 *  · el almacenista con UNA puerta entra directo (paridad con la landing vieja) — y con `stay`
 *    se queda y ve su tarjeta;
 *  · permisos `sin_cargar` pintan skeleton, no "no tienes nada" (ADR-056: dos `{}` distintos);
 *  · cero puertas con permisos cargados = estado DECLARADO, sin el redirect ciego a captures;
 *  · el error de red del contexto es un error, no "Sin puesto asignado";
 *  · el puesto NULL se declara, no se inventa desde el rol;
 *  · las tarjetas son enlaces reales (`<a href>`): teclado, ctrl+clic, botón medio;
 *  · `[SN.8]` lo que está A TU NOMBRE no se mezcla con una cola compartida, una bandeja en cero
 *    no se pinta, y una bandeja que no se pudo contar se DECLARA en vez de bajar a cero.
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

const SIN_TRABAJO: MeWork = { pendientes: [], no_medido: [], medido_at: '2026-09-10T12:00:00.000Z' };

interface Montaje {
  perms?: Permission[];
  role?: string;
  cargado?: boolean;
  ctx$?: Observable<MeContext>;
  scope$?: Observable<MyScope | null>;
  work$?: Observable<MeWork>;
  stay?: boolean;
}

const con = (...p: Permission[]): Record<string, boolean> => Object.fromEntries(p.map((k) => [k, true]));

describe('MiTrabajoComponent · lo que ve cada persona', () => {
  let fix: ComponentFixture<MiTrabajoComponent>;
  let navigate: jest.SpyInstance;
  const html = () => (fix.nativeElement as HTMLElement).textContent ?? '';
  const q = <T extends Element>(sel: string) => (fix.nativeElement as HTMLElement).querySelectorAll<T>(sel);
  /** Tarjetas de ESPACIO (las de pendiente llevan además `.mt-card-work`). */
  const tarjetas = () => q<HTMLAnchorElement>('a.mt-card:not(.mt-card-work)');

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
        {
          provide: MeContextService,
          useValue: {
            mine: () => m.ctx$ ?? of(CTX_BASE),
            work: () => m.work$ ?? of(SIN_TRABAJO),
            reset: jest.fn(),
          },
        },
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

  // ── Puertas ───────────────────────────────────────────────────────────────

  it('el almacenista (RECIBIR + SUPERVISAR) tiene UNA puerta → entra directo a /almacen', async () => {
    await montar({ perms: [Permission.COMMERCIAL_INVENTORY_RECIBIR, Permission.COMMERCIAL_INVENTORY_SUPERVISAR] });
    expect(navigate).toHaveBeenCalledWith(['/almacen']);
  });

  it('…pero si pidió QUEDARSE (state.stay) no navega, y ve su tarjeta con los módulos que sí abre', async () => {
    await montar({ perms: [Permission.COMMERCIAL_INVENTORY_RECIBIR, Permission.COMMERCIAL_INVENTORY_SUPERVISAR], stay: true });
    expect(navigate).not.toHaveBeenCalled();
    const cards = tarjetas();
    expect(cards.length).toBe(1);
    expect(cards[0].textContent).toContain('Almacén');
    expect(cards[0].textContent).toContain('Recepción');
    // Es un enlace de verdad: href puesto por routerLink.
    expect(cards[0].getAttribute('href')).toBe('/almacen');
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
    expect(tarjetas().length).toBe(0);
  });

  it('el admin de plataforma ve los 6 espacios (4 activos + 2 propuestos con su P-xx) y los planned sólo declarados', async () => {
    await montar({ perms: [], role: 'superadmin' });
    expect(navigate).not.toHaveBeenCalled();
    // 6 espacios de la suite + el espacio propio "Mi trabajo".
    expect(q('section.mt-space').length).toBe(7);
    expect(q('#espacio-mi-trabajo').length).toBe(1);
    expect(html()).toContain('Propuesta · P-03');
    expect(html()).toContain('Propuesta · P-06');
    expect(html()).toContain('Configuración de la suite');
    // Los planned no son sección: son una línea al pie.
    expect(q('#espacio-recursos-humanos').length).toBe(0);
    expect(html()).toContain('Espacios del mapa sin funciones todavía');
    expect(html()).toContain('Operación por zonas');
    expect(html()).toContain('Recursos Humanos');
    // Con ≥3 espacios aparecen los atajos (uno por espacio de la suite).
    expect(q('a.mt-chip').length).toBe(6);
  });

  it('el vendedor no ve el back-office de Ventas aunque tenga la clave', async () => {
    await montar({ perms: [Permission.COMMERCIAL_ORDERS_VER, Permission.COMMERCIAL_EXPIRY_VER], role: 'vendedor', stay: true });
    const hrefs = Array.from(tarjetas()).map((a) => a.getAttribute('href'));
    expect(hrefs).not.toContain('/comercial');
    // …pero sí lo que sí es suyo (caducidades abre Punto de Venta y Almacén).
    expect(hrefs).toEqual(expect.arrayContaining(['/tienda', '/almacen']));
    expect(html()).toContain('Punto de Venta');
  });

  it('la línea de contenido lista los módulos de ESA persona, con +N cuando hay más', async () => {
    await montar({ perms: [], role: 'superadmin' });
    const finanzas = Array.from(tarjetas()).find((a) => a.getAttribute('href') === '/finanzas');
    expect(finanzas).toBeTruthy();
    expect(finanzas!.textContent).toMatch(/Bancos/);
    expect(finanzas!.textContent).toMatch(/· \+\d+/);
  });

  // ── Mi contexto ───────────────────────────────────────────────────────────

  it('Mi contexto: nombre en la cabecera, puesto, área, alcance (de me/scope) y periodo', async () => {
    await montar({ perms: [Permission.COMMERCIAL_INVENTORY_RECIBIR], stay: true });
    expect(html()).toContain('Persona de Prueba');
    expect(html()).toContain('Almacenista');
    expect(html()).toContain('8 ESQUINAS');
    expect(html()).toContain('todas las zonas');
    expect(html()).toMatch(/Periodo/);
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
    expect(tarjetas().length).toBe(1);
  });

  it('la cabecera de Dirección NO se estrena: lo pendiente se declara con sus P-xx', async () => {
    await montar({ perms: [], role: 'superadmin' });
    expect(html()).not.toContain('Esto ve Dirección General');
    expect(html()).toContain('pendiente de definición');
    expect(html()).toContain('P-06');
    expect(html()).toContain('P-01');
    expect(html()).toContain('P-11');
  });

  // ── [SN.8] Mi trabajo: pendientes ─────────────────────────────────────────

  it('lo que está A TU NOMBRE no se mezcla con la cola compartida', async () => {
    await montar({
      perms: [Permission.COMMERCIAL_INVENTORY_RECIBIR], stay: true,
      work$: of({
        medido_at: '2026-09-10T12:00:00.000Z',
        no_medido: [],
        pendientes: [
          { id: 'cuadre', label: 'Descuadres por revisar', detalle: 'caja e inventario', ruta: '/almacen/cuadre', icono: 'pi pi-flag', total: 1865, alcance: 'bandeja' },
          { id: 'conteos-asignados', label: 'Conteos de inventario asignados a ti', detalle: 'sesiones abiertas', ruta: '/almacen/inventory/count', icono: 'pi pi-list-check', total: 2, alcance: 'mio' },
        ],
      } satisfies MeWork),
    });
    expect(html()).toContain('A tu nombre');
    expect(html()).toContain('En tus bandejas');
    // El "a tu nombre" va primero y se marca distinto.
    const work = q<HTMLAnchorElement>('a.mt-card-work');
    expect(work.length).toBe(2);
    expect(work[0].classList).toContain('is-mine');
    expect(work[0].getAttribute('href')).toBe('/almacen/inventory/count');
    expect(work[1].classList).not.toContain('is-mine');
    expect(work[1].textContent).toContain('1865');
    // La cola compartida se declara como tal: nadie la tiene asignada.
    expect(html()).toContain('nadie las tiene asignadas');
  });

  it('sin pendientes → se dice, no se pintan cajas en cero', async () => {
    await montar({ perms: [Permission.COMMERCIAL_INVENTORY_RECIBIR], stay: true });
    expect(q('a.mt-card-work').length).toBe(0);
    expect(html()).toContain('No tienes pendientes en las bandejas a las que tienes acceso');
    expect(html()).not.toContain('A tu nombre');
  });

  it('una bandeja que no se pudo contar se DECLARA, no baja a cero', async () => {
    await montar({
      perms: [Permission.COMMERCIAL_INVENTORY_RECIBIR], stay: true,
      work$: of({
        medido_at: '2026-09-10T12:00:00.000Z',
        pendientes: [],
        no_medido: [{ id: 'cuadre', label: 'Descuadres por revisar', motivo: 'relation does not exist' }],
      } satisfies MeWork),
    });
    expect(html()).toContain('Sin medir');
    expect(html()).toContain('Descuadres por revisar');
    expect(html()).toContain('no se muestra en cero');
  });

  it('error al consultar el trabajo → error, no "no tienes pendientes"', async () => {
    await montar({ perms: [Permission.COMMERCIAL_INVENTORY_RECIBIR], stay: true, work$: throwError(() => ({ status: 500 })) });
    expect(html()).toContain('No se pudo consultar tu trabajo pendiente');
    expect(html()).not.toContain('No tienes pendientes');
  });
});
