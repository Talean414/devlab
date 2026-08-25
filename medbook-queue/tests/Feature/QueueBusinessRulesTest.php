<?php

namespace Tests\Feature;

use App\Models\Customer;
use App\Services\QueueService;
use Carbon\Carbon;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class QueueBusinessRulesTest extends TestCase
{
    use RefreshDatabase; // Resets the database after each test

    /**
     * Test 1: The Exact Scenario (Rules 1, 2, 3 & 7)
     */
    public function test_it_calculates_the_provided_scenario_correctly()
    {
        // Seed the exact scenario data
        Customer::create(['name' => 'Peter', 'service_required' => 'Consultation', 'original_arrival_time' => Carbon::parse('2026-08-26 09:45:00'), 'original_priority' => 'Normal']);
        Customer::create(['name' => 'Mary', 'service_required' => 'Consultation', 'original_arrival_time' => Carbon::parse('2026-08-26 11:01:00'), 'original_priority' => 'Emergency']);
        Customer::create(['name' => 'John', 'service_required' => 'Consultation', 'original_arrival_time' => Carbon::parse('2026-08-26 11:04:00'), 'original_priority' => 'Emergency']);
        Customer::create(['name' => 'Susan', 'service_required' => 'Consultation', 'original_arrival_time' => Carbon::parse('2026-08-26 10:25:00'), 'original_priority' => 'Priority']);
        Customer::create(['name' => 'Daniel', 'service_required' => 'Consultation', 'original_arrival_time' => Carbon::parse('2026-08-26 10:50:00'), 'original_priority' => 'Normal']);

        $service = new QueueService();
        $assessedTime = Carbon::parse('2026-08-26 11:15:00'); // Isolate the point in time

        $queue = $service->getOrderedQueue($assessedTime);

        // Assert Effective Priorities[cite: 1]
        $this->assertEquals('Emergency', $queue->where('name', 'Peter')->first()->effective_priority); // 90 mins -> Emergency
        $this->assertEquals('Emergency', $queue->where('name', 'Susan')->first()->effective_priority); // 50 mins -> Emergency
        $this->assertEquals('Emergency', $queue->where('name', 'Mary')->first()->effective_priority); // Emergency remains Emergency
        $this->assertEquals('Emergency', $queue->where('name', 'John')->first()->effective_priority); // Emergency remains Emergency
        $this->assertEquals('Normal', $queue->where('name', 'Daniel')->first()->effective_priority); // 25 mins -> Normal

        // Assert Correct Queue Order (Effective Priority -> Earliest Arrival)[cite: 1]
        $this->assertEquals('Peter', $queue[0]->name); // Arrived 09:45
        $this->assertEquals('Susan', $queue[1]->name); // Arrived 10:25
        $this->assertEquals('Mary', $queue[2]->name); // Arrived 11:01
        $this->assertEquals('John', $queue[3]->name); // Arrived 11:04
        $this->assertEquals('Daniel', $queue[4]->name); // Normal priority
    }

    /**
     * Test 2: One Customer at a Time (Rule 6)
     */
    public function test_it_rejects_serving_multiple_customers_simultaneously()
    {
        $customer1 = Customer::create(['name' => 'A', 'service_required' => 'X', 'original_arrival_time' => now(), 'original_priority' => 'Normal']);
        $customer2 = Customer::create(['name' => 'B', 'service_required' => 'Y', 'original_arrival_time' => now(), 'original_priority' => 'Normal']);

        // Serve the first customer successfully
        $this->patchJson("/api/queue/{$customer1->id}/status", ['status' => 'Being Served'])
            ->assertStatus(200);

        // Attempting to serve a second customer must fail[cite: 1]
        $this->patchJson("/api/queue/{$customer2->id}/status", ['status' => 'Being Served'])
            ->assertStatus(422)
            ->assertJson(['error' => 'Another customer is already being served.']);
    }

    /**
     * Test 3: Invalid Transitions (Rule 5)
     */
    public function test_it_prevents_invalid_status_transitions()
    {
        $customer = Customer::create([
            'name' => 'Test',
            'service_required' => 'X',
            'original_arrival_time' => now(),
            'original_priority' => 'Normal',
            'status' => 'Cancelled' // Start with Cancelled status
        ]);

        // Cancelled cannot go back to Waiting[cite: 1]
        $this->patchJson("/api/queue/{$customer->id}/status", ['status' => 'Waiting'])
            ->assertStatus(422)
            ->assertJson(['error' => 'Invalid transition from Cancelled to Waiting.']);
    }
}
