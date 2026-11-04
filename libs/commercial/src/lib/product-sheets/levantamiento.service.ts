import { createHash } from 'crypto';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Knex } from 'knex';
import type {
  LevantamientoCalidadFoto, LevantamientoCara, LevantamientoContexto, LevantamientoEscaneoDto, LevantamientoEscaneoRespuesta,
  LevantamientoBusquedaFila, LevantamientoFotoRespuesta, LevantamientoMotivoSalto, LevantamientoPeldano, LevantamientoSaltoDto, LevantamientoSugeridosRespuesta,
} from '@megadulces/contracts';
import { LEVANTAMIENTO_CARA_OBLIGATORIA, LEVANTAMIENTO_CARAS, LEVANTAMIENTO_MOTIVOS_SALTO } from '@megadulces/contracts';
import { detectarTipo, ObjectStorageService, quitarMetadatosJpeg, ScopeService, TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import { resolverEscaneo, type KdiiFila, type ResultadoEscaneo } from '../shared/kdii-codigo';
import { kdiiPorCodigo, kdiiPorSku } from '../shared/kdii-lectura';
import {
  apartadoVivo, carasRequeridas, decidirEscaneo, ESTADOS_CON_FICHA, ESTADOS_EN_REVISION, estadoTrasFoto, nombreUnidad,
  caraResuelta, nuevoApartado, peldanoPrincipal, type AccionEscaneo, type Apartado, type ApartadoDelUsuario, type FotoFicha,
} from './levantamiento.rules';
import { CONTEOS_LEVANTAMIENTO_SQL, NO_FISICO_REGEX, SUGERIDOS_LEVANTAMIENTO_SQL } from './levantamiento.sql';
import { consultaBuscadorCatalogo, ORDEN_BUSCADOR_CATALOGO } from '../shared/catalogo-buscador';

/**
 * El área de alcance es el id del proyecto en `AUTHZ_TREE` (ZN.8), no el prefijo de la ruta. El módulo
 * vive en el proyecto `compras`, sin ruta en el mapa (es universal, como `servicio-reportar`).
 */
export const AREA_LEVANTAMIENTO = 'compras';

/** De dónde salió la sucursal de la captura (se guarda en la ficha). */
export type OrigenSucursal = 'perfil' | 'alcance' | 'elegida';

/** El frente no se salta (`LEVANTAMIENTO_CARA_OBLIGATORIA`): así toda ficha completa trae al menos una foto real. */
export const FRENTE_OBLIGATORIO = 'El frente siempre se fotografía: es la foto principal del catálogo. Si no se puede tomar, sal sin terminar.';

/** Tope por foto. La cámara del navegador entrega ~1-4 MB; un archivo de 15 MB ya no es una foto de anaquel. */
export const MAX_FOTO_BYTES = 15 * 1024 * 1024;

/**
 * La lectura de la IA (D6) está APAGADA por defecto: las fotos de teléfonos personales dentro de la
 * tienda pueden traer personas y viajarían a Anthropic. Se enciende con `NP7_AI_ENABLED=true` cuando
 * Edgar resuelva D6. Mientras tanto todo va a revisión de Catálogo (es el piloto, §10b.3 punto 4).
 * ⚠️ HOY NO CONECTA NINGUNA IA: la lectura llega con NP.7.L.11d. En `true` sólo escondería el aviso
 * «lo revisa Catálogo», así que NO se define en prod hasta que esa lectura exista.
 */
export const iaEncendida = (): boolean => process.env['NP7_AI_ENABLED'] === 'true';

export interface Quien {
  userId: string;
  username: string | null;
}

/**
 * `[NP.7.L.10]` La fila del buscador, armada campo por campo (LISTA BLANCA): la consulta que se reusa de
 * cotizaciones selecciona precio y venta, y nada de eso puede salir hacia quien captura.
 */
export function filaBusqueda(r: Record<string, unknown>): LevantamientoBusquedaFila {
  return {
    sku: String(r['sku']),
    name: String(r['name'] ?? ''),
    content: (r['content'] as string | null) ?? null,
    barcode: (r['barcode'] as string | null) ?? null,
    has_sheet: r['has_sheet'] === true,
  };
}

/** Lo que multer entrega (sin depender de `Express.Multer`). */
export interface ArchivoSubido {
  buffer: Buffer;
  size: number;
  originalname?: string;
  mimetype?: string;
}

interface FichaFila {
  id: string;
  origin: string;
  status: string;
  sku: string | null;
  branch_code: string | null;
  photos: FotoFicha[];
  sheet: Record<string, unknown>;
  created_by: string | null;
}

const MENSAJE: Record<AccionEscaneo, string> = {
  capturar: 'Toma las fotos de este producto.',
  ya_esta: 'Este producto ya tiene ficha. ¡Gracias! Escanea el siguiente.',
  en_revision: 'Este producto ya se levantó y está en revisión. Escanea el siguiente.',
  apartado_por_otro: 'Alguien más lo está levantando en este momento. Escanea otro.',
  demasiados_apartados: 'Tienes 3 productos a medias. Termina uno antes de empezar otro.',
  no_registrado: 'Este código no está registrado en esta sucursal. Búscalo por nombre o avísale a tu encargado: puede ser un producto nuevo.',
  codigo_compartido: 'Este código lo tienen varios productos en el sistema y no se puede levantar así. Avísale a tu encargado.',
  otra_unidad: 'Ese código es de otra presentación.',
  sin_unidad_principal: 'Todavía no sabemos qué presentación de este producto se vende más. Escanea otro.',
};

/**
 * `[NP.7.L.2]` + `[NP.7.L.9a]` El levantamiento: escanear, apartar, subir las fotos de la unidad
 * principal. Plan: `FASE_NP7_ALTA_DESDE_FOTOS.md` §10b.3.
 *
 * Toda consulta va dentro de `TenantKnexService.run()`: `catalog.product_sheets` tiene RLS forzada y
 * sin contexto devuelve CERO filas sin error (GOTCHAS §1).
 */
@Injectable()
export class LevantamientoService {
  private readonly logger = new Logger(LevantamientoService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly scope: ScopeService,
    private readonly storage: ObjectStorageService,
  ) {}

  // ── Sucursal ────────────────────────────────────────────────────────────────────────────────

  /**
   * La sucursal sobre la que se levanta (D25, 2026-11-02). Todos participan, y 88 de 184 personas activas
   * no tienen sucursal en su perfil (medido ese día), así que:
   *  · sin pedir nada → la de su perfil; si no tiene, se le pide elegir (`SUCURSAL_REQUERIDA`);
   *  · pide la de su perfil → ésa;
   *  · sin sucursal en el perfil → la que elija, si existe (queda marcada `elegida` en la ficha);
   *  · CON sucursal en el perfil y pide OTRA → sólo si su alcance de escritura se lo permite.
   * Es un dato de catálogo (fotos), no de dinero: por eso quien no tiene sucursal puede declarar dónde está.
   */
  async sucursal(quien: Quien, pedida?: string | null): Promise<{ code: string; source: OrigenSucursal }> {
    const code = String(pedida ?? '').trim();
    const propia = await this.sucursalDelPerfil(quien.userId);
    if (!code) {
      if (propia) return { code: propia, source: 'perfil' };
      throw new BadRequestException({ code: 'SUCURSAL_REQUERIDA', message: 'Elige la sucursal donde estás.' });
    }
    if (code === propia) return { code, source: 'perfil' };
    const existe = await this.tk.run((trx) => trx('commercial.warehouses').where({ kepler_code: code }).whereNull('deleted_at').first('kepler_code'));
    if (!existe || !/^[0-9]{2}$/.test(code)) throw new BadRequestException('Esa sucursal no existe.');
    if (!propia) return { code, source: 'elegida' };
    await this.scope.assertCanWrite('warehouse', code, AREA_LEVANTAMIENTO);
    return { code, source: 'alcance' };
  }

  /** La sucursal del perfil de la persona (vacío si no tiene). Aparte para que la prueba de integración la fije. */
  protected async sucursalDelPerfil(userId: string): Promise<string> {
    const perfil = await this.tk.run((trx) => trx('identity.users').where({ id: userId }).first('warehouse_code'));
    return String(perfil?.warehouse_code ?? '').trim();
  }

  /**
   * La unidad más vendida del SKU en la sucursal, como FACTOR (`mv_kepler_sold_rung.rung_modal`). Aparte porque
   * es una vista materializada: la prueba de integración no puede sembrarle filas y la fija aquí.
   */
  protected async rungModal(trx: Knex.Transaction, branch: string, sku: string): Promise<number | null> {
    const rm = await trx('analytics.mv_kepler_sold_rung').where({ sucursal: branch, sku }).first('rung_modal');
    return rm?.rung_modal == null ? null : Number(rm.rung_modal);
  }

  /**
   * Universo y faltantes de la sucursal. Aparte porque lee vistas materializadas del ODS que la base vacía
   * del CI no tiene: la prueba de integración lo fija aquí y ejerce el resto del contexto.
   */
  protected async conteos(trx: Knex.Transaction, tenant: string, branch: string): Promise<{ universe: number; missing: number }> {
    // El planificador estima 1 fila en la ficha de Kepler (son ~9,700) y elige ciclos anidados:
    // 3.5 s → 0.5 s sin ellos, medido 2026-11-02. Sólo dentro de esta transacción.
    await trx.raw('SET LOCAL enable_nestloop = off');
    const c = (await trx.raw(CONTEOS_LEVANTAMIENTO_SQL, { tenant, branch, no_fisico: NO_FISICO_REGEX })).rows[0] as { universe: number; missing: number };
    return { universe: Number(c.universe), missing: Number(c.missing) };
  }

  /** Las sucursales para elegir (las de Kepler, con su nombre; nunca «07» suelto en pantalla). */
  async sucursales(): Promise<Array<{ code: string; name: string }>> {
    return this.tk.run(async (trx) => {
      const rows = await trx('commercial.warehouses').whereNull('deleted_at').whereRaw("kepler_code ~ '^[0-9]{2}$'")
        .orderBy('kepler_code').select('kepler_code', 'name');
      const vistas = new Set<string>();
      return (rows as Array<{ kepler_code: string; name: string }>).filter((r) => (vistas.has(r.kepler_code) ? false : (vistas.add(r.kepler_code), true)))
        .map((r) => ({ code: r.kepler_code, name: r.name }));
    });
  }

  private tenant(): string {
    return this.tenantCtx.requireTenantId();
  }

  // ── Pantalla A ──────────────────────────────────────────────────────────────────────────────

  async contexto(quien: Quien, pedida?: string | null): Promise<LevantamientoContexto> {
    const { code: branch, source } = await this.sucursal(quien, pedida);
    const tenant = this.tenant();
    return this.tk.run(async (trx) => {
      const c = await this.conteos(trx, tenant, branch);
      const w = await trx('commercial.warehouses').where({ kepler_code: branch }).whereNull('deleted_at').first('name');
      // `identity.users` no tiene `full_name`: el nombre es `nombre` (42703 en prod, 2026-11-03).
      const u = await trx('identity.users').where({ id: quien.userId }).first('username', 'nombre');
      const semana = await this.semana(trx, tenant, branch, quien.userId);
      return {
        branch_code: branch,
        branch_name: w?.name ?? null,
        branch_source: source,
        user: { id: quien.userId, username: u?.username ?? quien.username, name: u?.nombre ?? null },
        missing: c.missing,
        universe: c.universe,
        week: semana,
        ai_enabled: iaEncendida(),
      };
    });
  }

  /**
   * La semana de la persona (lunes a domingo, hora de México). «Publicada» = la ficha que levantó quedó
   * `publicada`, fechada con `sheet.publicada.at` (la pone la decisión de Catálogo, NP.7.L.3b). «Levantó» =
   * quien TERMINÓ la captura (`sheet.capturo.by`), no quien creó la fila: una recaptura o una captura
   * retomada la puede terminar otra persona. Las fichas anteriores a ese dato caen en `created_by`.
   */
  private async semana(trx: Knex.Transaction, tenant: string, branch: string, userId: string): Promise<LevantamientoContexto['week']> {
    const { rows } = await trx.raw(
      `WITH lunes AS (SELECT date_trunc('week', now() AT TIME ZONE 'America/Mexico_City') AS d),
            mias AS (
              SELECT coalesce(sheet #>> '{capturo,by}', created_by::text) AS quien,
                     count(*) FILTER (WHERE status = 'publicada'
                       AND (coalesce((sheet #>> '{publicada,at}')::timestamptz, updated_at) AT TIME ZONE 'America/Mexico_City') >= (SELECT d FROM lunes))::int AS publicadas,
                     count(*) FILTER (WHERE status IN ('fotos_tomadas','analizada','por_revisar'))::int AS en_revision
                FROM catalog.product_sheets
               WHERE tenant_id = ? AND origin = 'levantamiento' AND branch_code = ? AND deleted_at IS NULL
               GROUP BY 1)
       SELECT coalesce((SELECT publicadas FROM mias WHERE quien = ?), 0) AS published,
              coalesce((SELECT en_revision FROM mias WHERE quien = ?), 0) AS in_review,
              CASE WHEN coalesce((SELECT publicadas FROM mias WHERE quien = ?), 0) = 0 THEN NULL
                   ELSE 1 + (SELECT count(*) FROM mias m
                              WHERE m.publicadas > (SELECT publicadas FROM mias WHERE quien = ?))::int END AS rank`,
      [tenant, branch, userId, userId, userId, userId],
    );
    const r = rows[0] ?? {};
    return { published: Number(r.published ?? 0), in_review: Number(r.in_review ?? 0), rank: r.rank == null ? null : Number(r.rank) };
  }

  async sugeridos(quien: Quien, pedida: string | null | undefined, limit = 30, offset = 0): Promise<LevantamientoSugeridosRespuesta> {
    const { code: branch } = await this.sucursal(quien, pedida);
    const tenant = this.tenant();
    const lim = Math.min(Math.max(Math.trunc(Number(limit) || 30), 1), 100);
    const off = Math.max(Math.trunc(Number(offset) || 0), 0);
    return this.tk.run(async (trx) => {
      await trx.raw('SET LOCAL enable_nestloop = off');
      const { rows } = await trx.raw(SUGERIDOS_LEVANTAMIENTO_SQL, { tenant, branch, no_fisico: NO_FISICO_REGEX, limit: lim, offset: off });
      const filas = rows as Array<{ sku: string; nombre: string; unidad_rotulo: string | null; unidad_factor: string | null; total: number }>;
      return {
        rows: filas.map((r) => ({ sku: r.sku, name: r.nombre, unit_label: r.unidad_rotulo, unit_factor: r.unidad_factor == null ? null : Number(r.unidad_factor) })),
        // Con la página vacía (offset fuera de rango) el total no viaja en ninguna fila: se pide aparte.
        total: filas.length ? Number(filas[0].total) : await this.totalSugeridos(trx, tenant, branch),
      };
    });
  }

  private async totalSugeridos(trx: Knex.Transaction, tenant: string, branch: string): Promise<number> {
    const { rows } = await trx.raw(SUGERIDOS_LEVANTAMIENTO_SQL, { tenant, branch, no_fisico: NO_FISICO_REGEX, limit: 1, offset: 0 });
    return rows.length ? Number(rows[0].total) : 0;
  }

  // ── Buscador de respaldo (A2) ───────────────────────────────────────────────────────────────

  /**
   * `[NP.7.L.10]` Cuando el código no pasa: la misma búsqueda de Cotización nueva (palabras en cualquier
   * orden, código exacto, lo más vendido sin teclear), con la sucursal resuelta aquí y SIN precio.
   * ⚠️ La fuente es `v_label_prices`: un producto sin precio publicado en esa sucursal no aparece.
   */
  async buscar(quien: Quien, q: string | null | undefined, pedida?: string | null, limit = 20): Promise<LevantamientoBusquedaFila[]> {
    const { code: branch } = await this.sucursal(quien, pedida);
    const term = String(q ?? '').trim().slice(0, 80);
    const n = Math.min(Math.max(Math.trunc(Number(limit) || 20), 1), 30);
    const tenant = this.tenant();
    return this.tk.run(async (trx) => {
      const inner = consultaBuscadorCatalogo(trx, branch, term, n);
      const { rows } = await trx.raw(
        `SELECT v.sku, v.name, v.content, v.barcode,
                EXISTS (SELECT 1 FROM catalog.product_sheets ps
                         WHERE ps.tenant_id = :tenant AND ps.sku = v.sku AND ps.deleted_at IS NULL AND ps.superseded_at IS NULL
                           AND ps.status IN ('publicada','conciliada','con_diferencias')) AS has_sheet
           FROM :inner v
          ORDER BY ${ORDEN_BUSCADOR_CATALOGO}`,
        { inner, term, pre: `${term}%`, tenant },
      );
      return (rows as Array<Record<string, unknown>>).map(filaBusqueda);
    });
  }

  // ── Escaneo (B0) ────────────────────────────────────────────────────────────────────────────

  async escanear(quien: Quien, dto: LevantamientoEscaneoDto, pedida?: string | null): Promise<LevantamientoEscaneoRespuesta> {
    const code = String(dto?.code ?? '').trim();
    const skuBuscado = String(dto?.sku ?? '').trim();
    if (!code && !skuBuscado) throw new BadRequestException('Falta el código escaneado.');
    if (code.length > 64 || skuBuscado.length > 32) throw new BadRequestException('Código demasiado largo.');
    const { code: branch, source } = await this.sucursal(quien, pedida);
    const tenant = this.tenant();
    const ahora = new Date();

    return this.tk.run(async (trx) => {
      const porBusqueda = !code && !!skuBuscado;
      const filas: KdiiFila[] = porBusqueda
        ? await kdiiPorSku(trx, branch, [skuBuscado], { tresCompleta: true })
        : await kdiiPorCodigo(trx, branch, code, { tresCompleta: true });
      const resultado: ResultadoEscaneo = porBusqueda
        ? (filas.length ? { tipo: 'ok', resuelto: { sku: filas[0].sku, nombre: filas[0].nombre, peldano: 'base', unidad: filas[0].u1, factor: 1 } } : { tipo: 'desconocido' })
        : resolverEscaneo(code, filas);

      const base = this.respuestaVacia(code || null);
      if (resultado.tipo === 'ambiguo') {
        const nombres = new Map(filas.map((f) => [f.sku, f.nombre]));
        return { ...base, action: 'codigo_compartido', message: MENSAJE.codigo_compartido, candidates: resultado.candidatos.map((s) => ({ sku: s, name: nombres.get(s) ?? null })) };
      }
      if (resultado.tipo === 'desconocido') return { ...base, action: 'no_registrado', message: MENSAJE.no_registrado };

      let resuelto = resultado.resuelto;
      const skuResuelto = resuelto.sku;
      const fila = filas.find((f) => f.sku === skuResuelto)!;
      const principal = peldanoPrincipal(fila, await this.rungModal(trx, branch, fila.sku));
      if (porBusqueda && principal) {
        // Por el buscador no hay código que diga el peldaño: se levanta la unidad principal.
        resuelto = { ...resuelto, ...this.unidadDe(fila, principal) };
      }
      const r = resuelto;

      // La ficha vigente del SKU, de cualquier origen (una alta conciliada también cuenta, §7.1).
      const fichas = (await trx('catalog.product_sheets')
        .where({ tenant_id: tenant, sku: r.sku }).whereNull('deleted_at').whereNull('superseded_at')
        .forUpdate()
        .select('id', 'origin', 'status', 'sku', 'branch_code', 'photos', 'sheet', 'created_by')) as FichaFila[];
      const conFicha = fichas.find((f) => ESTADOS_CON_FICHA.includes(f.status));
      const lev = fichas.find((f) => f.origin === 'levantamiento') ?? null;
      const estadoFicha = conFicha?.status ?? lev?.status ?? null;
      const apartado = lev && principal ? this.apartadoDe(lev, principal) : null;
      const vivos = await this.apartadosVivos(trx, tenant, quien.userId, lev?.id ?? null, ahora);

      const decision = decidirEscaneo({
        resultado: { tipo: 'ok', resuelto: r }, principal, estadoFicha, apartado, userId: quien.userId, ahora, vivosDelUsuario: vivos, porBusqueda,
      });

      const scanned = { rung: r.peldano as LevantamientoPeldano, label: r.unidad, factor: r.factor };
      const principalDto = principal ? { rung: principal, ...this.etiqueta(fila, principal) } : null;
      const comun = { ...base, sku: r.sku, name: r.nombre, scanned: porBusqueda ? null : scanned, principal: principalDto };

      if (decision.accion !== 'capturar') {
        const message = decision.accion === 'otra_unidad' && principalDto
          ? `Ese código es de ${nombreUnidad(r.unidad, r.factor)}. Por ahora sólo se fotografía ${nombreUnidad(principalDto.label, principalDto.factor)}: escanea el código de esa presentación.`
          : MENSAJE[decision.accion];
        return { ...comun, action: decision.accion, message };
      }

      if (decision.liberar) await this.soltarEn(trx, tenant, decision.liberar, quien.userId);
      const nuevo = nuevoApartado(quien.userId, ahora);
      // Retomar la captura que empezó OTRA sucursal: sus fotos no son de este anaquel ni de esta gente, así
      // que la captura empieza de cero (las anteriores se guardan aparte, como en la recaptura).
      const reiniciar = !!lev && (lev.status === 'recapturar' || (lev.status === 'en_captura' && lev.branch_code !== branch));
      const id = await this.apartar(trx, { tenant, branch, source, sku: r.sku, principal: principal!, lev, reiniciar, apartado: nuevo, quien, code: code || null, porBusqueda });
      if (!id) return { ...comun, action: 'apartado_por_otro', message: MENSAJE.apartado_por_otro };

      const fotos = lev && lev.status === 'en_captura' && !reiniciar ? (lev.photos ?? []) : [];
      return {
        ...comun, action: 'capturar', message: MENSAJE.capturar, sheet_id: id,
        faces: [...carasRequeridas()] as LevantamientoCara[], ...this.carasDe(fotos, principal!), reserved_until: nuevo.until,
      };
    });
  }

  private respuestaVacia(code: string | null): LevantamientoEscaneoRespuesta {
    return {
      action: 'no_registrado', message: '', code, sku: null, name: null, scanned: null, principal: null,
      sheet_id: null, faces: [], faces_done: [], faces_skipped: [], reserved_until: null, candidates: [],
    };
  }

  /**
   * Las caras resueltas del peldaño y, aparte, las saltadas: la pantalla nunca cuenta un salto como foto. Un
   * salto VIEJO del frente (anterior a `LEVANTAMIENTO_CARA_OBLIGATORIA`) no sale en ninguna de las dos: la
   * pantalla vuelve a pedir esa foto.
   */
  private carasDe(fotos: FotoFicha[], principal: LevantamientoPeldano): { faces_done: LevantamientoCara[]; faces_skipped: LevantamientoCara[] } {
    const del = fotos.filter((f) => f.peldano === principal && caraResuelta(f));
    return {
      faces_done: [...new Set(del.map((f) => f.cara as LevantamientoCara))],
      faces_skipped: [...new Set(del.filter((f) => !f.storage_key).map((f) => f.cara as LevantamientoCara))],
    };
  }

  private etiqueta(f: KdiiFila, p: LevantamientoPeldano): { label: string | null; factor: number | null } {
    if (p === 'base') return { label: f.u1, factor: 1 };
    const crudo = p === 'dos' ? f.f2 : f.f3;
    return { label: p === 'dos' ? f.u2 : f.u3, factor: crudo != null && Number(crudo) > 0 ? Number(crudo) : null };
  }

  private unidadDe(f: KdiiFila, p: LevantamientoPeldano): { peldano: LevantamientoPeldano; unidad: string | null; factor: number | null } {
    const e = this.etiqueta(f, p);
    return { peldano: p, unidad: e.label, factor: e.factor };
  }

  private apartadoDe(f: FichaFila, p: LevantamientoPeldano): Apartado | null {
    const peldanos = (f.sheet?.['peldanos'] ?? {}) as Record<string, { apartado?: Apartado | null } | undefined>;
    return peldanos[p]?.apartado ?? null;
  }

  /**
   * Apartados vivos de la persona en OTRAS fichas (para el tope de 3).
   * ⛔ Nada de `? IS NULL` sin tipo: Postgres no le puede inferir el tipo a un parámetro que sólo aparece
   * ahí y rechaza la consulta entera (42P18, GOTCHAS §5) — tumbaba TODO escaneo. La condición se arma aquí.
   */
  private async apartadosVivos(trx: Knex.Transaction, tenant: string, userId: string, excepto: string | null, ahora: Date): Promise<ApartadoDelUsuario[]> {
    const { rows } = await trx.raw(
      `SELECT id, (sheet #>> ARRAY['peldanos', sheet->>'principal', 'apartado', 'until']) AS until,
              jsonb_array_length(photos) > 0 AS con_fotos
         FROM catalog.product_sheets
        WHERE tenant_id = ? AND origin = 'levantamiento' AND status = 'en_captura' AND deleted_at IS NULL AND superseded_at IS NULL
          AND (sheet #>> ARRAY['peldanos', sheet->>'principal', 'apartado', 'by']) = ?
          ${excepto ? 'AND id <> ?::uuid' : ''}`,
      excepto ? [tenant, userId, excepto] : [tenant, userId],
    );
    return (rows as Array<{ id: string; until: string | null; con_fotos: boolean }>)
      .filter((r) => r.until && new Date(r.until).getTime() > ahora.getTime())
      .map((r) => ({ sheetId: r.id, until: String(r.until), conFotos: !!r.con_fotos }));
  }

  /**
   * Aparta el peldaño principal. Si la ficha existe, UPDATE CONDICIONAL: sólo si nadie más lo tiene
   * apartado y vivo (dos escaneos simultáneos → gana uno). Si no existe, INSERT; si otro la creó en el
   * mismo instante, el índice único lo rechaza y se responde «apartado por otro». Devuelve el id o null.
   */
  private async apartar(trx: Knex.Transaction, a: {
    tenant: string; branch: string; source: OrigenSucursal; sku: string; principal: LevantamientoPeldano; lev: FichaFila | null; reiniciar: boolean;
    apartado: Apartado; quien: Quien; code: string | null; porBusqueda: boolean;
  }): Promise<string | null> {
    const ruta = ['peldanos', a.principal];
    const peldano = { apartado: a.apartado, codigo_escaneado: a.code, por_busqueda: a.porBusqueda };
    if (a.lev) {
      // Reiniciar (recaptura, u otra sucursal): las fotos anteriores se guardan aparte y la captura empieza de cero.
      const { rows } = await trx.raw(
        `UPDATE catalog.product_sheets
            SET sheet = jsonb_set(
                          jsonb_set(CASE WHEN ? THEN sheet || jsonb_build_object('fotos_anteriores', coalesce(sheet->'fotos_anteriores','[]'::jsonb) || photos) ELSE sheet END
                                      || jsonb_build_object('sucursal_por', ?::text),
                                    '{principal}', to_jsonb(?::text), true),
                          ?::text[], coalesce(sheet #> ?::text[], '{}'::jsonb) || ?::jsonb, true),
                photos = CASE WHEN ? THEN '[]'::jsonb ELSE photos END,
                status = 'en_captura', branch_code = ?, updated_at = now(), updated_by = ?, updated_by_username = ?
          WHERE id = ? AND tenant_id = ? AND status IN ('en_captura','recapturar')
            AND (sheet #>> ARRAY['peldanos', ?, 'apartado', 'by'] IS NULL
                 OR sheet #>> ARRAY['peldanos', ?, 'apartado', 'by'] = ?
                 OR (sheet #>> ARRAY['peldanos', ?, 'apartado', 'until'])::timestamptz <= now())
        RETURNING id`,
        [a.reiniciar, a.source, a.principal, ruta, ruta, JSON.stringify(peldano), a.reiniciar, a.branch, a.quien.userId, a.quien.username,
          a.lev.id, a.tenant, a.principal, a.principal, a.quien.userId, a.principal],
      );
      return rows[0]?.id ?? null;
    }
    const sheet = { schema_version: 1, principal: a.principal, sucursal_por: a.source, peldanos: { [a.principal]: peldano } };
    await trx.raw('SAVEPOINT apartar');
    try {
      const [fila] = await trx('catalog.product_sheets')
        .insert({
          tenant_id: a.tenant, origin: 'levantamiento', status: 'en_captura', sku: a.sku, branch_code: a.branch,
          ean: a.code, photos: JSON.stringify([]), sheet: JSON.stringify(sheet),
          created_by: a.quien.userId, created_by_username: a.quien.username, updated_by: a.quien.userId, updated_by_username: a.quien.username,
        })
        .returning('id');
      await trx.raw('RELEASE SAVEPOINT apartar');
      return (fila as { id: string }).id;
    } catch (e) {
      await trx.raw('ROLLBACK TO SAVEPOINT apartar');
      if ((e as { code?: string }).code === '23505') return null;
      throw e;
    }
  }

  private async soltarEn(trx: Knex.Transaction, tenant: string, sheetId: string, userId: string): Promise<void> {
    await trx.raw(
      `UPDATE catalog.product_sheets
          SET sheet = sheet #- ARRAY['peldanos', sheet->>'principal', 'apartado'], updated_at = now(), updated_by = ?
        WHERE id = ? AND tenant_id = ? AND sheet #>> ARRAY['peldanos', sheet->>'principal', 'apartado', 'by'] = ?`,
      [userId, sheetId, tenant, userId],
    );
  }

  /**
   * «Salir sin terminar» o «No es éste»: suelta el apartado propio; las fotos ya subidas se quedan. La
   * ficha sigue `en_captura` pero sin apartado, y así vuelve a los sugeridos (`levantamiento.sql.ts`).
   */
  async soltar(quien: Quien, sheetId: string): Promise<{ ok: true }> {
    const tenant = this.tenant();
    await this.tk.run((trx) => this.soltarEn(trx, tenant, sheetId, quien.userId));
    return { ok: true };
  }

  // ── Fotos (B) ───────────────────────────────────────────────────────────────────────────────

  /**
   * Valida la ficha y el apartado ANTES de subir (sin huérfanos en el bucket), sube FUERA de la
   * transacción (una subida lenta no deja una conexión ociosa) y guarda en una transacción corta. Si el
   * guardado falla, borra la foto del bucket; si reemplazó otra (cara repetida), borra la anterior.
   *
   * Sólo JPEG, y SIN metadatos: las fotos salen de teléfonos personales y el EXIF trae el GPS (plan
   * NP.7.2.1). La pantalla siempre manda JPEG re-codificado por canvas; aquí se quita lo que quede.
   */
  async foto(quien: Quien, sheetId: string, archivo: ArchivoSubido | undefined, meta: {
    face?: string; sharpness?: string | number; contrast?: string | number; quality_version?: string; width?: string | number; height?: string | number;
  }): Promise<LevantamientoFotoRespuesta> {
    const cara = this.caraValida(meta.face);
    if (!archivo?.buffer?.length) throw new BadRequestException('Falta la foto.');
    if (archivo.size > MAX_FOTO_BYTES) throw new BadRequestException('La foto pesa más de 15 MB.');
    if (detectarTipo(new Uint8Array(archivo.buffer)) !== 'image/jpeg') throw new BadRequestException('El archivo no es una foto JPEG.');
    const limpia = quitarMetadatosJpeg(new Uint8Array(archivo.buffer));
    if (!limpia) throw new BadRequestException('La foto llegó dañada. Tómala otra vez.');
    const buffer = Buffer.from(limpia);
    const tenant = this.tenant();

    const ficha = await this.tk.run((trx) => this.fichaParaFoto(trx, tenant, sheetId, quien.userId));
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    const { key } = await this.storage.putBuffer(buffer, 'image/jpeg', `levantamiento/${ficha.branch_code}/${ficha.sku}`, 'foto.jpg');

    const n = (v: unknown): number | null => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
    const calidad: LevantamientoCalidadFoto | null = n(meta.sharpness) == null || n(meta.contrast) == null
      ? null : { sharpness: n(meta.sharpness)!, contrast: n(meta.contrast)!, version: String(meta.quality_version ?? '').slice(0, 20) };
    const foto: FotoFicha = {
      peldano: ficha.principal, cara, storage_key: key, sha256, captured_by: quien.userId, captured_at: new Date().toISOString(),
      saltada_motivo: null,
      calidad: calidad ? { nitidez: calidad.sharpness, contraste: calidad.contrast, version: calidad.version } : null,
      ancho: n(meta.width), alto: n(meta.height), por_busqueda: ficha.porBusqueda,
    };
    let g: { respuesta: LevantamientoFotoRespuesta; reemplazada: string | null };
    try {
      g = await this.tk.run((trx) => this.guardarCara(trx, tenant, sheetId, quien, foto));
    } catch (e) {
      await this.borrar(key);
      throw e;
    }
    if (g.reemplazada) await this.borrar(g.reemplazada);
    return g.respuesta;
  }

  async saltar(quien: Quien, sheetId: string, dto: LevantamientoSaltoDto): Promise<LevantamientoFotoRespuesta> {
    const cara = this.caraValida(dto?.face);
    if (cara === LEVANTAMIENTO_CARA_OBLIGATORIA) throw new BadRequestException(FRENTE_OBLIGATORIO);
    const motivo = String(dto?.reason ?? '') as LevantamientoMotivoSalto;
    if (!(LEVANTAMIENTO_MOTIVOS_SALTO as readonly string[]).includes(motivo)) throw new BadRequestException('Elige por qué no se puede tomar esa cara.');
    const tenant = this.tenant();
    const g = await this.tk.run(async (trx) => {
      const ficha = await this.fichaParaFoto(trx, tenant, sheetId, quien.userId);
      return this.guardarCara(trx, tenant, sheetId, quien, {
        peldano: ficha.principal, cara, storage_key: null, sha256: null, captured_by: quien.userId, captured_at: new Date().toISOString(),
        saltada_motivo: motivo, calidad: null, ancho: null, alto: null, por_busqueda: ficha.porBusqueda,
      });
    });
    if (g.reemplazada) await this.borrar(g.reemplazada);
    return g.respuesta;
  }

  /** Borrar del bucket nunca tumba la respuesta: lo que falla se avisa en el log con su llave. */
  private async borrar(key: string): Promise<void> {
    await this.storage.remove(key).catch((err: unknown) => this.logger.warn(`[NP.7] no se pudo borrar la foto huérfana ${key}: ${String(err)}`));
  }

  private caraValida(face: unknown): LevantamientoCara {
    const c = String(face ?? '') as LevantamientoCara;
    if (!(LEVANTAMIENTO_CARAS as readonly string[]).includes(c)) throw new BadRequestException('Cara de foto inválida.');
    return c;
  }

  /**
   * Sólo sube quien tiene el apartado (vivo o vencido sin que nadie lo tomara). Sin apartado —se soltó, o
   * lo liberó el tope de 3— hay que volver a escanear: el escaneo es el que valida la sucursal (D25) y
   * aparta de forma condicional.
   */
  private revisarApartado(f: Pick<FichaFila, 'sheet'>, principal: LevantamientoPeldano, userId: string): void {
    const a = this.apartadoDe(f as FichaFila, principal);
    if (a && a.by !== userId && apartadoVivo(a, new Date())) throw new ForbiddenException('Alguien más está levantando este producto.');
    if (!a || a.by !== userId) throw new ConflictException('Este producto ya no está apartado a tu nombre. Escanéalo otra vez para seguir.');
  }

  private async fichaParaFoto(trx: Knex.Transaction, tenant: string, sheetId: string, userId: string): Promise<{
    branch_code: string; sku: string; principal: LevantamientoPeldano; porBusqueda: boolean;
  }> {
    const f = (await trx('catalog.product_sheets').where({ id: sheetId, tenant_id: tenant, origin: 'levantamiento' }).whereNull('deleted_at')
      .first('id', 'status', 'sku', 'branch_code', 'sheet')) as Pick<FichaFila, 'id' | 'status' | 'sku' | 'branch_code' | 'sheet'> | undefined;
    if (!f) throw new NotFoundException('No encontramos esa captura.');
    if (f.status !== 'en_captura') throw new ConflictException('Esta captura ya se envió.');
    const principal = (f.sheet?.['principal'] as LevantamientoPeldano | undefined) ?? null;
    if (!principal) throw new ConflictException('La captura no tiene unidad principal.');
    this.revisarApartado(f, principal, userId);
    const peldano = ((f.sheet?.['peldanos'] ?? {}) as Record<string, { por_busqueda?: boolean }>)[principal] ?? {};
    return { branch_code: String(f.branch_code), sku: String(f.sku), principal, porBusqueda: !!peldano.por_busqueda };
  }

  /**
   * Reemplaza la cara (si se repitió) y recalcula el estado. Condicional: sigue en captura y el apartado es
   * de quien sube. Devuelve la llave de la foto reemplazada para borrarla DESPUÉS de confirmar.
   * Al completarse queda `sheet.capturo`: el crédito (la semana, la bandeja) es de quien TERMINÓ la captura,
   * no de quien creó la fila — una recaptura o una captura retomada la puede terminar otra persona.
   */
  private async guardarCara(trx: Knex.Transaction, tenant: string, sheetId: string, quien: Quien, foto: FotoFicha): Promise<{
    respuesta: LevantamientoFotoRespuesta; reemplazada: string | null;
  }> {
    const f = (await trx('catalog.product_sheets').where({ id: sheetId, tenant_id: tenant }).forUpdate().first('status', 'photos', 'sheet')) as Pick<FichaFila, 'status' | 'photos' | 'sheet'> | undefined;
    if (!f || f.status !== 'en_captura') throw new ConflictException('Esta captura ya se envió.');
    const principal = foto.peldano!;
    this.revisarApartado(f, principal, quien.userId);
    const anterior = (f.photos ?? []).find((x) => x.peldano === principal && x.cara === foto.cara) ?? null;
    const fotos = [...(f.photos ?? []).filter((x) => x !== anterior), foto];
    const estado = estadoTrasFoto(fotos, principal);
    const completa = estado !== 'en_captura';
    // Cada foto renueva el apartado: quien está tomando fotos no pierde el producto a la mitad.
    const renovado = nuevoApartado(quien.userId, new Date());
    const capturo = completa ? { by: quien.userId, username: quien.username, at: new Date().toISOString() } : null;
    await trx.raw(
      `UPDATE catalog.product_sheets
          SET photos = ?::jsonb, status = ?,
              sheet = jsonb_set(CASE WHEN ? THEN jsonb_set(sheet, '{capturo}', ?::jsonb, true) ELSE sheet END,
                                ARRAY['peldanos', ?, 'apartado'], ?::jsonb, true),
              updated_at = now(), updated_by = ?, updated_by_username = ?
        WHERE id = ? AND tenant_id = ?`,
      [JSON.stringify(fotos), estado, completa, JSON.stringify(capturo), principal, JSON.stringify(completa ? null : renovado),
        quien.userId, quien.username, sheetId, tenant],
    );
    return {
      respuesta: { sheet_id: sheetId, face: foto.cara as LevantamientoCara, status: estado, ...this.carasDe(fotos, principal), complete: completa },
      reemplazada: anterior?.storage_key && anterior.storage_key !== foto.storage_key ? anterior.storage_key : null,
    };
  }

  /** Para la bandeja «por revisar» (NP.7.L.3b) y la prueba: ¿la ficha ya espera revisión? */
  static enRevision(status: string): boolean {
    return ESTADOS_EN_REVISION.includes(status);
  }
}
