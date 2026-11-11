# Ocularium

A medieval first-person game seen through a body-worn camera, for the web (WebGPU).

## Run

```sh
npm install
npm run dev
```

Open http://localhost:5199 in a recent Chrome or Edge and click to begin.

The sword is a weight on the end of an arm. There are no stored strokes: how hard a blow lands depends on how
fast the blade is really going, where along it the contact is, and whether the edge is leading. Blades and
shields stop each other by being in the way. Running, striking and taking blows all cost wind.

## Controls

| Input | Action |
|---|---|
| W A S D | Move |
| Shift | Run |
| C | Crouch |
| Space | Jump |
| Q / E | Lean |
| Mouse | Aim |
| Hold left button | The mouse moves the sword hand |
| Draw it back and let go | Cut; the longer it is held, the harder |
| Drag it across | Cut by hand |
| Click left button | Quick cut |
| Right button | Raise shield |
| F (hold to wind up) | Thrust |
| Esc | Pause |

## Credits

Third-party models, textures, sounds and motion are listed with their licences in
`public/assets/CREDITS.md`, `public/assets/audio/LICENSES.md` and
`public/assets/characters/LICENSES.md`.
