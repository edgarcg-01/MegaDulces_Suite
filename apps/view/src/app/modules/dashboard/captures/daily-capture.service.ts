import { Injectable, signal, computed, inject, effect } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, tap, forkJoin } from 'rxjs';
import { 
  VisitaSnapshot, 
  RegistroExhibicion,
  ConceptoExhibicion,
  UbicacionExhibicion,
  BrandGroup
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

  readonly visitasHoy = computed(() => {
    const today = new Date().toISOString().split('T')[0];
    return this._captures().filter(c => c.fechaCaptura === today);
  });

  // --- Computed Stats for Active Capture ---
  readonly stats = computed(() => {
    const exhibiciones = this._activeExhibiciones();
    
    let puntuacionTotal = 0;
    let ventaTotal = 0;
    let totalProductosMarcados = 0;

    exhibiciones.forEach(ex => {
      puntuacionTotal += ex.puntuacionCalculada;
      ventaTotal += ex.ventaAdicional || 0;
      totalProductosMarcados += ex.productosMarcados.length;
    });

    return {
      totalExhibiciones: exhibiciones.length,
      totalProductosMarcados,
      puntuacionTotal,
      ventaTotal
    };
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
  iniciarVisita() {
    this._horaInicio.set(new Date().toISOString());
    this._activeExhibiciones.set([]);
    this._latitud.set(null);
    this._longitud.set(null);
    
    // Forzar captura de ubicación fresca al iniciar cada visita
    this.capturarUbicacion();
  }

  capturarUbicacion(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject('Geolocation not supported');
        return;
      }

      navigator.geolocation.getCurrentPosition(
        (pos) => {
          this._latitud.set(pos.coords.latitude);
          this._longitud.set(pos.coords.longitude);
          resolve();
        },
        (err) => {
          console.warn('Error capturando GPS:', err);
          // Opcional: Intentar con baja precisión si falla la alta
          navigator.geolocation.getCurrentPosition(
            (pos) => {
              this._latitud.set(pos.coords.latitude);
              this._longitud.set(pos.coords.longitude);
              resolve();
            },
            (err2) => {
              console.error('Fallo absoluto de GPS:', err2);
              reject(err2);
            },
            { enableHighAccuracy: false, timeout: 5000, maximumAge: 30000 }
          );
        },
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
      );
    });
  }

  // --- Exhibition Actions ---
  addExhibicion(registro: Omit<RegistroExhibicion, 'id' | 'puntuacionCalculada' | 'horaRegistro'>) {
    // 1. Resolve objects from Catalogs (Source of Truth)
    const ubi = this._ubicaciones().find(u => u.id === registro.ubicacionId);
    const con = this._conceptos().find(c => c.id === registro.conceptoId);
    const niv = this._niveles().find(n => n.value.toLowerCase() === registro.nivelEjecucion?.toLowerCase());

    // 2. Base points from Catalog Items
    const puntosPosicion = ubi?.puntuacion || 0;
    const puntosConcepto = con?.puntuacion || 0;
    const multiplicador  = (niv?.puntuacion || 100) / 100; // Ej: 120 -> 1.2x

    // 3. Sumar puntos de productos marcados
    let puntosProductos = 0;
    if (registro.productosMarcados && registro.productosMarcados.length > 0) {
      this._groupedProducts().forEach(brand => {
        brand.items.forEach(prod => {
          if (registro.productosMarcados.includes(prod.pid)) {
            puntosProductos += (prod.puntuacion || 0);
          }
        });
      });
    }

    // 4. Fórmula Final Unificada: [(Posición + Concepto) + Productos] * Multiplicador
    const score = (puntosPosicion + puntosConcepto + puntosProductos) * multiplicador;

    const newExhibicion: RegistroExhibicion = {
      ...registro,
      id: Math.random().toString(36).substring(2, 9),
      puntuacionCalculada: Math.round(score * 100) / 100,
      horaRegistro: new Date().toISOString()
    };

    this._activeExhibiciones.update(curr => [...curr, newExhibicion]);
  }

  removeExhibicion(id: string) {
    this._activeExhibiciones.update(curr => curr.filter(ex => ex.id !== id));
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
    // Usar formato local YYYY-MM-DD para evitar desplazamientos por UTC
    const localDateStr = d.toLocaleDateString('en-CA'); 

    const payload = {
      folio: customFolio,
      fechaCaptura: localDateStr,
      horaInicio: this._horaInicio()!,
      horaFin: d.toISOString(),
      exhibiciones: this._activeExhibiciones(),
      stats: s,
      latitud: this._latitud(),
      longitud: this._longitud()
    };

    return this.http.post<any>(`${this.apiUrl}/daily-captures`, payload).pipe(
      tap((res: any) => {
        const parsedRes: VisitaSnapshot = {
           folio: res.folio,
           fechaCaptura: this.formatDate(res.fecha || res.fechaCaptura),
           horaInicio: res.hora_inicio || res.horaInicio,
           horaFin: res.hora_fin || res.horaFin,
           capturedBy: res.captured_by_username || user?.username || 'Sistema',
           zona: res.zona_captura,
           exhibiciones: typeof res.exhibiciones === 'string' ? JSON.parse(res.exhibiciones) : (res.exhibiciones || []),
           stats: typeof res.stats === 'string' ? JSON.parse(res.stats) : (res.stats || {})
        };
        
        this._captures.update(curr => [parsedRes, ...curr]);
        this.clearActiveState();
      })
    );
  }

  loadTodayCaptures() {
    const today = new Date().toISOString().split('T')[0];
    this.http.get<any[]>(`${this.apiUrl}/daily-captures?fecha=${today}`).subscribe({
      next: (data: any[]) => {
        const parsedData = data.map(item => ({
             folio: item.folio,
             fechaCaptura: this.formatDate(item.fecha || item.fechaCaptura),
             horaInicio: item.hora_inicio || item.horaInicio,
             horaFin: item.hora_fin || item.horaFin,
             capturedBy: item.captured_by_username || 'Sistema',
             zona: item.zona_captura,
             exhibiciones: typeof item.exhibiciones === 'string' ? JSON.parse(item.exhibiciones) : (item.exhibiciones || []),
             stats: typeof item.stats === 'string' ? JSON.parse(item.stats) : (item.stats || {})
        }));
        this._captures.set(parsedData);
      },
      error: (err) => console.error('Error fetching visits from server', err)
    });
  }

  loadMasterData() {
    forkJoin({
      conceptos: this.http.get<any[]>(`${this.apiUrl}/catalogs/conceptos`),
      ubicaciones: this.http.get<any[]>(`${this.apiUrl}/catalogs/ubicaciones`),
      niveles: this.http.get<any[]>(`${this.apiUrl}/catalogs/niveles`),
      planograma: this.http.get<any[]>(`${this.apiUrl}/planograms/brands`),
      scoring: this.http.get<any>(`${this.apiUrl}/scoring/config`)
    }).subscribe({
      next: (res) => {
        this._scoringConfig.set(res.scoring);
        this._niveles.set(res.niveles);
        // Mapear el catálogo de la BD (catalog_id, value) a la interfaz del UI (id, nombre)
        this._conceptos.set(res.conceptos.map(c => ({
          id: c.id,
          nombre: c.value,
          puntuacion: c.puntuacion,
          icono: c.icono
        })));

        this._ubicaciones.set(res.ubicaciones.map(u => ({
          id: u.id,
          nombre: u.value,
          puntuacion: u.puntuacion
        })));

        // Mapear planograma: Marcas -> Productos
        this._groupedProducts.set(res.planograma.map(b => ({
          marca: b.nombre,
          items: b.productos.map((p: any) => ({
            pid: p.id,
            name: p.nombre,
            puntuacion: p.puntuacion
          }))
        })));
      },
      error: (err) => console.error('Error loading master data from backend', err)
    });
  }
  
  // Manual trigger if needed by components
  refreshAll() {
    if (this.auth.isAuthenticated) {
      this.loadTodayCaptures();
      this.loadMasterData();
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
