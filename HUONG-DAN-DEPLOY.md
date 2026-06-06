# 🚀 HƯỚNG DẪN DEPLOY APP LÊN VERCEL (có domain riêng)

App này sau khi deploy sẽ:
- Mở được từ **mọi máy** (MacBook của bạn, máy nhân viên, điện thoại) qua một địa chỉ web
- **Không còn dính CORS** — lấy đơn Printify thật, không cần tắt CORS hay Terminal
- **Giấu token an toàn** trên server (không lộ ra trình duyệt)

---

## CÁCH 1: Deploy bằng web (dễ nhất — không cần cài gì)

### Bước 1 — Tạo tài khoản GitHub & Vercel (miễn phí)
1. Tạo tài khoản tại **github.com** (nếu chưa có)
2. Tạo tài khoản tại **vercel.com** → chọn **Continue with GitHub**

### Bước 2 — Đưa code lên GitHub
1. Vào **github.com** → nhấn **New repository**
2. Đặt tên (vd: `pod-manager`) → **Create repository**
3. Nhấn **uploading an existing file**
4. Kéo thả **toàn bộ** thư mục này (cả `api/`, `public/`, `vercel.json`, `package.json`) vào
5. Nhấn **Commit changes**

### Bước 3 — Kết nối Vercel
1. Vào **vercel.com** → **Add New** → **Project**
2. Chọn repo `pod-manager` vừa tạo → **Import**
3. Giữ nguyên mọi thiết lập mặc định → nhấn **Deploy**
4. Đợi ~1 phút → Vercel cho bạn 1 link dạng `https://pod-manager-xxx.vercel.app`

### Bước 4 — Cấu hình token Printify (giấu an toàn)
Vào **Settings → Environment Variables**. Chọn 1 trong 2 cách:

**Cách A — Nhiều tài khoản Printify (khuyên dùng):**
- Name: `PRINTIFY_TOKENS`
- Value (JSON 1 dòng):
```json
[{"name":"Shop Vợ","token":"eyJ_token_1..."},{"name":"Shop Em","token":"eyJ_token_2..."}]
```
- App sẽ tự gộp đơn từ **tất cả** tài khoản, và cho lọc theo từng shop.

**Cách B — Một tài khoản:**
- Name: `PRINTIFY_TOKEN`  |  Value: token của bạn

(Tuỳ chọn) thêm `MERCHIZE_KEY`, `SELLERWIX_KEY` nếu muốn giấu key xưởng.
Xong nhấn **Redeploy**.

> 💡 Trong app: vào **Cài đặt** → **Kiểm tra kết nối tất cả tài khoản** để xem các shop đã nối. Ngoài màn hình đơn hàng có ô lọc **🏪 Tất cả shop** để xem riêng từng shop.

### Bước 4b — TÀI KHOẢN ĐĂNG NHẬP & PHÂN QUYỀN ⭐
App có đăng nhập + phân quyền (Sếp = admin, Nhân viên = staff). Tài khoản lưu trong **database** (cần bật Upstash ở Bước 4c), mật khẩu được **mã hoá an toàn**.

1. Thêm biến **`AUTH_SECRET`** = chuỗi bí mật bất kỳ (vd: `pod-secret-2025-doi-cai-nay`).
2. (Tuỳ chọn) đặt admin mặc định khác:
   - `ADMIN_DEFAULT_USER` (mặc định: `admin`)
   - `ADMIN_DEFAULT_PASS` (mặc định: `abc13579`)
3. **Redeploy**.

**Lần đầu đăng nhập:** dùng `admin` / `abc13579` (hoặc giá trị bạn đặt ở bước 2).

**Sau khi đăng nhập (Sếp):**
- Vào menu **👥 Quản lý nhân viên** → thêm nhân viên, reset mật khẩu, xoá tài khoản
- Vào menu **🔑 Đổi mật khẩu** → đổi pass admin của mình (nên làm ngay sau lần đầu)

**Nhân viên:** đăng nhập bằng tài khoản sếp cấp → vào **🔑 Đổi mật khẩu** để tự đổi.

> Tài khoản lưu trong database nên đổi/reset pass ngay trong app, không cần vào Vercel. (Nếu chưa bật database thì app dùng tạm `USERS_JSON` và không đổi pass trong app được.)

### Phân quyền cụ thể

| Chức năng | Sếp (admin) | Nhân viên (staff) |
|---|---|---|
| Xem đơn, tìm kiếm | ✅ | ✅ |
| Cập nhật trạng thái, gán designer/fulfiller | ✅ | ✅ |
| Upload file thiết kế, xác nhận SP | ✅ | ✅ |
| Đánh dấu gấp, gửi proof, thiếu info | ✅ | ✅ |
| **Trang Bảng thống kê / Lợi nhuận** | ✅ | ❌ ẩn |
| **Đẩy đơn sang xưởng** | ✅ | ❌ ẩn |
| **Xoá đơn** | ✅ | ❌ ẩn |
| **Sửa token / Cài đặt** | ✅ | ❌ ẩn |

### Bước 4c — DATABASE DÙNG CHUNG (cả team thấy giống nhau) ⭐
Để mọi người (sếp + nhân viên) thấy **cùng một dữ liệu** (đơn, trạng thái, designer, ghi chú...), app dùng Upstash Redis — miễn phí.

1. Vào **upstash.com** → đăng nhập (bằng GitHub cũng được) → **Create Database**
   - Chọn loại **Redis**, đặt tên bất kỳ, chọn region gần (Singapore/Tokyo cho VN)
2. Sau khi tạo, kéo xuống mục **REST API** → copy 2 giá trị:
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`
3. Lên Vercel → **Settings → Environment Variables**, thêm 2 biến đó (tên y hệt)
4. **Redeploy**

Sau bước này:
- Sếp tải đơn về → lưu lên database chung
- Nhân viên mở app → thấy đúng dữ liệu đó, gán designer/đổi trạng thái → sếp & người khác thấy ngay
- Mỗi lần sửa đơn tự lưu lên database (không mất khi đóng máy)

> Nếu **chưa** cấu hình Upstash: app vẫn chạy, nhưng dữ liệu chỉ lưu trên trình duyệt từng máy (mỗi người thấy riêng). Cấu hình Upstash để dùng chung.


### Bước 5 — Dùng app
- Mở link Vercel → app hiện ra
- Nếu đã set `PRINTIFY_TOKEN`: chỉ cần nhấn **Tải đơn** (không cần dán token nữa)
- Nếu chưa set: dán token vào ô như cũ → **Tải đơn**

---

## CÁCH 2: Gắn domain riêng (vd: app.tencuaban.com)

1. Mua domain ở bất kỳ đâu (Namecheap, GoDaddy, Tenten, Mắt Bão...)
2. Trong Vercel project → **Settings** → **Domains** → **Add**
3. Nhập domain của bạn → Vercel hướng dẫn trỏ DNS (thêm record CNAME/A)
4. Đợi DNS cập nhật (vài phút–vài giờ) → xong, mở bằng domain riêng

---

## CHI PHÍ
- **Vercel Hobby (miễn phí)**: đủ dùng cho 1 shop, vài người dùng. Giới hạn rộng rãi.
- **Vercel Pro (~$20/tháng)**: nếu nhiều đơn, nhiều người, cần ổn định cao hơn.
- **Domain**: ~$10–15/năm tuỳ đuôi (.com, .shop...).

---

## CẤU TRÚC THƯ MỤC
```
pod-app/
├── api/
│   ├── auth.js       ← đăng nhập + phân quyền (admin/staff)
│   ├── printify.js   ← lấy đơn Printify (nhiều token, giấu CORS)
│   ├── push.js       ← đẩy đơn sang xưởng (chỉ admin)
│   ├── data.js       ← lưu/đọc đơn DÙNG CHUNG cho cả team
│   └── _redis.js     ← kết nối Upstash database
├── public/
│   └── index.html    ← giao diện app (đăng nhập, đa shop, đồng bộ chung)
├── vercel.json
└── package.json
```

## TÓM TẮT CÁC BIẾN MÔI TRƯỜNG CẦN ĐẶT TRÊN VERCEL
| Biến | Bắt buộc? | Dùng để |
|---|---|---|
| `AUTH_SECRET` | ✅ | ký phiên đăng nhập |
| `USERS_JSON` | tuỳ chọn | tài khoản (chỉ khi CHƯA bật database) |
| `ADMIN_DEFAULT_USER` / `ADMIN_DEFAULT_PASS` | tuỳ chọn | admin mặc định lần đầu (mặc định admin/abc13579) |
| `PRINTIFY_TOKENS` (hoặc `PRINTIFY_TOKEN`) | ✅ | lấy đơn |
| `UPSTASH_REDIS_REST_URL` | ⭐ nên có | database chung |
| `UPSTASH_REDIS_REST_TOKEN` | ⭐ nên có | database chung |
| `MERCHIZE_KEY`, `SELLERWIX_KEY` | tuỳ chọn | giấu key xưởng |

---

## LƯU Ý BẢO MẬT
- Token Printify bạn từng gửi trong chat **nên tạo lại cái mới** (vào Printify → Connections → xoá cũ, tạo mới).
- Khi đã deploy + set Environment Variable, token **không còn hiện** trong trình duyệt → an toàn cho nhân viên dùng chung.

---

## 🔍 SHOP INSIGHT — phân tích theo shop & nhân viên

Trang **Shop Insight** (menu, chỉ admin) gồm:
- **Soi từng shop**: chọn shop ở góc phải → xem số đơn, doanh thu, lợi nhuận, tỉ lệ lỗi/gấp riêng
- **So sánh các shop**: bảng xếp hạng shop theo doanh thu, lợi nhuận, tỉ lệ lỗi
- **Sản phẩm bán chạy** + biểu đồ theo loại sản phẩm
- **Xếp hạng nhân viên** theo SKU: số đơn / doanh thu / lợi nhuận / tốc độ (đổi tiêu chí bằng dropdown)

### Cách gán nhân viên qua SKU
Nhân viên được nhận diện qua **viết tắt trong SKU** (ở đâu trong SKU cũng được, miễn tách bởi `-` `_` hoặc khoảng trắng).

Khai báo bảng viết tắt: menu **👥 Quản lý nhân viên** → mục **🔖 Viết tắt SKU → Nhân viên** → thêm cặp (viết tắt → tên). Ví dụ:
- `LN` → Lan  (SKU `LN-TS-00125` tính cho Lan)
- `HG` → Hương
- `TA` → Tuấn Anh

App tự đọc mọi SKU và quy đơn về đúng nhân viên để xếp hạng. Viết tắt dài hơn được ưu tiên khớp trước (tránh nhầm).
