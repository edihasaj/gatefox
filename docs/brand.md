---
summary: 'Gateway fox identity, documentation colors, and generated asset provenance.'
read_when:
  - Changing the gateway logo or documentation design
  - Adding a surface that uses gateway brand assets
---

# Gateway identity

The fox is the gateway's logo. Its ivory muzzle forms an arch, with a moss accent
at the entrance. The master is a transparent head illustration so the character
remains recognizable in small marks.

The documentation uses parchment `#F6F3EB`, charcoal `#18201B`, and moss
`#426258`. Its orange link and button color is `#BA3C19`, darkened from the
illustration's vermilion for text contrast. Baskerville headings pair with
Avenir Next body text and local font fallbacks. The page needs no remote fonts,
analytics, or build step.

`assets/brand/fox-master.png` preserves the generated image. The documentation
uses a 256 px transparent logo and 32 px and 16 px favicons. The generation record
contains the prompt, hashes, and derivative commands. Alpha edges were inspected
on magenta; small marks were checked on light and dark backgrounds.

This is the identity for the gateway's README, usage guide, and native macOS
control panel. The app uses the original transparent fox in its chrome and a
parchment rounded tile in its Dock icon. `scripts/build-macos-icon.sh` derives
the 1024 px tile and multi-resolution ICNS from the existing master without new
image generation. Its derivative record is in `assets/brand/generation/`.
Do not modify the signed ChatGPT bundle to add gateway branding.

Open `docs/index.html` directly, or serve `docs/` with a static web server.
Clipboard buttons use the browser clipboard when permitted; otherwise they
select the command text for manual copying. Search and navigation run locally.
