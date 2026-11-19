# dummo

**Design, pose and export 3D-printable articulated action figures, right in the browser.**

Pick proportions and an armor style, pose the figure, and download print-ready plates. Every
part comes out already oriented for printing, with snap-fit joints and no supports needed.

**[Open dummo →](https://souzagab.github.io/dummo/)**

![dummo screenshot](docs/screenshot.png)

## Features

- **Parametric body**: 11 proportion controls (torso, shoulders, hips, neck, limbs) plus a global
  scale from 60% to 250%. Presets: Standard, Heroic, Slim, Chibi, Brute.
- **Armor styling**: head shapes (egg, round, block, visor), head size, chest width, limb bulk,
  facet amount, an engraved chest emblem, and an on/off switch for each armor piece.
- **Hands and gear**: fist, open or grip hands. Grip hands can hold a printable sword or staff.
- **Posing**: 25 joints with real joint limits, pose presets (T-pose, Hero, Walk, Run, Kick…),
  mirroring, random poses. Click any part to grab its joint. The figure stays on the ground
  automatically.
- **Print-ready export**: plates packed for your bed (180–300 mm or custom) as 3MF with colors,
  per-part STLs, or a single zip with everything. Choose Draft, Normal or Fine detail.
- **Fit tuning**: material presets (PETG, ABS/ASA, PLA, resin), adjustable interference values,
  and a printable fit-test coupon for dialling in your printer.
- **Display stand** that plugs into a port in the figure's back.
- Exploded view, part outlines, print-plate preview, screenshots, undo/redo, autosave, share
  links, and save/load of `.dummo.json` design files.

![print plates](docs/plates.png)

## How the figures work

Every figure is built from two layers.

**Frame.** All the joints live in the frame, printed in PETG, ABS or ASA. Every frame part is a
5 mm slab that prints flat. Ball stems and bridged slots are flattened so the parts print cleanly
without supports.

| Joint | Where | How it holds |
|---|---|---|
| Ball + C-socket | spine, neck, hips, shoulders, wrists, ankles | the socket is a little smaller than the ball, and the split ring flexes to snap it in |
| Double hinge | knees, elbows | a link with V-ridges clicks onto grooved pins; two pivots give a deep bend |
| Swivel | thigh and upper-arm twist | a disc slides into a T-slot; a printed leaf spring keeps it under tension |

**Armor.** Torso and head armor are two-piece shells that close around the frame with
press-fit pegs. Limb armor is a sleeve that slides on and is held by crush ribs. The feet take the
ankle's tongue.

Fit values (interference and clearance) are absolute: they stay the same at every scale, because
printer error doesn't grow with the model.

## Development

```bash
npm install
npm run dev        # local dev server
npm run check      # build every part for every preset; validate solids and test for collisions
npm run build      # type-check + production build into dist/
```

Requires Node 24 (the check script runs TypeScript directly).

### Layout

```
src/
  core/
    geometry/      joint primitives (kit), frame parts, armor, stand, weapons, test coupon
    catalog.ts     every part: how it's built and where it mounts on the rig
    skeleton.ts    joint hierarchy, pivots, limits
    pose.ts        forward kinematics + pose presets
    layout.ts      bed packing
    export.ts      STL / 3MF / zip writers
  worker/          geometry runs in a Web Worker (manifold-3d, WebAssembly)
  viewer/          three.js scene, posing, plates view
  ui/              panel and controls
scripts/check.ts   headless geometry and collision test (runs in CI before deploying)
```

Pushing to `main` runs the checks, builds, and deploys to GitHub Pages.

Built with [three.js](https://threejs.org), [manifold-3d](https://github.com/elalish/manifold),
[fflate](https://github.com/101arrowz/fflate) and [Vite](https://vite.dev).
