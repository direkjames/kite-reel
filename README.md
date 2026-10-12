# Kite Reel

A free video editor for Windows. Your videos never leave your PC.

Kite Reel is part of the Kite family, alongside [Kite Photo](https://direkjames.github.io/kite-photo/).

## What it does today

A multi-track editor in the familiar layout: media library on the left, preview in the middle, properties on the right, timeline along the bottom.

- Video, audio and text tracks, as many as you add
- Import videos, photos and sounds, then drag them onto the timeline
- Move, trim, split and delete clips, with snapping
- Select several clips at once (Ctrl and click, or drag a box over empty space) and move, copy, paste or delete them together
- Speed changes from a quarter speed to four times, with the sound kept in tune
- Turn, mirror and crop any video or photo
- Fade in and fade out for videos, photos, text and sounds
- Transitions between clips that touch: dissolve and flash, added from the small button on the join
- Text layers with font, size, colour, alignment, outline and background, positioned by dragging in the preview
- Looks and light and color sliders for each clip, plus size, position and opacity
- Volume for each clip, mute and hide for each track
- Frame shapes: 16:9, 9:16, 1:1 and 4:5
- Undo and redo, project files, and your last session restored when you reopen the app
- Export to MP4

### Keys

| Key | Does |
|---|---|
| Space | Play or pause |
| S, or Ctrl+B | Split at the playhead |
| Delete | Delete the selected clips |
| Ctrl+C, Ctrl+X, Ctrl+V | Copy, cut, and paste at the playhead |
| Ctrl+D | Make a copy straight after the selected clips |
| Ctrl+A, Esc | Select everything, select nothing |
| T | Add text at the playhead |
| Left, Right | Step one frame (with Shift, one second) |
| Home, End | Go to the start or end |
| + and - | Zoom the timeline (also Ctrl + scroll) |
| Ctrl+Z, Ctrl+Shift+Z | Undo, redo |
| Ctrl+I | Import media |
| Ctrl+S, Ctrl+O | Save or open a project |
| Ctrl+E | Export |

## Getting it

Download `Kite-Reel-Setup-x.y.z.exe` from the [latest release](https://github.com/direkjames/kite-reel/releases/latest) and run it.

Windows will show a "Windows protected your PC" notice the first time, because the installer is not signed by a registered publisher. Choose **More info**, then **Run anyway**.

After that, Kite Reel keeps itself up to date. It checks for a new version when it starts, downloads it in the background, and installs it the next time it closes.

## Publishing an update

1. Change the code.
2. Raise the `version` number in `package.json`, for example from `0.3.0` to `0.4.0`.
3. Put the changes on the `main` branch.

GitHub then builds the installer and publishes a release (see the Actions tab). Installed copies pick it up by themselves. If the version number is not raised, nothing is published.

## How it is put together

| Part | What it is |
|---|---|
| `main.js`, `preload.js` | The Windows app: window, file dialogs, updates |
| `src/engine.js` | Everything that talks to FFmpeg: reading, preview copies, export |
| `src/server.js` | A private local server that connects the editor screen to the engine |
| `renderer/` | The editor screen: `store.js` holds the project, `player.js` and `gl.js` draw the preview, `timeline.js` and `panels.js` are the interface, `exporter.js` hands the project to the engine |
| `.github/workflows/build.yml` | The recipe GitHub follows to build and publish |

## Running it from the code

Needs [Node.js](https://nodejs.org) 20 or newer.

```
npm install
npm start
```

## Licenses

Kite Reel is free software under the GNU General Public License, version 3 or later.
It bundles [FFmpeg](https://ffmpeg.org), whose build here is also under the GPL. See `NOTICE.md`.
