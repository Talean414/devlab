import { Component, OnInit, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormBuilder, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { QueueService } from './services/queue.service';
import { Customer, OriginalPriority } from './models/customer.model';
import { HttpErrorResponse } from '@angular/common/http';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule],
  templateUrl: './app.html',
  styleUrls: ['./app.css']
})
export class App implements OnInit {
  private queueService = inject(QueueService);
  private fb = inject(FormBuilder);
  private cdr = inject(ChangeDetectorRef);

  queue: Customer[] = [];
  nextCustomer: Customer | null = null;
  currentlyServing: Customer | null = null;
  errorMessage: string | null = null;

  customerForm: FormGroup;
  priorities: OriginalPriority[] = ['Normal', 'Priority', 'Emergency'];

  constructor() {
    this.customerForm = this.fb.group({
      name: ['', Validators.required],
      service_required: ['', Validators.required],
      original_arrival_time: ['', Validators.required],
      original_priority: ['Normal', Validators.required]
    });
  }

  ngOnInit(): void {
    this.loadQueue();
  }

  loadQueue(): void {
    this.queueService.getQueue().subscribe({
      next: (res) => {
        this.queue = Array.isArray(res?.queue) ? res.queue : [];
        this.nextCustomer = res?.next_customer || null;
        this.currentlyServing = res?.currently_serving || null;
        this.cdr.detectChanges();
      },
      error: () => {
        this.showError('Failed to load queue. Ensure backend is running.');
        this.cdr.detectChanges();
      }
    });
  }

  onSubmit(): void {
    if (this.customerForm.invalid) return;

    this.queueService.addCustomer(this.customerForm.value).subscribe({
      next: () => {
        this.customerForm.reset({ original_priority: 'Normal' });
        this.loadQueue();
      },
      error: (err: HttpErrorResponse) => {
        this.showError(err.error?.message || err.error?.error || 'Failed to add customer.');
      }
    });
  }

  serveNextCustomer(): void {
    if (this.nextCustomer?.id) {
      this.updateStatus(this.nextCustomer.id, 'Being Served');
    }
  }

  completeService(customerId: number | undefined): void {
    if (customerId) {
      this.updateStatus(customerId, 'Completed');
    }
  }

  updateStatus(customerId: number | undefined, newStatus: string): void {
    if (!customerId) return;

    this.queueService.updateStatus(customerId, newStatus).subscribe({
      next: () => {
        this.errorMessage = null;
        this.loadQueue();
      },
      error: (err: HttpErrorResponse) => {
        this.showError(err.error?.error || err.error?.message || 'Transition failed.');
      }
    });
  }

  private showError(message: string): void {
    this.errorMessage = message;
    this.cdr.detectChanges();
    setTimeout(() => {
      this.errorMessage = null;
      this.cdr.detectChanges();
    }, 5000);
  }
}
