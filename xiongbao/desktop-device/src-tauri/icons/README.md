# Device app icons

Generated from `openbot/app/src/assets/brand/xiongbao-logo-256.png` (256x256 RGBA). The source is only
256px, so the larger sizes (`128x128@2x.png`, and the 512/1024 entries Pillow writes into `icon.icns`)
are upscaled and a little soft. Once a 1024px source exists, point `src` at it and rerun the same command.

Run from `openbot/desktop-device/src-tauri`:

```sh
python3 - <<'PY'
from PIL import Image
src = Image.open("../../app/src/assets/brand/xiongbao-logo-256.png").convert("RGBA")
for name, px in [("32x32", 32), ("64x64", 64), ("128x128", 128), ("128x128@2x", 256)]:
    src.resize((px, px), Image.LANCZOS).save(f"icons/{name}.png")
src.save("icons/icon.ico", sizes=[(s, s) for s in (16, 24, 32, 48, 64, 128, 256)])
src.save("icons/icon.icns")
PY
```

`bunx @tauri-apps/cli icon <source.png> -o icons` also works, but writes extra platform files.
