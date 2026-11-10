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
 * `[GX.103]` El vale cuyo folio ES lo escrito (`10570` = `0010570`), si es UNO solo. El folio es por
 * sucursal: con dos o más vales del mismo folio no se adivina cuál, se elige de la lista.
 */
export function valeDelFolio(q: string, vales: readonly ExpedienteDelDia[]): ExpedienteDelDia | null {
  const t = String(q ?? '').trim();
  if (!/^\d+$/.test(t) || t.length > 15) return null;
  const n = Number(t);
  const iguales = vales.filter((v) => {
    const cifras = String(v.folio_solicitud ?? '').replace(/\D/g, '');
    return cifras !== '' && Number(cifras) === n;
  });
  return iguales.length === 1 ? iguales[0] : null;
}

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
  /** `[GX.103]` Se pidieron los últimos gastos con la caja vacía (Enter, F9 o «Últimos»): la lista de F9 de Kepler. */
  readonly recientes = signal(false);
  readonly resultado = signal<ResultadoBusquedaGastos | null>(null);
  readonly cargando = signal(false);
  readonly error = signal('');
  /** Hay texto, o se pidieron los recientes (y hay permiso): la pantalla esconde lo suyo y se ven los resultados. */
  readonly buscando = computed(() => this.puedeBuscar() && (this.busqueda().trim().length > 0 || this.recientes()));
  /**
   * Muy poco para buscar. Un dígito sí vale: el folio se busca por dígitos. La caja VACÍA no es «corta»:
   * con ella se piden los recientes.
   */
  readonly corta = computed(() => {
    const t = this.busqueda().trim();
    return t.length > 0 && t.length < MINIMO_BUSQUEDA_GASTOS && !/^\d$/.test(t);
  });

  /** El vale que eligió la persona. La pantalla activa lo abre con SUS acciones. */
  private readonly elegidos = new Subject<ExpedienteDelDia>();
  readonly aperturas$ = this.elegidos.asObservable();

  private espera: ReturnType<typeof setTimeout> | null = null;
  /** Cada búsqueda lleva su número: una respuesta vieja que llega tarde no pisa a la nueva. */
  private turno = 0;
  /** `[GX.103]` La búsqueda salió de un Enter: si lo escrito es el folio de UN solo vale, se abre al llegar. */
  private abrirAlLlegar = false;

  constructor() {
    this.destroyRef.onDestroy(() => { if (this.espera) clearTimeout(this.espera); });
  }

  abrir(v: ExpedienteDelDia): void { this.elegidos.next(v); }

  /** Busca solo, un momento después de dejar de escribir: no una consulta por tecla. */
  escribir(v: string): void {
    this.busqueda.set(String(v ?? ''));
    // Escribir deja los recientes: ahora se busca lo escrito (y borrarlo todo regresa a la pantalla).
    this.recientes.set(false);
    this.abrirAlLlegar = false;
    if (this.espera) clearTimeout(this.espera);
    if (!this.buscando() || this.corta()) { this.turno++; this.resultado.set(null); this.error.set(''); return; }
    this.espera = setTimeout(() => this.ejecutar(), 350);
  }

  /**
   * Enter: sin esperar. `[GX.103]` Con la caja vacía, los recientes. Con un folio que es de UN solo
   * vale, lo abre directo: lo que hace Kepler con folio + Enter. Si el folio está en dos sucursales,
   * no se adivina: se elige de la lista.
   */
  buscarYa(): void {
    if (this.espera) clearTimeout(this.espera);
    if (!this.puedeBuscar()) return;
    const q = this.busqueda().trim();
    if (!q) { this.verRecientes(); return; }
    if (this.corta()) return;
    const r = this.resultado();
    // Lo que ya está en pantalla es de esta misma búsqueda: se abre sin volver a preguntar.
    if (r && !r.recientes && r.q === q && !this.cargando()) { this.abrirSiEsElFolio(r); return; }
    this.abrirAlLlegar = true;
    this.ejecutar();
  }

  /** `[GX.103]` Los últimos gastos, sin escribir nada: la lista que Kepler enseña con F9. */
  verRecientes(): void {
    if (!this.puedeBuscar()) return;
    if (this.espera) clearTimeout(this.espera);
    this.busqueda.set('');
    this.recientes.set(true);
    this.abrirAlLlegar = false;
    this.ejecutar();
  }

  limpiar(): void {
    if (this.espera) clearTimeout(this.espera);
    this.turno++;
    this.busqueda.set('');
    this.recientes.set(false);
    this.abrirAlLlegar = false;
    this.resultado.set(null);
    this.error.set('');
    this.cargando.set(false);
  }

  private abrirSiEsElFolio(r: ResultadoBusquedaGastos): void {
    const v = valeDelFolio(r.q, r.vales);
    if (v) this.abrir(v);
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
    // Con los recientes la caja va vacía: el servidor lo lee como «los últimos».
    const q = this.recientes() ? '' : this.busqueda().trim();
    const abrir = this.abrirAlLlegar;
    this.abrirAlLlegar = false;
    const turno = ++this.turno;
    this.cargando.set(true);
    this.error.set('');
    this.svc.buscarGastos(q).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        if (turno !== this.turno) return;
        this.resultado.set(r);
        this.cargando.set(false);
        if (abrir) this.abrirSiEsElFolio(r);
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
