import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { MessageService } from 'primeng/api';
import { Subject, of } from 'rxjs';
import { vi } from 'vitest';
import { AuthService } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import { ThemeService } from '../../../core/services/theme.service';
import { DataUpdateService } from '../../../core/services/data-update.service';
import { WebSocketService } from '../../../core/services/websocket.service';
import { HapticService } from '../../../core/services/haptic.service';
import { CountFocusService } from '../../../core/services/count-focus.service';
import { DataScopeService } from '../../../core/services/data-scope.service';
import { FindingsService } from '../../finanzas/findings.service';
import { ActionsService } from '../../finanzas/actions.service';
import { ServiceDeskService } from '../../servicio/service-desk.service';
import { EtiquetasService } from '../../tienda/etiquetas.service';
import { AlertsSocketService } from '../command-center/alerts-socket.service';
import { LayoutComponent } from './layout.component';

/**
 * `[RH.13.5]` Asistencia es UNA pantalla: Incidencias y Relojes viven dentro de ella. En el menú, quien ve Asistencia
 * ve UNA entrada (antes tres que llevaban al mismo trabajo); quien no la ve —Contabilidad con Incidencias, medido en
 * MATRIZ_ACCESOS— conserva la suya. Se prueba con el layout de verdad y la lista de entradas de verdad.
 */
type ItemNav = { label: string; route: string };
type Interno = { rhNavGroups: Array<{ title: string; items: ItemNav[] }>; hasPermFor(i: ItemNav): boolean };

function montar(claves: string[], admin = false): string[] {
  vi.stubGlobal('matchMedia', (q: string) => ({ media: q, matches: false, onchange: null, addEventListener: () => undefined,
    removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false }));
  const set = new Set(claves);
  TestBed.configureTestingModule({
    imports: [LayoutComponent],
    providers: [
      provideRouter([]),
      MessageService,
      { provide: AuthService, useValue: { user: () => ({ username: 'prueba', role_name: 'prueba', permissions: Object.fromEntries(claves.map((c) => [c, true])) }) } },
      { provide: PermissionsService, useValue: { has: (p: string) => admin || set.has(p), hasAny: (...ps: string[]) => admin || ps.some((p) => set.has(p)), isAdmin: () => admin } },
      { provide: ThemeService, useValue: { isMonochrome: () => true, toggle: vi.fn() } },
      { provide: DataUpdateService, useValue: { hasPendingUpdate: signal(false), init: vi.fn(), destroy: vi.fn() } },
      { provide: WebSocketService, useValue: { connected: signal(false) } },
      { provide: HapticService, useValue: { tap: vi.fn(), impact: vi.fn() } },
      { provide: CountFocusService, useValue: { active: signal(false) } },
      { provide: DataScopeService, useValue: { dim: () => of(null) } },
      { provide: AlertsSocketService, useValue: { connect: vi.fn(), disconnect: vi.fn(), alert$: new Subject(), connected: signal(false) } },
      { provide: FindingsService, useValue: { stats: () => of({}) } },
      { provide: ActionsService, useValue: { stats: () => of({}) } },
      { provide: ServiceDeskService, useValue: { notifications: () => of([]) } },
      { provide: EtiquetasService, useValue: { notices: () => of([]) } },
    ],
  });
  const cmp = TestBed.createComponent(LayoutComponent).componentInstance as unknown as Interno;
  const grupo = cmp.rhNavGroups.find((g) => g.title === 'Asistencia');
  if (!grupo) throw new Error('no está el grupo Asistencia del menú de Personal');
  return grupo.items.filter((i) => cmp.hasPermFor(i)).map((i) => i.label);
}

describe('[RH.13.5] menú de Personal: una sola entrada de Asistencia', () => {
  afterEach(() => { TestBed.resetTestingModule(); vi.unstubAllGlobals(); });

  it('⭐ RH (ve Asistencia, captura, califica y administra relojes) ve UNA entrada', () => {
    expect(montar([Permission.HR_ATTENDANCE_GESTIONAR, Permission.HR_ATTENDANCE_VER, Permission.HR_INCIDENTS_CAPTURAR,
      Permission.HR_INCIDENTS_CALIFICAR, Permission.HR_PERIOD_CLOSE, Permission.HR_DEVICES_GESTIONAR])).toEqual(['Asistencia']);
  });

  it('⛔ NEGATIVA — Contabilidad (audita incidencias, NO ve Asistencia) conserva su entrada de Incidencias', () => {
    expect(montar([Permission.HR_INCIDENTS_AUDITAR])).toEqual(['Incidencias']);
  });

  it('quien sólo administra relojes, sin ver Asistencia, conserva Relojes', () => {
    expect(montar([Permission.HR_DEVICES_GESTIONAR])).toEqual(['Relojes']);
  });

  it('el administrador también ve UNA (la pantalla que contiene a las otras dos)', () => {
    expect(montar([], true)).toEqual(['Asistencia']);
  });
});
