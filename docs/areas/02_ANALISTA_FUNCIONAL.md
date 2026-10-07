# 📊 Analista Funcional — Trade Marketing en Campo

> **Responsabilidad:** Traducción de reglas de negocio a historias de usuario, validación de flujos, priorización de backlog y criterios de aceptación.

---

## 1. Usuarios del Sistema

| Actor | Descripción | Acceso | Funcionalidades Clave |
|---|---|---|---|
| 👤 **Ejecutivo / Auxiliar** | Captura visitas y evidencias en campo | App móvil | Check-in GPS, fotos, exhibiciones, captura diaria |
| 👁️ **Supervisor** | Monitorea, valida y evalúa | Web + App | Validación de visitas, competencias, KPIs |
| 👑 **Dirección / Marketing** | Analiza KPIs y reportes | Web dashboard | Reportes, rankings, export, configuración |

## 2. Funcionalidades MVP (del PRD)

- [x] Login por roles (superadmin, ejecutivo, reportes)
- [ ] Catálogos: usuarios, rutas, zonas, tiendas, marcas, tipos
- [ ] Check-in/out con geolocalización
- [ ] Registro de exhibiciones (posición + tipo + foto)
- [ ] Captura de 1-6 fotos por visita
- [ ] Cálculo de score automático por exhibición
- [ ] Dashboards y reportes con filtros
- [ ] Captura diaria de PDV (material, planograma, venta)

## 3. Reglas de Negocio — Scoring de Exhibición

### 3.1 Fórmula

```
Score = peso_posición × factor_tipo_exhibición × nivel_ejecución
```

> **Regla absoluta:** Sin evidencia fotográfica → Score = 0

### 3.2 Pesos por Posición en Tienda

| Posición | Peso | Justificación |
|---|---|---|
| 🔴 Caja (punto de impulso) | **100** | Máxima visibilidad y conversión |
| 🟠 Adyacente a caja | **70** | Alta exposición al flujo de pago |
| 🟡 Vitrina principal | **60** | Visibilidad prominente al entrar |
| 🟢 Exhibidor independiente | **50** | Captación activa del shopper |
| 🔵 Refrigerador | **40** | Ubicación funcional |
| ⚪ Anaquel estándar | **25** | Ubicación orgánica de categoría |
| ⚫ Detrás del mostrador | **10** | Baja visibilidad |

### 3.3 Factor por Tipo de Exhibición

| Tipo | Factor |
|---|---|
| Exhibidor de piso | **2.0** |
| Refrigerador branded | **1.8** |
| Vitrina / aparador | **1.5** |
| Tira (strip) | **1.0** |

### 3.4 Nivel de Ejecución

| Nivel | Multiplicador | Criterio |
|---|---|---|
| **Alto** | 1.0 | Planograma perfecto, limpio, completo |
| **Medio** | 0.7 | Planograma parcial o con faltantes |
| **Bajo** | 0.4 | Desordenado, vacío o dañado |

### 3.5 Ejemplos de Cálculo

| Escenario | Cálculo | Score |
|---|---|---|
| Exhibidor de piso en caja, ejecución alta | 100 × 2.0 × 1.0 | **200 pts** |
| Tira en anaquel, ejecución media | 25 × 1.0 × 0.7 | **17.5 pts** |
| Vitrina en refrigerador, sin foto | — | **0 pts** |
| Refrigerador branded adyacente a caja, ejecución alta | 70 × 1.8 × 1.0 | **126 pts** |

> Los pesos y factores son **configurables** por el superadmin.

## 4. KPIs Operativos

### 4.1 Matriz de KPIs por Periodo

| ID | KPI | Unidad | Semanal | Quincenal | Mensual | Trimestral | Anual |
|---|---|---|---|---|---|---|---|
| `pdv_visitados` | PDVs Visitados | # | 60 | 120 | 240 | 720 | 2,880 |
| `exhibidores` | Exhibidores Instalados | # | 8 | 16 | 30 | 90 | 360 |
| `vitrinas` | Vitrinas Instaladas | # | 5 | 10 | 20 | 60 | 240 |
| `vitroleros` | Vitroleros Instalados | # | 6 | 12 | 24 | 72 | 288 |
| `paleteros` | Paleteros Instalados | # | 4 | 8 | 16 | 48 | 192 |
| `tiras` | Tiras Instaladas | # | 15 | 30 | 60 | 180 | 720 |
| `planograma` | Cumplimiento Planograma | % | 90% | 90% | 92% | 93% | 95% |
| `permanencia` | Material POP Temporal | % | 85% | 85% | 88% | 90% | 90% |
| `ventas_foco` | Ventas SKUs Foco | $ | $15K | $30K | $60K | $180K | $720K |
| `rotacion` | Rotación por Exhibidor | x | 2.5x | 5x | 10x | 30x | 120x |
| `roi` | ROI por Exhibidor | % | 15% | 15% | 18% | 20% | 22% |
| `incidencias` | Incidencias Resueltas | % | 90% | 90% | 92% | 93% | 95% |
| `evidencias` | Evidencias en Tiempo | % | 95% | 95% | 95% | 95% | 95% |

### 4.2 Umbrales de Estado

| Estado | Rango | Color |
|---|---|---|
| ✅ **CUMPLE** | ≥ 100% de meta | Verde |
| ⚠️ **EN RIESGO** | ≥ 80% y < 100% | Amarillo |
| ❌ **NO CUMPLE** | < 80% | Rojo |

### 4.3 Competencias del Ejecutivo (Score 0–5)

| ID | Competencia | Peso |
|---|---|---|
| `negociacion` | Negociación en PDV | 25% |
| `resultados` | Orientación a Resultados | 20% |
| `disciplina` | Disciplina Operativa | 15% |
| `observacion` | Observación Comercial | 15% |
| `influencia` | Influencia y Persuasión | 15% |
| `resiliencia` | Resiliencia | 10% |

**Score Ponderado** = Σ (score × peso / 100) → máximo 5.0

### 4.4 Compensación Variable (Períodos Mensual+)

| Componente | Indicador | Peso |
|---|---|---|
| Cobertura PDV | % PDV visitados | 30% |
| Planograma | % cumplimiento | 25% |
| Ventas SKU Foco | Incremento % | 25% |
| Permanencia | % material activo | 10% |
| Ejecución | Índice compuesto | 10% |

## 5. Criterios de Aceptación Globales (del PRD)

| # | Criterio | Validación |
|---|---|---|
| CA-01 | Visita válida requiere GPS **y** evidencia fotográfica | Backend valida ambos |
| CA-02 | Cada exhibición requiere tipo, posición y foto | DTO requiere 3 campos |
| CA-03 | Score automático calculado por visita | Endpoint retorna score |
| CA-04 | Captura por exhibición ≤ 30 segundos | Medido por UX |
| CA-05 | UX móvil simple, baja fricción, botones grandes | Revisión de prototipo |

## 6. Matriz de Permisos

| Permiso | 👑 Super Admin | 📋 Ejecutivo | 📊 Reportes |
|---|:---:|:---:|:---:|
| Capturar KPIs / Exhibiciones | ✅ | ✅ | ❌ |
| Configurar Metas | ✅ | ❌ | ❌ |
| Evaluar Competencias | ✅ | ❌ | ❌ |
| Compensación Variable | ✅ | ❌ | ❌ |
| Editar Info General | ✅ | ✅ | ❌ |
| Exportar Datos | ✅ | ❌ | ✅ |
| Importar Datos | ✅ | ❌ | ❌ |
| Reset de Periodos | ✅ | ❌ | ❌ |
| Ver Todos los Datos | ✅ | ❌ | ✅ |
| Check-in/out en campo | ✅ | ✅ | ❌ |
| Validar visitas | ✅ | ❌ | ❌ |
| Admin (usuarios, catálogos) | ✅ | ❌ | ❌ |

## 7. Entregables por Fase

### Fase 1 — Backend Core 🔧

| # | Entregable | Criterio de Aceptación |
|---|---|---|
| AF1.1 | User Stories de autenticación | Login, logout, cambio de contraseña (Given/When/Then) |
| AF1.2 | User Stories de captura KPI | ≥ 5 historias con criterios de aceptación |
| AF1.3 | Glosario de negocio v1 | Aprobado por stakeholder |
| AF1.4 | Priorización de backlog Fase 1 | MoSCoW ordering acordado |

### Fase 2 — Módulos de Negocio 📋

| # | Entregable | Criterio de Aceptación |
|---|---|---|
| AF2.1 | User Stories de planograma | CRUD marcas + productos + validación |
| AF2.2 | User Stories de catálogos dinámicos | Auto-sync ejecutivos y zonas |
| AF2.3 | Reglas de negocio: scoring documentadas | Fórmula + tabla aprobada |
| AF2.4 | Wireframes de flujo de scoring | Confirmación con stakeholder |

### Fase 4 — App Móvil 📋

| # | Entregable | Criterio de Aceptación |
|---|---|---|
| AF4.1 | User Stories del flujo de campo | Check-in → exhibición → foto → score |
| AF4.2 | Criterios de validación GPS | Distancia máxima al PDV, precisión |
| AF4.3 | Reglas de negocio offline | Qué se puede hacer sin conexión |

## 8. Catálogos del Sistema

| ID | Catálogo | Ejemplos | Sincronización |
|---|---|---|---|
| `ejecutivos` | Ejecutivo de Campo, etc. | Auto-sync desde usuarios activos con rol ejecutivo |
| `semanas` | Semana 01, ..., Semana 52 | Precargado (52 semanas) |
| `periodos` | Enero 1-15, ..., Diciembre 16-31 | Precargado (24 quincenas) |
| `zonas` | Zona Norte, Zona Sur, etc. | Auto-sync desde zonas de usuarios activos |
| `meses` | Enero, ..., Diciembre | Precargado (12 meses) |
| `anios` | 2025, 2026, 2027, 2028 | Precargado |

## 9. Planograma de Productos (Default)

| # | Marca | Productos | Qty |
|---|---|---|---|
| 1 | LA ROSA | Mazapán Clásico, Mazapán Gigante, Nugs, Suizo, Japonés, Gummy Pop, Paleta Jumbo, etc. | 18 |
| 2 | HERSHEY | Pelón, Kisses, Crayón, Pelonetes, etc. | 9 |
| 3 | ARCOR | Nikolo, Bon o Bon, Butter Toffe, Poosh | 4 |
| 4 | WINIS | Winis T7, Maxi Tubo, Frutaffy, Acidup, etc. | 8 |
| 5 | CANELS | Canels 4s, Goma Tueni, Cherry Sours, ICEE, etc. | 8 |
| 6 | MONTES | Damy, Ricos Besos, Chicloso Surtido | 3 |
| 7 | AP | Michamoy | 1 |
| 8 | DELICIATE | Ate Azúcar, Ate Chile, Manguito, Gummy Tiras | 4 |
| 9 | BOLSAS DE LOS ALTOS | 60x90, 50x70, 90x120 | 3 |
| 10 | LAS DELICIAS | Wafer Choco, Astridix, Crunch Caritas, etc. | 8 |
| 11 | INTERCANDY | Gelatina, Rainbow, Baileys, etc. | 5 |
| 12 | KALU | Volmond, Fruit 3D, Pelafrut, Jelly Pop | 4 |
| 13 | FRUTI FRESK | Cometinix, Freskiice, Freskysoda, Agua Calid | 4 |
| | **TOTAL** | | **~79** |

---

*Contacto: Coordinar aprobación de backlog con Dev Backend y stakeholders.*
