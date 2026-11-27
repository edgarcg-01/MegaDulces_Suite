import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { PermissionsService } from '../../../core/services/permissions.service';
import { AuthService } from '../../../core/services/auth.service';
import { Permission } from '../../../core/constants/permissions';
import { FinanzasCalendarioPagosComponent } from './finanzas-calendario-pagos.component';
import { EVIDENCIA_REFS_POR_CONSULTA } from '@megadulces/contracts';

/**
 * `[PGP.231]` La evidencia de las facturas se pide con las llaves en el CUERPO (`POST …/evidencia/consulta`).
 * En la URL (`GET …/evidencia?refs=`), 200 llaves son ~5.7 KB y el token de un superadmin ~11 KB: juntos pasan los 16 KB
 * de cabeceras de Node y la API contestaba 431 (prueba visual del 2026-11-26, día 25-nov del Calendario).
 */
function montar() {
  const llaves = [Permission.FINANCE_PAYMENTS_VER, Permission.FINANCE_PAYMENTS_GESTIONAR];
  TestBed.configureTestingModule({
    imports: [FinanzasCalendarioPagosComponent],
    providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([]),
      { provide: PermissionsService, useValue: {
        isAdmin: () => false, isSuperadmin: () => false,
        has: (k: string) => llaves.includes(k), hasExplicit: (k: string) => llaves.includes(k),
        hasAny: (...ks: string[]) => ks.some((k) => llaves.includes(k)),
      } },
      { provide: AuthService, useValue: { user: () => ({ permissions: Object.fromEntries(llaves.map((k) => [k, true])) }) } }],
  });
  const fixture = TestBed.createComponent(FinanzasCalendarioPagosComponent);
  const http = TestBed.inject(HttpTestingController);
  fixture.detectChanges();
  http.match(() => true); // lo que la pantalla lee al entrar: no es de esta prueba
  return { c: fixture.componentInstance, http };
}

/** Lo privado que se ejercita: de dónde salen las llaves y la carga misma. */
type ConEvidencia = { refsDePagosAbiertos(): string[]; cargarEvidencias(): Promise<void>; evidenciaFallo(): boolean };
const llavesDeUnDia = (n: number) => Array.from({ length: n }, (_, i) => `oblig:08|20|1|${String(i + 1).padStart(7, '0')}`);
const esConsulta = (r: { method: string; url: string }) => r.method === 'POST' && r.url.endsWith('/finance/payment-calendar/evidencia/consulta');

describe('[PGP.231] la evidencia se pide con las llaves en el cuerpo, no en la URL', () => {
  it('250 facturas: dos consultas POST (200 + 50), nada en la URL, y ningún GET a /evidencia', async () => {
    const { c, http } = montar();
    const x = c as unknown as ConEvidencia;
    const refs = llavesDeUnDia(250);
    vi.spyOn(x, 'refsDePagosAbiertos').mockReturnValue(refs);
    const carga = x.cargarEvidencias();

    const primera = http.expectOne(esConsulta);
    expect((primera.request.body as { refs: string[] }).refs).toEqual(refs.slice(0, EVIDENCIA_REFS_POR_CONSULTA));
    expect(primera.request.params.keys()).toEqual([]);
    expect(primera.request.urlWithParams).not.toContain('oblig');
    primera.flush([]);
    await new Promise((r) => setTimeout(r, 0));

    const segunda = http.expectOne(esConsulta);
    expect((segunda.request.body as { refs: string[] }).refs).toEqual(refs.slice(EVIDENCIA_REFS_POR_CONSULTA));
    segunda.flush([]);
    await carga;

    // ⛔ NEGATIVA: el GET con ?refs= (el que daba 431) ya no se usa desde la pantalla.
    expect(http.match((r) => r.method === 'GET' && /\/evidencia(\?|$)/.test(r.urlWithParams))).toHaveLength(0);
    expect(x.evidenciaFallo()).toBe(false);
  });

  it('si la consulta falla, se dice (evidenciaFallo) y esas llaves se pueden volver a pedir', async () => {
    const { c, http } = montar();
    const x = c as unknown as ConEvidencia;
    vi.spyOn(x, 'refsDePagosAbiertos').mockReturnValue(llavesDeUnDia(3));
    const carga = x.cargarEvidencias();
    http.expectOne(esConsulta).flush({ message: 'falla' }, { status: 500, statusText: 'Error' });
    await carga;
    expect(x.evidenciaFallo()).toBe(true);
    const otra = x.cargarEvidencias();
    expect((http.expectOne(esConsulta).request.body as { refs: string[] }).refs).toHaveLength(3);
    http.match(() => true);
    void otra;
  });
});
