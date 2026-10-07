# Optimización de Performance — Parte 2

## 1. Google Fonts: Preconnect + eliminar @import

### apps/view/src/index.html
Reemplazar:
```html
  <base href="/">
  <meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">

  <!-- Favicon - Logo Mega Dulces -->
```
Por:
```html
  <base href="/">
  <meta name="viewport" content="width=device-width, initial-scale=1">

  <!-- Google Fonts: preconnect + stylesheet -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">

  <!-- Favicon - Logo Mega Dulces -->
```

### apps/view/src/styles.css
Eliminar línea 1:
```css
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap');
```

### apps/trade-marketing-view/src/index.html
Mismo cambio que view.

### apps/trade-marketing-view/src/styles.css
Mismo cambio que view.

---

## 2. LCP: Separar loading signals en HomeComponent

### apps/view/src/app/modules/dashboard/home/home.component.ts

**Reemplazar signal de loading única** (línea ~53):
```typescript
  loading = signal(true);
```
Por:
```typescript
  summaryMonthlyLoading = signal(true);
  summaryDailyLoading = signal(true);
  reportsDataLoading = signal(true);
```

**Reemplazar loadDashboardData()** (líneas ~212-251):
```typescript
  loadDashboardData() {
    this.summaryMonthlyLoading.set(true);
    this.summaryDailyLoading.set(true);
    this.reportsDataLoading.set(true);

    const f = this.filtersState.filters();
    const monthlyRange = this.getMonthlyDateRange();
    const dailyRange = this.getDailyDateRange();

    forkJoin({
      summaryMonthly: this.reportsService.getSummary({
        startDate: monthlyRange.startDate,
        endDate: monthlyRange.endDate,
        zone: f.zone,
        supervisorId: f.supervisorId,
        sellerIds: f.sellerIds
      }),
      summaryDaily: this.reportsService.getDailyCompliance({
        startDate: dailyRange.startDate,
        endDate: dailyRange.endDate,
        zone: f.zone,
        supervisorId: f.supervisorId,
        sellerIds: f.sellerIds
      }),
      reportsRes: this.reportsService.getReportsData({
        startDate: monthlyRange.startDate,
        endDate: monthlyRange.endDate,
        zone: f.zone,
        supervisorId: f.supervisorId,
        sellerIds: f.sellerIds
      })
    }).subscribe({
      next: ({ summaryMonthly, summaryDaily, reportsRes }) => {
        this.summaryMonthly.set(summaryMonthly.metricas_globales);
        this.summaryMonthlyLoading.set(false);
        this.summaryDaily.set(summaryDaily.metricas_diarias);
        this.summaryDailyLoading.set(false);
        this.reportsData.set(reportsRes);
        this.reportsDataLoading.set(false);
        this.updateChart(reportsRes);
      },
      error: () => {
        this.summaryMonthlyLoading.set(false);
        this.summaryDailyLoading.set(false);
        this.reportsDataLoading.set(false);
      }
    });
  }
```

### apps/view/src/app/modules/dashboard/home/home.component.html

**Reemplazar skeleton de loading** (líneas ~23-27):
```html
<ng-container *ngIf="loading()">
  <div *ngFor="let i of [1,2,3,4]"
       class="card-premium animate-pulse min-h-[180px] flex items-center justify-center">
    <p-skeleton width="80%" height="4rem"></p-skeleton>
  </div>
</ng-container>
```
Por:
```html
<ng-container *ngIf="summaryMonthlyLoading()">
  <div *ngFor="let i of [1,2,3,4]"
       class="card-premium animate-pulse min-h-[180px] flex items-center justify-center">
    <p-skeleton width="80%" height="4rem"></p-skeleton>
  </div>
</ng-container>
```

**Reemplazar contenedor de KPI cards** (línea ~29):
```html
<ng-container *ngIf="!loading()">
```
Por:
```html
<ng-container *ngIf="!summaryMonthlyLoading()">
```

**Reemplazar skeleton del chart** (línea ~106):
```html
<p-skeleton *ngIf="loading()" height="320px" class="w-full"></p-skeleton>
```
Por:
```html
<p-skeleton *ngIf="reportsDataLoading()" height="320px" class="w-full"></p-skeleton>
```

**Reemplazar sección de actividad reciente** (si usa `loading()`):
```html
<ng-container *ngIf="!loading()">
```
Por:
```html
<ng-container *ngIf="!reportsDataLoading()">
```

### apps/trade-marketing-view/src/app/modules/dashboard/home/home.component.ts
Mismos cambios que view.

### apps/trade-marketing-view/src/app/modules/dashboard/home/home.component.html
Mismos cambios que view.

---

## 3. API Paginación — Backend

### apps/api/src/modules/reports/reports.controller.ts

Agregar query params opcionales al endpoint `getFilteredData()`:
```typescript
@Get('data')
async getFilteredData(
  @Query('startDate') startDate: string,
  @Query('endDate') endDate: string,
  @Query('zone') zone: string,
  @Query('supervisorId') supervisorId: string,
  @Query('userIds') userIds: string,
  @Query('page') page: number = 1,
  @Query('pageSize') pageSize: number = 50,
  @Query('include') include: string = 'metrics,trend,rows',
) {
  const includeList = include.split(',').map(s => s.trim());
  return this.reportsService.getFilteredData({
    startDate, endDate, zone, supervisorId,
    userIds: userIds ? userIds.split(',') : [],
    page, pageSize, include: includeList,
  });
}
```

### apps/api/src/modules/reports/reports.service.ts

Agregar interfaz de filtros extendida:
```typescript
interface FilteredDataOptions {
  startDate: string;
  endDate: string;
  zone?: string;
  supervisorId?: string;
  userIds?: string[];
  page?: number;
  pageSize?: number;
  include?: string[];
}
```

En `getFilteredData()`, agregar al inicio:
```typescript
const safePage = Math.max(1, options.page ?? 1);
const safePageSize = Math.min(200, Math.max(1, options.pageSize ?? 50));
const include = options.include ?? ['metrics', 'trend', 'rows'];

const result: any = {};
```

**Aplicar paginación a rows** (después del query, antes del map):
```typescript
if (include.includes('rows')) {
  const offset = (safePage - 1) * safePageSize;
  query = query.limit(safePageSize).offset(offset);
}
const rows = await query.orderBy('hora_inicio', 'desc');
```

**Condicionar productStats y productMap** (solo si include incluye 'products'):
```typescript
if (include.includes('products')) {
  // ... existing productStats, productMap, sellerProductStats logic
}
result.productStats = include.includes('products') ? productStats : undefined;
result.productMap = include.includes('products') ? productMap : undefined;
result.sellerProductStats = include.includes('products') ? sellerProductStats : undefined;
```

**Condicionar rows en la respuesta**:
```typescript
if (include.includes('rows')) {
  result.rows = normalizedRows;
  result.totalRows = totalCount; // Agregar COUNT(*) query
}
```

**Siempre incluir metrics y trendData**:
```typescript
result.metrics = metrics;
result.trendData = trendData;
result.exhibidoresHealth = exhibidoresHealth;
```

### apps/trade-marketing-api/src/modules/reports/ — Mismos cambios

---

## 4. ReportsService — Frontend

### apps/view/src/app/modules/dashboard/reports/reports.service.ts

Actualizar `getReportsData()` para aceptar page/pageSize/include:
```typescript
getReportsData(filters: any, page: number = 1, pageSize: number = 50, include: string = 'metrics,trend'): Observable<any> {
  const params: any = {
    startDate: filters.startDate,
    endDate: filters.endDate,
    page: page.toString(),
    pageSize: pageSize.toString(),
    include,
  };
  if (filters.zone) params.zone = filters.zone;
  if (filters.supervisorId) params.supervisorId = filters.supervisorId;
  if (filters.sellerIds?.length) params.userIds = filters.sellerIds.join(',');
  return this.http.get(`${this.apiUrl}/data`, { params });
}
```

### apps/view/src/app/modules/dashboard/home/home.component.ts

Actualizar llamada a `getReportsData` en `loadDashboardData()`:
```typescript
reportsRes: this.reportsService.getReportsData({...f, ...monthlyRange}, 1, 5, 'metrics,trend')
```
(Esto pide solo 5 rows, metrics y trend — el payload baja de 619 KB a ~10 KB)
