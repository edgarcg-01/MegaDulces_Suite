import { Injectable, Logger } from '@nestjs/common';

/** Unidad económica normalizada desde la respuesta cruda de DENUE (22 campos). */
export interface DenueUnit {
  id: string; // CLEE / Id (source_ref)
  nombre: string;
  razon_social: string;
  scian: string; // clave de la clase de actividad
  scian_label: string;
  estrato: string; // personal ocupado (rango)
  tipo: string; // Fijo | Semifijo
  lat: number | null;
  lng: number | null;
  calle: string;
  num_ext: string;
  colonia: string;
  cp: string;
  municipio: string;
  entidad: string;
  telefono: string;
  email: string;
  web: string;
  raw: Record<string, any>;
}

/**
 * Cliente de la API DENUE de INEGI (v1). Wrapper aislado igual que MapboxService:
 *  - buscar:        POIs por keyword a ≤5 km de un punto (prospección en vivo).
 *  - buscarAreaAct: cosecha sistemática por clase SCIAN + área, paginada.
 *  - cuantificar:   conteo del universo por SCIAN/área (planeación, barato).
 *  - ficha:         detalle de UNA unidad por su CLEE/id (enriquecimiento).
 *
 * Token gratuito vía DENUE_TOKEN. DENUE es dato abierto → resultados almacenables
 * (con atribución a INEGI). Se actualiza ~2×/año, así que la cosecha es infrecuente.
 * Degrada con gracia si no hay token (enabled=false → los services no rompen).
 */
@Injectable()
export class DenueClientService {
  private readonly logger = new Logger(DenueClientService.name);
  private readonly token = process.env.DENUE_TOKEN || '';
  private readonly base = 'https://www.inegi.org.mx/app/api/denue/v1/consulta';

  get enabled(): boolean {
    return !!this.token;
  }

  /** POIs por keyword (`condicion`, "todos" = todas las actividades) a ≤5 km de lat/lng. */
  async buscar(condicion: string, lat: number, lng: number, metros: number): Promise<DenueUnit[]> {
    const m = Math.min(Math.max(Math.round(metros) || 0, 1), 5000);
    const cond = encodeURIComponent((condicion || 'todos').trim() || 'todos');
    const url = `${this.base}/Buscar/${cond}/${lat},${lng}/${m}/${this.token}`;
    return this.fetchUnits(url);
  }

  /**
   * Cosecha sistemática por clase SCIAN dentro de un área. Params numéricos de
   * área no usados van en 0. Paginación por rango [ini, fin] (1-based, inclusivo).
   */
  async buscarAreaAct(opts: {
    entidad?: string; // 2 díg (ej. '25' Sinaloa); '0' = todas
    municipio?: string; // 3 díg; '0' = todos
    clase: string; // clase SCIAN (6 díg)
    nombre?: string; // keyword o '0'
    ini: number;
    fin: number;
  }): Promise<DenueUnit[]> {
    const ent = opts.entidad || '0';
    const mun = opts.municipio || '0';
    const nombre = encodeURIComponent(opts.nombre || '0');
    // entidad/municipio/localidad/ageb/manzana/sector/subsector/rama/clase/nombre/ini/fin/id/token
    const url =
      `${this.base}/BuscarAreaAct/${ent}/${mun}/0/0/0/0/0/0/${opts.clase}/${nombre}` +
      `/${opts.ini}/${opts.fin}/0/${this.token}`;
    return this.fetchUnits(url);
  }

  /**
   * Conteo del universo por actividad (SCIAN) y área. DENUE devuelve un desglose
   * (una fila por entidad/área con `Total`), así que SUMAMOS todas las filas —
   * con area='0' (nacional) son 32 filas; con un área específica, 1+.
   */
  async cuantificar(actividad: string, area = '0', estrato = '0'): Promise<number | null> {
    if (!this.token) return null;
    const url = `${this.base}/Cuantificar/${actividad}/${area}/${estrato}/${this.token}`;
    try {
      const j = await this.getJson(url);
      const rows = Array.isArray(j) ? j : j ? [j] : [];
      if (!rows.length) return 0;
      return rows.reduce((sum: number, r: any) => sum + (Number(r?.Total ?? r?.total ?? r) || 0), 0);
    } catch (e: any) {
      this.logger.warn(`cuantificar error: ${e?.message || e}`);
      return null;
    }
  }

  /** Detalle de UNA unidad por su CLEE/id. */
  async ficha(id: string): Promise<DenueUnit | null> {
    if (!this.token || !id) return null;
    const url = `${this.base}/Ficha/${encodeURIComponent(id)}/${this.token}`;
    const units = await this.fetchUnits(url);
    return units[0] || null;
  }

  // ── internos ───────────────────────────────────────────────────────────

  private async fetchUnits(url: string): Promise<DenueUnit[]> {
    if (!this.token) return [];
    try {
      const j = await this.getJson(url);
      const arr = Array.isArray(j) ? j : j ? [j] : [];
      return arr.map((r) => DenueClientService.normalize(r)).filter((u) => !!u.id);
    } catch (e: any) {
      this.logger.warn(`DENUE fetch error: ${e?.message || e}`);
      return [];
    }
  }

  /**
   * GET con reintento + backoff: INEGI corta conexiones bajo ráfaga (rate-limit
   * por IP), así que reintentamos hasta 3 veces con espera creciente. Timeout por
   * intento generoso (30s) porque los payloads de `Buscar` pueden ser grandes.
   */
  private async getJson(url: string, attempts = 3): Promise<any> {
    let lastErr: any;
    for (let i = 0; i < attempts; i++) {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 30000);
      try {
        const res = await fetch(url, { signal: ctrl.signal });
        if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        return text ? JSON.parse(text) : null;
      } catch (e: any) {
        lastErr = e;
        if (i < attempts - 1) await new Promise((r) => setTimeout(r, 800 * (i + 1)));
      } finally {
        clearTimeout(to);
      }
    }
    throw lastErr;
  }

  /** Mapea el registro crudo de DENUE (claves ES, casing variable) a DenueUnit. */
  private static normalize(r: Record<string, any>): DenueUnit {
    const g = (...keys: string[]): string => {
      for (const k of keys) {
        const v = r?.[k];
        if (v != null && String(v).trim() !== '') return String(v).trim();
      }
      return '';
    };
    const num = (...keys: string[]): number | null => {
      const v = g(...keys);
      const n = Number(v);
      return v && !isNaN(n) ? n : null;
    };
    // El código SCIAN no viene como campo propio en Buscar: va embebido en el
    // CLEE (entidad[2] + municipio[3] + clase SCIAN[6] + ...). `Clase_actividad`
    // es solo la descripción. Ej: "09015461160..." → clase = "461160".
    const clee = g('CLEE', 'clee');
    const scianFromClee = /^\d{11}/.test(clee) ? clee.slice(5, 11) : '';
    // Municipio/entidad: en Buscar vienen dentro de `Ubicacion` ("LOC, Municipio, ENTIDAD").
    let municipio = g('Municipio', 'municipio');
    let entidad = g('Entidad', 'entidad', 'Estado');
    const ubic = g('Ubicacion', 'ubicacion');
    if (ubic && (!municipio || !entidad)) {
      const parts = ubic.split(',').map((s) => s.trim()).filter(Boolean);
      if (parts.length >= 2) {
        entidad = entidad || parts[parts.length - 1];
        municipio = municipio || parts[parts.length - 2];
      }
    }
    return {
      id: clee || g('Id', 'id'),
      nombre: g('Nombre', 'nombre'),
      razon_social: g('Razon_social', 'razon_social'),
      scian: g('CodigoActEco', 'codigoActEco') || scianFromClee,
      scian_label: g('Clase_actividad', 'clase_actividad'),
      estrato: g('Estrato', 'estrato', 'Personal'),
      tipo: g('Tipo', 'tipo'),
      lat: num('Latitud', 'latitud'),
      lng: num('Longitud', 'longitud'),
      calle: g('Calle', 'calle'),
      num_ext: g('Num_Exterior', 'num_exterior'),
      colonia: g('Colonia', 'colonia'),
      cp: g('CP', 'cp'),
      municipio,
      entidad,
      telefono: g('Telefono', 'telefono'),
      email: g('Correo_e', 'correo_e', 'Correo'),
      web: g('Sitio_internet', 'sitio_internet', 'Web'),
      raw: r || {},
    };
  }
}
