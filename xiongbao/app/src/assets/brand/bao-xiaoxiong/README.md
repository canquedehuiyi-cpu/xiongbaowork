# 宝小熊 / BAO XIAOXIONG — avatar asset manifest

The design sheet for the staff/group avatar presets. **No image files live here yet** — this
folder holds only the cutting list (`manifest.json`). Binary files cannot be pushed through the
GitHub MCP file tools (they take text only), so the crops must be cut and pushed through a
binary-capable path (a `git push` from a machine that has the files).

## Source

- Design sheet (original PNG, 1140×1380):
  `~/workspace/user/media_library/image/873e74cb-6bbd-4bf4-9152-a8d8e21b8da4.png`
- Pinyin edition (WebP, 1392×1680, the one the crops are measured on):
  `~/workspace/imagine_media/media-generation-baoxiaoxiong-bao-pinyin-0-a8d76913-f845-4493-af94-ccf97ab42a80.webp`
- The sheet shows five outfits （潮酷街头 / 华贵国风 / 休闲萌趣 / 酷炫科技 / 喜庆舞狮）, five
  expressions （调皮 / 可爱 / 帅气 / 开心 / 卖萌）, and a three-view section.

## Licence

**Pending user confirmation.** The sheet is the user's own design material; confirm its licence
and permission before shipping any crop as a preset. Do not publish the crops until that is
settled.

## What `manifest.json` holds

- `outfits` — five entries with the outfit slug used by the `portraits.outfit` column
  (`street`, `guofeng`, `casual`, `tech`, `lion`) and the square crop box on the sheet.
- `expressions` — five entries with the preset slug (`naughty`, `cute`, `cool`, `happy`, `sweet`)
  and the square crop box on the sheet.
- `combinations` — the 25 outfit × expression combinations are **planned, batch 2**. They are not
  plain crops: each needs the expression head composited onto the outfit body (head-swap), so no
  crop boxes are listed for them.
- `animations` — batch 1 is the five expressions × seven motion states (35 animations). They are
  shipped as CSS motion loops over the static poster (`portrait-motion-*` in `app/src/styles.css`)
  with `videoUrl: null` in `PRESET_ANIMATIONS`, because no mp4 files can be pushed through the
  MCP tools. Real video playback exists for uploaded videos via the `portrait_media` table and
  the `<video>` branch in `AbstractAvatar`; preset mp4 files are pending a binary-capable push.
  Dance videos are batch 2, not part of the seven states.

## Cutting a crop

Head centres were located by visual grounding on the 1392×1680 sheet and converted to pixels;
each crop box is centre ± half the side, clamped to the sheet. **Re-measure before cutting —
do not trust these numbers blindly.**

```sh
ffmpeg -i <sheet.webp> -vf "crop=SIZE:SIZE:X:Y" <slug>.png
```

One crop per entry in `manifest.json`, square-cropped, then resized to 256 px for the picker.
Until the Bao crops land, the five shipped preset posters stay the existing
`@/assets/brand/xiongbao-{cool,cute,happy,naughty,sweet}.png`.
