import { describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { of, throwError } from 'rxjs';
import { MessageService } from 'primeng/api';
import { BancosEstadoBancoComponent } from './bancos-estado-banco.component';
import { ArchivoEstadoBanco, ArchivosDelBanco, BankService, ContraElLibro, CuentaContraElLibro, RevisionEstadoBanco } from '../../bank.service';
import { AuthService } from '../../../../core/services/auth.service';
import { Permission } from '../../../../core/constants/permissions';

/**
 * `[CB.59]` Se sueltan una o varias descargas: cada una en su fila con su veredicto, la cuenta que
 * coincide por saldo se elige sola, lo que nadie pudo comprobar no se cuenta como listo sin
 * confirmarlo, y un guardado parcial deja los que fallaron con su motivo. Datos inventados.
 */
const ARCHIVO: ArchivoEstadoBanco = {
  id: 'f1', bank: 'banbajio', alias: 'BB 1111', account_label: '1111', file_name: 'x.xlsx', date_from: '2026-10-01', date_to: '2026-10-31',
  lines_in_file: 10, lines_new: 10, opening_balance: 100, closing_balance: 200, total_in: 150, total_out: 50,
  balance_ok: true, declared_ok: true, account_check: 'sin_testigo', created_at: '2026-11-05T18:00:00Z', created_by: 'prueba',
};
const cta = (alias: string, hasta: string | null, con_lector = true, sin_testigo = 0) =>
  ({ id: alias, bank: alias.split(' ')[0], alias, hasta, archivos: hasta ? 1 : 0, sin_testigo, con_lector });
const DATOS: ArchivosDelBanco = {
  archivos: [ARCHIVO], total: 1, tope: 100,
  cuentas: [cta('BB 1111', '2026-10-31', true, 1), cta('BB 2222', null), cta('BBVA 3333', null), cta('BNMX 9999', null, false)],
};
function revision(p: Partial<RevisionEstadoBanco>): RevisionEstadoBanco {
  return {
    banco: 'banbajio', archivo: 'x.xlsx', cuenta_en_archivo: null, cliente_en_archivo: null, cuenta: null, como_se_fijo: null,
    candidatas: [{ id: 'a', alias: 'BB 1111', saldo_conocido: 500, coincide: true }, { id: 'b', alias: 'BB 2222', saldo_conocido: 9, coincide: false }],
    desde: '2026-11-01', hasta: '2026-11-04', movimientos: 4, nuevos: 4, ya_cargados: 0, saldo_inicial: 500, saldo_final: 700,
    total_abonos: 300, total_cargos: 100, cuadra: true, eslabones_rotos: [], totales_declarados_coinciden: true, no_leidos: [],
    motivos_bloqueo: ['el archivo no dice de qué cuenta es: elige la cuenta'], puede_confirmar: false, ya_subido: null, ...p,
  };
}
const LISTO = (alias = 'BB 1111', id = 'a') => revision({ cuenta: { id, alias }, como_se_fijo: 'saldo_continuo', motivos_bloqueo: [], puede_confirmar: true });

const resumenC = (p: Partial<CuentaContraElLibro['resumen']>) => ({ cuadra: 0, difiere: 0, sin_libro: 0, abierto: 1, solo_banco: 0, solo_libro: 0, monto_solo_banco: 0, monto_solo_libro: 0, ...p });
const CONTRA: ContraElLibro = { desde: '2026-09-25', cuentas: [
  { id: 'a', alias: 'BB 1111', desde: '2026-11-01', hasta: '2026-11-03', dias: [], resumen: resumenC({ cuadra: 2 }) },
  { id: 'c', alias: 'BBVA 3333', desde: '2026-11-01', hasta: '2026-11-03', resumen: resumenC({ cuadra: 1, difiere: 1, solo_banco: 1 }), dias: [
    { fecha: '2026-11-02', veredicto: 'difiere', movimientos_banco: 3, renglones_libro: 2, pareados: 2, fecha_distinta: 0, cierre_banco: 100, cierre_libro: 103.51,
      solo_banco: [{ id: 'x', fecha: '2026-11-02', lado: 'sale', importe: 3.51, concepto: 'COMISION' }], solo_libro: [] }] },
  { id: 'd', alias: 'BTE 4444', desde: '2026-11-03', hasta: '2026-11-03', dias: [], resumen: resumenC({}) },
] };

function montar(opts: {
  contra?: ContraElLibro | Error;
  datos?: ArchivosDelBanco;
  revisar?: (nombre: string, id?: string | null) => RevisionEstadoBanco;
  confirmar?: (nombre: string) => unknown;
}) {
  const llamadas: [string, string | null | undefined][] = [];
  const guardados: unknown[][] = [];
  const api = {
    archivosDelBanco: () => of(opts.datos ?? DATOS),
    contraElLibro: () => (opts.contra instanceof Error ? throwError(() => opts.contra) : of(opts.contra ?? { desde: '2026-09-25', cuentas: [] })),
    revisarEstadoBanco: (_b: string, n: string, id?: string | null) => { llamadas.push([n, id]); return of(opts.revisar!(n, id)); },
    confirmarEstadoBanco: (...args: unknown[]) => {
      guardados.push(args);
      const r = opts.confirmar?.(args[1] as string);
      return r instanceof Error ? throwError(() => r) : of({ cuenta: { alias: 'x' }, nuevos: 1, ya_existia: false });
    },
  };
  const auth = { user: signal({ permissions: { [Permission.FINANCE_BANK_GESTIONAR]: true } }) };
  TestBed.configureTestingModule({
    imports: [BancosEstadoBancoComponent],
    providers: [provideZonelessChangeDetection(), MessageService,
      { provide: BankService, useValue: api }, { provide: AuthService, useValue: auth }],
  });
  const fx = TestBed.createComponent(BancosEstadoBancoComponent);
  fx.detectChanges();
  const cmp = fx.componentInstance;
  const soltar = async (...nombres: string[]) => { await cmp.agregarArchivos(nombres.map((nombre) => ({ nombre, b64: 'AAAA' }))); fx.detectChanges(); };
  return { fx, cmp, llamadas, guardados, soltar, el: fx.nativeElement as HTMLElement };
}

describe('BancosEstadoBancoComponent', () => {
  it('sin nada subido no hay vacío grande: el resumen, la franja de una línea y nada más', () => {
    const { el } = montar({ datos: { archivos: [], total: 0, tope: 100, cuentas: [cta('BB 2222', null)] } });
    expect(el.querySelector('.eb-soltar')?.textContent).toContain('Arrastra aquí una o varias descargas');
    expect(el.querySelector('p-table')).toBeNull();
    expect(el.textContent).not.toContain('Todavía no se ha subido');
  });

  it('el resumen cuenta sólo las cuentas con lector, nombra las que faltan y dice cuál no se puede subir', () => {
    const { cmp, el } = montar({});
    const [con, atrasada, sinTestigo] = cmp.resumen();
    expect(con.value).toBe('1 de 3');
    expect(con.sub).toContain('BB 2222');
    expect(con.sub).not.toContain('BNMX');
    expect(atrasada.value).toBe('31/10/26');
    expect(sinTestigo.value).toBe(1);
    expect(el.textContent).toContain('BNMX 9999 no se puede subir aún');
  });

  it('[negativa] la lista trae tope, el resumen no: lo dice y no recorta las cuentas', () => {
    const { cmp, el } = montar({ datos: { ...DATOS, total: 250, cuentas: [cta('BB 1111', '2026-10-31'), cta('BB 2222', '2026-10-30'), cta('BBVA 3333', '2026-10-29')] } });
    expect(cmp.resumen()[0].value).toBe('3 de 3');
    expect(el.textContent).toContain('Se muestran los 1 más recientes de 250');
  });

  it('varios archivos a la vez: cada uno en su fila; el que coincide por saldo se elige solo y queda listo', async () => {
    const { cmp, llamadas, soltar, el } = montar({
      revisar: (n, id) => n === 'bbajio.xlsx' ? (id === 'a' ? LISTO() : revision({}))
        : revision({ candidatas: [{ id: 'c', alias: 'BBVA 3333', saldo_conocido: 1, coincide: false }, { id: 'd', alias: 'BBVA 4444', saldo_conocido: 2, coincide: false }] }),
    });
    await soltar('bbajio.xlsx', 'bbva.exp');
    expect(cmp.lote().length).toBe(2);
    expect(llamadas).toEqual([['bbajio.xlsx', null], ['bbajio.xlsx', 'a'], ['bbva.exp', null]]);
    expect(cmp.veredicto(cmp.lote()[0]).texto).toBe('Listo: 4 nuevos');
    expect(cmp.veredicto(cmp.lote()[1]).texto).toBe('Elige la cuenta');
    expect(cmp.textoGuardar()).toBe('Guardar 1 listo');
    expect(el.textContent).toContain('1 de 2 listos · 1 piden algo');
  });

  it('[negativa] sin testigo: no cuenta como listo hasta confirmar la cuenta, y la confirmación viaja al guardar', async () => {
    const { cmp, guardados, soltar } = montar({
      revisar: () => revision({ candidatas: [], cuenta: { id: 'b', alias: 'BB 2222' }, como_se_fijo: 'sin_testigo', motivos_bloqueo: [], puede_confirmar: true }),
    });
    await soltar('x.xlsx');
    const a = cmp.lote()[0];
    expect(cmp.veredicto(a).texto).toBe('Ningún saldo lo comprueba');
    expect(cmp.listos().length).toBe(0);
    cmp.aceptar(a, true);
    expect(cmp.listos().length).toBe(1);
    await cmp.guardar();
    expect(guardados[0][3]).toBe(true);
  });

  it('[negativa] guardado parcial: el que falla se queda con su motivo y el otro sale de la lista', async () => {
    const { cmp, soltar } = montar({
      revisar: (n) => LISTO(n),
      confirmar: (n) => (n === 'malo.csv' ? Object.assign(new Error('400'), { error: { motivos: ['el saldo no encadena en 1 renglón(es)'] } }) : null),
    });
    await soltar('bueno.csv', 'malo.csv');
    await cmp.guardar();
    expect(cmp.lote().map((a) => a.nombre)).toEqual(['malo.csv']);
    expect(cmp.veredicto(cmp.lote()[0]).texto).toContain('No se guardó: el saldo no encadena');
    expect(cmp.listos().length).toBe(0);
  });

  it('[negativa] el mismo archivo otra vez: se avisa y no cuenta como listo', async () => {
    const { cmp, soltar } = montar({
      revisar: () => ({ ...LISTO(), ya_subido: { archivo_id: 'f1', subido_el: '2026-11-05T18:00:00Z', subido_por: 'prueba' } }),
    });
    await soltar('x.xlsx');
    expect(cmp.veredicto(cmp.lote()[0]).texto).toContain('Ya se subió');
    expect(cmp.listos().length).toBe(0);
  });

  it('[CB.60] contra el libro: lo que difiere va primero, dice cuántas cuentas cuadran y nombra lo que sobra', () => {
    const { cmp, fx, el } = montar({ contra: CONTRA });
    expect(cmp.cuentasContra().map((c) => c.alias)).toEqual(['BBVA 3333', 'BB 1111', 'BTE 4444']);
    expect(cmp.estadoContra(cmp.cuentasContra()[0]).texto).toBe('difiere en 1 día');
    expect(cmp.estadoContra(cmp.cuentasContra()[2]).texto).toBe('sin días cerrados todavía');
    const item = cmp.resumen().find((m) => m.label === 'Cuadran con el libro');
    expect(item?.value).toBe('1 de 2'); // BTE 4444 no tiene días cerrados: no cuenta ni a favor ni en contra
    expect(item?.sub).toContain('BBVA 3333');
    const boton = el.querySelector('button[aria-label="Ver los días de BBVA 3333"]') as HTMLButtonElement | null;
    expect(boton).not.toBeNull();
    boton!.click();
    fx.detectChanges();
    expect(el.textContent).toContain('Sólo en el banco: sale');
  });

  it('[negativa] si la comparación no se pudo leer, se dice y no aparece ningún «cuadran»', () => {
    const { cmp, el } = montar({ contra: Object.assign(new Error('500'), { status: 500 }) });
    expect(cmp.cuentasContra()).toEqual([]);
    expect(cmp.resumen().some((m) => m.label === 'Cuadran con el libro')).toBe(false);
    expect(cmp.contraError()).toBeTruthy();
    expect(el.textContent).not.toContain('Contra el libro');
  });
});
