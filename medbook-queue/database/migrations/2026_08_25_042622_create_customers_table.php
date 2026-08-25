<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Run the migrations.
     */
    public function up(): void
    {
        Schema::create('customers', function (Blueprint $table) {
            $table->id(); // Reliable tie-breaker for creation order
            $table->string('name'); // [cite: 14]
            $table->string('service_required'); // [cite: 15]
            $table->timestamp('original_arrival_time'); // [cite: 16]

            // Using enums strictly enforces the allowed values at the database level
            $table->enum('original_priority', ['Normal', 'Priority', 'Emergency']); // [cite: 17]
            $table->enum('status', ['Waiting', 'Being Served', 'Completed', 'Cancelled']) // [cite: 18]
                ->default('Waiting');

            $table->timestamps();
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::dropIfExists('customers');
    }
};
