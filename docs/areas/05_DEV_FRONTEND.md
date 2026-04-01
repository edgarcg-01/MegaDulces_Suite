# 🖥️ Dev Frontend — Trade Marketing en Campo

> **Responsabilidad:** Implementación del dashboard web (SPA), integración con API REST, componentes, state management y páginas.

---

## 1. Stack Tecnológico

| Tecnología | Versión | Uso |
|---|---|---|
| Angular | 18+ | Framework SPA |
| TypeScript | ^5.7 | Type safety |
| Angular CLI | latest | Build + Dev server |
| RxJS | latest | Server state, reactive programming |
| NgRx / Signals | latest | Client state (auth, UI preferences) |
| Angular Router | latest | Routing + protected routes |
| HttpClient (Angular) | latest | HTTP client con interceptors |

## 2. Proyecto Base

```bash
ng new trade-marketing-web --routing --style css
cd trade-marketing-web
npm install @ngrx/store
```

## 3. Estructura de Directorios

```
src/
├── app/
│   ├── core/
│   │   ├── http/                 # Interceptors y HttpClient
│   │   ├── guards/               # Auth Guards
│   │   └── services/             # auth.service.ts, api services
│   ├── modules/
│   │   ├── auth/                 # Login component
│   │   ├── dashboard/            # Dashboard components
│   │   ├── daily-capture/        # Captura diaria
│   │   ├── reports/              # Reportes
│   │   └── admin/                # Admin pages
│   ├── shared/
│   │   ├── components/           # UI Components (Button, Card, Badge)
│   │   ├── pipes/                # Formatters (currency, date)
│   │   ├── models/               # Types e Interfaces
│   │   └── utils/                # Funciones puras (scoring)
│   ├── store/                    # NgRx / State management
│   ├── app.routes.ts             # Rutas
│   └── app.component.ts          # Componente raíz
├── assets/
├── styles/
│   ├── styles.css                # Variables globales (Design system)
│   └── theme.css
```

## 4. Páginas y Rutas

### 4.1 Mapa de Rutas

| Ruta | Componente | Guard | Roles |
|---|---|---|---|
| `/login` | `LoginPage` | Público | — |
| `/` | `DashboardPage` | Autenticado | Todos |
| `/daily` | `DailyCapturePage` | Autenticado | Todos |
| `/reports` | `ReportsPage` | Autenticado | Todos |
| `/admin/users` | `AdminUsersPage` | Autenticado | superadmin |
| `/admin/catalogs` | `AdminCatalogsPage` | Autenticado | superadmin |
| `/admin/planograma` | `AdminPlanogramaPage` | Autenticado | superadmin |
| `/admin/permissions` | `AdminPermissionsPage` | Autenticado | superadmin |
| `/admin/config` | `AdminConfigPage` | Autenticado | superadmin |
| `/admin/audit` | `AdminAuditPage` | Autenticado | superadmin |
| `*` | `NotFoundPage` | — | — |

### 4.2 Descripción de Páginas

| Página | Contenido Principal | Datos del API |
|---|---|---|
| **LoginPage** | Form usuario/contraseña, roles de prueba | `POST /auth/login` |
| **DashboardPage** | Score cards KPIs, tabla KPIs con progreso, competencias (radar + gauge), compensación variable, selectores de periodo | `GET /captures`, `GET /catalogs/*` |
| **DailyCapturePage** | Tabla de planograma por visita (checkboxes), material de exhibición, rango de compra, venta adicional, info de ruta | `POST /daily-captures`, `GET /planograma/brands` |
| **ReportsPage** | Filtros (zona, ejecutivo, periodo, fecha), tabla de capturas, detalle modal, export PDF/CSV | `GET /captures`, `GET /reports/*` |
| **AdminUsersPage** | Stats, form crear usuario, tabla de usuarios con acciones | `GET/POST/PUT/DELETE /users` |
| **AdminCatalogsPage** | 6 catálogos con add/remove, auto-sync badges | `GET/POST/DELETE /catalogs/*` |
| **AdminPlanogramaPage** | Marcas expandibles con productos | `GET/POST/DELETE /planograma/*` |

## 5. Auth Flow

### 5.1 HttpInterceptor (Angular)

```typescript
// core/http/auth.interceptor.ts
@Injectable()
export class AuthInterceptor implements HttpInterceptor {
  constructor(private authService: AuthService, private router: Router) {}

  intercept(req: HttpRequest<any>, next: HttpHandler): Observable<HttpEvent<any>> {
    const token = this.authService.token();
    if (token) {
      req = req.clone({
        setHeaders: { Authorization: `Bearer ${token}` }
      });
    }

    return next.handle(req).pipe(
      catchError((error) => {
        if (error.status === 401) {
          this.authService.logout();
          this.router.navigate(['/login']);
        }
        return throwError(() => error);
      })
    );
  }
}
```

### 5.2 Auth Service (Angular)

```typescript
// core/services/auth.service.ts
@Injectable({ providedIn: 'root' })
export class AuthService {
  token = signal<string | null>(null);
  user = signal<JwtPayload | null>(null);

  get isAuthenticated() {
    return !!this.token();
  }

  login(token: string, user: JwtPayload) {
    this.token.set(token);
    this.user.set(user);
  }

  logout() {
    this.token.set(null);
    this.user.set(null);
  }
}
```

> ⚠️ **REGLA:** Zero accesos a `localStorage` para datos de negocio. Solo para theme/preferencias UI. Todos los datos vienen de la API.

## 6. Design System Tokens (del Dashboard existente)

### Variables CSS a implementar

```css
:root {
  --bg-primary: #06090f;
  --bg-secondary: #0c1220;
  --bg-card: #111a2e;
  --bg-card-hover: #162040;
  --bg-input: #0a1025;
  --border: #1a2744;
  --accent: #2563eb;
  --accent-light: #3b82f6;
  --success: #059669;
  --success-light: #10b981;
  --warning: #d97706;
  --warning-light: #f59e0b;
  --danger: #dc2626;
  --danger-light: #ef4444;
  --text: #e8edf5;
  --text-muted: #8b9cc0;
  --text-dim: #4a5e87;
  --mono: 'IBM Plex Mono', monospace;
  --sans: 'DM Sans', sans-serif;
  --radius: 10px;
  --radius-sm: 6px;
}
```

## 7. Datos Estáticos (KPI Config)

Estos datos se migran del HTML a constantes TypeScript:

```typescript
// utils/kpi-config.ts
export const KPI_CONFIG = [
  { id: 'pdv_visitados', name: 'PDVs Visitados', unit: '', icon: '📍', ... },
  { id: 'exhibidores', name: 'Exhibidores Instalados', unit: '', icon: '🏪', ... },
  // ... 13 KPIs total
];

export const COMPETENCIAS = [
  { id: 'negociacion', name: 'Negociación en PDV', peso: 25 },
  // ... 6 competencias total
];

export const PERIODOS = ['Semanal', 'Quincenal', 'Mensual', 'Trimestral', 'Anual'];
```

## 8. Entregables por Fase

### Fase 3 — Frontend Web 📋

| # | Entregable | Criterio de Aceptación |
|---|---|---|
| FE3.1 | Proyecto Angular CLI + Angular 18 | Build < 5 seg |
| FE3.2 | Login page con JWT | Token en memoria (no localStorage) |
| FE3.3 | Dashboard KPIs | 5 periodos, score cards, tablas, gráficas |
| FE3.4 | Captura Diaria | Tabla dinámica por visita |
| FE3.5 | Reportes con filtros | Zona, ejecutivo, periodo, export |
| FE3.6 | Admin complete | Usuarios, Catálogos, Planograma, Permisos |
| FE3.7 | State management | RxJS + NgRx / Signals |
| FE3.8 | Auth interceptor | Refresh/redirect a login |
| FE3.9 | 0 localStorage para negocio | Solo theme/UI prefs |

### Fase 4 — Mobile (Ionic + Angular) 📋

| # | Entregable | Criterio de Aceptación |
|---|---|---|
| MOB4.1 | Proyecto Ionic + Angular + Capacitor | Build iOS + Android |
| MOB4.2 | Login + secure storage | Secure Storage encriptado |
| MOB4.3 | Check-in GPS | Geolocalización real |
| MOB4.4 | Exhibición: posición + tipo + foto | ≤ 30 seg |
| MOB4.5 | Captura de 1-6 fotos | Compresión + upload |
| MOB4.6 | Cola offline + auto-sync | Persistencia local |
| MOB4.7 | Push notifications | Alertas KPI |

## 9. Performance Targets

| Métrica | Objetivo |
|---|---|
| Lighthouse Performance | ≥ 85 |
| First Contentful Paint | < 1.5s |
| Largest Contentful Paint | < 2.5s |
| Bundle Size (gzipped) | < 200KB |
| Time to Interactive | < 3s |

---

*Contacto: Coordinar con Dev UI/UX para design system y con Dev Backend para contratos API.*
