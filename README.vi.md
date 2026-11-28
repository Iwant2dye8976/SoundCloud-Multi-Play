[English](README.md) | **Tiếng Việt**

# SoundCloud Multi-Play

Tiện ích mở rộng Chrome (Manifest V3) giúp SoundCloud tiếp tục phát nhạc ngay cả khi bạn đang phát ở tab hoặc thiết bị khác, đi kèm popup mini-player với các phím điều khiển, lưu tiến trình phát và tải bài hát.

## Tính năng

- **Phát nhạc đa thiết bị / đa tab** — Giữ SoundCloud tiếp tục phát ngay cả khi bạn bắt đầu phát ở tab trình duyệt khác hoặc thiết bị khác (`"Paused because you started playing on another device."`). Có thể bật/tắt nhanh trong popup (hiển thị nhãn `OFF` trên biểu tượng khi tạm dừng).
- **Điều khiển mini-player & thanh tiến trình tua được** — Hiển thị ảnh bìa, tên bài hát chạy chữ khi quá dài (nhấn để sao chép `"Nghệ sĩ - Tên bài"`), nghệ sĩ, thời gian đã phát/tổng thời lượng, tua trực tiếp đến bất kỳ vị trí nào và chuyển nhanh giữa nhiều tab SoundCloud.
- **Phím tắt toàn cục & trong popup** — Điều khiển Phát/Tạm dừng, Bài tiếp theo, Bài trước và Thích từ bất kỳ tab nào (tùy chỉnh tại `chrome://extensions/shortcuts`), cùng đầy đủ phím tắt trong popup.
- **Điều chỉnh âm lượng & tắt tiếng** — Kéo thanh âm lượng (`0%–100%`) hoặc bật/tắt tiếng ngay từ popup.
- **Like & Follow** — Nhấn thích bài hát đang phát hoặc theo dõi nghệ sĩ trực tiếp trong popup.
- **Tải bài hát đang phát** — Tải về bài hát đang phát (định dạng `.m4a` AAC hoặc `.mp3` khi SoundCloud cung cấp) với thanh tiến trình trực tiếp, tự thử lại khi timeout và hỗ trợ nhấn để hủy tải.
- **Lưu & tiếp tục tiến trình** — Tự động lưu vị trí đang nghe cho bài hát gần nhất, đặt lại thời gian phát khi bạn nghe bài mới, chuyển bài tiếp theo hoặc nghe hết bài, kèm thẻ Tiếp tục (Resume) trong popup.
- **Điều khiển từ điện thoại qua mạng LAN** — Điều khiển phát/tạm dừng, tua, âm lượng, trộn bài/lặp lại, Like/Follow và chuyển tab SoundCloud từ điện thoại cùng mạng Wi-Fi/LAN thông qua máy chủ Node.js nhẹ (không phụ thuộc thư viện ngoài) kèm mã PIN và mã QR ghép nối.

## Điều khiển qua mạng LAN

### Cách A — Tự động bật/tắt cùng tiện ích (khuyên dùng trên Windows)

1. Nhấn **Copy setup** trong popup (lệnh chạy được từ bất kỳ thư mục nào và tự tìm đường dẫn tiện ích), hoặc chạy từ bất kỳ đâu:
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File "C:\soundcloud\lan-server\install-native-host.ps1"
   ```
2. Tải lại tiện ích tại `chrome://extensions`.
3. Bật **LAN Mobile Remote** trong popup — Chrome sẽ tự động chạy ngầm máy chủ cầu nối (không cần mở terminal) và tự dừng khi tắt. Quét mã QR hoặc mở địa chỉ LAN và nhập mã PIN 6 chữ số trên điện thoại.

*(Để gỡ bỏ cấu hình tự khởi động và lệnh `sc-remote`, chạy `powershell -NoProfile -ExecutionPolicy Bypass -File "C:\soundcloud\lan-server\uninstall-native-host.ps1"`.)*

### Cách B — Chạy thủ công (từ bất kỳ thư mục nào)

Sau khi chạy cài đặt một lần, bạn có thể mở server từ bất kỳ thư mục nào bằng lệnh:
```sh
sc-remote
```
Hoặc chạy trực tiếp bằng Node:
```sh
node "C:\soundcloud\lan-server\server.js"
```

## Phím tắt toàn cục

| Phím mặc định | Chức năng |
| --- | --- |
| `Alt` + `Shift` + `P` | Phát / Tạm dừng |
| `Alt` + `Shift` + `N` | Bài tiếp theo |
| `Alt` + `Shift` + `B` | Bài trước |
| `Alt` + `Shift` + `L` | Thích / bỏ thích bài hát |

## Phím tắt (trong Popup)

| Phím | Chức năng |
| --- | --- |
| `Space` / `K` | Phát / Tạm dừng |
| `←` / `→` | Tua lùi / tới 10 giây |
| `Shift` + `←` / `J` | Bài trước |
| `Shift` + `→` | Bài tiếp theo |
| `↑` / `↓` | Tăng / giảm âm lượng 5% |
| `M` | Tắt / bật tiếng |
| `S` | Bật / tắt phát ngẫu nhiên (Shuffle) |
| `R` | Đổi chế độ lặp lại (Repeat) |
| `L` | Thích / bỏ thích bài hát |
| `F` | Theo dõi / bỏ theo dõi nghệ sĩ |
| `C` | Sao chép liên kết bài hát |
| `D` | Tải bài hát đang phát |

## Cài đặt (Load Unpacked)

1. Mở `chrome://extensions` trên Chrome (hoặc trình duyệt nhân Chromium như Edge, Brave).
2. Bật **Chế độ cho nhà phát triển (Developer mode)** ở góc trên bên phải.
3. Nhấn **Tải tiện ích đã giải nén (Load unpacked)** và chọn thư mục `C:\soundcloud`.
4. Mở hoặc tải lại trang `https://soundcloud.com`.

## Cấu trúc thư mục

```text
soundcloud/
├── manifest.json          # Tệp cấu hình tiện ích (MV3)
├── background.js          # Service worker MV3 xử lý phím tắt toàn cục và nhãn OFF
├── content-main.js        # Hook ở MAIN world, điều khiển phát nhạc, tải bài và đồng bộ tiến trình
├── content-bridge.js      # Cầu nối ISOLATED world cho chrome.storage và giao tiếp popup
├── icons/
│   ├── icon-16.png
│   ├── icon-48.png
│   └── icon-128.png
├── lan-server/
│   ├── server.js          # Máy chủ Node.js HTTP + WebSocket qua LAN (không phụ thuộc ngoài)
│   └── public/            # Giao diện web điều khiển cho điện thoại (HTML, CSS, JS)
└── popup/
    ├── popup.html         # Giao diện popup
    ├── popup.css          # CSS giao diện tối cho mini-player
    ├── popup.js           # Logic popup, phím tắt, ghép nối LAN và giao tiếp với tab
    └── qr.js              # Trình tạo mã QR SVG không phụ thuộc ngoài
```

## Quyền truy cập

- `storage` — Lưu trạng thái bật/tắt, cấu hình LAN và vị trí phát đã lưu cục bộ trong `chrome.storage.local`.
- `tabs` — Tìm các tab SoundCloud đang mở để lấy trạng thái trình phát, gửi lệnh điều khiển hoặc chuyển đến/mở SoundCloud.
- `alarms` — Duy trì kết nối WebSocket trong service worker MV3 khi bật điều khiển qua mạng LAN.
- `nativeMessaging` — Cho phép Chrome tự động bật và tắt máy chủ cầu nối LAN cục bộ theo công tắc LAN Mobile Remote.
- `*://*.soundcloud.com/*` — Chèn content script trên các trang SoundCloud.
