# 📊 Đánh giá Hiệu năng Mô hình AI Docker (Qwen 2.5 7B)

> **Tài liệu kiểm thử và đo lường hiệu năng của mô hình Self-Hosted AI phục vụ tính năng Trợ lý thông minh HomeMind.**

---

## 1. Môi trường Thực thi (Environment Specs)

| Thông số | Chi tiết cấu hình |
| :--- | :--- |
| **Nền tảng host** | Docker Cloud Agentic Sandbox |
| **Container Engine** | Docker v28 (Ubuntu Linux amd64) |
| **AI Runtime** | `ollama/ollama:latest` |
| **Model** | `qwen2.5:7b-instruct-q4_K_M` (4.5 GB GGUF) |
| **Chế độ phần cứng** | CPU-only (Đa nhân) |
| **Endpoint chuẩn** | `https://11434-001m6k0e8ar6257cbjeybmp5d0v.sbx.sandboxes-cloud.docker.com/v1` |

---

## 2. Kết quả Đo lường Hiệu năng Thực tế

### A. Thời gian Phản hồi (Latency, ms)

| Kịch bản kiểm thử | Câu nói tiếng Việt | Tool định tuyến | Tokens | Latency (ms) | Kết quả |
| :--- | :--- | :---: | :---: | :---: | :---: |
| **Câu đơn / Nhớ mua** | *"nhớ mua 5 gói mì tôm hảo hảo"* | `shopping.add` | 41 | **4,110 ms** | Đạt (200 OK) |
| **Hỏi chi tiêu** | *"tháng này tiêu hết bao nhiêu tiền"* | `spending.month` | 25 | **2,990 ms** | Đạt (200 OK) |
| **Kiểm tra kho** | *"trong nhà còn gì không"* | `inventory.list` | 18 | **2,170 ms** | Đạt (200 OK) |
| **Hạn sử dụng** | *"tuần này có gì sắp hết hạn"* | `inventory.expiring` | 22 | **2,920 ms** | Đạt (200 OK) |
| **Thêm kho kèm giá & vị trí** | *"vừa mua 2 chai nước mắm 45k để ở tủ bếp"* | `inventory.add` | 54 | **13,410 ms** | Đạt (200 OK) |

* **Độ trễ trung bình:** ~5,120 ms (5.1 giây).
* **Độ trễ thấp nhất:** 2,170 ms (2.1 giây).
* **Ngưỡng an toàn:** Thấp hơn nhiều so với giới hạn timeout 30,000 ms của Gateway.

---

### B. Mức Tiêu thụ Tài nguyên Hệ thống (RAM & CPU)

Theo dõi thời gian thực qua `docker stats` và `htop`:

1. **Mức tiêu thụ RAM:**
   - **Trạng thái nhàn rỗi (Idle):** ~4.8 GB (Model nạp vào bộ nhớ RAM).
   - **Khi đang sinh từ (Active Inference):** ~5.1 GB - 5.3 GB.
   - **So sánh:** Nhẹ hơn ~80% so với giải pháp `vLLM` (~25 GB, dễ gây tràn ổ đĩa).

2. **Mức sử dụng CPU:**
   - **Trạng thái nhàn rỗi:** 0.1% - 0.5% CPU.
   - **Khi đang suy luận (Inference):** 350% - 600% (Tận dụng đồng thời 4 - 6 nhân CPU ảo của sandbox).

3. **Tỷ lệ Tuân thủ Schema (`validatePlan`):**
   - **100% (5/5 kịch bản)** trả về đúng JSON Schema của hệ thống HomeMind, không xuất hiện markdown codeblock gây lỗi.

---

*Báo cáo được thực hiện và kiểm chứng bởi kỹ sư: Le Nguyen Quoc Hung.*
