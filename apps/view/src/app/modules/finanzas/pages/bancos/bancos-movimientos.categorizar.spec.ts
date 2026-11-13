import { describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { Subject, of } from 'rxjs';
import { BancosMovimientosComponent } from './bancos-movimientos.component';
import { BankMovement, BankService } from '../../bank.service';
import { PermissionsService } from '../../../../core/services/permissions.service';
import { CategorizarEgresoComponent } from '../../../../shared/components/categorizar-egreso/categorizar-egreso.component';
import { CategorizarEgresoApi, type VistaPreviaBeneficiario } from '../../../../shared/components/categorizar-egreso/categorizar-egreso.api';

/**
 * `[CB.70]` Un egreso sin categoría se categoriza en el detalle del movimiento, con la MISMA pieza del puente
 * ContPAQi (`[CP.8.80]`): mismo endpoint, mismo cuerpo `{ categoria, beneficiario? }`, mismo permiso. Antes, el
 * Cierre mandaba a Kepler, y corregir en Kepler no le pone categoría al movimiento. Datos inventados.
 */
const mov = (p: Partial<BankMovement>): BankMovement => ({
  id: 'm', movement_date: '2026-11-06', bank: 'BBVA', account_label: '4885', bank_account_id: 'a',
  category_id: null, category_code: null, category_name: null, group_key: null, kepler_account: null,
  raw_type: null, raw_code: null, sucursal: null, concept: 'X', amount_in: 0, amount_out: 0, running_balance: null, recon_status: 'pending', ...p,
});
const EGRESO = mov({ id: 'e1', fuente: 'libro', concept: 'Oscar Hernandez R', amount_out: 7186 });
const DEPOSITO = mov({ id: 'p1', fuente: 'libro', concept: 'SPEI RECIBIDO', amount_in: 6500 });
const CON_CATEGORIA = mov({ id: 'c1', fuente: 'libro', category_id: 'c', category_name: 'Proveedores', amount_out: 10 });
const DE_LA_DESCARGA = mov({ id: 'd1', fuente: 'descarga', motivo: 'falta_en_libro', amount_out: 5, recon_status: null as never });
const PREVIA: VistaPreviaBeneficiario = { texto: 'OSCAR HERNANDEZ', movimientos: 3, importe: 9000, filas: [], regla_existente: null };

function montar(rows: BankMovement[], conPermiso = true, previa$ = of(PREVIA)) {
  const pedidos: { tipo: string; id: string; body?: unknown; texto?: string }[] = [];
  const api = {
    categoriasEgreso: () => of([{ code: 'gasto_x', nombre: 'Gastos varios', grupo: 'gasto' }]),
    vistaPreviaBeneficiario: (id: string, texto: string) => { pedidos.push({ tipo: 'previa', id, texto }); return previa$; },
    categorizar: (id: string, body: unknown) => {
      pedidos.push({ tipo: 'categorizar', id, body });
      return of({ movimiento_id: id, categoria: 'gasto_x', regla: { prioridad: 1010, texto: 'OSCAR HERNANDEZ', nueva: true }, aplicados: 2, importe_aplicado: 1814 });
    },
  };
  TestBed.configureTestingModule({
    imports: [BancosMovimientosComponent],
    providers: [provideZonelessChangeDetection(),
      { provide: BankService, useValue: { movementFlow: () => of({ tipo: 'pago', proveedor: null, cadena: [], docs: [], cobranza: null, nota: 'n' }) } },
      { provide: PermissionsService, useValue: { has$: () => signal(conPermiso) } },
      { provide: CategorizarEgresoApi, useValue: api },
    ],
  });
  const fx = TestBed.createComponent(BancosMovimientosComponent);
  for (const [k, v] of Object.entries({ movements: rows, movTotal: rows.length, accountOpts: [], groupOpts: [], reconOpts: [] })) {
    fx.componentRef.setInput(k, v);
  }
  fx.detectChanges();
  let categorizados = 0;
  fx.componentInstance.categorizado.subscribe(() => categorizados++);
  const el = fx.nativeElement as HTMLElement;
  const abrir = (i: number) => { (el.querySelectorAll('tr.fb-mov-row')[i] as HTMLElement).click(); fx.detectChanges(); };
  const seccion = () => el.querySelector('.fb-cat-sec');
  const pieza = () => fx.debugElement.query(By.directive(CategorizarEgresoComponent))?.componentInstance as CategorizarEgresoComponent | undefined;
  return { fx, el, abrir, seccion, pieza, pedidos, categorizados: () => categorizados };
}

describe('[CB.70] categorizar un egreso desde Movimientos', () => {
  it('con permiso: «Categorizar» abre la pieza del puente, propone el nombre y manda el mismo cuerpo', () => {
    const { fx, el, abrir, seccion, pieza, pedidos, categorizados } = montar([EGRESO]);
    abrir(0);
    const boton = seccion()?.querySelector('button') as HTMLButtonElement;
    expect(boton.textContent).toContain('Categorizar');
    boton.click();
    fx.detectChanges();
    const ce = pieza()!;
    expect(ce).toBeTruthy();
    expect(pedidos[0]).toEqual({ tipo: 'previa', id: 'e1', texto: 'OSCAR HERNANDEZ' });
    ce.elegida.set('gasto_x');
    ce.guardar();
    fx.detectChanges();
    expect(pedidos.at(-1)).toEqual({ tipo: 'categorizar', id: 'e1', body: { categoria: 'gasto_x', beneficiario: 'OSCAR HERNANDEZ' } });
    expect(categorizados()).toBe(1);
    expect(el.querySelector('.fb-cat-aviso')?.textContent).toContain('Categorizado como Gastos varios. Con «OSCAR HERNANDEZ» se categorizaron 2 más');
  });

  it('[negativa] con la casilla, no se guarda sin haber visto qué toma la regla', () => {
    const previa$ = new Subject<VistaPreviaBeneficiario>();
    const { fx, abrir, seccion, pieza, pedidos } = montar([EGRESO], true, previa$);
    abrir(0);
    (seccion()?.querySelector('button') as HTMLButtonElement).click();
    fx.detectChanges();
    const ce = pieza()!;
    ce.elegida.set('gasto_x');
    expect(ce.puedeGuardar()).toBe(false);
    ce.guardar();
    expect(pedidos.some((p) => p.tipo === 'categorizar')).toBe(false);
    previa$.next(PREVIA);
    expect(ce.puedeGuardar()).toBe(true);
  });

  it('[negativa] sin permiso: no hay botón, y dice quién lo hace', () => {
    const { abrir, seccion } = montar([EGRESO], false);
    abrir(0);
    expect(seccion()?.querySelector('button')).toBeNull();
    expect(seccion()?.textContent).toContain('«Categorizar egresos en el Puente ContPAQi»');
  });

  it('un depósito sin categoría dice dónde se corrige (el motor del puente sólo categoriza egresos)', () => {
    const { abrir, seccion } = montar([DEPOSITO]);
    abrir(0);
    expect(seccion()?.querySelector('button')).toBeNull();
    expect(seccion()?.textContent).toContain('libro CUENTAS');
  });

  it('ni lo que ya tiene categoría ni lo de la descarga ofrecen categorizar', () => {
    const a = montar([CON_CATEGORIA]);
    a.abrir(0);
    expect(a.seccion()).toBeNull();
    TestBed.resetTestingModule();
    const b = montar([DE_LA_DESCARGA]);
    b.abrir(0);
    expect(b.seccion()).toBeNull();
  });
});
