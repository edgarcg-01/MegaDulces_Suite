import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../../environments/environment';

@Injectable({
  providedIn: 'root'
})
export class AdminPlanogramaService {
  private http = inject(HttpClient);
  private apiUrl = `${environment.apiUrl}/planograms/brands`;
  private productsUrl = `${environment.apiUrl}/planograms/products`;

  getBrands(): Observable<any[]> {
    return this.http.get<any[]>(this.apiUrl);
  }

  createBrand(data: { nombre: string; activo?: boolean; orden?: number }): Observable<any> {
    return this.http.post<any>(this.apiUrl, data);
  }

  updateBrand(brandId: string, data: { nombre?: string; activo?: boolean; orden?: number }): Observable<any> {
    return this.http.put<any>(`${this.apiUrl}/${brandId}`, data);
  }

  deleteBrand(brandId: string): Observable<any> {
    return this.http.delete<any>(`${this.apiUrl}/${brandId}`);
  }

  addProduct(brandId: string, data: { nombre: string; activo?: boolean; orden?: number }): Observable<any> {
    return this.http.post<any>(`${this.apiUrl}/${brandId}/products`, data);
  }

  updateProduct(productId: string, data: { nombre?: string; activo?: boolean; orden?: number }): Observable<any> {
    return this.http.put<any>(`${this.productsUrl}/${productId}`, data);
  }

  deleteProduct(productId: string): Observable<any> {
    return this.http.delete<any>(`${this.productsUrl}/${productId}`);
  }
}
