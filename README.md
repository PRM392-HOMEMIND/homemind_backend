# 🏠 HomeMind Backend Service

> **Dịch vụ máy chủ trung tâm cho ứng dụng HomeMind (Smart Home Inventory).**  
> Xây dựng trên nền tảng **NestJS**, **Prisma ORM**, **PostgreSQL** và tích hợp cổng thanh toán **PayOS**.

---

## 🚀 Công nghệ sử dụng
- **Framework:** NestJS (Node.js LTS)
- **Database:** PostgreSQL (với 49 migration tuần tự, RLS-based session isolation)
- **ORM:** Prisma v6
- **Xác thực:** Custom In-house Auth (Argon2 password hashing, Jose JWT with Token Rotation)
- **Thanh toán:** PayOS SDK (VietQR NAPAS dynamic generation, Idempotent Webhook Reconciler)
- **Email & OTP:** Infobip Provider
- **Containerization:** Docker multi-stage build, rootless execution, Nginx reverse proxy

---

## 📂 Cấu trúc thư mục

`	ext
homemind_backend/
├── src/                    # Mã nguồn chính theo Domain-Driven Modules
│   ├── auth/               # Xác thực tài khoản, OTP, JWT rotation
│   ├── inventory/          # Quản lý kho, hạn sử dụng (Expiry tracking)
│   ├── shopping/           # Danh sách đi chợ thông minh, tự động gợi ý mua lại
│   ├── spending/           # Quản lý & thống kê chi tiêu hàng tháng
│   ├── family/             # Family workspace, chia sẻ kho, quản lý thành viên
│   ├── billing/            # Tích hợp cổng PayOS, VietQR, xử lý webhook & quota
│   ├── assistant/          # Trợ lý thông minh (Phonetic matcher, NLP parser)
│   ├── snapshot/           # Snapshot bootstrap phục vụ mobile mở app tức thì
│   ├── common/             # Interceptors, filters, pagination, throttler guards
│   ├── config/             # Thẩm định biến môi trường nghiêm ngặt (env.ts)
│   └── database/           # Prisma DatabaseService với transaction context
├── prisma/                 # Schema PostgreSQL và lịch sử 49 migrations
├── deploy/                 # Docker Compose, Nginx proxy, script phân quyền DB
├── openapi/                # Đặc tả hợp đồng API (Customer & Admin OpenAPI)
├── scripts/                # Scripts migration, seed dữ liệu demo
├── Dockerfile              # Dockerfile tối ưu multi-stage build bảo mật cao
└── package.json
`

---

## 🛠️ Hướng dẫn khởi chạy Local

### 1. Yêu cầu môi trường
- Node.js >= 20.x
- PostgreSQL >= 16.x (hoặc Docker)

### 2. Cài đặt Dependencies & Sinh Prisma Client
`ash
npm install
npx prisma generate
`

### 3. Cấu hình Biến môi trường
Sao chép .env.example thành .env và điền thông tin:
`ash
cp .env.example .env
`
*Lưu ý: AUTH_ACCESS_SECRET, AUTH_REFRESH_SECRET, AUTH_RESET_SECRET phải có ít nhất 32 ký tự ngẫu nhiên độc lập.*

### 4. Chạy Migration Database & Seed dữ liệu demo
`ash
npx prisma migrate deploy
npm run db:demo:seed
`

### 5. Khởi chạy Server
`ash
# Development mode với auto-reload:
npm run start:dev

# Production build:
npm run build
npm run start
`
Server sẽ lắng nghe tại http://127.0.0.1:3000.

---

## 🐳 Triển khai bằng Docker

Sử dụng Docker Compose trong thư mục deploy/:
`ash
docker compose -f deploy/compose.yaml up -d
`
Gồm 3 service:
1. db: PostgreSQL với cấu hình an toàn và script phân quyền role tối thiểu.
2. migrate: Container chuyên dụng tự động migrate schema trước khi app chạy.
3. pi: Container backend chạy chế độ read-only filesystem, dropped privileges.

---

## 📜 Giấy phép
Dự án được phát triển trong khuôn khổ môn học PRM393 - Đại học FPT.

<!-- Development branch baseline -->
