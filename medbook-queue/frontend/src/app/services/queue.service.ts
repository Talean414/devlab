import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { Customer, QueueResponse } from '../models/customer.model';

@Injectable({
  providedIn: 'root'
})
export class QueueService {
  private http = inject(HttpClient);
  private apiUrl = 'http://localhost:8000/api/queue'; // Adjust port if needed

  /**
   * Fetches the current ordered queue and the customer to serve next.
   */
  getQueue(): Observable<QueueResponse> {
    return this.http.get<QueueResponse>(this.apiUrl);
  }

  /**
   * Adds a new customer to the queue.
   */
  addCustomer(customer: Partial<Customer>): Observable<Customer> {
    return this.http.post<Customer>(this.apiUrl, customer);
  }

  /**
   * Updates a customer's status with transition validation.
   */
  updateStatus(customerId: number, status: string): Observable<{ message: string }> {
    return this.http.patch<{ message: string }>(`${this.apiUrl}/${customerId}/status`, { status });
  }
}
