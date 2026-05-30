import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../../environments/environment';

export interface MatchedProduct {
  product_id: string;
  brand_id: string | null;
  brand_name: string | null;
  product_name: string;
  score: number;
}

export interface MatchedItem {
  raw: string;
  normalized: string;
  /** Cantidad solicitada por el usuario (extraída por Claude). Default 1. */
  quantity: number;
  suggested: (MatchedProduct & { autoConfirm: boolean }) | null;
  alternatives: MatchedProduct[];
}

export interface MatchResponse {
  items: MatchedItem[];
  meta: {
    items_count: number;
    elapsed_ms: number;
    extractor_used: 'claude' | 'heuristic' | 'mixed';
  };
}

/**
 * Fase K — wrapper HTTP del endpoint `POST /planograms/products/match-ai`.
 * El servicio backend hace: Claude Haiku 4.5 (extract) → Voyage voyage-3 (embed)
 * → pgvector HNSW (KNN). Acá solo es relay del request y deserialización.
 */
@Injectable({ providedIn: 'root' })
export class AiProductMatcherService {
  private http = inject(HttpClient);
  private apiUrl = environment.apiUrl;

  match(rawText: string): Observable<MatchResponse> {
    return this.http.post<MatchResponse>(
      `${this.apiUrl}/ai/products/match-ai`,
      { rawText },
    );
  }
}
