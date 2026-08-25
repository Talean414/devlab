export type OriginalPriority = 'Normal' | 'Priority' | 'Emergency';
export type CustomerStatus = 'Waiting' | 'Being Served' | 'Completed' | 'Cancelled';

export interface Customer {
  id: number;
  name: string;
  service_required: string;
  original_arrival_time: string;
  original_priority: OriginalPriority;
  status: CustomerStatus;
  effective_priority?: OriginalPriority;
  waiting_minutes?: number;
  created_at?: string;
  updated_at?: string;
}

export interface QueueResponse {
  queue: Customer[];
  next_customer: Customer | null;
  currently_serving?: Customer | null;
}
