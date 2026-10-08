import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { PermissionsService } from '../../../core/services/permissions.service';
import { AuthService } from '../../../core/services/auth.service';
import { PageTabsComponent, type PageTab } from './page-tabs.component';

/**
 * `[RH.1.7c]` El contador de una pestaña («Faltas 3»). Lo que se defiende: sale cuando hay algo que atender y NO
 * sale con cero ni con null — un «0» se leería como «todo bien» cuando a veces es «no se pudo medir».
 */
@Component({
  standalone: true,
  imports: [PageTabsComponent],
  template: `<app-page-tabs [tabs]="tabs()" variant="underline" />`,
})
class HostComponent {
  tabs = signal<PageTab[]>([]);
}

describe('[RH.1.7c] PageTabsComponent — contador', () => {
  async function render(tabs: PageTab[]) {
    await TestBed.configureTestingModule({
      imports: [HostComponent],
      providers: [
        provideRouter([]),
        { provide: PermissionsService, useValue: { isAdmin: () => true, has: () => true } },
        { provide: AuthService, useValue: { user: () => ({ permissions: {} }) } },
      ],
    }).compileComponents();
    const fix = TestBed.createComponent(HostComponent);
    fix.componentInstance.tabs.set(tabs);
    fix.detectChanges();
    return fix.nativeElement as HTMLElement;
  }
  afterEach(() => TestBed.resetTestingModule());

  it('con algo que atender, el número sale (y el lector de pantalla lo oye)', async () => {
    const el = await render([{ label: 'Checadas', route: '/a' }, { label: 'Faltas', route: '/b', badge: 3 }]);
    expect(el.querySelector('.ptab-num')?.textContent?.trim()).toBe('3');
    expect(el.textContent).toContain('3 por atender');
  });

  it('⛔ con cero o sin medir (null), no se dibuja ningún número', async () => {
    const el = await render([{ label: 'Faltas', route: '/b', badge: 0 }, { label: 'Incidencias', route: '/c', badge: null }]);
    expect(el.querySelector('.ptab-num')).toBeNull();
  });
});
