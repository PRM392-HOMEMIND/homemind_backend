export const DICTIONARY_VERSION = '1.1.0';

// Đây là các tool mà AI router được phép đề xuất trong pilot. Các HTTP route
// ghi thủ công là lựa chọn riêng cho UI; AI write luôn đi qua draft/confirm.
export const ACTIVE_TOOLS = [
  {
    toolId: 'inventory.list', sideEffect: 'read', confirmRequired: false,
    description: 'Liệt kê sản phẩm trong kho của household hiện tại.',
    manualHttp: 'GET /v1/workspaces/{id}/inventory',
    parameters: [
      { name: 'category', type: 'string | null', required: false, description: 'Lọc danh mục.' },
      { name: 'query', type: 'string | null', required: false, description: 'Tìm theo tên.' },
      { name: 'status', type: 'in_stock | out | null', required: false, description: 'Bỏ trống để xem cả hai trạng thái.' },
      { name: 'limit', type: 'number | null', required: false, description: 'Tối đa 50 kết quả qua AI.' },
    ],
    examples: ['Trong nhà còn gì?', 'Còn đồ gia dụng gì không?'],
  },
  {
    toolId: 'inventory.expiring', sideEffect: 'read', confirmRequired: false,
    description: 'Tìm lô còn tồn theo khoảng hạn sử dụng.',
    manualHttp: 'GET /v1/workspaces/{id}/inventory?expiryRange={range}',
    parameters: [
      { name: 'range', type: 'expired | next_7_days | next_30_days | this_week | this_month', required: true, description: 'Khoảng ngày hỗ trợ trong pilot.' },
      { name: 'includeExpired', type: 'boolean', required: false, description: 'Chỉ mở rộng mốc bắt đầu cho next_7_days/next_30_days.' },
    ],
    examples: ['Tuần này có gì sắp hết hạn?', 'Hàng nào đã hết hạn?'],
  },
  {
    toolId: 'shopping.list', sideEffect: 'read', confirmRequired: false,
    description: 'Đọc danh sách mua sắm và gợi ý từ hàng đã hết.',
    manualHttp: 'GET /v1/workspaces/{id}/shopping-items',
    parameters: [
      { name: 'status', type: 'needed | bought | skipped | null', required: false, description: 'Mặc định needed.' },
      { name: 'includeSuggestions', type: 'boolean', required: false, description: 'Có trả gợi ý từ sản phẩm out hay không.' },
    ],
    examples: ['Hôm nay cần mua gì?', 'Danh sách mua sắm còn gì?'],
  },
  {
    toolId: 'spending.month', sideEffect: 'read', confirmRequired: false,
    description: 'Tổng tiền đã chi trong một tháng (chỉ cộng các lần mua đã có giá) và các lần mua chưa có giá.',
    manualHttp: 'GET /v1/workspaces/{id}/spending',
    parameters: [
      { name: 'month', type: 'YYYY-MM | null', required: false, description: 'Tháng cần xem theo lịch Việt Nam; bỏ trống = tháng hiện tại.' },
    ],
    examples: ['Tháng này tôi tiêu hết bao nhiêu tiền?', 'Còn món nào chưa ghi giá không?', 'Tháng trước chi bao nhiêu?'],
  },
  {
    toolId: 'home.summary', sideEffect: 'read', confirmRequired: false,
    description: 'Tổng quan kho, hạn dùng và số món cần mua.',
    manualHttp: 'GET /v1/workspaces/{id}/home',
    parameters: [], examples: ['Tóm tắt kho giúp tôi.'],
  },
  {
    toolId: 'inventory.add', sideEffect: 'write', confirmRequired: true,
    description: 'Đề xuất thêm sản phẩm/lô; chỉ ghi sau khi người dùng xác nhận.',
    manualHttp: 'POST /v1/workspaces/{id}/inventory/items',
    parameters: [
      { name: 'items', type: 'Array<{productName, quantity?, unit?, category?, expiryDate?, priceVnd?, storageLocation?, productCandidateId?}>', required: false, description: 'Dùng khi người dùng nói nhiều món trong một câu; tối đa 20 món, mỗi món có HSD riêng.' },
      { name: 'productName', type: 'string', required: false, description: 'Tên hàng khi chỉ có một món và không dùng items; thiếu thì hỏi lại.' },
      { name: 'quantity', type: 'number | null', required: false, description: 'Tùy chọn, không tự điền 1; dương nếu có. Không nói thì null (vẫn lưu được).' },
      { name: 'unit', type: 'string | null', required: false, description: 'Tùy chọn. Không nói thì null (vẫn lưu được).' },
      { name: 'category', type: 'string | null', required: false, description: 'Danh mục.' },
      { name: 'expiryDate', type: 'YYYY-MM-DD | null', required: false, description: 'HSD theo lịch địa phương.' },
      { name: 'priceVnd', type: 'integer | null', required: false, description: 'TỔNG tiền đã trả cho món/lô này, đơn vị đồng (VND), 0..100000000000. Chỉ điền khi người dùng nói giá; không đoán.' },
      { name: 'storageLocation', type: 'string | null', required: false, description: 'Nơi cất, tối đa 60 ký tự (vd "Tủ lạnh"). Chỉ điền khi người dùng nói chỗ để; không đoán.' },
      { name: 'productCandidateId', type: 'uuid | null', required: false, description: 'Product cùng household đã khớp.' },
      { name: 'confidence', type: 'object', required: false, description: 'Điểm tự tin để hiển thị, không cấp quyền.' },
      { name: 'warnings', type: 'string[]', required: false, description: 'Cảnh báo để hiển thị.' },
    ],
    examples: ['Vừa mua được 3 ký thịt lợn giá 175 nghìn, một chai dầu gội, một chai sữa tắm, một chai dầu xả mỗi chai 150 nghìn hạn tháng 9 năm 2027, và 3 ký muối giá 10 nghìn một ký.', 'Vừa mua 2 hộp sữa chua 45 nghìn để trong tủ lạnh.', 'Thêm hai hộp sữa chua hạn bảy ngày.', 'Trong tủ có sữa rửa mặt hạn tháng 9 năm sau, 2 chai toner hạn 2029, 3 cây son dưỡng hạn 2028.'],
  },
  {
    toolId: 'inventory.mark_out', sideEffect: 'write', confirmRequired: true,
    description: 'Đề xuất trừ hoặc đánh hết hàng; có thể hỏi mua lại.',
    manualHttp: 'POST /v1/workspaces/{id}/inventory/{productId}/mark-out',
    parameters: [
      { name: 'productId', type: 'uuid', required: true, description: 'Phải khớp candidate cùng household để tạo draft.' },
      { name: 'productName', type: 'string | null', required: false, description: 'Tên để hiển thị.' },
      { name: 'quantity', type: 'number | null', required: false, description: 'Số lượng ĐÃ dùng/bán; null = đánh hết toàn bộ.' },
      { name: 'remainingQuantity', type: 'number | null', required: false, description: 'Số lượng CÒN LẠI người dùng nói ("chỉ còn nửa ký", "còn 2 chai"), theo đơn vị của candidate. Server tự tính phần đã dùng = tồn kho - còn lại.' },
      { name: 'addToShoppingList', type: 'boolean', required: false, description: 'Chỉ true khi người dùng muốn mua lại.' },
      { name: 'warnings', type: 'string[]', required: false, description: 'Cảnh báo để hiển thị.' },
    ],
    examples: ['Hết trứng, nhớ mua lại nhé.'],
  },
  {
    toolId: 'inventory.set_expiry', sideEffect: 'write', confirmRequired: true,
    description: 'Đặt hạn sử dụng cho một phần (hoặc toàn bộ) hàng ĐÃ có trong kho, không thêm hàng mới; chỉ ghi sau khi người dùng xác nhận.',
    manualHttp: null,
    parameters: [
      { name: 'productId', type: 'uuid', required: true, description: 'Phải khớp candidate cùng household.' },
      { name: 'productName', type: 'string | null', required: false, description: 'Tên để hiển thị.' },
      { name: 'quantity', type: 'number | null', required: false, description: 'Số lượng có hạn này (vd 2 trong 5 gói); null = toàn bộ số đang có.' },
      { name: 'expiryDate', type: 'YYYY-MM-DD', required: true, description: 'Hạn sử dụng theo lịch địa phương; phải có ngày cụ thể.' },
      { name: 'warnings', type: 'string[]', required: false, description: 'Cảnh báo để hiển thị.' },
    ],
    examples: ['Trong 5 gói mì có 2 gói hạn 20 tháng 10.', 'Cập nhật hạn sữa tươi là 5 tháng 11.'],
  },
  {
    toolId: 'shopping.add', sideEffect: 'write', confirmRequired: true,
    description: 'Đề xuất thêm một hoặc nhiều món vào danh sách mua.',
    manualHttp: 'POST /v1/workspaces/{id}/shopping-items',
    parameters: [
      { name: 'items', type: 'Array<{name, quantity?, unit?}>', required: false, description: 'Tối đa 20 món trong một draft.' },
      { name: 'name', type: 'string', required: false, description: 'Dùng cho một món khi không có items.' },
      { name: 'quantity', type: 'number | null', required: false, description: 'Không tự điền nếu chưa biết.' },
      { name: 'unit', type: 'string | null', required: false, description: 'Đơn vị nếu đã biết.' },
      { name: 'confidence', type: 'object', required: false, description: 'Điểm tự tin để hiển thị.' },
      { name: 'warnings', type: 'string[]', required: false, description: 'Cảnh báo để hiển thị.' },
    ],
    examples: ['Nhớ mua nước mắm với trứng.'],
  },
  {
    toolId: 'shopping.skip', sideEffect: 'write', confirmRequired: true,
    description: 'Đề xuất bỏ qua (không mua nữa/xóa khỏi danh sách cần mua) một hoặc nhiều món đang cần mua; chỉ ghi sau khi người dùng xác nhận.',
    manualHttp: 'PATCH /v1/workspaces/{id}/shopping-items/{itemId}',
    parameters: [
      { name: 'names', type: 'string[]', required: false, description: 'Tên các món cần mua muốn bỏ qua, đúng như người dùng nói; tối đa 20.' },
      { name: 'name', type: 'string', required: false, description: 'Dùng cho một món khi không có names.' },
    ],
    examples: ['Bỏ qua món ớt.', 'Không cần mua chanh với sả nữa.', 'Xóa hành khỏi danh sách đi chợ.'],
  },
  {
    toolId: 'clarify', sideEffect: 'none', confirmRequired: false,
    description: 'Hỏi lại khi thiếu tên hàng, candidate mơ hồ hoặc yêu cầu nhiều tool.',
    manualHttp: null,
    parameters: [{ name: 'question', type: 'string', required: false, description: 'Một câu hỏi cụ thể.' }],
    examples: ['Thêm hàng.'],
  },
  {
    toolId: 'unknown', sideEffect: 'none', confirmRequired: false,
    description: 'Yêu cầu ngoài phạm vi HomeMind.', manualHttp: null,
    parameters: [], examples: ['Thời tiết hôm nay thế nào?'],
  },
] as const;

export type ToolId = (typeof ACTIVE_TOOLS)[number]['toolId'];
export const activeDictionary = { dictionaryVersion: DICTIONARY_VERSION, tools: ACTIVE_TOOLS };
