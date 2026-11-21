# wgb-companion extension

Thay thế Muse: **chat web = NÃO chỉ đạo, agent local = TAY CHÂN.**

```
Bạn + NÃO chỉ đạo (Claude Free / ChatGPT / Gemini web)
   │  gõ:  @wgb <task>          (extension nghe trong chính tab chat)
   ▼
wgb-companion (extension MV3)  ──POST /dispatch──►  wgb serve (127.0.0.1:8787)
   ▲                                                │ createGoal → runner
   │  điền "[wgb] Goal <id>: <kết quả>" + Send      ▼
   └──────────────────────────────────────  echo / exec / opencode / inbox
```

## Cài (Load unpacked — 30 giây)

1. Mở Brave → gõ `brave://extensions` → bật **Developer mode** (góc phải trên).
2. **Load unpacked** → chọn thư mục `wgb-companion` (đã copy sẵn tại
   `C:\Users\My PC\Documents\Extensions\wgb-companion`).
3. Mở tab chat (chatgpt.com / gemini.google.com / claude.ai) — thấy pill
   `wgb ▸ ...` ở góc dưới phải là extension đang sống. Reload tab nếu chưa thấy.
4. Chạy control plane: `node src/cli.js serve` (trong thư mục project).
5. Gõ trong chat: `@wgb status` → extension sẽ tự điền kết quả vào khung chat.

> Vai trò hai phía: chat web (ví dụ Claude Free) là **chỉ đạo/kiểm duyệt** — nó gõ
> `@wgb ...`, nhận kết quả, chốt DUYỆT hoặc sửa; agent local (opencode/inbox) là
> **thực thi**. Vòng: Chỉ đạo → Thực thi → Kiểm duyệt, lặp tới khi xong.

## Ghi chú

- `@wgb status` — liệt kê goals gần nhất (nhanh, không tốn token).
- Khi goal đang chạy, pill xanh hiển thị tiến độ; chống echo tự động (bỏ qua tin `[wgb]`, cooldown 20s).
- Đổi cấu hình trong popup của extension (server URL, trigger, autoSend).
- Chỉ hoạt động khi `wgb serve` đang chạy. Máy khác dùng được nếu mở port + đặt token.

## v1.1 — bài học throttle đắt (2026-11-21)

v1.0 poll record API **mỗi 3s** (~1.200 request/giờ) → tự gây "A temporary limit is
preventing this chat from loading" (ChatGPT throttle). v1.1 sửa theo chuẩn
`chatgpt-use` (15 loads/40 sends mỗi giờ):

1. **Record fetch giữ nhịp 15s/lần** (mỗi lần chỉ 1 request) — thay vì 3s.
2. **Backoff luỹ thừa khi bị limit**: 60s → 120s → ... tối đa 5 phút; pill hiển thị
   thời gian nghỉ; reset khi thành công. **Tin cũ không mất** — chỉ bị throttle.
3. **Dedupe theo nội dung** (`doneHashes`, tối đa 100 task gần nhất): task trùng
   không dispatch lại — cho phép xử lý **ngay tin đầu tiên** sau khi load (hết cảnh
   "tin đầu bị nuốt" của v1.0).

Sau khi sửa file: `brave://extensions` → nạp lại (icon refresh trên card
wgb-companion) → reload các tab chat.
