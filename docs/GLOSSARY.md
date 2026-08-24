# Glosario — términos de dominio y nombres internos

> Para que el español de negocio y los nombres clave del proyecto no sean un muro.
> Si te cruzás un término que no está acá, agregalo.

---

## Negocio / dominio (retail y distribución de dulces)

| Término | Qué es |
|---|---|
| **Mega Dulces** | El cliente/negocio: distribuidora de dulces en México. Primer (y hoy único) *tenant* de la plataforma. |
| **Tenant** | Cliente/organización aislada en la plataforma multi-tenant. Cada fila de datos lleva `tenant_id`; RLS aísla un tenant de otro. |
| **CEDIS** | Centro de distribución (el almacén central mayorista). En Kepler es la sucursal `00`. |
| **Sucursal** | Tienda/plaza física. Numeradas `01`–`06`. Cada una tiene su propia DB Kepler. |
| **Almacén (warehouse)** | Ubicación de inventario. Puede ser un CEDIS, una tienda, o un camión de ruta. |
| **PdV** | Punto de venta — la tienda del cliente al que se le vende/audita. |
| **SKU** | Código único de producto. En Kepler es `kdii.c1`; en la plataforma `products.sku`. |
| **Folio** | Número de documento (pedido, factura, cobro, recepción…). **No es único entre tipos de documento** en Kepler. |
| **Exhibición** | Montaje/display del producto en el PdV. Núcleo del negocio original de *trade marketing*. |
| **Planograma** | El layout ideal de cómo deben acomodarse los productos en el anaquel. |
| **Ruta** | Recorrido de venta/entrega que hace un vendedor o camión (ej. "RUTA 21"). |
| **Vendedor** | Persona que toma pedidos / audita en campo. App `apps/vendor`. |
| **Cliente (customer)** | El comercio que compra (tiendita, mayorista…). `commercial.customers`. |
| **Traspaso** | Movimiento de inventario entre almacenes (sin venta). Kepler: documentos género `N`. |
| **Captura** | Registro que hace el vendedor/auditor en campo (foto, conteo, pedido). |
| **Visita** | Evento de un vendedor/auditor en un PdV; se le hace *scoring*. |

## Compras / inventario

| Término | Qué es |
|---|---|
| **Reabastecimiento** | Reponer stock. Proyecto *Compras* (`/compras`). Ver Fase RA. |
| **Punto de reorden** | Nivel de existencia que dispara una compra. Kepler: `kdii.c34` (mín `c33`, máx `c35`). |
| **Existencia** | Stock disponible. Kepler: `kdil.c9`. |
| **Requisición / Orden de compra / Orden de entrada / Vale de entrada** | Etapas de la cadena de compra en Kepler (`X-A-30 → 35 → 37 → 40 → 20`). Ver [`ERP_KEPLER.md`](ERP_KEPLER.md) §3. |
| **Rotación** | Qué tan rápido se vende un producto. Clasificado en `rotation_tier` (alta/media/baja/dead). |
| **Sell-out** | Venta real al consumidor final (vs *sell-in* = venta al comercio). |
| **Box factor / factor de caja** | Piezas por caja. Kepler: `kdii.c84`. Clave para no inflar unidades. |
| **ABC / XYZ** | Segmentación de productos por valor (ABC) y variabilidad de demanda (XYZ). |

## Finanzas / contable / fiscal

| Término | Qué es |
|---|---|
| **Cobro** | Pago que hace un cliente. Kepler: documento `U-A-5` (serie `UA0501`). |
| **Pago a proveedor** | Kepler: `X-D-26` transferencia / `X-D-25` cheque / `X-D-60` anticipo. |
| **CxP / CxC** | Cuentas por Pagar (a proveedores) / por Cobrar (de clientes / cartera). |
| **Cartera** | Saldo vivo de lo que deben los clientes. |
| **Factoraje** | Financiamiento contra facturas; en el catálogo cuenta como compra a proveedor. |
| **Arqueo** | Conteo/cuadre de efectivo (caja). |
| **Póliza** | Asiento contable. Kepler: `kdc2YYMM`. |
| **Balanza** | Balanza de comprobación (saldos por cuenta contable). |
| **EFOS (69-B)** | Empresas que Facturan Operaciones Simuladas — listas negras del SAT. Riesgo fiscal. |
| **CFDI** | Comprobante Fiscal Digital (factura electrónica mexicana). |
| **Conciliación bancaria** | Cuadrar los movimientos del banco vs el ERP. Fase CB (`/finanzas/bancos`). |

## Canales de venta (proyectos)

| Término | Qué es |
|---|---|
| **Portal B2B** | Web donde el cliente hace sus pedidos solo. `apps/portal`, rutas `/portal/*`. |
| **Modo Vendedor** | App móvil del vendedor para tomar pedidos en ruta. `apps/vendor`, `/vendor/*`. |
| **Televenta** | Venta telefónica (remote manager). `/televenta/*`. Rol `tele_operator`. |
| **Última Milla** | Entrega a domicilio local (en moto). Fase LM. |
| **Venta en Ruta** | Autoventa offline-first desde el camión. Fase VR. |

## Sistemas externos

| Término | Qué es |
|---|---|
| **Kepler** | El ERP de Mega Dulces (retail/distribución MX). Schema ofuscado. Ver [`ERP_KEPLER.md`](ERP_KEPLER.md). |
| **Wincaja** | Sistema de punto de venta de algunas sucursales (corre sobre Access 97). |
| **ContPAQi** | Sistema contable/fiscal externo (SQL Server) — *system of record* contable. Fase CP. |
| **MagniTracking** | Proveedor de rastreo GPS de la flota (GPS-Server.net). Fase LT. |
| **Railway** | La plataforma cloud donde corre prod (API + DBs). |
| **Cloudinary / Tigris (S3)** | Almacenamiento de imágenes/media. |

## Motores de IA (nombres internos)

| Nombre | Qué es |
|---|---|
| **Thot** | Motor de inteligencia **comercial** (rotación, margen, afinidad, sugeridos). `libs/commercial`. ADR-018. |
| **Horus** | Supervisor de IA de **ejecución en trade** (auditoría de ruta, visión de fotos, fraude). `libs/trade`. ADR-020. |
| **Maat** | IA de **finanzas** (chat, detección de patrones, hallazgos). `libs/finance`. ADR-028. |
| **Regla común** | *El motor decide, el agente comunica, el LLM queda fuera del camino del dinero* (ADR-016). |

## Arquitectura / plataforma

| Término | Qué es |
|---|---|
| **`kepler_ods`** | Modelo canónico: una tabla por entidad Kepler, alimentada por replicación lógica. La fuente de verdad para dato de Kepler. |
| **Schemas** | `commercial.*` (core comercial), `analytics.*` (reportes/MVs), `finance.*`, `logistics.*`, `trade.*`, `hr.*`. |
| **RLS** | Row Level Security de Postgres — aísla datos por tenant. Ver [`GOTCHAS.md`](GOTCHAS.md) §1. |
| **`TenantKnexService`** | El servicio obligatorio para queries a tablas con RLS (setea el contexto de tenant). |
| **Multi-tenant** | Arquitectura shared-DB + `tenant_id` en toda tabla + RLS. ADR-010. |
| **Fase (A, B, C… J, RA, CB, CP…)** | Unidad de trabajo del roadmap. El detalle de cada una está en `docs/IMPLEMENTACION/FASES/`. |
| **ADR** | Architecture Decision Record — decisión técnica registrada en `docs/IMPLEMENTACION/02_DECISIONES_ARQUITECTURA.md`. |
| **Tracker** | El kanban en markdown (`docs/IMPLEMENTACION/01_TRACKER_PROGRESO.md`). Se actualiza al cerrar items. |
