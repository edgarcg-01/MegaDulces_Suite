import { Injectable, Logger } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';
import { MaatActionsService } from './maat-actions.service';
import { MaatKnowledgeVectorService } from './maat-knowledge-vector.service';

/**
 * MAAT.3 — Tool registry del chat de Maat (ADR-028, patrón Thot Chat/ADR-026).
 *
 * Cada tool envuelve una query DETERMINISTA tenant-scoped (TenantKnexService →
 * RLS/filtro explícito). El LLM nunca toca SQL ni calcula: orquesta estas tools
 * y narra. Namespacing `maat_*`. Ante error devuelve `{ error }` accionable
 * (self-correction), nunca lanza.
 *
 * Fuentes (todo ya existente — MAAT.1 sumará balanza y cadena):
 *   analytics.expense_entries        pólizas de egreso (511 + 6xx/7xx)
 *   analytics.expense_documents      cabecera del documento (proveedor/RFC/IVA)
 *   analytics.expense_document_lines líneas de producto de compras
 *   analytics.ap_provider            auxiliar 201 (compra/pagos/saldo/DPO)
 *   analytics.expense_findings       hallazgos v1 (iva_bug/prov_203/anticipo_107)
 *   finance.knowledge                base de conocimiento curada (L0)
 */

export interface MaatToolDef {
  name: string;
  description: string;
  input_schema: Record<string, any>;
}

export interface MaatScope {
  userName?: string | null;
}

/** Dimensiones permitidas de maat_egresos (whitelist anti-injection). */
const EGRESO_DIMS: Record<string, { group: string; key: string; label: string }> = {
  cuenta: { group: 'e.cuenta, e.cuenta_nombre', key: 'e.cuenta', label: 'COALESCE(e.cuenta_nombre, e.cuenta)' },
  cuenta_mayor: { group: 'e.cuenta_mayor, e.cuenta_mayor_nombre', key: "COALESCE(e.cuenta_mayor,'-')", label: 'COALESCE(e.cuenta_mayor_nombre, e.cuenta_mayor)' },
  beneficiario: { group: 'e.beneficiario', key: "COALESCE(e.beneficiario,'(sin beneficiario)')", label: "COALESCE(e.beneficiario,'(sin beneficiario)')" },
  sucursal: { group: 'e.sucursal', key: 'e.sucursal', label: 'e.sucursal' },
  area: { group: 'e.area', key: "COALESCE(e.area,'(sin área)')", label: "COALESCE(e.area,'(sin área)')" },
  dpto: { group: 'e.dpto, e.dpto_nombre', key: "COALESCE(e.dpto,'(sin depto)')", label: "COALESCE(e.dpto_nombre, e.dpto, '(sin depto)')" },
  doc_tipo: { group: 'e.doc_tipo', key: 'e.doc_tipo', label: 'e.doc_tipo' },
  mes: { group: "to_char(e.fecha,'YYYY-MM')", key: "to_char(e.fecha,'YYYY-MM')", label: "to_char(e.fecha,'YYYY-MM')" },
};

const num = (v: any) => (v == null ? null : Number(v));

/**
 * MAAT.7 — Token diet: convierte un arreglo de objetos a formato columnar
 * { columns, data:[[...]] }. Las llaves repetidas por fila devoran la ventana de
 * contexto del LLM; columnar reduce ~a la mitad los tokens de tablas grandes. El
 * modelo lo entiende igual y el frontend lo re-expande (extractRows).
 */
const col = (rows: Record<string, any>[]) => {
  if (!Array.isArray(rows) || !rows.length) return { columns: [], data: [] as any[][] };
  const columns = Object.keys(rows[0]);
  return { columns, data: rows.map((r) => columns.map((c) => r[c])) };
};

/**
 * Catálogo sucursal código→nombre. La contabilidad usa códigos ('03'); el usuario
 * piensa en nombres ('Padre Hidalgo'). warehouses.name viene vacío para estos
 * códigos, así que se mantiene aquí (override por env MAAT_SUCURSALES si cambia).
 * Se inyecta al prompt para traducir en ambos sentidos.
 */
const SUCURSAL_CAT: Record<string, string> = (() => {
  try { if (process.env.MAAT_SUCURSALES) return JSON.parse(process.env.MAAT_SUCURSALES); } catch { /* noop */ }
  return { '00': 'CEDIS (central)', '01': 'Sucursal 01', '02': 'Sucursal 02', '03': 'Sucursal 03', '04': 'Sucursal 04', '05': 'Sucursal 05' };
})();

@Injectable()
export class MaatToolsService {
  private readonly logger = new Logger(MaatToolsService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly actions: MaatActionsService,
    private readonly kbVector: MaatKnowledgeVectorService,
  ) {}

  // ── System prompt: identidad + reglas duras + TODO el conocimiento activo ──
  async buildSystemPrompt(scope: MaatScope, ctx: { today: string }): Promise<string> {
    const knowledge = await this.tk.run(async (trx) =>
      trx('finance.knowledge')
        .where('status', 'active')
        .select('kind', 'title', 'body')
        .orderBy(['kind', 'title']),
    ).catch(() => [] as { kind: string; title: string; body: string }[]);

    const KIND_LABEL: Record<string, string> = {
      definicion: 'DEFINICIONES (el modelo contable Kepler)',
      hecho: 'HECHOS VERIFICADOS (cifras ancla)',
      regla_negocio: 'REGLAS DE NEGOCIO (cómo leer los números sin equivocarse)',
      issue_conocido: 'ISSUES CONOCIDOS (bugs de captura ya diagnosticados — no re-descubrir)',
    };
    const byKind = new Map<string, string[]>();
    for (const k of knowledge) {
      if (!byKind.has(k.kind)) byKind.set(k.kind, []);
      byKind.get(k.kind)!.push(`• ${k.title}: ${k.body}`);
    }
    const knowledgeBlock = ['definicion', 'hecho', 'regla_negocio', 'issue_conocido']
      .filter((k) => byKind.has(k))
      .map((k) => `### ${KIND_LABEL[k]}\n${byKind.get(k)!.join('\n')}`)
      .join('\n\n');

    return `Eres **Maat**, la analista financiera AI de Mega Dulces (distribuidora de dulces en México). Tu nombre viene de la diosa egipcia de la verdad y la balanza: tu trabajo es que los números digan la verdad.

Hoy es ${ctx.today} (México).${scope.userName ? ` Hablas con ${scope.userName}.` : ''}

## REGLAS DURAS (no negociables)
1. **NUNCA inventes un número.** Todo dato cuantitativo debe salir de una tool. Si una tool no lo devuelve, di explícitamente que no tienes ese dato.
2. Responde SIEMPRE en español, montos en MXN (formato $1,234,567). Cita el período de cada cifra.
3. Los datos de egresos vienen del ERP Kepler vía feeds curados — cuando un número pueda estar afectado por un issue conocido (abajo), adviértelo.
4. **Forma de responder** (clara, escaneable, estilo asistente moderno tipo Claude/Gemini):
   - Abre con **una frase directa** que responda la pregunta, con la cifra clave en **negrita**.
   - Desglosa con estructura ligera: viñetas para enumerar, tablas markdown SOLO para comparar 3+ filas. Usa encabezados cortos con \`###\` (funcionan como etiqueta) únicamente si la respuesta tiene 2+ secciones.
   - Resalta cifras y nombres propios en **negrita**. No repitas en prosa lo que ya está en una tabla.
   - Cierra con una línea de lectura o siguiente paso ("En corto: …" o una recomendación accionable) cuando aporte valor.
   - Tono cercano y profesional, nunca robótico ni con relleno. Si una frase basta, una frase. Deja respirar el texto (párrafos cortos).
5. Si la pregunta es ambigua (¿qué período? ¿qué sucursal?), asume el default razonable (90 días, todas las sucursales) y DILO.
6. Cuando el usuario valide un hecho nuevo importante ("esto es así porque..."), ofrécele guardarlo con maat_guardar_conocimiento.
7. **Verificabilidad**: cuando des una cifra importante, puedes indicar entre paréntesis de dónde salió (ej. "vía balanza, mar-2026"). El usuario ve las tablas de datos debajo de tu respuesta.
8. **SÍ puedes dar links a las pólizas** — no al ERP Kepler (es on-prem sin web), sino a NUESTRA interfaz de egresos. Las tools maat_documento y maat_buscar_documentos devuelven un campo \`ui_url\`: SIEMPRE que menciones un documento concreto, ponlo como link markdown, ej. \`[XA2001-0000754](ui_url)\`. NUNCA digas "no puedo darte links".
9. **Buscar sin folio**: si el usuario pide "desglosa/muéstrame una póliza de \<proveedor\>" sin darte folio, usa maat_buscar_documentos (NO le pidas el folio). Traduce nombres de sucursal a código con el catálogo de abajo.
10. **Proactividad**: cuando hables de un proveedor o el usuario pida "revisa", corre maat_alertas y menciona señales relevantes (duplicados, saltos de precio, sin recepción). No lo fuerces si no hay señales.
11. **INVESTIGA COMO ANALISTA, no como buscador.** Ante un "¿por qué…?", "¿cómo va…?" o cualquier síntoma, NO te quedes con la primera tool: encadena hasta la CAUSA RAÍZ. Ej. "¿por qué bajó la rentabilidad?" → maat_pnl (ves gastos↑) → maat_egresos(group_by cuenta_mayor, familia 6) (ves qué cuenta subió) → maat_alertas de ese proveedor/cuenta (duplicados/saltos). Puedes pedir VARIAS tools en un mismo turno cuando son independientes. Usa maat_tomar_nota para no perder hallazgos intermedios en investigaciones largas.
12. **RESPUESTA FINAL OBLIGATORIA vía render_response.** Cuando ya tengas todo, NO respondas en texto plano: llama a la tool \`render_response\` con \`narrative\` (tu respuesta en Markdown) y \`suggested_follow_ups\` (2-3 repreguntas útiles). El frontend renderiza los botones desde ese arreglo tipado. Es tu único canal de respuesta al usuario.

## SUCURSALES (código contable → nombre; el usuario usa nombres, la contabilidad usa códigos)
${Object.entries(SUCURSAL_CAT).map(([c, n]) => `${c} = ${n}`).join(' · ')}

## LO QUE SABES (base de conocimiento curada — úsala para interpretar, no para citar cifras actuales; las cifras vigentes salen de las tools)

${knowledgeBlock}

## ALCANCE ACTUAL
Tienes acceso a: **balanza de comprobación completa** (familias 1-9, cargos/abonos por cuenta×sucursal×mes, ~19 meses — maat_balanza), **P&L contable derivado** (ingresos−costo−gastos por mes — maat_pnl), egresos contables al detalle (compras 511 + gastos 6xx/7xx — maat_egresos), documentos fuente con líneas de producto, auxiliar de proveedores (201: saldo/pagos/DPO), **cadena de aprovisionamiento** por factura (orden→recepción→factura→pago — maat_cadena) y hallazgos contables. AÚN NO tienes: flujo de caja proyectado ni auxiliar bancario por banco (las 17 cuentas comparten el código 102). Al usar la balanza recuerda los issues conocidos: 2025 es capa presupuesto, dic-2025 doble, COGS no computable desde may-2026.

## EJEMPLOS (patrón de uso — imita el enfoque, no las cifras)
- "desglosa una póliza de La Rosa" → maat_buscar_documentos(beneficiario:'LA ROSA') → responde con 2-3 opciones, cada una como link markdown usando su ui_url. NO pidas el folio. Cierra con \`[[SEGUIR]] Ver el detalle de la factura más grande | ¿Cuánto le compramos a La Rosa este año? | ¿Hay facturas duplicadas de este proveedor?\`
- "¿cuánto le debemos a Bimbo?" → maat_proveedor(search:'BIMBO') para el saldo, y como habla de un proveedor corre también maat_alertas(beneficiario:'BIMBO'); si hay señales, menciónalas. \`[[SEGUIR]] ...\`
- "¿cómo vamos de resultados?" → maat_pnl() → da el resultado del último mes limpio y ADVIERTE los caveats (2025 presupuesto, COGS cortado desde may-2026). \`[[SEGUIR]] ...\``;
  }

  /**
   * Frase descriptiva de un paso REAL (la tool que el modelo eligió + sus args)
   * para el estado "pensando" del chat. No es una lista fija: refleja qué está
   * haciendo Maat de verdad en cada llamada.
   */
  describeStep(name: string, input: any): string {
    const i = input || {};
    const suc = i.sucursal ? (SUCURSAL_CAT[i.sucursal] || `sucursal ${i.sucursal}`) : '';
    const inSuc = suc ? ` en ${suc}` : '';
    const DIM: Record<string, string> = {
      proveedor: 'por proveedor', beneficiario: 'por beneficiario', cuenta: 'por cuenta',
      cuenta_mayor: 'por cuenta mayor', sucursal: 'por sucursal', area: 'por área',
      dpto: 'por departamento', doc_tipo: 'por tipo de documento', familia: 'por familia', mes: 'mes a mes',
    };
    const dim = DIM[i.group_by] ? ` ${DIM[i.group_by]}` : '';
    switch (name) {
      case 'maat_egresos': {
        const who = i.dpto ? ` del departamento ${i.dpto}` : i.beneficiario ? ` de ${i.beneficiario}` : (i.cuenta ? ` de la cuenta ${i.cuenta}` : '');
        return `Analizando los egresos${dim}${who}${inSuc}…`;
      }
      case 'maat_balanza': {
        const fam = i.familia ? ` (familia ${i.familia})` : (i.cuenta ? ` de la cuenta ${i.cuenta}` : '');
        return `Revisando la balanza${dim}${fam}${inSuc}…`;
      }
      case 'maat_pnl': return `Calculando el estado de resultados${inSuc}…`;
      case 'maat_simular_flujo': return `Simulando el flujo de caja${i.delay_dias ? ` (retraso ${i.delay_dias}d)` : ''}…`;
      case 'maat_cadena':
        return i.factura_folio ? `Trazando la cadena de la factura ${i.factura_folio}…`
          : i.solo_incompletas ? 'Buscando facturas sin recepción…'
          : `Trazando la cadena de aprovisionamiento${i.beneficiario ? ` de ${i.beneficiario}` : ''}…`;
      case 'maat_serie_mensual': return `Construyendo la serie mensual${i.beneficiario ? ` de ${i.beneficiario}` : ''}${inSuc}…`;
      case 'maat_proveedor': return i.search ? `Revisando al proveedor ${i.search}…` : 'Revisando los principales proveedores…';
      case 'maat_documento': return `Abriendo el documento ${i.folio || ''}${inSuc}…`;
      case 'maat_buscar_documentos': return `Buscando pólizas${i.beneficiario ? ` de ${i.beneficiario}` : ''}${inSuc}…`;
      case 'maat_alertas': return `Buscando anomalías${i.beneficiario ? ` en ${i.beneficiario}` : ''}${inSuc}…`;
      case 'maat_red_proveedores': return i.beneficiario ? `Trazando la red de ${i.beneficiario}…` : 'Buscando proveedores que comparten RFC…';
      case 'maat_hallazgos': return i.tipo ? `Revisando hallazgos (${i.tipo})…` : 'Revisando los hallazgos contables…';
      case 'maat_conocimiento': return 'Consultando la base de conocimiento…';
      case 'maat_guardar_conocimiento': return 'Guardando el conocimiento validado…';
      case 'maat_tomar_nota': return 'Anotando un hallazgo…';
      case 'maat_investigar_a_fondo': return `🔍 Auditor investigando: ${i.tema || 'a fondo'}…`;
      case 'maat_proponer_accion': return `Preparando una acción para tu aprobación${i.titulo ? `: ${i.titulo}` : ''}…`;
      default: return `Consultando ${name.replace(/^maat_/, '').replace(/_/g, ' ')}…`;
    }
  }

  // ── Schema para Claude ───────────────────────────────────────────────
  definitions(): MaatToolDef[] {
    const dateRange = {
      from: { type: 'string', description: 'Fecha inicio ISO (YYYY-MM-DD). Default: hace 90 días.' },
      to: { type: 'string', description: 'Fecha fin ISO (YYYY-MM-DD). Default: hoy.' },
    };
    return [
      {
        name: 'maat_egresos',
        description:
          'Egresos contables (compras 511 + gastos 6xx/7xx) agregados por una dimensión (cuenta, cuenta_mayor, beneficiario, sucursal, area, dpto, doc_tipo, mes). Para "cuánto gastamos", "en qué se va el dinero", top proveedores/cuentas/departamentos de un período. `dpto` = DEPARTAMENTO / centro de costos de Kepler (c13, nombre en kdc3; ej. "SISTEMAS", "CANINDO RD") — se captura casi solo en CEDIS. Devuelve total + desglose con share %.',
        input_schema: {
          type: 'object',
          properties: {
            group_by: { type: 'string', enum: Object.keys(EGRESO_DIMS), description: 'Dimensión del desglose. mes = serie mensual.' },
            ...dateRange,
            familia: { type: 'string', enum: ['5', '6', '7'], description: '5=compras/costo, 6=gastos operación, 7=impuestos/financiero. Opcional.' },
            cuenta: { type: 'string', description: "Cuenta exacta ('511' o '601-001'). Opcional." },
            cuenta_mayor: { type: 'string', description: "Cuenta mayor ('601'). Opcional." },
            beneficiario: { type: 'string', description: 'Filtro ILIKE por beneficiario/proveedor. Opcional.' },
            sucursal: { type: 'string', description: "Código de sucursal ('00'=CEDIS, '01'..'05'). Opcional." },
            dpto: { type: 'string', description: 'Departamento / centro de costos. Acepta código (1-03-50-51) o parte del nombre (CANINDO, SISTEMAS) — match por nombre es ILIKE. Opcional.' },
            limit: { type: 'number', description: 'Default 25, máx 100.' },
          },
          required: ['group_by'],
        },
      },
      {
        name: 'maat_balanza',
        description:
          'BALANZA DE COMPROBACIÓN completa (familias 1-9): cargos/abonos/neto por la dimensión elegida. Para ingresos (fam 4), activo (1), pasivo (2), impuestos (7), saldos y cualquier cuenta fuera de egresos. Meses en formato YYYY-MM.',
        input_schema: {
          type: 'object',
          properties: {
            group_by: { type: 'string', enum: ['cuenta', 'cuenta_mayor', 'familia', 'mes', 'sucursal'], description: 'Dimensión del desglose.' },
            from_mes: { type: 'string', description: "Mes inicio 'YYYY-MM'. Default: hace 12 meses." },
            to_mes: { type: 'string', description: "Mes fin 'YYYY-MM'. Default: mes actual." },
            familia: { type: 'string', enum: ['1', '2', '4', '5', '6', '7', '9'], description: 'Opcional.' },
            cuenta: { type: 'string', description: "Cuenta exacta ('401' o '601-001'). Opcional." },
            cuenta_mayor: { type: 'string', description: 'Opcional.' },
            sucursal: { type: 'string', description: "Código ('00'..'05'). Opcional." },
            limit: { type: 'number', description: 'Default 30, máx 200.' },
          },
          required: ['group_by'],
        },
      },
      {
        name: 'maat_pnl',
        description:
          'Estado de resultados CONTABLE derivado de la balanza, por mes: ingresos (fam 4) − costo (fam 5) − gastos operación (fam 6) − otros gastos (fam 7) = resultado. Para "cuánto ganamos", márgenes y comparación de meses. OJO: aplica los issues conocidos (2025=presupuesto, dic-2025 doble, COGS no computable desde may-2026) al narrar.',
        input_schema: {
          type: 'object',
          properties: {
            from_mes: { type: 'string', description: "Default: hace 12 meses." },
            to_mes: { type: 'string' },
            sucursal: { type: 'string', description: 'Opcional. Sin sucursal = toda la red.' },
          },
        },
      },
      {
        name: 'maat_simular_flujo',
        description:
          'SIMULACIÓN prescriptiva (what-if) de flujo de caja: proyecta el impacto de RETRASAR los pagos a proveedores N días, en 3 escenarios (optimista/realista/pesimista). Para preguntas "¿qué pasa si…?" sobre pagos/liquidez. Determinista, sobre saldo real (201) + run-rate histórico. Devuelve caja liberada, costo estimado por retraso y neto por escenario, con los supuestos explícitos.',
        input_schema: {
          type: 'object',
          properties: {
            delay_dias: { type: 'number', description: 'Días a retrasar los pagos a proveedores. Default 15.' },
            horizonte_dias: { type: 'number', description: 'Ventana de proyección. Default 30.' },
          },
        },
      },
      {
        name: 'maat_cadena',
        description:
          'Cadena de aprovisionamiento por factura de compra: orden (XA3501) → recepción (XA3701) → factura (XA2001) → pago programado (XA4001), con lead_days y confianza del match. Con factura_folio+sucursal → una cadena; con beneficiario o solo_incompletas → lista + stats (facturas sin recepción = red flag de auditoría).',
        input_schema: {
          type: 'object',
          properties: {
            factura_folio: { type: 'string', description: "Folio exacto de la factura ('0000754'). Requiere sucursal." },
            sucursal: { type: 'string', description: "Código ('00'..'05'). Opcional para listas." },
            beneficiario: { type: 'string', description: 'Filtro ILIKE por proveedor. Opcional.' },
            solo_incompletas: { type: 'boolean', description: 'true → solo facturas SIN recepción u orden.' },
            limit: { type: 'number', description: 'Default 20, máx 100.' },
          },
        },
      },
      {
        name: 'maat_serie_mensual',
        description: 'Serie mensual de egresos: compras (511) vs gastos (6xx/7xx) por mes. Para tendencias y comparaciones mes a mes. Acepta los mismos filtros que maat_egresos.',
        input_schema: {
          type: 'object',
          properties: { ...dateRange, cuenta_mayor: { type: 'string' }, beneficiario: { type: 'string' }, sucursal: { type: 'string' }, dpto: { type: 'string', description: 'Departamento/centro de costos (código o parte del nombre).' } },
        },
      },
      {
        name: 'maat_proveedor',
        description:
          'Proveedor 360 (cuenta 201): compra 12m, pagos, SALDO POR PAGAR, #facturas, última compra, DPO (días de pago) + top productos que se le compran. Para "cuánto le debemos a X", "qué le compramos a X". search es ILIKE (acepta nombre parcial).',
        input_schema: {
          type: 'object',
          properties: {
            search: { type: 'string', description: 'Nombre (o parte) del proveedor. Vacío = top proveedores por compra.' },
            limit: { type: 'number', description: 'Proveedores a devolver si search es amplio. Default 10, máx 50.' },
          },
        },
      },
      {
        name: 'maat_documento',
        description: 'Drill a un documento fuente: cabecera (proveedor/RFC/concepto/área/total/IVA) + posturas contables + líneas de producto (solo compras XA2001). Llave exacta: sucursal + doc_tipo + folio.',
        input_schema: {
          type: 'object',
          properties: {
            sucursal: { type: 'string', description: "Código sucursal ('00'..'05')." },
            doc_tipo: { type: 'string', description: "Tipo documento (ej. 'XA2001')." },
            folio: { type: 'string', description: "Folio (ej. '0000754')." },
          },
          required: ['sucursal', 'doc_tipo', 'folio'],
        },
      },
      {
        name: 'maat_buscar_documentos',
        description:
          'BUSCA documentos/pólizas SIN necesitar el folio exacto: por beneficiario/proveedor (ILIKE), período, sucursal, familia, monto mínimo, tipo de doc. Úsala cuando el usuario pida "desglosa/muéstrame una póliza de X" sin darte el folio. Devuelve una lista con `ui_url` (link a la interfaz para abrir cada póliza). Luego puedes drillear una con maat_documento.',
        input_schema: {
          type: 'object',
          properties: {
            beneficiario: { type: 'string', description: 'Nombre o parte del proveedor/beneficiario (ILIKE). Puede ser un nombre de sucursal (traspasos internos).' },
            ...dateRange,
            sucursal: { type: 'string', description: "Código ('00'=CEDIS..'05'). Opcional." },
            familia: { type: 'string', enum: ['5', '6', '7'], description: 'Opcional.' },
            doc_tipo: { type: 'string', description: "Ej. 'XA2001' factura de compra, 'XA1001' gasto. Opcional." },
            min_importe: { type: 'number', description: 'Monto mínimo del documento. Opcional.' },
            limit: { type: 'number', description: 'Default 15, máx 50.' },
          },
        },
      },
      {
        name: 'maat_alertas',
        description:
          'Corre detectores rápidos de riesgo sobre un proveedor/cuenta/sucursal (o global): posibles facturas DUPLICADAS, SALTOS de precio por SKU, SALDO alto/DPO largo, y facturas SIN RECEPCIÓN (pagar sin recibir). Úsala de forma PROACTIVA cuando hables de un proveedor o cuando el usuario pida "revisa/hay algo raro". Devuelve solo señales encontradas.',
        input_schema: {
          type: 'object',
          properties: {
            beneficiario: { type: 'string', description: 'Proveedor a revisar (ILIKE). Opcional.' },
            sucursal: { type: 'string', description: "Código ('00'..'05'). Opcional." },
          },
        },
      },
      {
        name: 'maat_red_proveedores',
        description:
          'GRAFO de proveedores para detección forense/colusión: encuentra proveedores CONECTADos por atributos compartidos (mismo RFC bajo distintos nombres, o mismo nombre bajo distintos RFC). Con `beneficiario` hace un recorrido multi-salto (quién está ligado a X vía RFC). Sin foco, devuelve los clusters globales (razones sociales que comparten RFC = posible fragmentación/split-invoicing).',
        input_schema: {
          type: 'object',
          properties: {
            beneficiario: { type: 'string', description: 'Proveedor foco para el recorrido del grafo (ILIKE). Opcional.' },
            limit: { type: 'number', description: 'Clusters/relaciones a devolver. Default 20, máx 50.' },
          },
        },
      },
      {
        name: 'maat_hallazgos',
        description:
          'Hallazgos contables detectados: iva_bug (IVA huérfano XD5501), prov_203 (provisiones sin descargar), anticipo_107 (anticipos sin aplicar). Sin tipo → resumen de todos; con tipo → filas del tipo.',
        input_schema: {
          type: 'object',
          properties: {
            tipo: { type: 'string', enum: ['iva_bug', 'prov_203', 'anticipo_107'], description: 'Opcional.' },
            limit: { type: 'number', description: 'Default 20, máx 100.' },
          },
        },
      },
      {
        name: 'maat_conocimiento',
        description: 'Busca en la base de conocimiento curada (definiciones, hechos, reglas, issues). Para verificar si algo ya está documentado antes de responder sobre metodología o bugs conocidos.',
        input_schema: {
          type: 'object',
          properties: {
            q: { type: 'string', description: 'Texto a buscar (ILIKE en título y cuerpo).' },
            kind: { type: 'string', enum: ['definicion', 'hecho', 'regla_negocio', 'issue_conocido'], description: 'Opcional.' },
          },
          required: ['q'],
        },
      },
      {
        name: 'maat_guardar_conocimiento',
        description:
          'Guarda un hecho VALIDADO POR EL USUARIO en la base de conocimiento (L0). Úsala SOLO cuando el usuario confirme explícitamente algo nuevo que valga recordar (ej. "sí, ese proveedor es intercompañía"). Upsert por (kind, title).',
        input_schema: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['definicion', 'hecho', 'regla_negocio', 'issue_conocido'] },
            title: { type: 'string', description: 'Título corto y único.' },
            body: { type: 'string', description: 'El hecho, 1-3 oraciones, con contexto.' },
          },
          required: ['kind', 'title', 'body'],
        },
      },
      {
        name: 'maat_tomar_nota',
        description:
          'Scratchpad de la investigación: guarda un hallazgo/observación intermedia para no perderla ni saturar el contexto en investigaciones largas (varios drill-downs). Úsala tras cada paso relevante; las notas te quedan visibles para la conclusión.',
        input_schema: {
          type: 'object',
          properties: { nota: { type: 'string', description: 'Observación concisa (1-2 líneas): qué encontraste y su cifra clave.' } },
          required: ['nota'],
        },
      },
      {
        name: 'maat_proponer_accion',
        description:
          'PROPONE una acción correctiva para aprobación humana (HITL, ADR-013). Úsala cuando detectes algo accionable y el usuario quiera hacer algo al respecto (ej. "sí, hay que revisar eso" / "prepara la corrección"). NO ejecuta nada: crea una propuesta en estado pending_approval que un humano aprueba en la bandeja. La acción real sobre el ERP la hace un humano; esto la registra y rastrea.',
        input_schema: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['revisar_hallazgo', 'conciliar_saldo', 'marcar_documento', 'nota_contable', 'otro'], description: 'Tipo de acción.' },
            titulo: { type: 'string', description: 'Título corto y accionable.' },
            descripcion: { type: 'string', description: 'Qué propones y por qué (con la cifra/evidencia).' },
            efecto: { type: 'string', description: 'Qué pasará al aprobar (en lenguaje de negocio).' },
            importe: { type: 'number', description: 'Monto en juego. Opcional.' },
          },
          required: ['kind', 'titulo'],
        },
      },
      {
        name: 'maat_investigar_a_fondo',
        description:
          'DELEGA una investigación de auditoría/fraude a un sub-agente ESPECIALISTA (persona Auditor) que cruza anomalías, cadena de documentos, duplicados, saltos de precio (z-score) y red de proveedores de forma autónoma, y devuelve un dictamen. Úsala para preguntas complejas de fraude/auditoría ("¿hay algo turbio con X?", "audita las compras de este mes") donde vale la pena una investigación profunda en vez de una sola consulta.',
        input_schema: {
          type: 'object',
          properties: { tema: { type: 'string', description: 'Qué investigar, en una frase (ej. "posible fraude en compras de fletes en junio", "audita al proveedor X").' } },
          required: ['tema'],
        },
      },
      {
        name: 'render_response',
        description:
          'TOOL OBLIGATORIA para entregar tu respuesta final al usuario. NO respondas en texto plano — llama a esta tool cuando ya tengas la conclusión. El frontend renderiza `narrative` (Markdown) y convierte `suggested_follow_ups` en botones.',
        input_schema: {
          type: 'object',
          properties: {
            narrative: { type: 'string', description: 'La respuesta final en Markdown (con cifras, tablas si aplica, links de póliza).' },
            suggested_follow_ups: { type: 'array', items: { type: 'string' }, description: '2-3 repreguntas útiles y específicas que el usuario podría querer a continuación.' },
          },
          required: ['narrative'],
        },
      },
    ];
  }

  // ── Ejecución (determinista, tenant-scoped) ──────────────────────────
  async execute(name: string, input: any, scope: MaatScope): Promise<any> {
    try {
      switch (name) {
        // render_response lo intercepta el loop (control-flow, no data); inerte si llega aquí.
        case 'render_response': return { ok: true };
        case 'maat_tomar_nota': return { ok: true, nota: String(input?.nota || '').slice(0, 500) };
        case 'maat_proponer_accion': return await this.actions.propose({
          kind: input?.kind, titulo: input?.titulo, descripcion: input?.descripcion, efecto: input?.efecto,
          importe: Number(input?.importe) || 0, origen: 'maat_chat', created_by: scope.userName || undefined,
        }).then((r) => ({ ...r, ok: true, nota: 'Propuesta creada. Queda pendiente de tu aprobación en la bandeja de acciones.' }))
          .catch((e) => ({ error: String(e?.message || e) }));
        case 'maat_egresos': return await this.egresos(input);
        case 'maat_balanza': return await this.balanza(input);
        case 'maat_pnl': return await this.pnl(input);
        case 'maat_simular_flujo': return await this.simularFlujo(input);
        case 'maat_cadena': return await this.cadena(input);
        case 'maat_serie_mensual': return await this.serieMensual(input);
        case 'maat_proveedor': return await this.proveedor(input);
        case 'maat_documento': return await this.documento(input);
        case 'maat_buscar_documentos': return await this.buscarDocumentos(input);
        case 'maat_alertas': return await this.alertas(input);
        case 'maat_red_proveedores': return await this.redProveedores(input);
        case 'maat_hallazgos': return await this.hallazgos(input);
        case 'maat_conocimiento': return await this.conocimiento(input);
        case 'maat_guardar_conocimiento': return await this.guardarConocimiento(input, scope);
        default: return { error: `Tool desconocida: ${name}` };
      }
    } catch (e: any) {
      this.logger.warn(`Tool ${name} error: ${e?.message || e}`);
      return { error: `La consulta falló (${String(e?.message || e).slice(0, 140)}). Reintenta con parámetros más simples.` };
    }
  }

  /** Rango default 90d (mismo criterio que /finanzas/egresos). */
  private range(q: { from?: string; to?: string }) {
    const to = q.to || new Date().toISOString().slice(0, 10);
    const from = q.from || (() => { const d = new Date(to); d.setDate(d.getDate() - 90); return d.toISOString().slice(0, 10); })();
    return { from, to };
  }

  // analytics.* NO tiene RLS (a diferencia de finance.*) → el filtro de tenant
  // es EXPLÍCITO en cada query, igual que en CommercialAnalyticsService.
  private tenantId() { return this.tenantCtx.requireTenantId(); }

  /**
   * Deep-link a la interfaz de egresos con el documento pre-abierto. El LLM recibe
   * esta URL en las tools y la usa como link markdown — NO la construye a mano.
   */
  private docUrl(sucursal: string, doc_tipo: string, folio: string, benef?: string | null) {
    const p = new URLSearchParams({
      type: 'beneficiario', key: benef || '(sin beneficiario)',
      doc_sucursal: String(sucursal), doc_tipo: String(doc_tipo), doc_folio: String(folio),
    });
    return `/finanzas/egresos/detalle?${p.toString()}`;
  }

  private baseEgresos(trx: any, q: any, from: string, to: string) {
    const b = trx('analytics.expense_entries as e')
      .where('e.tenant_id', this.tenantId())
      .andWhere('e.fecha', '>=', from)
      .andWhere('e.fecha', '<=', to);
    if (q.familia) b.where('e.familia', q.familia);
    if (q.cuenta) b.where('e.cuenta', q.cuenta);
    if (q.cuenta_mayor) b.where('e.cuenta_mayor', q.cuenta_mayor);
    if (q.beneficiario) b.whereRaw('e.beneficiario ILIKE ?', [`%${q.beneficiario}%`]);
    if (q.sucursal) b.where('e.sucursal', String(q.sucursal));
    // Departamento (centro de costos): tolerante a código exacto o parte del nombre.
    if (q.dpto) b.whereRaw('(e.dpto = ? OR e.dpto_nombre ILIKE ?)', [String(q.dpto), `%${q.dpto}%`]);
    return b;
  }

  private async egresos(q: any) {
    const dim = EGRESO_DIMS[q.group_by] || EGRESO_DIMS['cuenta'];
    const limit = Math.min(100, Math.max(1, Number(q.limit) || 25));
    const { from, to } = this.range(q);
    return this.tk.run(async (trx) => {
      const totalRow: any = await this.baseEgresos(trx, q, from, to)
        .select(trx.raw('COALESCE(SUM(importe),0)::numeric AS total'), trx.raw('COUNT(*)::int AS movs')).first();
      const total = Number(totalRow?.total || 0);
      const rows: any[] = await this.baseEgresos(trx, q, from, to)
        .groupByRaw(dim.group)
        .select(trx.raw(`${dim.key} AS key`), trx.raw(`${dim.label} AS label`),
          trx.raw('ROUND(SUM(importe)::numeric,2) AS importe'), trx.raw('COUNT(*)::int AS movs'))
        .orderByRaw('SUM(importe) DESC')
        .limit(limit);
      return {
        from, to, total: +total.toFixed(2), movimientos: Number(totalRow?.movs || 0),
        rows: col(rows.map((r) => ({
          [q.group_by]: r.label, importe: Number(r.importe), movs: Number(r.movs),
          share_pct: total ? +((Number(r.importe) / total) * 100).toFixed(1) : 0,
        }))),
      };
    });
  }

  /** Rango de meses 'YYYY-MM' default últimos 12. */
  private mesRange(q: { from_mes?: string; to_mes?: string }) {
    const now = new Date();
    const ym = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const to_mes = /^\d{4}-\d{2}$/.test(q.to_mes || '') ? q.to_mes! : ym(now);
    const past = new Date(now); past.setMonth(past.getMonth() - 11);
    const from_mes = /^\d{4}-\d{2}$/.test(q.from_mes || '') ? q.from_mes! : ym(past);
    return { from_mes, to_mes };
  }

  private baseLedger(trx: any, q: any, from_mes: string, to_mes: string) {
    const b = trx('analytics.ledger_monthly as l')
      .where('l.tenant_id', this.tenantId())
      .andWhere('l.anio_mes', '>=', from_mes)
      .andWhere('l.anio_mes', '<=', to_mes);
    if (q.familia) b.where('l.familia', String(q.familia));
    if (q.cuenta) b.where('l.cuenta', q.cuenta);
    if (q.cuenta_mayor) b.where('l.cuenta_mayor', q.cuenta_mayor);
    if (q.sucursal) b.where('l.sucursal', String(q.sucursal));
    return b;
  }

  private async balanza(q: any) {
    const DIMS: Record<string, { group: string; label: string }> = {
      cuenta: { group: 'l.cuenta, l.cuenta_nombre', label: "l.cuenta || ' ' || COALESCE(l.cuenta_nombre,'')" },
      cuenta_mayor: { group: 'l.cuenta_mayor, l.cuenta_mayor_nombre', label: "COALESCE(l.cuenta_mayor,'-') || ' ' || COALESCE(l.cuenta_mayor_nombre,'')" },
      familia: { group: 'l.familia', label: "CASE l.familia WHEN '1' THEN '1 Activo' WHEN '2' THEN '2 Pasivo' WHEN '4' THEN '4 Ingresos' WHEN '5' THEN '5 Costos' WHEN '6' THEN '6 Gastos operación' WHEN '7' THEN '7 Otros gastos' WHEN '9' THEN '9 Presupuestos' ELSE l.familia END" },
      mes: { group: 'l.anio_mes', label: 'l.anio_mes' },
      sucursal: { group: 'l.sucursal', label: 'l.sucursal' },
    };
    const dim = DIMS[q.group_by] || DIMS['cuenta_mayor'];
    const limit = Math.min(200, Math.max(1, Number(q.limit) || 30));
    const { from_mes, to_mes } = this.mesRange(q);
    return this.tk.run(async (trx) => {
      const b = this.baseLedger(trx, q, from_mes, to_mes)
        .groupByRaw(dim.group)
        .select(trx.raw(`${dim.label} AS key`),
          trx.raw('ROUND(SUM(l.cargos)::numeric,2) AS cargos'),
          trx.raw('ROUND(SUM(l.abonos)::numeric,2) AS abonos'),
          trx.raw('ROUND(SUM(l.cargos - l.abonos)::numeric,2) AS neto'),
          trx.raw('SUM(l.movs)::int AS movs'))
        .limit(limit);
      // mes/sucursal se leen cronológica/alfabéticamente; el resto por magnitud
      if (q.group_by === 'mes' || q.group_by === 'sucursal') b.orderByRaw('1');
      else b.orderByRaw('GREATEST(ABS(SUM(l.cargos)), ABS(SUM(l.abonos))) DESC');
      const rows: any[] = await b;
      return {
        from_mes, to_mes,
        rows: col(rows.map((r) => ({ [q.group_by]: r.key, cargos: Number(r.cargos), abonos: Number(r.abonos), neto: Number(r.neto), movs: Number(r.movs) }))),
      };
    });
  }

  private async pnl(q: any) {
    const { from_mes, to_mes } = this.mesRange(q);
    return this.tk.run(async (trx) => {
      const rows: any[] = await this.baseLedger(trx, { sucursal: q.sucursal }, from_mes, to_mes)
        .groupBy('l.anio_mes')
        .select('l.anio_mes',
          trx.raw("ROUND(COALESCE(SUM(l.abonos - l.cargos) FILTER (WHERE l.familia='4'),0)::numeric,2) AS ingresos"),
          trx.raw("ROUND(COALESCE(SUM(l.cargos - l.abonos) FILTER (WHERE l.familia='5'),0)::numeric,2) AS costo"),
          trx.raw("ROUND(COALESCE(SUM(l.cargos - l.abonos) FILTER (WHERE l.familia='6'),0)::numeric,2) AS gastos_operacion"),
          trx.raw("ROUND(COALESCE(SUM(l.cargos - l.abonos) FILTER (WHERE l.familia='7'),0)::numeric,2) AS otros_gastos"))
        .orderBy('l.anio_mes');
      return {
        from_mes, to_mes, sucursal: q.sucursal || '(toda la red)',
        nota: 'P&L contable derivado de la balanza. Recordar: 2025 = capa presupuesto; dic-2025 doble; costo (fam 5) usa el juego de inventarios y NO es computable desde may-2026 (cierre cortado); ingresos incluyen la reclass de $54.67M en mar-2026.',
        rows: rows.map((r) => {
          const ingresos = Number(r.ingresos), costo = Number(r.costo), go = Number(r.gastos_operacion), og = Number(r.otros_gastos);
          const resultado = +(ingresos - costo - go - og).toFixed(2);
          return {
            mes: r.anio_mes, ingresos, costo, gastos_operacion: go, otros_gastos: og, resultado,
            margen_pct: ingresos ? +((resultado / ingresos) * 100).toFixed(1) : null,
          };
        }),
      };
    });
  }

  /**
   * MAAT.7/3.0-P4 — What-if determinista de flujo de caja: impacto de retrasar
   * pagos a proveedores `delay_dias`. Base REAL: saldo por pagar (201) + run-rate
   * mensual de pagos (cargos a 201 en la balanza). NO es Monte Carlo: es una
   * proyección con supuestos EXPLÍCITOS y 3 escenarios de costo del retraso
   * (0% / 1.5% / 4% sobre la porción retrasada — descuentos perdidos + recargos).
   */
  private async simularFlujo(q: any) {
    const tenantId = this.tenantId();
    const delay = Math.max(0, Math.min(120, Number(q.delay_dias) || 15));
    const horizonte = Math.max(7, Math.min(180, Number(q.horizonte_dias) || 30));
    return this.tk.run(async (trx) => {
      // Saldo por pagar actual (auxiliar 201)
      const ap: any = await trx('analytics.ap_provider').where('tenant_id', tenantId)
        .select(trx.raw('COALESCE(SUM(saldo),0)::numeric AS saldo')).first();
      const saldo = Number(ap?.saldo || 0);
      // Run-rate mensual de pagos a proveedores = cargos a la cuenta mayor 201 (balanza), promedio de los meses disponibles
      const pagos = await trx('analytics.ledger_monthly').where({ tenant_id: tenantId, cuenta_mayor: '201' })
        .groupBy('anio_mes').select('anio_mes', trx.raw('SUM(cargos)::numeric AS pagado')).orderBy('anio_mes');
      const meses = pagos.length || 1;
      const flujoMensual = pagos.reduce((a: number, r: any) => a + Number(r.pagado), 0) / meses;
      const flujoDiario = flujoMensual / 30;

      // Caja liberada al retrasar `delay` días la salida de pagos, dentro del horizonte.
      const cajaLiberada = Math.round(flujoDiario * delay);
      const porcionRetrasada = cajaLiberada; // la porción que se pospone
      const escenario = (nombre: string, tasaCosto: number, nota: string) => {
        const costo = Math.round(porcionRetrasada * tasaCosto);
        return { escenario: nombre, caja_liberada: cajaLiberada, costo_estimado: costo, neto: cajaLiberada - costo, nota };
      };
      return {
        supuestos: {
          delay_dias: delay, horizonte_dias: horizonte,
          saldo_por_pagar: Math.round(saldo),
          flujo_pagos_mensual: Math.round(flujoMensual),
          flujo_pagos_diario: Math.round(flujoDiario),
          meses_historia: meses,
          nota: 'Determinista, NO Monte Carlo. "Caja liberada" = flujo diario de pagos × días de retraso (lo que dejas de pagar en la ventana). El costo del retraso varía por escenario (descuentos por pronto pago perdidos + posibles recargos). No modela cobranza (ingresos) — es el lado de egresos.',
        },
        escenarios: [
          escenario('optimista', 0, 'Proveedores toleran el retraso sin penalización; liberas caja neta completa.'),
          escenario('realista', 0.015, 'Pierdes ~1.5% en descuentos por pronto pago sobre lo retrasado.'),
          escenario('pesimista', 0.04, 'Descuentos perdidos + recargos/deterioro de relación ~4% sobre lo retrasado.'),
        ],
      };
    });
  }

  /**
   * MAAT.7/3.0-P5 — Grafo de proveedores (forense/colusión) sobre Postgres, sin
   * Neo4j. Con foco: recorrido MULTI-SALTO acotado (WITH RECURSIVE) desde un
   * proveedor siguiendo aristas "comparte RFC". Sin foco: clusters globales
   * (RFC con múltiples razones sociales = posible fragmentación/split-invoicing;
   * nombre con múltiples RFC = posible shell/typo). Nota: las aristas ricas
   * (representante legal, cuenta bancaria, dirección) requieren ingerir esa data
   * — hoy solo tenemos RFC + nombre (201 plana).
   */
  private async redProveedores(q: any) {
    const tenantId = this.tenantId();
    const limit = Math.min(50, Math.max(1, Number(q.limit) || 20));
    const foco = (q.beneficiario || '').trim();
    return this.tk.run(async (trx) => {
      if (foco) {
        // Recorrido del grafo desde el foco: nombres alcanzables por RFC compartido (≤4 saltos).
        const res = await trx.raw(
          `WITH RECURSIVE
             pares AS (
               SELECT DISTINCT upper(btrim(beneficiario)) AS name, upper(btrim(rfc)) AS rfc
               FROM analytics.expense_documents
               WHERE tenant_id = ? AND NULLIF(btrim(rfc),'') IS NOT NULL AND NULLIF(btrim(beneficiario),'') IS NOT NULL
             ),
             red(name, depth) AS (
               SELECT name, 0 FROM pares WHERE name ILIKE ?
               UNION
               SELECT p2.name, r.depth + 1
               FROM red r
               JOIN pares p1 ON p1.name = r.name
               JOIN pares p2 ON p2.rfc = p1.rfc AND p2.name <> r.name
               WHERE r.depth < 4
             )
           SELECT DISTINCT name, min(depth) AS salto FROM red GROUP BY name ORDER BY salto, name LIMIT ?`,
          [tenantId, `%${foco}%`, limit],
        );
        const nodos = (res.rows || []).map((r: any) => ({ proveedor: r.name, saltos: Number(r.salto) }));
        return nodos.length <= 1
          ? { foco, relacionados: [], nota: `No encontré otros proveedores ligados a "${foco}" por RFC compartido (o falta data de documentos).` }
          : { foco, relacionados: nodos, nota: 'Proveedores conectados por RFC compartido (mismo RFC bajo distintos nombres). saltos = distancia en el grafo.' };
      }
      // Global: RFC con ≥2 razones sociales (fragmentación) + nombre con ≥2 RFC (shell/typo).
      const porRfc = await trx('analytics.expense_documents').where('tenant_id', tenantId)
        .whereRaw("NULLIF(btrim(rfc),'') IS NOT NULL").whereRaw("NULLIF(btrim(beneficiario),'') IS NOT NULL")
        .groupByRaw('upper(btrim(rfc))')
        .havingRaw('count(DISTINCT upper(btrim(beneficiario))) >= 2')
        .select(trx.raw('upper(btrim(rfc)) AS rfc'),
          trx.raw('count(DISTINCT upper(btrim(beneficiario)))::int AS nombres'),
          trx.raw("(array_agg(DISTINCT upper(btrim(beneficiario))))[1:5] AS ejemplos"),
          trx.raw('ROUND(SUM(importe)::numeric,2) AS importe'))
        .orderByRaw('SUM(importe) DESC').limit(limit);
      const porNombre = await trx('analytics.expense_documents').where('tenant_id', tenantId)
        .whereRaw("NULLIF(btrim(rfc),'') IS NOT NULL").whereRaw("NULLIF(btrim(beneficiario),'') IS NOT NULL")
        .groupByRaw('upper(btrim(beneficiario))')
        .havingRaw('count(DISTINCT upper(btrim(rfc))) >= 2')
        .select(trx.raw('upper(btrim(beneficiario)) AS nombre'),
          trx.raw('count(DISTINCT upper(btrim(rfc)))::int AS rfcs'),
          trx.raw('ROUND(SUM(importe)::numeric,2) AS importe'))
        .orderByRaw('SUM(importe) DESC').limit(limit);
      if (!porRfc.length && !porNombre.length) {
        return { rfc_multi_nombre: [], nombre_multi_rfc: [], nota: 'Sin relaciones detectables (requiere data de documentos con RFC — el feed GX v3 alimenta esto en prod).' };
      }
      return {
        rfc_multi_nombre: porRfc.map((r: any) => ({ rfc: r.rfc, nombres: Number(r.nombres), ejemplos: r.ejemplos, importe: Number(r.importe) })),
        nombre_multi_rfc: porNombre.map((r: any) => ({ nombre: r.nombre, rfcs: Number(r.rfcs), importe: Number(r.importe) })),
        nota: 'RFC con varias razones sociales = posible fragmentación/split-invoicing. Nombre con varios RFC = posible shell o error de captura. Revisar los de mayor importe.',
      };
    });
  }

  private async cadena(q: any) {
    const limit = Math.min(100, Math.max(1, Number(q.limit) || 20));
    return this.tk.run(async (trx) => {
      const base = () => {
        const b = trx('analytics.expense_doc_chain').where('tenant_id', this.tenantId());
        if (q.sucursal) b.where('sucursal', String(q.sucursal));
        if (q.beneficiario) b.whereRaw('beneficiario ILIKE ?', [`%${q.beneficiario}%`]);
        if (q.solo_incompletas) b.where((w: any) => w.whereNull('recepcion_folio').orWhereNull('orden_folio'));
        return b;
      };
      if (q.factura_folio) {
        const row = await base().where('factura_folio', String(q.factura_folio)).first();
        return row ? { ...row, total: Number(row.total) } : { error: `Sin cadena para la factura ${q.factura_folio}${q.sucursal ? ` en sucursal ${q.sucursal}` : ' (¿falta sucursal?)'}.` };
      }
      const stats: any = await base()
        .select(trx.raw('COUNT(*)::int AS facturas'),
          trx.raw('COUNT(*) FILTER (WHERE recepcion_folio IS NOT NULL AND orden_folio IS NOT NULL)::int AS completas'),
          trx.raw('COUNT(*) FILTER (WHERE recepcion_folio IS NULL)::int AS sin_recepcion'),
          trx.raw('ROUND(AVG(lead_days) FILTER (WHERE lead_days IS NOT NULL))::int AS lead_days_prom'),
          trx.raw('ROUND(SUM(total) FILTER (WHERE recepcion_folio IS NULL)::numeric,2) AS monto_sin_recepcion'))
        .first();
      const rows = await base()
        .select('sucursal', 'factura_folio', 'factura_fecha', 'beneficiario', trx.raw('total::numeric AS total'),
          'orden_folio', 'recepcion_folio', 'pago_folio', 'lead_days', 'match_confidence')
        .orderBy('total', 'desc')
        .limit(limit);
      return {
        stats: {
          facturas: Number(stats.facturas), completas: Number(stats.completas),
          completas_pct: stats.facturas ? +((stats.completas / stats.facturas) * 100).toFixed(1) : 0,
          sin_recepcion: Number(stats.sin_recepcion),
          monto_sin_recepcion: Number(stats.monto_sin_recepcion || 0),
          lead_days_promedio: stats.lead_days_prom != null ? Number(stats.lead_days_prom) : null,
        },
        rows: rows.map((r: any) => ({ ...r, total: Number(r.total) })),
      };
    });
  }

  private async serieMensual(q: any) {
    const { from, to } = this.range({ ...q, from: q.from || (() => { const d = new Date(); d.setMonth(d.getMonth() - 12); return d.toISOString().slice(0, 10); })() });
    return this.tk.run(async (trx) => {
      const rows: any[] = await this.baseEgresos(trx, q, from, to)
        .groupByRaw("to_char(e.fecha,'YYYY-MM')")
        .select(trx.raw("to_char(e.fecha,'YYYY-MM') AS mes"),
          trx.raw("ROUND(COALESCE(SUM(importe) FILTER (WHERE e.familia='5'),0)::numeric,2) AS compras"),
          trx.raw("ROUND(COALESCE(SUM(importe) FILTER (WHERE e.familia IN ('6','7')),0)::numeric,2) AS gastos"),
          trx.raw('ROUND(SUM(importe)::numeric,2) AS total'))
        .orderBy('mes');
      return { from, to, rows: col(rows.map((r) => ({ mes: r.mes, compras: Number(r.compras), gastos: Number(r.gastos), total: Number(r.total) }))) };
    });
  }

  private async proveedor(q: any) {
    const search = (q.search || '').trim();
    const limit = Math.min(50, Math.max(1, Number(q.limit) || 10));
    return this.tk.run(async (trx) => {
      const b = trx('analytics.ap_provider').where('tenant_id', this.tenantId());
      if (search) b.whereRaw('proveedor ILIKE ?', [`%${search}%`]);
      const provs: any[] = await b
        .groupBy('proveedor_norm')
        .select(trx.raw('MAX(proveedor) AS proveedor'),
          trx.raw('SUM(compra_12m)::numeric AS compra_12m'), trx.raw('SUM(pagos_12m)::numeric AS pagos_12m'),
          trx.raw('SUM(saldo)::numeric AS saldo'), trx.raw('SUM(num_facturas)::int AS num_facturas'),
          trx.raw('MAX(ultima_compra) AS ultima_compra'))
        .orderByRaw('SUM(compra_12m) DESC')
        .limit(limit);
      const out = provs.map((p) => {
        const compra = Number(p.compra_12m), saldo = Number(p.saldo);
        return {
          proveedor: p.proveedor, compra_12m: compra, pagos_12m: Number(p.pagos_12m), saldo,
          num_facturas: Number(p.num_facturas), ultima_compra: p.ultima_compra,
          dpo_dias: compra > 0 && saldo > 0 ? Math.round(saldo / (compra / 365)) : null,
        };
      });
      // Match único → anexar top productos comprados (detalle kdm2).
      if (out.length === 1) {
        const products: any[] = await trx('analytics.expense_document_lines as l')
          .join('analytics.expense_documents as d', function (this: any) {
            this.on('d.tenant_id', 'l.tenant_id').andOn('d.sucursal', 'l.sucursal')
              .andOn('d.doc_tipo', 'l.doc_tipo').andOn('d.doc_folio', 'l.doc_folio');
          })
          .where('l.tenant_id', this.tenantId())
          .whereRaw('d.beneficiario ILIKE ?', [`%${search || out[0].proveedor}%`])
          .groupBy('l.sku')
          .select('l.sku', trx.raw('MAX(l.producto) AS producto'),
            trx.raw('SUM(l.cantidad)::numeric AS cantidad'), trx.raw('SUM(l.importe)::numeric AS importe'),
            trx.raw('COUNT(DISTINCT l.doc_folio)::int AS docs'))
          .orderByRaw('SUM(l.importe) DESC')
          .limit(15);
        return {
          ...out[0],
          top_productos: products.map((r) => ({ sku: r.sku, producto: r.producto, cantidad: num(r.cantidad), importe: Number(r.importe), docs: Number(r.docs) })),
        };
      }
      return { proveedores: out };
    });
  }

  private async documento(q: any) {
    const { sucursal, doc_tipo, folio } = q;
    if (!sucursal || !doc_tipo || !folio) return { error: 'Faltan sucursal, doc_tipo o folio.' };
    return this.tk.run(async (trx) => {
      const header = await trx('analytics.expense_documents as d')
        .where({ 'd.tenant_id': this.tenantId(), 'd.sucursal': sucursal, 'd.doc_tipo': doc_tipo, 'd.doc_folio': folio })
        .select('d.sucursal', 'd.doc_tipo', 'd.doc_folio', 'd.fecha', 'd.fecha_doc', 'd.beneficiario', 'd.rfc',
          'd.concepto', 'd.area', trx.raw('d.importe::numeric AS importe'), trx.raw('d.iva::numeric AS iva'), 'd.usuario')
        .first();
      const postings = await trx('analytics.expense_entries')
        .where({ tenant_id: this.tenantId(), sucursal, doc_tipo, doc_folio: folio })
        .select('linea', 'cuenta', 'cuenta_nombre', trx.raw('importe::numeric AS importe'))
        .orderBy('linea');
      const lines = await trx('analytics.expense_document_lines')
        .where({ tenant_id: this.tenantId(), sucursal, doc_tipo, doc_folio: folio })
        .select('sku', 'producto', trx.raw('cantidad::numeric AS cantidad'), trx.raw('costo_unitario::numeric AS costo_unitario'), trx.raw('importe::numeric AS importe'))
        .orderBy('importe', 'desc');
      if (!header && !postings.length) return { error: `No existe el documento ${doc_tipo}-${folio} en sucursal ${sucursal}.` };
      return {
        header: header ? { ...header, importe: Number(header.importe), iva: Number(header.iva) } : null,
        posturas: postings.map((r: any) => ({ ...r, importe: Number(r.importe) })),
        lineas: lines.map((r: any) => ({ ...r, cantidad: num(r.cantidad), costo_unitario: num(r.costo_unitario), importe: Number(r.importe) })),
        ui_url: this.docUrl(sucursal, doc_tipo, folio, header?.beneficiario),
      };
    });
  }

  /** Busca documentos SIN folio (por proveedor/período/monto). Cada fila trae ui_url. */
  private async buscarDocumentos(q: any) {
    const limit = Math.min(50, Math.max(1, Number(q.limit) || 15));
    const { from, to } = this.range(q);
    return this.tk.run(async (trx) => {
      // Fuente: documentos con cabecera (compras/gastos). Para pólizas sin cabecera
      // (diario), el drill igual funciona vía expense_entries — pero para "una póliza
      // de X proveedor" la cabecera es lo relevante.
      const b = trx('analytics.expense_documents as d')
        .where('d.tenant_id', this.tenantId())
        .andWhere('d.fecha', '>=', from)
        .andWhere('d.fecha', '<=', to);
      if (q.beneficiario) b.whereRaw('(d.beneficiario ILIKE ? OR d.area ILIKE ?)', [`%${q.beneficiario}%`, `%${q.beneficiario}%`]);
      if (q.sucursal) b.where('d.sucursal', String(q.sucursal));
      if (q.doc_tipo) b.where('d.doc_tipo', String(q.doc_tipo));
      if (q.familia) b.whereRaw("left(d.doc_tipo,3) = ANY(?)", [q.familia === '5' ? ['XA2'] : ['XA1']]); // heurística tipo→familia
      if (q.min_importe != null) b.where('d.importe', '>=', Number(q.min_importe));
      const rows = await b
        .select('d.sucursal', 'd.doc_tipo', 'd.doc_folio', 'd.fecha', 'd.beneficiario', 'd.concepto', 'd.area',
          trx.raw('d.importe::numeric AS importe'))
        .orderBy('d.importe', 'desc')
        .limit(limit);
      if (!rows.length) return { rows: [], nota: 'Sin documentos para ese criterio. Prueba con otro nombre de proveedor o amplía el período.' };
      return {
        from, to,
        rows: col(rows.map((r: any) => ({
          sucursal: r.sucursal, doc_tipo: r.doc_tipo, folio: r.doc_folio, fecha: r.fecha,
          beneficiario: r.beneficiario, concepto: r.concepto, importe: Number(r.importe),
          ui_url: this.docUrl(r.sucursal, r.doc_tipo, r.doc_folio, r.beneficiario),
        }))),
      };
    });
  }

  /**
   * MAAT.3.1 — detector-lite proactivo (adelanto de MAAT.2, sin persistir):
   * duplicados, saltos de precio SKU, saldo/DPO y facturas sin recepción.
   * Cálculo on-the-fly; devuelve SOLO las señales encontradas.
   */
  private async alertas(q: any) {
    const tenantId = this.tenantId();
    const benef = (q.beneficiario || '').trim();
    return this.tk.run(async (trx) => {
      const signals: any[] = [];

      // 1) Facturas duplicadas: mismo proveedor + importe ±0.5% + ventana 7d + folios distintos (últimos 120d)
      const dupBase = trx('analytics.expense_documents as a')
        .join('analytics.expense_documents as b', function (this: any) {
          this.on('a.tenant_id', 'b.tenant_id').andOn('a.beneficiario', 'b.beneficiario')
            .andOn('a.doc_folio', '<', 'b.doc_folio');
        })
        .where('a.tenant_id', tenantId).where('b.tenant_id', tenantId)
        .whereRaw('abs(a.importe - b.importe) <= greatest(a.importe,1)*0.005')
        .whereRaw("abs(a.fecha - b.fecha) <= 7")
        .whereRaw('a.importe > 500')
        .whereRaw("a.fecha >= (CURRENT_DATE - interval '120 days')");
      if (benef) dupBase.whereRaw('a.beneficiario ILIKE ?', [`%${benef}%`]);
      if (q.sucursal) dupBase.where('a.sucursal', String(q.sucursal));
      const dups = await dupBase
        .select('a.beneficiario', 'a.sucursal', 'a.doc_folio as folio_a', 'b.doc_folio as folio_b',
          trx.raw('a.importe::numeric AS importe'), 'a.fecha as fecha_a', 'b.fecha as fecha_b')
        .orderBy('a.importe', 'desc').limit(10);
      for (const d of dups) signals.push({
        tipo: 'posible_duplicado', severidad: 'alta',
        detalle: `${d.beneficiario}: 2 facturas de ${Number(d.importe).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' })} en ≤7 días (folios ${d.folio_a} y ${d.folio_b}, suc ${d.sucursal}).`,
        importe: Number(d.importe),
        ui_url: this.docUrl(d.sucursal, 'XA2001', d.folio_b, d.beneficiario),
      });

      // 2) Salto de precio por SKU: costo_unitario reciente > 1.3× su promedio histórico del proveedor
      if (benef) {
        // MAAT.7 — anomalía ESTADÍSTICA (z-score) en vez de heurística 1.3×avg:
        // el costo máximo se desvía ≥2σ de la media del SKU (stddev poblacional).
        // Menos falsos positivos y captura saltos reales que un umbral fijo ignora.
        const jumps = await trx('analytics.expense_document_lines as l')
          .join('analytics.expense_documents as d', function (this: any) {
            this.on('d.tenant_id', 'l.tenant_id').andOn('d.sucursal', 'l.sucursal')
              .andOn('d.doc_tipo', 'l.doc_tipo').andOn('d.doc_folio', 'l.doc_folio');
          })
          .where('l.tenant_id', tenantId).whereRaw('d.beneficiario ILIKE ?', [`%${benef}%`])
          .whereRaw('l.costo_unitario > 0')
          .groupBy('l.sku')
          .havingRaw('count(*) >= 4')
          .havingRaw('stddev_pop(l.costo_unitario) > 0')
          .havingRaw('max(l.costo_unitario) - avg(l.costo_unitario) >= 2 * stddev_pop(l.costo_unitario)')
          .select('l.sku', trx.raw('MAX(l.producto) AS producto'),
            trx.raw('ROUND(AVG(l.costo_unitario)::numeric,2) AS avg_costo'),
            trx.raw('ROUND(MAX(l.costo_unitario)::numeric,2) AS max_costo'),
            trx.raw('ROUND(((max(l.costo_unitario) - avg(l.costo_unitario)) / nullif(stddev_pop(l.costo_unitario),0))::numeric, 1) AS z'))
          .orderByRaw('(max(l.costo_unitario) - avg(l.costo_unitario)) / nullif(stddev_pop(l.costo_unitario),0) DESC')
          .limit(5);
        for (const j of jumps) signals.push({
          tipo: 'salto_precio', severidad: Number(j.z) >= 3 ? 'alta' : 'media',
          detalle: `SKU ${j.sku} (${j.producto || '?'}): un costo de ${Number(j.max_costo).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' })} se desvía ${Number(j.z)}σ de su promedio ${Number(j.avg_costo).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' })} (anomalía estadística).`,
        });
      }

      // 3) Saldo alto / DPO largo (ap_provider)
      if (benef) {
        const ap = await trx('analytics.ap_provider').where('tenant_id', tenantId)
          .whereRaw('proveedor ILIKE ?', [`%${benef}%`])
          .select(trx.raw('MAX(proveedor) AS proveedor'), trx.raw('SUM(saldo)::numeric AS saldo'), trx.raw('SUM(compra_12m)::numeric AS compra'))
          .first();
        if (ap && Number(ap.saldo) > 0) {
          const dpo = Number(ap.compra) > 0 ? Math.round(Number(ap.saldo) / (Number(ap.compra) / 365)) : null;
          if (dpo && dpo > 60) signals.push({
            tipo: 'dpo_largo', severidad: 'media',
            detalle: `${ap.proveedor}: saldo por pagar ${Number(ap.saldo).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' })}, DPO ~${dpo} días.`,
            importe: Number(ap.saldo),
          });
        }
      }

      // 4) Facturas sin recepción (pagar sin recibir) — de la cadena
      const chainBase = trx('analytics.expense_doc_chain').where('tenant_id', tenantId).whereNull('recepcion_folio');
      if (benef) chainBase.whereRaw('beneficiario ILIKE ?', [`%${benef}%`]);
      if (q.sucursal) chainBase.where('sucursal', String(q.sucursal));
      const noRcp: any = await chainBase.clone()
        .select(trx.raw('COUNT(*)::int AS n'), trx.raw('ROUND(SUM(total)::numeric,2) AS monto')).first();
      if (Number(noRcp?.n) > 0) signals.push({
        tipo: 'sin_recepcion', severidad: 'alta',
        detalle: `${noRcp.n} factura(s) sin recepción registrada${benef ? ` de ${benef}` : ''} por ${Number(noRcp.monto).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' })} (pagar sin comprobante de recibido).`,
        importe: Number(noRcp.monto),
      });

      return { signals, encontradas: signals.length };
    });
  }

  private async hallazgos(q: any) {
    const tenantId = this.tenantId();
    const limit = Math.min(100, Math.max(1, Number(q.limit) || 20));
    return this.tk.run(async (trx) => {
      // MAAT.2 — lee el motor de patrones persistido (finance.findings). Solo
      // pendientes (nuevo/en_revision) para la conversación; el triage vive en la bandeja.
      const base = () => trx('finance.findings as f').where('f.tenant_id', tenantId).whereIn('f.status', ['nuevo', 'en_revision']);
      const summary: any[] = await base()
        .groupBy('f.clase')
        .select('f.clase', trx.raw('COUNT(*)::int AS num'), trx.raw('ROUND(SUM(f.importe)::numeric,2) AS total'))
        .orderByRaw('SUM(f.importe) DESC');
      if (!summary.length) return { resumen: [], rows: [], nota: 'No hay hallazgos pendientes. Corre el motor (bandeja de hallazgos) o revisa períodos con más movimiento.' };

      const rowsQ = base()
        .leftJoin('finance.rule_registry as r', function (this: any) { this.on('r.tenant_id', 'f.tenant_id').andOn('r.rule_key', 'f.rule_key'); })
        .select('f.rule_key', 'r.nombre as regla', 'f.clase', 'f.severity', 'f.titulo', 'f.resumen',
          'f.entity', trx.raw('f.importe::numeric AS importe'))
        .orderByRaw("CASE f.severity WHEN 'critical' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END")
        .orderBy('f.importe', 'desc').limit(limit);
      // q.tipo flexible: filtra por clase o por rule_key si viene
      if (q.tipo) rowsQ.where((w: any) => w.where('f.clase', q.tipo).orWhere('f.rule_key', q.tipo));
      const rows = await rowsQ;

      return {
        resumen: summary.map((s) => ({ clase: s.clase, num: Number(s.num), total: Number(s.total) })),
        rows: col(rows.map((r: any) => ({
          regla: r.regla || r.rule_key, clase: r.clase, severidad: r.severity,
          titulo: r.titulo, resumen: r.resumen, importe: Number(r.importe),
          // deep-link a la póliza si el hallazgo apunta a un documento
          ui_url: r.entity?.doc_folio ? this.docUrl(r.entity.sucursal, r.entity.doc_tipo || 'XA2001', r.entity.doc_folio, r.entity.beneficiario) : null,
        }))),
      };
    });
  }

  private async conocimiento(q: any) {
    const query = String(q.q || '').trim();
    // RAG: si hay query y el índice vectorial está disponible, búsqueda semántica.
    if (query && this.kbVector.available()) {
      const tenantId = this.tenantCtx.requireTenantId();
      const hits = await this.kbVector.search(tenantId, query, q.kind, 8);
      if (hits.length) {
        return { rows: hits.map((h) => ({ kind: h.kind, title: h.title, body: h.body, source: h.source, score: h.score })), via: 'semantico' };
      }
    }
    // Fallback determinista (sin query, sin índice, o índice vacío): ILIKE.
    return this.tk.run(async (trx) => {
      const b = trx('finance.knowledge').where('status', 'active');
      if (q.kind) b.where('kind', q.kind);
      if (query) b.whereRaw('(title ILIKE ? OR body ILIKE ?)', [`%${query}%`, `%${query}%`]);
      const rows = await b.select('kind', 'title', 'body', 'source').orderBy(['kind', 'title']).limit(20);
      return rows.length ? { rows, via: 'texto' } : { rows: [], nota: 'Sin resultados en la base de conocimiento.' };
    });
  }

  private async guardarConocimiento(q: any, scope: MaatScope) {
    if (!q?.title?.trim() || !q?.body?.trim() || !q?.kind) return { error: 'kind, title y body son requeridos.' };
    const kind = q.kind;
    const title = String(q.title).trim().slice(0, 200);
    const body = String(q.body).trim().slice(0, 2000);
    const tenantId = this.tenantCtx.requireTenantId();
    const row = await this.tk.run(async (trx) => {
      const [r] = await trx('finance.knowledge')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          kind, title, body, source: 'chat', created_by: scope.userName || 'maat-chat',
        })
        .onConflict(['tenant_id', 'kind', 'title'])
        .merge({ body, status: 'active', updated_at: trx.fn.now() })
        .returning(['kind', 'title']);
      this.logger.log(`knowledge guardado vía chat: [${r.kind}] ${r.title} (por ${scope.userName || '?'})`);
      return r;
    });
    // RAG: embdebe la entrada al vuelo (best-effort, no bloquea la respuesta).
    await this.kbVector.upsert(tenantId, { kind, title, body, source: 'chat' });
    return { guardado: true, kind: row.kind, title: row.title };
  }
}
