# Mapa de módulos — cómo se implementa y cómo se conecta todo

> Un solo lugar para ver la suite completa: **de dónde nace el dato, por dónde pasa, qué módulo
> lo usa y cómo se hablan los módulos entre sí.** Medido contra el código el **2026-10-27**
> (`apps/`, `libs/`, `apps/api/src/composition/`, `layout.component.ts`, `ops/k3s/`).
>
> Este doc es el **índice**; el detalle vive en otros:
> [`ARCHITECTURE.md`](ARCHITECTURE.md) (código) · [`ARQUITECTURA_DATOS.md`](ARQUITECTURA_DATOS.md)
> (tablas y FKs) · [`ops/README.md`](../ops/README.md) (qué corre dónde) ·
> [`ERP_KEPLER.md`](ERP_KEPLER.md) (doctypes) · [`FLUJO_COMPRA_A_PAGO.md`](FLUJO_COMPRA_A_PAGO.md) ·
> [`FLUJO_VENTA_A_COBRO.md`](FLUJO_VENTA_A_COBRO.md).
>
> ⚠️ `ARQUITECTURA_DATOS.md` §1 todavía dibuja **Railway** como prod y `.245` como consolidación.
> Las dos cosas quedaron atrás: prod es `pg-prod` en el servidor `md` (k3s) desde el 2026-09-22,
> y `.245` ya no se usa. El diagrama §1 de este doc es el vigente.

---

## 1. Las capas físicas (de la fuente a la pantalla)

```mermaid
flowchart TB
    subgraph SRC["① FUENTES — on-prem, LAN (nadie las toca desde la suite)"]
        direction LR
        K["Kepler ERP<br/>un Postgres por sucursal<br/>tablas kdXX / columnas cN"]
        W["Wincaja POS<br/>Access 97 (.mdb)"]
        CP["ContPAQi<br/>SQL Server — SoR contable"]
        CK["Relojes ZK<br/>(asistencia)"]
        CA["CAOS .110<br/>caja fuerte"]
        GPS["MagniTracking<br/>GPS flota"]
    end

    subgraph ING["② INGESTA — servidor md 192.168.0.222 (k3s, ns ingesta)"]
        direction LR
        REP["pgvector-md :5433<br/>8 réplicas lógicas<br/>de las sucursales"]
        HOT["ods-live-hot @15 s<br/>ods-live-mirror @300 s<br/>ods-live-caja"]
        REC["ods-reconcile @900 s<br/>reconcile-chicas / -full / -ancho<br/>(completitud y borrados)"]
        CRON["feeds-cron (17 carriles)<br/>feeds-livefast @60 s<br/>store-poller @25 s"]
        WC[".249 (Windows)<br/>3 carriles Wincaja<br/>Jet 32-bit"]
    end

    subgraph DB["③ pg-prod — md :5434 (multi-tenant + RLS)"]
        direction LR
        ODS["kepler_ods.* / wincaja.*<br/>espejo crudo del ERP<br/>(la fuente canónica)"]
        AN["analytics.*<br/>VISTAS derive-no-copy<br/>sobre kepler_ods"]
        OWN["commercial · catalog · identity<br/>finance · fiscal · logistics<br/>trade · reconciliation · hr<br/>(datos PROPIOS: HITL, OCR, firmas)"]
    end

    subgraph APP["④ BACKEND — k3s ns prod"]
        direction LR
        API["api (NestJS)<br/>composition root"]
        WRK["worker<br/>colas / cron"]
        RD["redis"]
    end

    subgraph UI["⑤ INTERFACES"]
        direction LR
        VIEW["view :30080<br/>suite de operación"]
        POR["portal :30081<br/>B2B cliente"]
        VEN["vendor :30082<br/>vendedor de campo"]
        WA["WhatsApp bot"]
    end

    K -->|replicación lógica| REP --> HOT --> ODS
    REP --> REC --> ODS
    K & CP & CA --> CRON --> ODS & OWN
    W --> WC --> ODS
    CK --> OWN
    GPS -->|FleetPoller del API| OWN
    ODS --> AN
    AN & OWN & ODS --> API
    API <--> WRK
    API <--> RD
    API --> VIEW & POR & VEN & WA
```

**Las cuatro reglas que ordenan este dibujo:**

1. **Toda cifra del ERP sale de `kepler_ods`**, de **una** tabla principal, y se le da forma con una
   **vista** en `analytics.*`. No hay importers nuevos ni copias (reglas 1 y 2 de `CLAUDE.md`).
2. **Las tablas propias** (`commercial.*`, `finance.*`…) guardan **sólo lo que la suite crea**: una
   firma, un conteo, una solicitud, un OCR, un hallazgo. No guardan una segunda versión del ERP.
3. **Las apps leen siempre de `pg-prod`**, nunca de Kepler, Wincaja o ContPAQi directo.
4. **La frescura de cada carril se ve en `/admin/db-health`** (latidos `cron_runs` / `ods.ctl`).

---

## 2. Cómo se implementa un módulo (las 4 capas)

Cada módulo de negocio tiene las mismas cuatro capas, en este orden. Una fase **no sube de capa**
hasta que la de abajo está verificada ([`METODO_DE_TRABAJO.md`](METODO_DE_TRABAJO.md)).

```mermaid
flowchart LR
    C0["C0 · DATO<br/>kepler_ods.kdXX<br/>→ vista analytics.*<br/>o tabla propia<br/>(migración generada)"]
    C1["C1 · DOMINIO<br/>libs/&lt;dominio&gt;/src/lib/&lt;módulo&gt;<br/>*.service.ts<br/>reglas en libs/contracts"]
    C2["C2 · API<br/>*.controller.ts<br/>@RequirePermission(KEY)<br/>TenantKnexService.run()"]
    C3["C3 · UI<br/>apps/view/src/app/modules/&lt;espacio&gt;<br/>página + ruta + permiso<br/>+ renglón del sidebar"]
    C0 --> C1 --> C2 --> C3
```

| Capa | Dónde vive | Qué la verifica |
|---|---|---|
| C0 dato | `database/migrations*/`, vistas sobre `kepler_ods` | lectura de prod contra un testigo independiente (ADR-059) |
| C1 dominio | `libs/<dominio>/src/lib/<módulo>/` | `vitest` del lib + reglas en `libs/contracts` |
| C2 API | controller del mismo lib, cableado en `apps/api` | prueba contra base real para lo que **escribe** (regla 13) |
| C3 UI | `apps/view/src/app/modules/<espacio>/pages/` | `check:pantalla`, `check:templates`, `check-sidebar-tabs` |

**El permiso es la costura entre capas:** una **clave** del enum (`Permission.X`, ADR-054) la usa el
controller (C2), la ruta y la pestaña (C3), y se **reparte** en prod a los roles (regla 20). El
sidebar no da ni quita acceso: sólo muestra lo que el permiso ya permite.

---

## 3. El backend: dominios y cómo se hablan

`apps/api` es **delgado**: trae la plataforma (`auth`, `auth-mt`, `cron`, `db-health`,
`kepler-consolidado`, `kp`, `store`, `tenants-admin`, `catalogo-interno`, `dev-projects`) y cablea los
dominios. **Los dominios no se importan entre sí**: cuando uno necesita algo de otro, declara un
**puerto** en `libs/contracts` y `apps/api/src/composition/*.binding.module.ts` le conecta la
implementación.

### 3.1 Los dominios (`libs/`)

| Lib | Qué resuelve | Módulos principales |
|---|---|---|
| `platform-core` | Infra compartida (hoja: no depende de nadie) | database/tenant (RLS), ability (permisos), scope, cache, queue, storage, ai, ai-product-matcher, provenance, pdf |
| `contracts` | Tipos, DTOs, **puertos** y reglas que comparten dos pantallas | — (sin runtime) |
| `commercial` | Todo lo que vende, compra y mueve mercancía | orders, customers, pricing, promotions, products, inventory, **replenishment** (pedido), **receiving** (entradas), picking, televenta, quotes, sales-documents, tickets, route-control, profitability, standard-cost, intelligence (Thot), push |
| `finance` | El dinero | **payment-calendar**, pagos, payment-program, creditor-statements, bank, caja, caos, cortes-sucursales, collection-deposits, customer-ledger, expense-*, budget, contpaqi, polizas, purchase-book, trip-pay, maat |
| `fiscal` | SAT y contabilidad | cfdi, descarga, estatus, emision, listas (69-B), diot, impuestos, conciliacion, contabilidad, materialidad, vault |
| `logistics` | Entregar | shipments, erp-shipments, routing, tracking, fleet, fleet-cost, guides, payroll, trip-closure, checklists, cartaporte |
| `trade` | Ejecución en punto de venta (el negocio original) | visits, daily-captures, scoring, planograms, stores, reports, commercial-map, supervisor-ai (Horus), websocket |
| `reconciliation` | Cuadres de caja e inventario | cash-cuts-sync, blind-count, movement-reconcile, scanner de descuadres |
| `hr` | Personas | attendance (relojes), talent (reclutamiento) |
| `service-desk` | Mesa de servicio | requests, routing, sla, notifications, dictado |
| `whatsapp` | Canal conversacional | webhook, conversation, orders, broadcast, promos |

### 3.2 Los puertos (las únicas costuras entre dominios)

Medido de los 14 `*.binding.module.ts` y de quién hace `@Inject(<PUERTO>)`:

```mermaid
flowchart LR
    subgraph WA["whatsapp"]
        wah["webhook"]
        wac["conversation / orders / broadcast"]
    end
    subgraph COM["commercial"]
        cord["orders / payments"]
        crep["replenishment"]
        cimpl["(implementa notificadores,<br/>pedidos y alta de clientes)"]
    end
    subgraph FIN["finance"]
        fbc["bank-capture"]
        fpb["purchase-book"]
        fsink["findings sink<br/>(bandeja de hallazgos)"]
        fusers["caja · bank · polizas · maat<br/>budget · expense-proofs<br/>goods-receipt-proofs…"]
    end
    subgraph FIS["fiscal"]
        fis["emision (timbrado)"]
        fes["estatus CFDI"]
        fcon["conciliacion · listas"]
    end
    subgraph LOG["logistics"]
        lsh["shipments"]
    end
    subgraph TRD["trade"]
        tst["stores"]
    end
    subgraph REC["reconciliation"]
        rbc["blind-count · cash-count-sla<br/>scanner"]
    end
    subgraph HR["hr"]
        htal["talent"]
    end
    subgraph SD["service-desk"]
        sdn["notifications"]
    end

    wah -- BANK_CAPTURE --> fbc
    wah -- RECRUITMENT_BOT --> htal
    wac -- COMMERCE_CONVERSATION --> cimpl
    cord -- INVOICE_ISSUER --> fis
    fpb -- CFDI_ESTATUS --> fes
    lsh -- ORDER_FULFILLMENT --> cimpl
    tst -- CUSTOMER_PROVISIONING --> cimpl
    htal -- RECRUITMENT_OUTBOUND --> wac
    crep & fusers & fcon & rbc -- FINANCE_FINDINGS_SINK --> fsink
    crep & fusers & rbc -- FINANCE_NOTIFIER --> cimpl
    rbc -- RECON_NOTIFIER --> cimpl
    sdn -- SERVICE_DESK_CHANNEL --> cimpl
```

| Puerto | Lo pide | Lo implementa | Para qué |
|---|---|---|---|
| `ORDER_FULFILLMENT_PORT` | logistics/shipments | commercial | un embarque marca surtido/entregado el pedido |
| `INVOICE_ISSUER_PORT` | commercial/orders, payments | fiscal | facturar (timbrar) un pedido o un pago |
| `CFDI_ESTATUS_PORT` | finance/purchase-book | fiscal | ¿la factura del proveedor sigue vigente en el SAT? |
| `CUSTOMER_PROVISIONING_PORT` | trade/stores | commercial | una tienda de trade se vuelve cliente comercial |
| `COMMERCE_CONVERSATION_PORT` | whatsapp | commercial | el bot consulta catálogo/precio y levanta pedido |
| `BANK_CAPTURE_PORT` | whatsapp/webhook | finance | una foto de ficha de depósito entra a bancos |
| `FINANCE_FINDINGS_SINK_PORT` | 10 módulos (finance, fiscal, replenishment) | finance | **una sola bandeja** de hallazgos (ADR-056) |
| `FINANCE_NOTIFIER_PORT` · `RECON_NOTIFIER_PORT` · `HEALTH_NOTIFIER_PORT` | caja, bancos, cuadres, db-health… | commercial / whatsapp | avisar (realtime, push, WhatsApp) |
| `RECRUITMENT_BOT_PORT` · `RECRUITMENT_OUTBOUND_PORT` | whatsapp ↔ hr/talent | hr / whatsapp | reclutamiento por WhatsApp |
| `SERVICE_DESK_CHANNEL_PORT` · `MAILER_PORT` | service-desk, db-health | commercial / api | canales de aviso de la mesa de servicio y correo |

### 3.3 Un request, de punta a punta

```mermaid
sequenceDiagram
    participant U as Pantalla (view/portal/vendor)
    participant G as api · auth-mt + guards
    participant C as Controller del dominio
    participant S as Service (libs/*)
    participant DB as pg-prod (RLS)
    U->>G: HTTP + JWT
    G->>G: valida JWT · TenantContextInterceptor<br/>@RequirePermission(KEY) · scope (sucursal/zona)
    G->>C: request con tenant + usuario
    C->>S: llama al caso de uso
    S->>DB: TenantKnexService.run()<br/>BEGIN · SET LOCAL app.tenant_id
    DB-->>S: sólo filas del tenant (rol app_runtime)
    S-->>C: dato + procedencia (frescura, measured)
    C-->>U: JSON · Socket.IO para lo realtime
```

⛔ Sin tenant, RLS devuelve **cero filas**, no un error. Cero filas por defecto y cero por desuso se ven
igual ([`GOTCHAS.md`](GOTCHAS.md)).

---

## 4. El frontend: espacios → módulos → dominio

`apps/view` se divide en **espacios** (`apps/view/src/app/modules/<espacio>`); cada uno tiene su
sidebar en `layout.component.ts`. Un renglón con `tabs:` es un **apartado**: una entrada que abre una
barra de pestañas, y cada pestaña conserva su propio permiso.

| Espacio | Grupos del sidebar (hoy) | Dominio backend principal |
|---|---|---|
| **Mi trabajo** (`/projects`) | bandeja por responsabilidad, Cuadro de Resultados por Puesto | todos (lee) |
| **Trade** (`/dashboard`) | Dashboard, Captura diaria, Reportes, Seguimiento, Mapas, Supervisor IA, Asignación, Tiendas, Planograma | `trade` |
| **Comercial** | Ventas · Precios y promociones · Ruta y vendedores · Reportes | `commercial` |
| **Telemarketing** | Mi turno · Lo que sale del canal (cotizaciones, facturación) | `commercial/televenta`, `quotes`, `sales-documents` |
| **Compras** | Compra · Recepción y pago · Catálogo y costos | `commercial/replenishment`, `receiving` + `finance/payment-calendar`, `creditor-statements` |
| **Almacén** (WMS) | existencia, surtido, cuadre, movimientos | `commercial/inventory`, `picking`, `movements` |
| **Reparto** | Surtido, Asignar, Pedidos WhatsApp, Seguimiento, Cortes | `commercial/home-delivery`, `rider-liquidation` |
| **Logística** | Operación · Flota y personal · Costos y reportes | `logistics` |
| **Tienda** | Operación (verificador, en vivo, cajas) · Análisis y control (arqueo, caducidades, etiquetas) | `commercial/tickets`, `labels`, `reconciliation` |
| **Finanzas** | Ingresos · Caja y bancos · Egresos · Registro y análisis | `finance` |
| **Contabilidad** | Fiscal/SAT · Facturación · Contabilidad · Impuestos · Credenciales | `fiscal` + `finance/contpaqi`, `polizas`, `purchase-book` |
| **RH** | Asistencia, Incidencias, Relojes | `hr` |
| **Servicio** | Bandeja, Mis solicitudes, Reportes, Configuración | `service-desk` |
| **Administración** | Personas, Puestos, Responsabilidades, Roles, Salud DB | `api` (auth-mt, tenants-admin, db-health) |
| **Desarrolladores** | Proyectos | `api/dev-projects` |

Las otras apps: **`portal`** (el cliente B2B pide y paga; usa `commercial`), **`vendor`** (el vendedor
de campo, offline con Dexie; usa `commercial` + `trade`) y el **bot de WhatsApp** (`whatsapp` →
puertos de `commercial` y `finance`).

---

## 5. Cómo se interconecta el negocio (el flujo completo)

Las cajas grises son **Kepler** (el ERP donde se asienta la operación). Las de color son **pantallas
de la suite**. La suite **lee** a Kepler por el ODS; hoy **no escribe** en él (§6).

```mermaid
flowchart LR
    classDef kep fill:#e7e5e4,stroke:#78716c,color:#1c1917
    classDef ui fill:#fff7ed,stroke:#ea580c,color:#1c1917
    classDef fin fill:#ecfdf5,stroke:#059669,color:#1c1917

    subgraph COMPRA["COMPRA → PAGO  (FLUJO_COMPRA_A_PAGO.md)"]
        direction TB
        P1["Compras › Existencia<br/>+ Alertas de abasto"]:::ui --> P2["Compras › Pedido<br/>(sugerido, aprobación)"]:::ui
        P2 --> K1["X-A-30 requisición<br/>→ 35 → 37 OC"]:::kep
        K1 --> K2["X-A-40 vale<br/>X-A-20 orden de entrada"]:::kep
        K2 --> P3["Compras › Control de entradas<br/>(recepción 360, reclamos)"]:::ui
        K2 --> K3["kdxe: nace la deuda<br/>con el proveedor"]:::kep
        K3 --> P4["Compras › Revisión de facturas<br/>+ Finanzas › Deuda con proveedores"]:::fin
        P4 --> P5["Pago a proveedor › Obligaciones<br/>→ Calendario de pagos<br/>(firma, Cuentas de pago)"]:::fin
        P5 --> K4["X-D-26/25/60 pago<br/>kdxf aplica a facturas"]:::kep
    end

    subgraph VENTA["VENTA → COBRO  (FLUJO_VENTA_A_COBRO.md)"]
        direction TB
        V1["Comercial › Pedidos · Portal<br/>Telemarketing · Vendor · WhatsApp"]:::ui --> K5["U-D-40/41 pedido y embarque<br/>U-D-10 ticket · U-D-23 corte"]:::kep
        K5 --> V2["Logística › Embarques<br/>Reparto › Surtido/Seguimiento"]:::ui
        K5 --> K6["kdue: cartera del cliente"]:::kep
        K6 --> V3["Finanzas › Crédito"]:::fin
        V3 --> K7["U-A-5 / U-A-7 cobro<br/>kdm5 aplica a facturas"]:::kep
    end

    subgraph DINERO["DINERO Y REGISTRO"]
        direction TB
        D1["Tienda › Arqueo<br/>Finanzas › Cortes y arqueos"]:::fin --> D2["Finanzas › Caja<br/>(Caja General, CAOS)"]:::fin
        D2 --> D3["Finanzas › Bancos y conciliación"]:::fin
        D3 --> D4["Contabilidad › Pólizas · Libro de Compras<br/>Puente ContPAQi"]:::fin
        D4 --> CPQ["ContPAQi<br/>(SoR contable)"]:::kep
    end

    K4 --> D3
    K7 --> D3
    K5 --> D1
    TR["Trade › visitas, capturas<br/>Supervisor IA"]:::ui -. alta de cliente .-> V1
    INV["Almacén · inventario<br/>Costo estándar"]:::ui -. existencia y costo .-> P1
    INV -. existencia y precio .-> V1
```

**Los eslabones que unen los procesos** (cada uno es un lugar donde una cifra cruza de un módulo a
otro, y por eso donde más se ha roto algo):

| Eslabón | Sale de | Entra a | Cifra que cruza |
|---|---|---|---|
| Existencia y costo | ODS `kdik` / costo estándar `c77` | Pedido de compra, precios, rentabilidad | piezas en unidad base, costo por pieza ([`UNIDADES_DE_MEDIDA.md`](UNIDADES_DE_MEDIDA.md)) |
| Orden de entrada → deuda | `X-A-20` | `kdxe` → Obligaciones | importe a pagar y su vencimiento (`c18`) |
| Pago → factura | `X-D-26` (`c45` = cuenta de tesorería) | `kdxf` → Deuda con proveedores | qué facturas salda cada pago |
| Venta → cartera | `U-D-*` | `kdue` → Crédito | saldo del cliente (cuidado: espejos `U-D-13` en Oficinas) |
| Cobro → factura | `U-A-5/7` | `kdm5` (`c13`) → Crédito | qué facturas salda cada cobro |
| Corte → caja → banco | `U-D-23`, arqueo | Caja General → Bancos | efectivo entregado, depositado, conciliado |
| Movimiento → póliza | bancos, compras, gastos | ContPAQi | asiento contable (la suite arma el TXT, no escribe en ContPAQi) |

---

## 6. Lo que la suite escribe hacia afuera

| Destino | Estado | Cómo |
|---|---|---|
| **Kepler** | ⛔ **apagado** | El empuje Suite → Kepler (pedido, traspaso, `X-D-26`) existe en diseño (`KR`, `PGP`, `PQ`) pero no está encendido. Hoy lo aprobado en la suite se **recaptura** en Kepler. |
| **ContPAQi** | sólo archivo | ADR-040: ContPAQi es el SoR contable; la suite arma el TXT/puente y nunca escribe directo. |
| **SAT** | sí | timbrado de CFDI (`fiscal/emision`, vía PAC) y descarga masiva (`fiscal/descarga`). |
| **WhatsApp / push / correo** | sí | por los puertos notificadores (§3.2). |
| **Bancos** | ⛔ no | el pago sale por la banca en línea; la suite prepara y firma, no transfiere. |

---

## 7. Mantener este mapa vivo

- Un **puerto nuevo** = un renglón en §3.2 (de dónde sale: `ls apps/api/src/composition`).
- Un **espacio o grupo nuevo del sidebar** = un renglón en §4 (de dónde sale: `layout.component.ts`).
- Un **carril de ingesta nuevo** va en [`ops/README.md`](../ops/README.md), no acá; acá sólo si cambia la forma del §1.
- Un **eslabón de negocio nuevo** (una cifra que pasa de un módulo a otro) = un renglón en la tabla del §5.
