import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { PermissionsService } from '../../../core/services/permissions.service';
import { AuthService } from '../../../core/services/auth.service';
import { PageTabsComponent, type PageTab } from './page-tabs.component';

/**
 * `[RH.13.5]` La pestaña activa la decide la RUTA, no los parámetros. Asistencia es una sola pantalla con modos y
 * paneles en la URL (`/rh/asistencia?ver=faltas`, `?panel=relojes`): con `exact: true` de Angular la pestaña Checadas se
 * apagaba aunque la persona siguiera en ella, y la barra dejaba de decir dónde está.
 */
@Component({ standalone: true, imports: [PageTabsComponent], template: `<app-page-tabs [tabs]="tabs()" variant="underline" />` })
class HostComponent { readonly tabs = signal<PageTab[]>([]); }

@Component({ standalone: true, template: '' })
class VaciaComponent {}

describe('[RH.13.5] PageTabsComponent — la pestaña activa ignora los parámetros', () => {
  async function render(url: string) {
    TestBed.configureTestingModule({
      imports: [HostComponent],
      providers: [
        provideRouter([{ path: 'rh/asistencia', component: VaciaComponent }, { path: 'rh/asistencia/cruces', component: VaciaComponent }]),
        { provide: PermissionsService, useValue: { has: () => true, hasAny: () => true, isAdmin: () => true } },
        { provide: AuthService, useValue: { user: () => ({ permissions: {} }) } },
      ],
    });
    await TestBed.inject(Router).navigateByUrl(url);
    const fix = TestBed.createComponent(HostComponent);
    fix.componentInstance.tabs.set([{ label: 'Checadas', route: '/rh/asistencia' }, { label: 'Cruces', route: '/rh/asistencia/cruces' }]);
    fix.detectChanges();
    await fix.whenStable();
    fix.detectChanges();
    const el = fix.nativeElement as HTMLElement;
    return Array.from(el.querySelectorAll('.ptab.is-active')).map((t) => t.textContent?.trim());
  }
  afterEach(() => TestBed.resetTestingModule());

  it('⭐ con un modo o un panel en la URL, Checadas sigue marcada', async () => {
    expect(await render('/rh/asistencia?ver=faltas')).toEqual(['Checadas']);
    TestBed.resetTestingModule();
    expect(await render('/rh/asistencia?panel=relojes&site=PH')).toEqual(['Checadas']);
  });

  it('⛔ NEGATIVA — exacta en la ruta: en Cruces no se marca Checadas', async () => {
    expect(await render('/rh/asistencia/cruces?x=1')).toEqual(['Cruces']);
  });
});
