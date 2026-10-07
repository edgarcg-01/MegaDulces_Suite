# 🎨 Dev UI/UX — Trade Marketing en Campo

> **Responsabilidad:** Sistema de diseño, componentes reutilizables, flujo UX de captura en campo, prototipos y experiencia del usuario final.

---

## 1. Design System Actual (del Dashboard HTML)

### 1.1 Paleta de Colores

```css
:root {
  /* Fondos */
  --bg-primary: #06090f;
  --bg-secondary: #0c1220;
  --bg-card: #111a2e;
  --bg-card-hover: #162040;
  --bg-input: #0a1025;

  /* Bordes */
  --border: #1a2744;
  --border-focus: #2563eb;

  /* Acento */
  --accent: #2563eb;
  --accent-light: #3b82f6;
  --accent-glow: rgba(37, 99, 235, 0.2);

  /* Semáforo */
  --success: #059669;
  --success-light: #10b981;
  --warning: #d97706;
  --warning-light: #f59e0b;
  --danger: #dc2626;
  --danger-light: #ef4444;

  /* Texto */
  --text: #e8edf5;
  --text-muted: #8b9cc0;
  --text-dim: #4a5e87;

  /* Efectos */
  --radius: 10px;
  --radius-sm: 6px;
  --shadow: 0 4px 24px rgba(0, 0, 0, 0.3);
  --shadow-glow: 0 0 30px var(--accent-glow);
}
```

### 1.2 Tipografía

| Uso | Familia | Variable CSS |
|---|---|---|
| **Interfaz general** | DM Sans (400, 500, 600, 700) | `--sans` |
| **Datos numéricos / códigos** | IBM Plex Mono (400, 500, 600, 700) | `--mono` |

**Google Fonts import:**
```
DM Sans:ital,wght@0,400;0,500;0,600;0,700
IBM Plex Mono:wght@400;500;600;700
```

### 1.3 Componentes Existentes a Reutilizar

| Componente | Clase CSS | Uso |
|---|---|---|
| Score Card | `.score-card` | KPIs principales con ícono + valor + label |
| Card | `.card`, `.card-header`, `.card-body` | Contenedores de sección |
| KPI Table | `.kpi-table` | Tabla de KPIs con barras de progreso |
| Progress Bar | `.progress-track`, `.progress-fill` | Indicador de cumplimiento |
| Badge | `.badge`, `.badge-success/warning/danger` | Estado semáforo |
| Role Badge | `.role-badge`, `.role-superadmin/ejecutivo/reportes` | Identificador de rol |
| Button | `.btn`, `.btn-accent/danger/success/warning` | Botones con variantes |
| Toggle | `.toggle-switch` | Switches para permisos |
| Modal | `.modal-overlay`, `.modal` | Diálogos modales |
| Nav Tabs | `.nav-tabs`, `.nav-tab` | Navegación por pestañas |
| Period Tabs | `.period-tabs`, `.period-tab` | Selector de periodo |
| Gauge SVG | Función `gaugeCircleSVG()` | Gauges circulares de competencias |
| Radar SVG | Función `radarSVG()` | Radar chart de competencias |
| Bar Chart | `.bar-chart`, `.bar-col`, `.bar-fill` | Gráfica de barras |
| Info Bar | `.info-bar`, `.info-field` | Selectores de contexto |

## 2. Flujo UX de Captura en Campo

### 2.1 Principios de Diseño

| Principio | Métrica | Criterio |
|---|---|---|
| ⚡ **Velocidad** | Tiempo por visita completa | **≤ 2 minutos** |
| 🎯 **Eficiencia** | Tiempo por exhibición individual | **≤ 30 segundos** |
| 🖐️ **Simplicidad** | Taps/inputs por exhibición | Mínima escritura |
| 📶 **Resiliencia** | Soporte sin conexión | Offline básico en MVP |

### 2.2 Flujo Visual

```
┌──────────┐    ┌──────────────┐    ┌─────────────┐
│  🔐      │    │  🏪          │    │  📍         │
│  Login   │───▶│  Seleccionar │───▶│  Check-in   │
│          │    │  Tienda/PDV  │    │  GPS Auto   │
└──────────┘    └──────────────┘    └──────┬──────┘
                                          │
                                          ▼
                ┌──────────────┐    ┌─────────────┐
                │  📋          │    │  ➕         │
                │  Seleccionar │◀───│  Agregar    │
                │  Posición    │    │  Exhibición │
                └──────┬───────┘    └─────────────┘
                       │
                       ▼
                ┌──────────────┐    ┌─────────────┐
                │  🏷️          │    │  📸         │
                │  Seleccionar │───▶│  Tomar Foto │
                │  Tipo        │    │  (1-6 fotos)│
                └──────────────┘    └──────┬──────┘
                                          │
                                          ▼
                ┌──────────────┐    ┌─────────────┐
                │  💾          │    │  ¿Más?      │
                │  Guardado    │───▶│  exhibición  │──Sí──▶ (Volver a Agregar)
                │  Automático  │    │             │
                └──────────────┘    └──────┬──────┘
                                          │ No
                                          ▼
                ┌──────────────┐    ┌─────────────┐
                │  📊          │    │  🚪         │
                │  Score       │───▶│  Check-out  │───▶ ✅ Completado
                │  Automático  │    │             │
                └──────────────┘    └─────────────┘
```

### 2.3 Reglas UX

- **Botones grandes** — Mínimo 44px de alto para touch targets
- **Mínima escritura** — Preferir selects, toggles y checkboxes
- **≤ 30 seg por exhibición** — 3 taps máximo: posición → tipo → foto
- **Guardado automático** — Sin botón manual de save; auto-save al tomar foto
- **Indicador offline** — Barra superior clara cuando no hay conexión
- **Feedback háptico** — Vibración al guardar exhibición exitosamente

## 3. Vistas del Sistema (Web)

### 3.1 Inventario de Vistas

| Vista | Roles | Descripción | Prioridad |
|---|---|---|---|
| **Login** | Todos | Autenticación con usuario/contraseña | P0 |
| **Dashboard KPIs** | Todos | Score cards, tabla KPIs, barras de progreso, competencias | P0 |
| **Captura Diaria** | Ejecutivo, Admin | Tabla de planograma por visita, material y venta | P0 |
| **Reportes** | Admin, Reportes | Filtros + tabla de capturas + export | P0 |
| **Admin: Usuarios** | Admin | CRUD de usuarios con roles | P1 |
| **Admin: Catálogos** | Admin | Gestión de catálogos dinámicos | P1 |
| **Admin: Planograma** | Admin | CRUD de marcas y productos | P1 |
| **Admin: Permisos** | Admin | Toggles de permisos por rol | P1 |
| **Admin: Configuración** | Admin | Metas de KPI + export/import | P2 |
| **Admin: Resumen** | Admin | Estadísticas del sistema | P2 |

### 3.2 Responsive Breakpoints

| Breakpoint | Ancho | Layout |
|---|---|---|
| **Mobile** | < 600px | Stack vertical, sidebar colapsable |
| **Tablet** | 600px – 1000px | Grid 1 columna, tabs horizontales |
| **Desktop** | > 1000px | Grid 2 columnas (main + sidebar 340px) |

## 4. Entregables por Fase

### Fase 3 — Frontend Web 📋

| # | Entregable | Criterio de Aceptación |
|---|---|---|
| UI3.1 | Design System tokens (colores, tipografía, spacing) | Basado en palette actual |
| UI3.2 | Componente library (≥ 15 componentes) | Cards, Buttons, Tables, Badges, Modals, etc. |
| UI3.3 | Prototipos interactivos | Login, Dashboard, Captura, Admin |
| UI3.4 | Dark mode definido | Variables CSS coherentes |
| UI3.5 | Responsive breakpoints | Mobile-first, 3 breakpoints |

### Fase 4 — App Móvil 📋

| # | Entregable | Criterio de Aceptación |
|---|---|---|
| UI4.1 | Wireframes móviles flujo de campo | Botones grandes, mínima escritura |
| UI4.2 | Prototipo check-in → exhibición → foto | ≤ 3 taps por exhibición |
| UI4.3 | Indicadores de estado offline/sync | Claro y no intrusivo |
| UI4.4 | Guía de iconografía para campo | Set consistente de emojis/iconos |

## 5. Animaciones Existentes a Preservar

| Animación | CSS | Duración |
|---|---|---|
| Login box entrada | `@keyframes loginIn` | 0.5s ease |
| Error shake | `@keyframes shake` | 0.4s ease |
| Modal fade + slide | `@keyframes modalFadeIn` + `modalSlideIn` | 0.25s / 0.3s |
| Card fade in | `@keyframes fadeIn` | 0.4s ease |
| Progress bar fill | `transition: width` | 0.6s cubic-bezier |
| Score card hover | `transform: translateY(-1px)` | 0.25s |
| Button glow | `box-shadow: var(--shadow-glow)` | 0.2s |

---

*Contacto: Coordinar con Dev Frontend para implementación de componentes.*
