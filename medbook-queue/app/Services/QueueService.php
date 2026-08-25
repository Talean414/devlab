<?php

namespace App\Services;

use App\Models\Customer;
use Carbon\Carbon;

class QueueService
{
    /**
     * Retrieves and orders the queue of waiting customers.
     */
    public function getOrderedQueue(Carbon $assessedTime = null)
    {
        // Rule 7: Testable time - accept a point in time or default to the server clock[cite: 1].
        $time = $assessedTime ?? now();

        // Rule 5: Only Waiting customers appear in the queue[cite: 1].
        $customers = Customer::where('status', 'Waiting')->get();

        $processedQueue = $customers->map(function ($customer) use ($time) {
            // Rule 4: Waiting time runs from original arrival timestamp to the assessed time[cite: 1].
            // Use diffInMinutes to calculate the total elapsed minutes without resetting[cite: 1].
            $waitingMinutes = $customer->original_arrival_time->diffInMinutes($time);

            // Append calculated fields for the frontend
            $customer->waiting_minutes = $waitingMinutes;
            $customer->effective_priority = $this->calculateEffectivePriority(
                $customer->original_priority,
                $waitingMinutes
            );

            return $customer;
        });

        return $this->sortQueue($processedQueue);
    }

    /**
     * Rule 3: Calculates effective priority based on waiting time[cite: 1].
     */
    private function calculateEffectivePriority(string $originalPriority, int $waitingMinutes): string
    {
        if ($originalPriority === 'Emergency') {
            return 'Emergency'; // Emergency always remains Emergency[cite: 1]
        }

        if ($originalPriority === 'Priority') {
            // Escalates to Emergency at 45 minutes or more[cite: 1]
            return $waitingMinutes >= 45 ? 'Emergency' : 'Priority';
        }

        // Handling Normal priority
        if ($waitingMinutes >= 90) {
            return 'Emergency'; // Escalates to Emergency at 90 minutes or more[cite: 1]
        }
        if ($waitingMinutes >= 60) {
            return 'Priority'; // Escalates to Priority at 60 minutes or more[cite: 1]
        }

        return 'Normal'; // Under 60 minutes[cite: 1]
    }

    /**
     * Rules 1 & 2: Orders the queue based on strict tie-breaking rules[cite: 1].
     */
    private function sortQueue($customers)
    {
        // Assign numerical weights to easily compare priority levels
        $priorityWeights = [
            'Emergency' => 3,
            'Priority'  => 2,
            'Normal'    => 1,
        ];

        return $customers->sort(function ($a, $b) use ($priorityWeights) {
            // 1. Sort by Effective Priority (highest weight first)[cite: 1]
            if ($priorityWeights[$a->effective_priority] !== $priorityWeights[$b->effective_priority]) {
                return $priorityWeights[$b->effective_priority] <=> $priorityWeights[$a->effective_priority];
            }

            // 2. Tie-breaker: Earliest original arrival date and time ranks first[cite: 1]
            if ($a->original_arrival_time->ne($b->original_arrival_time)) {
                return $a->original_arrival_time <=> $b->original_arrival_time;
            }

            // 3. Final tie-breaker: Record created first (database ID)[cite: 1]
            return $a->id <=> $b->id;
        })->values(); // Re-index the array keys after sorting
    }
}
