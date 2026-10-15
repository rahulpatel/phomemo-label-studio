# Label Studio for Phomemo M110

Design labels in Figma (or any tool that exports SVG), then fill in and print them on a Phomemo M110 over USB or Bluetooth, straight from the browser. You don't need Phomemo's apps or drivers.

**Use it online at [phomemo.liteloop.dev](https://phomemo.liteloop.dev).** Everything runs in your browser, and templates are saved locally.

## Run it locally

```sh
npm start
```

Requires Node.js 18 or later, with no dependencies to install. Open http://localhost:5173 in a Chromium browser (Helium, Chrome, Edge, Brave). Safari and Firefox don't support WebUSB or Web Bluetooth. Click **Connect USB** and choose the printer. After that, the app reconnects on its own whenever the printer is plugged in. After that, the app reconnects on its own whenever the printer is plugged in.

## Making a template in Figma

1. Create a frame at **8 px per mm**, so 1 Figma pixel is 1 printer dot:

   | Label | Frame |
   | --- | --- |
   | 40 × 30 mm | 320 × 240 |
   | 50 × 30 mm | 400 × 240 |
   | 50 × 80 mm | 400 × 640 (or 640 × 400, printed rotated 90°) |

2. Design in black and white. Grays and photos are dithered. Keep important content 2 mm from the edges.
3. For text that changes, type a placeholder in a text layer: `{{name}}`, `{{price}}`, `{{best before}}`.
   `{{date}}`, `{{time}}` and `{{datetime}}` fill in automatically unless you type something else.
4. Bring it into the app:
   - **Fastest:** right-click the frame → **Copy/Paste as → Copy as SVG**, then press ⌘V in the app.
     To update an existing template after editing in Figma, copy it again and click **Update from clipboard**.
   - **Or** export the frame as SVG (with "Outline text" **off**) and drop the file on the app.
     Dropping a file with the same name again updates that template and keeps its settings.

PNG and JPEG files work too, for designs that never change.

### Tips

- SVGs can only use fonts installed on your Mac. Figma's built-in fonts (like Inter) need to be installed locally. The app warns you when a font is missing. For text that never changes, you can also outline it in Figma.
- Figma positions text by its left edge. For centered or right-aligned fields, choose the matching alignment next to the field in the app. Text then grows from the center or right as you type.
- Text that's too long shrinks automatically to stay on the label.
- Keep each placeholder in one text style. A placeholder split across mixed styles isn't detected.

## Printing

- **Label size**: 40×30, 50×30 and 50×80 mm are built in. Add your own under **Sizes…**. A size is chosen automatically from the design's shape.
- **Rotation**: rotates the design on the label, for example a landscape design on a 50×80 label.
- **Darkness**: how hot the print head runs (1–15, default 10).
- **Image conversion**: *Sharp* for text and logos, *Dithered* for photos. *Auto* picks one for you.
- **Paper & alignment**: paper type (gaps, continuous, black marks) and position offsets. Use **Print alignment test** to calibrate.
  Defaults are −1 mm right and +1 mm down, measured on one M110. Yours may differ.
- ⌘P prints.

Parts of the label that can't print are hatched in red in the preview:

- **Left/right:** the print head is 48 mm wide (384 dots at 8 per mm), while labels can be up to 50 mm. On the M110 this was tested on, the head sits about 1 mm right of center, so on 50 mm labels the left ~2 mm can't print. 40 mm labels fit fully.
- **Top/bottom:** the printer starts printing about 1 mm early, so the design is shifted down 1 mm and its bottom 1 mm is dropped.

Both strips follow the **Shift right / Shift down** settings.

## How it works

| File | Purpose |
| --- | --- |
| `js/m110.js` | Printer protocol: speed `1B 4E 0D`, density `1B 4E 04`, media `1F 11`, raster `GS v 0`, footer `1F F0 05 00 1F F0 03 00`; status replies `1A <type> <value>` |
| `js/transports.js` | WebUSB (vendor `0x0483`, product `0x5740`, printer-class interface, bulk endpoints) and Web Bluetooth (service `0xFF00`, write `0xFF02`, notify `0xFF03`) |
| `js/printer.js` | Connection, status (battery, paper, cover, firmware) and sending print jobs |
| `js/template.js` | SVG import and cleanup, `{{field}}` detection and filling, font checks |
| `js/raster.js` | Renders the SVG at 203 dpi, converts it to black and white, and places it on the 384-dot print head |
| `js/app.js` | User interface |

The protocol is based on [vivier/phomemo-tools](https://github.com/vivier/phomemo-tools) and
[transcriptionstream/phomymo](https://github.com/transcriptionstream/phomymo), and was checked on an M110 (firmware 2.2.2) over USB.
Other Phomemo models and Bluetooth may work but haven't been tested. Issues and pull requests are welcome.

## License

[MIT](LICENSE)

This project isn't affiliated with or endorsed by Phomemo. "Phomemo" is a trademark of its owner.
