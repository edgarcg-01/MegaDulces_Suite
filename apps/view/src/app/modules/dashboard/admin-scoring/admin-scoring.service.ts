import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../../../environments/environment';
import { Observable } from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class AdminScoringService {
  private http = inject(HttpClient);
  private apiUrl = `${environment.apiUrl}/scoring`;

  getConfig(): Observable<any> {
    return this.http.get<any>(`${this.apiUrl}/config`);
  }

  updateConfig(config: any): Observable<any> {
    return this.http.put<any>(`${this.apiUrl}/config`, config);
  }
}
