import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, UrlTree, provideRouter } from '@angular/router';
import { signal } from '@angular/core';
import { of, Subject, throwError } from 'rxjs';
import { Permission } from '../../../core/constants/permissions';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { DataScopeService } from '../../../core/services/data-scope.service';
import { DesktopNoticeService } from '../../../core/services/desktop-notice.service';
import { FindingsService } from '../../finanzas/findings.service';
import { ActionsService } from '../../finanzas/actions.service';
import { ServiceDeskService } from '../../servicio/service-desk.service';
import { EtiquetasService } from '../../tienda/etiquetas.service';
import { ComprasService, type PorAprobarResumen } from '../../compras/compras.service';
import { AlertsSocketService } from '../command-center/alerts-socket.service';
import { NotificationsBellComponent } from './notifications-bell.component';

/**
 * `[PQ.35]` A quien autoriza compras le avisa la campana cuando llega una requisición (Edgar,
 * 2026-10-29: «ella es la única que puede aceptar»). La fuente es la lista de pendientes, no una
 * tabla de avisos; el aviso de Windows sale sólo si la pestaña no se ve.
 */
const rq = (id: string, folio: string): PorAprobarResumen['recientes'][number] => ({
  id, folio, created_at: '2026-10-29T18:00:00Z', total_cost: 12500, sucursal: 'Morelia Abastos',
  que: 'CUERITOS FRYEN', pidio: 'aide piceno', de_sucursal: false,
});
const resumen = (...xs: PorAprobarResumen['recientes']): PorAprobarResumen => ({ n: xs.length, monto: xs.length * 12500, recientes: xs });

describe('NotificationsBellComponent · requisiciones por aprobar', () => {
  let fix: ComponentFixture<NotificationsBellComponent>;
  let porAprobar: ReturnType<typeof vi.fn>;
  let mostrar: ReturnType<typeof vi.fn>;
  const root = (): HTMLElement => fix.nativeElement as HTMLElement;
  const tick = async (): Promise<void> => { await fix.whenStable(); await new Promise((r) => setTimeout(r, 0)); fix.detectChanges(); };
  const poll = async (): Promise<void> => { (fix.componentInstance as unknown as { pollRequisiciones(): void }).pollRequisiciones(); await tick(); };

  async function montar(permisos: string[], respuestas: PorAprobarResumen[] | 'error', admin = false): Promise<void> {
    const cola = respuestas === 'error' ? [] : [...respuestas];
    let ultima = resumen();
    // Cada lectura toma la siguiente respuesta; agotada la cola, repite la última (abrir la campana
    // vuelve a leer, y en la vida real la bandeja no se vacía por mirarla).
    porAprobar = vi.fn(() => (respuestas === 'error' ? throwError(() => new Error('red')) : of(ultima = cola.shift() ?? ultima)));
    mostrar = vi.fn(() => true);
    const has = (p: string) => permisos.includes(p);
    await TestBed.configureTestingModule({
      imports: [NotificationsBellComponent],
      providers: [
        provideRouter([]),
        { provide: AlertsSocketService, useValue: { connect: vi.fn(), alert$: new Subject(), connected: signal(true) } },
        { provide: FindingsService, useValue: { stats: () => of({}) } },
        { provide: ActionsService, useValue: { stats: () => of({}) } },
        { provide: AuthService, useValue: { user: () => ({ permissions: {} }) } },
        { provide: PermissionsService, useValue: { has, hasAny: (...p: string[]) => p.some(has), isAdmin: () => admin } },
        { provide: DataScopeService, useValue: { dim: () => of(null) } },
        { provide: ServiceDeskService, useValue: { notifications: () => of([]) } },
        { provide: EtiquetasService, useValue: { notices: () => of([]) } },
        { provide: ComprasService, useValue: { porAprobar } },
        { provide: DesktopNoticeService, useValue: { permiso: signal('granted'), mostrar, solicitar: vi.fn() } },
      ],
    }).compileComponents();
    fix = TestBed.createComponent(NotificationsBellComponent);
    fix.detectChanges();
    await tick();
  }
  afterEach(() => fix?.destroy());

  it('⭐ el contador de la campana dice cuántas esperan, y su renglón lleva a donde se aprueban', async () => {
    await montar([Permission.COMPRAS_REQUISICIONES_AUTORIZAR], [resumen(rq('a', 'RQ-2026-01800'), rq('b', 'RQ-2026-01801'))]);
    expect(porAprobar).toHaveBeenCalledTimes(1);
    expect(fix.componentInstance.attentionCount()).toBe(2);
    (root().querySelector('button[aria-label="Notificaciones"]') as HTMLButtonElement).click();
    await tick();
    const enlace = Array.from(root().querySelectorAll('a')).find((a) => /por aprobar/.test(a.textContent ?? '')) as HTMLAnchorElement;
    expect(enlace.textContent).toContain('2 requisición(es) por aprobar');
    expect(enlace.getAttribute('href')).toBe('/compras/pedido?lo_pedido=1');
  });

  it('⭐ una requisición NUEVA entra al feed con folio, sucursal, qué y quién la mandó; y sale el aviso de Windows si la pestaña no se ve', async () => {
    await montar([Permission.COMPRAS_REQUISICIONES_AUTORIZAR], [resumen(), resumen(rq('n', 'RQ-2026-01900'))]);
    const vis = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await poll();
    vis.mockRestore();
    expect(mostrar).toHaveBeenCalledTimes(1);
    expect(mostrar.mock.calls[0][0]).toBe('Requisición por aprobar · RQ-2026-01900');
    expect(mostrar.mock.calls[0][1]).toContain('Morelia Abastos · CUERITOS FRYEN');
    expect(mostrar.mock.calls[0][1]).toContain('la mandó aide piceno');
    // al tocar el aviso de Windows, lleva a «Lo pedido»
    const router = TestBed.inject(Router);
    const navegar = vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);
    (mostrar.mock.calls[0][2] as () => void)();
    expect(router.serializeUrl(navegar.mock.calls[0][0] as UrlTree)).toBe('/compras/pedido?lo_pedido=1');
  });

  it('NEGATIVA: lo que ya estaba pendiente al abrir la Suite NO dispara avisos (lo dice el contador)', async () => {
    await montar([Permission.COMPRAS_REQUISICIONES_AUTORIZAR], [resumen(rq('a', 'RQ-1'))]);
    expect(mostrar).not.toHaveBeenCalled();
    expect(fix.componentInstance.feed().length).toBe(0);
  });

  it('NEGATIVA: con la pestaña a la vista no sale el aviso de Windows (basta la campana)', async () => {
    await montar([Permission.COMPRAS_REQUISICIONES_AUTORIZAR], [resumen(), resumen(rq('n', 'RQ-2'))]);
    const vis = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    await poll();
    vis.mockRestore();
    expect(mostrar).not.toHaveBeenCalled();
    expect(fix.componentInstance.feed().length).toBe(1);
  });

  it('NEGATIVA: sin la clave no se pregunta nada, ni siquiera siendo superadmin (8 personas recibirían ruido)', async () => {
    await montar([], [resumen(rq('a', 'RQ-1'))], true);
    expect(porAprobar).not.toHaveBeenCalled();
  });

  it('NEGATIVA: si el servidor no responde, el contador dice «sin medir», nunca 0', async () => {
    await montar([Permission.COMPRAS_REQUISICIONES_AUTORIZAR], 'error');
    expect(fix.componentInstance.rqN()).toBeNull();
    (root().querySelector('button[aria-label="Notificaciones"]') as HTMLButtonElement).click();
    await tick();
    expect(root().textContent).toContain('Requisiciones: sin medir');
  });
});
