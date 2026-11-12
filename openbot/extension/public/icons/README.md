# Toolbar icons

Generated from `app/src/assets/brand/xiongbao-logo-256.png` (the upstream icons were replaced). Regenerate from `openbot/`:

```sh
python3 -c "
from PIL import Image
src = Image.open('app/src/assets/brand/xiongbao-logo-256.png').convert('RGBA')
for size in (16, 32, 48, 128):
    src.resize((size, size), Image.LANCZOS).save(f'extension/public/icons/{size}.png', optimize=True)
"
```
