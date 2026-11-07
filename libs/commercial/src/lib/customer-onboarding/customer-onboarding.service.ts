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
  type PosibleDuplicado,
  type RegimenFiscalOpcion,
  type RevisionAlta,
  type SolicitudAlta,
  type SolicitudAltaBody,
  type SubirConstanciaBody,
  type SubirConstanciaRespuesta,
} from '@megadulces/contracts';
import {
  bloquea, diferenciaDeCredito, estadoInicial, revisarSolicitud, type ContextoRevision, type FichaKeplerLeida,
} from './alta-clientes.rules';
import { estadoCorto, fichaDesdeConstancia, fichaVacia, recortesDe } from './ficha-kepler';
import { NewCustomersKeplerService } from '../new-customers-kepler/new-customers-kepler.service';
import { codigoKepler, normalizarClave, normalizarNombre, parecido, UMBRAL_PARECIDO } from '../new-customers-kepler/new-customers-kepler.engine';

/**
 * `[ALC.2]` Alta de clientes: la constancia del SAT → la solicitud → el crédito → la liga con Kepler.
 *
 * Plan: [`FASE_ALC_ALTA_DE_CLIENTES.md`](../../../../../docs/IMPLEMENTACION/FASES/FASE_ALC_ALTA_DE_CLIENTES.md).
 *
 * ── Qué NO hace ─────────────────────────────────────────────────────────────────────────────
 * ⛔ No escribe en Kepler (D1-a): la ficha se captura allá —la forma la arma esta pantalla en su
 * mismo orden— y la Suite la LIGA cuando la clave aparece en el ODS. La escritura de `kdud` es de
 * Edgar (D1-b). ⛔ No copia el maestro: lo lee de `kepler_ods.kdud` en cada consulta.
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
}

const num = (v: unknown, def = 0): number => { const n = Number(v); return Number.isFinite(n) ? n : def; };
const txt = (v: unknown): string | null => { const s = String(v ?? '').trim(); return s ? s : null; };
const isoFecha = (v: string | Date | null): string | null =>
  v == null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);

export interface ActorAlta { userId: string | null; roleName: string | null; puedeCredito: boolean }

@Injectable()
export class CustomerOnboardingService {
  private readonly logger = new Logger(CustomerOnboardingService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly scope: ScopeService,
    private readonly storage: ObjectStorageService,
    private readonly nuevos: NewCustomersKeplerService,
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
      const { rows: [edo] } = await trx.raw(
        `/* alc:cp-estado */ SELECT btrim(e.c3) AS estado
           FROM kepler_ods.kdfe33satcp p
           JOIN kepler_ods.kdfe33satedo e ON e.sucursal = '00' AND btrim(e.c1) = btrim(p.c2) AND btrim(e.c2) = 'MEX'
          WHERE p.sucursal = '00' AND btrim(p.c1) = ?
          LIMIT 1`,
        [cp],
      );
      const { rows } = await trx.raw(
        `/* alc:cp-dir2 */ SELECT upper(btrim(replace(d.c5, E'\\r', ''))) AS texto, count(*)::int AS fichas
           FROM kepler_ods.kdud d
          WHERE btrim(d.c27) = ? AND btrim(coalesce(d.c5, '')) <> ''
          GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 6`,
        [cp],
      );
      return {
        codigo_postal: cp,
        estado: edo?.estado ? estadoCorto(edo.estado) : null,
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
      };
    });
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
    };
  }

  /** Lo que llega del navegador, a la forma que revisan las reglas (mayúsculas, sin espacios de sobra). */
  private normalizar(raw: SolicitudAltaBody): SolicitudAltaBody {
    if (!raw || typeof raw !== 'object') throw new BadRequestException('Falta la solicitud.');
    const ficha = { ...fichaVacia() };
    for (const k of Object.keys(CASILLAS_KEPLER) as Array<keyof FichaKeplerCliente>) {
      const v = String(raw.ficha?.[k] ?? '').replace(/\s+/g, ' ').trim();
      ficha[k] = k === 'email' ? v.toLowerCase() : v.toUpperCase();
    }
    return {
      ...raw,
      branch: String(raw.branch ?? '').trim(),
      origen: raw.origen === 'constancia' ? 'constancia' : 'manual',
      tipo_persona: raw.tipo_persona === 'moral' ? 'moral' : 'fisica',
      rfc: normalizarClaveFiscal(raw.rfc),
      curp: normalizarClaveFiscal(raw.curp) || null,
      nombre_fiscal: String(raw.nombre_fiscal ?? '').replace(/\s+/g, ' ').trim().toUpperCase(),
      regimen_capital: txt(raw.regimen_capital)?.toUpperCase() ?? null,
      nombre_comercial: txt(raw.nombre_comercial)?.toUpperCase() ?? null,
      regimen_fiscal: String(raw.regimen_fiscal ?? '').trim(),
      codigo_postal_fiscal: String(raw.codigo_postal_fiscal ?? '').trim(),
      ficha: { ...ficha, rfc: ficha.rfc || normalizarClaveFiscal(raw.rfc) },
      vendedor_code: txt(raw.vendedor_code), grupo_code: txt(raw.grupo_code), zona_code: txt(raw.zona_code),
      credito_solicitado: num(raw.credito_solicitado), plazo_dias: num(raw.plazo_dias), descuento_pct: num(raw.descuento_pct),
      comentarios: txt(raw.comentarios),
      constancia_key: txt(raw.constancia_key),
      customer_id: txt(raw.customer_id),
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
    const b = this.normalizar(raw);
    if (b.branch) await this.exigirSucursal(b.branch, query);
    return this.tk.run(async (trx) => ({
      hallazgos: revisarSolicitud(b, await this.contexto(trx, b)),
      duplicados: await this.duplicados(trx, b.rfc, b.nombre_fiscal, b.branch),
      recortes: recortesDe(b.ficha),
    }));
  }

  async crear(raw: SolicitudAltaBody, query: Record<string, unknown> = {}): Promise<CrearSolicitudRespuesta> {
    const me = this.tenantCtx.get()?.userId;
    if (!me) throw new UnauthorizedException('Sin usuario en la sesión: una solicitud de alta la firma alguien.');
    const b = this.normalizar(raw);
    await this.exigirSucursal(b.branch, query);
    if (b.customer_id && !UUID_RE.test(b.customer_id)) throw new BadRequestException('customer_id inválido.');
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
      const hallazgos = revisarSolicitud(b, await this.contexto(trx, b));
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
        const { rows } = await trx.raw(
          `/* alc:crear */
           INSERT INTO commercial.customer_onboarding_requests
             (tenant_id, status, origin, branch, person_type, rfc, curp, fiscal_name, capital_regime, trade_name,
              tax_regime, fiscal_zip, kepler_sheet, seller_code, group_code, zone_code, credit_requested, term_days,
              discount_pct, comments, constancia_key, constancia_reading, constancia_issued_on, customer_id,
              created_by, updated_by)
           VALUES (public.current_tenant_id(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::date, ?, ?, ?)
           RETURNING id`,
          [
            estadoInicial(b), b.origen, b.branch, b.tipo_persona, b.rfc, b.tipo_persona === 'fisica' ? b.curp : null, b.nombre_fiscal,
            b.regimen_capital, b.nombre_comercial, b.regimen_fiscal, b.codigo_postal_fiscal, JSON.stringify(b.ficha),
            b.vendedor_code, b.grupo_code, b.zona_code, b.credito_solicitado, b.plazo_dias, b.descuento_pct, b.comentarios,
            b.constancia_key, lectura ? JSON.stringify(lectura) : null, emitida, b.customer_id, me, me,
          ].map((v) => (v === undefined ? null : v)) as Knex.RawBinding[],
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
      SELECT r.*, uc.nombre AS created_by_name, ud.nombre AS credit_decided_by_name
        FROM commercial.customer_onboarding_requests r
        LEFT JOIN public.users uc ON uc.id = r.created_by
        LEFT JOIN public.users ud ON ud.id = r.credit_decided_by`;
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
      regimen_fiscal: f.tax_regime, codigo_postal_fiscal: f.fiscal_zip, ficha: { ...fichaVacia(), ...(f.kepler_sheet ?? {}) },
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
      ligada_el: f.linked_at ? new Date(f.linked_at).toISOString() : null,
      creada_por: f.created_by, creada_por_nombre: f.created_by_name,
      creada_el: new Date(f.created_at).toISOString(),
      coincidencias_kepler: [],
      credito_decidido_por_quien_la_creo: !!f.credit_decided_by && f.credit_decided_by === f.created_by,
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
    const clave = normalizarClave(body?.erp_customer_code);
    if (!clave) throw new BadRequestException('Escribe la clave que le dio Kepler.');

    // El cliente `V-` del vendedor se liga con la regla de MCP.3.8 (misma fila, datos de Kepler).
    const previa = await this.una(id, query);
    if (previa.estado !== 'lista_para_kepler') throw new ConflictException(`La solicitud ${previa.folio} no está lista para ligar (está «${previa.estado}»).`);

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
              updated_at = now(), updated_by = ?
        WHERE id = ? AND deleted_at IS NULL`,
      [GENERICOS.has(s.rfc), s.rfc, s.nombre_fiscal, s.regimen_fiscal, s.codigo_postal_fiscal, me, customerId],
    );
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
      await trx.raw(
        `/* alc:cancelar */ UPDATE commercial.customer_onboarding_requests
            SET status = 'cancelada', comments = concat_ws(E'\\n', comments, ?::text), updated_at = now(), updated_by = ? WHERE id = ?`,
        [`Cancelada: ${motivo}`, me, id],
      );
      return this.leerUna(trx, id);
    });
  }
}
