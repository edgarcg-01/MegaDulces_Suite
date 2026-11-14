'use strict';
/**
 * `[MDT.1.2]` `[MDT.2.5]` — El manual por puesto, COMO DATO, sobre un motor de checklist genérico.
 *
 * ── Por qué ─────────────────────────────────────────────────────────────────────────────────
 * MDTask (la app aparte en Railway, Fase MDT) entrega cada día a cada puesto las tareas de los
 * Manuales Corporativos de Operación 2026. La norma vive en SU código (un catálogo de 96 KB) y las
 * entregas en otra base. Esto la trae a la Suite como dato, colgada de `identity.positions`, y deja
 * el motor en `platform` para que no haya un tercer motor de checklist (D5, ADR-056): el de
 * embarques (`logistics.shipment_checklists`, 0 filas en prod) queda como deuda con nombre para
 * pasarse a éste.
 *
 * ── Lo medido antes (pg-prod, sólo lectura, 7688376744939610156, 2026-11-13) ─────────────────
 *  · Catálogo de MDTask @3aa3297, extraído por AST sin ejecutarlo: 20 manuales, 51 tareas,
 *    391 puntos (8 con evidencia escrita; el resto pide foto por orden de Dirección del 3-sep).
 *  · 22 de los 23 puestos con manual existen en `identity.positions` (87 personas asignadas).
 *    Falta `kileadora` (MDTask la agregó el 22-sep, después del organigrama de `[AU.23]`).
 *  · `platform` existe (DP); ninguna tabla `checklist_*`.
 *
 * ── Las tablas ──────────────────────────────────────────────────────────────────────────────
 *  · `checklist_templates`          la tarea de la norma: cuándo toca (frecuencia, día, hora límite)
 *                                   y de qué documento sale. NO guarda los puntos.
 *  · `checklist_template_positions` a qué puestos les toca.
 *  · `checklist_template_versions`  los PUNTOS y la HORA LÍMITE, versionados. Registro: no se edita,
 *                                   se agrega una versión con `valid_from` y motivo. Una entrega guarda
 *                                   la versión con la que se juzgó (MDTask §5.4). La hora de la versión
 *                                   gana a la de la plantilla (MDT.3.2b).
 *  · `checklist_runs`               la ENTREGA de una persona para un periodo. ⛔ NO la crea un
 *                                   emisor (D3: ningún cron): nace cuando la persona abre la tarea.
 *                                   Lo pendiente de hoy se DERIVA de la norma al leer. Lleva
 *                                   `assigned_(to|by|at)` + `due_at`: es fuente del contrato de tarea
 *                                   (`task.contract.ts`), con `assigned_by` NULL = la asignó la norma.
 *  · `checklist_run_files`          la evidencia (fotos, documentos) en el bucket propio. Se guarda
 *                                   la llave, nunca la URL.
 *
 * ── Invariantes que hace cumplir la base ────────────────────────────────────────────────────
 *  · frecuencia semanal ⇔ día de la semana; mensual ⇔ día del mes.
 *  · `submitted` ⇔ `submitted_at` ⇔ `submitted_late` no nulo.
 *  · la versión de una entrega pertenece a SU plantilla (FK compuesta).
 *  · una entrega por plantilla, persona y periodo.
 *
 * ── Llaves (regla 20: repartidas, no sólo declaradas) ───────────────────────────────────────
 *  ⛔ PILOTO (2026-11-14): las tres llaves van SÓLO a Dirección, Recursos Humanos y superadmin.
 *     Mientras la gente siga entregando en MDTask, repartir ENTREGAR a todos haría que Mi trabajo les
 *     marque como PENDIENTE lo que sí entregaron (allá): un número falso para 87 personas. El reparto
 *     amplio va en la migración del CORTE (`[MDT.C1]`), el día que MDTask deja de recibir entregas:
 *       · ENTREGAR   → todo rol con personas (excepto customer_b2b, servicio, checador_kiosco,
 *                      verificador_precios, etiquetas_anaquel, etiquetas_tienda, sin_acceso, auditor_externo).
 *       · EQUIPO_VER → los roles cuyo puesto TIENE puestos a cargo (derivado de
 *                      `reports_to_position_code`, no elegido a mano) + Dirección.
 *  · TAREAS_PUESTO_NORMA_GESTIONAR → Dirección y Recursos Humanos: el manual «se elabora en Capital
 *                                   Humano y lo autoriza Dirección» (catálogo de MDTask). Ésta no cambia.
 *
 * La siembra va en ESTA migración (precedente DP): una que sólo inserta la clasifica NO_MEDIDO la
 * compuerta del despliegue. Aditiva e idempotente. RLS forzado. FKs compuestas `(tenant_id, …)`.
 *
 * @param { import("knex").Knex } knex
 */

const TENANT = '00000000-0000-0000-0000-00000000d01c';
// La siembra va DENTRO de la migración (2026-11-14): el aplicador de prod copia sólo este .js al pod, con la
// imagen vieja, y un require a un .json aparte tiraba la migración antes del up (el despliegue quedó frenado).
// Es la norma extraída por AST del catálogo de MDTask (20 manuales, 51 tareas, 391 puntos).
const SEED = {
  "_fuente": "MDTask (IngeDavid2209/mega-dulces-app @ 3aa3297): src/app/shared/tareas-manual.catalogo.ts + evidencia-manual.ts, extraídos por AST sin ejecutar el código, 2026-11-13. Los manuales son los Manuales Corporativos de Operación 2026 (carpeta entregada el 2026-08-28).",
  "_consume": "database/migrations-newdb/20261113175536_mdt_manual_por_puesto.js",
  "_evidencia": "Regla de Dirección (3-sep-2026, relevada por David): todo punto pide foto, y más de una (evidence=photos). Excepción declarada punto por punto: los «escritos» (text = cuadro de texto, list = renglones). accepts_documents = el punto se prueba con un archivo que ya existe (PDF/Excel). requires_amount/folio/comment = campos extra que la app pide.",
  "_puestos": "puestos = code de identity.positions. Cruce por nombre contra organigrama-mdtask.json (MDT.0.6): 89/90; kileadora no existía y la crea la migración.",
  "_conteo": {
    "manuales": 20,
    "tareas": 51,
    "puntos": 391
  },
  "ventana": {
    "inicio": "06:00",
    "fin": "23:00"
  },
  "mapa_puestos_mdtask": {
    "direccion-general": "direccion",
    "gerencia-zona": "jefe_zona",
    "aux-mercadotecnia-zona": "auxiliar_mkt",
    "aux-caja-general-zona": "aux_caja_general_zona",
    "aux-administrativo-zona": "auxiliar_administrativo",
    "analista-abastecimiento-regional": "analista_abastecimiento_regional",
    "promotora": "vendedor_promociones",
    "supervisor-ventas-rd": "supervisor_rd",
    "supervisor-ventas-vecinal": "supervisor_rv",
    "vendedor-rd": "vendedor_ruta",
    "vendedor-vecinal": "vendedor_vecinal",
    "vendedor-suplente": "vendedor_suplente",
    "vendedor-mayoreo": "vendedor_mayoreo",
    "ejecutivo-trade-marketing": "ejecutivo_trade_marketing",
    "cajero-rd": "cajero_rd",
    "cajero-vecinal": "cajero_rv_promotor",
    "surtidor-ventas": "surtidor_ventas",
    "repartidor-vecinal": "repartidor_vecinal",
    "encargado-sucursal": "encargado_sucursal",
    "auxiliar-encargado": "auxiliar_encargado",
    "almacenista-sucursal": "almacenista",
    "bodeguero-sucursal": "bodeguero",
    "anaquelista": "anaquelista",
    "cajero-sucursal": "cajera",
    "coordinador-cajas": "encargado_cajas",
    "coordinador-piso-ventas": "coordinador_piso_ventas",
    "vendedora-piso": "vendedor_piso",
    "surtidor-sucursal": "surtidor_tienda",
    "multifuncional": "multifuncional",
    "kileadora": "kileadora",
    "recepcion-mercancia-sucursal": "recepcion_mercancia_sucursal",
    "vigilancia": "vigilancia",
    "intendencia": "intendencia",
    "coordinador-operaciones-zona": "encargado_operaciones",
    "recepcion-mercancia-zona": "recepcion_mercancia_zona",
    "empaque": "empaquetador",
    "surtidor-zona": "surtidor",
    "checador": "checador",
    "embarques": "embarques",
    "facturacion": "facturador",
    "chofer-zona": "chofer_local",
    "aux-reparto": "aux_reparto",
    "jefatura-cedis": "jefatura_cedis",
    "encargado-almacen-cedis": "encargado_almacen_cedis",
    "auxiliar-cedis": "auxiliar_cedis",
    "surtidor-cedis": "surtidor_cedis",
    "checador-cedis": "checador_cedis",
    "almacenista-cedis": "almacenista_cedis",
    "recepcion-producto-cedis": "receptor_mercancia",
    "entradas-salidas-cedis": "entradas_salidas_cedis",
    "facturacion-cedis": "facturacion_cedis",
    "coordinador-logistica": "encargado_logistica",
    "aux-administrativo-logistica": "aux_administrativo_logistica",
    "aux-logistica-flotilla": "aux_logistica_flotilla",
    "chofer-cedis": "chofer_cedis",
    "auxiliar-chofer": "auxiliar_chofer",
    "repartidor-cedis": "repartidor",
    "gerencia-admin-financiera": "jefe_finanzas",
    "encargado-contabilidad": "encargado_contabilidad",
    "analista-contable": "auxiliar_contabilidad",
    "jefe-tesoreria": "tesoreria",
    "credito-cobranza": "auxiliar_credito_cobranza",
    "analista-ingresos": "analista_ingresos",
    "caja-general": "caja_general",
    "practicante-caja-general": "practicante_caja_general",
    "analista-egresos": "analista_egresos",
    "presupuestos-compras-corporativas": "presupuestos_compras_corp",
    "coordinacion-auditoria-prevencion": "prevencion",
    "auxiliar-auditoria-prevencion": "auxiliar_prevencion",
    "encargado-activos-insumos": "encargado_activos_insumos",
    "jefe-mantenimiento": "jefe_mantenimiento",
    "jefatura-capital-humano": "jefatura_capital_humano",
    "servicios-al-personal": "auxiliar_rh",
    "practicante-control-documental-rh": "practicante_control_doc_rh",
    "reclutamiento-onboarding": "reclutamiento_onboarding",
    "practicante-atraccion-talento": "practicante_atraccion_talento",
    "direccion-comercial-marketing": "direccion_comercial",
    "coordinacion-compras": "gerente_compras",
    "analista-catalogo-productos": "analista_catalogo_productos",
    "analista-ordenes-entrada": "auxiliar_compras",
    "analista-abastecimiento-comercial": "analista_abastecimiento_comercial",
    "jefe-marketing": "jefe_marketing",
    "trade-marketing": "trade_marketing",
    "inteligencia-comercial": "inteligencia_comercial",
    "coordinador-marketing-digital": "coordinador_mkt_digital",
    "practicante-produccion-audiovisual": "practicante_produccion_av",
    "practicante-diseno-grafico": "practicante_diseno_grafico",
    "jefatura-sistemas": "sistemas",
    "infraestructura-seguridad": "infraestructura_seguridad",
    "full-stack-developer": "full_stack_developer"
  },
  "manuales": [
    {
      "documento": "Manual Corporativo de Operación — Cajera de Sucursal",
      "codigo": "MDDLA-SUC-CAJ-001",
      "version": "1.1 · Agosto 2026",
      "archivo": "15. Manual_Corporativo_Cajera_Sucursal_MDDLA_2026.pdf",
      "puestos": [
        "cajera"
      ],
      "formatos_no_automatizados": [
        "C. Registro sugerido de incidencias de caja"
      ],
      "tareas": [
        {
          "key": "manual.cajero_sucursal.apertura",
          "source_key": "cajero-sucursal.apertura",
          "name": "Checklist de apertura de caja",
          "moment": "apertura",
          "frequency": "daily",
          "weekday": null,
          "month_day": null,
          "due_time": "23:00",
          "format_code": "Anexo A",
          "note": null,
          "per_event": false,
          "only_positions": null,
          "own_document": null,
          "items": [
            {
              "id": "p0",
              "label": "Área limpia y ordenada",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p1",
              "label": "Usuario propio y caja correcta",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p2",
              "label": "Fondo contado/registrado",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": true,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p3",
              "label": "Lector, impresora y rollos disponibles",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p4",
              "label": "Terminal bancaria operativa",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p5",
              "label": "Material y detector de billetes disponibles",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            }
          ]
        },
        {
          "key": "manual.cajero_sucursal.cierre",
          "source_key": "cajero-sucursal.cierre",
          "name": "Checklist de cierre de caja",
          "moment": "cierre",
          "frequency": "daily",
          "weekday": null,
          "month_day": null,
          "due_time": "23:00",
          "format_code": "Anexo B",
          "note": null,
          "per_event": false,
          "only_positions": null,
          "own_document": null,
          "items": [
            {
              "id": "p0",
              "label": "Último cliente atendido y cortina cerrada",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p1",
              "label": "Vouchers conciliados",
              "block": null,
              "evidence": "photos",
              "accepts_documents": true,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p2",
              "label": "Retiros integrados",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p3",
              "label": "Devoluciones/documentos integrados",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p4",
              "label": "Efectivo arqueado",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": true,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p5",
              "label": "Diferencias reportadas",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": true
            },
            {
              "id": "p6",
              "label": "Corte generado",
              "block": null,
              "evidence": "photos",
              "accepts_documents": true,
              "requires_amount": false,
              "requires_folio": true,
              "requires_comment": false
            },
            {
              "id": "p7",
              "label": "Efectivo y documentos en caja fuerte",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            }
          ]
        },
        {
          "key": "manual.cajero_sucursal.operacion",
          "source_key": "cajero-sucursal.operacion",
          "name": "Operación de caja del turno",
          "moment": "operacion",
          "frequency": "daily",
          "weekday": null,
          "month_day": null,
          "due_time": "23:00",
          "format_code": "3.2 – 3.11",
          "note": "Autoevaluación del turno sobre los procedimientos del manual. No sustituye al procedimiento: confirma que se siguió. Lo que no se pueda afirmar se explica en las observaciones.",
          "per_event": false,
          "only_positions": null,
          "own_document": null,
          "items": [
            {
              "id": "p0",
              "label": "Cobré siempre con mi usuario propio y en la caja que me corresponde",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p1",
              "label": "Comparé la descripción del sistema contra el producto físico ante cualquier duda",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p2",
              "label": "No otorgué descuentos ni modifiqué precios por iniciativa propia",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p3",
              "label": "Revisé autenticidad de billetes y conté el cambio antes de entregarlo",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p4",
              "label": "No hice préstamos de caja ni cambios a personas ajenas a una venta",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p5",
              "label": "Capturé la forma de pago correcta y conservé los comprobantes",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p6",
              "label": "Validé datos fiscales antes de generar cada factura",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p7",
              "label": "Entregué los retiros a la Encargada de inmediato, sin dejarlos expuestos",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p8",
              "label": "Escalé a la Encargada las diferencias de precio, devoluciones y fallas de sistema",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            }
          ]
        }
      ]
    },
    {
      "documento": "Manual Corporativo de Operación — Anaquelista de Sucursal",
      "codigo": "MDDLA-SUC-ANA-001",
      "version": "1.2 · Septiembre 2026",
      "archivo": "11. Manual_Corporativo_Anaquelista_Sucursal_MDDLA_2026_v1.1.pdf",
      "puestos": [
        "anaquelista"
      ],
      "formatos_no_automatizados": [
        "B. Registro sugerido de caducidades",
        "C. Registro sugerido de faltantes recurrentes"
      ],
      "tareas": [
        {
          "key": "manual.anaquelista.pasillo",
          "source_key": "anaquelista.pasillo",
          "name": "Checklist diario de pasillo",
          "moment": "operacion",
          "frequency": "daily",
          "weekday": null,
          "month_day": null,
          "due_time": "23:00",
          "format_code": "Anexo A",
          "note": null,
          "per_event": false,
          "only_positions": null,
          "own_document": null,
          "items": [
            {
              "id": "p0",
              "label": "Lista de surtido entregada/atendida",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p1",
              "label": "Faltantes identificados",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": true
            },
            {
              "id": "p2",
              "label": "Producto rotado por fecha",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p3",
              "label": "Etiquetas correctas/actualizadas",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p4",
              "label": "Producto frenteado y estable",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p5",
              "label": "Pasillo sin cajas/restos",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p6",
              "label": "Área limpia",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p7",
              "label": "Revisión final de Encargada/Auxiliar",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            }
          ]
        },
        {
          "key": "manual.anaquelista.operacion",
          "source_key": "anaquelista.operacion",
          "name": "Operación de pasillo del turno",
          "moment": "operacion",
          "frequency": "daily",
          "weekday": null,
          "month_day": null,
          "due_time": "23:00",
          "format_code": "3.1 – 3.12",
          "note": "Autoevaluación del turno sobre los procedimientos del manual. No sustituye al procedimiento: confirma que se siguió. Lo que no se pueda afirmar se explica en las observaciones.",
          "per_event": false,
          "only_positions": null,
          "own_document": null,
          "items": [
            {
              "id": "p0",
              "label": "Recorrí el pasillo y registré los faltantes con descripción y código",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p1",
              "label": "Comparé el surtido recibido contra la etiqueta y la presentación del anaquel",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p2",
              "label": "Revisé la zona de restos antes de pedir o abrir una caja nueva",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p3",
              "label": "Comparé fechas al acomodar y dejé al frente lo de caducidad más próxima",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p4",
              "label": "Reporté a Encargada el producto próximo a caducar, sin decidir merma ni descuento",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p5",
              "label": "Revisé los cambios de precio del día y avisé de cualquier diferencia antes de que llegara a Caja",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p6",
              "label": "Retiré la señalización de promociones ya vencidas",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p7",
              "label": "Dejé el acomodo estable y las etiquetas legibles",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            }
          ]
        }
      ]
    },
    {
      "documento": "Manual Corporativo de Operación — Encargada de Sucursal PH",
      "codigo": null,
      "version": "1.2 · Septiembre 2026",
      "archivo": "20. Manual_Corporativo_Encargada_Sucursal_PH_MDDLA_2026.pdf",
      "puestos": [
        "encargado_sucursal",
        "auxiliar_encargado"
      ],
      "formatos_no_automatizados": [
        "C. Registro de incidencias de Encargada",
        "D. Seguimiento semanal de caducidades",
        "E. Control de traspasos entre sucursales",
        "F. Control de pedidos directos a proveedor",
        "G. Bitácora de diferencias de Caja",
        "H. Validación de competencia de respaldo",
        "I. Matriz rápida de escalamiento"
      ],
      "tareas": [
        {
          "key": "manual.encargado_sucursal.apertura",
          "source_key": "encargado-sucursal.apertura",
          "name": "Checklist de apertura de sucursal",
          "moment": "apertura",
          "frequency": "daily",
          "weekday": null,
          "month_day": null,
          "due_time": "23:00",
          "format_code": "Anexo A",
          "note": null,
          "per_event": false,
          "only_positions": null,
          "own_document": null,
          "items": [
            {
              "id": "p0",
              "label": "Alarma/candados retirados y acceso seguro",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p1",
              "label": "Sistemas y computadoras operativos",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p2",
              "label": "Cajas aperturadas/habilitadas",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p3",
              "label": "Área de cajas libre y ordenada",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p4",
              "label": "Piso frenteado y sin obstáculos",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p5",
              "label": "Bodega despejada y segura",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p6",
              "label": "Tareas del día asignadas en Mega Dulces Task",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            }
          ]
        },
        {
          "key": "manual.encargado_sucursal.cierre",
          "source_key": "encargado-sucursal.cierre",
          "name": "Checklist de cierre de sucursal",
          "moment": "cierre",
          "frequency": "daily",
          "weekday": null,
          "month_day": null,
          "due_time": "23:00",
          "format_code": "Anexo B",
          "note": null,
          "per_event": false,
          "only_positions": null,
          "own_document": null,
          "items": [
            {
              "id": "p0",
              "label": "Pasillos sin mercancía pendiente de acomodo",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p1",
              "label": "Cortes y retiros integrados",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p2",
              "label": "Diferencias de Caja reportadas",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": true
            },
            {
              "id": "p3",
              "label": "Factura global generada",
              "block": null,
              "evidence": "photos",
              "accepts_documents": true,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p4",
              "label": "Reportes de venta actualizados",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p5",
              "label": "Bodega y áreas críticas revisadas",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p6",
              "label": "Alarma/candados colocados",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            }
          ]
        },
        {
          "key": "manual.encargado_sucursal.operacion",
          "source_key": "encargado-sucursal.operacion",
          "name": "Operación de sucursal del turno",
          "moment": "operacion",
          "frequency": "daily",
          "weekday": null,
          "month_day": null,
          "due_time": "23:00",
          "format_code": "2.3",
          "note": "Prioridades diarias del puesto, en el orden que fija el manual. Lo que no se pueda afirmar se explica en las observaciones.",
          "per_event": false,
          "only_positions": [
            "encargado_sucursal"
          ],
          "own_document": null,
          "items": [
            {
              "id": "p0",
              "label": "Pendientes del turno anterior",
              "block": null,
              "evidence": "list",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p1",
              "label": "Disponibilidad de mercancía en piso",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p2",
              "label": "Objetivo de venta del día",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p3",
              "label": "Revisión de retiros durante el turno",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p4",
              "label": "Ausencias cubiertas sin dejar Caja, Recepción, Piso ni Bodega desatendidos",
              "block": null,
              "evidence": "text",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": true
            }
          ]
        },
        {
          "key": "manual.auxiliar_encargado.operacion",
          "source_key": "auxiliar-encargado.operacion",
          "name": "Operación del Auxiliar de Encargado",
          "moment": "operacion",
          "frequency": "daily",
          "weekday": null,
          "month_day": null,
          "due_time": "23:00",
          "format_code": null,
          "note": "Autoevaluación del turno sobre los procedimientos del manual. No sustituye al procedimiento: confirma que se siguió. Lo que no se pueda afirmar se explica en las observaciones.",
          "per_event": false,
          "only_positions": [
            "auxiliar_encargado"
          ],
          "own_document": {
            "documento": "Operación del Auxiliar de Encargado — derivado, pendiente de manual propio",
            "version": "0.1 · Septiembre 2026"
          },
          "items": [
            {
              "id": "p0",
              "label": "Recibí el turno y anoté lo que quedó pendiente del anterior",
              "block": null,
              "evidence": "list",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p1",
              "label": "Cubrí el puesto que quedó sin gente y anoté cuál y por cuánto tiempo",
              "block": null,
              "evidence": "text",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": true
            },
            {
              "id": "p2",
              "label": "Recorrí piso y bodega al menos una vez y levanté los faltantes con código",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p3",
              "label": "Apoyé en Caja cobrando siempre con mi usuario propio",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p4",
              "label": "Entregué a la Encargada los retiros que recibí, sin dejarlos expuestos",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p5",
              "label": "Revisé los cambios de precio del día antes de que llegaran a Caja",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p6",
              "label": "Escalé a la Encargada lo que no me toca decidir: mermas, descuentos, bajas y diferencias",
              "block": null,
              "evidence": "text",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": true
            },
            {
              "id": "p7",
              "label": "Dejé por escrito lo que la Encargada tiene que retomar al volver",
              "block": null,
              "evidence": "list",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            }
          ]
        }
      ]
    },
    {
      "documento": "Manual Corporativo de Operación — Bodeguero de Sucursal PH",
      "codigo": null,
      "version": "1.0 · Agosto 2026",
      "archivo": "18. Manual_Corporativo_Bodeguero_Sucursal_PH_MDDLA_2026.pdf",
      "puestos": [
        "bodeguero"
      ],
      "formatos_no_automatizados": [
        "16.3 Registro sugerido de incidencia"
      ],
      "tareas": [
        {
          "key": "manual.bodeguero_sucursal.inicio",
          "source_key": "bodeguero-sucursal.inicio",
          "name": "Checklist diario de inicio y surtido",
          "moment": "apertura",
          "frequency": "daily",
          "weekday": null,
          "month_day": null,
          "due_time": "23:00",
          "format_code": "16.1",
          "note": null,
          "per_event": false,
          "only_positions": null,
          "own_document": null,
          "items": [
            {
              "id": "p0",
              "label": "Listas de Anaquelistas/Promotoras recibidas",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p1",
              "label": "Prioridades de alta rotación identificadas",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p2",
              "label": "Restos revisados antes de abrir nuevas cajas",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p3",
              "label": "Faltantes marcados y comunicados",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": true
            },
            {
              "id": "p4",
              "label": "Pasillos de Bodega transitables",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p5",
              "label": "Área de excesos sin incidencias visibles",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": true
            }
          ]
        },
        {
          "key": "manual.bodeguero_sucursal.cierre",
          "source_key": "bodeguero-sucursal.cierre",
          "name": "Checklist de cierre de Bodega",
          "moment": "cierre",
          "frequency": "daily",
          "weekday": null,
          "month_day": null,
          "due_time": "23:00",
          "format_code": "16.2",
          "note": null,
          "per_event": false,
          "only_positions": null,
          "own_document": null,
          "items": [
            {
              "id": "p0",
              "label": "Carretas despejadas o correctamente ubicadas",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p1",
              "label": "Mercancía sin acomodar identificada y controlada",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p2",
              "label": "Restos ordenados",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p3",
              "label": "Producto dañado/caducado segregado y marcado",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p4",
              "label": "Pasillos libres",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p5",
              "label": "Tareas de aplicación completadas",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            }
          ]
        },
        {
          "key": "manual.bodeguero_sucursal.operacion",
          "source_key": "bodeguero-sucursal.operacion",
          "name": "Operación de Bodega del turno",
          "moment": "operacion",
          "frequency": "daily",
          "weekday": null,
          "month_day": null,
          "due_time": "23:00",
          "format_code": "4.1 – 10.1",
          "note": "Autoevaluación del turno sobre los procedimientos del manual. No sustituye al procedimiento: confirma que se siguió. Lo que no se pueda afirmar se explica en las observaciones.",
          "per_event": false,
          "only_positions": null,
          "own_document": null,
          "items": [
            {
              "id": "p0",
              "label": "Surtí contra lista física o solicitud autorizada",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p1",
              "label": "Verifiqué restos antes de abrir una caja nueva",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p2",
              "label": "Confirmé código, descripción, marca y presentación antes de entregar",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p3",
              "label": "Marqué en la lista lo no disponible y lo regresé para integrarlo a faltantes",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p4",
              "label": "Informé a Encargada las diferencias entre existencia de sistema y físico",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p5",
              "label": "Di prioridad al piso de venta cuando hubo necesidad crítica de surtido",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p6",
              "label": "Reporté producto próximo a caducar y lo mantuve visible para su rotación",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p7",
              "label": "Acomodé de inmediato las cajas que estaban fuera de su ubicación",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p8",
              "label": "Dejé pasillos y rutas de tránsito despejados",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            }
          ]
        }
      ]
    },
    {
      "documento": "Operación del Surtidor de Sucursal — derivado, pendiente de manual propio",
      "codigo": null,
      "version": "0.1 · Septiembre 2026",
      "archivo": "",
      "puestos": [
        "surtidor_tienda"
      ],
      "formatos_no_automatizados": [],
      "tareas": [
        {
          "key": "manual.surtidor_sucursal.operacion",
          "source_key": "surtidor-sucursal.operacion",
          "name": "Operación de surtido del turno",
          "moment": "operacion",
          "frequency": "daily",
          "weekday": null,
          "month_day": null,
          "due_time": "23:00",
          "format_code": null,
          "note": "Autoevaluación del turno sobre los procedimientos del manual. No sustituye al procedimiento: confirma que se siguió. Lo que no se pueda afirmar se explica en las observaciones.",
          "per_event": false,
          "only_positions": null,
          "own_document": null,
          "items": [
            {
              "id": "p0",
              "label": "Surtí las listas de pasillo que recibí",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p1",
              "label": "Confirmé código, descripción y presentación contra el físico antes de subirlo al pasillo",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p2",
              "label": "Conté la cantidad contra la lista, no la estimé por caja",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p3",
              "label": "Revisé los restos antes de abrir una caja nueva del mismo producto",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p4",
              "label": "Marqué en la lista lo que no había, sin sustituirlo por otro código",
              "block": null,
              "evidence": "list",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p5",
              "label": "Reporté el producto dañado o próximo a caducar en vez de subirlo al pasillo",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p6",
              "label": "Dejé el pasillo transitable y sin cajas ni restos al terminar",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p7",
              "label": "Atendí primero los pasillos de alta rotación y las listas marcadas como urgentes",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p8",
              "label": "Devolví las listas atendidas y anoté lo que quedó sin surtir y por qué",
              "block": null,
              "evidence": "text",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": true
            }
          ]
        }
      ]
    },
    {
      "documento": "Operación de kileo y empaque — derivado, pendiente de manual propio",
      "codigo": null,
      "version": "0.1 · Septiembre 2026",
      "archivo": "",
      "puestos": [
        "kileadora",
        "empaquetador"
      ],
      "formatos_no_automatizados": [],
      "tareas": [
        {
          "key": "manual.kileadora.operacion",
          "source_key": "kileadora.operacion",
          "name": "Operación de kileo del turno",
          "moment": "operacion",
          "frequency": "daily",
          "weekday": null,
          "month_day": null,
          "due_time": "23:00",
          "format_code": null,
          "note": "Autoevaluación del turno sobre los procedimientos del manual. No sustituye al procedimiento: confirma que se siguió. Lo que no se pueda afirmar se explica en las observaciones.",
          "per_event": false,
          "only_positions": null,
          "own_document": null,
          "items": [
            {
              "id": "p0",
              "label": "Revisé que la báscula estuviera en cero y con su verificación vigente antes de pesar",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p1",
              "label": "Usé cofia, guantes y utensilio limpio para manipular el producto a granel",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p2",
              "label": "Revisé la caducidad del granel antes de abrir y solo empaqué producto dentro de fecha",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p3",
              "label": "Etiqueté cada bolsa con su peso, precio y fecha de empaque, legibles",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p4",
              "label": "Comparé el precio de la etiqueta contra la lista vigente del día y avisé de cualquier diferencia antes de que llegara a Caja",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p5",
              "label": "Mantuve los recipientes tapados y rotulados, sin mezclar producto de dos lotes",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p6",
              "label": "Repuse el exhibidor de bolsas kileadas y retiré las que ya no estaban en condiciones de venta",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p7",
              "label": "Registré la merma y los restos del día en vez de reintegrarlos al granel",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p8",
              "label": "Dejé el área, la báscula y los utensilios limpios y sin producto expuesto al terminar",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            }
          ]
        }
      ]
    },
    {
      "documento": "Manual Corporativo de Operación — Almacenista de Sucursal (Integrado)",
      "codigo": "MDDLA-OP-ALM-SUC-001",
      "version": "1.1 · Septiembre 2026",
      "archivo": "19. Manual_Corporativo_Almacenista INTEGRADO_de_Sucursal_MDDLA_2026.pdf",
      "puestos": [
        "almacenista"
      ],
      "formatos_no_automatizados": [
        "Anexo 2. Control de caducidades y rotación",
        "Anexo 3. Control de restos y excesos",
        "Anexo 4. Bitácora de diferencias físicas",
        "Anexo 5. Mapa de ubicaciones del almacén",
        "Anexo 7. Entrega-recepción de ausencia o cambio de responsable",
        "Anexo 8. Matriz de funciones por sucursal",
        "Anexo 9. Tablero mensual de indicadores"
      ],
      "tareas": [
        {
          "key": "manual.almacenista_sucursal.diario",
          "source_key": "almacenista-sucursal.diario",
          "name": "Checklist diario de almacén",
          "moment": "operacion",
          "frequency": "daily",
          "weekday": null,
          "month_day": null,
          "due_time": "23:00",
          "format_code": "Anexo 1",
          "note": null,
          "per_event": false,
          "only_positions": null,
          "own_document": null,
          "items": [
            {
              "id": "p0",
              "label": "Pasillos libres",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p1",
              "label": "Mercancía en ubicación correcta",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p2",
              "label": "Restos revisados",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p3",
              "label": "Excesos identificados",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p4",
              "label": "Producto fecha corta identificado",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p5",
              "label": "Estibas estables",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p6",
              "label": "Producto de limpieza separado de alimentos",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p7",
              "label": "Chocolate/producto sensible en zona adecuada",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p8",
              "label": "Mercancía pendiente identificada",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            }
          ]
        },
        {
          "key": "manual.almacenista_sucursal.seguridad",
          "source_key": "almacenista-sucursal.seguridad",
          "name": "Checklist de seguridad de almacén",
          "moment": "operacion",
          "frequency": "weekly",
          "weekday": 1,
          "month_day": null,
          "due_time": "23:00",
          "format_code": "Anexo 6",
          "note": "El anexo pide estado y acción requerida por elemento. Lo que no cumpla se reporta con su acción y responsable en las observaciones.",
          "per_event": false,
          "only_positions": null,
          "own_document": null,
          "items": [
            {
              "id": "p0",
              "label": "Estibas estables y dentro de límite",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p1",
              "label": "Pasillos despejados",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p2",
              "label": "Sin goteras ni humedad",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p3",
              "label": "Producto pesado fuera de altura",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p4",
              "label": "Separación de químicos y productos con olor",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            }
          ]
        },
        {
          "key": "manual.almacenista_sucursal.operacion",
          "source_key": "almacenista-sucursal.operacion",
          "name": "Operación de almacén del turno",
          "moment": "operacion",
          "frequency": "daily",
          "weekday": null,
          "month_day": null,
          "due_time": "23:00",
          "format_code": "3.2 – 3.8",
          "note": "Autoevaluación del turno sobre los procedimientos del manual. No sustituye al procedimiento: confirma que se siguió. Lo que no se pueda afirmar se explica en las observaciones.",
          "per_event": false,
          "only_positions": null,
          "own_document": null,
          "items": [
            {
              "id": "p0",
              "label": "Revisé pendientes del día anterior y mercancía por acomodar",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p1",
              "label": "Validé producto, etiqueta, cantidad y estado físico antes de acomodar",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p2",
              "label": "Detuve el acomodo y reporté cuando una etiqueta no coincidía con el producto",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p3",
              "label": "Separé y reporté daño, humedad o producto no conforme antes de mezclarlo",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p4",
              "label": "Comparé caducidades contra la existencia previa al acomodar",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p5",
              "label": "No entregué mercancía a otras sucursales o áreas sin respaldo ni autorización",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            }
          ]
        }
      ]
    },
    {
      "documento": "Manual Corporativo de Operación — Recepción de Mercancía PH",
      "codigo": "RM-PH",
      "version": "1.0 · 2026",
      "archivo": "10. Manual_Corporativo_Recepcion_Mercancia_PH_COMPLETO_CON_ANEXOS.pdf",
      "puestos": [
        "recepcion_mercancia_sucursal"
      ],
      "formatos_no_automatizados": [
        "RM-PH-01 Agenda de proveedores y capacidad de recepción",
        "RM-PH-03 Formato de diferencias de recepción",
        "RM-PH-04 Registro de producto dañado o fecha corta",
        "RM-PH-05 Acuse de transferencia Recepción–Almacén",
        "RM-PH-07 Incidencia de etiquetado",
        "RM-PH-08 Duplicidad",
        "RM-PH-09 Devolución",
        "RM-PH-10 Registro de tiempos y volumen"
      ],
      "tareas": [
        {
          "key": "manual.recepcion_mercancia_sucursal.recepcion",
          "source_key": "recepcion-mercancia-sucursal.recepcion",
          "name": "Checklist de recepción de mercancía",
          "moment": "operacion",
          "frequency": "daily",
          "weekday": null,
          "month_day": null,
          "due_time": "23:00",
          "format_code": "RM-PH-02",
          "note": "El manual lo llena en CADA recepción. Aquí se entrega una vez al día como registro consolidado de la jornada.",
          "per_event": true,
          "only_positions": null,
          "own_document": null,
          "items": [
            {
              "id": "p0",
              "label": "Proveedor identificado",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p1",
              "label": "Factura o remisión recibida",
              "block": null,
              "evidence": "photos",
              "accepts_documents": true,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p2",
              "label": "Destino validado",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p3",
              "label": "Compra/Drive validado",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p4",
              "label": "Unidad de medida verificada",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p5",
              "label": "Cantidad conciliada",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p6",
              "label": "Estado físico revisado",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p7",
              "label": "Caducidad revisada",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p8",
              "label": "Código y presentación verificados",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p9",
              "label": "Etiqueta colocada",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p10",
              "label": "Entrada registrada en Kepler",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": true,
              "requires_comment": false
            },
            {
              "id": "p11",
              "label": "Póliza generada",
              "block": null,
              "evidence": "photos",
              "accepts_documents": true,
              "requires_amount": false,
              "requires_folio": true,
              "requires_comment": false
            },
            {
              "id": "p12",
              "label": "Liberación autorizada",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            }
          ]
        },
        {
          "key": "manual.recepcion_mercancia_sucursal.seguridad",
          "source_key": "recepcion-mercancia-sucursal.seguridad",
          "name": "Checklist de seguridad y orden del área",
          "moment": "operacion",
          "frequency": "daily",
          "weekday": null,
          "month_day": null,
          "due_time": "23:00",
          "format_code": "RM-PH-11",
          "note": null,
          "per_event": false,
          "only_positions": null,
          "own_document": null,
          "items": [
            {
              "id": "p0",
              "label": "Área despejada",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p1",
              "label": "Pasillos libres",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p2",
              "label": "Mercancía segregada",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p3",
              "label": "Altura segura",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p4",
              "label": "Carretas en buen estado",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p5",
              "label": "Calzado adecuado",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p6",
              "label": "Cámaras funcionales",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p7",
              "label": "Incidencias reportadas",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": true
            }
          ]
        },
        {
          "key": "manual.recepcion_mercancia_sucursal.cierre",
          "source_key": "recepcion-mercancia-sucursal.cierre",
          "name": "Cierre diario de recepción",
          "moment": "cierre",
          "frequency": "daily",
          "weekday": null,
          "month_day": null,
          "due_time": "23:00",
          "format_code": "RM-PH-12",
          "note": null,
          "per_event": false,
          "only_positions": null,
          "own_document": null,
          "items": [
            {
              "id": "p0",
              "label": "Recepciones cerradas",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p1",
              "label": "Pendientes de compra identificados",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p2",
              "label": "Notas de crédito atendidas",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p3",
              "label": "Devoluciones registradas",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p4",
              "label": "Correcciones de etiqueta aplicadas",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p5",
              "label": "Documentos por entregar concentrados",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p6",
              "label": "Área ordenada",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            }
          ]
        },
        {
          "key": "manual.recepcion_mercancia_sucursal.carpeta_prevencion",
          "source_key": "recepcion-mercancia-sucursal.carpeta-prevencion",
          "name": "Control semanal de carpeta para Prevención",
          "moment": "administrativo",
          "frequency": "weekly",
          "weekday": 5,
          "month_day": null,
          "due_time": "23:00",
          "format_code": "RM-PH-06",
          "note": null,
          "per_event": false,
          "only_positions": null,
          "own_document": null,
          "items": [
            {
              "id": "p0",
              "label": "Folios y compras de la semana integrados",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p1",
              "label": "Entradas registradas",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p2",
              "label": "Pólizas integradas",
              "block": null,
              "evidence": "photos",
              "accepts_documents": true,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p3",
              "label": "Facturas y vales completos",
              "block": null,
              "evidence": "photos",
              "accepts_documents": true,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p4",
              "label": "Correcciones aplicadas y cerradas",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p5",
              "label": "Carpeta entregada a Prevención",
              "block": null,
              "evidence": "photos",
              "accepts_documents": true,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            }
          ]
        }
      ]
    },
    {
      "documento": "Manual Corporativo de Operación — Checador de CEDIS",
      "codigo": "CEDIS-CH",
      "version": "1.0 · 2026",
      "archivo": "8. Manual_Corporativo_Checador_CEDIS_COMPLETO_CON_ANEXOS.pdf",
      "puestos": [
        "checador",
        "checador_cedis"
      ],
      "formatos_no_automatizados": [
        "CEDIS-CH-02 Formato de diferencias de pedido",
        "CEDIS-CH-03 Control de incidencias de checado",
        "CEDIS-CH-04 Registro diario de cajas y pedidos revisados",
        "CEDIS-CH-05 Control de errores e indicadores"
      ],
      "tareas": [
        {
          "key": "manual.checador.checado_pedido",
          "source_key": "checador.checado-pedido",
          "name": "Checklist de checado de pedido",
          "moment": "operacion",
          "frequency": "daily",
          "weekday": null,
          "month_day": null,
          "due_time": "23:00",
          "format_code": "CEDIS-CH-01",
          "note": "El manual lo aplica por CADA pedido. Aquí se entrega una vez al día como registro consolidado; un \"No\" en código, cantidad, destino, mercancía sin etiqueta o diferencia sin resolver impide liberar la carga.",
          "per_event": true,
          "only_positions": null,
          "own_document": null,
          "items": [
            {
              "id": "p0",
              "label": "Pedido corresponde a la sucursal indicada.",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p1",
              "label": "Ticket y etiquetas corresponden al mismo destino.",
              "block": null,
              "evidence": "photos",
              "accepts_documents": true,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p2",
              "label": "Código de producto coincide con mercancía física.",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p3",
              "label": "Descripción/presentación coincide con la caja.",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p4",
              "label": "Cantidad física coincide con ticket.",
              "block": null,
              "evidence": "photos",
              "accepts_documents": true,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p5",
              "label": "Cajas y camas de tarima fueron contadas.",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p6",
              "label": "Se revisaron frente, laterales, parte posterior e interior visible de la tarima.",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p7",
              "label": "No existen cajas sin etiqueta de checado.",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p8",
              "label": "No existe mercancía de otra sucursal mezclada.",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p9",
              "label": "Producto dañado fue separado o escalado.",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p10",
              "label": "Producto próximo a caducar fue reportado cuando aplique.",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p11",
              "label": "Diferencias detectadas fueron corregidas o documentadas.",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": true
            },
            {
              "id": "p12",
              "label": "Pedido quedó acomodado para carga sin obstrucciones.",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p13",
              "label": "No queda mercancía pendiente de revisión asociada al pedido.",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            }
          ]
        },
        {
          "key": "manual.checador.liberacion_carga",
          "source_key": "checador.liberacion-carga",
          "name": "Liberación de pedido para carga",
          "moment": "operacion",
          "frequency": "daily",
          "weekday": null,
          "month_day": null,
          "due_time": "23:00",
          "format_code": "CEDIS-CH-06",
          "note": "Con este formato el Checador confirma que terminó su revisión y transfiere el pedido a carga. No se libera con una diferencia crítica pendiente: la excepción la autoriza y documenta la Jefatura de CEDIS.",
          "per_event": true,
          "only_positions": null,
          "own_document": null,
          "items": [
            {
              "id": "p0",
              "label": "Código, descripción y cantidad verificados contra ticket.",
              "block": null,
              "evidence": "photos",
              "accepts_documents": true,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p1",
              "label": "Todas las cajas fueron revisadas y cuentan con etiqueta de checado.",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p2",
              "label": "No existe mercancía de otra sucursal dentro de la carga.",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p3",
              "label": "Diferencias detectadas quedaron corregidas/cerradas.",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": true
            },
            {
              "id": "p4",
              "label": "Producto dañado o no conforme fue retirado/escalado.",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": true
            },
            {
              "id": "p5",
              "label": "Pedido está físicamente disponible y acomodado para carga.",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            }
          ]
        },
        {
          "key": "manual.checador.seguridad_area",
          "source_key": "checador.seguridad-area",
          "name": "Checklist de seguridad, orden y limpieza del área",
          "moment": "cierre",
          "frequency": "daily",
          "weekday": null,
          "month_day": null,
          "due_time": "23:00",
          "format_code": "CEDIS-CH-07",
          "note": "El anexo se revisa al inicio y al cierre del turno.",
          "per_event": false,
          "only_positions": null,
          "own_document": null,
          "items": [
            {
              "id": "p0",
              "label": "Pasillos libres de cajas, etiquetas y residuos.",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p1",
              "label": "Tarimas colocadas sin bloquear rutas de tránsito.",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p2",
              "label": "Patín en condición visible adecuada y estacionado de forma segura.",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p3",
              "label": "Calzado/equipo de protección requerido disponible y utilizado.",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p4",
              "label": "No se manipulan cargas que excedan capacidad segura de la persona/equipo.",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p5",
              "label": "Cajas inestables o dañadas fueron corregidas antes de movimiento.",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p6",
              "label": "Área de checado despejada y residuos de etiquetas retirados.",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p7",
              "label": "Se reportaron golpes, esguinces, casi accidentes o condiciones inseguras.",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            }
          ]
        }
      ]
    },
    {
      "documento": "Manual Corporativo de Operación — Auxiliar de CEDIS",
      "codigo": "CEDIS-AUX",
      "version": "1.0 · 2026",
      "archivo": "13. Manual_Corporativo_Auxiliar_CEDIS.pdf",
      "puestos": [
        "auxiliar_cedis"
      ],
      "formatos_no_automatizados": [
        "CEDIS-AUX-02 Asignación diaria de personal",
        "CEDIS-AUX-03 Control de recepción y repartición",
        "CEDIS-AUX-04 Registro de diferencias de recepción",
        "CEDIS-AUX-05 Control de surtido por sucursal",
        "CEDIS-AUX-06 Liberación a embarque",
        "CEDIS-AUX-07 Bitácora de saturación y capacidad",
        "CEDIS-AUX-09 Reporte de condición insegura / casi accidente",
        "CEDIS-AUX-10 Control de inventario y diferencias",
        "CEDIS-AUX-11 Contingencia por falla de Kepler"
      ],
      "tareas": [
        {
          "key": "manual.auxiliar_cedis.jornada",
          "source_key": "auxiliar-cedis.jornada",
          "name": "Checklist de inicio y cierre de jornada",
          "moment": "cierre",
          "frequency": "daily",
          "weekday": null,
          "month_day": null,
          "due_time": "23:00",
          "format_code": "CEDIS-AUX-01",
          "note": null,
          "per_event": false,
          "only_positions": null,
          "own_document": null,
          "items": [
            {
              "id": "p0",
              "label": "Personal disponible y ausencias registradas",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p1",
              "label": "Descargas esperadas identificadas",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p2",
              "label": "Cargas por sucursal definidas",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p3",
              "label": "Pasillos pendientes identificados",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p4",
              "label": "Mercancía por repartir controlada",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p5",
              "label": "Orden y limpieza al cierre",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p6",
              "label": "Incidencias escaladas",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": true
            }
          ]
        },
        {
          "key": "manual.auxiliar_cedis.montacargas",
          "source_key": "auxiliar-cedis.montacargas",
          "name": "Checklist de seguridad de montacargas y maniobras",
          "moment": "operacion",
          "frequency": "daily",
          "weekday": null,
          "month_day": null,
          "due_time": "23:00",
          "format_code": "CEDIS-AUX-08",
          "note": null,
          "per_event": false,
          "only_positions": null,
          "own_document": null,
          "items": [
            {
              "id": "p0",
              "label": "Operador autorizado",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p1",
              "label": "Zona despejada",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p2",
              "label": "Sin celular ni distracciones",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p3",
              "label": "Tarimas íntegras",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p4",
              "label": "Carga estable",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p5",
              "label": "Pasillos libres",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p6",
              "label": "Incidencias reportadas",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": true
            }
          ]
        },
        {
          "key": "manual.auxiliar_cedis.operacion",
          "source_key": "auxiliar-cedis.operacion",
          "name": "Operación de CEDIS del turno",
          "moment": "operacion",
          "frequency": "daily",
          "weekday": null,
          "month_day": null,
          "due_time": "23:00",
          "format_code": "3.1 – 3.9",
          "note": "Autoevaluación del turno sobre los procedimientos del manual. No sustituye al procedimiento: confirma que se siguió. Lo que no se pueda afirmar se explica en las observaciones.",
          "per_event": false,
          "only_positions": null,
          "own_document": null,
          "items": [
            {
              "id": "p0",
              "label": "Asigné actividades al personal al inicio de la jornada",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p1",
              "label": "La recepción y descarga se hizo con conteo, no solo contra documento",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p2",
              "label": "La repartición por sucursal quedó validada",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p3",
              "label": "Vigilé la capacidad del acomodo para no bloquear pasillos",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p4",
              "label": "El surtido interno salió contra instrucción autorizada",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p5",
              "label": "Las diferencias de checado se corrigieron antes de liberar",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p6",
              "label": "El embarque salió con su documentación completa",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p7",
              "label": "Las diferencias de inventario quedaron escaladas",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            }
          ]
        }
      ]
    },
    {
      "documento": "Manual Corporativo de Operación — Recepción de Mercancía CEDIS",
      "codigo": null,
      "version": "1.0 · Agosto 2026",
      "archivo": "17. Manual_Corporativo_Recepcion_de_Mercancia_CEDIS_MDDLA_2026.pdf",
      "puestos": [
        "receptor_mercancia"
      ],
      "formatos_no_automatizados": [
        "Anexo B. Registro sugerido de incidencias de proveedor",
        "Anexo C. Validación de capacitación de respaldo"
      ],
      "tareas": [
        {
          "key": "manual.recepcion_producto_cedis.recepcion",
          "source_key": "recepcion-producto-cedis.recepcion",
          "name": "Checklist de recepción de mercancía",
          "moment": "operacion",
          "frequency": "daily",
          "weekday": null,
          "month_day": null,
          "due_time": "23:00",
          "format_code": "Anexo A",
          "note": "El manual lo llena en cada recepción. Aquí se entrega una vez al día como registro consolidado de la jornada.",
          "per_event": true,
          "only_positions": null,
          "own_document": null,
          "items": [
            {
              "id": "p0",
              "label": "Existe factura/remisión y vale de recepción",
              "block": null,
              "evidence": "photos",
              "accepts_documents": true,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p1",
              "label": "Proveedor/unidad corresponden a la recepción prevista",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p2",
              "label": "Producto y código corresponden al documento",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p3",
              "label": "Presentación/gramaje/unidad por cartón correctos",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p4",
              "label": "Cantidad física conciliada",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p5",
              "label": "Caducidad revisada cuando aplica",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p6",
              "label": "Condición física aceptable",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p7",
              "label": "Etiquetas emitidas y colocadas",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p8",
              "label": "Repartición por sucursal validada cuando aplica",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p9",
              "label": "Incidencias documentadas y autorizadas",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": true
            },
            {
              "id": "p10",
              "label": "Vale entregado a Entradas y Salidas",
              "block": null,
              "evidence": "photos",
              "accepts_documents": true,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            }
          ]
        },
        {
          "key": "manual.recepcion_producto_cedis.operacion",
          "source_key": "recepcion-producto-cedis.operacion",
          "name": "Operación de recepción del turno",
          "moment": "operacion",
          "frequency": "daily",
          "weekday": null,
          "month_day": null,
          "due_time": "23:00",
          "format_code": "3.1 – 3.11",
          "note": "Autoevaluación del turno sobre los procedimientos del manual. No sustituye al procedimiento: confirma que se siguió. Lo que no se pueda afirmar se explica en las observaciones.",
          "per_event": false,
          "only_positions": null,
          "own_document": null,
          "items": [
            {
              "id": "p0",
              "label": "Preparé la recepción con el vale y la documentación antes de la descarga",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p1",
              "label": "Identifiqué y conté la mercancía durante la descarga, sin dar por buena la remisión",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p2",
              "label": "Emití y coloqué las etiquetas del producto recibido",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p3",
              "label": "Documenté las incidencias del proveedor y las escalé cuando correspondía",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p4",
              "label": "Cerré la recepción y entregué el vale a Entradas y Salidas",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p5",
              "label": "Las maniobras de descarga se hicieron sin exceder la capacidad segura del equipo",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            }
          ]
        }
      ]
    },
    {
      "documento": "Manual Corporativo de Operación — Entradas y Salidas de Almacén CEDIS",
      "codigo": null,
      "version": "1.0 · Agosto 2026",
      "archivo": "16. Manual_Corporativo_Entradas_y_Salidas_Almacen_CEDIS_MDDLA_2026.pdf",
      "puestos": [
        "entradas_salidas_cedis"
      ],
      "formatos_no_automatizados": [
        "Anexo B. Registro de diferencia de recepción",
        "Anexo D. Control de pólizas Kepler"
      ],
      "tareas": [
        {
          "key": "manual.entradas_salidas_cedis.entrada_proveedor",
          "source_key": "entradas-salidas-cedis.entrada-proveedor",
          "name": "Checklist de entrada de proveedor",
          "moment": "operacion",
          "frequency": "daily",
          "weekday": null,
          "month_day": null,
          "due_time": "23:00",
          "format_code": "Anexo A",
          "note": "El manual lo llena por cada entrada de proveedor. Aquí se entrega una vez al día como registro consolidado.",
          "per_event": true,
          "only_positions": null,
          "own_document": null,
          "items": [
            {
              "id": "p0",
              "label": "Factura/remisión recibida",
              "block": null,
              "evidence": "photos",
              "accepts_documents": true,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p1",
              "label": "Orden de compra localizada",
              "block": null,
              "evidence": "photos",
              "accepts_documents": true,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p2",
              "label": "Productos/cantidades cotejados",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p3",
              "label": "Mercancía no solicitada consultada con Compras",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p4",
              "label": "Vale generado por factura",
              "block": null,
              "evidence": "photos",
              "accepts_documents": true,
              "requires_amount": false,
              "requires_folio": true,
              "requires_comment": false
            },
            {
              "id": "p5",
              "label": "Repartición entregada",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p6",
              "label": "Recepción física concluida",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p7",
              "label": "Diferencias documentadas/resueltas",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": true
            },
            {
              "id": "p8",
              "label": "Precios validados",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p9",
              "label": "Entrada de almacén registrada",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p10",
              "label": "Póliza Kepler generada",
              "block": null,
              "evidence": "photos",
              "accepts_documents": true,
              "requires_amount": false,
              "requires_folio": true,
              "requires_comment": false
            },
            {
              "id": "p11",
              "label": "Póliza y factura entregadas a Compras",
              "block": null,
              "evidence": "photos",
              "accepts_documents": true,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            }
          ]
        },
        {
          "key": "manual.entradas_salidas_cedis.salida_sucursal",
          "source_key": "entradas-salidas-cedis.salida-sucursal",
          "name": "Checklist de salida a sucursal",
          "moment": "operacion",
          "frequency": "daily",
          "weekday": null,
          "month_day": null,
          "due_time": "23:00",
          "format_code": "Anexo C",
          "note": "El manual lo llena por cada salida. Aquí se entrega una vez al día como registro consolidado.",
          "per_event": true,
          "only_positions": null,
          "own_document": null,
          "items": [
            {
              "id": "p0",
              "label": "Sucursal destino confirmada",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p1",
              "label": "Cotizaciones/tickets recibidos de Checado",
              "block": null,
              "evidence": "photos",
              "accepts_documents": true,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p2",
              "label": "Embarques confirma mercancía que viajará",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p3",
              "label": "Tickets procesados sin bloqueos pendientes",
              "block": null,
              "evidence": "photos",
              "accepts_documents": true,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p4",
              "label": "Existencia suficiente validada",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p5",
              "label": "Traspaso/ticket de sucursal generado",
              "block": null,
              "evidence": "photos",
              "accepts_documents": true,
              "requires_amount": false,
              "requires_folio": true,
              "requires_comment": false
            },
            {
              "id": "p6",
              "label": "Copias y anexos integrados",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p7",
              "label": "Documentación entregada a unidad/Logística",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p8",
              "label": "Incidencia pendiente autorizada por Jefatura (si aplica)",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": true
            },
            {
              "id": "p9",
              "label": "Evidencia archivada",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            }
          ]
        },
        {
          "key": "manual.entradas_salidas_cedis.operacion",
          "source_key": "entradas-salidas-cedis.operacion",
          "name": "Operación administrativa del turno",
          "moment": "operacion",
          "frequency": "daily",
          "weekday": null,
          "month_day": null,
          "due_time": "23:00",
          "format_code": "3.1 – 3.8",
          "note": "Autoevaluación del turno sobre los procedimientos del manual. No sustituye al procedimiento: confirma que se siguió. Lo que no se pueda afirmar se explica en las observaciones.",
          "per_event": false,
          "only_positions": null,
          "own_document": null,
          "items": [
            {
              "id": "p0",
              "label": "Comparé la documentación recibida contra la orden de compra",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p1",
              "label": "Elaboré el vale y la repartición por sucursal",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p2",
              "label": "Registré la entrada al almacén de lo recibido",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p3",
              "label": "Generé la póliza definitiva en Kepler",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p4",
              "label": "Los traspasos a sucursal quedaron cobrados o autorizados",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p5",
              "label": "Las devoluciones de sucursales quedaron documentadas",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p6",
              "label": "Consulté a Compras la mercancía no solicitada, sin darle entrada",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            }
          ]
        }
      ]
    },
    {
      "documento": "Manual Corporativo de Operación — Supervisor Operativo TLMK La Piedad",
      "codigo": null,
      "version": "1.0 · 2026",
      "archivo": "2. Manual_Corporativo_Supervisor_Operativo_TLMK_La_Piedad.pdf",
      "puestos": [
        "encargado_operaciones"
      ],
      "formatos_no_automatizados": [
        "Anexo B. Control de pedidos y rutas",
        "Anexo C. Registro de errores",
        "Anexo D. Formato de devolución",
        "Anexo E. Reporte semanal"
      ],
      "tareas": [
        {
          "key": "manual.coordinador_operaciones_zona.diario",
          "source_key": "coordinador-operaciones-zona.diario",
          "name": "Checklist diario del Supervisor",
          "moment": "cierre",
          "frequency": "daily",
          "weekday": null,
          "month_day": null,
          "due_time": "23:00",
          "format_code": "Anexo A",
          "note": null,
          "per_event": false,
          "only_positions": null,
          "own_document": null,
          "items": [
            {
              "id": "p0",
              "label": "Revisé pedidos de sucursal y TLMK.",
              "block": "Inicio",
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p1",
              "label": "Identifiqué pedidos creados o bloqueados.",
              "block": "Inicio",
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p2",
              "label": "Definí prioridades y asigné personal.",
              "block": "Inicio",
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p3",
              "label": "Cada pedido está en carro o carreta separada.",
              "block": "Surtido",
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p4",
              "label": "Pedidos urgentes cuentan con instrucción clara.",
              "block": "Surtido",
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p5",
              "label": "Todos los pedidos fueron verificados.",
              "block": "Checado",
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p6",
              "label": "No hay diferencias abiertas.",
              "block": "Checado",
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": true
            },
            {
              "id": "p7",
              "label": "Cajas, paqueterías y secuencia están completas.",
              "block": "Corrección",
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p8",
              "label": "La mercancía coincide con la guía.",
              "block": "Guía",
              "evidence": "photos",
              "accepts_documents": true,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p9",
              "label": "La unidad se entregó a Logística.",
              "block": "Carga",
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p10",
              "label": "Registré devoluciones e incidencias.",
              "block": "Carga",
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p11",
              "label": "Comuniqué retrasos y causas.",
              "block": "Cierre",
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            }
          ]
        }
      ]
    },
    {
      "documento": "Manual Corporativo de Operación — Analista de Facturación y Control Documental TLMK",
      "codigo": "MDDLA-TLMK-FAC-01",
      "version": "1.0 · 2026",
      "archivo": "3. Manual_Corporativo_Analista_Facturacion_Control_Documental_TLMK_MDDLA.pdf",
      "puestos": [
        "facturador"
      ],
      "formatos_no_automatizados": [
        "Anexo 2. Bitácora de incidencias",
        "Anexo 3. Bitácora de cancelaciones y refacturaciones",
        "Anexo 5. Matriz de cobertura del puesto"
      ],
      "tareas": [
        {
          "key": "manual.facturacion.diario",
          "source_key": "facturacion.diario",
          "name": "Checklist diario del puesto",
          "moment": "cierre",
          "frequency": "daily",
          "weekday": null,
          "month_day": null,
          "due_time": "23:00",
          "format_code": "Anexo 1",
          "note": null,
          "per_event": false,
          "only_positions": null,
          "own_document": null,
          "items": [
            {
              "id": "p0",
              "label": "Generar reporte de facturas del día anterior",
              "block": "Inicio",
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p1",
              "label": "Revisar pendientes, devoluciones o errores reportados",
              "block": "Inicio",
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p2",
              "label": "Confirmar autorización de pedidos",
              "block": "Operación",
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p3",
              "label": "Corregir negados y sustituciones",
              "block": "Operación",
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p4",
              "label": "Entregar pedidos corregidos a checado",
              "block": "Operación",
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p5",
              "label": "Validar cliente, importe y tipo de comprobante",
              "block": "Facturación",
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p6",
              "label": "Verificar datos fiscales y códigos SAT",
              "block": "Facturación",
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p7",
              "label": "Asignar transporte y generar guía",
              "block": "Ruta",
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p8",
              "label": "Confirmar documentación completa contra hoja de carga",
              "block": "Ruta",
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p9",
              "label": "Archivar tickets, facturas y remisiones",
              "block": "Cierre",
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p10",
              "label": "Entregar reporte y carpeta a Crédito y Cobranza",
              "block": "Cierre",
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            }
          ]
        },
        {
          "key": "manual.facturacion.liberacion_ruta",
          "source_key": "facturacion.liberacion-ruta",
          "name": "Checklist de liberación documental de ruta",
          "moment": "operacion",
          "frequency": "daily",
          "weekday": null,
          "month_day": null,
          "due_time": "23:00",
          "format_code": "Anexo 4",
          "note": "El manual lo llena por cada ruta o guía. Aquí se entrega una vez al día como registro consolidado.",
          "per_event": true,
          "only_positions": null,
          "own_document": null,
          "items": [
            {
              "id": "p0",
              "label": "Factura o remisión integrada",
              "block": null,
              "evidence": "photos",
              "accepts_documents": true,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p1",
              "label": "Ticket de surtido integrado",
              "block": null,
              "evidence": "photos",
              "accepts_documents": true,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p2",
              "label": "Ticket de checado integrado",
              "block": null,
              "evidence": "photos",
              "accepts_documents": true,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p3",
              "label": "Documento entregado a la ruta",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            }
          ]
        }
      ]
    },
    {
      "documento": "Manual Corporativo de Operación — Jefatura de Compras",
      "codigo": "MDDLA-MCO-COM-01",
      "version": "1.0 · 2026",
      "archivo": "1. Manual_Corporativo_Jefa_de_Compras_MDDLA.pdf",
      "puestos": [
        "gerente_compras"
      ],
      "formatos_no_automatizados": [
        "Anexo B. Formato de seguimiento de órdenes"
      ],
      "tareas": [
        {
          "key": "manual.coordinacion_compras.diario",
          "source_key": "coordinacion-compras.diario",
          "name": "Checklist diario de la Jefatura de Compras",
          "moment": "cierre",
          "frequency": "daily",
          "weekday": null,
          "month_day": null,
          "due_time": "23:00",
          "format_code": "Anexo A",
          "note": null,
          "per_event": false,
          "only_positions": null,
          "own_document": null,
          "items": [
            {
              "id": "p0",
              "label": "Faltantes y riesgos críticos revisados.",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": true
            },
            {
              "id": "p1",
              "label": "Pedidos vencidos o incompletos atendidos.",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p2",
              "label": "Sugerencias de compra validadas.",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p3",
              "label": "Presupuesto y prioridades coordinados con Finanzas.",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p4",
              "label": "Recepciones y diferencias críticas resueltas.",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": true
            },
            {
              "id": "p5",
              "label": "Excedentes y baja rotación con acción vigente.",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p6",
              "label": "Cambios de precio o condiciones documentados.",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p7",
              "label": "Facturas críticas conciliadas.",
              "block": null,
              "evidence": "photos",
              "accepts_documents": true,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p8",
              "label": "Compromisos con proveedores actualizados.",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p9",
              "label": "Reporte o tablero ejecutivo actualizado.",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            }
          ]
        },
        {
          "key": "manual.coordinacion_compras.minuta_semanal",
          "source_key": "coordinacion-compras.minuta-semanal",
          "name": "Minuta de revisión semanal de Compras",
          "moment": "administrativo",
          "frequency": "weekly",
          "weekday": 5,
          "month_day": null,
          "due_time": "23:00",
          "format_code": "Anexo D",
          "note": "Cada tema se cierra con hallazgo o decisión, responsable, fecha compromiso y estatus.",
          "per_event": false,
          "only_positions": null,
          "own_document": null,
          "items": [
            {
              "id": "p0",
              "label": "Desabasto",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p1",
              "label": "Pedidos pendientes",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p2",
              "label": "Presupuesto y pagos",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p3",
              "label": "Excedentes",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p4",
              "label": "Baja rotación",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p5",
              "label": "Promociones",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p6",
              "label": "Proveedores",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p7",
              "label": "Sistemas / datos",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            }
          ]
        },
        {
          "key": "manual.coordinacion_compras.evaluacion_proveedor",
          "source_key": "coordinacion-compras.evaluacion-proveedor",
          "name": "Evaluación mensual de proveedor",
          "moment": "administrativo",
          "frequency": "monthly",
          "weekday": null,
          "month_day": 28,
          "due_time": "23:00",
          "format_code": "Anexo C",
          "note": "Ponderación del anexo: entregas completas 25%, entregas a tiempo 25%, calidad y caducidad 15%, exactitud de factura 15%, cumplimiento comercial 10%, atención de incidencias 10%.",
          "per_event": false,
          "only_positions": null,
          "own_document": null,
          "items": [
            {
              "id": "p0",
              "label": "Entregas completas evaluadas (25%)",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p1",
              "label": "Entregas a tiempo evaluadas (25%)",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p2",
              "label": "Calidad y caducidad evaluadas (15%)",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p3",
              "label": "Exactitud de factura evaluada (15%)",
              "block": null,
              "evidence": "photos",
              "accepts_documents": true,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p4",
              "label": "Cumplimiento comercial evaluado (10%)",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p5",
              "label": "Atención de incidencias evaluada (10%)",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": true
            },
            {
              "id": "p6",
              "label": "Calificación total registrada",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            }
          ]
        }
      ]
    },
    {
      "documento": "Manual Corporativo de Operación — Auxiliar Administrativo de Logística",
      "codigo": "MDDLA-LOG-AAL-001",
      "version": "1.0 · 2026",
      "archivo": "6. Manual_Corporativo_Auxiliar_Administrativo_Logistica.pdf",
      "puestos": [
        "aux_administrativo_logistica"
      ],
      "formatos_no_automatizados": [
        "Anexo A. Tarjeta mensual de KPIs",
        "Anexo B. Plan de acción por error o atraso",
        "Anexo C. Evaluación de competencias",
        "Anexo D. Lista de transferencia del puesto"
      ],
      "tareas": [
        {
          "key": "manual.aux_administrativo_logistica.cierre",
          "source_key": "aux-administrativo-logistica.cierre",
          "name": "Checklist de cierre diario",
          "moment": "cierre",
          "frequency": "daily",
          "weekday": null,
          "month_day": null,
          "due_time": "23:00",
          "format_code": "Anexo E",
          "note": null,
          "per_event": false,
          "only_positions": null,
          "own_document": null,
          "items": [
            {
              "id": "p0",
              "label": "Registré las hojas de viaje recibidas y señalé faltantes.",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p1",
              "label": "Capturé facturas, gasolina y pólizas del corte correspondiente.",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p2",
              "label": "Validé errores antes de entregar a Finanzas.",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p3",
              "label": "Actualicé Drive y los controles del área.",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p4",
              "label": "Di seguimiento a cartas porte, fletes o facturación de tickets.",
              "block": null,
              "evidence": "photos",
              "accepts_documents": true,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p5",
              "label": "Identifiqué pendientes vencidos y los escalé cuando fue necesario.",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p6",
              "label": "Organicé soportes y dejé prioridades del día siguiente.",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            }
          ]
        }
      ]
    },
    {
      "documento": "Manual Corporativo de Operación — Auxiliar de Logística, Control Documental y Operativo de Flotilla",
      "codigo": "A",
      "version": "1.0 · 2026",
      "archivo": "7. Manual_Corporativo_Auxiliar_Logistica_Flotilla_COMPLETO_CON_ANEXOS.pdf",
      "puestos": [
        "aux_logistica_flotilla"
      ],
      "formatos_no_automatizados": [
        "A-01 Ficha maestra y alta de unidad",
        "A-03 Control maestro de pólizas y vencimientos",
        "A-04 Calendario de verificaciones y trámites",
        "A-05 Reporte de falla vehicular",
        "A-06 Orden de ingreso y salida de taller",
        "A-07 Bitácora e historial de mantenimiento por unidad",
        "A-08 Control de kilometraje y mantenimiento preventivo",
        "A-09 Reporte de contingencia en carretera",
        "A-10 Expediente de siniestro",
        "A-11 Control de multas e infracciones",
        "A-12 Control de facturas, pagos y centros de costo",
        "A-15 Evaluación de proveedores y talleres",
        "A-16 Formato de baja, venta o sustitución de unidad",
        "A-17 Minuta de seguimiento de flotilla",
        "A-18 Entrega-recepción y continuidad del puesto"
      ],
      "tareas": [
        {
          "key": "manual.aux_logistica_flotilla.seguimiento_semanal",
          "source_key": "aux-logistica-flotilla.seguimiento-semanal",
          "name": "Seguimiento operativo semanal de flotilla",
          "moment": "administrativo",
          "frequency": "weekly",
          "weekday": 1,
          "month_day": null,
          "due_time": "23:00",
          "format_code": "5.4",
          "note": "El ciclo de evaluación del manual fija este seguimiento como semanal, junto con la Jefatura de Logística.",
          "per_event": false,
          "only_positions": null,
          "own_document": null,
          "items": [
            {
              "id": "p0",
              "label": "Vencimientos próximos revisados (pólizas, verificación, tenencia)",
              "block": null,
              "evidence": "photos",
              "accepts_documents": true,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p1",
              "label": "Unidades en taller con estatus actualizado",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p2",
              "label": "Pagos pendientes identificados",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p3",
              "label": "Contingencias y siniestros abiertos con seguimiento",
              "block": null,
              "evidence": "photos",
              "accepts_documents": true,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p4",
              "label": "Carpeta de continuidad actualizada",
              "block": null,
              "evidence": "photos",
              "accepts_documents": true,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            }
          ]
        },
        {
          "key": "manual.aux_logistica_flotilla.combustible_semanal",
          "source_key": "aux-logistica-flotilla.combustible-semanal",
          "name": "Control semanal de combustible",
          "moment": "administrativo",
          "frequency": "weekly",
          "weekday": 5,
          "month_day": null,
          "due_time": "23:00",
          "format_code": "A-13",
          "note": null,
          "per_event": false,
          "only_positions": null,
          "own_document": null,
          "items": [
            {
              "id": "p0",
              "label": "Facturas de la semana concentradas",
              "block": null,
              "evidence": "photos",
              "accepts_documents": true,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p1",
              "label": "Litros e importe registrados por unidad",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p2",
              "label": "Gasto asignado a unidad, área o sucursal",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p3",
              "label": "Consumos atípicos observados",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": true
            }
          ]
        },
        {
          "key": "manual.aux_logistica_flotilla.expediente_vehicular",
          "source_key": "aux-logistica-flotilla.expediente-vehicular",
          "name": "Checklist de expediente vehicular",
          "moment": "administrativo",
          "frequency": "monthly",
          "weekday": null,
          "month_day": 25,
          "due_time": "23:00",
          "format_code": "A-02",
          "note": "El manual lo aplica al alta de cada unidad. Aquí se entrega mensual como revisión de integridad del expediente: cada documento debe estar, estar vigente y ser localizable.",
          "per_event": false,
          "only_positions": null,
          "own_document": null,
          "items": [
            {
              "id": "p0",
              "label": "Factura o documento de propiedad",
              "block": null,
              "evidence": "photos",
              "accepts_documents": true,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p1",
              "label": "Contrato de arrendamiento",
              "block": null,
              "evidence": "photos",
              "accepts_documents": true,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p2",
              "label": "Tarjeta de circulación",
              "block": null,
              "evidence": "photos",
              "accepts_documents": true,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p3",
              "label": "Póliza de seguro",
              "block": null,
              "evidence": "photos",
              "accepts_documents": true,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p4",
              "label": "Comprobante de verificación",
              "block": null,
              "evidence": "photos",
              "accepts_documents": true,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p5",
              "label": "Permisos especiales",
              "block": null,
              "evidence": "photos",
              "accepts_documents": true,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p6",
              "label": "Tenencia / refrendo aplicable",
              "block": null,
              "evidence": "photos",
              "accepts_documents": true,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p7",
              "label": "Identificación de número económico",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p8",
              "label": "Órdenes de taller",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p9",
              "label": "Facturas de mantenimiento",
              "block": null,
              "evidence": "photos",
              "accepts_documents": true,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p10",
              "label": "Expedientes de siniestros",
              "block": null,
              "evidence": "photos",
              "accepts_documents": true,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p11",
              "label": "Historial de kilometraje",
              "block": null,
              "evidence": "photos",
              "accepts_documents": true,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p12",
              "label": "Baja o venta, cuando aplique",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            }
          ]
        },
        {
          "key": "manual.aux_logistica_flotilla.entrega_unidad",
          "source_key": "aux-logistica-flotilla.entrega-unidad",
          "name": "Checklist de entrega y recepción de unidad",
          "moment": "operacion",
          "frequency": "event",
          "weekday": null,
          "month_day": null,
          "due_time": "23:00",
          "format_code": "A-14",
          "note": "Se llena únicamente cuando cambia la custodia de una unidad. La app no la entrega sola porque no puede saber cuándo ocurre: queda aquí como el formato oficial a seguir.",
          "per_event": false,
          "only_positions": null,
          "own_document": null,
          "items": [
            {
              "id": "p0",
              "label": "Carrocería y cristales",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p1",
              "label": "Llantas y refacción",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p2",
              "label": "Luces y señales",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p3",
              "label": "Frenos y dirección",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p4",
              "label": "Niveles y fugas",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p5",
              "label": "Herramienta / gato",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p6",
              "label": "Extintor / equipo de seguridad",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p7",
              "label": "Tarjeta de circulación",
              "block": null,
              "evidence": "photos",
              "accepts_documents": true,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p8",
              "label": "Póliza de seguro",
              "block": null,
              "evidence": "photos",
              "accepts_documents": true,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p9",
              "label": "Kilometraje",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p10",
              "label": "Combustible",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            }
          ]
        }
      ]
    },
    {
      "documento": "Manual Corporativo de Operación — Coordinación de Auditoría Operativa y Prevención de Pérdidas",
      "codigo": null,
      "version": "1.0 · 2026",
      "archivo": "5. Manual_Corporativo_Coordinacion_Auditoria_Operativa_Prevencion_Perdidas.pdf",
      "puestos": [
        "prevencion"
      ],
      "formatos_no_automatizados": [
        "Anexo A. Tarjeta mensual de KPIs",
        "Anexo B. Plan de acción por diferencia o riesgo",
        "Anexo C. Evaluación de competencias",
        "Anexo D. Minuta ejecutiva de auditoría o inventario",
        "Anexo E. Lista de transferencia del puesto"
      ],
      "tareas": [
        {
          "key": "manual.coordinacion_auditoria_prevencion.cargas_rutas",
          "source_key": "coordinacion-auditoria-prevencion.cargas-rutas",
          "name": "Control diario de cargas y operación de rutas",
          "moment": "operacion",
          "frequency": "daily",
          "weekday": null,
          "month_day": null,
          "due_time": "23:00",
          "format_code": "3.2",
          "note": "Señales de alerta del manual: carga mayor a la habitual, devolución elevada, venta baja con carga alta, movimiento sin soporte y diferencia recurrente.",
          "per_event": false,
          "only_positions": null,
          "own_document": null,
          "items": [
            {
              "id": "p0",
              "label": "Obtener la información de carga por vendedor o unidad.",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p1",
              "label": "Comparar la carga con venta histórica, capacidad de desplazamiento, mercancía previa y límites autorizados.",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p2",
              "label": "Identificar incrementos atípicos, productos de alto valor o mercancía que exceda la rotación esperada.",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p3",
              "label": "Solicitar aclaración al Supervisor de Ruta Directa antes de liberar o normalizar una carga fuera de patrón.",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p4",
              "label": "Dar seguimiento a venta, devoluciones y liquidación para confirmar correspondencia.",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p5",
              "label": "Registrar incidencias y seleccionar rutas de mayor riesgo para inventario sorpresa.",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": true
            }
          ]
        },
        {
          "key": "manual.coordinacion_auditoria_prevencion.planeacion",
          "source_key": "coordinacion-auditoria-prevencion.planeacion",
          "name": "Planeación y programación de actividades",
          "moment": "apertura",
          "frequency": "daily",
          "weekday": null,
          "month_day": null,
          "due_time": "23:00",
          "format_code": "3.1",
          "note": "Resultado esperado del manual: iniciar cada jornada con prioridades claras y actividades calendarizadas, sin descuidar los procesos quincenales o mensuales.",
          "per_event": false,
          "only_positions": null,
          "own_document": null,
          "items": [
            {
              "id": "p0",
              "label": "Prioridades del día definidas",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p1",
              "label": "Inventarios y conciliaciones calendarizados",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p2",
              "label": "Asuntos críticos identificados",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p3",
              "label": "Procesos quincenales y mensuales con avance revisado",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            }
          ]
        }
      ]
    },
    {
      "documento": "Manual Corporativo de Operación — Auxiliar de Auditoría y Prevención",
      "codigo": "MDDLA-AOP-AUX-01",
      "version": "1.0 · 2026",
      "archivo": "9. Manual_Corporativo_Auxiliar_Auditoria_Prevencion_COMPLETO_CON_ANEXOS.pdf",
      "puestos": [
        "auxiliar_prevencion"
      ],
      "formatos_no_automatizados": [
        "AP-04 Bitácora de anomalías",
        "AP-05 Investigación de diferencias",
        "AP-06 Ajustes",
        "AP-07 Inventario de ruta",
        "AP-09 Faltantes y sobrantes",
        "AP-10 Incidencias de inventario",
        "AP-14 Seguimiento de diferencias",
        "AP-16 Cierre de investigación"
      ],
      "tareas": [
        {
          "key": "manual.auxiliar_auditoria_prevencion.conciliacion",
          "source_key": "auxiliar-auditoria-prevencion.conciliacion",
          "name": "Conciliación de traspasos y compras",
          "moment": "operacion",
          "frequency": "daily",
          "weekday": null,
          "month_day": null,
          "due_time": "23:00",
          "format_code": "AP-03",
          "note": "La tabla de implementación del manual marca este formato como diario/semanal; la app lo entrega diario y la Coordinación interviene en las excepciones.",
          "per_event": false,
          "only_positions": null,
          "own_document": null,
          "items": [
            {
              "id": "p0",
              "label": "Traspasos del periodo identificados",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p1",
              "label": "Compra o entrada correspondiente localizada en la sucursal destino",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p2",
              "label": "Cantidad coincide",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p3",
              "label": "Costo coincide",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p4",
              "label": "Excepciones escaladas a Coordinación",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": true
            }
          ]
        },
        {
          "key": "manual.auxiliar_auditoria_prevencion.jornada",
          "source_key": "auxiliar-auditoria-prevencion.jornada",
          "name": "Inicio de jornada y control diario de rutas",
          "moment": "apertura",
          "frequency": "daily",
          "weekday": null,
          "month_day": null,
          "due_time": "23:00",
          "format_code": "3.2 – 3.3",
          "note": "Autoevaluación del turno sobre los procedimientos del manual. No sustituye al procedimiento: confirma que se siguió. Lo que no se pueda afirmar se explica en las observaciones.",
          "per_event": false,
          "only_positions": null,
          "own_document": null,
          "items": [
            {
              "id": "p0",
              "label": "Prioricé los pendientes de control del día",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p1",
              "label": "Revisé las ventas de rutas del día anterior",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p2",
              "label": "Comparé carga contra venta y devolución de cada ruta",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p3",
              "label": "Identifiqué movimientos atípicos o sin soporte",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p4",
              "label": "Escalé a Coordinación lo que salió del patrón",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p5",
              "label": "Registré las incidencias detectadas",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            }
          ]
        },
        {
          "key": "manual.auxiliar_auditoria_prevencion.carpetas",
          "source_key": "auxiliar-auditoria-prevencion.carpetas",
          "name": "Revisión de carpetas de sucursal",
          "moment": "administrativo",
          "frequency": "weekly",
          "weekday": 5,
          "month_day": null,
          "due_time": "23:00",
          "format_code": "AP-01",
          "note": "Objetivo del formato: que la documentación semanal de cada sucursal permita reconstruir entradas, salidas, pólizas, devoluciones, ajustes y cancelaciones.",
          "per_event": false,
          "only_positions": null,
          "own_document": null,
          "items": [
            {
              "id": "p0",
              "label": "Entradas completas",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p1",
              "label": "Salidas completas",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p2",
              "label": "Pólizas completas",
              "block": null,
              "evidence": "photos",
              "accepts_documents": true,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p3",
              "label": "Devoluciones completas",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p4",
              "label": "Ajustes completos",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p5",
              "label": "Cancelaciones completas",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p6",
              "label": "Pendientes enviados con fecha compromiso",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            }
          ]
        },
        {
          "key": "manual.auxiliar_auditoria_prevencion.compras_pendientes",
          "source_key": "auxiliar-auditoria-prevencion.compras-pendientes",
          "name": "Control semanal de compras pendientes",
          "moment": "administrativo",
          "frequency": "weekly",
          "weekday": 5,
          "month_day": null,
          "due_time": "23:00",
          "format_code": "AP-02",
          "note": null,
          "per_event": false,
          "only_positions": null,
          "own_document": null,
          "items": [
            {
              "id": "p0",
              "label": "Traspasos sin compra o entrada en destino identificados",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p1",
              "label": "Motivo del pendiente documentado",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p2",
              "label": "Responsable contactado",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p3",
              "label": "Compromiso de cierre registrado",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p4",
              "label": "Estatus actualizado",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            }
          ]
        }
      ]
    },
    {
      "documento": "Manual Corporativo de Operación — Jefatura de Zona (Maestro)",
      "codigo": null,
      "version": "1.0 · Julio 2026",
      "archivo": "4. Manual_Corporativo_Jefatura_Zona_La_Piedad_Maestro.pdf",
      "puestos": [
        "jefe_zona"
      ],
      "formatos_no_automatizados": [
        "Anexo 1. Tarjeta mensual de KPIs",
        "Anexo 2. Formato de plan de mejora",
        "Anexo 3. Evaluación de competencias",
        "Anexo 4. Minuta de revisión ejecutiva",
        "Anexo 5. Lista de transferencia del puesto"
      ],
      "tareas": [
        {
          "key": "manual.gerencia_zona.supervision_sucursal",
          "source_key": "gerencia-zona.supervision-sucursal",
          "name": "Checklist de supervisión de sucursal",
          "moment": "supervision",
          "frequency": "weekly",
          "weekday": 3,
          "month_day": null,
          "due_time": "23:00",
          "format_code": "3.2.8",
          "note": "Criterios esenciales de conformidad por área. El manual pide que la frecuencia de visita se defina por riesgo, desempeño, rotación y resultados; la app la entrega semanal como piso mínimo. Un control no se da por cumplido solo porque exista el formato: la información debe reflejar lo ocurrido.",
          "per_event": false,
          "only_positions": null,
          "own_document": null,
          "items": [
            {
              "id": "p0",
              "label": "Apertura y cierre: horarios cumplidos, responsables definidos, alarmas y accesos controlados, checklist completo y desviaciones reportadas.",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": true
            },
            {
              "id": "p1",
              "label": "Personal: cobertura razonable, presentación, puntualidad, asignación de actividades, descansos y comportamiento conforme a lineamientos.",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": true
            },
            {
              "id": "p2",
              "label": "Venta e imagen: precios y promociones correctos, abasto visible, limpieza, exhibiciones vigentes, enfoque comercial y atención adecuada.",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": true
            },
            {
              "id": "p3",
              "label": "Inventario: rotación, identificación, integridad, entradas y salidas registradas, diferencias investigadas y productos de riesgo controlados.",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": true
            },
            {
              "id": "p4",
              "label": "Efectivo y cajas: arqueos, retiros, resguardo, devoluciones y autorizaciones documentados; acceso limitado a personal facultado.",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": true
            },
            {
              "id": "p5",
              "label": "Bodega y seguridad: orden, pasillos libres, estiba segura, mercancía identificada, prevención de daños y condiciones adecuadas de trabajo.",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": true
            }
          ]
        },
        {
          "key": "manual.gerencia_zona.reporte_diario",
          "source_key": "gerencia-zona.reporte-diario",
          "name": "Reporte diario de zona",
          "moment": "cierre",
          "frequency": "daily",
          "weekday": null,
          "month_day": null,
          "due_time": "23:00",
          "format_code": "3.1.12",
          "note": "Registro de rendición de cuentas del puesto, por el canal definido por Dirección.",
          "per_event": false,
          "only_positions": null,
          "own_document": null,
          "items": [
            {
              "id": "p0",
              "label": "Reporte de apertura de las encargaturas confirmado",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p1",
              "label": "Incidencias del día documentadas con acción y responsable",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": true
            },
            {
              "id": "p2",
              "label": "Evidencias de seguimiento revisadas dentro del plazo acordado",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p3",
              "label": "Hallazgos críticos comunicados el mismo día",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            },
            {
              "id": "p4",
              "label": "Prioridades del día siguiente definidas",
              "block": null,
              "evidence": "photos",
              "accepts_documents": false,
              "requires_amount": false,
              "requires_folio": false,
              "requires_comment": false
            }
          ]
        }
      ]
    }
  ]
};

const AUDIT = `
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  deleted_at timestamptz,
  deleted_by uuid`;

const marcas = (xs) => xs.map(() => '?').join(',');

/** Piloto: quienes validan antes del corte (ver el encabezado). El reparto amplio es de `[MDT.C1]`. */
const PILOTO = ['direccion', 'superadmin', 'recursos_humanos'];

const LLAVES = {
  TAREAS_PUESTO_ENTREGAR: { solo: PILOTO },
  TAREAS_PUESTO_EQUIPO_VER: { solo: PILOTO },
  TAREAS_PUESTO_NORMA_GESTIONAR: { solo: PILOTO },
};

async function proteger(knex, tabla, privilegios) {
  await knex.raw(`ALTER TABLE platform.${tabla} ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE platform.${tabla} FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON platform.${tabla}`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON platform.${tabla}
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())`);
  await knex.raw(`GRANT ${privilegios} ON platform.${tabla} TO app_runtime`);
}

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw('CREATE SCHEMA IF NOT EXISTS platform');
  await knex.raw('GRANT USAGE ON SCHEMA platform TO app_runtime');

  // ── La tarea de la norma ────────────────────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS platform.checklist_templates (
      id                uuid        NOT NULL DEFAULT gen_random_uuid(),
      tenant_id         uuid        NOT NULL REFERENCES identity.tenants (id) ON DELETE RESTRICT,
      key               text        NOT NULL,
      domain            text        NOT NULL,
      name              text        NOT NULL,
      moment            text,
      frequency         text        NOT NULL,
      weekday           smallint,
      month_day         smallint,
      start_time        time        NOT NULL DEFAULT '06:00',
      due_time          time        NOT NULL DEFAULT '23:00',
      per_event         boolean     NOT NULL DEFAULT false,
      document_title    text,
      document_code     text,
      document_version  text,
      document_file     text,
      format_code       text,
      note              text,
      source_key        text,
      active            boolean     NOT NULL DEFAULT true,
      ${AUDIT},
      PRIMARY KEY (id),
      CONSTRAINT checklist_templates_tenant_id_uk UNIQUE (tenant_id, id),
      CONSTRAINT checklist_templates_key_uk UNIQUE (tenant_id, key),
      CONSTRAINT checklist_templates_key_ck CHECK (key ~ '^[a-z0-9_]+(\\.[a-z0-9_]+)+$'),
      CONSTRAINT checklist_templates_domain_ck CHECK (domain IN ('manual_puesto')),
      CONSTRAINT checklist_templates_name_ck CHECK (length(btrim(name)) BETWEEN 1 AND 200),
      CONSTRAINT checklist_templates_moment_ck CHECK (moment IS NULL OR moment IN
        ('apertura','operacion','cierre','supervision','administrativo')),
      CONSTRAINT checklist_templates_frequency_ck CHECK (frequency IN
        ('daily','weekly','biweekly','monthly','event')),
      CONSTRAINT checklist_templates_weekday_ck CHECK (
        (frequency = 'weekly') = (weekday IS NOT NULL) AND (weekday IS NULL OR weekday BETWEEN 1 AND 7)),
      CONSTRAINT checklist_templates_month_day_ck CHECK (
        (frequency = 'monthly') = (month_day IS NOT NULL) AND (month_day IS NULL OR month_day BETWEEN 1 AND 31)),
      CONSTRAINT checklist_templates_window_ck CHECK (start_time < due_time)
    )`);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS platform.checklist_template_positions (
      tenant_id      uuid        NOT NULL REFERENCES identity.tenants (id) ON DELETE RESTRICT,
      template_id    uuid        NOT NULL,
      position_code  text        NOT NULL,
      created_at     timestamptz NOT NULL DEFAULT now(),
      created_by     uuid,
      PRIMARY KEY (tenant_id, template_id, position_code),
      CONSTRAINT checklist_template_positions_template_fk FOREIGN KEY (tenant_id, template_id)
        REFERENCES platform.checklist_templates (tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT checklist_template_positions_position_fk FOREIGN KEY (tenant_id, position_code)
        REFERENCES identity.positions (tenant_id, code) ON DELETE CASCADE
    )`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_cktpl_pos_position
                  ON platform.checklist_template_positions (tenant_id, position_code)`);

  // ── Los puntos, versionados (registro) ───────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS platform.checklist_template_versions (
      id            uuid        NOT NULL DEFAULT gen_random_uuid(),
      tenant_id     uuid        NOT NULL REFERENCES identity.tenants (id) ON DELETE RESTRICT,
      template_id   uuid        NOT NULL,
      version       integer     NOT NULL,
      valid_from    date        NOT NULL,
      items         jsonb       NOT NULL,
      change_note   text        NOT NULL,
      -- La hora límite es parte de la NORMA y se versiona con ella (MDT.3.2b): cambiarla nunca reescribe lo ya
      -- juzgado. NULL = la de la plantilla (la ventana del día de MDTask, 23:00).
      due_time      time,
      created_at    timestamptz NOT NULL DEFAULT now(),
      created_by    uuid,
      PRIMARY KEY (id),
      CONSTRAINT checklist_template_versions_tenant_id_uk UNIQUE (tenant_id, id),
      CONSTRAINT checklist_template_versions_tpl_id_uk UNIQUE (tenant_id, template_id, id),
      CONSTRAINT checklist_template_versions_version_uk UNIQUE (tenant_id, template_id, version),
      CONSTRAINT checklist_template_versions_version_ck CHECK (version >= 1),
      CONSTRAINT checklist_template_versions_items_ck CHECK (
        jsonb_typeof(items) = 'array' AND jsonb_array_length(items) BETWEEN 1 AND 200),
      CONSTRAINT checklist_template_versions_note_ck CHECK (length(btrim(change_note)) > 0),
      CONSTRAINT checklist_template_versions_due_ck CHECK (due_time IS NULL OR due_time > time '00:00'),
      CONSTRAINT checklist_template_versions_template_fk FOREIGN KEY (tenant_id, template_id)
        REFERENCES platform.checklist_templates (tenant_id, id) ON DELETE RESTRICT
    )`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_cktpl_ver_vigencia
                  ON platform.checklist_template_versions (tenant_id, template_id, valid_from DESC, version DESC)`);

  // ── La entrega: nace cuando la persona abre la tarea, no la crea un emisor (D3) ───────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS platform.checklist_runs (
      id               uuid        NOT NULL DEFAULT gen_random_uuid(),
      tenant_id        uuid        NOT NULL REFERENCES identity.tenants (id) ON DELETE RESTRICT,
      template_id      uuid        NOT NULL,
      version_id       uuid        NOT NULL,
      period_date      date        NOT NULL,
      assigned_to      uuid        NOT NULL,
      assigned_by      uuid,
      assigned_at      timestamptz NOT NULL,
      due_at           timestamptz NOT NULL,
      position_code    text,
      warehouse_code   text,
      status           text        NOT NULL DEFAULT 'in_progress',
      responses        jsonb       NOT NULL DEFAULT '{}'::jsonb,
      employee_note    text,
      submitted_at     timestamptz,
      submitted_late   boolean,
      ${AUDIT},
      PRIMARY KEY (id),
      CONSTRAINT checklist_runs_tenant_id_uk UNIQUE (tenant_id, id),
      CONSTRAINT checklist_runs_periodo_uk UNIQUE (tenant_id, template_id, assigned_to, period_date),
      CONSTRAINT checklist_runs_status_ck CHECK (status IN ('in_progress','submitted','cancelled')),
      CONSTRAINT checklist_runs_submitted_ck CHECK ((status = 'submitted') = (submitted_at IS NOT NULL)),
      CONSTRAINT checklist_runs_late_ck CHECK ((submitted_at IS NULL) = (submitted_late IS NULL)),
      CONSTRAINT checklist_runs_responses_ck CHECK (jsonb_typeof(responses) = 'object'),
      CONSTRAINT checklist_runs_note_ck CHECK (employee_note IS NULL OR length(employee_note) <= 2000),
      CONSTRAINT checklist_runs_template_fk FOREIGN KEY (tenant_id, template_id)
        REFERENCES platform.checklist_templates (tenant_id, id) ON DELETE RESTRICT,
      CONSTRAINT checklist_runs_version_fk FOREIGN KEY (tenant_id, template_id, version_id)
        REFERENCES platform.checklist_template_versions (tenant_id, template_id, id) ON DELETE RESTRICT,
      CONSTRAINT checklist_runs_assigned_to_fk FOREIGN KEY (tenant_id, assigned_to)
        REFERENCES identity.users (tenant_id, id) ON DELETE RESTRICT,
      CONSTRAINT checklist_runs_assigned_by_fk FOREIGN KEY (tenant_id, assigned_by)
        REFERENCES identity.users (tenant_id, id) ON DELETE RESTRICT
    )`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_ckrun_persona
                  ON platform.checklist_runs (tenant_id, assigned_to, period_date DESC) WHERE deleted_at IS NULL`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_ckrun_periodo
                  ON platform.checklist_runs (tenant_id, period_date, status) WHERE deleted_at IS NULL`);

  // ── La evidencia ─────────────────────────────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS platform.checklist_run_files (
      id             uuid        NOT NULL DEFAULT gen_random_uuid(),
      tenant_id      uuid        NOT NULL REFERENCES identity.tenants (id) ON DELETE RESTRICT,
      run_id         uuid        NOT NULL,
      item_id        text        NOT NULL,
      storage_key    text        NOT NULL,
      mime           text        NOT NULL,
      size_bytes     integer     NOT NULL,
      original_name  text,
      captured_at    timestamptz,
      uploaded_by    uuid        NOT NULL,
      created_at     timestamptz NOT NULL DEFAULT now(),
      deleted_at     timestamptz,
      deleted_by     uuid,
      PRIMARY KEY (id),
      CONSTRAINT checklist_run_files_tenant_id_uk UNIQUE (tenant_id, id),
      CONSTRAINT checklist_run_files_key_uk UNIQUE (tenant_id, storage_key),
      CONSTRAINT checklist_run_files_size_ck CHECK (size_bytes > 0),
      CONSTRAINT checklist_run_files_item_ck CHECK (length(item_id) BETWEEN 1 AND 40),
      CONSTRAINT checklist_run_files_deleted_ck CHECK ((deleted_at IS NULL) = (deleted_by IS NULL)),
      CONSTRAINT checklist_run_files_run_fk FOREIGN KEY (tenant_id, run_id)
        REFERENCES platform.checklist_runs (tenant_id, id) ON DELETE RESTRICT,
      CONSTRAINT checklist_run_files_uploaded_by_fk FOREIGN KEY (tenant_id, uploaded_by)
        REFERENCES identity.users (tenant_id, id) ON DELETE RESTRICT
    )`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_ckfile_run
                  ON platform.checklist_run_files (tenant_id, run_id, item_id) WHERE deleted_at IS NULL`);

  // Grants: la versión es registro; la entrega se edita mientras está abierta; el archivo sólo
  // se retira (soft delete) antes de entregar.
  await proteger(knex, 'checklist_templates', 'SELECT, INSERT, UPDATE');
  await proteger(knex, 'checklist_template_positions', 'SELECT, INSERT, DELETE');
  await proteger(knex, 'checklist_template_versions', 'SELECT, INSERT');
  await proteger(knex, 'checklist_runs', 'SELECT, INSERT, UPDATE');
  await proteger(knex, 'checklist_run_files', 'SELECT, INSERT, UPDATE');

  await knex.raw(`COMMENT ON TABLE platform.checklist_templates IS 'MDT.1.2 — una tarea de la norma (p. ej. el manual de un puesto): cuándo toca y de qué documento sale. Los puntos viven en checklist_template_versions. Motor genérico (D5): logistics.shipment_checklists es deuda para pasarse aquí.'`);
  await knex.raw(`COMMENT ON TABLE platform.checklist_runs IS 'MDT.1.3 — la entrega de una persona para un periodo. NO la crea un emisor (D3: ningún cron): nace cuando la persona abre la tarea; lo pendiente se deriva de la norma al leer. assigned_by NULL = la asignó la norma, no una persona. Fuente del contrato de tarea.'`);
  await knex.raw(`COMMENT ON TABLE platform.checklist_run_files IS 'MDT.2.1 — la evidencia de un punto, en el bucket privado. Se guarda storage_key, nunca la URL (se firma en cada lectura).'`);

  // ── MDT.0.6: el puesto que faltaba, y la siembra de la norma, sólo si el tenant existe ─────
  const { rows: [t] } = await knex.raw('SELECT id FROM identity.tenants WHERE id = ?', [TENANT]);
  let sembradas = 0;
  let sinPuesto = 0;
  if (t) {
    await knex.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);
    // `kileadora` hereda lo organizacional de `anaquelista` (mismo nivel, misma sucursal) y reporta
    // a la Encargada. Sin `default_role`: MDTask no trae perfil de acceso y no se inventa ([AU.23]).
    await knex.raw(`
      INSERT INTO identity.positions
        (tenant_id, code, name, org_labels, orden, department_code, scope_axis,
         reports_to_position_code, default_complements, nivel)
      SELECT a.tenant_id, 'kileadora', 'Kileadora de Sucursal', a.org_labels, a.orden, a.department_code,
             a.scope_axis,
             (SELECT e.code FROM identity.positions e
               WHERE e.tenant_id = a.tenant_id AND e.code = 'encargado_sucursal' AND e.deleted_at IS NULL),
             a.default_complements, a.nivel
        FROM identity.positions a
       WHERE a.tenant_id = ? AND a.code = 'anaquelista' AND a.deleted_at IS NULL
      ON CONFLICT (tenant_id, code) DO NOTHING`, [TENANT]);

    for (const m of SEED.manuales) {
      for (const tarea of m.tareas) {
        const doc = tarea.own_document || { documento: m.documento, version: m.version };
        const { rows: [tpl] } = await knex.raw(`
          INSERT INTO platform.checklist_templates
            (tenant_id, key, domain, name, moment, frequency, weekday, month_day, start_time, due_time,
             per_event, document_title, document_code, document_version, document_file, format_code,
             note, source_key)
          VALUES (?, ?, 'manual_puesto', ?, ?, ?, ?, ?, ?::time, ?::time, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (tenant_id, key) DO NOTHING
          RETURNING id`,
        [TENANT, tarea.key, tarea.name, tarea.moment, tarea.frequency, tarea.weekday, tarea.month_day,
          SEED.ventana.inicio, tarea.due_time, tarea.per_event, doc.documento,
          tarea.own_document ? null : m.codigo, doc.version, tarea.own_document ? null : m.archivo,
          tarea.format_code, tarea.note, 'mdtask:' + tarea.source_key]);
        if (!tpl) continue; // ya estaba: idempotente, no se pisa lo que alguien haya editado
        sembradas++;
        await knex.raw(`
          INSERT INTO platform.checklist_template_versions
            (tenant_id, template_id, version, valid_from, items, change_note)
          VALUES (?, ?, 1, DATE '2026-11-13', ?::jsonb, ?)
          ON CONFLICT (tenant_id, template_id, version) DO NOTHING`,
        [TENANT, tpl.id, JSON.stringify(tarea.items),
          `Carga inicial desde MDTask (${m.documento} · ${doc.version}), catálogo @3aa3297`]);
        // A qué puestos: los del manual, o sólo los que la tarea nombra. Un puesto que no existe en
        // este tenant se salta y se cuenta: no se inventa.
        const puestos = tarea.only_positions || m.puestos;
        for (const code of puestos) {
          const { rowCount } = await knex.raw(`
            INSERT INTO platform.checklist_template_positions (tenant_id, template_id, position_code)
            SELECT ?, ?, p.code FROM identity.positions p
             WHERE p.tenant_id = ? AND p.code = ? AND p.deleted_at IS NULL
            ON CONFLICT DO NOTHING`, [TENANT, tpl.id, TENANT, code]);
          if (!rowCount) sinPuesto++;
        }
      }
    }
  }

  // ── Las tres llaves, REPARTIDAS. Tabla real `identity.role_permissions`. ─────────────────
  for (const [llave, regla] of Object.entries(LLAVES)) {
    let valor;
    let params;
    if (regla.solo) {
      valor = `role_name IN (${marcas(regla.solo)})`;
      params = regla.solo;
    } else if (regla.excepto) {
      valor = `role_name NOT IN (${marcas(regla.excepto)})`;
      params = regla.excepto;
    } else {
      valor = `(role_name IN (${regla.derivado}) OR role_name IN (${marcas(regla.ademas)}))`;
      params = regla.ademas;
    }
    await knex.raw(
      `UPDATE identity.role_permissions
          SET permissions = permissions || jsonb_build_object(?::text, ${valor})
        WHERE permissions -> ?::text IS NULL
          AND role_name NOT LIKE 'retirado%'
          AND deleted_at IS NULL`,
      [llave, ...params, llave],
    );
    const { rows } = await knex.raw(
      `SELECT role_name FROM identity.role_permissions
        WHERE permissions -> ?::text = 'true'::jsonb AND role_name <> 'superadmin' AND deleted_at IS NULL ORDER BY 1`,
      [llave],
    );
    const { rows: [hay] } = await knex.raw('SELECT count(*)::int n FROM identity.role_permissions WHERE deleted_at IS NULL');
    if (hay.n > 0 && !rows.length) {
      throw new Error(`Ningún rol (fuera de superadmin) quedó con ${llave}: la pantalla nacería sin dueño (regla 20)`);
    }
    // eslint-disable-next-line no-console
    console.log(`  [MDT.2.5] ${llave}: en true → ${rows.length} rol(es): ${rows.map((r) => r.role_name).join(', ') || '(ninguno)'}`);
  }

  // eslint-disable-next-line no-console
  console.log(`  [MDT.1.2] platform.checklist_*: ${sembradas} tareas sembradas de ${SEED._conteo.tareas}` +
    ` (${SEED._conteo.puntos} puntos)${sinPuesto ? ` · ${sinPuesto} enlace(s) a puesto omitidos: el puesto no existe en el tenant` : ''}`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  for (const llave of Object.keys(LLAVES)) {
    await knex.raw(
      `UPDATE identity.role_permissions SET permissions = permissions - ?::text WHERE permissions -> ?::text IS NOT NULL`,
      [llave, llave],
    );
  }
  await knex.raw('DROP TABLE IF EXISTS platform.checklist_run_files');
  await knex.raw('DROP TABLE IF EXISTS platform.checklist_runs');
  await knex.raw('DROP TABLE IF EXISTS platform.checklist_template_versions');
  await knex.raw('DROP TABLE IF EXISTS platform.checklist_template_positions');
  await knex.raw('DROP TABLE IF EXISTS platform.checklist_templates');
  // El puesto sólo se retira si nadie lo ocupa: si ya tiene gente, quitarlo dejaría fichas sin puesto.
  await knex.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);
  await knex.raw(`
    DELETE FROM identity.positions p
     WHERE p.tenant_id = ? AND p.code = 'kileadora'
       AND NOT EXISTS (SELECT 1 FROM identity.users u WHERE u.tenant_id = p.tenant_id AND u.position_code = p.code)
       AND NOT EXISTS (SELECT 1 FROM identity.positions c WHERE c.tenant_id = p.tenant_id AND c.reports_to_position_code = p.code)`,
  [TENANT]);
};
