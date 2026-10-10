import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { signal } from '@angular/core';
import { of, Subject, throwError } from 'rxjs';
import type { PriceChangeNoticeDto } from '@megadulces/contracts';
import { Permission } from '../../../core/constants/permissions';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { DataScopeService } from '../../../core/services/data-scope.service';
import { FindingsService } from '../../finanzas/findings.service';
import { ActionsService } from '../../finanzas/actions.service';
import { ServiceDeskService } from '../../servicio/service-desk.service';
import { EtiquetasService } from '../../tienda/etiquetas.service';
import { AlertsSocketService } from '../command-center/alerts-socket.service';
import { NotificationsBellComponent } from './notifications-bell.component';

/**
 * `[ETQ-AVISOS.2]` La campana recoge los avisos de cambios de precio — y sólo los pide quien
 * puede verlos. El servidor ya recorta por plaza; acá se prueba la entrega, no el alcance.
 */
const aviso = (id: string, creado: string, extra: Partial<PriceChangeNoticeDto> = {}): PriceChangeNoticeDto => ({
  id, plaza: '01', plaza_nombre: 'Padre Hidalgo', fecha: '2026-10-08', corte: 'manana', origen: 'auto',
  productos: 47, suben: 30, bajan: 15, sin_precio: 2, nota: null, enviado_por: null, created_at: creado, ...extra,
});

describe('NotificationsBellComponent · avisos de cambios de precio', () => {
  let fix: ComponentFixture<NotificationsBellComponent>;
  let notices: ReturnType<typeof vi.fn>;
  const root = (): HTMLElement => fix.nativeElement as HTMLElement;
  const tick = async (): Promise<void> => {
    await fix.whenStable();
    await new Promise((r) => setTimeout(r, 0));
    fix.detectChanges();
  };

  async function montar(permisos: string[], respuestas: PriceChangeNoticeDto[][] | 'error' = []): Promise<void> {
    const cola = respuestas === 'error' ? [] : [...respuestas];
    notices = vi.fn(() => (respuestas === 'error' ? throwError(() => new Error('red')) : of(cola.shift() ?? [])));
    const has = (p: string) => permisos.includes(p);
    await TestBed.configureTestingModule({
      imports: [NotificationsBellComponent],
      providers: [
        provideRouter([]),
        { provide: AlertsSocketService, useValue: { connect: vi.fn(), alert$: new Subject(), connected: signal(true) } },
        { provide: FindingsService, useValue: { stats: () => of({}) } },
        { provide: ActionsService, useValue: { stats: () => of({}) } },
        { provide: AuthService, useValue: { user: () => ({ permissions: {} }) } },
        { provide: PermissionsService, useValue: { has, hasAny: (...p: string[]) => p.some(has), isAdmin: () => false } },
        { provide: DataScopeService, useValue: { dim: () => of(null) } },
        { provide: ServiceDeskService, useValue: { notifications: () => of([]) } },
        { provide: EtiquetasService, useValue: { notices } },
      ],
    }).compileComponents();
    fix = TestBed.createComponent(NotificationsBellComponent);
    fix.detectChanges();
    await tick();
  }

  const abrir = async (): Promise<void> => {
    (root().querySelector('button[aria-label="Notificaciones"]') as HTMLButtonElement).click();
    await tick();
  };

  it('⭐ quien ve la etiquetera recibe el aviso en su campana, con la tienda, el resumen y el enlace', async () => {
    await montar([Permission.STORE_LABELS_VER], [[aviso('a', '2026-10-09T13:30:00Z')]]);
    expect(notices).toHaveBeenCalledWith(undefined);
    await abrir();
    const t = root().textContent ?? '';
    expect(t).toContain('Cambios de precio · Padre Hidalgo');
    expect(t).toContain('47 productos cambiaron de precio');
    const navegar = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    const item = Array.from(root().querySelectorAll('li button')).find((b) => /Cambios de precio/.test(b.textContent ?? '')) as HTMLButtonElement;
    item.click();
    expect(navegar).toHaveBeenCalledWith('/tienda/etiquetas/cambios?plaza=01&fecha=2026-10-08');
  });

  it('⛔ quien NO puede ver la etiquetera ni siquiera los pide (evita un 403 por cada ciclo)', async () => {
    await montar([]);
    expect(notices).not.toHaveBeenCalled();
  });

  it('un aviso que ya se vio no se duplica, y el segundo poll pide sólo lo posterior', async () => {
    const a = aviso('a', '2026-10-09T13:30:00Z');
    await montar([Permission.STORE_LABELS_VER], [[a], [a, aviso('b', '2026-10-09T19:00:00Z', { corte: 'tarde', fecha: '2026-10-09' })]]);
    // simula el siguiente ciclo del poll
    (fix.componentInstance as unknown as { pollPrecios(): void }).pollPrecios();
    await tick();
    expect(notices).toHaveBeenLastCalledWith('2026-10-09T13:30:00Z');
    await abrir();
    const filas = Array.from(root().querySelectorAll('li button')).filter((b) => /Cambios de precio/.test(b.textContent ?? ''));
    expect(filas).toHaveLength(2); // a una sola vez + b
  });

  it('el aviso de Compras se distingue del automático y lleva la nota', async () => {
    await montar([Permission.STORE_LABELS_VER], [[aviso('c', '2026-10-09T15:00:00Z', {
      origen: 'compras', corte: 'compras', enviado_por: 'Ana Compras', nota: 'Reimprime primero la caja',
    })]]);
    await abrir();
    const t = root().textContent ?? '';
    expect(t).toContain('Compras te mandó los cambios de precio');
    expect(t).toContain('Reimprime primero la caja');
  });

  it('si el servidor no responde la campana no se rompe y sigue funcionando', async () => {
    await montar([Permission.STORE_LABELS_VER], 'error');
    await abrir();
    expect(root().textContent).toContain('Sin novedades en tiempo real.');
  });
});
