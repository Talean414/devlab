<?php

use Illuminate\Support\Facades\Route;
use App\Http\Controllers\QueueController;

// Group our endpoints with an API prefix implicitly handled by Laravel
Route::prefix('queue')->group(function () {
    Route::get('/', [QueueController::class, 'index']); // View ordered queue
    Route::post('/', [QueueController::class, 'store']); // Add a customer
    Route::patch('/{customer}/status', [QueueController::class, 'updateStatus']); // Update status
});
