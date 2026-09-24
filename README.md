# Possibility — generative media experiences

Three interactive experiences built with generative media on [fal](https://fal.ai), shown at the GenMedia Conference 2026.

| Route | Experience | What it shows |
| --- | --- | --- |
| `/stories/` | **Elsewhere** | A city walk that keeps branching: 183 generated scenes, 76 recorded paths, laid out as a 3D tree you can play continuously or scrub frame by frame. |
| `/sim2real/` | **Worldline · Delivery robot** | One simulated street, twelve possible futures (crossing, no-entry sign, junction with a cyclist). Each branch is rendered photoreal from the 3D and checked against the simulation, in day and snow. |
| `/flux3/` | **FLUX 3 Action · Robot arm** | A robot policy compared with real SO-101 recordings, replayed on a 3D arm and re-rendered as video. |

Each experience is its own route, so its 3D scene and media load only when it is opened.

## Models used (fal)

| Endpoint | Used for |
| --- | --- |
| `minimax/h3-max/director` | Elsewhere scenes |
| `minimax/h3-max/reference-to-video` | Delivery robot and robot arm renders, from 3D previsualisations |
| `fal-ai/nano-banana-2/edit` | Photoreal first frames (day and snow) from the 3D frame 0 |
| `fal-ai/sam-3/video-rle` | Checking each render against the simulation |
| `fal-ai/bria/background/remove` | Elsewhere character cut-outs |
| `openrouter/router/decisions` (Jev) and `openrouter/router/vision` (Gemini) | Elsewhere scene rankings and descriptions |
| `fal-ai/flux-3-action/so101` | Robot arm actions (FLUX 3 Action) |

The site replays recorded results: it makes no API calls and needs no key.

## Run locally

```bash
npm install
npm run dev      # http://localhost:3000
npm run build    # static export in out/
```

Requires Node 22 or later. The build is a static export (`output: 'export'`), deployable to any static host.

## Credits

- SO-101 arm model: [TheRobotStudio SO-ARM100](https://github.com/TheRobotStudio/SO-ARM100) URDF (Apache-2.0), loaded with [urdf-loader](https://github.com/gkjohnson/urdf-loaders).
- Robot arm recordings: public [LeRobot](https://huggingface.co/lerobot) SO-101 datasets on Hugging Face.
