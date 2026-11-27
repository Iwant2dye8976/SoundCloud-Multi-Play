[English](README.md) | **Tiếng Việt**

# SoundCloud Multi-Play

Tiện ích mở rộng Chrome (Manifest V3) giúp SoundCloud tiếp tục phát nhạc ngay cả khi bạn đang phát ở tab hoặc thiết bị khác, đi kèm popup mini-player với các phím điều khiển, lưu tiến trình phát và tải bài hát.

## Tính năng

- **Phát nhạc đa thiết bị / đa tab** — Giữ SoundCloud tiếp tục phát ngay cả khi bạn bắt đầu phát ở tab trình duyệt khác hoặc thiết bị khác (`"Paused because you started playing on another device."`). Có thể bật/tắt nhanh trong popup.
- **Điều khiển mini-player & thanh tiến trình tua được** — Hiển thị ảnh bìa, tên bài hát, nghệ sĩ, thời gian đã phát/tổng thời lượng và cho phép kéo tua trực tiếp đến bất kỳ vị trí nào.
- **Điều chỉnh âm lượng & tắt tiếng** — Kéo thanh âm lượng (`0%–100%`) hoặc bật/tắt tiếng ngay từ popup.
- **Like & Follow** — Nhấn thích bài hát đang phát hoặc theo dõi nghệ sĩ trực tiếp trong popup.
- **Tải bài hát đang phát** — Tải về bài hát đang phát (định dạng `.m4a` AAC hoặc `.mp3` khi SoundCloud cung cấp) với thanh tiến trình trực tiếp và tự động mờ dần về nút mặc định khi tải xong.
- **Lưu & tiếp tục tiến trình** — Tự động lưu vị trí đang nghe cho bài hát gần nhất, đặt lại thời gian phát khi bạn nghe bài mới, chuyển bài tiếp theo hoặc nghe hết bài, kèm thẻ Tiếp tục (Resume) trong popup.

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
├── content-main.js        # Hook ở MAIN world, điều khiển phát nhạc, tải bài và đồng bộ tiến trình
├── content-bridge.js      # Cầu nối ISOLATED world cho chrome.storage và giao tiếp popup
├── icons/
│   ├── icon-16.png
│   ├── icon-48.png
│   └── icon-128.png
└── popup/
    ├── popup.html         # Giao diện popup
    ├── popup.css          # CSS giao diện tối cho mini-player
    └── popup.js           # Logic popup, phím tắt và giao tiếp với tab
```

## Quyền truy cập

- `storage` — Lưu trạng thái bật/tắt và vị trí phát đã lưu cục bộ trong `chrome.storage.local`.
- `tabs` — Tìm các tab SoundCloud đang mở để lấy trạng thái trình phát, gửi lệnh điều khiển hoặc chuyển đến/mở SoundCloud.
- `*://*.soundcloud.com/*` — Chèn content script trên các trang SoundCloud.
