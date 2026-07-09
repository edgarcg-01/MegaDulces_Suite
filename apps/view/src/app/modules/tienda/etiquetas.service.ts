import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import { LabelModel } from './components/label.component';

export interface SearchHit { product_id: string; sku: string | null; name: string; barcode: string | null; }
export interface ResolveResult { labels: LabelModel[]; not_found: string[]; }

@Injectable({ providedIn: 'root' })
export class EtiquetasService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/store/labels`;

  search(q: string): Observable<SearchHit[]> {
    return this.http.get<SearchHit[]>(`${this.base}/search`, { params: { q } });
  }

  resolve(codes: string[]): Observable<ResolveResult> {
    return this.http.post<ResolveResult>(`${this.base}/resolve`, { codes });
  }
}
