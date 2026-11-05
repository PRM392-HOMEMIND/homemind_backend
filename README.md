# 🏠 HomeMind Backend Service

> **Dịch vụ máy chủ trung tâm cho ứng dụng HomeMind (Smart Home Inventory).**  
> Xây dựng trên nền tảng **NestJS**, **Prisma ORM**, **PostgreSQL** và tích hợp cổng thanh toán **PayOS**.

---

## 🚀 Công nghệ sử dụng
- **Framework:** NestJS (Node.js LTS)
- **Database:** PostgreSQL (với 44 migration tuần tự, RLS-based session isolation)
- **ORM:** Prisma v6
- **Xác thực:** Custom In-house Auth (Argon2 password hashing, Jose JWT with Token Rotation)
- **Thanh toán:** PayOS SDK (VietQR NAPAS dynamic generation, Idempotent Webhook Reconciler)
- **Email & OTP:** Infobip Provider & Nodemailer
- **Containerization:** Docker multi-stage build, rootless execution, Nginx reverse proxy

---

## 📂 Cấu trúc thư mục

```text
homemind_backend/
├── src/                          # Mã nguồn chính theo kiến trúc Domain-Driven Modules
│   ├── admin/                    # Quản trị hệ thống, KPI dashboard, tra cứu giao dịch & tài khoản
│   ├── assistant/                # Trợ lý thông minh (AI NLP parser, phonetic matcher, quota control)
│   ├── auth/                     # Xác thực tài khoản, Argon2 hashing, JWT access/refresh rotation
│   ├── billing/                  # Cổng PayOS, VietQR, chữ ký HMAC webhook, chu kỳ đơn & hạn mức
│   ├── common/                   # DTOs dùng chung, decorators, exception filters, throttler guards
│   ├── config/                   # Thẩm định & nạp biến môi trường nghiêm ngặt (env.ts)
│   ├── database/                 # Prisma DatabaseService tích hợp RLS session & transaction context
│   ├── email/                    # Gửi email thông báo, mã OTP xác thực qua Infobip & Nodemailer
│   ├── family/                   # Không gian gia đình, chia sẻ kho, quản lý thành viên & lời mời
│   ├── feedback-popup/           # Khảo sát ý kiến người dùng, chiến dịch tặng 30 ngày Premium
│   ├── health/                   # Endpoint kiểm tra trạng thái dịch vụ (Liveness & Readiness probe)
│   ├── home/                     # Quản lý không gian hộ gia đình (household workspace metadata)
│   ├── inventory/                # Quản lý sản phẩm, lô hàng, theo dõi hạn sử dụng (smart expiry tracking)
│   ├── me/                       # Hồ sơ cá nhân người dùng hiện tại, đổi mật khẩu, thiết lập profile
│   ├── notifications/            # Hệ thống thông báo in-app & email, outbox worker xử lý nền
│   ├── search/                   # Tìm kiếm có phạm vi (scoped search) theo từ khóa và danh mục
│   ├── shopping/                 # Danh sách đi chợ thông minh, tự động gợi ý mua sắm
│   ├── snapshot/                 # Snapshot dữ liệu tức thì hỗ trợ ứng dụng di động khởi động nhanh
│   ├── spending/                 # Theo dõi, tổng hợp và báo cáo chi tiêu theo danh mục & thời gian
│   ├── app.module.ts             # Root Module kết nối toàn bộ các thành phần trong hệ thống
│   └── main.ts                   # Entry point khởi chạy NestJS, cấu hình Swagger OpenAPI & validation
├── prisma/                       # Thiết kế cơ sở dữ liệu PostgreSQL và quản lý migration
│   ├── migrations/               # Lịch sử 44 migrations tuần tự định nghĩa schema, triggers & SPs
│   ├── seeds/                    # Dữ liệu hạt giống cho danh mục siêu thị mẫu
│   ├── admin-grants.sql          # Phân quyền bảo mật cho role quản trị viên
│   ├── demo_data.sql             # Dữ liệu thử nghiệm khởi tạo môi trường
│   └── schema.prisma             # Định nghĩa mô hình dữ liệu (Prisma Models & Relations)
├── deploy/                       # Cấu hình triển khai hạ tầng & Docker Compose trên AWS EC2
│   ├── db/                       # Kịch bản phân quyền cơ sở dữ liệu và bảo mật RLS
│   ├── nginx/                    # Cấu hình Nginx reverse proxy, định tuyến SSL & chứng chỉ HTTPS
│   ├── server/                   # Kịch bản triển khai và vận hành server
│   ├── compose.yaml              # Docker Compose stack sản xuất (api, nginx, migrate)
│   └── production.env.example    # Mẫu biến môi trường cho môi trường sản xuất
├── openapi/                      # Đặc tả hợp đồng API tiêu chuẩn OpenAPI 3.0
│   ├── HOMEMIND_ADMIN_OPENAPI.json
│   └── HOMEMIND_CUSTOMER_OPENAPI.json
├── scripts/                      # Bộ công cụ CLI bảo trì, seed dữ liệu demo & kiểm thử
├── test/                         # Bộ kiểm thử toàn diện (Unit, Integration, E2E và Stress test)
├── Dockerfile                    # Dockerfile tối ưu multi-stage build bảo mật cao (non-root)
├── package.json                  # Khai báo thư viện phụ thuộc và scripts quản trị
├── prisma.config.ts              # Cấu hình runtime cho Prisma
└── tsconfig.json                 # Cấu hình TypeScript compiler
```

---

## 🛠️ Hướng dẫn khởi chạy Local

### 1. Yêu cầu môi trường
- Node.js >= 20.x
- PostgreSQL >= 16.x (hoặc Docker)

### 2. Cài đặt Dependencies & Sinh Prisma Client
```bash
npm install
npx prisma generate
```

### 3. Cấu hình Biến môi trường
Sao chép `.env.example` thành `.env` và điền thông tin:
```bash
cp .env.example .env
```
*Lưu ý: `AUTH_ACCESS_SECRET`, `AUTH_REFRESH_SECRET`, `AUTH_RESET_SECRET` phải có ít nhất 32 ký tự ngẫu nhiên độc lập.*

### 4. Chạy Migration Database & Seed dữ liệu demo
```bash
npx prisma migrate deploy
npm run db:demo:seed
```

### 5. Khởi chạy Server
```bash
# Development mode với auto-reload:
npm run start:dev

# Production build:
npm run build
npm run start
```
Server sẽ lắng nghe tại `http://127.0.0.1:3000`.

---

## 🐳 Triển khai Production trên AWS EC2 với Docker Compose

Stack sản phẩm được tối ưu hóa tinh gọn cho AWS EC2 kết hợp **Supabase Cloud PostgreSQL** và **Nginx Reverse Proxy**:
```bash
docker compose -f deploy/compose.yaml up -d
```
Gồm các thành phần:
1. **`api` (Backend NestJS)**: Chạy ứng dụng NestJS ở chế độ an toàn (read-only filesystem, dropped root privileges), kết nối trực tiếp cơ sở dữ liệu Supabase Cloud qua Connection Pooling.
2. **`nginx` (Reverse Proxy & SSL Gateway)**: Cổng tiếp nhận duy nhất từ Internet (cổng 80 & 443), bảo vệ backend nội bộ, định tuyến tên miền `homemind.ddns.net`.
3. **`migrate` (One-shot Tool)**: Áp dụng Prisma migration lên Supabase khi cần:
   ```bash
   docker compose -f deploy/compose.yaml run --rm migrate
   ```
---

## 📜 Giấy phép
Dự án được phát triển trong khuôn khổ môn học PRM393 - Đại học FPT.
