<?php

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

class StoreCustomerRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    public function rules(): array
    {
        return [
            'name' => 'required|string|max:255',
            'service_required' => 'required|string|max:255',
            'original_arrival_time' => 'required|date',
            'original_priority' => 'required|in:Normal,Priority,Emergency',
        ];
    }
}
