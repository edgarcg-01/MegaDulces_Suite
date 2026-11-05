import { describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { of } from 'rxjs';
import { MessageService } from 'primeng/api';
import { BancosEstadoBancoComponent } from './bancos-estado-banco.component';
import { ArchivoEstadoBanco, ArchivosDelBanco, BankService, RevisionEstadoBanco } from '../../bank.service';
import { AuthService } from '../../../../core/services/auth.service';
import { Permission } from '../../../../core/constants/permissions';

/**
 * `[CB.59]` La descarga del banco: el veredicto primero, la cuenta que coincide por saldo se elige
 * sola, lo que nadie pudo comprobar no se pinta en verde y lo que no se puede guardar no ofrece
 * «Guardar». Datos inventados (el repo es público).
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

function montar(opts: { datos?: ArchivosDelBanco; revisar?: (id?: string | null) => RevisionEstadoBanco }) {
  const llamadas: (string | null | undefined)[] = [];
  const guardados: unknown[][] = [];
  const api = {
    archivosDelBanco: () => of(opts.datos ?? DATOS),
    revisarEstadoBanco: (_b: string, _n: string, id?: string | null) => { llamadas.push(id); return of(opts.revisar!(id)); },
    confirmarEstadoBanco: (...args: unknown[]) => { guardados.push(args); return of({ cuenta: { alias: 'x' }, nuevos: 1, ya_existia: false }); },
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
  const subir = () => { (cmp as any).archivo = { b64: 'AAAA', nombre: 'x.xlsx' }; (cmp as any).revisar(true); fx.detectChanges(); };
  return { fx, cmp, llamadas, guardados, subir, el: fx.nativeElement as HTMLElement };
}

describe('BancosEstadoBancoComponent', () => {
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

  it('si UNA cuenta coincide por saldo, se elige sola y el veredicto lo dice', () => {
    const { cmp, llamadas, subir } = montar({
      revisar: (id) => id === 'a'
        ? revision({ cuenta: { id: 'a', alias: 'BB 1111' }, como_se_fijo: 'saldo_continuo', motivos_bloqueo: [], puede_confirmar: true })
        : revision({}),
    });
    subir();
    expect(llamadas).toEqual([null, 'a']);
    expect(cmp.cuentaElegida()).toBe('a');
    expect(cmp.puedeGuardar()).toBe(true);
    expect(cmp.textoGuardar()).toBe('Guardar 4 movimientos');
  });

  it('[negativa] sin testigo: no se pinta como comprobado y no guarda hasta confirmar la cuenta a mano', () => {
    const { cmp, fx, guardados, subir } = montar({
      revisar: () => revision({ candidatas: [], cuenta: { id: 'b', alias: 'BB 2222' }, como_se_fijo: 'sin_testigo', motivos_bloqueo: [], puede_confirmar: true }),
    });
    subir();
    expect(document.body.textContent).toContain('No hay con qué comprobar que este archivo es de BB 2222');
    expect(document.body.textContent).not.toContain('Se pueden guardar');
    expect(cmp.puedeGuardar()).toBe(false);
    expect(cmp.textoGuardar()).toBe('Guardar sin comprobar');
    cmp.aceptado.set(true);
    expect(cmp.puedeGuardar()).toBe(true);
    cmp.guardar();
    expect(guardados[0][3]).toBe(true);
    fx.destroy();
  });

  it('[negativa] bloqueado: no se puede guardar y el motivo queda a la vista', () => {
    const motivo = 'el saldo inicial ($500) es el último saldo conocido de BB 1111, no de BB 2222';
    const { cmp, fx, subir } = montar({
      revisar: () => revision({ candidatas: [], cuenta: { id: 'b', alias: 'BB 2222' }, motivos_bloqueo: [motivo] }),
    });
    subir();
    expect(cmp.puedeGuardar()).toBe(false);
    expect(document.body.textContent).toContain(motivo);
    fx.destroy();
  });

  it('[negativa] el mismo archivo otra vez: lo avisa antes de guardar y no ofrece «Guardar»', () => {
    const { cmp, fx, subir } = montar({
      revisar: () => revision({
        cuenta: { id: 'a', alias: 'BB 1111' }, como_se_fijo: 'saldo_continuo', motivos_bloqueo: [], puede_confirmar: true,
        ya_subido: { archivo_id: 'f1', subido_el: '2026-11-05T18:00:00Z', subido_por: 'prueba' },
      }),
    });
    subir();
    expect(cmp.puedeGuardar()).toBe(false);
    expect(document.body.textContent).toContain('ya se subió');
    fx.destroy();
  });
});
