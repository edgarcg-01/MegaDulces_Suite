import { Injectable, Logger } from '@nestjs/common';
import { Knex } from 'knex';
import { diaMxDeInstante } from '@megadulces/contracts';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';
import {
  classifyByRules, learnConceptFromHistory, pickBest, buildProvenance,
  cribarContraCatalogo, clavePar,
  type ClassifyRule, type HistoryRow, type Proposal, type ConceptPair,
} from './caja-autofill.engine';

/**
 * CG.17 — Autorrelleno de Caja General: los SELECT (ADR-070 §8).
 *
 * Este servicio SOLO consulta y le pasa las filas al motor puro
 * (`caja-autofill.engine.ts`), que es donde vive la decisión y donde está la suite unitaria.
 * Acá no hay reglas de negocio: si algo decide, está mal puesto.
 *
 * ⛔ Nada de lo que devuelve este servicio se guarda solo. Devuelve PROPUESTAS con su
 * procedencia; el humano confirma (§8.5 regla 1). Y lo que no se puede proponer sale con
 * `value: null` + `reason` — nunca un default (regla 3).
 */

export interface AutofillInput {
  tipo?: 'ingreso' | 'gasto' | 'deposito';
  sucursal?: string;
  glosa?: string;
  beneficiario?: string;
  beneficiario_rfc?: string;
  /** Cuenta del Access `Control`, si el movimiento viene de ese mundo durante el traslape. */
  legacy_cuenta?: string;
  /** `[CG.109]` El tercero de Kepler (`GG015`, `GN001`, `RUTA 22`…). Abre el Nivel 0.5. */
  entidad_code?: string;
  /**
   * `[CG.108]` `sucursal|doc_tipo|folio|cuenta` del documento de Kepler que origina el
   * movimiento. Es lo que abre el Nivel 0: con el documento se puede ir a la contabilidad de
   * Kepler y LEER la cuenta en vez de aprenderla.
   */
  origen_ref?: string;
}

export interface AutofillResult {
  concepto: Proposal<ConceptPair>;
  documento: Proposal<Record<string, unknown>>;
  /** Lo que iría a `cash_ledger.autofill`: procedencia por campo. */
  provenance: Record<string, unknown>;
  /** Qué niveles se pudieron consultar. Un nivel caído NO puede verse como "no propuso". */
  niveles: Record<string, 'consultado' | 'sin_fuente'>;
}

/** Ventana de historia del nivel `aprendido`. Más atrás, la contabilidad ya cambió de criterio. */
const HISTORY_MONTHS = 24;

/**
 * `[CG.110]` **El par de respaldo para un gasto sin documento ni regla.**
 *
 * Medido en prod 2026-10-13: 4 de los 5 gastos sin documento que un humano capturo eligieron
 * este par, y la poliza de Kepler lo postea en el 98.48 % de estos pagos. Vive como constante
 * y no suelto en el codigo para que cambiarlo sea UN lugar, con esta medicion al lado.
 *
 * ⚠️ Si manana la contabilidad decide otro, se cambia aca y se re-mide -- no se agrega un
 * segundo default en otra rama, que es como terminan dos verdades.
 */
const RESPALDO_GASTO = { cuenta: '201', concepto: '201' } as const;

@Injectable()
export class CajaAutofillService {
  private readonly log = new Logger(CajaAutofillService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  async suggest(input: AutofillInput): Promise<AutofillResult> {
    const tenantId = this.tenantCtx.requireTenantId();
    const niveles: AutofillResult['niveles'] = {};

    return this.tk.run(async (trx) => {
      // ── Nivel 1: el documento que ya existe. Se LIGA, no se teclea. ──────────────────
      let documento: Proposal<Record<string, unknown>> = {
        value: null, source: null, confidence: null, reason: 'sin_documento',
      };
      if (input.beneficiario_rfc) {
        try {
          const cfdi = await trx('fiscal.cfdis')
            .where({ tenant_id: tenantId, emisor_rfc: input.beneficiario_rfc })
            .orderBy('fecha', 'desc')
            .first('uuid', 'emisor_nombre', 'emisor_rfc', 'total', 'fecha', 'serie', 'folio');
          niveles['documento'] = 'consultado';
          if (cfdi) {
            documento = {
              value: {
                origen_tipo: 'cfdi', origen_uuid: cfdi.uuid,
                origen_ref: [cfdi.serie, cfdi.folio].filter(Boolean).join('-') || null,
                beneficiario: cfdi.emisor_nombre, beneficiario_rfc: cfdi.emisor_rfc,
                monto: Number(cfdi.total),
              },
              source: 'documento', confidence: 1, originId: cfdi.uuid,
            };
          }
        } catch (e) {
          // Una fuente caída NO es "no propuso": se declara (§8.5 regla 3 / ADR-056).
          niveles['documento'] = 'sin_fuente';
          this.log.warn(`nivel documento no consultable: ${(e as Error).message}`);
        }
      } else {
        niveles['documento'] = 'sin_fuente';
      }

      // ── Nivel 2: lo que contabilidad YA posteó para este sujeto ─────────────────────
      let aprendido: Proposal<ConceptPair> = {
        value: null, source: null, confidence: null, reason: 'sin_historia',
      };
      const sujeto = input.beneficiario_rfc || input.beneficiario;
      if (sujeto) {
        try {
          const desde = new Date();
          desde.setMonth(desde.getMonth() - HISTORY_MONTHS);
          const rows: HistoryRow[] = await trx('analytics.expense_entries')
            .where('tenant_id', tenantId)
            .whereNotNull('concepto')
            // `[CGP-L.5]` El día de México del instante; `toISOString` lo corría después de las 18:00.
            .where('fecha', '>=', diaMxDeInstante(desde))
            .where((b: any) => b
              .whereILike('beneficiario', `%${sujeto}%`)
              .orWhereILike('beneficiario_doc', `%${sujeto}%`))
            .groupBy('cuenta', 'concepto')
            .select(
              trx.raw('cuenta AS kepler_cuenta'),
              trx.raw('concepto AS kepler_concepto'),
              trx.raw('count(*)::int AS n'),
            );
          niveles['aprendido'] = 'consultado';
          aprendido = learnConceptFromHistory(rows);
        } catch (e) {
          niveles['aprendido'] = 'sin_fuente';
          this.log.warn(`nivel aprendido no consultable: ${(e as Error).message}`);
        }
      } else {
        niveles['aprendido'] = 'sin_fuente';
      }

      // ── Nivel 3: reglas explícitas, editables sin redeploy ──────────────────────────
      let porRegla: Proposal<ConceptPair> = {
        value: null, source: null, confidence: null, reason: 'sin_regla',
      };
      try {
        const rules: ClassifyRule[] = await trx('finance.caja_classify_rules')
          .where('tenant_id', tenantId)
          .select('id', 'priority', 'match_tipo', 'match_glosa', 'match_beneficiario',
            'kepler_cuenta', 'kepler_concepto', 'centro_costo', 'active', 'suppressed_at',
            'applied_count', 'corrected_count');
        niveles['regla'] = 'consultado';
        porRegla = classifyByRules(rules, {
          tipo: input.tipo, glosa: input.glosa, beneficiario: input.beneficiario,
        });
      } catch (e) {
        niveles['regla'] = 'sin_fuente';
        this.log.warn(`nivel regla no consultable: ${(e as Error).message}`);
      }

      // ── Nivel extra: el mapa HITL de la cuenta del Access, durante el traslape ──────
      let porMapa: Proposal<ConceptPair> = {
        value: null, source: null, confidence: null, reason: 'sin_historia',
      };
      if (input.legacy_cuenta) {
        const m = await trx('finance.caja_kepler_concept_map')
          .where({ tenant_id: tenantId, legacy_cuenta: input.legacy_cuenta })
          .whereNotNull('kepler_cuenta')
          .first('kepler_cuenta', 'kepler_concepto', 'support', 'support_ratio', 'confirmed_at', 'id');
        if (m) {
          porMapa = {
            value: { kepler_cuenta: m.kepler_cuenta, kepler_concepto: m.kepler_concepto },
            source: m.confirmed_at ? 'aprendido' : 'regla',
            // Un mapa CONFIRMADO por un humano vale más que uno sólo derivado.
            confidence: m.confirmed_at ? 0.95 : Number(m.support_ratio ?? 0.5),
            support: m.support ?? undefined,
            supportRatio: m.support_ratio ? Number(m.support_ratio) : undefined,
            originId: m.id,
          };
        }
      }

      // ── Nivel 0: LA CONTABILIDAD DE KEPLER PARA ESE MISMO DOCUMENTO ────────────────
      let porPoliza: Proposal<ConceptPair> = {
        value: null, source: null, confidence: null, reason: 'sin_documento',
      };
      if (input.origen_ref) {
        try {
          porPoliza = await this.porPolizaDelDocumento(trx, input.origen_ref);
          niveles['poliza'] = 'consultado';
        } catch (e) {
          niveles['poliza'] = 'sin_fuente';
          this.log.warn(`nivel poliza no consultable: ${(e as Error).message}`);
        }
      }

      // ── Nivel 0.5: la regla de la ENTIDAD ──────────────────────────────────────────
      let porEntidad: Proposal<ConceptPair> = {
        value: null, source: null, confidence: null, reason: 'sin_historia',
      };
      if (input.entidad_code) {
        try {
          porEntidad = await this.porEntidad(trx, tenantId, input.entidad_code);
          niveles['entidad'] = 'consultado';
        } catch (e) {
          niveles['entidad'] = 'sin_fuente';
          this.log.warn(`nivel entidad no consultable: ${(e as Error).message}`);
        }
      }

      // ── Nivel 4: EL RESPALDO DECLARADO. Lo que cierra el 100 %. ──────────────────────
      //
      // ⭐⭐ `[CG.110]` Edgar, 2026-10-13: *"quiero el 100%"* · *"nosotros pongamos las reglas
      // en nuestro sistema al menos"* · *"b ya"*.
      //
      // Un gasto que llega hasta acá es uno SIN documento liquidado y sin regla de entidad:
      // típicamente una caja chica o una tarjeta. Medido, esos no tienen una cuenta de gasto
      // derivable — `GG015` tocó **34 cuentas distintas** y las dominantes de las demás van del
      // 13.6 % al 74.3 % (`GG004` → "ARREGLO FREGADERO" con 18.2 %). Declarar una de ésas
      // clasificaría mal el 82 %.
      //
      // ⭐ Lo que SÍ está medido: de los 5 gastos sin documento que un humano ya capturó,
      // **4 eligieron `201 / 201 PASIVO A PROVEEDORES`** (el quinto fue `999 PRESUPUESTOS`, un
      // caso aparte). Y es el mismo par que la póliza de Kepler postea para estos pagos en el
      // **98.48 %** de los casos. No es un default inventado: es la contrapartida real del pago.
      //
      // ⚠️ Va con `confidence` BAJA y `source: 'regla'` a propósito. La pantalla rotula los
      // niveles, así que quien captura ve que esto es una regla declarada y no algo leído del
      // documento — que es toda la diferencia entre un default honesto y uno disfrazado.
      // El gasto fino se clasifica en Kepler, que es donde vive esa decisión.
      let respaldo: Proposal<ConceptPair> = {
        value: null, source: null, confidence: null, reason: 'sin_regla',
      };
      if (input.tipo === 'gasto') {
        respaldo = {
          value: { kepler_cuenta: RESPALDO_GASTO.cuenta, kepler_concepto: RESPALDO_GASTO.concepto },
          source: 'regla', confidence: 0.5,
        };
      } else {
        /**
         * ⭐⭐ `[CG.127]` **EL INGRESO NO TENÍA NINGÚN NIVEL, y por eso la cobranza de ruta
         * terminaba en «HONORARIOS CONTADOR».**
         *
         * Edgar, leyendo el libro: *"estos no son honorarios a contador"*. Tenía razón, y los dos
         * que señaló son cobranza de ruta — `CI-2026-00010` cuadra con la **ruta 26 del 10-oct**
         * ($17,267.04) y `CI-2026-00009` con la **ruta 21 del 09-oct** ($22,676.07), con **un solo
         * candidato** cada uno.
         *
         * Medido sobre los 24 ingresos del libro ($404,725):
         *
         *     102/011  CAJA GENERAL ............ 15 movs  $271,763   la caja contra SI MISMA
         *     201/201  PASIVO A PROVEEDORES .....  5 movs   $59,812   deuda con proveedor
         *     607-002  HONORARIOS CONTADOR ......  3 movs   $56,668   ← lo que Edgar vio
         *     102/037  CAJA CHICA MORELIA .......  1 mov    $16,482
         *     115/071  ABONO A CLIENTES .........  0 movs        $0   ← lo correcto
         *
         * ⛔ Y la causa no era el criterio de nadie: **la cascada entera sólo tenía respaldo para
         * `gasto`**. Un ingreso que llegaba hasta acá salía sin propuesta, y quien captura elegía
         * de una lista de 2,840 conceptos la que sonara. *No fallaba el autollenado en los
         * ingresos: no existía para ellos.*
         *
         * ⭐ La cuenta NO se cablea: la dice el **árbitro**, que es la póliza del propio Kepler
         * (ADR-040/059). Un cobro `UA0501` lleva cargo a `102` y **abono a `115`**, así que la
         * contrapartida de un ingreso de cobranza es el abono — derivado por sucursal en
         * `analytics.v_caja_contracuenta_cobro`, que cuadra en **9 de 9 plazas** (la `00` con
         * 16,700 renglones de respaldo).
         *
         * ⚠️ Confianza **0.6**, por encima del respaldo del gasto (0.5) y por debajo de cualquier
         * nivel que lea el documento: esto es cierto para *la clase* «cobranza», no para ESTE
         * movimiento. Si el ingreso trae documento, la póliza gana y este nivel ni se mira.
         */
        try {
          respaldo = await this.contracuentaDeCobro(trx, tenantId, input.sucursal);
          niveles['contracuenta'] = 'consultado';
        } catch (e) {
          // ⛔ Si el árbitro no se puede leer NO se inventa una cuenta: se declara y el ingreso
          //    cae a captura manual con su motivo, que es el comportamiento correcto.
          niveles['contracuenta'] = 'sin_fuente';
          this.log.warn(`contracuenta del cobro no consultable: ${(e as Error).message}`);
        }
      }

      // Cascada: gana el nivel de más certeza que haya producido un valor.
      // ⭐ `[CG.108]` La póliza va PRIMERA: es lo que Kepler ya contabilizó para ESE documento,
      // no una inferencia. La regla de la entidad va después: es cierta para la entidad, no
      // para el movimiento, y un movimiento atípico de una entidad regular existe.
      //
      // ⛔⛔ `[CG.118]` **PERO ANTES SE CRIBA CONTRA EL CATÁLOGO DE LA PLAZA.** Reportado por
      // Edgar con foto de la pantalla, 2026-10-13 12:55: *"El par cuenta/concepto 201/201 no
      // existe en el catálogo de Kepler para la sucursal 01"* — y el aviso salió **después de que
      // la persona ya había firmado**. Se perdió la firma y la captura.
      //
      // Medido: la cuenta `201` **no existe en 4 de las 9 sucursales** (01, 06, 07, 08). O sea
      // que `RESPALDO_GASTO`, que es una constante, sólo era válida en 5. Lo mismo vale para
      // cualquier otro nivel: `aprendido` y `porEntidad` salen de pólizas que pueden ser de OTRA
      // plaza, así que también pueden proponer un par que acá no existe.
      //
      // ⭐ El arreglo NO es "arreglar el respaldo": es que **ningún nivel pueda emitir un par que
      // el guardado va a rechazar**. La validación ya existía (`resolveConcept`) pero vivía en el
      // otro extremo del trámite, y una compuerta que se dispara después del esfuerzo no evita el
      // error: lo cobra. *Si la cuenta la decide el motor, el motor es quien tiene que mirarla.*
      const cribados = await this.cribarPorPlaza(
        trx, tenantId, input.sucursal, niveles,
        [porPoliza, porEntidad, porMapa, aprendido, porRegla, respaldo],
      );
      const concepto = pickBest<ConceptPair>(...cribados);
      const provenance = buildProvenance({ kepler_concepto: concepto, documento });

      return { concepto, documento, provenance, niveles };
    });
  }

  /**
   * ⭐⭐ `[CG.118]` **La criba: un par que la plaza no tiene no es una propuesta, es un error
   * diferido.**
   *
   * Cada candidato de la cascada se contrasta contra `analytics.v_kepler_conceptos` de SU
   * sucursal. El que no existe **no se corrige ni se sustituye**: se vacía y se queda con el
   * motivo `no_existe_en_la_plaza`, de modo que la cascada siga bajando al nivel siguiente.
   * Sustituirlo por "algo parecido" sería inventar una cuenta, que es peor que no proponer.
   *
   * ⚠️ **Una sola consulta para los seis niveles.** Preguntar par por par serían 6 viajes por
   * cada tecla del capturista; acá se arma el conjunto de pares distintos y se pregunta una vez.
   *
   * ⚠️ **Sin sucursal NO se criba, y se DECLARA** (`niveles.catalogo = 'sin_fuente'`). Dejar
   * pasar en silencio haría que la ausencia de la criba se viera igual que una criba que aprobó
   * todo — la confusión que ADR-056 prohíbe. El guardado sigue siendo la última compuerta.
   */
  /**
   * ⭐ `[CG.127]` **La contracuenta de un cobro, preguntada al árbitro.**
   *
   * ⚠️ `concepto` puede venir NULL si el nombre que usa la póliza no existe en el catálogo de esa
   * plaza. Ahí **no se propone**: media propuesta no sirve para guardar nada, y rellenar el
   * concepto «con el más parecido» inventaría una cuenta.
   *
   * ⚠️ Sin sucursal tampoco se propone. La cuenta difiere por plaza, y adivinar cuál usar sería
   * la misma falta que `[CG.118]` vino a cerrar del otro lado.
   */
  private async contracuentaDeCobro(
    trx: Knex.Transaction, tenantId: string, sucursal: string | undefined,
  ): Promise<Proposal<ConceptPair>> {
    if (!sucursal) {
      return { value: null, source: null, confidence: null, reason: 'sin_regla' };
    }
    const r = await trx('analytics.v_caja_contracuenta_cobro')
      .where({ tenant_id: tenantId, sucursal })
      .first('cuenta', 'concepto', 'renglones');
    if (!r?.cuenta || !r?.concepto) {
      return { value: null, source: null, confidence: null, reason: 'sin_historia' };
    }
    return {
      value: { kepler_cuenta: String(r.cuenta), kepler_concepto: String(r.concepto) },
      source: 'regla', confidence: 0.6,
    };
  }

  private async cribarPorPlaza(
    trx: Knex.Transaction,
    tenantId: string,
    sucursal: string | undefined,
    niveles: AutofillResult['niveles'],
    candidatos: Array<Proposal<ConceptPair>>,
  ): Promise<Array<Proposal<ConceptPair>>> {
    const conValor = candidatos.filter((p) => p?.value?.kepler_cuenta && p?.value?.kepler_concepto);
    if (!conValor.length) return candidatos;

    if (!sucursal) {
      niveles['catalogo'] = 'sin_fuente';
      this.log.warn('criba por plaza omitida: la propuesta llegó sin sucursal');
      return candidatos;
    }

    try {
      const pares = conValor.map((p) => [p.value!.kepler_cuenta, p.value!.kepler_concepto]);
      const rows = await trx('analytics.v_kepler_conceptos')
        .where({ tenant_id: tenantId, sucursal })
        .whereIn(['cuenta', 'concepto'], pares)
        .select('cuenta', 'concepto');
      niveles['catalogo'] = 'consultado';
      const vivos = new Set<string>(rows.map((r: { cuenta: string; concepto: string }) => clavePar(r.cuenta, r.concepto)));
      // La DECISIÓN vive en el motor y se prueba ahí: acá sólo se consulta. Lo que esta función
      // sabe hacer es preguntarle a la base; lo que hay que hacer con la respuesta es lógica.
      return cribarContraCatalogo<ConceptPair>(candidatos, vivos);
    } catch (e) {
      // ⛔ Si el catálogo no se puede leer, NO se criba — y se dice. Cribar contra un conjunto
      // vacío habría vaciado las seis propuestas y se vería igual que "no hubo nada que proponer".
      niveles['catalogo'] = 'sin_fuente';
      this.log.warn(`criba por plaza no consultable: ${(e as Error).message}`);
      return candidatos;
    }
  }

  /**
   * ⭐ `[CG.109]` **NIVEL 0.5: la regla de la entidad.** Cubre lo que el documento no resuelve.
   *
   * Dos fuentes, y el ORDEN importa:
   *
   *   1. **Lo DECLARADO** (`finance.caja_autofill_declarada`) — lo que la empresa decidió.
   *      Edgar: *"nosotros pongamos las reglas en nuestro sistema"*. Gana sobre lo derivado
   *      porque una decisión explícita vale más que una mayoría: si alguien ya dijo a qué cuenta
   *      va la caja chica de Morelia, un cálculo no puede contradecirlo.
   *   2. **Lo DERIVADO** (`analytics.mv_caja_autofill_entidad`) — la cuenta que las pólizas de
   *      Kepler muestran para esa entidad, con su soporte.
   *
   * ⛔ Lo derivado sólo propone si el veredicto es `unanime` o `dominante` (>= 80 %). Una
   * entidad `disperso` NO propone: medido, `GG015` (caja chica de Morelia Abastos) tocó **34
   * cuentas distintas** — proponerle una sería acertar una de treinta y cuatro. Para esas está
   * la tabla declarada, que es de dónde sale el 100 %.
   *
   * ⚠️ Y el concepto va junto: si la cuenta tiene más de uno en el catálogo, la vista deja
   * `kepler_concepto` en NULL y acá NO se propone media cuenta — media cuenta no contabiliza.
   */
  private async porEntidad(trx: any, tenantId: string, entidad: string): Promise<Proposal<ConceptPair>> {
    const d = await trx('finance.caja_autofill_declarada')
      .where({ tenant_id: tenantId, entidad_code: entidad })
      .first('kepler_cuenta', 'kepler_concepto');
    if (d?.kepler_cuenta && d?.kepler_concepto) {
      return {
        value: { kepler_cuenta: d.kepler_cuenta, kepler_concepto: d.kepler_concepto },
        source: 'regla', confidence: 0.98,
      };
    }

    const r = await trx('analytics.mv_caja_autofill_entidad')
      .where({ tenant_id: tenantId, entidad_code: entidad })
      .first('kepler_cuenta', 'kepler_concepto', 'support', 'support_ratio', 'veredicto');
    if (!r) return { value: null, source: null, confidence: null, reason: 'sin_historia' };
    if (r.veredicto === 'disperso') {
      // 'catalogo' y 'unanime' y 'dominante' proponen; 'disperso' NO. Ver la matvista.
      return {
        value: null, source: null, confidence: null, reason: 'empate',
        support: Number(r.support ?? 0), supportRatio: Number(r.support_ratio ?? 0),
      };
    }
    if (!r.kepler_cuenta || !r.kepler_concepto) {
      return { value: null, source: null, confidence: null, reason: 'empate' };
    }
    return {
      value: { kepler_cuenta: r.kepler_cuenta, kepler_concepto: r.kepler_concepto },
      source: 'aprendido',
      confidence: Number(r.support_ratio ?? 0.8),
      support: Number(r.support ?? 0),
      supportRatio: Number(r.support_ratio ?? 0),
    };
  }

  /**
   * ⭐⭐ `[CG.108]` **NIVEL 0: leer la cuenta en vez de aprenderla.**
   *
   * Edgar, 2026-10-13: *"necesito un 100% de autollenado"*. Las vías de aprendizaje no pueden
   * llegar ahí — con empate se niegan a proponer, y hacen bien. Pero hay una vía que no
   * aprende nada: **Kepler ya contabilizó ese documento**, y la cuenta está escrita.
   *
   * ── El camino, y por qué son DOS saltos y no uno ────────────────────────────────────────
   *
   * ⛔ El salto obvio —la póliza del PAGO— está **REFUTADO por su placebo**: contra los
   * movimientos que un humano ya clasificó acertó **1 de 16**. La póliza del pago dice `201`
   * (se salda el pasivo); el humano captura el **gasto** (`601-001` nómina, `511` mercancía,
   * `150-002` CCTV). *Respondía la pregunta equivocada*, y con 98.48 % de cobertura habría
   * clasificado mal quince de cada dieciséis. Se deja escrito para que nadie lo reconstruya.
   *
   * ✅ El que sirve es el de DOS saltos: el pago → (`kdxf`, el casamiento estructural D→A de
   * Kepler) → el documento que liquida → la póliza de ESE documento → su cuenta de gasto.
   * Placebo contra los mismos movimientos: **12 de 13 decididos**.
   *
   * ── Los dos frenos, y que se frenan solos ───────────────────────────────────────────────
   *
   * ⚠️ `n_dest = 1`: un pago que liquida cuatro facturas no tiene UNA cuenta de gasto.
   * ⚠️ `count(distinct cuenta) = 1`: una póliza que toca tres cuentas tampoco.
   *
   * ⭐ Lo que valida el diseño es que **los dos casos que la regla habría errado quedan fuera
   * por esos frenos**, sin que nadie los liste: `CG-2026-00007` liquida 4 documentos y
   * `CG-2026-00002` toca 3 cuentas. La regla no decide cuando no puede — que es exactamente
   * la diferencia entre autollenar y adivinar.
   *
   * ⚠️ Se excluyen `102*`/`122*` (bancos y caja) y `201`/`203`/`210-001` (los pasivos): son la
   * contrapartida del pago, no su destino. Sin ese filtro todo volvería a dar `201`.
   *
   * ⚠️ Las pólizas viven PARTIDAS en 24 tablas `kdc2YYMM` (una por mes). Se descubren del
   * catálogo y no se listan a mano: una lista fija deja de ver el mes que viene, en silencio.
   */
  private async porPolizaDelDocumento(trx: any, origenRef: string): Promise<Proposal<ConceptPair>> {
    const [sucursal, docTipo, folio] = String(origenRef).split('|');
    if (!sucursal || !docTipo || !folio) {
      return { value: null, source: null, confidence: null, reason: 'sin_documento' };
    }
    // `X-D-26` -> `26`: kdxf y las polizas guardan el numero del tipo, no la cadena.
    const tnum = docTipo.split('-')[2];
    if (!tnum) return { value: null, source: null, confidence: null, reason: 'sin_documento' };

    const tablas = await trx('information_schema.tables')
      .where('table_schema', 'kepler_ods').andWhereILike('table_name', 'kdc2%')
      .orderBy('table_name').pluck('table_name');
    if (!tablas.length) return { value: null, source: null, confidence: null, reason: 'sin_documento' };

    const union = tablas
      .map((t: string) => `select btrim(c14) suc, c17::text dt, btrim(c19) folio, btrim(c3) cuenta
         from kepler_ods.${t} where btrim(coalesce(c19,'')) <> ''`)
      .join(' union all ');

    const { rows } = await trx.raw(
      `with dest as (
         select min(f.c7::text) dt_dest, min(btrim(f.c9)) folio_dest,
                count(distinct f.c7::text || '-' || btrim(f.c9))::int n_dest
           from kepler_ods.kdxf f
          where btrim(f.c1) = ? and f.c4::text = ? and f.c5 = 1 and btrim(f.c6) = ?
       ), gl as (${union})
       select d.n_dest,
              count(distinct g.cuenta)::int n_cuenta,
              min(g.cuenta) cuenta
         from dest d
         left join gl g
           on g.suc = ? and g.dt = d.dt_dest and g.folio = d.folio_dest
          and g.cuenta not like '102%' and g.cuenta not like '122%'
          and g.cuenta not in ('201','203','210-001')
        group by d.n_dest`,
      [sucursal, tnum, folio, sucursal]);

    const r = rows?.[0];
    // ⚠️ Los tres "no" son DISTINTOS y se declaran distinto: sin documento liquidado, con
    // varios, o con la poliza repartida. Un solo motivo generico los volveria el mismo hecho.
    if (!r || !r.n_dest) return { value: null, source: null, confidence: null, reason: 'sin_documento' };
    if (Number(r.n_dest) > 1) return { value: null, source: null, confidence: null, reason: 'empate' };
    if (Number(r.n_cuenta) !== 1 || !r.cuenta) {
      return { value: null, source: null, confidence: null, reason: Number(r.n_cuenta) > 1 ? 'empate' : 'sin_documento' };
    }

    // El concepto sale del catalogo de la cuenta, y SOLO si la cuenta tiene uno solo: elegir
    // entre varios seria inventar justo donde esta vía promete no hacerlo.
    const cs = await trx('analytics.v_kepler_conceptos')
      .where('cuenta', r.cuenta).distinct('concepto').pluck('concepto');
    if (cs.length !== 1) {
      return { value: null, source: null, confidence: null, reason: cs.length ? 'empate' : 'sin_historia' };
    }

    return {
      value: { kepler_cuenta: String(r.cuenta), kepler_concepto: String(cs[0]) },
      // No es "aprendido": es lo que Kepler ya contabilizo. La procedencia tiene que decirlo.
      source: 'documento',
      confidence: 0.99,
    };
  }
}
