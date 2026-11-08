import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Knex } from 'knex';
import type {
  CoberturaLevantamiento, FichaPublicada, FichasPublicadas, LevantamientoPeldano, RevisionBandeja, RevisionDecisionDto,
  RevisionDecisionRespuesta, RevisionFicha, RevisionMotivo, LevantamientoDetalleTipo,
} from '@megadulces/contracts';
import { ObjectStorageService, TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import { kdiiPorSku } from '../shared/kdii-lectura';
import type { KdiiFila, Peldano } from '../shared/kdii-codigo';
import { leerConfigLector } from './ia/lector.config';
import type { LecturaGuardada } from './ia/lectura-foto.contract';
import { fichaLista } from './ia/lector-worker.service';
import { decidirRevision, ESTADOS_CON_FICHA, ESTADOS_EN_REVISION, motivosDeRevision, ordenDeFoto, sinFotoReal, type FotoFicha } from './levantamiento.rules';
import { COBERTURA_LEVANTAMIENTO_SQL, NO_FISICO_REGEX } from './levantamiento.sql';
import type { Quien } from './levantamiento.service';

const MOTIVOS: RevisionMotivo[] = ['sin_analizar', 'caras_saltadas', 'entro_por_busqueda', 'foto_repetida'];
/** Las URL firmadas viven 15 min: alcanzan para revisar una página, no para publicar con ellas. */
const TTL_FOTO = 900;
/** `[NP.7.L.5]` Sin sucursal pedida, la cobertura es la del piloto (Padre Hidalgo, §10). */
const SUCURSAL_PILOTO = '01';

/** Una ficha del levantamiento como sale de `catalog.product_sheets`: lo que comparten la bandeja y Publicadas. */
export interface FilaFicha {
  id: string;
  sku: string;
  branch_code: string;
  photos: FotoFicha[];
  sheet: {
    principal?: LevantamientoPeldano;
    peldanos?: Record<string, { codigo_escaneado?: string | null }>;
    /** Quien TERMINÓ la captura (NP.7.L.2): el crédito y el «capturó» de la bandeja. */
    capturo?: { by?: string; username?: string | null; at?: string };
    /** Lo escribe `decidir` al publicar (quién, cuándo). */
    publicada?: { by?: string; at?: string };
    /** Historial de decisiones de Catálogo, en el orden en que se tomaron (`decidir` agrega al final). */
    revisiones?: Array<{ decision?: string; by?: string; by_username?: string | null; at?: string }>;
  };
  created_by_username: string | null;
  created_at: string | Date;
}

interface FilaRevision extends FilaFicha {
  status: string;
}

/** Lo que hace falta de una ficha para saber si su propuesta de la IA sigue vigente. */
interface ConPropuesta {
  /** `ai_raw.propuesta` existe y no es `null` (calculado en SQL: no se trae `ai_raw` entero). */
  con_propuesta: boolean;
  /** `ai_raw.lecturas`, SÓLO si hay propuesta (es lo único para lo que se lee); si no, `null`. */
  lecturas: Record<string, LecturaGuardada> | null;
}

interface FilaPublicada extends FilaFicha, ConPropuesta {}

/** Lo que la bandeja y Publicadas dicen igual de una ficha (la parte común de sus dos contratos). */
export type FichaComun = Omit<FichaPublicada, 'published_by' | 'published_at' | 'ai_reading'>;

/** Motivos de una ficha: los de las fotos (§10b.3 punto 4) y, si nadie la leyó todavía, «sin analizar». */
export function motivosDeFicha(f: Pick<FilaRevision, 'status' | 'photos' | 'sheet'>): RevisionMotivo[] {
  const p = f.sheet?.principal ?? null;
  const deFotos = p ? (motivosDeRevision(f.photos ?? [], p) as RevisionMotivo[]) : [];
  return [...(f.status === 'fotos_tomadas' ? (['sin_analizar'] as RevisionMotivo[]) : []), ...deFotos];
}

/**
 * Tope del offset. En Publicadas el offset va al SQL y knex lo pasa con `parseInt(String(v))`: `1e20` llegaba
 * entero y desbordaba el bigint de Postgres (500, no 400) y `1e21` se escribe «1e+21» y se volvía 1 (otra página,
 * en silencio). Un millón está muy por arriba de cualquier lista real: pasado el tope, la página sale vacía.
 */
const OFFSET_MAX = 1_000_000;

/** Página pedida → límites seguros: 1..100 (30 si no viene o no es número) y 0..1,000,000. Igual en la bandeja y en Publicadas. */
export function paginaDe(limit: unknown, offset: unknown): { lim: number; off: number } {
  return {
    lim: Math.min(Math.max(Math.trunc(Number(limit) || 30), 1), 100),
    off: Math.min(Math.max(Math.trunc(Number(offset) || 0), 0), OFFSET_MAX),
  };
}

/**
 * `[NP.7.L.5]` La sucursal de la cobertura: la del piloto si no viene; si viene, dos dígitos (la clave de
 * Kepler). Cualquier otra cosa es 400: una sucursal mal escrita contaría «universo 0» y se leería como
 * «no hay nada que levantar».
 */
export function sucursalDeCobertura(raw: unknown): string {
  const b = String(raw ?? '').trim();
  if (!b) return SUCURSAL_PILOTO;
  if (!/^\d{2}$/.test(b)) throw new BadRequestException('La sucursal va con su clave de dos dígitos (por ejemplo, 01).');
  return b;
}

/**
 * Escapa los comodines de LIKE (`\`, `%`, `_`) para que la búsqueda encuentre el texto TAL CUAL: sin esto,
 * «MEN_A» encuentra «MENTA». Va con `ESCAPE '\'` en el SQL.
 */
export function escaparLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Quién la publicó: el `by_username` de la ÚLTIMA decisión «publicar» de `sheet.revisiones` (`decidir` las
 * agrega al final). Si esa entrada no trae usuario, `null`: no se le acredita a quien publicó antes.
 */
export function publicadaPor(revisiones: FilaFicha['sheet']['revisiones'] | unknown): string | null {
  if (!Array.isArray(revisiones)) return null;
  for (let i = revisiones.length - 1; i >= 0; i -= 1) {
    const r = revisiones[i] as { decision?: unknown; by_username?: unknown } | null;
    if (r && r.decision === 'publicar') return typeof r.by_username === 'string' && r.by_username.trim() ? r.by_username : null;
  }
  return null;
}

/**
 * Cuándo se publicó, sólo si quedó registrado (`sheet.publicada.at`). Una ficha anterior al registro
 * devuelve `null`: `updated_at` sirve para ORDENAR, no para afirmar una fecha de publicación (regla 11).
 */
export function publicadaEn(sheet: FilaFicha['sheet'] | null | undefined): string | null {
  const at = sheet?.publicada?.at;
  if (!at) return null;
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** La lectura de la IA: apagada (D6) manda sobre todo; encendida, «leída» sólo si la propuesta está vigente. */
export function lecturaIa(habilitada: boolean, propuestaVigenteHoy: boolean): FichaPublicada['ai_reading'] {
  if (!habilitada) return 'apagada';
  return propuestaVigenteHoy ? 'leida' : 'sin_leer';
}

/**
 * ¿La propuesta guardada es de las fotos que la ficha tiene HOY? Al recapturar, `apartar` vacía `photos` y NO toca
 * `ai_raw`: la propuesta hecha con las fotos viejas se queda hasta que el worker lea una foto nueva (ahí la pone
 * en null). Sin esto, una ficha recapturada y publicada antes de esa lectura diría «la IA ya leyó esta ficha» de
 * fotos que la IA no leyó. La regla es la del worker (`fichaLista`, regla 16): todas las fotos reales de la unidad
 * principal con lectura `ok`.
 */
export function propuestaVigente(x: Pick<FilaFicha, 'photos' | 'sheet'> & ConPropuesta): boolean {
  return x.con_propuesta === true && fichaLista(x.photos ?? [], x.sheet?.principal ?? '', x.lecturas);
}

/**
 * La armada de una ficha que comparten la bandeja y Publicadas (regla 16: un solo lugar): el dato de
 * Kepler de SU sucursal (nombre, rótulo y factor del peldaño, códigos), el nombre de la sucursal y las
 * fotos de la unidad principal con URL firmada. `firmar` recibe la llave del bucket.
 * ⛔ Nada de costo, precio, margen ni venta: lo que no está aquí no sale.
 */
export async function armarFichaComun(
  x: FilaFicha, kdii: Map<string, KdiiFila>, sucursales: Map<string, string>, firmar: (key: string) => Promise<string>,
): Promise<FichaComun> {
  const k = kdii.get(`${x.branch_code}|${x.sku}`) ?? null;
  const p = x.sheet?.principal ?? null;
  const etiqueta = !k || !p ? { label: null, factor: null, codes: [] as Array<string | null> } : p === 'base'
    ? { label: k.u1, factor: 1, codes: k.base }
    : p === 'dos' ? { label: k.u2, factor: k.f2, codes: k.dos } : { label: k.u3, factor: k.f3, codes: k.tres };
  // En el orden en que se piden (caras, acercamientos, detalles), no en el que se subieron: repetir una cara la mandaba al final.
  const fotos = (x.photos ?? []).filter((ph) => ph.peldano === p).sort((a, b) => ordenDeFoto(a.cara) - ordenDeFoto(b.cara));
  return {
    id: x.id, sku: x.sku, name: k?.nombre ?? null,
    branch_code: x.branch_code, branch_name: sucursales.get(x.branch_code) ?? null,
    rung: p, unit_label: etiqueta.label, unit_factor: etiqueta.factor == null ? null : Number(etiqueta.factor),
    scanned_code: (p && x.sheet?.peldanos?.[p]?.codigo_escaneado) || null,
    kepler_codes: (etiqueta.codes ?? []).filter((c): c is string => !!c && !!String(c).trim()),
    captured_by: x.sheet?.capturo?.username ?? x.created_by_username, captured_at: new Date(x.sheet?.capturo?.at ?? x.created_at).toISOString(),
    photos: await Promise.all(fotos.map(async (ph) => ({
      face: ph.cara,
      url: ph.storage_key ? await firmar(ph.storage_key) : null,
      skipped_reason: ph.saltada_motivo ?? null,
      sharpness: ph.calidad?.nitidez ?? null,
      detail: ph.detalle ? { kind: ph.detalle.tipo as LevantamientoDetalleTipo, note: ph.detalle.nota ?? null } : null,
    }))),
  };
}

/** Nombre de cada sucursal por su clave de Kepler (`commercial.warehouses`): nunca «07» suelto en pantalla. */
async function nombresDeSucursal(trx: Knex.Transaction, codigos: string[]): Promise<Map<string, string>> {
  if (!codigos.length) return new Map();
  const w = (await trx('commercial.warehouses').whereNull('deleted_at').whereIn('kepler_code', codigos)
    .select('kepler_code', 'name')) as Array<{ kepler_code: string; name: string }>;
  return new Map(w.map((x) => [x.kepler_code, x.name]));
}

/** El dato de Kepler de cada ficha, leído en SU sucursal (una consulta por sucursal), y los nombres de sucursal. */
async function keplerDeFichas(
  trx: Knex.Transaction, filas: Array<Pick<FilaFicha, 'branch_code' | 'sku'>>,
): Promise<{ kdii: Map<string, KdiiFila>; sucursales: Map<string, string> }> {
  const porSucursal = new Map<string, string[]>();
  for (const x of filas) porSucursal.set(x.branch_code, [...(porSucursal.get(x.branch_code) ?? []), x.sku]);
  const kdii = new Map<string, KdiiFila>();
  for (const [suc, skus] of porSucursal) {
    for (const k of await kdiiPorSku(trx, suc, [...new Set(skus)], { tresCompleta: true })) kdii.set(`${suc}|${k.sku}`, k);
  }
  return { kdii, sucursales: await nombresDeSucursal(trx, [...porSucursal.keys()]) };
}

/**
 * `[NP.7.L.3b]` La bandeja «por revisar» de Catálogo: lo levantado que espera a una persona. En el piloto
 * es TODO (la IA está apagada, D6). Una decisión por ficha: publicar, pedir otra foto o descartar.
 * ⚠️ No filtra por sucursal: Catálogo revisa la red entera. ⚠️ «Confirmar hallazgo» (NP.7.L.3c) todavía no.
 */
@Injectable()
export class RevisionService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly storage: ObjectStorageService,
  ) {}

  async bandeja(f: { branch?: string | null; reason?: string | null; limit?: number; offset?: number }): Promise<RevisionBandeja> {
    const { lim, off } = paginaDe(f.limit, f.offset);
    const motivo = MOTIVOS.includes(f.reason as RevisionMotivo) ? (f.reason as RevisionMotivo) : null;
    const branch = String(f.branch ?? '').trim() || null;
    const tenant = this.tenantCtx.requireTenantId();

    const { todas, kdii, sucursales } = await this.tk.run(async (trx) => {
      const q = trx('catalog.product_sheets')
        .where({ tenant_id: tenant, origin: 'levantamiento' }).whereIn('status', [...ESTADOS_EN_REVISION])
        .whereNull('deleted_at').whereNull('superseded_at')
        // Por llegada a revisión (cuando se TERMINÓ la captura), no por cuándo se creó la fila: una recaptura
        // no se cuela al frente de la cola.
        .orderByRaw("coalesce((sheet #>> '{capturo,at}')::timestamptz, created_at) ASC, id ASC")
        .select('id', 'sku', 'branch_code', 'status', 'photos', 'sheet', 'created_by_username', 'created_at');
      if (branch) q.where({ branch_code: branch });
      const filas = (await q) as FilaRevision[];
      return { todas: filas, ...(await keplerDeFichas(trx, filas)) };
    });

    // El conteo es de TODA la bandeja, no de la página: si no, el número de arriba no se puede recorrer.
    const conMotivos = todas.map((x) => ({ x, m: motivosDeFicha(x) }));
    const counts = Object.fromEntries(MOTIVOS.map((m) => [m, conMotivos.filter((c) => c.m.includes(m)).length])) as Record<RevisionMotivo, number>;
    const filtradas = motivo ? conMotivos.filter((c) => c.m.includes(motivo)) : conMotivos;
    const pagina = filtradas.slice(off, off + lim);

    const rows: RevisionFicha[] = [];
    for (const { x, m } of pagina) {
      rows.push({ ...(await armarFichaComun(x, kdii, sucursales, this.firmar)), status: x.status, reasons: m });
    }
    return { counts, total: filtradas.length, total_all: todas.length, rows };
  }

  /**
   * `[NP.7.L.5]` Catálogo digital › Publicadas (primer corte de la pestaña Cobertura, maqueta E de §10b.4):
   * hasta hoy una ficha publicada no se veía en ninguna pantalla (hallazgo (b) del 2026-11-04).
   *
   * - La lista es de TODA la red (Catálogo publica para todas las sucursales), sólo del levantamiento,
   *   vigente (sin descartar ni reemplazar) y con la unidad principal publicada. Lo más reciente primero:
   *   por `sheet.publicada.at`; una ficha anterior a ese registro ordena por `updated_at` (y su
   *   `published_at` sale `null`, no se inventa). Desempate por id: dos lecturas dan la misma página.
   * - `q`: SKU exacto o el nombre de Kepler de la sucursal de la ficha que CONTENGA el texto, sin acentos
   *   ni mayúsculas (`f_unaccent(lower(…))`, como el buscador), con los comodines de LIKE escapados.
   *   `total` cuenta lo que cumple `q`, no la página.
   * - La cobertura es de UNA sucursal (`branch`, la del piloto si no viene), en vivo.
   * ⛔ Sin costo, precio, margen ni venta por SKU: sólo el % agregado de la cobertura.
   * ⚠️ Usa `CATALOGO_FICHAS_REVISAR` (la clave de la bandeja): la propia de Cobertura
   * (`CATALOGO_LEVANTAR_COBERTURA_VER`, NP.7.L.5) queda como deuda con nombre.
   */
  async publicadas(f: { branch?: string | null; q?: string | null; limit?: unknown; offset?: unknown }): Promise<FichasPublicadas> {
    const branch = sucursalDeCobertura(f.branch);
    const { lim, off } = paginaDe(f.limit, f.offset);
    const term = String(f.q ?? '').trim().slice(0, 80);
    const tenant = this.tenantCtx.requireTenantId();

    const { total, filas, kdii, sucursales } = await this.tk.run(async (trx) => {
      const base = trx('catalog.product_sheets as ps')
        .where({ 'ps.tenant_id': tenant, 'ps.origin': 'levantamiento' }).whereIn('ps.status', [...ESTADOS_CON_FICHA])
        .whereNull('ps.deleted_at').whereNull('ps.superseded_at');
      if (term) {
        // El nombre se busca en la ficha de Kepler de la sucursal de CADA ficha. Subconsulta SIN correlación
        // (un `IN` de pares) para que Postgres pueda resolverla una sola vez (subplan con hash) y no una vez
        // por ficha, como haría un `EXISTS` correlacionado dentro de un `OR`. ⚠️ Plan y tiempo NO MEDIDOS en prod.
        base.where((w) => {
          w.whereRaw('upper(ps.sku) = upper(?)', [term]).orWhereRaw(
            `(ps.branch_code, ps.sku) IN (
               SELECT btrim(k.sucursal), btrim(k.c1)
                 FROM kepler_ods.kdii k
                WHERE public.f_unaccent(lower(k.c2)) LIKE public.f_unaccent(lower(?)) ESCAPE '\\')`,
            [`%${escaparLike(term)}%`],
          );
        });
      }
      const [{ n }] = (await base.clone().count({ n: '*' })) as Array<{ n: string | number }>;
      const pagina = (await base.clone()
        .orderByRaw("coalesce((ps.sheet #>> '{publicada,at}')::timestamptz, ps.updated_at) DESC, ps.id ASC")
        .limit(lim).offset(off)
        .select('ps.id', 'ps.sku', 'ps.branch_code', 'ps.photos', 'ps.sheet', 'ps.created_by_username', 'ps.created_at',
          trx.raw(`coalesce(jsonb_typeof(ps.ai_raw -> 'propuesta'), 'null') <> 'null' AS con_propuesta`),
          // Las lecturas sólo hacen falta si hay propuesta (para saber si sigue vigente): sin ella no se traen.
          trx.raw(`CASE WHEN coalesce(jsonb_typeof(ps.ai_raw -> 'propuesta'), 'null') <> 'null' THEN ps.ai_raw -> 'lecturas' END AS lecturas`))) as FilaPublicada[];
      return { total: Number(n), filas: pagina, ...(await keplerDeFichas(trx, pagina)) };
    });

    const ia = leerConfigLector().habilitada;
    const rows: FichaPublicada[] = [];
    for (const x of filas) {
      rows.push({
        ...(await armarFichaComun(x, kdii, sucursales, this.firmar)),
        published_by: publicadaPor(x.sheet?.revisiones),
        published_at: publicadaEn(x.sheet),
        ai_reading: lecturaIa(ia, propuestaVigente(x)),
      });
    }
    return { coverage: await this.cobertura(tenant, branch), total, rows };
  }

  /**
   * `[NP.7.L.5]` La cobertura de UNA sucursal, en vivo (`COBERTURA_LEVANTAMIENTO_SQL`: el mismo universo que
   * la pantalla A). Aparte y `protected` porque lee vistas materializadas del ODS que no admiten filas
   * sembradas: la prueba de integración la fija en las pruebas de la lista y la ejerce de verdad aparte.
   */
  protected async cobertura(tenant: string, branch: string): Promise<CoberturaLevantamiento> {
    return this.tk.run(async (trx) => {
      const nombre = (await nombresDeSucursal(trx, [branch])).get(branch) ?? null;
      // El planificador estima 1 fila en la ficha de Kepler y elige ciclos anidados (34 s → ~0.5 s sin
      // ellos, medido 2026-11-02 en los conteos). Sólo dentro de esta transacción.
      await trx.raw('SET LOCAL enable_nestloop = off');
      const c = (await trx.raw(COBERTURA_LEVANTAMIENTO_SQL, { tenant, branch, no_fisico: NO_FISICO_REGEX })).rows[0] as {
        universe: number; published: number; missing: number; sales_share_pct: string | number | null;
      };
      return {
        branch_code: branch, branch_name: nombre,
        universe: Number(c.universe), published: Number(c.published), missing: Number(c.missing),
        sales_share_pct: c.sales_share_pct == null ? null : Number(c.sales_share_pct),
        measured_at: new Date().toISOString(),
      };
    });
  }

  /** Las URL firmadas de las fotos (15 min). Flecha: se pasa suelta a `armarFichaComun`. */
  private readonly firmar = (key: string): Promise<string> => this.storage.signedUrl(key, TTL_FOTO);

  /**
   * Una decisión, con candado de fila: dos revisores no deciden la misma ficha dos veces (el segundo ve
   * «ya no está en revisión»). Cada decisión queda en `sheet.revisiones` (quién, cuándo, nota).
   * ⛔ Nadie PUBLICA lo que capturó: `compras` y `gerente_compras` también levantan (L.7b), y su
   * publicación sumaría en su propia semana. Otra persona de Catálogo la revisa.
   */
  async decidir(quien: Quien, id: string, dto: RevisionDecisionDto): Promise<RevisionDecisionRespuesta> {
    const nota = String(dto?.note ?? '').trim().slice(0, 500);
    const tenant = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx: Knex.Transaction) => {
      const f = await trx('catalog.product_sheets').where({ id, tenant_id: tenant, origin: 'levantamiento' }).whereNull('deleted_at')
        .forUpdate().first('status', 'created_by', 'photos', trx.raw(`sheet #>> '{capturo,by}' AS capturo`), trx.raw(`sheet ->> 'principal' AS principal`));
      if (!f) throw new NotFoundException('No encontramos esa ficha.');
      const r = decidirRevision(f.status, String(dto?.decision ?? ''), nota);
      if (!r.ok) throw (ESTADOS_EN_REVISION.includes(f.status) ? new BadRequestException(r.motivo) : new ConflictException(r.motivo));
      // Una ficha sin ninguna foto (anterior a que el frente fuera obligatorio) no se publica: se descarta o se pide otra.
      if (dto.decision === 'publicar' && sinFotoReal((f.photos ?? []) as FotoFicha[], (f.principal ?? 'base') as Peldano)) {
        throw new ConflictException('Esta ficha no tiene ninguna foto: descártala o pide otra foto.');
      }
      const suya = String(f.capturo ?? f.created_by ?? '') === quien.userId
        || ((f.photos ?? []) as Array<{ captured_by?: string | null }>).some((p) => p.captured_by === quien.userId);
      if (dto.decision === 'publicar' && suya) {
        throw new ForbiddenException('No puedes publicar lo que tú levantaste: que lo revise otra persona de Catálogo.');
      }
      const ahora = new Date().toISOString();
      const registro = { decision: dto.decision, by: quien.userId, by_username: quien.username, at: ahora, note: nota || null };
      await trx.raw(
        `UPDATE catalog.product_sheets
            SET status = coalesce(?, status),
                sheet = jsonb_set(
                          CASE WHEN ? = 'publicar' THEN jsonb_set(sheet, '{publicada}', ?::jsonb, true) ELSE sheet END,
                          '{revisiones}', coalesce(sheet->'revisiones', '[]'::jsonb) || ?::jsonb, true),
                deleted_at = CASE WHEN ? THEN now() ELSE deleted_at END,
                deleted_by = CASE WHEN ? THEN ?::uuid ELSE deleted_by END,
                updated_at = now(), updated_by = ?, updated_by_username = ?
          WHERE id = ? AND tenant_id = ?`,
        [r.status, dto.decision, JSON.stringify({ by: quien.userId, at: ahora }), JSON.stringify([registro]),
          r.borrar, r.borrar, quien.userId, quien.userId, quien.username, id, tenant],
      );
      return { id, status: r.borrar ? 'descartada' : String(r.status) };
    });
  }
}
