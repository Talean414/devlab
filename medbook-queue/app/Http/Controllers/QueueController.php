<?php

namespace App\Http\Controllers;

use App\Models\Customer;
use App\Services\QueueService;
use App\Http\Requests\StoreCustomerRequest;
use App\Http\Requests\UpdateCustomerStatusRequest;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\DB;
use Exception;

class QueueController extends Controller
{
    private QueueService $queueService;

    public function __construct(QueueService $queueService)
    {
        $this->queueService = $queueService;
    }

    /**
     * View the current ordered queue.
     */
    public function index(): JsonResponse
    {
        $queue = $this->queueService->getOrderedQueue();

        return response()->json([
            'queue' => $queue,
            'next_customer' => $queue->first() // Identifies who should be served next
        ]);
    }

    /**
     * Add a customer to the queue.
     */
    public function store(StoreCustomerRequest $request): JsonResponse
    {
        $customer = Customer::create(array_merge(
            $request->validated(),
            ['status' => 'Waiting'] // Enforce initial status
        ));

        return response()->json($customer, 201);
    }

    /**
     * Update a customer's status using permitted transitions.
     */
    public function updateStatus(UpdateCustomerStatusRequest $request, Customer $customer): JsonResponse
    {
        $newStatus = $request->validated()['status'];

        try {
            DB::transaction(function () use ($customer, $newStatus) {
                // Lock the specific customer row for update to prevent concurrent modifications
                $lockedCustomer = Customer::where('id', $customer->id)->lockForUpdate()->first();

                $this->validateTransition($lockedCustomer->status, $newStatus);

                // Rule 6: No more than one customer may be "Being Served"
                if ($newStatus === 'Being Served') {
                    // We lock the query checking for currently served customers
                    $currentlyServed = Customer::where('status', 'Being Served')->lockForUpdate()->exists();

                    if ($currentlyServed) {
                        throw new Exception('Another customer is already being served.');
                    }
                }

                $lockedCustomer->update(['status' => $newStatus]);
            });

            return response()->json(['message' => 'Status updated successfully.']);
        } catch (Exception $e) {
            // Return a clear message when validation fails or an invalid action is attempted
            return response()->json(['error' => $e->getMessage()], 422);
        }
    }

    /**
     * Rule 5: State machine logic for valid transitions.
     */
    private function validateTransition(string $currentStatus, string $newStatus): void
    {
        $validTransitions = [
            'Waiting' => ['Being Served', 'Cancelled'],
            'Being Served' => ['Completed', 'Waiting'],
            'Completed' => [],
            'Cancelled' => [],
        ];

        if (!in_array($newStatus, $validTransitions[$currentStatus])) {
            throw new Exception("Invalid transition from {$currentStatus} to {$newStatus}.");
        }
    }
}
