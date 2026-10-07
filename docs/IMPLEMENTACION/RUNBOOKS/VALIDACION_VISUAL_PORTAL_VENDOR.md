# Checklist de validación visual — Portal B2B + Modo Vendedor

> Para correr en el browser con dev servers (`localhost:4200` view + `localhost:3334` API multi-tenant). Marcar `[x]` al validar cada item.

---

## Pre-requisitos

- [ ] API arriba en `:3334` con `ENABLE_MULTITENANT=true` y `JWT_SECRET=super_secret_dev_key_change_in_prod`.
- [ ] View arriba en `:4200` (`npx nx serve view`).
- [ ] DevTools abierto: Network + Console + Application (para inspeccionar localStorage del token).

**Credenciales:**

| Rol | tenant_slug | username | password |
|---|---|---|---|
| Portal B2B (cliente) | `mega_dulces` | `cliente_demo` | `cliente_demo` |
| Vendedor / Admin | `mega_dulces` | `superoot` | `superoot` |

---

## Parte A — Portal B2B (cliente)

### A.1 — Login
1. [ ] Ir a `http://localhost:4200/portal/login`
2. [ ] Form muestra 3 campos: tenant_slug, username, password
3. [ ] Login con `mega_dulces` / `cliente_demo` / `cliente_demo`
4. [ ] Redirect a `/portal/catalog`
5. [ ] `localStorage` tiene `access_token` válido (JWT con `role_name=customer_b2b`)
6. [ ] **Negativo**: intento login con password incorrecto → toast/error rojo, NO redirect

### A.2 — Catálogo
7. [ ] `/portal/catalog` muestra grid de productos
8. [ ] Cada card muestra: nombre, brand, precio SEGÚN el cliente (no precio genérico)
9. [ ] Botón "Agregar" funciona y suma al carrito (badge en header)
10. [ ] Productos sin stock o sin precio NO se pueden agregar (botón disabled o no aparece)
11. [ ] Búsqueda/filtro por nombre filtra el grid en tiempo real

### A.3 — Carrito
12. [ ] Ir a `/portal/cart` desde el badge del header
13. [ ] Líneas muestran nombre, cantidad editable, subtotal
14. [ ] Editar cantidad recalcula subtotal y total
15. [ ] Quitar línea (×) la borra y recalcula total
16. [ ] Botón "Confirmar pedido" abre ConfirmDialog
17. [ ] Al confirmar: redirect a `/portal/orders`, pedido aparece en la lista con status `draft` o `confirmed`

### A.4 — Mis pedidos
18. [ ] `/portal/orders` muestra lista con folio, fecha, status, total
19. [ ] Click en un pedido → `/portal/orders/:id`
20. [ ] Detalle muestra: header (folio + status + totales), líneas con producto/cantidad/precio
21. [ ] **Timeline** de historial: muestra transición(es) de status (ej: `null → draft`, `draft → confirmed`)
22. [ ] Cada transición muestra `changed_by_username` y timestamp

### A.5 — Recomendaciones (canasta estratégica)
23. [ ] `/portal/recommendations` muestra 4 secciones: Base / Foco / Exploración / Innovación
24. [ ] Cada sección con su icono y tag de severidad
25. [ ] Cards muestran producto, score% (0-100), reason en texto, precio sample
26. [ ] Si una sección tiene 0 items, muestra placeholder, no crashea

### A.6 — Tenant isolation visual
27. [ ] Logout (botón en header)
28. [ ] Re-login con tenant_slug FAKE (`acme_fake` o el que sea) y `cliente_demo` → debe FALLAR (no existe ese tenant)

---

## Parte B — Modo Vendedor (admin/colaborador)

### B.1 — Acceso
1. [ ] Logout del portal
2. [ ] Login en `/login` (admin layout) con `superoot` / `superoot`
3. [ ] En el sidebar, ítem **"Modo Vendedor"** (icono briefcase)
4. [ ] Click → redirect a `/vendor/customers`
5. [ ] **Negativo**: si fuera un usuario sin permiso `COMMERCIAL_ORDERS_CREAR`, el ítem no aparece

### B.2 — Lista de clientes
6. [ ] `/vendor/customers` muestra header sticky + lista de clientes (mobile-first, 1 columna)
7. [ ] Bottom nav muestra 2 tabs: **Clientes** + **Mi día**
8. [ ] Search input filtra debounced (~250ms de delay al tipear)
9. [ ] Search por nombre o code funciona
10. [ ] Click en un cliente → `/vendor/take-order/:customer_id`

### B.3 — Tomar pedido
11. [ ] Página combinada: arriba catálogo (productos del cliente con SU precio), abajo carrito sticky
12. [ ] Tap "Agregar" en un producto → entra al carrito sticky con cantidad 1
13. [ ] Cambiar cantidad con +/- recalcula subtotal
14. [ ] Carrito sticky muestra total al pie con botón "Confirmar"
15. [ ] Confirmar → dialog de confirmación → POST al backend → toast OK → redirect a `/vendor/today`

### B.4 — Mi día
16. [ ] `/vendor/today` muestra 3 KPI cards: pedidos hoy, total facturado hoy, # clientes visitados
17. [ ] Lista debajo de pedidos del día con folio, cliente, status, total
18. [ ] Pull-to-refresh o botón refresh trae el último estado

### B.5 — Mobile responsiveness
19. [ ] Activar DevTools mobile view (iPhone 13 / Pixel 5)
20. [ ] Header sticky NO se rompe
21. [ ] Bottom nav siempre visible en `/vendor/*`
22. [ ] Inputs (search, cantidad) no zoom-in al focus (font-size ≥ 16px)
23. [ ] Carrito sticky en take-order no tapa el último producto del catálogo

### B.6 — Guard rejection
24. [ ] Hacer logout y login con `cliente_demo` (rol `customer_b2b`)
25. [ ] Intentar abrir directamente `http://localhost:4200/vendor/customers` → redirect a `/portal/catalog` (no debería ver el módulo vendor)

---

## Issues encontrados

> Anotar cualquier bug visual aquí. Si es crítico, abrir item nuevo en el tracker.

| # | Severidad | Página | Descripción |
|---|---|---|---|
|   |   |   |   |

---

## Cierre

- [ ] **Parte A completa** (28 checks portal)
- [ ] **Parte B completa** (25 checks vendedor)
- [ ] **0 issues críticos abiertos** o documentados en tracker.

Si todo verde → marcar en tracker:
- `[D.3.10] Validación visual portal — ✅`
- `[D.5.3] Validación visual vendor — ✅`
