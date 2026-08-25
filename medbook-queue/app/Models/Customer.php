<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;

class Customer extends Model
{
    use HasFactory;

    protected $fillable = [
        'name',
        'service_required',
        'original_arrival_time',
        'original_priority',
        'status',
    ];

    protected $casts = [
        'original_arrival_time' => 'datetime',
    ];
}
