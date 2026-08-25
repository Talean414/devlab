# Medbook Queue Management System

A full-stack queue management application designed to organize, prioritize, and track customer service workflows in real time. Built with a Laravel REST API backend and an Angular standalone frontend.

---

## Prerequisites

Ensure the following tools are installed on your machine before setup:

- **PHP:** `>= 8.2`
- **Composer:** `>= 2.0`
- **Node.js:** `>= 18.0.0`
- **NPM:** `>= 9.0.0`
- **Database:** MySQL `>= 8.0`, PostgreSQL, or SQLite

---

## System Architecture

```text
medbook-queue/
├── backend/      # Laravel 11 / PHP REST API
└── frontend/     # Angular 18 Standalone Single Page Application
```

---

# 1. Backend Setup (Laravel API)

## 1.1 Navigate to the Backend Directory

```bash
cd backend
```

## 1.2 Install PHP Dependencies

```bash
composer install
```

## 1.3 Configure Environment Variables

Copy the example environment file:

```bash
cp .env.example .env
```

## 1.4 Configure the Database

Update the database credentials in `.env`:

```env
DB_CONNECTION=mysql
DB_HOST=127.0.0.1
DB_PORT=3306
DB_DATABASE=medbook_queue
DB_USERNAME=root
DB_PASSWORD=
```

### SQLite

If using SQLite instead, set:

```env
DB_CONNECTION=sqlite
```

Then create an empty database file:

```bash
touch database/database.sqlite
```

## 1.5 Generate the Application Key

```bash
php artisan key:generate
```

## 1.6 Run Database Migrations

```bash
php artisan migrate
```

## 1.7 Verify CORS Configuration

Check:

```text
config/cors.php
```

Ensure `allowed_origins` includes:

```text
http://localhost:4200
```

Also ensure `allowed_methods` allows all methods:

```php
'allowed_methods' => ['*'],
```

## 1.8 Start the Laravel Backend

```bash
php artisan serve --port=8000
```

The API will be available at:

```text
http://localhost:8000
```

---

# 2. Frontend Setup (Angular UI)

## 2.1 Navigate to the Frontend Directory

```bash
cd frontend
```

## 2.2 Install Node Dependencies

```bash
npm install
```

## 2.3 Start the Angular Development Server

```bash
npm start
```

Or:

```bash
npx ng serve --port 4200
```

## 2.4 Access the Web Application

Open your browser and navigate to:

```text
http://localhost:4200
```

---

# Core Business & Queue Logic

## Customer Lifecycle & States

Customers progress through four explicit lifecycle states:

1. **Waiting** — Customer has been added to the queue and is waiting for service.
2. **Being Served** — Active consultation is in progress. Only one active customer is allowed at a time.
3. **Completed** — Service has finished and the counter is freed for the next customer.
4. **Cancelled** — Customer has left or has been removed from the queue.

---

## Priority Escalation & Waiting Time

### Priority Levels

```text
Normal < Priority < Emergency
```

### Queue Ordering

The queue is ordered by:

1. `effective_priority` — Emergency → Priority → Normal
2. `original_arrival_time` — Ascending

In other words, higher-priority customers are served first, while customers with the same priority are served according to arrival time.

### Waiting Time Calculation

```text
Waiting Minutes = (Current Time - Original Arrival Time) / 60
```

---

# API Reference

## 1. Get Queue

### Endpoint

```http
GET /api/queue
```

### Example Response

```json
{
    "currently_serving": {
        "id": 1,
        "name": "Jane Doe",
        "service_required": "Consultation",
        "status": "Being Served",
        "effective_priority": "Priority"
    },
    "next_customer": {
        "id": 2,
        "name": "John Smith",
        "service_required": "Pharmacy",
        "status": "Waiting",
        "effective_priority": "Normal"
    },
    "queue": []
}
```

---

## 2. Add Customer

### Endpoint

```http
POST /api/queue
```

### Request Body

```json
{
    "name": "Alice Johnson",
    "service_required": "Triage",
    "original_arrival_time": "2026-08-25T10:00",
    "original_priority": "Normal"
}
```

---

## 3. Update Customer Status

### Endpoint

```http
PATCH /api/queue/{id}/status
```

### Request Body

```json
{
    "status": "Being Served"
}
```

---

# Troubleshooting

## 422 Unprocessable Content: "Another customer is already being served"

### Cause

A customer is currently locked in the `Being Served` status.

The system only allows one active customer to be served at a time.

### Resolution

Complete the active customer's service from the UI by clicking:

**Complete Service**

Alternatively, reset stranded test records using Laravel Tinker:

```bash
php artisan tinker
```

Then run:

```php
App\Models\Customer::where('status', 'Being Served')
    ->update(['status' => 'Completed']);
```

---

## UI Not Displaying API Updates

If the Angular UI is not reflecting changes from the Laravel API:

1. Ensure the Laravel backend is running:

```text
http://localhost:8000
```

2. Ensure the Angular frontend is running:

```text
http://localhost:4200
```

3. Verify the Angular API URL configuration.

4. Verify the Laravel CORS configuration.

5. Ensure Angular's `ChangeDetectorRef.detectChanges()` is triggered when necessary after HTTP responses in standalone Angular mode.

---

# Development URLs

| Service          | URL                     |
| ---------------- | ----------------------- |
| Angular Frontend | `http://localhost:4200` |
| Laravel API      | `http://localhost:8000` |

---

# Quick Start

Run the backend:

```bash
cd backend
composer install
cp .env.example .env
php artisan key:generate
php artisan migrate
php artisan serve --port=8000
```

In another terminal, run the frontend:

```bash
cd frontend
npm install
npm start
```

Then open:

```text
http://localhost:4200
```
