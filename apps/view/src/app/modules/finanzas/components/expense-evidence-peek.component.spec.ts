import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { MessageService } from 'primeng/api';

import { ExpenseEvidencePeekComponent } from './expense-evidence-peek.component';

/**
 * `[GX.68]` Candado del **visor de la evidencia**: lo que le dice a quien no pudo abrirla.
 *
 * ## ⛔ El defecto que cierra
 * Este componente tenía UN solo mensaje para cualquier fallo:
 *
 *     «No se pudo traer el expediente. Puede ser la conexión — reintentá.»
 *
 * Sobre un **403** eso es falso dos veces: nombra una causa que no es, y manda a repetir algo
 * que no se arregla repitiéndolo. Es la lección de `[GX.37]`, que el repo ya aplica del lado
 * del almacenamiento (`motivoDeAlmacenamiento`) y que acá faltaba.
 *
 * Importa porque el 403 era **sistemático, no raro**: `GET :id` exigía `FINANCE_EXPENSES_VER`
 * y 11 roles capturan sin tenerlo — 76 usuarios medidos en la base local, que es justo la
 * gente que levanta el vale. Veían «puede ser la conexión» y reintentaban para siempre.
 */

describe('[GX.68] ExpenseEvidencePeekComponent · el motivo por el que no se ve', () => {
  let fix: ComponentFixture<ExpenseEvidencePeekComponent>;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [ExpenseEvidencePeekComponent],
      providers: [provideHttpClient(), provideHttpClientTesting(), MessageService],
    });
    http = TestBed.inject(HttpTestingController);
    fix = TestBed.createComponent(ExpenseEvidencePeekComponent);
  });

  afterEach(() => { TestBed.resetTestingModule(); });

  /** Abrir el panel con un comprobante dispara el pedido del expediente. */
  const abrirCon = (id = 'vale-1') => {
    fix.componentRef.setInput('proofId', id);
    fix.componentRef.setInput('open', true);
    fix.detectChanges();
    return http.expectOne((r) => r.url.includes('/finance/expenses/proofs/'));
  };

  it('monta y pide el expediente al abrirse (esto compila el template)', () => {
    const req = abrirCon();
    expect(req.request.method).toBe('GET');
    req.flush({ id: 'vale-1', files: [] });
    fix.detectChanges();
    expect(fix.componentInstance.errorMsg()).toBeNull();
  });

  /**
   * ⭐ EL CANDADO. El 403 trae su motivo del servidor y se muestra ESE — no uno inventado en
   * la pantalla, para que los dos no se separen.
   */
  it('⭐ un 403 muestra el motivo del servidor, no «la conexión»', () => {
    const req = abrirCon();
    req.flush({ message: 'Este vale no es tuyo. Podés abrir los que vos levantaste o los que comprobaste.' },
      { status: 403, statusText: 'Forbidden' });
    fix.detectChanges();
    const msg = fix.componentInstance.errorMsg() || '';
    expect(msg).toContain('no es tuyo');
    // ⛔ NEGATIVA: las dos frases del defecto no pueden volver.
    expect(msg).not.toMatch(/reintent/i);
    expect(msg).not.toMatch(/conexi[oó]n/i);
  });

  /** Si el servidor no explica, la pantalla igual dice que es permiso — nunca «reintentá». */
  it('un 403 sin mensaje sigue diciendo que es permiso', () => {
    const req = abrirCon();
    req.flush(null, { status: 403, statusText: 'Forbidden' });
    fix.detectChanges();
    const msg = fix.componentInstance.errorMsg() || '';
    expect(msg).toMatch(/permiso/i);
    expect(msg).not.toMatch(/reintent/i);
  });

  /** 404 tampoco es la conexión: el expediente no está, y reintentar no lo va a traer. */
  it('un 404 dice que el expediente no está', () => {
    const req = abrirCon();
    req.flush(null, { status: 404, statusText: 'Not Found' });
    fix.detectChanges();
    const msg = fix.componentInstance.errorMsg() || '';
    expect(msg).toContain('ya no está');
    expect(msg).not.toMatch(/reintent/i);
  });

  /**
   * ⚠️ Y la otra mitad: un fallo de red **sí** se arregla reintentando, así que ese mensaje
   * se conserva. Si esto se rompiera, el arreglo habría cambiado una frase equivocada por
   * otra — para el caso en que la vieja era la correcta.
   */
  it('un fallo de red SÍ invita a reintentar', () => {
    const req = abrirCon();
    req.error(new ProgressEvent('error'), { status: 0, statusText: 'Unknown Error' });
    fix.detectChanges();
    const msg = fix.componentInstance.errorMsg() || '';
    expect(msg).toMatch(/conexi[oó]n/i);
    expect(msg).toMatch(/reintent/i);
  });

  /** Un 500 no es permiso ni ausencia: cae en el genérico, que es lo honesto. */
  it('un 500 cae en el mensaje genérico', () => {
    const req = abrirCon();
    req.flush(null, { status: 500, statusText: 'Server Error' });
    fix.detectChanges();
    expect(fix.componentInstance.errorMsg() || '').toMatch(/No se pudo traer el expediente/i);
  });
});
