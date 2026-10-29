> Historical design/reference — trước migration ngày 02/10/2026. Các đoạn Supabase mô tả kiến trúc cũ, không phải cấu hình hay lệnh chạy hiện tại. Runtime hiện dùng Nest custom auth + PostgreSQL native; xem [hướng dẫn backend](../../homemind_backend/README.md).

# Đặc tả triển khai backend HomeMind

Trạng thái: đặc tả sẵn sàng để triển khai pilot B2C. Tài liệu này định nghĩa xây dựng backend và tích hợp Flutter cần thiết. Công việc được sắp theo quan hệ phụ thuộc, không chia theo thời gian.

## 1. Mục tiêu và nguồn tham chiếu

Hoàn thiện luồng HomeMind trên Android với dữ liệu đám mây: xác thực, tải một workspace hộ gia đình, quản lý kho và danh sách mua bằng thao tác tay, hỏi dữ liệu thật bằng giọng nói/văn bản, xem và sửa bản nháp do AI tạo, xác nhận một lần, rồi thấy kết quả vẫn còn sau khi khởi động lại ứng dụng.

Đọc các tài liệu sau trước khi sửa contract:

- `docs/API_DICTIONARY.md`: tên tool đang hoạt động, tham số và tác động của từng tool.
- `docs/API_CONTRACTS.md`: cấu trúc JSON và dữ liệu trả về của API `/v1`.
- `docs/DATABASE_SCHEMA.md`: thực thể và SQL minh họa; **chưa phải migration có thể triển khai nguyên trạng**.
- `docs/SRS_HOMEMIND.md`: yêu cầu chức năng và phi chức năng.
- `docs/MVP_DATA_CONTRACTS_INDEX.md` và `docs/HomeMind_Implementation_Vision.md`: phạm vi pilot.
- `docs/M0_FLUTTER_REALTIME_VOICE_SCOPE.md` và `docs/M1_GEMINI_DIRECT_DEV_EXTRACTION.md`: trạng thái nhận dạng giọng nói hiện tại và thiết kế voice-first về sau.
- `docs/HomeMind_Startup_Documentation.md` và `docs/HomeMind_Executive_Summary.md`: bối cảnh sản phẩm; stack và danh sách tính năng rộng hơn trong các tài liệu này không thay thế phạm vi pilot bên dưới.
- `apps/homemind_mobile/lib` và `apps/homemind_mobile/assets/mocks`: model, interface và fixture hiện có của Flutter.

**Thứ tự ưu tiên khi có mâu thuẫn:** tài liệu này chốt những điểm còn khác nhau; tiếp theo dùng API Contracts và Dictionary cho hành vi công khai; SRS và schema cho quy tắc nghiệp vụ; cuối cùng dùng tài liệu startup cho định hướng sản phẩm. Khi thay đổi contract công khai, cập nhật đồng bộ tài liệu, fixture, OpenAPI và mã nguồn.

## 2. Phạm vi và quyết định đã chốt

### Trong phạm vi

- Ứng dụng Flutter, HTTP API NestJS, Supabase Auth và Supabase Postgres.
- Mỗi tài khoản mới có một workspace `household` và một membership `owner`. Mô hình dữ liệu cho phép thêm thành viên sau này, nhưng pilot không có UI/API mời thành viên.
- Các luồng thủ công: Home, tồn kho, chi tiết/sửa sản phẩm, đánh dấu hết và hỏi mua lại, danh sách mua sắm, xác thực.
- Flutter dùng `speech_to_text` native để lấy transcript tiếng Việt cuối cùng. Nhập văn bản dùng cùng đường xử lý assistant.
- Các tool đọc đang hoạt động: `inventory.list`, `inventory.expiring`, `shopping.list`, `home.summary`.
- Các tool ghi đang hoạt động: `inventory.add`, `inventory.mark_out`, `shopping.add`.
- Hai kết quả `clarify` và `unknown`.
- Bản nháp ghi, xác nhận/hủy rõ ràng, lưu nguyên tử, audit và retry không tạo bản ghi trùng.
- Cảnh báo hạn dùng trong ứng dụng dựa trên các lô tồn. Pilot chưa cần worker gửi push.

### Ngoài phạm vi cho đến khi pilot được nghiệm thu

Vision/barcode, TTS, nghe mic liên tục, hàng đợi ghi offline, mời thành viên gia đình, B2B/POS, thanh toán, áp hạn mức freemium, AI sửa/xóa sản phẩm diện rộng và command schema `2.0`. Mô hình command trong `M1_GEMINI_DIRECT_DEV_EXTRACTION.md` là thiết kế tương lai; không mở các route `/v1/voice/...` trong pilot. Thao tác chạm và nhập tay vẫn phải hoạt động khi người dùng không cấp quyền mic.

### Quyết định xử lý những điểm chưa thống nhất trong contract

1. API công khai dùng prefix `/v1`; response assistant có `schemaVersion` bằng `1.0`; cả request và response dùng `dictionaryVersion` bằng `1.1.0`. Sửa các ví dụ `1.0.0` cũ trong tài liệu và fixture.
2. Mỗi assistant turn trong pilot chỉ dùng hoặc đề xuất **một** tool nghiệp vụ. Riêng `shopping.add` được chứa nhiều phần tử trong `items` của cùng một tool. Nếu model đề xuất nhiều tool khác, trả `clarify`; không âm thầm thực hiện một phần.
3. Dùng `ProductStatus = in_stock | out` và `ExpiryLevel = ok | attention | soon | urgent | expired` trên mọi ranh giới API. Bỏ các giá trị chỉ có ở FE như `out_of_stock` và `fresh` tại ranh giới này.
4. Số lượng, đơn vị hoặc HSD chưa biết phải để `null`; AI không được tự điền `1`, một đơn vị hoặc một ngày. Thiếu tên sản phẩm thì phải hỏi lại. Màn xác nhận phải hiển thị trường chưa chắc chắn và cho sửa; không ghi sản phẩm nếu số lượng không dương hoặc chưa có đơn vị.
5. `clientDate` và timezone chỉ là ngữ cảnh để hiểu ngày tương đối, không thay thế kiểm tra phía server. Pilot chấp nhận `Asia/Ho_Chi_Minh` và `vi-VN`; kiểm tra ngày dựa trên đồng hồ server và cảnh báo HSD trong quá khứ. `expiryDate` là kiểu `date` theo lịch địa phương, không phải UTC timestamp.
6. Thao tác ghi thủ công không cần bản nháp AI, nhưng phải dùng cùng quy tắc kiểm tra nghiệp vụ và các hàm ghi DB. Ghi qua voice/AI bắt buộc có turn đang chờ và xác nhận rõ ràng.
7. Home có thể trả hạn mức gói miễn phí và số lượng sản phẩm hiện tại; pilot chưa chặn ở 30 sản phẩm. Không hiển thị paywall như đã được áp dụng nếu chưa có cơ chế hạn mức và thanh toán.

## 3. Thành phần cần bàn giao trong repo

Dùng cấu trúc đích sau và giữ toàn bộ mã trong repo chung:

```text
apps/homemind_backend/
  implementation.md
  README.md
  package.json, lockfile, tsconfig*.json, nest-cli.json
  .env.example
  src/
    main.ts
    config/
    common/              # guard xác thực/workspace, lỗi, validation
    auth/                # xác minh JWT và người dùng hiện tại
    me/
    workspaces/
    inventory/
    shopping/
    home/
    assistant/           # router, adapter model, danh mục tool, turns
    database/            # Supabase client theo user và repository có kiểu
  test/                   # kiểm thử API/tích hợp/bảo mật và fixture AI
supabase/
  config.toml
  migrations/
  seed.sql

apps/homemind_mobile/
(tạm thời giữ nguyên, triển khai backend trước ở phase này)

```

Dùng TypeScript với NestJS, bật kiểm tra kiểu chặt, validation cho DTO và sinh OpenAPI. Chọn một trình quản lý package và commit lockfile. Dùng `supabase_flutter` để quản lý Auth/session; dùng abstraction `http` hiện có của Dart hoặc một HTTP client thống nhất để gọi NestJS. Không thêm ORM chỉ để biểu diễn schema nhỏ này; quản lý SQL bằng migration có version và sinh kiểu DB khi phù hợp.

Trong `apps/homemind_backend/README.md`, ghi rõ cách chạy Supabase và NestJS local, cấu hình, structure tree chi tiết, lệnh migration/seed và địa chỉ API Flutter phải dùng khi chạy Android emulator hoặc thiết bị thật. File `.env` có thể cấu hình địa chỉ supabase trực tiếp mà không cần thêm vào gitignore vì đây là dự án private.

## 4. Kiến trúc request và phân quyền

```text
Flutter --Supabase Auth--> access token
Flutter --Authorization: Bearer <access token>--> NestJS /v1
NestJS --xác minh token + kiểm tra workspace--> domain services
NestJS --Supabase client theo user--> đọc PostgREST / ghi RPC
NestJS --Gemini credential chỉ ở server--> kế hoạch có cấu trúc
Supabase Postgres --RLS + RPC có kiểm soát--> dữ liệu
```

- Flutter không gửi Gemini key hoặc Supabase secret key. Supabase publishable key có thể nằm trong Flutter vì không phải khóa đặc quyền.
- NestJS xác minh chữ ký, issuer, audience và hạn token Supabase bằng phương pháp JWT được dự án hỗ trợ; không tin các claim chỉ được giải mã nhưng chưa xác minh. Lấy danh tính user từ `sub`. Không tạo thêm bảng mật khẩu hoặc HomeMind JWT riêng.
- Mọi route workspace và assistant turn phải kiểm tra membership qua `workspace_members`; ID trong path/body luôn là dữ liệu không đáng tin. Confirm/cancel còn phải kiểm tra `user_id` của turn trùng người gọi và workspace trùng request.
- Tạo **Supabase client theo token người dùng cho từng request** khi truy cập dữ liệu. Không dùng server secret/service-role client cho truy cập dữ liệu thông thường, vì khóa đặc quyền bỏ qua RLS.
- Bật RLS cho các bảng nghiệp vụ. Policy đọc giới hạn dòng theo workspace mà người gọi là thành viên. Thu hồi quyền truy cập trực tiếp của `anon` và quyền ghi trực tiếp vào bảng nếu ứng dụng ghi qua RPC. Chỉ cấp cho `authenticated` quyền đọc và gọi RPC tối thiểu cần thiết. Một lời gọi trực tiếp đến RPC được expose vẫn phải kiểm tra user, membership và trạng thái như khi gọi qua NestJS.
- Chỉ dùng `SECURITY DEFINER` cho hàm ghi khi cần transaction nguyên tử trong lúc quyền ghi trực tiếp bị thu hồi. Nếu dùng, đặt `search_path` an toàn, ghi rõ schema trong SQL, dùng owner có quyền tối thiểu, kiểm tra `auth.uid()`, tenant ID, product/candidate ID và chủ sở hữu turn ngay trong hàm, chỉ cấp quyền execute cho `authenticated`. Không nhận SQL hoặc tên bảng tùy ý từ JSON.
- Không đưa `service_role` hoặc kết nối Postgres đặc quyền vào ứng dụng mobile. Loại token, credential, transcript gốc và model prompt khỏi log.

## 5. Thiết kế DB và yêu cầu migration

Tạo migration cho các bảng khái niệm trong `docs/DATABASE_SCHEMA.md`:

| Bảng | Hành vi bắt buộc |
|---|---|
| `profiles` | `id = auth.users.id`, tên hiển thị và thời điểm tạo/cập nhật. |
| `workspaces`, `workspace_members` | Tenant hộ gia đình và membership duy nhất theo `(workspace_id, user_id)`. |
| `products` | Mặt hàng logic trong workspace, tên chuẩn hóa, category, đơn vị mặc định, trạng thái và dấu xóa mềm. |
| `inventory_lots` | Số lượng còn lại không âm, đơn vị và HSD tùy chọn. Một sản phẩm có thể có nhiều lô. |
| `inventory_transactions` | Nhật ký bất biến của thay đổi số lượng, nguồn, người thực hiện và turn AI nếu có. |
| `shopping_items` | Danh sách `needed`/`bought`/`skipped` độc lập với tồn kho; có thể liên kết sản phẩm và ghi nguồn tạo. |
| `assistant_turns` | Câu gốc/đã chỉnh, tool JSON đã kiểm tra, dữ liệu đọc hoặc bản nháp, chủ sở hữu, trạng thái, version, thời điểm tạo và hạn của draft. |
| `notification_preferences`, `workspace_entitlements` | Giá trị mặc định cho pilot; cấu hình cảnh báo trong app và thông tin gói miễn phí. |
| `idempotency_operations` | Một dòng cho mỗi yêu cầu ghi logic, không phải một dòng cho mỗi inventory transaction. |

Yêu cầu chi tiết cho migration:

1. Thêm foreign key, check constraint, default và index rõ ràng. Với các tham chiếu giữa bảng thuộc tenant, bảo đảm cùng workspace bằng unique/FK ghép hoặc kiểm tra tương đương trong mọi RPC ghi; item ở workspace A không bao giờ được liên kết với product/lot/turn của workspace B.
2. Lưu số lượng bằng `numeric(12,3)` và từ chối số lượng ghi âm hoặc bằng không khi không hợp lệ. Duy trì một đơn vị thống nhất khi cộng dồn tồn theo product, hoặc không cộng các đơn vị không tương thích. Chuẩn hóa tên để so khớp nhưng không tự gộp các candidate mơ hồ.
3. `inventory_lots.quantity` là số tồn hiện tại; `inventory_transactions` là nhật ký audit. Mỗi thay đổi tồn phải cập nhật lot và thêm transaction tương ứng trong cùng một DB transaction. `products.status` phải phù hợp với việc còn hay không còn lot có số lượng dương; mark-out đưa các lot liên quan về 0 và ghi delta âm.
4. Tính `expiryLevel` lúc đọc theo ngày địa phương của household. HSD `NULL` có level `ok` và không nằm trong cảnh báo HSD. `expired` là trước hôm nay; `urgent` còn 0–2 ngày; `soon` 3–7 ngày; `attention` 8–30 ngày; `ok` trên 30 ngày. Chỉ lot có số lượng dương mới tạo cảnh báo. Trước khi áp dụng ngưỡng tùy category, phải ghi rõ quy tắc trong mã/tài liệu.
5. Xây dựng truy vấn/projection tồn kho có lọc workspace đúng. Nếu expose view cho `authenticated`, dùng dạng view tuân theo quyền người gọi hoặc cơ chế tương đương có RLS; không dựa vào view mặc định có thể bỏ qua row policy.
6. Tạo cơ chế khởi tạo khi đăng ký Auth để cấp profile, household, owner membership, preferences và entitlement theo cách nguyên tử. Retry hoặc sửa dữ liệu thiếu không được tạo household trùng. Ghi rõ cách bổ sung dữ liệu cho Auth user đã tồn tại.
7. Seed hai Auth user ở hai workspace độc lập, sản phẩm có các lot/HSD khác nhau và shopping item. Không đưa tài khoản demo công khai vào production.
8. Kiểm thử RLS và grant cho mọi bảng/hàm được expose: user A không thể đọc, sửa, confirm hoặc liên kết dữ liệu workspace B; request chưa xác thực bị từ chối.

### Idempotency và ghi nguyên tử

`idempotency_operations` cần unique `(workspace_id, idempotency_key)` và lưu actor, operation, hash của payload chuẩn hóa, result JSON và thời điểm. Với mỗi yêu cầu ghi, khóa/đăng ký operation trong cùng transaction với dữ liệu nghiệp vụ. Retry cùng key và cùng payload trả lại result đã lưu; cùng key nhưng payload khác trả `IDEMPOTENCY_CONFLICT`. Áp dụng cho endpoint ghi thủ công và assistant confirm. **Không** đặt unique idempotency key trên từng dòng ledger: một hành động xác nhận có thể tạo nhiều dòng.

`confirm_assistant_turn` phải thực hiện nguyên tử: khóa turn đang chờ, kiểm tra owner/workspace/hạn và tool được phép, kiểm tra lại arguments đã sửa so với draft đã lưu, ghi nghiệp vụ, lưu result rồi đổi trạng thái sang `committed`. Confirm lần hai với cùng key trả result ban đầu; key khác trên turn đã commit không được ghi lần nữa. Cancel chỉ chuyển turn đang chờ sang `cancelled`. Turn đã hủy/hết hạn không được commit.

## 6. HTTP API công khai

Dùng JSON qua HTTPS, Bearer authentication, UUID và tên trường camelCase. Giữ cấu trúc response trong `docs/API_CONTRACTS.md`, trừ những bổ sung giải quyết khoảng trống được nêu rõ bên dưới. Xuất OpenAPI và thêm kiểm thử contract bằng fixture. Trả envelope lỗi `{ "error": { "code", "message", "details" } }` như tài liệu cùng HTTP status phù hợp; không trả nguyên lỗi DB/model cho client.

| Route | Hành vi |
|---|---|
| `GET /v1/me` | Profile hiện tại, household mặc định, tên/type/role. |
| `GET /v1/workspaces/:id/home` | Home summary và alert từ dữ liệu thật. |
| `GET /v1/workspaces/:id/inventory` | `items`, `total`; lọc theo `q`, category, status, expiryRange; giới hạn số dòng và thứ tự ổn định. |
| `GET /v1/workspaces/:id/inventory/:productId` | Product và các lot cho màn chi tiết/sửa. Định nghĩa JSON trong OpenAPI và cập nhật `API_CONTRACTS.md`. |
| `POST /v1/workspaces/:id/inventory/items` | Thêm product/lot thủ công, ledger và idempotency. |
| `PATCH /v1/workspaces/:id/inventory/:productId` | Sửa metadata được phép; không âm thầm ghi đè số lượng lot. |
| `POST /v1/workspaces/:id/inventory/:productId/mark-out` | Trừ một phần hoặc đánh hết; chỉ thêm shopping item khi `addToShoppingList: true`. |
| `GET /v1/workspaces/:id/shopping-items` | `items`, `total`, có thể kèm gợi ý suy ra từ DB. |
| `POST /v1/workspaces/:id/shopping-items` | Tạo shopping item thủ công. |
| `PATCH /v1/workspaces/:id/shopping-items/:itemId` | Sửa trường được phép hoặc đặt `bought`/`skipped`. |
| `POST /v1/assistant/turn` | Kết quả đọc, bản nháp ghi, yêu cầu làm rõ hoặc unknown. |
| `POST /v1/assistant/turns/:turnId/confirm` | Ghi sau xác nhận theo transaction; yêu cầu `idempotencyKey` UUID. |
| `POST /v1/assistant/turns/:turnId/cancel` | Hủy draft đang chờ của chính người gọi. |

Các route ghi thủ công yêu cầu header `Idempotency-Key` dạng UUID; client giữ nguyên key khi retry. Với `confirm`, dùng `idempotencyKey` trong body theo contract hiện có. Giới hạn độ dài input và kích thước trang. Trả `401` khi token thiếu/sai, `403` khi không phải member, `404` khi tài nguyên không tồn tại trong phạm vi được phép, `409` khi draft cũ hoặc idempotency conflict, `422` khi vi phạm quy tắc nghiệp vụ, `429` khi quá rate limit và `503`/`504` khi model không sẵn sàng/timeout, tùy trường hợp.

### Request và kết quả assistant

`POST /v1/assistant/turn` nhận `workspaceId`, `locale`, `clientDate`, `timezone`, `dictionaryVersion` và `{ input: { type: "text" | "voice_transcript", text } }`. Chỉ gửi transcript cuối cùng; các sự kiện STT partial chỉ hiển thị trong Flutter. Giới hạn độ dài transcript và từ chối input rỗng. Không dùng `workspaceId` do client gửi để suy ra danh tính hoặc quyền.

- **Read:** kiểm tra tool và arguments, truy vấn DB qua cùng domain service mà API thủ công dùng, sau đó trả `kind: read_result`, `toolsUsed`, `data` và message được tạo chặt từ dữ liệu trả về. Không bịa tồn kho, HSD hoặc shopping item.
- **Write:** kiểm tra tool/arguments, tìm product candidate trong cùng workspace, tạo draft `assistant_turns` đang chờ, trả `kind: write_draft`, `toolsProposed`, warnings và `requiresConfirmation: true`. Chưa sửa dòng nghiệp vụ ở bước này.
- **Clarify/unknown:** không ghi nghiệp vụ và không có tool có thể confirm. Nếu product mơ hồ hoặc thiếu trường bắt buộc, hỏi một câu cụ thể. Pilot có thể bắt đầu turn mới từ câu trả lời; chưa cần duy trì hội thoại nhiều lượt.
- **Confirm:** chỉ nhận tool ID đã lưu và các trường arguments cho phép sửa; kiểm tra lại toàn bộ trường đã sửa. Không xem tool name, product ID hoặc confidence do client gửi là bằng chứng về quyền. Candidate product vẫn phải thuộc workspace. Trả cấu trúc `write_committed` hiện có với các ID đã tạo và message.
- **Cancel:** trả cấu trúc `cancelled` đã định nghĩa; không ghi nghiệp vụ.

Response phải dùng `schemaVersion` và `dictionaryVersion` cố định như đã chốt. Model không được sinh HTTP path, SQL, tool name tùy ý, quyết định phân quyền, chính sách rủi ro hoặc sự thật cuối cùng về DB.

## 7. Triển khai AI router

Đặt Gemini credential trong môi trường/secret manager của NestJS. Định nghĩa interface `AiPlanner` và một adapter Gemini để có thể đổi model/provider mà không sửa domain service. Yêu cầu đầu ra JSON có cấu trúc và schema chặt; không phân tích văn xuôi tùy ý thành command. Prompt và danh mục tool chỉ chứa các tool Dictionary đang hoạt động cùng quy tắc trường ngắn gọn. Sau khi nhận response, kiểm tra lại bằng runtime schema. Tool không hợp lệ, action không được hỗ trợ, số lượng ngoài giới hạn, ngày sai dạng hoặc candidate sai phải thành `clarify` hoặc lỗi có kiểm soát; không thực thi theo phỏng đoán.

Tạo context từ workspace đã xác thực, ngày/timezone của server, schema các tool cho phép và tối đa các product candidate liên quan. Không gửi toàn bộ inventory nếu không cần. Rate-limit assistant theo user/workspace; ghi outcome, tên model, độ trễ, ước tính token/chi phí nếu có và mã lỗi nhưng mặc định không log transcript gốc. Khi timeout, cho người dùng thử lại một cách rõ ràng; không âm thầm thay bằng kho mock hoặc báo thành công.

Kiểm thử tối thiểu tám câu demo trong `docs/API_CONTRACTS.md`, cùng trường hợp mơ hồ, thiếu dữ liệu, HSD quá khứ, prompt injection, candidate khác workspace, schema model sai và confirm trùng. Đo p50/p95 riêng cho STT, model và DB; mục tiêu xuất hiện draft trong ≤4 giây là mục tiêu cần đo, không phải lý do bỏ qua validation.

## 8. Tích hợp Flutter

Giữ abstraction nhận dạng giọng nói và interface `AssistantService` hiện tại khi bổ sung adapter production. Chọn mock hoặc backend thật bằng cấu hình build tường minh; khi API production lỗi, không âm thầm chuyển sang dữ liệu giả. Dùng Supabase Auth để refresh session, đính access token hiện tại vào lời gọi NestJS và khôi phục trạng thái đăng nhập sau khi mở lại app. `MockAuthService` và `FakeAssistantService` chỉ phục vụ test/demo.

Thay các thay đổi giả chỉ nằm trên màn hình bằng lời gọi server. Cụ thể: mark-out và mua lại phải lưu xong mới báo thành công; thao tác thêm từ gợi ý shopping phải tạo item; Home, inventory và shopping tải lại sau mutation thành công. Màn Confirm phải hiển thị input gốc/đã chỉnh, cho sửa product/quantity/unit/expiry và hiển thị warnings. Mỗi hành động người dùng tạo một UUID idempotency và giữ UUID đó qua các lần retry/double tap. Khóa thao tác gửi trùng khi đang chờ, nhưng server vẫn là lớp chống trùng cuối cùng.

Cập nhật Dart parser/fixture theo enum và version chuẩn. Xử lý rõ `read_result`, `write_draft`, `clarify`, `unknown`, `write_committed`, `cancelled` và lỗi API. Giữ transcript để người dùng thử lại khi mạng/model lỗi. Hiển thị trạng thái offline; không báo thao tác ghi offline đã thành công. Chỉ lưu dữ liệu session phù hợp bằng cơ chế lưu trữ an toàn của Auth SDK; không đưa Gemini credential gốc vào asset hoặc build production bằng `--dart-define`.

File `apps/homemind_mobile/.env` hiện được Git theo dõi, được đóng gói làm asset và có mục Gemini không rỗng. Trước khi tạo bản production: xác định đó có phải credential thật; nếu có thì thu hồi/đổi khóa; loại credential khỏi asset Flutter và file được theo dõi, ngừng gọi Gemini trực tiếp từ bản production, đồng thời chặn commit secret local về sau. Không in giá trị secret ra issue, test hoặc log.

## 9. Điều kiện kiểm chứng và bảo mật

Chỉ coi triển khai hoàn tất khi các điều kiện sau đạt:

1. Có thể tạo Supabase DB local sạch từ migration và seed đã commit, không cần chạy SQL thủ công trên dashboard. Migration chạy lại được từ môi trường rỗng; thay đổi ở staging/production dùng file migration đã review.
2. NestJS chạy với các biến môi trường đã ghi trong README, từ chối cấu hình/secret bắt buộc bị thiếu, xuất OpenAPI và kiểm tra toàn bộ DTO công khai. Flutter không có service-role secret.
3. Test Auth bao gồm JWT sai/hết hạn, thiếu membership, workspace trong path/body không khớp và người gọi cố confirm turn của user khác.
4. Test RLS/grant bao gồm mọi bảng tenant và RPC được expose với hai workspace cùng request chưa đăng nhập. Gọi API trực tiếp không thể vượt quyền tenant hoặc quy tắc ghi.
5. Test transaction chứng minh add, mark-out và mua lại cập nhật lot, trạng thái product, ledger và shopping một cách nguyên tử; lỗi làm rollback toàn bộ. `shopping.add` nhiều item thành công hoặc rollback như một hành động.
6. Test idempotency chứng minh cùng key/cùng payload trả cùng result; cùng key/khác payload bị từ chối; hai confirm đồng thời chỉ ghi một lần; một operation vẫn có thể tạo nhiều dòng ledger.
7. Test contract so JSON thật với fixture chuẩn cho mọi `kind` và domain read. Enum, version, xử lý `null` và envelope lỗi khớp nhau.
8. Test AI chứng minh câu trả lời read dựa trên dòng DB, tool/SQL/prompt injection không được ghi dữ liệu, trường thiếu không bị đoán và response sai schema/timeout không báo thành công.
9. Flutter static analysis và test liên quan đều pass; trên thiết bị Android thật hoàn thành: đăng nhập → nói thêm hàng → sửa/xác nhận → mở lại app → thấy tồn kho vẫn còn → hỏi HSD → đánh hết → thêm vào shopping. Khi từ chối quyền mic vẫn dùng được thao tác tay.
10. Log và analytics mặc định không chứa audio/transcript gốc. Ghi rõ thời gian lưu/xóa transcript và thông báo quyền riêng tư trước khi mời người dùng pilot bên ngoài.

## 10. Thứ tự thực hiện cho AI agent

Làm theo quan hệ phụ thuộc, không theo lịch:

1. Đọc các tài liệu và interface FE đã dẫn; ghi nhận các chỉnh sửa contract nhỏ vào `API_CONTRACTS.md`, Dictionary, mocks và tài liệu này nếu quá trình triển khai phát hiện bất nhất thực sự.
2. Tạo khung NestJS, validation cấu hình, định dạng lỗi, Auth guard, workspace guard và OpenAPI.
3. Tạo migration Supabase, RLS/grant, khởi tạo khi đăng ký, seed, client theo user và test phân quyền.
4. Triển khai domain read và write thủ công qua domain service dùng lại được và RPC nguyên tử. Thêm test transaction/idempotency.
5. Triển khai AI planner, allowlist, thực hiện read, tạo write draft, confirm/cancel và bộ fixture kiểm thử hồi quy.
6. Kết nối Auth và API adapter ở Flutter; thay mutation chỉ có trong mock và sửa enum trên wire. Giữ mock sau lựa chọn test/demo tường minh. (hiện tại bỏ qua bước này, việc tinh chỉnh/thay đổi logic trong folder homemind_mobile ở thời điểm hiện tại là NGHIÊM CẤM)
7. Chạy toàn bộ điều kiện mục 9, sửa lỗi, rồi cập nhật backend README với lệnh setup, ví dụ API và giới hạn còn lại.

## Các cơ sở để thiết lập .env, kết nối đến supabase (prisma ORM): 

```
# Connect to Postgres via the shared transaction-mode pooler (IPv4-only)
DATABASE_URL="postgresql://USER:CHANGE_ME@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres?pgbouncer=true"

# Connect to Postgres via the shared session-mode pooler (used for migrations)
DIRECT_URL="postgresql://USER:CHANGE_ME@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres"
```
## Các cơ sở để thiết lập prisma/schema.prisma, kết nối đến supabase (prisma ORM): 

```
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider  = "postgresql"
  url       = env("DATABASE_URL")
  directUrl = env("DIRECT_URL")
}
```