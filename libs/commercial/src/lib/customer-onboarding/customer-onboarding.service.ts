import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Knex } from 'knex';
import {
  ObjectStorageService,
  ScopeService,
  TenantContextService,
  TenantKnexService,
  branchKeyFilterSql,
  branchKeySql,
  claveDeRegimen,
  leerConstanciaPdf,
  normalizarClaveFiscal,
  validarRfc,
} from '@megadulces/platform-core';
import {
  CASILLAS_KEPLER,
  type BandejaAlta,
  type CatalogosAlta,
  type CodigoPostalAlta,
  type CoincidenciaKepler,
  type CrearSolicitudRespuesta,
  type DecidirCreditoBody,
  type EstadoSolicitudAlta,
  type FichaKeplerCliente,
  type HallazgoAlta,
  type LigarSolicitudBody,
  type OpcionCatalogo,
  type PlanAltaKepler,
  type PosibleDuplicado,
  type RegimenFiscalOpcion,
  type ResultadoServidorAlta,
  type RevisionAlta,
  type ServidorEscrituraKepler,
  type SolicitudAlta,
  type SolicitudAltaBody,
  type SubirConstanciaBody,
  type SubirConstanciaRespuesta,
  type UbicacionAlta,
  type UsoCfdiOpcion,
} from '@megadulces/contracts';
import {
  bloquea, diferenciaDeCredito, estadoInicial, pideCredito, revisarSolicitud, type ContextoRevision, type FichaKeplerLeida,
} from './alta-clientes.rules';
import { estadoCorto, fichaDesdeConstancia, fichaVacia, recortesDe } from './ficha-kepler';
import {
  PISO_DE_SUCURSAL, ZONA_DE_SUCURSAL, armarClienteKepler, columnasDelPlan, formaPagoPorDefecto, planConClave,
  siguienteClave, telefonoKepler, textoKepler, usoCfdiPorDefecto, type ArmadoClienteKepler,
} from './kepler-cliente.armador';
import { KeplerClienteSinkAdapter } from './kepler-cliente-sink.adapter';
import { NewCustomersKeplerService } from '../new-customers-kepler/new-customers-kepler.service';
import { codigoKepler, normalizarClave, normalizarNombre, parecido, UMBRAL_PARECIDO } from '../new-customers-kepler/new-customers-kepler.engine';

/**
 * `[ALC.2]` Alta de clientes: la constancia del SAT → la solicitud → el crédito → la liga con Kepler.
 *
 * Plan: [`FASE_ALC_ALTA_DE_CLIENTES.md`](../../../../../docs/IMPLEMENTACION/FASES/FASE_ALC_ALTA_DE_CLIENTES.md).
 *
 * ── Kepler ──────────────────────────────────────────────────────────────────────────────────
 * D1-a: la ficha se captura allá —la forma la arma esta pantalla en su mismo orden— y la Suite la
 * LIGA cuando la clave aparece en el ODS. D1-b `[ALC.2.8]`: `escribirEnKepler` la escribe en las 10
 * bases con `KeplerClienteSinkAdapter`, APAGADO por default (interruptor `cliente`, conexiones,
 * GRANT y la llave `COMMERCIAL_ALTA_CLIENTES_KEPLER`). ⛔ No copia el maestro: lo lee de
 * `kepler_ods.kdud` en cada consulta.
 *
 * ── El alcance ──────────────────────────────────────────────────────────────────────────────
 * Sucursal por `ScopeService` (área `comercial`): la caja ve y da de alta en las suyas; quien
 * tiene alcance «todas» (Crédito y Cobranza, Dirección) ve todas.
 */

const AREA = 'comercial';
const RUTA = 'commercial/customer-onboarding';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BANDEJA = 300;
const MAX_PDF_BYTES = 5 * 1024 * 1024;
const CARPETA = 'alta-clientes';
const GENERICOS = new Set(['XAXX010101000', 'XEXX010101000']);
const ESTADOS: EstadoSolicitudAlta[] = ['credito_por_aprobar', 'lista_para_kepler', 'ligada', 'cancelada'];

interface FilaSolicitud {
  id: string; folio_num: string | number; status: EstadoSolicitudAlta; origin: 'constancia' | 'manual'; branch: string;
  person_type: 'fisica' | 'moral'; rfc: string; curp: string | null; fiscal_name: string; capital_regime: string | null;
  trade_name: string | null; tax_regime: string; fiscal_zip: string; kepler_sheet: FichaKeplerCliente;
  seller_code: string | null; group_code: string | null; zone_code: string | null;
  credit_requested: string; term_days: number; discount_pct: string; comments: string | null;
  credit_decision: 'aprobado' | 'rechazado' | null; credit_decided_by: string | null; credit_decided_by_name: string | null;
  credit_decided_role: string | null; credit_decided_at: Date | null; credit_reason: string | null;
  credit_approved: string | null; term_approved: number | null; discount_approved: string | null;
  constancia_key: string | null; constancia_issued_on: string | Date | null; customer_id: string | null;
  erp_customer_code: string | null; linked_at: Date | null; created_by: string | null; created_by_name: string | null;
  created_at: Date;
  latitude: string | null; longitude: string | null; location_source: UbicacionAlta['origen'] | null; location_accuracy_m: string | null;
  uso_cfdi: string | null; payment_form: string | null;
  kepler_code: string | null; kepler_write_started_at: Date | null; kepler_write_by_name: string | null;
  kepler_written_at: Date | null; kepler_write_result: { intentada_el?: string; servidores?: ResultadoServidorAlta[] } | null;
}

/** `[ALC.2.8]` Un intento de escritura que lleva más que esto «en curso» se da por caído (el adaptador tarda segundos). */
const INTENTO_VIGENTE_MIN = 5;

const num = (v: unknown, def = 0): number => { const n = Number(v); return Number.isFinite(n) ? n : def; };
const txt = (v: unknown): string | null => { const s = String(v ?? '').trim(); return s ? s : null; };
/**
 * `[ALC.3.5]` La ubicación que llega de la pantalla: números finitos o nada. El rango y el país los
 * revisa `revisarSolicitud` (bloquea fuera de rango; avisa fuera de México).
 */
const ubicacionDe = (u: unknown): UbicacionAlta | null => {
  if (!u || typeof u !== 'object') return null;
  const x = u as Record<string, unknown>;
  const lat = Number(x['lat']), lng = Number(x['lng']);
  if (x['lat'] == null || x['lng'] == null || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const origen = x['origen'] === 'gps' || x['origen'] === 'mapa' ? x['origen'] : 'direccion';
  const p = Number(x['precision_m']);
  return { lat, lng, origen, precision_m: origen === 'gps' && Number.isFinite(p) && p >= 0 ? Math.round(p * 10) / 10 : null };
};
const isoFecha = (v: string | Date | null): string | null =>
  v == null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);

export interface ActorAlta { userId: string | null; roleName: string | null; puedeCredito: boolean; puedeKepler?: boolean }

@Injectable()
export class CustomerOnboardingService {
  private readonly logger = new Logger(CustomerOnboardingService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly scope: ScopeService,
    private readonly storage: ObjectStorageService,
    private readonly nuevos: NewCustomersKeplerService,
    private readonly kepler: KeplerClienteSinkAdapter,
  ) {}

  // ───────────────────────────── alcance ─────────────────────────────

  /** Sucursales (código Kepler `00`…`08`) que alcanza quien consulta; `null` = todas. */
  private async sucursalesDelAlcance(query: Record<string, unknown> = {}): Promise<string[] | null> {
    return this.scope.readParam(query, 'warehouse', RUTA, AREA);
  }

  private async exigirSucursal(branch: string, query: Record<string, unknown> = {}): Promise<void> {
    if (!/^\d{2}$/.test(branch)) throw new BadRequestException('Sucursal inválida: es la clave de Kepler de dos dígitos (00…08).');
    const alcance = await this.sucursalesDelAlcance(query);
    if (alcance !== null && !alcance.includes(branch)) {
      throw new ForbiddenException(`La sucursal ${branch} no está en tu alcance.`);
    }
  }

  // ───────────────────────────── catálogos ─────────────────────────────

  private async regimenes(trx: Knex | Knex.Transaction): Promise<RegimenFiscalOpcion[]> {
    // El catálogo del SAT que trae el propio Kepler (`c_RegimenFiscal`), vigente hoy.
    const { rows } = await trx.raw(
      `/* alc:regimenes */
       SELECT btrim(r.c1) AS clave, btrim(r.c2) AS descripcion,
              upper(left(btrim(r.c3), 1)) = 'S' AS persona_fisica,
              upper(left(btrim(r.c4), 1)) = 'S' AS persona_moral
         FROM kepler_ods.kdfe33satrf r
        WHERE r.sucursal = '00' AND btrim(coalesce(r.c1, '')) <> ''
          AND (r.c6 IS NULL OR r.c6 < '1900-01-01' OR r.c6 > now())
        ORDER BY 1`,
    );
    return rows.map((r: RegimenFiscalOpcion) => ({ ...r, persona_fisica: !!r.persona_fisica, persona_moral: !!r.persona_moral }));
  }

  /** `[ALC.3.6]` Uso de CFDI (`c_UsoCFDI` que trae Kepler), vigente, con los regímenes que lo admiten (`c7`). */
  private async usosCfdi(trx: Knex | Knex.Transaction): Promise<UsoCfdiOpcion[]> {
    const { rows } = await trx.raw(
      `/* alc:usos-cfdi */
       SELECT btrim(u.c1) AS clave, btrim(u.c2) AS descripcion, coalesce(u.c7, '') AS regimenes
         FROM kepler_ods.kdfe33satuso u
        WHERE u.sucursal = '00' AND btrim(coalesce(u.c1, '')) <> ''
          AND (u.c6 IS NULL OR u.c6 < '1900-01-01' OR u.c6 > now())
        ORDER BY 1`,
    );
    return rows.map((r: { clave: string; descripcion: string; regimenes: string }) => ({
      clave: r.clave, descripcion: r.descripcion,
      regimenes: r.regimenes.split(',').map((x) => x.trim()).filter(Boolean),
    }));
  }

  /** `[ALC.3.6]` Forma de pago (`c_FormaPago` que trae Kepler). */
  private async formasPago(trx: Knex | Knex.Transaction): Promise<OpcionCatalogo[]> {
    const { rows } = await trx.raw(
      `/* alc:formas-pago */ SELECT btrim(c1) AS clave, btrim(c2) AS nombre FROM kepler_ods.kdfe33satfopg
        WHERE sucursal = '00' AND btrim(coalesce(c1, '')) <> '' ORDER BY 1`,
    );
    return rows.map((r: OpcionCatalogo) => ({ clave: String(r.clave), nombre: String(r.nombre) }));
  }

  /** El estado del SAT de un CP, como lo escribe Kepler; `null` si no está en el catálogo. */
  private async estadoDelCp(trx: Knex | Knex.Transaction, cpRaw: unknown): Promise<string | null> {
    const cp = String(cpRaw ?? '').trim();
    if (!/^\d{5}$/.test(cp)) return null;
    const { rows: [edo] } = await trx.raw(
      `/* alc:cp-estado */ SELECT btrim(e.c3) AS estado
         FROM kepler_ods.kdfe33satcp p
         JOIN kepler_ods.kdfe33satedo e ON e.sucursal = '00' AND btrim(e.c1) = btrim(p.c2) AND btrim(e.c2) = 'MEX'
        WHERE p.sucursal = '00' AND btrim(p.c1) = ?
        LIMIT 1`,
      [cp],
    );
    return edo?.estado ? estadoCorto(edo.estado) : null;
  }

  /**
   * `[ALC.3.4]` Lo que se sabe de un CP. Medido en prod (2026-11-06): el catálogo del SAT
   * (`kdfe33satcp` → `kdfe33satedo`) da UN estado por CP (0 ambiguos); y 21,386 de 22,558 fichas de
   * `kdud` traen CP y renglón 2, en 486 CP distintos. No hay catálogo de colonias ni de municipios
   * en el ODS: el renglón 2 sale como sugerencia (los más usados en Kepler para ese CP), no se adivina.
   */
  async codigoPostal(cpRaw: unknown): Promise<CodigoPostalAlta> {
    const cp = String(cpRaw ?? '').trim();
    if (!/^\d{5}$/.test(cp)) throw new BadRequestException('El código postal lleva 5 dígitos.');
    return this.tk.run(async (trx) => {
      const estado = await this.estadoDelCp(trx, cp);
      const { rows } = await trx.raw(
        `/* alc:cp-dir2 */ SELECT upper(btrim(replace(d.c5, E'\\r', ''))) AS texto, count(*)::int AS fichas
           FROM kepler_ods.kdud d
          WHERE btrim(d.c27) = ? AND btrim(coalesce(d.c5, '')) <> ''
          GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 6`,
        [cp],
      );
      return {
        codigo_postal: cp,
        estado,
        sugerencias_direccion_2: rows.map((r: { texto: string; fichas: number }) => ({ texto: r.texto, fichas: Number(r.fichas) })),
      };
    });
  }

  async catalogos(branchRaw: unknown, query: Record<string, unknown> = {}): Promise<CatalogosAlta> {
    const alcance = await this.sucursalesDelAlcance(query);
    return this.tk.run(async (trx) => {
      const { rows: suc } = await trx.raw(
        `/* alc:sucursales */
         SELECT DISTINCT ON ((${branchKeySql('w')})) (${branchKeySql('w')}) AS clave, w.name AS nombre
           FROM commercial.warehouses w
          WHERE w.deleted_at IS NULL AND ${branchKeyFilterSql('w')}
          ORDER BY (${branchKeySql('w')}), w.is_default DESC, w.name`,
      );
      const sucursales: OpcionCatalogo[] = suc
        .filter((s: OpcionCatalogo) => alcance === null || alcance.includes(s.clave))
        .map((s: OpcionCatalogo) => ({ clave: String(s.clave), nombre: String(s.nombre) }));
      const pedida = txt(branchRaw);
      const branch = pedida && sucursales.some((s) => s.clave === pedida) ? pedida : sucursales[0]?.clave ?? '';
      const opciones = async (sql: string): Promise<OpcionCatalogo[]> => {
        if (!branch) return [];
        const { rows } = await trx.raw(sql, [branch]);
        return rows.map((r: OpcionCatalogo) => ({ clave: String(r.clave), nombre: String(r.nombre ?? r.clave) }));
      };
      return {
        branch,
        sucursales,
        vendedores: await opciones(`/* alc:vendedores */ SELECT btrim(c2) AS clave, btrim(c3) AS nombre FROM kepler_ods.kduv WHERE sucursal = ? AND btrim(coalesce(c2,'')) <> '' ORDER BY 2`),
        grupos: await opciones(`/* alc:grupos */ SELECT btrim(c1) AS clave, btrim(c2) AS nombre FROM kepler_ods.kduj WHERE sucursal = ? AND btrim(coalesce(c1,'')) <> '' ORDER BY 2`),
        zonas: await opciones(`/* alc:zonas */ SELECT btrim(c1) AS clave, btrim(c2) AS nombre FROM kepler_ods.kduk WHERE sucursal = ? AND btrim(coalesce(c1,'')) <> '' ORDER BY 2`),
        regimenes: await this.regimenes(trx),
        usos_cfdi: await this.usosCfdi(trx),
        formas_pago: await this.formasPago(trx),
        sugeridos: await this.sugeridos(trx, branch),
      };
    });
  }

  /**
   * `[ALC.3.6]` Lo que la sucursal ya dice de la cartera: su zona y su grupo de piso (constantes
   * medidas en `kduj`/`kduv`), y por grupo el vendedor que más usan sus fichas en Kepler.
   */
  private async sugeridos(trx: Knex | Knex.Transaction, branch: string): Promise<CatalogosAlta['sugeridos']> {
    const vendedor_por_grupo: Record<string, string> = {};
    if (/^\d{2}$/.test(branch)) {
      const { rows } = await trx.raw(
        `/* alc:vendedor-por-grupo */
         SELECT DISTINCT ON (grupo) grupo, vendedor
           FROM (SELECT btrim(c13) AS grupo, btrim(c12) AS vendedor, count(*) AS n
                   FROM kepler_ods.kdud
                  WHERE sucursal = ? AND btrim(coalesce(c13, '')) <> '' AND btrim(coalesce(c12, '')) <> ''
                  GROUP BY 1, 2) x
          ORDER BY grupo, n DESC, vendedor`,
        [branch],
      );
      for (const r of rows as Array<{ grupo: string; vendedor: string }>) vendedor_por_grupo[r.grupo] = r.vendedor;
    }
    return { zona: ZONA_DE_SUCURSAL[branch] ?? null, grupo_piso: PISO_DE_SUCURSAL[branch] ?? null, vendedor_por_grupo };
  }

  // ───────────────────────────── duplicados y contexto ─────────────────────────────

  /** Fichas de Kepler con el mismo RFC propio (en cualquier sucursal) o, con RFC genérico, nombre muy parecido en la sucursal. */
  private async duplicados(trx: Knex | Knex.Transaction, rfcRaw: string, nombre: string, branch: string): Promise<PosibleDuplicado[]> {
    const rfc = normalizarClaveFiscal(rfcRaw);
    const r = validarRfc(rfc);
    if (r.ok && !r.generico) {
      const { rows } = await trx.raw(
        `/* alc:duplicados-rfc */
         SELECT btrim(d.c2) AS clave, max(btrim(d.c3)) AS nombre, max(upper(btrim(d.c10))) AS rfc,
                array_agg(DISTINCT d.sucursal ORDER BY d.sucursal) AS sucursales
           FROM kepler_ods.kdud d
          WHERE upper(btrim(d.c10)) = ?
          GROUP BY btrim(d.c2)
          ORDER BY 1
          LIMIT 20`,
        [rfc],
      );
      return rows.map((x: PosibleDuplicado) => ({ ...x, por: 'rfc' as const }));
    }
    const nom = normalizarNombre(nombre);
    if (!nom || !/^\d{2}$/.test(branch)) return [];
    // Primera palabra significativa como filtro grueso en SQL; el parecido fino, en el motor de MCP.3.8.
    const primera = nom.split(' ').find((w) => w.length >= 4) ?? nom.split(' ')[0];
    const { rows } = await trx.raw(
      `/* alc:duplicados-nombre */
       SELECT btrim(d.c2) AS clave, btrim(d.c3) AS nombre, upper(btrim(d.c10)) AS rfc
         FROM kepler_ods.kdud d
        WHERE d.sucursal = ? AND upper(d.c3) LIKE ?
        LIMIT 400`,
      [branch, `%${primera.toUpperCase()}%`],
    );
    return rows
      .filter((x: { nombre: string }) => parecido(nom, normalizarNombre(x.nombre)) >= UMBRAL_PARECIDO)
      .slice(0, 10)
      .map((x: { clave: string; nombre: string; rfc: string | null }) => ({ ...x, rfc: x.rfc || null, sucursales: [branch], por: 'nombre' as const }));
  }

  private async contexto(trx: Knex | Knex.Transaction, b: SolicitudAltaBody): Promise<ContextoRevision> {
    const existe = async (sql: string, valor: string | null | undefined): Promise<boolean | null> => {
      if (!valor) return null;
      const { rows } = await trx.raw(sql, [b.branch, valor]);
      return rows.length > 0;
    };
    let cp_existe: boolean | null = null;
    if (/^\d{5}$/.test(String(b.codigo_postal_fiscal ?? ''))) {
      const { rows } = await trx.raw(
        `/* alc:cp */ SELECT 1 FROM kepler_ods.kdfe33satcp WHERE sucursal = '00' AND btrim(c1) = ? LIMIT 1`,
        [b.codigo_postal_fiscal],
      );
      cp_existe = rows.length > 0;
    }
    return {
      regimenes: await this.regimenes(trx),
      cp_existe,
      vendedor_existe: await existe(`/* alc:v */ SELECT 1 FROM kepler_ods.kduv WHERE sucursal = ? AND btrim(c2) = ? LIMIT 1`, b.vendedor_code),
      grupo_existe: await existe(`/* alc:g */ SELECT 1 FROM kepler_ods.kduj WHERE sucursal = ? AND btrim(c1) = ? LIMIT 1`, b.grupo_code),
      zona_existe: await existe(`/* alc:z */ SELECT 1 FROM kepler_ods.kduk WHERE sucursal = ? AND btrim(c1) = ? LIMIT 1`, b.zona_code),
      usos: await this.usosCfdi(trx),
      formas_pago: (await this.formasPago(trx)).map((f) => f.clave),
    };
  }

  /**
   * `[ALC.3.6]` El estado de la ficha sale del CP (catálogo del SAT), no de lo tecleado: en Kepler
   * Michoacán está escrito de 11 maneras (MICHOCAN, MCIHOACAN, MICHOACÁN…, medido). Si la persona
   * escribió otra cosa se corrige y se dice; si el CP no está en el catálogo, se respeta lo escrito.
   */
  private async conEstadoDelCp(trx: Knex | Knex.Transaction, b: SolicitudAltaBody): Promise<{ b: SolicitudAltaBody; hallazgo: HallazgoAlta | null }> {
    const cp = b.ficha.codigo_postal || b.codigo_postal_fiscal;
    const estado = await this.estadoDelCp(trx, cp);
    if (!estado || b.ficha.estado === estado) return { b, hallazgo: null };
    const hallazgo: HallazgoAlta = {
      campo: 'ficha.estado', gravedad: 'aviso',
      mensaje: b.ficha.estado
        ? `El CP ${cp} es de ${estado} (catálogo del SAT): se guarda ése y no «${b.ficha.estado}».`
        : `El estado se llenó con el del CP ${cp}: ${estado}.`,
    };
    return { b: { ...b, ficha: { ...b.ficha, estado } }, hallazgo };
  }

  /**
   * Lo que llega del navegador, a la forma que revisan las reglas. `[ALC.3.6]` La ficha queda como
   * la escribe Kepler (`textoKepler`: mayúsculas, sin acentos salvo la Ñ, sin comillas ni
   * caracteres de control; teléfonos sólo con dígitos), y el uso de CFDI y la forma de pago que no
   * se eligieron toman los de costumbre (medidos en `kdfedir`).
   */
  private normalizar(raw: SolicitudAltaBody): SolicitudAltaBody {
    if (!raw || typeof raw !== 'object') throw new BadRequestException('Falta la solicitud.');
    const ficha = { ...fichaVacia() };
    for (const k of Object.keys(CASILLAS_KEPLER) as Array<keyof FichaKeplerCliente>) {
      const v = String(raw.ficha?.[k] ?? '');
      ficha[k] = k === 'email' ? v.trim().toLowerCase()
        : k.startsWith('telefono') ? telefonoKepler(v)
          : k === 'codigo_postal' ? v.replace(/\D/g, '')
            : k === 'rfc' || k === 'curp' ? normalizarClaveFiscal(v)
              : textoKepler(v);
    }
    const rfc = normalizarClaveFiscal(raw.rfc);
    const regimen_fiscal = String(raw.regimen_fiscal ?? '').trim();
    return {
      ...raw,
      branch: String(raw.branch ?? '').trim(),
      origen: raw.origen === 'constancia' ? 'constancia' : 'manual',
      tipo_persona: raw.tipo_persona === 'moral' ? 'moral' : 'fisica',
      rfc,
      curp: normalizarClaveFiscal(raw.curp) || null,
      nombre_fiscal: String(raw.nombre_fiscal ?? '').replace(/\s+/g, ' ').trim().toUpperCase(),
      regimen_capital: txt(raw.regimen_capital)?.toUpperCase() ?? null,
      nombre_comercial: txt(raw.nombre_comercial)?.toUpperCase() ?? null,
      regimen_fiscal,
      codigo_postal_fiscal: String(raw.codigo_postal_fiscal ?? '').trim(),
      uso_cfdi: txt(raw.uso_cfdi)?.toUpperCase() ?? usoCfdiPorDefecto(rfc, regimen_fiscal),
      forma_pago: txt(raw.forma_pago) ?? formaPagoPorDefecto(pideCredito(raw)),
      ficha: { ...ficha, rfc: ficha.rfc || normalizarClaveFiscal(raw.rfc) },
      vendedor_code: txt(raw.vendedor_code), grupo_code: txt(raw.grupo_code), zona_code: txt(raw.zona_code),
      credito_solicitado: num(raw.credito_solicitado), plazo_dias: num(raw.plazo_dias), descuento_pct: num(raw.descuento_pct),
      comentarios: txt(raw.comentarios),
      constancia_key: txt(raw.constancia_key),
      customer_id: txt(raw.customer_id),
      ubicacion: ubicacionDe(raw.ubicacion),
      confirmar_duplicado: raw.confirmar_duplicado === true,
    };
  }

  // ───────────────────────────── 1. la constancia ─────────────────────────────

  async subirConstancia(body: SubirConstanciaBody, query: Record<string, unknown> = {}): Promise<SubirConstanciaRespuesta> {
    const dataUri = String(body?.pdf ?? '');
    const base64 = dataUri.replace(/^data:[^,]*,/, '');
    if (!base64) throw new BadRequestException('Falta el PDF de la constancia.');
    const bytes = new Uint8Array(Buffer.from(base64, 'base64'));
    if (bytes.length > MAX_PDF_BYTES) throw new BadRequestException('La constancia pesa más de 5 MB: no parece la del SAT (pesa ~140 KB).');

    const lectura = await leerConstanciaPdf(bytes);
    if (!lectura.ok) {
      return { lectura, constancia_key: null, aviso_guardado: null, armado: null, regimen_sugerido: null, regimenes_vigentes: [], hallazgos: [], duplicados: [] };
    }

    let constancia_key: string | null = null, aviso_guardado: string | null = null;
    if (!this.storage.isConfigured()) aviso_guardado = 'El almacén de documentos no está configurado: la constancia se leyó pero NO se guardó.';
    else {
      try { constancia_key = (await this.storage.putPdf(`data:application/pdf;base64,${base64}`, CARPETA)).key; }
      catch (e) { aviso_guardado = `La constancia se leyó pero no se pudo guardar: ${(e as Error).message}`; }
    }

    const c = lectura.constancia;
    const armado = fichaDesdeConstancia(c);
    const alcance = await this.sucursalesDelAlcance(query);
    const branch = txt(body?.branch) ?? (alcance?.[0] ?? '');
    return this.tk.run(async (trx) => {
      const regimenes = await this.regimenes(trx);
      const vigentes = c.regimenes.filter((r) => r.vigente).map((r) => claveDeRegimen(r.descripcion, regimenes))
        .filter((r): r is RegimenFiscalOpcion => r !== null);
      // Sólo se sugiere cuando no hay nada que elegir; con dos vigentes, elige la persona.
      const regimen_sugerido = vigentes.length === 1 ? vigentes[0].clave : null;
      const preliminar: SolicitudAltaBody = {
        branch, origen: 'constancia', tipo_persona: c.tipo, rfc: c.rfc, curp: c.curp, nombre_fiscal: c.nombre_fiscal,
        regimen_capital: c.regimen_capital, nombre_comercial: c.nombre_comercial, regimen_fiscal: regimen_sugerido ?? '',
        codigo_postal_fiscal: c.domicilio.codigo_postal ?? '', ficha: armado.ficha,
      };
      const hallazgos: HallazgoAlta[] = [
        ...lectura.avisos.map((m) => ({ campo: 'constancia', gravedad: 'aviso' as const, mensaje: m })),
        ...lectura.faltantes.map((f) => ({ campo: 'constancia', gravedad: 'aviso' as const, mensaje: `La constancia no trae ${f}: captúralo a mano.` })),
        ...revisarSolicitud(preliminar, await this.contexto(trx, preliminar)).filter((h) => h.campo !== 'kepler' && h.campo !== 'regimen_fiscal'),
      ];
      return {
        lectura, constancia_key, aviso_guardado, armado, regimen_sugerido, regimenes_vigentes: vigentes.map((r) => r.clave), hallazgos,
        duplicados: await this.duplicados(trx, c.rfc, c.nombre_fiscal, branch),
      };
    });
  }

  // ───────────────────────────── 2. revisar y crear ─────────────────────────────

  async revisar(raw: SolicitudAltaBody, query: Record<string, unknown> = {}): Promise<RevisionAlta> {
    const b0 = this.normalizar(raw);
    if (b0.branch) await this.exigirSucursal(b0.branch, query);
    return this.tk.run(async (trx) => {
      const { b, hallazgo } = await this.conEstadoDelCp(trx, b0);
      return {
        hallazgos: [...(hallazgo ? [hallazgo] : []), ...revisarSolicitud(b, await this.contexto(trx, b))],
        duplicados: await this.duplicados(trx, b.rfc, b.nombre_fiscal, b.branch),
        recortes: recortesDe(b.ficha),
      };
    });
  }

  async crear(raw: SolicitudAltaBody, query: Record<string, unknown> = {}): Promise<CrearSolicitudRespuesta> {
    const me = this.tenantCtx.get()?.userId;
    if (!me) throw new UnauthorizedException('Sin usuario en la sesión: una solicitud de alta la firma alguien.');
    const b0 = this.normalizar(raw);
    await this.exigirSucursal(b0.branch, query);
    if (b0.customer_id && !UUID_RE.test(b0.customer_id)) throw new BadRequestException('customer_id inválido.');
    let b = b0;
    if (b.constancia_key && !b.constancia_key.startsWith(`${CARPETA}/`)) throw new BadRequestException('La constancia no es de este módulo.');

    // La lectura que se guarda es la del PDF guardado, no la que mandó el navegador.
    let lectura: unknown = null, emitida: string | null = null;
    if (b.constancia_key && this.storage.isConfigured()) {
      const uri = await this.storage.getDataUri(b.constancia_key).catch(() => null);
      if (!uri) throw new BadRequestException('No se encontró la constancia guardada: vuelve a subirla.');
      const l = await leerConstanciaPdf(new Uint8Array(Buffer.from(uri.replace(/^data:[^,]*,/, ''), 'base64')));
      if (l.ok) {
        lectura = l;
        emitida = l.constancia.emitida_el;
        if (l.constancia.rfc !== b.rfc) throw new BadRequestException(`El RFC capturado (${b.rfc}) no es el de la constancia (${l.constancia.rfc}).`);
      }
    }

    return this.tk.run(async (trx) => {
      const est = await this.conEstadoDelCp(trx, b);
      b = est.b;
      const hallazgos = [...(est.hallazgo ? [est.hallazgo] : []), ...revisarSolicitud(b, await this.contexto(trx, b))];
      const duplicados = await this.duplicados(trx, b.rfc, b.nombre_fiscal, b.branch);
      const revision: RevisionAlta = { hallazgos, duplicados, recortes: recortesDe(b.ficha) };
      if (bloquea(hallazgos)) {
        throw new BadRequestException({ message: 'La solicitud tiene datos que no se pueden guardar así.', revision });
      }
      const porRfc = duplicados.filter((d) => d.por === 'rfc');
      if (porRfc.length && !b.confirmar_duplicado) {
        throw new ConflictException({
          message: `Ese RFC ya está en Kepler con la clave ${porRfc.map((d) => d.clave).join(', ')}. Si de verdad es otra ficha, confírmalo.`,
          revision,
        });
      }
      if (b.customer_id) {
        const { rows } = await trx.raw(
          `/* alc:cliente */ SELECT id FROM commercial.customers WHERE id = ? AND deleted_at IS NULL AND erp_customer_code IS NULL`,
          [b.customer_id],
        );
        if (!rows.length) throw new BadRequestException('El cliente de la Suite no existe o ya está ligado a Kepler.');
      }
      try {
        // Columna, valor y tipo en UNA lista: las marcas y los valores salen de ella y no pueden
        // descuadrarse (`[ALC.3.5.1]`: un INSERT con 30 `?` para 29 valores llegó a prod).
        const columnas: Array<[string, unknown, string?]> = [
          ['status', estadoInicial(b)], ['origin', b.origen], ['branch', b.branch], ['person_type', b.tipo_persona],
          ['rfc', b.rfc], ['curp', b.tipo_persona === 'fisica' ? b.curp : null], ['fiscal_name', b.nombre_fiscal],
          ['capital_regime', b.regimen_capital], ['trade_name', b.nombre_comercial], ['tax_regime', b.regimen_fiscal],
          ['fiscal_zip', b.codigo_postal_fiscal], ['uso_cfdi', b.uso_cfdi], ['payment_form', b.forma_pago],
          ['kepler_sheet', JSON.stringify(b.ficha), 'jsonb'], ['seller_code', b.vendedor_code], ['group_code', b.grupo_code],
          ['zone_code', b.zona_code], ['credit_requested', b.credito_solicitado], ['term_days', b.plazo_dias],
          ['discount_pct', b.descuento_pct], ['comments', b.comentarios], ['constancia_key', b.constancia_key],
          ['constancia_reading', lectura ? JSON.stringify(lectura) : null, 'jsonb'], ['constancia_issued_on', emitida, 'date'],
          ['customer_id', b.customer_id], ['latitude', b.ubicacion?.lat], ['longitude', b.ubicacion?.lng],
          ['location_source', b.ubicacion?.origen], ['location_accuracy_m', b.ubicacion?.precision_m],
          ['created_by', me], ['updated_by', me],
        ];
        const { rows } = await trx.raw(
          `/* alc:crear */
           INSERT INTO commercial.customer_onboarding_requests (tenant_id, ${columnas.map(([c]) => c).join(', ')})
           VALUES (public.current_tenant_id(), ${columnas.map(([, , t]) => (t ? `?::${t}` : '?')).join(', ')})
           RETURNING id`,
          columnas.map(([, v]) => (v === undefined ? null : v)) as Knex.RawBinding[],
        );
        this.logger.log(`[ALC] solicitud ${rows[0].id} (${b.rfc}, sucursal ${b.branch}) creada por ${me}`);
        return { solicitud: await this.leerUna(trx, rows[0].id), revision };
      } catch (e) {
        if ((e as { code?: string })?.code === '23505') {
          throw new ConflictException('Ese RFC ya tiene una solicitud de alta abierta: búscala en la bandeja.');
        }
        throw e;
      }
    });
  }

  // ───────────────────────────── 3. la bandeja ─────────────────────────────

  async bandeja(query: Record<string, unknown> = {}, actor: ActorAlta): Promise<BandejaAlta> {
    const alcance = await this.sucursalesDelAlcance(query);
    const vacio = Object.fromEntries(ESTADOS.map((e) => [e, 0])) as Record<EstadoSolicitudAlta, number>;
    if (alcance !== null && !alcance.length) {
      return { alcance: 'ninguno', solicitudes: [], conteo: vacio, truncada: false, puede_aprobar_credito: actor.puedeCredito, kepler_as_of: null };
    }
    const estado = ESTADOS.includes(query['estado'] as EstadoSolicitudAlta) ? (query['estado'] as EstadoSolicitudAlta) : null;
    return this.tk.run(async (trx) => {
      const filtroSuc = alcance === null ? '' : 'AND r.branch = ANY(?)';
      const params: Knex.RawBinding[] = alcance === null ? [] : [alcance];
      const { rows: cuenta } = await trx.raw(
        `/* alc:conteo */ SELECT r.status, count(*)::int AS n FROM commercial.customer_onboarding_requests r
          WHERE r.deleted_at IS NULL ${filtroSuc} GROUP BY 1`,
        params,
      );
      const conteo = { ...vacio };
      for (const c of cuenta) conteo[c.status as EstadoSolicitudAlta] = c.n;
      const { rows } = await trx.raw(
        `${this.selectSolicitud()}
          WHERE r.deleted_at IS NULL ${filtroSuc} ${estado ? 'AND r.status = ?' : ''}
          ORDER BY CASE r.status WHEN 'credito_por_aprobar' THEN 0 WHEN 'lista_para_kepler' THEN 1 ELSE 2 END, r.created_at DESC
          LIMIT ${MAX_BANDEJA + 1}`,
        estado ? [...params, estado] : params,
      );
      const solicitudes = await this.conCoincidencias(trx, rows.slice(0, MAX_BANDEJA).map((f: FilaSolicitud) => this.aSolicitud(f)));
      // El último cambio del maestro de clientes que llegó al ODS (lo escribe la ingesta en cada push;
      // la tabla la crea la migración 20260811120000, existe en toda base).
      const { rows: sync } = await trx.raw(
        `/* alc:frescura */ SELECT last_push_at FROM kepler_ods._sync_status WHERE table_name = 'kdud'`,
      );
      return {
        alcance: alcance === null ? 'todos' : 'propios',
        solicitudes,
        conteo,
        truncada: rows.length > MAX_BANDEJA,
        puede_aprobar_credito: actor.puedeCredito,
        kepler_as_of: sync[0]?.last_push_at ? new Date(sync[0].last_push_at).toISOString() : null,
      };
    });
  }

  /** «Lista para Kepler» con RFC propio: ¿ya hay ficha en Kepler (su sucursal) con ese RFC? */
  private async conCoincidencias(trx: Knex.Transaction, solicitudes: SolicitudAlta[]): Promise<SolicitudAlta[]> {
    const buscar = solicitudes.filter((s) => s.estado === 'lista_para_kepler' && !GENERICOS.has(s.rfc));
    if (!buscar.length) return solicitudes;
    const { rows } = await trx.raw(
      `/* alc:coincidencias */
       SELECT d.sucursal, btrim(d.c2) AS clave, btrim(d.c3) AS nombre, upper(btrim(d.c10)) AS rfc
         FROM kepler_ods.kdud d
        WHERE upper(btrim(d.c10)) = ANY(?)`,
      [[...new Set(buscar.map((s) => s.rfc))]],
    );
    return solicitudes.map((s) => {
      if (!buscar.includes(s)) return s;
      const deEsta = rows.filter((r: { sucursal: string; rfc: string }) => r.rfc === s.rfc && r.sucursal === s.branch);
      return {
        ...s,
        coincidencias_kepler: deEsta.map((r: { clave: string; nombre: string; rfc: string }): CoincidenciaKepler => ({
          clave: r.clave, nombre: r.nombre, rfc: r.rfc,
          sucursales: [...new Set(rows.filter((x: { clave: string; sucursal: string }) => x.clave === r.clave).map((x: { sucursal: string }) => x.sucursal))].sort() as string[],
          coincide_rfc: true,
        })),
      };
    });
  }

  private selectSolicitud(): string {
    return `/* alc:solicitud */
      SELECT r.*, uc.nombre AS created_by_name, ud.nombre AS credit_decided_by_name, uk.nombre AS kepler_write_by_name
        FROM commercial.customer_onboarding_requests r
        LEFT JOIN public.users uc ON uc.id = r.created_by
        LEFT JOIN public.users ud ON ud.id = r.credit_decided_by
        LEFT JOIN public.users uk ON uk.id = r.kepler_write_by`;
  }

  private async leerUna(trx: Knex.Transaction, id: string, bloquear = false): Promise<SolicitudAlta> {
    const { rows } = await trx.raw(`${this.selectSolicitud()} WHERE r.id = ? AND r.deleted_at IS NULL ${bloquear ? 'FOR UPDATE OF r' : ''}`, [id]);
    if (!rows.length) throw new NotFoundException('No existe esa solicitud de alta.');
    return this.aSolicitud(rows[0]);
  }

  private aSolicitud(f: FilaSolicitud): SolicitudAlta {
    return {
      id: String(f.id),
      folio: `ALC-${String(f.folio_num).padStart(5, '0')}`,
      estado: f.status, origen: f.origin, branch: f.branch, tipo_persona: f.person_type,
      rfc: f.rfc, curp: f.curp, nombre_fiscal: f.fiscal_name, regimen_capital: f.capital_regime, nombre_comercial: f.trade_name,
      regimen_fiscal: f.tax_regime, codigo_postal_fiscal: f.fiscal_zip,
      uso_cfdi: f.uso_cfdi ?? null, forma_pago: f.payment_form ?? null,
      ficha: { ...fichaVacia(), ...(f.kepler_sheet ?? {}) },
      vendedor_code: f.seller_code, grupo_code: f.group_code, zona_code: f.zone_code,
      credito_solicitado: num(f.credit_requested), plazo_dias: num(f.term_days), descuento_pct: num(f.discount_pct),
      comentarios: f.comments,
      credito: f.credit_decision ? {
        decision: f.credit_decision, por: String(f.credit_decided_by), por_nombre: f.credit_decided_by_name,
        el: f.credit_decided_at ? new Date(f.credit_decided_at).toISOString() : '', motivo: f.credit_reason ?? '',
        credito_aprobado: num(f.credit_approved), plazo_aprobado: num(f.term_approved), descuento_aprobado: num(f.discount_approved),
      } : null,
      constancia_key: f.constancia_key, constancia_emitida_el: isoFecha(f.constancia_issued_on),
      customer_id: f.customer_id, erp_customer_code: f.erp_customer_code,
      ubicacion: f.latitude != null && f.longitude != null && f.location_source
        ? { lat: num(f.latitude), lng: num(f.longitude), origen: f.location_source, precision_m: f.location_accuracy_m == null ? null : num(f.location_accuracy_m) }
        : null,
      ligada_el: f.linked_at ? new Date(f.linked_at).toISOString() : null,
      creada_por: f.created_by, creada_por_nombre: f.created_by_name,
      creada_el: new Date(f.created_at).toISOString(),
      coincidencias_kepler: [],
      credito_decidido_por_quien_la_creo: !!f.credit_decided_by && f.credit_decided_by === f.created_by,
      kepler: f.kepler_code
        ? {
          clave: f.kepler_code,
          escrita_el: f.kepler_written_at ? new Date(f.kepler_written_at).toISOString() : null,
          intentada_el: f.kepler_write_result?.intentada_el ?? null,
          intentada_por_nombre: f.kepler_write_by_name ?? null,
          servidores: f.kepler_write_result?.servidores ?? [],
        }
        : null,
    };
  }

  async una(id: string, query: Record<string, unknown> = {}): Promise<SolicitudAlta> {
    if (!UUID_RE.test(id)) throw new BadRequestException('id inválido');
    const s = await this.tk.run((trx) => this.leerUna(trx, id));
    await this.exigirSucursal(s.branch, query);
    return s;
  }

  /** Liga temporal (10 min) para ver la constancia guardada. */
  async urlConstancia(id: string, query: Record<string, unknown> = {}): Promise<{ url: string }> {
    const s = await this.una(id, query);
    if (!s.constancia_key) throw new NotFoundException('Esta solicitud se capturó sin constancia.');
    return { url: await this.storage.signedUrl(s.constancia_key, 600) };
  }

  // ───────────────────────────── 4. crédito ─────────────────────────────

  async decidirCredito(id: string, body: DecidirCreditoBody, actor: ActorAlta, query: Record<string, unknown> = {}): Promise<SolicitudAlta> {
    if (!actor.userId) throw new UnauthorizedException('Sin usuario en la sesión: el crédito lo firma alguien.');
    if (!actor.puedeCredito) throw new ForbiddenException('Decidir crédito es de Crédito y Cobranza (o, en su ausencia, Gerencia Administrativa y Financiera o Dirección General).');
    if (!UUID_RE.test(id)) throw new BadRequestException('id inválido');
    const decision = body?.decision;
    if (decision !== 'aprobado' && decision !== 'rechazado') throw new BadRequestException('La decisión es «aprobado» o «rechazado».');
    const motivo = txt(body?.motivo);
    if (!motivo || motivo.length < 5) throw new BadRequestException('Escribe el motivo de la decisión (queda en el registro).');

    return this.tk.run(async (trx) => {
      const s = await this.leerUna(trx, id, true);
      await this.exigirSucursal(s.branch, query);
      if (s.estado !== 'credito_por_aprobar') throw new ConflictException(`La solicitud ${s.folio} no espera crédito (está «${s.estado}»).`);
      const aprobado = decision === 'aprobado';
      const credito = aprobado ? num(body.credito_aprobado, s.credito_solicitado) : 0;
      const plazo = aprobado ? num(body.plazo_aprobado, s.plazo_dias) : 0;
      const desc = aprobado ? num(body.descuento_aprobado, s.descuento_pct) : 0;
      if (credito < 0 || plazo < 0 || !Number.isInteger(plazo) || desc < 0 || desc > 100) {
        throw new BadRequestException('Crédito y plazo no negativos (plazo en días enteros) y descuento de 0 a 100 %.');
      }
      await trx.raw(
        `/* alc:credito */
         UPDATE commercial.customer_onboarding_requests
            SET status = 'lista_para_kepler', credit_decision = ?, credit_decided_by = ?, credit_decided_role = ?,
                credit_decided_at = now(), credit_reason = ?, credit_approved = ?, term_approved = ?, discount_approved = ?,
                updated_at = now(), updated_by = ?
          WHERE id = ? AND status = 'credito_por_aprobar'`,
        [decision, actor.userId, actor.roleName, motivo, credito, plazo, desc, actor.userId, id],
      );
      this.logger.log(`[ALC] crédito de ${s.folio}: ${decision} por ${actor.userId} (${actor.roleName})`);
      return this.leerUna(trx, id);
    });
  }

  // ───────────────────────────── 5. ligar con Kepler ─────────────────────────────

  async ligar(id: string, body: LigarSolicitudBody, query: Record<string, unknown> = {}): Promise<SolicitudAlta> {
    const me = this.tenantCtx.get()?.userId;
    if (!me) throw new UnauthorizedException('Sin usuario en la sesión: ligar lo firma alguien.');
    if (!UUID_RE.test(id)) throw new BadRequestException('id inválido');

    // El cliente `V-` del vendedor se liga con la regla de MCP.3.8 (misma fila, datos de Kepler).
    const previa = await this.una(id, query);
    if (previa.estado !== 'lista_para_kepler') throw new ConflictException(`La solicitud ${previa.folio} no está lista para ligar (está «${previa.estado}»).`);
    // `[ALC.2.8]` Si la Suite ya la escribió en Kepler, la clave es ésa (no se teclea).
    const clave = normalizarClave(body?.erp_customer_code) || (previa.kepler?.escrita_el ? previa.kepler.clave : '');
    if (!clave) throw new BadRequestException('Escribe la clave que le dio Kepler.');
    if (previa.kepler?.escrita_el && clave !== previa.kepler.clave) {
      throw new ConflictException(`La Suite ya la dio de alta en Kepler con la clave ${previa.kepler.clave}: se liga con ésa.`);
    }

    // Tres casos, decididos con lo que hay en Kepler y en la Suite (sin escribir nada todavía):
    //  A. la clave ya tiene ficha en la Suite (ancla de VK.4) → se completa lo fiscal de ésa;
    //  B. la solicitud completa un `V-` del vendedor → la liga es la de MCP.3.8 (misma fila);
    //  C. no hay ficha en la Suite → se crea `K<sucursal>-<clave>`, como el ancla de VK.4.
    const plan = await this.tk.run(async (trx) => {
      const s = await this.leerUna(trx, id);
      const { rows: k } = await trx.raw(
        `/* alc:kepler */
         SELECT btrim(d.c3) AS nombre, upper(btrim(d.c10)) AS rfc, d.c15 AS limite, d.c16 AS plazo, d.c17 AS descuento
           FROM kepler_ods.kdud d WHERE d.sucursal = ? AND btrim(d.c2) = ? LIMIT 1`,
        [s.branch, clave],
      );
      const kepler = k[0] as FichaKeplerLeida | undefined;
      if (!kepler) {
        throw new NotFoundException(`Kepler (sucursal ${s.branch}) todavía no tiene la clave ${clave}. Si la acabas de capturar, espera a que llegue al ODS y vuelve a intentar.`);
      }
      if (!GENERICOS.has(s.rfc) && kepler.rfc !== s.rfc) {
        throw new ConflictException(`La clave ${clave} en Kepler tiene otro RFC (${kepler.rfc || 'vacío'}), no ${s.rfc}. Revisa la clave o corrige el RFC en Kepler.`);
      }
      const { rows: ancla } = await trx.raw(
        `/* alc:ancla */ SELECT id FROM commercial.customers WHERE erp_source_branch = ? AND erp_customer_code = ? AND deleted_at IS NULL LIMIT 1`,
        [s.branch, clave],
      );
      const anclaId = ancla[0] ? String(ancla[0].id) : null;
      if (anclaId && s.customer_id && s.customer_id !== anclaId) {
        throw new ConflictException(`La clave ${clave} ya está ligada a otra ficha de la Suite. Fusionar dos fichas no se hace aquí.`);
      }
      return { kepler, caso: anclaId ? ('A' as const) : s.customer_id ? ('B' as const) : ('C' as const), anclaId, clienteV: s.customer_id };
    });

    // B: la liga de MCP.3.8 corre en su propia transacción; si falla, aquí no se escribió nada.
    if (plan.caso === 'B' && plan.clienteV) await this.nuevos.link(plan.clienteV, clave, query);

    return this.tk.run(async (trx) => {
      const s = await this.leerUna(trx, id, true);
      if (s.estado !== 'lista_para_kepler') throw new ConflictException('Alguien más acaba de cambiar esta solicitud. Recarga la bandeja.');
      let customerId: string | null = plan.caso === 'A' ? plan.anclaId : s.customer_id;
      if (plan.caso === 'C') {
        const { rows: nuevo } = await trx.raw(
          `/* alc:nuevo-cliente */
           INSERT INTO commercial.customers
             (tenant_id, code, name, legal_name, rfc, credit_limit, payment_terms_days, erp_source_branch, erp_customer_code,
              default_price_list_id, active, created_by, updated_by)
           SELECT public.current_tenant_id(), ?, left(?, 200), left(?, 200), ?, COALESCE(?::numeric, 0), COALESCE(?::numeric, 0)::int, ?, ?,
                  (SELECT pl.id FROM commercial.price_lists pl WHERE pl.is_default AND pl.active AND pl.deleted_at IS NULL LIMIT 1),
                  true, ?, ?
            WHERE NOT EXISTS (SELECT 1 FROM commercial.customers x WHERE x.code = ? AND x.deleted_at IS NULL)
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [
            codigoKepler(s.branch, clave), plan.kepler.nombre || s.nombre_fiscal, s.nombre_fiscal, s.rfc,
            plan.kepler.limite, plan.kepler.plazo, s.branch, clave, me, me, codigoKepler(s.branch, clave),
          ],
        );
        if (!nuevo[0]) throw new ConflictException(`Ya existe un cliente de la Suite con el código ${codigoKepler(s.branch, clave)} o con esa clave de Kepler: recarga y vuelve a intentar.`);
        customerId = String(nuevo[0].id);
      }
      if (!customerId) throw new ConflictException('La solicitud se quedó sin ficha de la Suite a la cual ligarse. Recarga y vuelve a intentar.');
      await this.completarFiscales(trx, customerId, s, me);
      const nota = diferenciaDeCredito(s, plan.kepler);
      await trx.raw(
        `/* alc:ligada */
         UPDATE commercial.customer_onboarding_requests
            SET status = 'ligada', erp_customer_code = ?, customer_id = ?, linked_at = now(), linked_by = ?,
                comments = CASE WHEN ?::text IS NULL THEN comments ELSE concat_ws(E'\\n', comments, ?::text) END,
                updated_at = now(), updated_by = ?
          WHERE id = ? AND status = 'lista_para_kepler'`,
        [clave, customerId, me, nota, nota, me, id],
      );
      this.logger.log(`[ALC] ${s.folio} ligada a Kepler ${s.branch}/${clave} (caso ${plan.caso}) por ${me}`);
      return this.leerUna(trx, id);
    });
  }

  /** Lo fiscal de la solicitud a la ficha de la Suite (lo que el CFDI 4.0 necesita del receptor). */
  private async completarFiscales(trx: Knex.Transaction, customerId: string, s: SolicitudAlta, me: string): Promise<void> {
    await trx.raw(
      `/* alc:fiscales */
       UPDATE commercial.customers
          SET rfc = CASE WHEN ? THEN rfc ELSE ? END,
              legal_name = left(?, 200),
              regimen_fiscal = ?,
              billing_address = COALESCE(billing_address, '{}'::jsonb) || jsonb_build_object('zip', ?::text, 'source', 'alta-clientes'),
              -- [ALC.3.5] La ubicación sólo llena un hueco: si el cliente ya tenía punto (p. ej. el V-… del
              -- vendedor), no se pisa. Las dos coordenadas se deciden con el valor VIEJO de latitude.
              latitude = CASE WHEN latitude IS NULL AND ?::numeric IS NOT NULL THEN ?::numeric ELSE latitude END,
              longitude = CASE WHEN latitude IS NULL AND ?::numeric IS NOT NULL THEN ?::numeric ELSE longitude END,
              updated_at = now(), updated_by = ?
        WHERE id = ? AND deleted_at IS NULL`,
      [GENERICOS.has(s.rfc), s.rfc, s.nombre_fiscal, s.regimen_fiscal, s.codigo_postal_fiscal,
        s.ubicacion?.lat ?? null, s.ubicacion?.lat ?? null, s.ubicacion?.lng ?? null, s.ubicacion?.lng ?? null, me, customerId],
    );
  }

  // ───────────────────────────── 5b. escribir en Kepler (D1-b) ─────────────────────────────

  /** La solicitud en el idioma de Kepler, con los catálogos del SAT y el estado del CP leídos del ODS. */
  private async armarParaKepler(trx: Knex | Knex.Transaction, s: SolicitudAlta): Promise<ArmadoClienteKepler> {
    return armarClienteKepler({
      solicitud: s,
      estadoDelCp: await this.estadoDelCp(trx, s.ficha.codigo_postal || s.codigo_postal_fiscal),
      usos: await this.usosCfdi(trx),
      formasPago: (await this.formasPago(trx)).map((f) => f.clave),
    });
  }

  /** Claves ya reservadas por OTRAS solicitudes: dos altas simultáneas no se llevan la misma. */
  private async clavesReservadas(trx: Knex | Knex.Transaction, exceptoId: string): Promise<string[]> {
    const { rows } = await trx.raw(
      `/* alc:claves-reservadas */ SELECT kepler_code FROM commercial.customer_onboarding_requests
        WHERE kepler_code IS NOT NULL AND deleted_at IS NULL AND id <> ?`,
      [exceptoId],
    );
    return rows.map((r: { kepler_code: string }) => r.kepler_code);
  }

  /** El renglón (sucursal, `cliente`) del interruptor. Sin tabla o sin renglón = APAGADA (falla cerrada). */
  private async interruptorCliente(trx: Knex | Knex.Transaction, branch: string): Promise<{ encendida: boolean; tope_dia: number | null }> {
    const { rows: [t] } = await trx.raw(`SELECT to_regclass('commercial.kepler_push_switch') IS NOT NULL AS hay`);
    if (!t?.hay) return { encendida: false, tope_dia: 1 };
    const { rows: [r] } = await trx.raw(
      `/* alc:interruptor */ SELECT encendida, tope_dia FROM commercial.kepler_push_switch
        WHERE tenant_id = public.current_tenant_id() AND sucursal = ? AND tipo = 'cliente'`,
      [branch],
    );
    return r ? { encendida: r.encendida === true, tope_dia: r.tope_dia == null ? null : Number(r.tope_dia) } : { encendida: false, tope_dia: 1 };
  }

  /** Por qué NO se puede pulsar «Dar de alta en Kepler»; `null` = se puede. En el orden en que la persona lo resuelve. */
  private async bloqueoDeEscritura(
    trx: Knex | Knex.Transaction, s: SolicitudAlta, hallazgos: HallazgoAlta[], servidores: ServidorEscrituraKepler[], actor: ActorAlta,
  ): Promise<string | null> {
    if (s.estado !== 'lista_para_kepler') return `La solicitud está «${s.estado.replace(/_/g, ' ')}»: sólo una lista para Kepler se escribe.`;
    if (s.kepler?.escrita_el) return `Ya está en las 10 bases de Kepler con la clave ${s.kepler.clave}: falta ligarla.`;
    if (!actor.puedeKepler) return 'Escribir en Kepler pide la llave «Dar de alta clientes en Kepler».';
    if (bloquea(hallazgos)) return 'La ficha tiene datos que Kepler no recibiría así: corrígelos (abajo) antes de escribir.';
    const sw = await this.interruptorCliente(trx, s.branch);
    if (!sw.encendida) return `La escritura directa está apagada para la sucursal ${s.branch}. Mientras, se captura en Kepler con estas casillas y se liga.`;
    const apagados = servidores.filter((x) => !x.configurado).map((x) => x.servidor);
    if (apagados.length) return `Faltan las conexiones a Kepler de: ${apagados.join(', ')}. Sin las 10 no se escribe en ninguna.`;
    if (sw.tope_dia != null) {
      const { rows: [hoy] } = await trx.raw(
        `/* alc:tope */ SELECT count(*)::int AS n FROM commercial.customer_onboarding_requests
          WHERE branch = ? AND id <> ? AND kepler_code IS NOT NULL AND deleted_at IS NULL
            AND coalesce(kepler_written_at, (kepler_write_result->>'intentada_el')::timestamptz)
                >= (date_trunc('day', now() AT TIME ZONE 'America/Mexico_City') AT TIME ZONE 'America/Mexico_City')`,
        [s.branch, s.id],
      );
      if (hoy.n >= sw.tope_dia) return `Hoy ya se escribieron ${hoy.n} alta(s) desde la sucursal ${s.branch}; el tope del interruptor es ${sw.tope_dia} por día.`;
    }
    return null;
  }

  /**
   * `[ALC.2.8]` `GET :id/kepler` — lo que se escribiría, la clave que seguiría y por qué no se puede
   * escribir todavía. No escribe nada. Con la escritura apagada es la guía exacta para capturarla a
   * mano en Kepler (la misma clave, las mismas casillas).
   */
  async planKepler(id: string, actor: ActorAlta, query: Record<string, unknown> = {}): Promise<PlanAltaKepler> {
    if (!UUID_RE.test(id)) throw new BadRequestException('id inválido');
    const s = await this.una(id, query);
    return this.tk.run(async (trx) => {
      const armado = await this.armarParaKepler(trx, s);
      const hallazgos = [...armado.hallazgos];
      let clave_propuesta: string | null = s.kepler?.clave ?? null;
      if (!clave_propuesta && armado.serie) {
        const { rows } = await trx.raw(
          `/* alc:serie-ods */ SELECT DISTINCT btrim(c2) AS c2 FROM kepler_ods.kdud WHERE upper(btrim(c2)) ~ ?`,
          [armado.serie.cuenta],
        );
        const r = siguienteClave(armado.serie, [...rows.map((x: { c2: string }) => x.c2), ...(await this.clavesReservadas(trx, s.id))]);
        if (r.ok) clave_propuesta = r.clave;
        else hallazgos.push({ campo: 'clave', gravedad: 'bloquea', mensaje: r.motivo });
      }
      const columnas = columnasDelPlan(planConClave(armado.plan, clave_propuesta ?? ''));
      const servidores = this.kepler.servidores();
      const { rows: sync } = await trx.raw(`/* alc:frescura */ SELECT last_push_at FROM kepler_ods._sync_status WHERE table_name = 'kdud'`);
      return {
        clave_propuesta,
        serie: armado.serie ? { tipo: armado.serie.tipo, zona: armado.serie.zona, patron: armado.serie.patron } : null,
        clave_reservada: s.kepler?.clave ?? null,
        kdud: columnas.kdud,
        kdfedir: columnas.kdfedir,
        hallazgos,
        servidores,
        bloqueo_escritura: await this.bloqueoDeEscritura(trx, s, hallazgos, servidores, actor),
        puede_escribir: actor.puedeKepler === true,
        kepler_as_of: sync[0]?.last_push_at ? new Date(sync[0].last_push_at).toISOString() : null,
      };
    });
  }

  /** Suelta la marca de «escribiendo» sin tocar nada más (el intento no llegó a Kepler). */
  private async soltarIntento(id: string): Promise<void> {
    await this.tk.run((trx) => trx.raw(
      `/* alc:soltar */ UPDATE commercial.customer_onboarding_requests SET kepler_write_started_at = NULL WHERE id = ?`, [id]));
  }

  /**
   * `[ALC.2.8]` `POST :id/kepler` — da de alta al cliente en las 10 bases de Kepler. Cinco pasos,
   * para que ningún tropiezo deje una clave escrita en Kepler que la Suite no conozca:
   *  1. se marca «escribiendo» (un doble clic o dos personas no escriben dos veces) y se revisa todo;
   *  2. la clave se calcula contra las 10 bases vivas (no escribe);
   *  3. la clave queda RESERVADA en la Suite (índice único) antes de tocar Kepler;
   *  4. se escribe, servidor por servidor (el concentrador primero);
   *  5. se guarda el resultado de cada base. Si alguna falló, el reintento usa la MISMA clave.
   */
  async escribirEnKepler(id: string, actor: ActorAlta, query: Record<string, unknown> = {}): Promise<SolicitudAlta> {
    const me = actor.userId;
    if (!me) throw new UnauthorizedException('Sin usuario en la sesión: el alta en Kepler la firma alguien.');
    if (!actor.puedeKepler) throw new ForbiddenException('Escribir en Kepler pide la llave «Dar de alta clientes en Kepler».');
    if (!UUID_RE.test(id)) throw new BadRequestException('id inválido');
    await this.una(id, query);

    // 1 · marcar y revisar
    const prep = await this.tk.run(async (trx) => {
      const s = await this.leerUna(trx, id, true);
      const { rows: [m] } = await trx.raw(
        `SELECT kepler_write_started_at > now() - make_interval(mins => ?) AS en_curso FROM commercial.customer_onboarding_requests WHERE id = ?`,
        [INTENTO_VIGENTE_MIN, id],
      );
      if (m?.en_curso) throw new ConflictException('Alguien la está escribiendo en Kepler en este momento: espera un minuto y recarga.');
      const armado = await this.armarParaKepler(trx, s);
      const bloqueo = await this.bloqueoDeEscritura(trx, s, armado.hallazgos, this.kepler.servidores(), actor);
      if (bloqueo) throw new ConflictException({ message: bloqueo, hallazgos: armado.hallazgos });
      if (!armado.serie) throw new ConflictException('Sin zona de clientes no hay serie de clave.');
      const reservadas = await this.clavesReservadas(trx, id);
      await trx.raw(
        `/* alc:escribiendo */ UPDATE commercial.customer_onboarding_requests
            SET kepler_write_started_at = now(), kepler_write_by = ?, updated_at = now(), updated_by = ? WHERE id = ?`,
        [me, me, id],
      );
      return { s, armado, serie: armado.serie, reservadas };
    });

    // 2 · la clave, contra las 10 bases vivas
    const clave = await this.kepler.reservarClave(prep.serie, prep.reservadas, prep.s.kepler?.clave ?? null)
      .catch((e: Error) => ({ ok: false as const, motivo: e.message }));
    if (!clave.ok) {
      await this.soltarIntento(id);
      throw new ConflictException(clave.motivo);
    }

    // 3 · reservada en la Suite ANTES de escribir
    try {
      await this.tk.run((trx) => trx.raw(
        `/* alc:reservar */ UPDATE commercial.customer_onboarding_requests SET kepler_code = ? WHERE id = ? AND (kepler_code IS NULL OR kepler_code = ?)`,
        [clave.clave, id, clave.clave]));
    } catch (e) {
      await this.soltarIntento(id);
      if ((e as { code?: string })?.code === '23505') throw new ConflictException(`Otra solicitud acaba de reservar la clave ${clave.clave}: vuelve a intentar.`);
      throw e;
    }

    // 4 · escribir
    let entrega: Awaited<ReturnType<KeplerClienteSinkAdapter['entregar']>>;
    try {
      entrega = await this.kepler.entregar(planConClave(prep.armado.plan, clave.clave), prep.s.folio);
    } catch (e) {
      await this.soltarIntento(id);
      throw e;
    }

    // 5 · el resultado de cada base
    const todas = entrega.servidores.every((x) => x.estado !== 'rechazada');
    const solicitud = await this.tk.run(async (trx) => {
      await trx.raw(
        `/* alc:resultado-kepler */
         UPDATE commercial.customer_onboarding_requests
            SET kepler_write_started_at = NULL,
                kepler_write_result = ?::jsonb,
                kepler_written_at = CASE WHEN ? THEN now() ELSE kepler_written_at END,
                kepler_code = CASE WHEN ? THEN NULL ELSE kepler_code END,
                updated_at = now(), updated_by = ?
          WHERE id = ?`,
        [JSON.stringify({ intentada_el: new Date().toISOString(), servidores: entrega.servidores }), todas, entrega.claveAjena, me, id],
      );
      const escritas = entrega.servidores.filter((x) => x.estado !== 'rechazada').length;
      this.logger.log(`[ALC] ${prep.s.folio} → Kepler ${clave.clave}: ${escritas}/${entrega.servidores.length} bases, por ${me}`);
      return this.leerUna(trx, id);
    });
    // La clave resultó de otro cliente en el concentrador y no se escribió nada: la reserva ya se
    // soltó (arriba); se dice, y el siguiente intento calcula otra.
    if (entrega.claveAjena) {
      throw new ConflictException(`${entrega.servidores[0]?.motivo ?? `La clave ${clave.clave} ya existe en Kepler.`} Vuelve a intentar: se tomará la siguiente.`);
    }
    return solicitud;
  }

  // ───────────────────────────── 6. cancelar ─────────────────────────────

  async cancelar(id: string, motivoRaw: unknown, query: Record<string, unknown> = {}): Promise<SolicitudAlta> {
    const me = this.tenantCtx.get()?.userId;
    if (!me) throw new UnauthorizedException('Sin usuario en la sesión.');
    if (!UUID_RE.test(id)) throw new BadRequestException('id inválido');
    const motivo = txt(motivoRaw);
    if (!motivo || motivo.length < 5) throw new BadRequestException('Escribe por qué se cancela.');
    return this.tk.run(async (trx) => {
      const s = await this.leerUna(trx, id, true);
      await this.exigirSucursal(s.branch, query);
      if (s.estado === 'ligada' || s.estado === 'cancelada') throw new ConflictException(`La solicitud ${s.folio} ya está «${s.estado}».`);
      // `[ALC.2.8]` Lo que ya está en Kepler no se cancela desde aquí: quedaría un cliente huérfano allá.
      const enKepler = s.kepler?.servidores.filter((x) => x.estado !== 'rechazada').map((x) => x.servidor) ?? [];
      if (enKepler.length) {
        throw new ConflictException(`La clave ${s.kepler?.clave} ya está en Kepler (${enKepler.join(', ')}): lígala; si no debía darse de alta, se da de baja en Kepler.`);
      }
      await trx.raw(
        `/* alc:cancelar */ UPDATE commercial.customer_onboarding_requests
            SET status = 'cancelada', comments = concat_ws(E'\\n', comments, ?::text), updated_at = now(), updated_by = ? WHERE id = ?`,
        [`Cancelada: ${motivo}`, me, id],
      );
      return this.leerUna(trx, id);
    });
  }
}
