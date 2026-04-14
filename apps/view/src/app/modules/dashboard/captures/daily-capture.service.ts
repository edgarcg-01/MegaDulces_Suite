import { Injectable, signal, computed, inject, effect } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, tap, forkJoin } from 'rxjs';
import {
  VisitaSnapshot,
  RegistroExhibicion,
  ConceptoExhibicion,
  UbicacionExhibicion,
  BrandGroup,
} from './daily-capture.models';
import { AuthService } from '../../../core/services/auth.service';
import { environment } from '../../../../environments/environment';

@Injectable({ providedIn: 'root' })
export class DailyCaptureService {
  private auth = inject(AuthService);
  private http = inject(HttpClient);
  private apiUrl = environment.apiUrl;

  // --- Master Data (Fetched from API) ---
  private _conceptos = signal<ConceptoExhibicion[]>([]);
  readonly conceptos = this._conceptos.asReadonly();

  private _ubicaciones = signal<UbicacionExhibicion[]>([]);
  readonly ubicaciones = this._ubicaciones.asReadonly();

  private _groupedProducts = signal<BrandGroup[]>([]);
  readonly groupedProducts = this._groupedProducts.asReadonly();

  private _scoringConfig = signal<any>(null);
  readonly scoringConfig = this._scoringConfig.asReadonly();

  private _niveles = signal<any[]>([]);
  readonly niveles = this._niveles.asReadonly();

  // --- Active Visit State ---
  private _horaInicio = signal<string | null>(null);
  readonly horaInicio = this._horaInicio.asReadonly();
  readonly hasActiveVisit = computed(() => this._horaInicio() !== null);

  private _latitud = signal<number | null>(null);
  readonly latitud = this._latitud.asReadonly();

  private _longitud = signal<number | null>(null);
  readonly longitud = this._longitud.asReadonly();

  private _activeExhibiciones = signal<RegistroExhibicion[]>([]);
  readonly activeExhibiciones = this._activeExhibiciones.asReadonly();

  // --- Captures History ---
  private _captures = signal<VisitaSnapshot[]>([]);
  readonly captures = this._captures.asReadonly();

  private _currentAssignment = signal<any | null>(null);
  readonly currentAssignment = this._currentAssignment.asReadonly();

  readonly visitasHoy = computed(() => {
    const today = new Date().toISOString().split('T')[0];
    const user = this.auth.user();
    if (!user) return [];
    return this._captures().filter((c) => c.fechaCaptura === today && c.userId === user.sub);
  });

  // --- Computed Stats for Active Capture ---
  readonly stats = computed(() => {
    const exhibiciones = this._activeExhibiciones();
    let puntuacionTotal = 0;
    let ventaTotal = 0;
    let totalProductosMarcados = 0;

    exhibiciones.forEach((ex) => {
      puntuacionTotal += ex.puntuacionCalculada;
      ventaTotal += ex.ventaAdicional || 0;
      totalProductosMarcados += ex.productosMarcados.length;
    });

    return {
      totalExhibiciones: exhibiciones.length,
      totalProductosMarcados,
      puntuacionTotal,
      ventaTotal,
    };
  });

  // --- Computed Max Score from Catalogs ---
  readonly maxScore = computed(() => {
    const ubicaciones = this._ubicaciones();
    const conceptos = this._conceptos();
    const niveles = this._niveles();

    const maxUbicacion = Math.max(...ubicaciones.map(u => Number(u.puntuacion) || 0));
    const maxConcepto = Math.max(...conceptos.map(c => Number(c.puntuacion) || 0));
    const maxNivel = Math.max(...niveles.map(n => Number(n.puntuacion) || 0));

    return maxUbicacion * maxConcepto * maxNivel;
  });

  // --- Computed Percentage ---
  readonly scorePercentage = computed(() => {
    const s = this.stats();
    const maxPerExhibicion = this.maxScore();
    const numExhibiciones = s.totalExhibiciones;
    
    // El máximo de la visita es el máximo por exhibición × número de exhibiciones
    const maxVisita = maxPerExhibicion * numExhibiciones;
    
    if (maxVisita === 0) return 0;
    return Math.round((s.puntuacionTotal / maxVisita) * 100);
  });

  constructor() {
    // Reactively load data when user state becomes available
    effect(() => {
      const u = this.auth.user();
      if (u) {
        this.loadTodayCaptures();
        this.loadMasterData();
      }
    });
  }

  // --- Visit Lifecycle Actions ---
  async iniciarVisita(): Promise<boolean> {
    this._horaInicio.set(new Date().toISOString());
    this._activeExhibiciones.set([]);
    this._latitud.set(null);
    this._longitud.set(null);

    // Intentar capturar ubicación al iniciar la visita
    try {
      await this.capturarUbicacion();
      console.log(
        'GPS capturado exitosamente:',
        this._latitud(),
        this._longitud(),
      );
      return true;
    } catch (error) {
      console.warn(
        'No se pudo caspturar GPS, continuando sin ubicación:',
        error,
      );
      // No fallar la visita por GPS, pero registrar el problema
      return true;
    }
  }

  capturarUbicacion(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        console.error('Geolocalización no soportada en este navegador');
        reject('Geolocation not supported');
        return;
      }

      // Intentar con alta precisión primero
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          this._latitud.set(pos.coords.latitude);
          this._longitud.set(pos.coords.longitude);
          console.log('GPS capturado con alta precisión:', pos.coords.latitude, pos.coords.longitude);
          resolve();
        },
        (err) => {
          console.warn('Error con GPS de alta precisión:', err.message);
          // Intentar con baja precisión como fallback
          navigator.geolocation.getCurrentPosition(
            (pos) => {
              this._latitud.set(pos.coords.latitude);
              this._longitud.set(pos.coords.longitude);
              console.log('GPS capturado con baja precisión:', pos.coords.latitude, pos.coords.longitude);
              resolve();
            },
            (err2) => {
              console.error('Fallo absoluto de GPS:', err2.message);
              reject(err2);
            },
            {
              enableHighAccuracy: false,
              timeout: 10000,
              maximumAge: 60000
            }
          );
        },
        {
          enableHighAccuracy: true,
          timeout: 20000,
          maximumAge: 0
        }
      );
    });
  }

  // --- Exhibition Actions ---
  addExhibicion(registro: Omit<RegistroExhibicion, 'id' | 'puntuacionCalculada' | 'horaRegistro'>) {
    console.log('[addExhibicion] Called with:', registro);

    // 1. Resolve objects from Catalogs (Source of Truth)
    const ubi = this._ubicaciones().find((u) => u.id === registro.ubicacionId);
    const con = this._conceptos().find((c) => c.id === registro.conceptoId);
    const niv = this._niveles().find(n => n.value.toLowerCase() === registro.nivelEjecucion?.toLowerCase());

    console.log('[addExhibicion] Catalog lookup:');
    console.log('  - ubicaciones available:', this._ubicaciones());
    console.log('  - conceptos available:', this._conceptos());
    console.log('  - niveles available:', this._niveles());
    console.log('  - niveles structure:', this._niveles().map(n => ({ value: n.value, puntuacion: n.puntuacion })));
    console.log('  - registro.nivelEjecucion:', registro.nivelEjecucion);
    console.log('  - ubi found:', ubi);
    console.log('  - con found:', con);
    console.log('  - niv found:', niv);

    // 2. Base points from Catalog Items
    const puntosPosicion = Number(ubi?.puntuacion) || 0;
    const puntosConcepto = Number(con?.puntuacion) || 0;
    const multiplicador = Number(niv?.puntuacion) || 1; // Niveles ahora usan valores decimales: 1.0, 0.7, 0.4, 0.2

    console.log('[addExhibicion] Base points:');
    console.log('  - puntosPosicion:', puntosPosicion);
    console.log('  - puntosConcepto:', puntosConcepto);
    console.log('  - multiplicador:', multiplicador);

    // 3. Sumar puntos de productos marcados
    let puntosProductos = 0;
    if (registro.productosMarcados && registro.productosMarcados.length > 0) {
      this._groupedProducts().forEach((brand) => {
        brand.items.forEach((prod) => {
          if (registro.productosMarcados.includes(prod.pid)) {
            puntosProductos += Number(prod.puntuacion) || 0;
          }
        });
      });
    }

    console.log('[addExhibicion] Productos points:', puntosProductos);

    // 4. Fórmula Final Unificada: Posición × Concepto × Nivel (según backend)
    const score = puntosPosicion * puntosConcepto * multiplicador;

    console.log('[addExhibicion] Final score:', score);

    const newExhibicion: RegistroExhibicion = {
      ...registro,
      id: Math.random().toString(36).substring(2, 9),
      puntuacionCalculada: Math.round(score * 100) / 100,
      horaRegistro: new Date().toISOString(),
    };

    console.log('[addExhibicion] New exhibicion:', newExhibicion);

    this._activeExhibiciones.update((curr) => [...curr, newExhibicion]);
  }

  removeExhibicion(id: string) {
    this._activeExhibiciones.update((curr) => curr.filter((ex) => ex.id !== id));
  }

  // --- External API Actions ---
  saveCapturaTotal(): Observable<VisitaSnapshot> | null {
    if (!this.hasActiveVisit()) return null;

    const s = this.stats();
    const user = this.auth.user();
    if (!user) return null;

    const d = new Date();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    const customFolio = `${user.username.charAt(0).toUpperCase()}-${hh}${mm}${ss}`;
    // Usar la fecha de inicio de la visita para fechaCaptura (extraer del timestamp ISO)
    const fechaInicio = this._horaInicio()!;
    const localDateStr = fechaInicio.split('T')[0];

    const payload = {
      folio: customFolio,
      fechaCaptura: localDateStr,
      horaInicio: this._horaInicio()!,
      horaFin: d.toISOString(),
      exhibiciones: this._activeExhibiciones(),
      stats: s,
      latitud: this._latitud(),
      longitud: this._longitud(),
    };

    return this.http.post<any>(`${this.apiUrl}/daily-captures`, payload).pipe(
      tap((res: any) => {
        console.log('[saveCapturaTotal] Response from backend:', res);
        console.log('[saveCapturaTotal] Stats in response:', res.stats);

        const parsedRes: VisitaSnapshot = {
          folio: res.folio,
          userId: res.user_id,
          fechaCaptura: this.formatDate(res.fecha || res.fechaCaptura),
          horaInicio: res.hora_inicio || res.horaInicio,
          horaFin: res.hora_fin || res.horaFin,
          capturedBy: res.captured_by_username || user?.username || 'Sistema',
          zona: res.zona_captura,
          exhibiciones: typeof res.exhibiciones === 'string' ? JSON.parse(res.exhibiciones) : (res.exhibiciones || []),
          stats: typeof res.stats === 'string' ? JSON.parse(res.stats) : (res.stats || {})
        };

        console.log('[saveCapturaTotal] Parsed stats:', parsedRes.stats);

        this._captures.update((curr) => [parsedRes, ...curr]);
        this.clearActiveState();
      }),
    );
  }

  loadTodayCaptures() {
    const today = new Date().toISOString().split('T')[0];
    this.http.get<any[]>(`${this.apiUrl}/daily-captures?fecha=${today}`).subscribe({
        next: (data: any[]) => {
        const parsedData = data.map(item => ({
            folio: item.folio,
            userId: item.user_id,
            fechaCaptura: this.formatDate(item.fecha || item.fechaCaptura),
            horaInicio: item.hora_inicio || item.horaInicio,
            horaFin: item.hora_fin || item.horaFin,
            capturedBy: item.captured_by_username || 'Sistema',
            zona: item.zona_captura,
            exhibiciones: typeof item.exhibiciones === 'string' ? JSON.parse(item.exhibiciones) : (item.exhibiciones || []),
            stats: typeof item.stats === 'string' ? JSON.parse(item.stats) : (item.stats || {})          }));
          this._captures.set(parsedData);
        },
      error: (err) => console.error('Error fetching visits from server', err)
      });
  }

  loadTodayAssignment() {
    const user = this.auth.user();
    if (!user) return;

    const day = new Date().getDay(); 
    const dayOfWeek = day === 0 ? 7 : day; // 1=Mon, 7=Sun

    this.http.get<any[]>(`${this.apiUrl}/daily-assignments?user_id=${user.sub}&day_of_week=${dayOfWeek}`)
      .subscribe({
        next: (data) => {
          if (data && data.length > 0) {
            this._currentAssignment.set(data[0]);
          } else {
            this._currentAssignment.set(null);
          }
        },
        error: (err) => console.error('Error loading today assignment', err)
      });
  }

  loadMasterData() {
    forkJoin({
      conceptos: this.http.get<any[]>(`${this.apiUrl}/catalogs/conceptos`),
      ubicaciones: this.http.get<any[]>(`${this.apiUrl}/catalogs/ubicaciones`),
      niveles: this.http.get<any[]>(`${this.apiUrl}/catalogs/niveles`),
      planograma: this.http.get<any[]>(`${this.apiUrl}/planograms/brands`),
      scoring: this.http.get<any>(`${this.apiUrl}/scoring/config`),
    }).subscribe({
      next: (res) => {
        this._scoringConfig.set(res.scoring);
        this._niveles.set(res.niveles);
        // Mapear el catálogo de la BD (catalog_id, value) a la interfaz del UI (id, nombre)
        this._conceptos.set(
          res.conceptos.map((c) => ({
            id: c.id,
            nombre: c.value,
            puntuacion: c.puntuacion,
            icono: c.icono
          })),
        );

        this._ubicaciones.set(
          res.ubicaciones.map((u) => ({
            id: u.id,
            nombre: u.value,
            puntuacion: u.puntuacion,
          })),
        );

        // Mapear planograma: Marcas -> Productos
        this._groupedProducts.set(
          res.planograma.map((b) => ({
            marca: b.nombre,
            items: (b.productos || []).map((p: any) => ({
              pid: p.id,
              name: p.nombre,
              puntuacion: p.puntuacion,
            })),
          })),
        );
      },
      error: (err) =>
        console.error('Error loading master data from backend', err),
    });
  }

  // Manual trigger if needed by components
  refreshAll() {
    if (this.auth.isAuthenticated) {
      this.loadTodayCaptures();
      this.loadMasterData();
      this.loadTodayAssignment();
    }
  }

  clearActiveState() {
    this._horaInicio.set(null);
    this._activeExhibiciones.set([]);
  }

  isPastCutoff(): boolean {
    const now = new Date();
    return now.getHours() >= 18;
  }

  private formatDate(dateStr: string | Date | undefined): string {
    if (!dateStr) return '';
    try {
      const d = new Date(dateStr);
      return d.toISOString().split('T')[0];
    } catch {
      return '';
    }
  }
}
