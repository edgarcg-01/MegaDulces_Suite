import { ChangeDetectorRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { PermissionsService } from '../../../core/services/permissions.service';
import { AuthService } from '../../../core/services/auth.service';
import { Permission } from '../../../core/constants/permissions';
import { FinanzasCalendarioPagosComponent } from './finanzas-calendario-pagos.component';
import type { CoberturaDelProgramaHttp, VencidosConMotivo } from '@megadulces/contracts';

/**
 * `[PGP.233]` **Por qué siguen ahí los pagos vencidos** y `[PGP.232]` **el pago grande que salió sin programarse**:
 * las dos líneas que se agregaron al aviso que ya existía (`[PGP.48]`), no una franja nueva.
 *
 * Los vectores son los MEDIDOS en prod el 2026-11-27 (12 pagos que Kepler ya abonó en parte, 2 esperando la descarga
 * de una cuenta, 1 sin medir; 3 pagos grandes fuera del programa), para que la prueba falle si cambia la redacción
 * que una persona va a leer.
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
  http.match(() => true);
  const pintar = () => { fixture.componentRef.injector.get(ChangeDetectorRef).markForCheck(); fixture.detectChanges(); };
  return { fixture, c: fixture.componentInstance, pintar };
}

const VENCIDOS: VencidosConMotivo = {
  hoy: '2026-11-27', dias_para_liberar: 7, revisados: 15,
  retenidos: [
    { motivo: 'kepler_en_parte', pagos: 12, monto: 1_613_799.01 },
    { motivo: 'banco_sin_medir', pagos: 2, monto: 1_431_794.37 },
    { motivo: 'kepler_sin_medir', pagos: 1, monto: 850 },
  ],
  cuentas_que_frenan: [{ cuenta: 'STDR 1621', hasta: '2026-11-19', pagos: 2, monto: 1_431_794.37 }],
  liberables: { pagos: 0, monto: 0 },
};

const COBERTURA: CoberturaDelProgramaHttp = {
  hoy: '2026-11-27', datos_al: '2026-11-27T19:00:00.000Z', desde: '2026-11-01', hasta: '2026-11-27',
  pagos: 235, monto: 41_527_842.9, pagos_en_programa: 223, monto_en_programa: 40_503_317.1,
  pagos_fuera: 12, monto_fuera: 1_024_525.8, umbral: 100_000,
  grandes: [
    { id: '00|X-D-26|0024242', sucursal: '00', doc_tipo: 'X-D-26', folio: '0024242', fecha: '2026-11-06', importe: 379_724.55, acreedor: 'CB005', acreedor_nombre: 'BOLSAS DE LOS ALTOS S. DE R.L DE C.V.', estado: 'no_programada' },
    { id: '05|X-D-26|0000227', sucursal: '05', doc_tipo: 'X-D-26', folio: '0000227', fecha: '2026-11-06', importe: 288_993.54, acreedor: 'CB005', acreedor_nombre: 'BOLSAS DE LOS ALTOS S. DE R.L DE C.V.', estado: 'no_programada' },
    { id: '00|X-D-26|0024282', sucursal: '00', doc_tipo: 'X-D-26', folio: '0024282', fecha: '2026-11-09', importe: 103_420, acreedor: 'CA021', acreedor_nombre: 'ROLANDO PEREZ CANO', estado: 'no_programada' },
  ],
  por_tramo: [{ tramo: 'de_100k_a_500k', pagos: 3, monto: 772_138.09 }, { tramo: 'de_10k_a_100k', pagos: 7, monto: 243_784.21 }],
  otros_universos: [{ universo: 'caja', pagos: 219, monto: 5_483_643.42, pagos_en_programa: 0, monto_en_programa: 0 }],
};

describe('[PGP.233] por qué siguen los vencidos · [PGP.232] el pago grande fuera del programa', () => {
  it('dice el motivo de cada grupo en llano, no el código de la regla', () => {
    const { c } = montar();
    c.vencidos.set(VENCIDOS);
    expect(c.porQueSiguen()).toBe('12 Kepler ya les abonó una parte · 2 esperan la descarga del banco · 1 no se pudieron medir contra Kepler');
  });

  it('⛔ sin respuesta del servidor NO dibuja «ninguno retenido»: la línea queda como antes', () => {
    const { c } = montar();
    expect(c.vencidos()).toBeNull();
    expect(c.porQueSiguen()).toBeNull();
    // Y con la lista vacía (nada que decidir) tampoco inventa texto.
    c.vencidos.set({ ...VENCIDOS, retenidos: [], cuentas_que_frenan: [] });
    expect(c.porQueSiguen()).toBeNull();
  });

  it('nombra la cuenta cuya descarga frena, con su día y lo que detiene', () => {
    const { c } = montar();
    c.vencidos.set(VENCIDOS);
    expect(c.textoCuentaQueFrena(c.cuentaQueFrena()!)).toBe('2 pagos por $1.43M esperan la descarga de STDR 1621: llega al jue 19 nov');
  });

  it('una cuenta que nunca se subió se dice así, no como una fecha vacía', () => {
    const { c } = montar();
    c.vencidos.set({ ...VENCIDOS, cuentas_que_frenan: [{ cuenta: 'STDR 5565', hasta: null, pagos: 1, monto: 390_355.26 }] });
    expect(c.textoCuentaQueFrena(c.cuentaQueFrena()!)).toBe('Un pago por $390.4K espera la descarga de STDR 5565: nunca se ha subido');
  });

  it('[PGP.232] el gancho nombra a quién se le pagó cuando es uno solo, y sólo aparece si hay pagos grandes', () => {
    const { c } = montar();
    expect(c.grandesFuera()).toBeNull();
    c.cobertura.set(COBERTURA);
    expect(c.textoGrandesFuera(c.grandesFuera()!)).toBe('3 pagos por $772.1K salieron este mes sin pasar por el Calendario');
    c.cobertura.set({ ...COBERTURA, grandes: [COBERTURA.grandes[0]] });
    expect(c.textoGrandesFuera(c.grandesFuera()!)).toBe('Un pago por $379.7K salió este mes sin pasar por el Calendario (BOLSAS DE LOS ALTOS S. DE R.L DE C.V.)');
  });

  it('⛔ un mes con todo el pago por banco programado no dibuja la línea', () => {
    const { c } = montar();
    c.cobertura.set({ ...COBERTURA, pagos_fuera: 0, monto_fuera: 0, grandes: [], por_tramo: [] });
    expect(c.grandesFuera()).toBeNull();
  });
});
