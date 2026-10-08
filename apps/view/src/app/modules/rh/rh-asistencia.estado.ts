import { Injectable, computed, inject, signal } from '@angular/core';
import type { HrAsistenciaResponse, HrCierreDto, HrPersonaDirectorioDto, HrRelojEstadoDto, HrSiteDto } from '@megadulces/contracts';
import { PermissionsService } from '../../core/services/permissions.service';
import { Permission } from '../../core/constants/permissions';
import { RhService, etiquetaSemana, fechaCorta, hoyEnMexico, juevesDeLaSemana, rhError, sumarDias } from './rh.service';
import { faltasDelPeriodo, rebasados } from './reporte-formato';

export type AtajoPeriodo = 'hoy' | 'esta' | 'pasada';

/**
 * Fase RH · `[RH.1.7c]` — lo que comparten las pestañas de Asistencia (Checadas, Tolerancia, Faltas, Incidencias,
 * Relojes): la plaza, el periodo, los filtros y la asistencia ya calculada. En Mega Talento las tres primeras son el
 * MISMO componente y no se desmonta al cambiar de pestaña; aquí son páginas hermanas (el patrón `app-page-tabs` de la
 * Suite), así que el estado vive en un servicio para que cambiar de pestaña no pierda la plaza ni vuelva a pedir el
 * cálculo.
 */
@Injectable({ providedIn: 'root' })
export class RhAsistenciaEstado {
  private readonly api = inject(RhService);
  private readonly perms = inject(PermissionsService);

  readonly hoy = signal(hoyEnMexico());
  readonly sitios = signal<HrSiteDto[]>([]);
  readonly sitio = signal<string | null>(null);
  readonly modoHoy = signal(false);
  readonly jueves = signal(juevesDeLaSemana(hoyEnMexico()));
  readonly soloPromotoras = signal(false);

  // ── Filtros de la vista: se conservan al cambiar de pestaña, como en Mega Talento ──
  readonly departamentos = signal<string[]>([]);
  /** «Ver solo a esta persona»: su código. */
  readonly unica = signal<string | null>(null);
  readonly buscar = signal('');
  readonly soloIrregulares = signal(false);
  /** Una persona elegida en «Buscar en todas las plazas»: su ficha se abre en cuanto llega su plaza. */
  readonly fichaPendiente = signal<string | null>(null);

  readonly datos = signal<HrAsistenciaResponse | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly relojes = signal<HrRelojEstadoDto[]>([]);
  /** Separa «no hay relojes» de «no se pudo leer» (p. ej. un 403): lo segundo no se pinta. */
  readonly relojesMedidos = signal(false);
  /** Incidencias por calificar del periodo; null = no se pudo leer (sin permiso): no se pinta un cero. */
  readonly pendientes = signal<number | null>(null);
  /** Semanas cerradas que toca el periodo; null = no se pudo leer. */
  readonly cierres = signal<HrCierreDto[] | null>(null);
  readonly directorio = signal<HrPersonaDirectorioDto[] | null>(null);
  readonly directorioError = signal(false);

  readonly juevesActual = computed(() => juevesDeLaSemana(this.hoy()));
  readonly esSemanaActual = computed(() => this.jueves() >= this.juevesActual());
  /** El rango que se pide: hoy, o la semana de nómina recortada a hoy (lo que no ha pasado no se mide). */
  readonly rango = computed(() => {
    const hoy = this.hoy();
    if (this.modoHoy()) return { desde: hoy, hasta: hoy };
    const desde = this.jueves();
    const fin = sumarDias(desde, 6);
    return { desde, hasta: fin > hoy ? hoy : fin };
  });
  readonly atajo = computed<AtajoPeriodo | null>(() => {
    if (this.modoHoy()) return 'hoy';
    if (this.jueves() === this.juevesActual()) return 'esta';
    if (this.jueves() === sumarDias(this.juevesActual(), -7)) return 'pasada';
    return null;
  });
  readonly etiquetaPeriodo = computed(() => (this.modoHoy() ? `hoy, ${fechaCorta(this.hoy())}` : etiquetaSemana(this.jueves())));
  readonly nombreSitio = computed(() => this.sitios().find((s) => s.code === this.sitio())?.name ?? this.sitio() ?? '');
  readonly relojesSitio = computed(() => this.relojes().filter((r) => r.sucursalId === this.sitio()));

  // ── Lo que cuentan las pestañas ──
  /** En una sucursal sin hora límite no se mide tolerancia: no hay número que dar (null, no un cero). */
  readonly nRebasados = computed(() => (this.datos()?.mideRetardo === false ? null : rebasados(this.datos()).usables.length));
  readonly nFaltas = computed(() => faltasDelPeriodo(this.datos(), this.hoy()).length);

  readonly puedeVerIncidencias = computed(() => this.perms.hasAny(
    Permission.HR_ATTENDANCE_VER, Permission.HR_INCIDENTS_CAPTURAR, Permission.HR_INCIDENTS_CALIFICAR,
    Permission.HR_INCIDENTS_AUDITAR, Permission.HR_PERIOD_CLOSE,
  ));

  private clave = '';
  private seq = 0;

  /** Lee los sitios (una vez) y se asegura de que la asistencia que se ve sea la de la plaza y el periodo actuales. */
  iniciar(): void {
    this.hoy.set(hoyEnMexico());
    if (this.sitios().length) { this.asegurar(); return; }
    this.api.sitios().subscribe({
      next: (s) => {
        const activos = s.filter((x) => x.is_active);
        this.sitios.set(activos);
        if (!this.sitio() && activos.length) this.sitio.set(activos[0].code);
        this.asegurar();
      },
      error: (e) => this.error.set(rhError(e, 'No se pudieron leer los sitios de checado.')),
    });
  }

  /** Pide el cálculo sólo si cambió la plaza, el periodo o planta/promotoras (o si se fuerza). */
  asegurar(forzar = false): void {
    const site = this.sitio();
    if (!site) return;
    const { desde, hasta } = this.rango();
    const clave = [site, desde, hasta, this.soloPromotoras() ? 'p' : 'n'].join('|');
    if (!forzar && clave === this.clave && (this.datos() || this.loading())) return;
    this.clave = clave;
    this.cargar(site, desde, hasta);
  }

  private cargar(site: string, desde: string, hasta: string): void {
    const mi = ++this.seq;
    this.loading.set(true);
    this.error.set(null);
    this.api.estadoRelojes().subscribe({
      next: (r) => { this.relojes.set(r); this.relojesMedidos.set(true); },
      error: () => this.relojesMedidos.set(false),
    });
    this.leerIncidencias(site, desde, mi);
    this.api.asistencia({ site_code: site, date_from: desde, date_to: hasta, only_promoters: this.soloPromotoras() }).subscribe({
      next: (d) => { if (mi !== this.seq) return; this.datos.set(d); this.loading.set(false); },
      error: (e) => {
        if (mi !== this.seq) return;
        this.datos.set(null);
        this.error.set(rhError(e, 'No se pudo calcular la asistencia.'));
        this.loading.set(false);
      },
    });
  }

  /** Lo que espera en Incidencias y si la semana está cerrada (para la pestaña y el aviso del cierre). */
  private leerIncidencias(site: string, desde: string, mi: number): void {
    if (!this.puedeVerIncidencias()) return;
    const semana = { desde: juevesDeLaSemana(desde), hasta: sumarDias(juevesDeLaSemana(desde), 6) };
    this.api.incidencias({ site_code: site, date_from: semana.desde, date_to: semana.hasta, statuses: 'capturada' }).subscribe({
      next: (l) => { if (mi === this.seq) this.pendientes.set(l.length); },
      error: () => { if (mi === this.seq) this.pendientes.set(null); },
    });
    this.api.estadoCierre(site, semana.desde, semana.hasta).subscribe({
      next: (c) => { if (mi === this.seq) this.cierres.set(c); },
      error: () => { if (mi === this.seq) this.cierres.set(null); },
    });
  }

  /** Después de calificar o cerrar en Incidencias: el contador y el aviso, sin recalcular la asistencia. */
  refrescarIncidencias(): void {
    const site = this.sitio();
    if (site) this.leerIncidencias(site, this.rango().desde, this.seq);
  }

  /** Incidencias navega por semanas con sus propias flechas: esto deja el estado en la misma semana. */
  irASemana(jueves: string): void {
    if (!this.modoHoy() && jueves === this.jueves()) return;
    this.modoHoy.set(false);
    this.jueves.set(jueves > this.juevesActual() ? this.juevesActual() : jueves);
    this.asegurar();
  }

  setSitio(s: string): void {
    if (s === this.sitio()) return;
    this.sitio.set(s);
    this.limpiarFiltros();
    this.datos.set(null);
    this.asegurar();
  }

  setPromotoras(v: boolean): void {
    if (v === this.soloPromotoras()) return;
    this.soloPromotoras.set(v);
    this.limpiarFiltros();
    this.asegurar();
  }

  irA(a: AtajoPeriodo): void {
    this.hoy.set(hoyEnMexico());
    this.modoHoy.set(a === 'hoy');
    this.jueves.set(a === 'pasada' ? sumarDias(this.juevesActual(), -7) : this.juevesActual());
    this.asegurar();
  }

  moverSemana(dias: number): void {
    this.modoHoy.set(false);
    const j = sumarDias(this.jueves(), dias);
    this.jueves.set(j > this.juevesActual() ? this.juevesActual() : j);
    this.asegurar();
  }

  limpiarFiltros(): void {
    this.departamentos.set([]);
    this.unica.set(null);
    this.buscar.set('');
    this.soloIrregulares.set(false);
  }

  /** El directorio de todas las plazas se baja una vez, la primera vez que alguien busca. */
  cargarDirectorio(): void {
    if (this.directorio() || this.directorioError()) return;
    this.api.directorio().subscribe({
      next: (d) => this.directorio.set(d),
      error: () => this.directorioError.set(true),
    });
  }

  /** Elegida en «Buscar en todas las plazas»: va a su plaza (y a su vista de planta o promotoría) y abre su ficha. */
  irAPersona(p: HrPersonaDirectorioDto): void {
    this.limpiarFiltros();
    if (p.promotora !== this.soloPromotoras()) this.soloPromotoras.set(p.promotora);
    if (p.site_code !== this.sitio()) { this.sitio.set(p.site_code); this.datos.set(null); }
    this.fichaPendiente.set(p.codigo);
    this.asegurar();
  }
}
