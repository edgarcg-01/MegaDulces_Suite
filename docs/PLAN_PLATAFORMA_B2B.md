# Plan de evolución: de Trade Marketing a Plataforma B2B integral

> Este documento mapea la propuesta de plataforma B2B comercial (atención asistida + autoservicio + sales intelligence + growth/fintech) contra el estado actual de la app, identifica brechas concretas y propone un roadmap por fases.

---

## 1. Resumen ejecutivo

La app **Trade Marketing** actual es un sistema de **auditoría de ejecución en punto de venta**: capturistas visitan tiendas, evalúan exhibiciones de producto, califican ejecución y los supervisores ven reportes en tiempo real.

La visión propuesta convierte esto en una **plataforma B2B end-to-end** que cubre:
- Toma de pedidos (no solo auditoría).
- Autoservicio del cliente (portal + WhatsApp bot).
- Inteligencia de ventas (no solo de ejecución).
- Motor de growth y fintech.

**Estimación realista:** 12-18 meses con 1 dev senior fullstack, o 8-10 meses con 2-3 devs en paralelo.

**Cumplimiento actual aproximado:** 22% de la visión completa. Casi todo el "qué tiene la app hoy" cae bajo el pilar de **Sales Intelligence** (panel analítico para supervisores). Los otros tres pilares están en cero.

---

## 2. Gap analysis — Capacidad por capacidad

### 2.1 App para la fuerza de ventas (Atención Asistida)

| Capacidad propuesta | Estado actual | Detalle |
|---|---|---|
| Vendedor toma pedidos en campo | ❌ No existe | La app móvil captura auditorías de exhibición, **no pedidos**. No hay catálogo comercial, carrito ni pedido. |
| IA sugiere "canasta estratégica" por tienda | ❌ No existe | No hay historial de ventas, ni catálogo comercial, ni infraestructura de ML. |
| Análisis de perfil del comercio | 🟡 Parcial | Tienes scoring de **ejecución** de la tienda (qué tan bien expone tus productos), pero no scoring **comercial** (volumen, frecuencia, mix). |
| Funcionamiento offline en mobile | ✅ Implementado | Módulo `visitas-sync` + Capacitor + Dexie.js en `apps/view`. Patrón offline-first ya funcionando para captures. Sirve como base para extender a pedidos. |
| Resolución de conflictos al sync | 🟡 Parcial | Hoy resuelve duplicidad por UUID idempotente. Falta lógica para conflictos de inventario/precio (no aplica todavía sin pedidos). |

**Subtotal cumplido:** ~15% (solo la infraestructura offline-first es reutilizable; el dominio comercial está vacío).

---

### 2.2 Comercio conversacional y autoatención (Self-Service)

| Capacidad propuesta | Estado actual | Detalle |
|---|---|---|
| Portal web B2B para clientes | ❌ No existe | El frontend actual (`apps/view`) es para personal interno (capturistas, supervisores, admins). |
| Bot de WhatsApp | ❌ No existe | No hay integración con WhatsApp Business API, Twilio, ni similar. Solo tienes WebSocket interno para realtime. |
| Bot con IA toma pedidos | ❌ No existe | No hay LLM integration, ni catálogo, ni motor de pedidos. |
| Bot responde dudas de soporte | ❌ No existe | Sin LLM ni base de conocimiento (FAQs/docs). |
| Recomendaciones personalizadas | ❌ No existe | Sin historial de pedidos ni modelo de recomendación. |

**Subtotal cumplido:** 0%.

---

### 2.3 Centro de Comando y Sales Intelligence

| Capacidad propuesta | Estado actual | Detalle |
|---|---|---|
| Panel web analítico para supervisores | ✅ Implementado | Módulos `/dashboard`, `/reports`, `/seguimiento` con gráficas (PrimeNG ChartModule). |
| Ejecución comercial en **tiempo real** | ✅ Implementado | WebSocket en namespace `/reports` con rooms por scope (`own/team/global`). Eventos `capture:created`, `metrics:updated` con batching cada 2s. |
| Medir desempeño | ✅ Implementado | Sistema `scoring-v2` calcula score por visita (peso × factor × nivel de ejecución). |
| Profundidad del **mix de productos vendidos** | ❌ No existe | Hoy mides **mix expuesto** (qué exhibiciones tiene una tienda), no **mix vendido**. Sin data de pedidos no se puede. |
| Reaccionar al instante | 🟡 Parcial | La data se ve al instante, pero no hay sistema de **alertas/acciones automáticas** (ej: "zona X bajó 20% en ejecución, notificar supervisor"). |
| Drill-down por zona/ruta/tienda | 🟡 Parcial | Existe filtrado en reports, falta visualización geográfica (mapa heat-mapped) y drill-down jerárquico fluido. |

**Subtotal cumplido:** ~60%. Es el pilar más maduro. Falta extender a métricas comerciales y agregar capa de alertas + visualización geo.

---

### 2.4 Motor de Growth y Fintech

| Capacidad propuesta | Estado actual | Detalle |
|---|---|---|
| Campañas hiper-segmentadas | ❌ No existe | No hay motor de segmentación de clientes. |
| Mecánicas promocionales complejas (combos, precios dinámicos) | ❌ No existe | No hay catálogo comercial ni motor de promociones. |
| Detección temprana de riesgo crediticio | ❌ No existe | No hay data transaccional (pedidos, pagos, días de crédito). Sin esa data no se puede modelar credit risk. |

**Subtotal cumplido:** 0%.

---

### 2.5 Funciones técnicas y arquitectura

| Capacidad propuesta | Estado actual | Detalle |
|---|---|---|
| **Orquestación de APIs / Omnicanalidad** | 🟡 Parcial | NestJS modular sirviendo a Angular web. Falta exposición pulida para mobile dedicada y eventual bot. |
| Diseño modular (monorepositorio) | ✅ Implementado | Nx monorepo con `apps/api`, `apps/view`, `libs/shared-scoring`. |
| Lenguajes con tipado estricto | ✅ Implementado | TypeScript estricto en todo el stack. |
| Contratos backend/frontend nunca se rompen | 🟡 Parcial | TypeScript ayuda, pero los tipos se duplican manualmente. Falta `nx generate` de DTOs compartidos o tRPC/Zod schemas. |
| **Sincronización offline-first** | ✅ Implementado (parcial) | Sync de capturas funciona. Falta extender el patrón a pedidos. |
| Manejo transaccional preciso | ✅ Implementado | Knex con `knex.transaction()` disponible y usado en endpoints críticos. |
| Resolución de conflictos de inventario/precios | ❌ No existe | Aplica solo cuando exista carrito y stock real. |
| **Integración de modelos predictivos** | ❌ No existe | Sin ML pipeline ni feature store ni modelos. |
| Recomendaciones en milisegundos | ❌ No existe | Sin recomendaciones. |
| **Despliegue y alta disponibilidad** | 🟡 Parcial | Dockerfile multi-stage + Railway. Escalado horizontal disponible pero solo 1 replica. |
| Contenedores | ✅ Implementado | Docker + tini + nginx + node, deploy en Railway. |
| Aislamiento de procesos críticos | ❌ No existe | Es monolito modular. Si se cae un módulo se cae todo. |

---

### 2.6 Scoreboard de cumplimiento

| Pilar | % cumplido | Componente principal cumplido |
|---|---|---|
| App fuerza de ventas (Atención Asistida) | 15% | Infraestructura offline-first |
| Comercio Conversacional / Autoservicio | 0% | — |
| Sales Intelligence | 60% | Panel reportes + realtime WS + scoring |
| Growth & Fintech | 0% | — |
| **Bases técnicas y arquitectura** | 65% | Nx + TS + Knex tx + Docker |
| **TOTAL ponderado de la visión** | **~22%** | — |

---

## 3. Roadmap propuesto por fases

### Fase 0 — Consolidación de bases (3-4 semanas, opcional pero recomendada)

Antes de agregar nuevos pilares, asegurar que las bases aguanten:

- [ ] Agregar **Redis** a Railway (necesario para queues, cache distribuida).
- [ ] Configurar **BullMQ** (queues robustas para jobs async).
- [ ] Agregar **Sentry** para tracking de errores en producción.
- [ ] Estandarizar logs con **Pino** (estructurados, parseable por Railway).
- [ ] Setup de **staging environment** separado (hoy todo va a prod).
- [ ] CI con tests automáticos en PRs (GitHub Actions).
- [ ] Generar tipos compartidos backend→frontend (Zod schemas o nx libs).

**Entregable:** infraestructura observable, testeada y replicable.

---

### Fase 1 — Sales Intelligence ampliado (8-10 semanas)

Extender lo que ya tienes en `/reports` y `/dashboard` al **Centro de Comando real**.

**Sprint 1-2 (4 sem): Modelo de "mix de productos expuestos"**
- [ ] Tabla `exhibition_products` (`exhibition_id`, `producto_id`, `presente`, `caras`, `frenteo`).
- [ ] UI de captura: el capturista marca qué SKUs ve en cada exhibición.
- [ ] Migración de planograma_productos → catálogo extendido con metadata (categoría, marca, prioridad).

**Sprint 3 (2 sem): Capa OLAP local**
- [ ] Schema `analytics.*` en Postgres con tablas pre-agregadas: `hourly_kpi_by_zone`, `daily_mix_depth_by_store`, `weekly_top_underperformers`.
- [ ] Triggers o jobs que refrescan estas tablas al recibir `capture:created`.
- [ ] Índices apropiados para queries sub-100ms.

**Sprint 4 (2 sem): Endpoints + alertas**
- [ ] `GET /command-center/*` (mapa de zonas, top/bottom performers, mix depth ranking).
- [ ] Motor de alertas: configura thresholds, dispara notificación WS al supervisor cuando se viola.

**Sprint 5 (2 sem): Frontend del Command Center**
- [ ] Nuevo módulo `/dashboard/command-center` en Angular.
- [ ] **Mapa de México** con Leaflet (gratis) o Mapbox heat-mapped por score actual.
- [ ] Grid en vivo de "visitas en curso" (checkin sin checkout).
- [ ] Drill-down: zona → ruta → tienda → última visita con fotos.
- [ ] Panel comparativo: meta vs ejecutado por supervisor.

**Entregable de Fase 1:** Supervisores ven todo lo que hoy ven, +mix de productos por tienda, +mapa con calor, +alertas en tiempo real. Sigue siendo data de **ejecución**, no de **ventas** todavía.

---

### Fase 2 — Catálogo comercial + Portal B2B + App fuerza de ventas extendida (12-16 semanas)

Aquí se transforma la app de auditoría a plataforma comercial.

**Sprint 1-3 (6 sem): Dominio comercial**
- [ ] Tablas: `products_commercial`, `price_lists`, `price_list_items`, `customers_b2b` (extiende `stores`).
- [ ] Sincronización inicial con ERP/SAP existente (importar SKUs, precios, stocks).
- [ ] Endpoints CRUD del catálogo (admin).

**Sprint 4-6 (6 sem): Pedidos + Carrito**
- [ ] Tablas: `carts`, `cart_items`, `orders`, `order_items`, `order_status_history`.
- [ ] Estados: `borrador → confirmado → en_preparacion → enviado → entregado → facturado → pagado`.
- [ ] Endpoints: `POST /orders`, `GET /orders/:id/status`, transiciones de estado con audit trail.
- [ ] Lógica de inventario: bloqueo de stock al confirmar pedido.
- [ ] Resolución de conflictos en sync offline (concurrencia: 2 vendedores compitiendo por stock limitado).

**Sprint 7-9 (6 sem): App fuerza de ventas — modo pedidos**
- [ ] Extender la app móvil (Ionic + Capacitor) con módulo "Toma de pedido".
- [ ] Carrito offline en Dexie con sync al backend cuando hay conexión.
- [ ] UI: catálogo navegable + búsqueda + escaneo de código de barras (Capacitor BarcodeScanner).
- [ ] Workflow: visita tienda → audita exhibición (módulo actual) → toma pedido nuevo.

**Sprint 10-12 (6 sem): Portal web B2B**
- [ ] Nueva app `apps/b2b-portal` en Nx (Angular standalone).
- [ ] Login para dueños de tienda (rol nuevo: `cliente_b2b`).
- [ ] Catálogo + carrito + checkout + historial de pedidos + estado de cuenta.
- [ ] Diferenciación visual completa de `apps/view` (esto es para clientes, no para personal interno).

**Sprint 13 (2 sem): IA — Canasta estratégica (versión 1)**
- [ ] Job que analiza historial de pedidos por tienda (últimos 6 meses si hay data, sino reglas).
- [ ] Tabla `recommended_basket` por tienda, generada nightly.
- [ ] Endpoint `GET /sales/recommendations/:store_id` consumido por la app del vendedor.
- [ ] **V1 con reglas:** "productos más vendidos en tu zona que tú no compraste este mes".
- [ ] V2 (post-MVP): modelo de collaborative filtering tipo "tiendas similares a la tuya pidieron X".

**Entregable de Fase 2:** Vendedor toma pedidos en campo con sugerencias. Cliente B2B compra desde portal web 24/7. Hay data transaccional fluyendo.

---

### Fase 3 — Comercio Conversacional (WhatsApp Bot) (10-12 semanas)

**Requiere Fase 2 cerrada** (necesita catálogo, carrito, pedidos operando).

**Sprint 1 (2 sem): Integración WhatsApp Business API**
- [ ] Selección de proveedor (BSP): **360dialog** o **Wati** recomendados para LATAM. Twilio si presupuesto holgado.
- [ ] Verificación de business + número dedicado (puede tardar 1-3 semanas de espera externa).
- [ ] Webhook receiver: `POST /webhooks/whatsapp` (NestJS).
- [ ] Cola en BullMQ para mensajes salientes con rate limiting.

**Sprint 2-3 (4 sem): Motor conversacional v1 (rules-based)**
- [ ] Menú estructurado: "Escribe 1 para pedir, 2 para soporte, 3 para hablar con asesor".
- [ ] Comandos básicos: ver catálogo, agregar SKU al carrito, confirmar pedido.
- [ ] Memoria de sesión: tabla `conversation_threads` por número.
- [ ] Handoff a humano si el bot no entiende.

**Sprint 4-7 (8 sem): Motor conversacional v2 (LLM)**
- [ ] Integración con **Anthropic Claude** o **OpenAI** vía SDK.
- [ ] **Tool calling**: el LLM puede invocar `search_products`, `add_to_cart`, `create_order`, `get_order_status`.
- [ ] **RAG**: vector search sobre catálogo + FAQs usando `pgvector` (extensión de Postgres, sin servicio nuevo).
- [ ] Personalidad y guardrails: prompt system bien definido, no hablar de competidores, no hacer promesas, etc.
- [ ] Monitoring: cada conversación se loggea con costo en tokens + satisfaction signal.

**Sprint 8-9 (4 sem): Recomendaciones desde el bot**
- [ ] El bot lee `recommended_basket` (de Fase 2) y proactivamente sugiere: "Hace 3 semanas no pides X, ¿quieres agregarlo?".
- [ ] Soporte automatizado: "¿Dónde está mi pedido?" → consulta `order_status_history` → responde con fecha estimada.

**Entregable de Fase 3:** Clientes piden por WhatsApp 24/7, IA atiende preguntas comunes, derivación a humano cuando es necesario.

---

### Fase 4 — Growth & Fintech (16-20 semanas)

**Requiere Fase 2 cerrada y 3-6 meses de data transaccional acumulada.**

**Sprint 1-3 (6 sem): Motor de segmentación**
- [ ] Tabla `customer_segments` definida por reglas JSON (DSL simple).
- [ ] Evaluador de reglas: dado un cliente, ¿a qué segmentos pertenece?
- [ ] UI de admin: definir/editar segmentos, ver tamaño, exportar lista.

**Sprint 4-6 (6 sem): Motor de campañas + delivery omnicanal**
- [ ] Tabla `campaigns`, `campaign_runs`, `campaign_deliveries`.
- [ ] Canales: WhatsApp (Fase 3), push web (portal B2B), email (Resend o SendGrid).
- [ ] A/B testing: split del segmento + medición de uplift en `orders.amount`.
- [ ] Dashboard de performance de cada campaña.

**Sprint 7-10 (8 sem): Motor de promociones**
- [ ] Tablas: `promotions`, `promotion_rules` (JSONB), `promotion_redemptions`.
- [ ] Tipos:
  - "Combos escalonados": 5 cajas A + 3 cajas B → 10% off.
  - "Precios dinámicos": precio cambia según volumen/segmento/temporada.
  - "Mecánicas de pirámide": comprá Y para desbloquear acceso a X.
- [ ] Evaluación en checkout: motor que toma carrito + cliente + reglas activas → aplica el mejor descuento.
- [ ] UI para definir promociones (admin) + monitoreo de redenciones.

**Sprint 11-14 (8 sem): Credit Risk Scoring v1 (reglas)**
- [ ] Tabla `customer_risk_features` actualizada diariamente (cron nocturno):
  - Días promedio de pago.
  - Tasa de cancelaciones.
  - Frecuencia de pedidos.
  - Mix premium vs económico.
  - Tiempo como cliente.
  - **Score de ejecución de la tienda** (de tu data de auditoría — ¡aquí conectas con Pilar Sales Intelligence!).
- [ ] Scoring heurístico: weights manuales, output 0-100.
- [ ] Dashboard de alertas: rojo/amarillo/verde por cliente.
- [ ] Workflow: si rojo, bloqueo automático de nuevos pedidos hasta revisión.

**Sprint 15-18 (8 sem): Credit Risk Scoring v2 (ML)** *(opcional, después de 6+ meses de data)*
- [ ] Pipeline de feature engineering en Python.
- [ ] Modelo: XGBoost o Random Forest (no necesitas deep learning para este caso).
- [ ] Servicio Python separado (FastAPI) hosteado en Railway al lado del API principal.
- [ ] Endpoint interno: `POST /internal/risk/score` consumido por NestJS.
- [ ] Reentrenamiento mensual con data nueva.

**Entregable de Fase 4:** Marketing dispara campañas segmentadas, promociones complejas, credit risk identifica clientes morosos antes del default.

---

## 4. Stack tecnológico — nuevo vs reutilizado

### Reutilizado (ya en el stack)
- **NestJS** + **TypeScript** estricto.
- **Angular 18** standalone + PrimeNG.
- **PostgreSQL** + Knex.js + migrations.
- **Socket.IO** (extendible a más namespaces).
- **Cloudinary** (fotos del catálogo).
- **Nx monorepo** + Docker + Railway.
- **CASL** (extensible a roles `cliente_b2b`, `kam`, etc.).
- **Capacitor + Dexie.js** (offline mobile).

### Nuevo (por agregar, listado por fase)

| Stack | Fase | Costo aproximado |
|---|---|---|
| **Redis** (BullMQ queues, cache distribuida) | 0 | $5-20/mes en Railway |
| **Sentry** (error tracking) | 0 | $0 (free tier) |
| **Pino** (logs estructurados) | 0 | $0 |
| **Leaflet** o **Mapbox** | 1 | $0 (Leaflet) / $50+/mes (Mapbox) |
| **pgvector** extension | 3 | $0 (extensión Postgres) |
| **WhatsApp BSP** (360dialog/Wati) | 3 | $50-200/mes + costo por conversación |
| **Anthropic Claude** o **OpenAI** | 3 | Variable — Claude Haiku 4.5 ~$1-5/1M tokens |
| **Resend** o **SendGrid** (email) | 4 | $20/mes |
| **Python ML service** (opcional) | 4 | $5-10/mes en Railway |

---

## 5. Decisiones arquitectónicas transversales

### 5.1 Multi-tenancy
**Decisión: NO implementar.** El código actual asume una sola organización. Si en el futuro vendes el sistema como SaaS a otras distribuidoras, requiere reescribir gran parte del schema. Por ahora se asume Mega Dulces como única org.

### 5.2 Separación de apps en el monorepo
- `apps/api`: API principal NestJS (lo que ya hay + extensiones de Fase 1, 2, 4).
- `apps/view`: panel interno (capturistas, supervisores, admins) — el que ya tienes.
- `apps/b2b-portal` (Fase 2): portal para clientes B2B — Angular separado.
- `apps/mobile` (eventualmente): app dedicada para fuerza de ventas — Ionic + Capacitor.
- `apps/conversational-api` (Fase 3, opcional): aislar webhooks de WhatsApp del API principal para no contaminar performance.

### 5.3 Queues y jobs asíncronos
A partir de Fase 0, **toda operación con I/O lento debe ir a queue**:
- Envío de mensajes WhatsApp.
- Generación de PDFs.
- Sync de catálogo con ERP.
- Recálculo de features de credit risk.
- Refresh de tablas analíticas pesadas.

### 5.4 Observabilidad obligatoria desde Fase 0
Sin tracing distribuido, los pilares 3 y 4 son ingobernables. Setup mínimo: Sentry (errores) + Pino (logs estructurados) + métricas básicas en Railway.

---

## 6. Riesgos y mitigaciones

| Riesgo | Impacto | Mitigación |
|---|---|---|
| Verificación de WhatsApp Business toma 6-12 semanas | Bloquea Fase 3 | Iniciar trámite con BSP en Fase 1 mientras se desarrolla Fase 2 |
| Modelo de credit risk falla por falta de data | Bloquea Fase 4 | Empezar con scoring heurístico (reglas) hasta tener 6+ meses de pedidos |
| Conflictos de stock en sync offline masivo | Pérdida de pedidos | Usar UUIDs idempotentes + retry server-side + notificación al vendedor si falla |
| ERP de Mega Dulces no expone API limpia | Bloquea Fase 2 | Adapter intermedio + sync nocturno por export CSV/SFTP si es necesario |
| Costos de LLM se disparan con escala | Margen comercial | Cache de respuestas frecuentes + degradación a reglas cuando supera presupuesto mensual |
| Equipo dev se queda corto | Slip de timeline | Priorizar Fase 1 + 2 (mayor valor inmediato) y posponer Fase 4 |

---

## 7. Métricas de éxito por fase

| Fase | KPI principal | Target a 3 meses post-launch |
|---|---|---|
| 1 - Sales Intelligence ampliado | % de supervisores que usan diariamente el Command Center | ≥ 80% de supervisores activos |
| 2 - Catálogo + Portal B2B | % de pedidos tomados vía vendedor con sugerencia de IA aceptada | ≥ 30% adopción de sugerencias |
| 3 - WhatsApp Bot | % de pedidos tomados vía bot vs vendedor humano | ≥ 15% de volumen vía bot |
| 4 - Growth & Fintech | Uplift en ticket promedio por cliente segmentado | +10-20% en campañas exitosas |
| 4 - Credit Risk | Reducción de cuentas morosas detectadas tarde | -30% morosidad inesperada |

---

## 8.5 Alineamiento con yom.ai como benchmark de referencia

> Esta sección compara producto a producto contra yom.ai (Chile/LATAM), la referencia que más se acerca a la visión propuesta para Mega Dulces.

### 8.5.1 Productos de yom.ai (10 módulos)

| # | Producto yom.ai | Qué hace |
|---|---|---|
| 1 | **Sales** | App móvil para fuerza de ventas con discurso comercial sugerido por IA (reemplaza al "tomapedidos" por consultor estratégico). |
| 2 | **Sales Intelligence** | Motor de recomendaciones: qué vender, cuánto, a quién. Basado en histórico del PdV. |
| 3 | **Execution & Potential of PdV** | Monitoreo de ejecución en estante (alineado con TU producto actual). |
| 4 | **Growth** | Digitalización de relaciones data-driven, perfilamiento, segmentación. |
| 5 | **Marketing** | Campañas personalizadas 1:1 sobre tienditas. |
| 6 | **Fintech / YomWallet** | Notas de crédito, recompensas, cupones, depósitos al tendero. |
| 7 | **B2B Portal** | E-commerce mayorista con canastas estratégicas categorizadas (focus / exploración / innovación / base), precios por segmento, descuentos por volumen. |
| 8 | **Remote Manager** | Módulo de televenta para call center. |
| 9 | **YomGPT** | Representante de ventas conversacional por IA (autoservicio del tendero). |
| 10 | **Command Center + Analytics Center** | Dashboards y supervisión central. |

### 8.5.2 Comparación módulo a módulo: Mega Dulces hoy vs yom.ai

| Módulo yom.ai | Mega Dulces hoy | Gap |
|---|---|---|
| **Execution & Potential of PdV** | ✅ Implementado | Tu mejor zona de overlap. Tu `scoring-v2` + capturas + exhibiciones cubren este módulo al ~80%. Falta extender a mix de productos vendidos (no solo expuestos). |
| **Command Center + Analytics** | 🟡 Parcial | Tienes `/reports` y `/dashboard`. Falta: mapa geo heatmap, drill-down jerárquico, alertas automáticas, vista "operación en vivo". |
| **Sales** (vendedor con IA) | ❌ Cero | Tu app móvil captura auditorías, no pedidos. Falta dominio comercial completo + motor de sugerencias. |
| **Sales Intelligence** (recomendaciones) | ❌ Cero | Sin historial de ventas, sin motor de recomendación. |
| **B2B Portal** | ❌ Cero | No existe portal para el dueño de tienda. |
| **YomGPT** (bot conversacional) | ❌ Cero | Sin integración WhatsApp ni LLM. |
| **Remote Manager** (televenta) | ❌ Cero | No contemplado previamente. **Sección nueva agregada al roadmap abajo.** |
| **Growth** (segmentación 1:1) | ❌ Cero | Contemplado en Fase 4 del plan. |
| **Marketing** (campañas) | ❌ Cero | Contemplado en Fase 4 del plan. |
| **YomWallet** (fintech embebida) | ❌ Cero | **NO estaba en el plan original — requiere extensión grande del scope de Fase 4 + agregar Fase 5.** |

### 8.5.3 Diferenciadores de yom.ai que conviene replicar

1. **Canastas estratégicas categorizadas** — no es "lista de productos sugeridos", es **clasificación por intención comercial**:
   - **Focus**: productos prioritarios para empujar volumen este mes.
   - **Exploración**: nuevas referencias para testear adopción.
   - **Innovación**: lanzamientos recientes con prioridad de visibilidad.
   - **Base**: SKUs estables que el cliente ya compra repetidamente.
   
   Implica una tabla extra `product_strategic_categorization` (rotativa, definida por marketing) además del modelo de recomendación.

2. **Omnicanalidad asistida + autoservicio** — el mismo carrito vive en 4 lugares: app vendedor, portal web, WhatsApp, call center. Requiere **API única de carrito** desde el día 1 (no carritos separados por canal).

3. **Mobile-first explícito** — yom.ai dice abiertamente que "casi 100% de pedidos en canal tradicional vienen de móvil". El portal web es secundario al app y al bot.

4. **Modelo B2B2C** — yom.ai no le vende a la tiendita, le vende a la marca/distribuidora. Implicación para Mega Dulces: **tú eres el cliente final del sistema; las tienditas son tu usuario gratuito**. Define quién paga qué.

5. **Casos de uso de marcas grandes** — yom.ai presenta logos de AB InBev, Coca-Cola, Nestlé, P&G como clientes. La plataforma es genérica y multi-cliente. Mega Dulces puede beneficiarse de diseñar el sistema para **eventualmente venderlo a otras distribuidoras** (decisión multi-tenant que en sección 5.1 había desestimado — vale reconsiderarla con esta referencia).

### 8.5.4 Stack inferido de yom.ai

- **Portal B2B**: Next.js
- **Apps mobile**: React Native
- **IA**: lenguaje genérico ("AI", "ML"), sin proveedor declarado
- **Pagos**: Webpay (Chile) + transferencias
- **WhatsApp**: BSP no nombrado
- **ERP/SAP**: integraciones no documentadas

**Implicación para Mega Dulces**: tu stack actual (Angular + NestJS) es perfectamente viable. No hay razón para migrar a Next.js. La app móvil sí podría replantearse: hoy es Ionic (Angular). Si vas a hacer una app dedicada a vendedores con UX de pedidos, **React Native + Expo** es el estándar de facto del sector (yom.ai, Bsale, FieldPro). Decisión a evaluar en Fase 2.

### 8.5.5 Módulos que faltan agregar al roadmap original

#### Nueva Fase 2.5 — Remote Manager (Televenta) — 4 semanas

Después del portal B2B + catálogo, agregar módulo de call center:

- UI separada para operador telefónico con vista "asistente comercial".
- Permite buscar cualquier cliente, abrir su carrito persistente (compartido con web/app/bot).
- Sugerencias de canasta estratégica visibles al operador en tiempo real durante la llamada.
- Métricas de productividad por operador (llamadas/hora, conversión, ticket promedio).

#### Nueva Fase 5 — Fintech (YomWallet equivalent) — 12-16 semanas

**Solo después de Fase 4 completa.** Requiere histórico de pagos y comportamiento crediticio.

| Sub-componente | Descripción |
|---|---|
| Wallet del tendero | Saldo a favor (notas de crédito, cashback, recompensas). Tablas: `customer_wallets`, `wallet_transactions`. |
| Sistema de cupones | Cupones digitales aplicables en checkout. Tablas: `coupons`, `coupon_redemptions`. |
| Línea de crédito gestionada | Crédito automático en cada pedido según `risk_score` (de Fase 4). Tablas: `credit_lines`, `credit_movements`. |
| Programa de recompensas | Puntos por volumen / lealtad / cumplimiento. |
| Depósitos directos a cuenta | Integración con sistema bancario (Banxico, Mercado Pago, etc.) para liquidar saldos a favor en cuenta del tendero. **Aquí necesitas partner financiero formal.** |
| Reportes regulatorios | Si manejas dinero del cliente, hay obligaciones fiscales (CFDI, retenciones). Asesoría legal **obligatoria**. |

### 8.5.6 Decisión multi-tenant — REABRIR

En sección 5.1 propuse NO implementar multi-tenancy. Con yom.ai como referencia (que sirve a 20+ marcas/distribuidoras desde la misma plataforma), conviene **reconsiderar al inicio de Fase 2**:

**Opción A — Single-tenant (mi propuesta original):**
- Más rápido construir.
- Si Mega Dulces quiere vender el sistema a otra distribuidora en el futuro → refactor masivo.

**Opción B — Multi-tenant desde Fase 2:**
- ~20-30% más de trabajo inicial (cada tabla nueva lleva `tenant_id`).
- Permite venderlo después como SaaS sin reescribir.
- Aún para uso interno, separa "Mega Dulces" como tenant default y queda preparado.

**Mi recomendación actualizada con la referencia de yom.ai**: **Opción B**. El costo marginal de agregar `tenant_id` al inicio es bajo; el costo de retrofittearlo después es altísimo. Y abre la puerta a un modelo de negocio (vender el sistema a otras distribuidoras) que sin esto queda cerrado.

### 8.5.7 Cumplimiento actualizado con referencia yom.ai

| Producto yom.ai | % cumplido por Mega Dulces hoy |
|---|---|
| Execution & Potential of PdV | ~80% |
| Command Center + Analytics | ~50% |
| Sales | 5% (solo offline-first reutilizable) |
| Sales Intelligence | 0% |
| B2B Portal | 0% |
| YomGPT (bot IA) | 0% |
| Remote Manager | 0% |
| Growth | 0% |
| Marketing | 0% |
| YomWallet (fintech) | 0% |
| **TOTAL ponderado contra yom.ai como benchmark** | **~14%** |

> **Cumples principalmente el módulo de "Execution & Potential of PdV" — la parte más madura de tu plataforma actual.** Es la base sólida sobre la cual yom.ai sería tu blueprint del resto.

---

## 9. Próximo paso recomendado

> **Confirmando con yom.ai como benchmark**, el cumplimiento de Mega Dulces es ~14% de la plataforma completa (vs 22% que dimos al inicio sin esa referencia — la diferencia son los módulos de YomWallet y Remote Manager que no estaban en el plan).

**Empezar por Fase 0 + el primer entregable de Fase 1** (modelo `exhibition_products`). Esto:
1. Mejora directamente lo que ya tienen los supervisores hoy.
2. Es entregable en 4-6 semanas con bajo riesgo.
3. Sienta bases de queue + observability que necesitarán todas las fases siguientes.
4. Genera momentum y prueba interna del approach antes de comprometerse con WhatsApp/ML/credit risk.

> **No intentar abarcar los 4 pilares en paralelo.** Cada uno tiene dependencias técnicas y operativas con los anteriores. El orden propuesto es: Fase 0 → 1 → 2 → 3 → 4.
