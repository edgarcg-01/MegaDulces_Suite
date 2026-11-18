import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FreshnessPillComponent } from './freshness-pill.component';

/**
 * `[GP.RF.38]` La región viva de la píldora sólo habla cuando cambia el ESTADO. Antes iba sobre el texto
 * que avanza cada 15 s y el lector de pantalla lo leía en cada cambio.
 */
describe('[GP.RF.38] freshness-pill: qué anuncia', () => {
  afterEach(() => vi.useRealTimers());

  function montar(since: number, staleAfterSec = 600) {
    const fix = TestBed.createComponent(FreshnessPillComponent);
    fix.componentRef.setInput('measures', 'fetch');
    fix.componentRef.setInput('since', since);
    fix.componentRef.setInput('staleAfterSec', staleAfterSec);
    fix.detectChanges();
    const el = fix.nativeElement as HTMLElement;
    return { fix, viva: () => el.querySelector('[aria-live]') as HTMLElement, visible: () => el.querySelector('.fp')?.textContent?.trim() };
  }

  it('NEGATIVA: el texto que avanza NO está en la región viva', () => {
    vi.useFakeTimers();
    const { fix, viva, visible } = montar(Date.now());
    expect(viva().textContent?.trim()).toBe('');
    vi.advanceTimersByTime(30_000);
    fix.detectChanges();
    expect(visible()).toContain('hace 30s');
    expect(viva().textContent?.trim()).toBe('');
    expect(fix.nativeElement.querySelector('.fp')?.hasAttribute('aria-live')).toBe(false);
  });

  it('cuando se atrasa, lo anuncia una vez', () => {
    vi.useFakeTimers();
    const { fix, viva } = montar(Date.now(), 60);
    vi.advanceTimersByTime(75_000);
    fix.detectChanges();
    expect(viva().textContent?.trim()).toBe('Esta pantalla se cargó hace rato: puede estar atrasada.');
  });
});
