import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subject } from 'rxjs';
import { PermissionsService } from '../../../core/services/permissions.service';
import { Permission } from '../../../core/constants/permissions';
import {
  ComprobacionesService, type ExpedienteDelDia, type ProofFile, type ResultadoBusquedaGastos,
} from '../comprobaciones.service';

/** Menos que esto no se busca: una letra suelta trae media base. Un dígito sí (es un folio). */
export const MINIMO_BUSQUEDA_GASTOS = 2;

/**
 * `[GX.88]` — **El estado del buscador de gastos**, compartido por las pestañas de Gastos.
 *
 * Pedido del usuario (2026-11-05): *«un buscador que va a funcionar para estos submódulos»*
 * (Aprobación · Mis gastos · Expediente · Historial), **arriba de las pestañas**, y sólo para
 * quien aprueba. Lo provee el shell del área (`GastosAreaShellComponent`), así que:
 *
 *  · **lo escrito se conserva al cambiar de pestaña** — el shell no se destruye entre ellas;
 *  · cada pantalla, al estar dentro del shell, lo inyecta para saber si hay una búsqueda activa
 *    (y esconder lo suyo mientras tanto) y para enterarse de qué vale eligió la persona;
 *  · **qué se hace con el vale lo decide la pantalla**: en Aprobación se decide; en Mis gastos,
 *    Historial y Expediente sólo se consulta y se le puede sumar evidencia.
 *
 * ⛔ Sólo para quien aprueba (`FINANCE_EXPENSES_COMPROBAR`): deja ver el gasto de toda la
 * empresa. Sin el permiso, `buscando()` es siempre falso y no se consulta nada; el servidor
 * además responde 403.
 */
@Injectable()
export class BuscadorGastosEstado {
  private readonly svc = inject(ComprobacionesService);
  private readonly perms = inject(PermissionsService);
  private readonly destroyRef = inject(DestroyRef);

  readonly puedeBuscar = computed(() => this.perms.has(Permission.FINANCE_EXPENSES_COMPROBAR));
  readonly busqueda = signal('');
  readonly resultado = signal<ResultadoBusquedaGastos | null>(null);
  readonly cargando = signal(false);
  readonly error = signal('');
  /** Hay texto (y permiso): la pantalla esconde lo suyo y se ven los resultados. */
  readonly buscando = computed(() => this.puedeBuscar() && this.busqueda().trim().length > 0);
  /** Muy poco para buscar. Un dígito sí vale: el folio se busca por dígitos. */
  readonly corta = computed(() => {
    const t = this.busqueda().trim();
    return t.length < MINIMO_BUSQUEDA_GASTOS && !/^\d$/.test(t);
  });

  /** El vale que eligió la persona. La pantalla activa lo abre con SUS acciones. */
  private readonly elegidos = new Subject<ExpedienteDelDia>();
  readonly aperturas$ = this.elegidos.asObservable();

  private espera: ReturnType<typeof setTimeout> | null = null;
  /** Cada búsqueda lleva su número: una respuesta vieja que llega tarde no pisa a la nueva. */
  private turno = 0;

  constructor() {
    this.destroyRef.onDestroy(() => { if (this.espera) clearTimeout(this.espera); });
  }

  abrir(v: ExpedienteDelDia): void { this.elegidos.next(v); }

  /** Busca solo, un momento después de dejar de escribir: no una consulta por tecla. */
  escribir(v: string): void {
    this.busqueda.set(String(v ?? ''));
    if (this.espera) clearTimeout(this.espera);
    if (!this.buscando() || this.corta()) { this.turno++; this.resultado.set(null); this.error.set(''); return; }
    this.espera = setTimeout(() => this.ejecutar(), 350);
  }

  /** Enter: sin esperar. */
  buscarYa(): void {
    if (this.espera) clearTimeout(this.espera);
    if (this.buscando() && !this.corta()) this.ejecutar();
  }

  limpiar(): void {
    if (this.espera) clearTimeout(this.espera);
    this.turno++;
    this.busqueda.set('');
    this.resultado.set(null);
    this.error.set('');
    this.cargando.set(false);
  }

  /**
   * Vuelve a buscar lo mismo. La pantalla lo llama después de decidir sobre un vale: su renglón
   * tiene que decir el estado nuevo, no el de hace un momento.
   */
  rebuscar(): void {
    if (this.buscando() && !this.corta()) this.ejecutar();
  }

  /** `[GX.87]` Se le agregó evidencia a un vale: los resultados muestran sus archivos nuevos. */
  conArchivos(id: string, files: ProofFile[]): void {
    this.resultado.update((r) => (r ? { ...r, vales: r.vales.map((v) => (v.id === id ? { ...v, files } : v)) } : r));
  }

  ejecutar(): void {
    const q = this.busqueda().trim();
    const turno = ++this.turno;
    this.cargando.set(true);
    this.error.set('');
    this.svc.buscarGastos(q).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        if (turno !== this.turno) return;
        this.resultado.set(r);
        this.cargando.set(false);
      },
      // Un error NO se pinta como «no hay resultados»: son dos afirmaciones distintas.
      error: () => {
        if (turno !== this.turno) return;
        this.resultado.set(null);
        this.error.set('No se pudo buscar. Vuelve a intentar.');
        this.cargando.set(false);
      },
    });
  }
}
