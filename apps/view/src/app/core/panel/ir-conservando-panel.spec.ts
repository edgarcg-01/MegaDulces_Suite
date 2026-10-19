import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { TestBed } from '@angular/core/testing';
import { Component } from '@angular/core';
import { Router, provideRouter } from '@angular/router';
import { irConservandoPanel } from './ir-conservando-panel';

@Component({ standalone: true, template: '' })
class Vacio {}

/**
 * `[MT.5.4]` **El panel se queda hasta que le den a la X.**
 *
 * Reportado por Edgar el 2026-10-16: «si abro otra pantalla, o hasta en el mismo
 * módulo, se cierra». Medido sobre el router real, la causa no era la pantalla
 * ni el módulo — era el mecanismo de navegación de cada botón:
 *
 *   router.navigate([...])      → CONSERVA (arma el árbol sobre el actual)
 *   router.navigateByUrl('/x')  → ⛔ PIERDE (el texto ES el árbol completo)
 *
 * Por eso el comportamiento parecía aleatorio desde la pantalla: dos botones que
 * se ven iguales navegan distinto.
 */
describe('[MT.5.4] irConservandoPanel', () => {
  let router: Router;

  const SPLIT = '/compras/ordenes(panel:compras/ordenes/abc)';

  beforeEach(async () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'compras/ordenes', component: Vacio },
          { path: 'compras/requisiciones', component: Vacio },
          { path: 'finanzas/egresos/detalle', component: Vacio },
          { path: 'compras/ordenes/:id', outlet: 'panel', component: Vacio },
          { path: 'compras/requisiciones/:id', outlet: 'panel', component: Vacio },
        ]),
      ],
    });
    TestBed.createComponent(Vacio).detectChanges();
    router = TestBed.inject(Router);
    await router.navigateByUrl(SPLIT);
  });

  it('conserva el panel al ir a otra pantalla del MISMO módulo', async () => {
    await irConservandoPanel(router, '/compras/requisiciones');
    expect(router.url).toBe('/compras/requisiciones(panel:compras/ordenes/abc)');
  });

  it('conserva el panel al cruzar a OTRO módulo', async () => {
    await irConservandoPanel(router, '/finanzas/egresos/detalle');
    expect(router.url).toContain('panel:compras/ordenes/abc');
  });

  /** Lo que llega de un hallazgo o de un link del chat trae filtros en la URL. */
  it('no se come los query params del destino', async () => {
    await irConservandoPanel(router, '/finanzas/egresos/detalle?type=beneficiario&key=x');
    expect(router.url).toContain('type=beneficiario');
    expect(router.url).toContain('key=x');
    expect(router.url).toContain('panel:');
  });

  /** Quien navega a una URL CON split pidió ese split, no el que estaba abierto. */
  it('si el destino trae su propio panel, gana el destino', async () => {
    await irConservandoPanel(router, '/compras/ordenes(panel:compras/requisiciones/zzz)');
    expect(router.url).toContain('panel:compras/requisiciones/zzz');
    expect(router.url).not.toContain('abc');
  });

  it('sin panel abierto no inventa ninguno', async () => {
    await router.navigateByUrl('/compras/ordenes');
    await irConservandoPanel(router, '/compras/requisiciones');
    expect(router.url).toBe('/compras/requisiciones');
  });

  /**
   * NEGATIVA — que la compuerta sepa ponerse roja. Es el defecto exacto que se
   * reportó: sin el helper, la misma navegación tira el panel. Sin esta prueba,
   * las de arriba pasarían con un router que conservara outlets por su cuenta y
   * no demostrarían que lo que arregla es la reinyección.
   */
  it('NEGATIVA: navigateByUrl con texto crudo SÍ lo pierde', async () => {
    await router.navigateByUrl('/compras/requisiciones');
    expect(router.url).toBe('/compras/requisiciones');
  });
});

/**
 * `[MT.5.4]` **El gate.** Arreglar los 6 sitios no evita el séptimo.
 *
 * Todo `navigateByUrl(` del código de la app tiene que estar acá con su motivo.
 * Los permitidos son los que reciben un `UrlTree` (ya armado con los outlets
 * puestos) y los de sesión, donde tirar el panel es lo correcto: la pantalla
 * partida pertenece a la sesión que se está cerrando.
 */
describe('[MT.5.4] gate: nadie navega con texto crudo', () => {
  const RAIZ = join(__dirname, '..', '..');

  /** Archivo → por qué se le permite. Cambiar esto es una decisión, no un ajuste. */
  const PERMITIDOS: Record<string, string> = {
    'app.component.ts': 'sesión requerida: recibe UrlTree de loginUrlTree()',
    'core/http/auth.interceptor.ts': 'sesión vencida: recibe UrlTree de loginUrlTree()',
    'core/services/multitarea.service.ts': 'abre al lado: arma el UrlTree con el panel puesto',
    'core/panel/ir-conservando-panel.ts': 'es el helper: navega el árbol ya corregido',
    'modules/auth/login/login.component.ts': 'entrar: no hay panel previo que conservar',
    'modules/reparto/reparto.guard.ts': 'guard que rebota: el área quedó vedada',
    'modules/televenta/televenta.guard.ts': 'guard que rebota: el área quedó vedada',
  };

  function fuentes(dir: string, acc: string[] = []): string[] {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) fuentes(p, acc);
      else if (e.endsWith('.ts') && !e.endsWith('.spec.ts')) acc.push(p);
    }
    return acc;
  }

  it('todo navigateByUrl está declarado, con su motivo', () => {
    const culpables = fuentes(RAIZ)
      .filter((p) => /\.navigateByUrl\(|[^.]\bnavigateByUrl\(/.test(readFileSync(p, 'utf8')))
      .map((p) => p.slice(RAIZ.length + 1).split('\\').join('/'))
      .filter((rel) => !(rel in PERMITIDOS));

    expect(culpables).toEqual([]);
  });

  /** El gate no sirve si la lista se puede ampliar sin pensarlo: cada entrada dice por qué. */
  it('cada permiso tiene motivo escrito', () => {
    for (const [archivo, motivo] of Object.entries(PERMITIDOS)) {
      expect(motivo.length, archivo).toBeGreaterThan(20);
    }
  });
});
