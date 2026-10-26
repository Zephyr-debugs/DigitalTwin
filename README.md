# worker_bot digital twin

A single-screen engineering dashboard for the worker_bot humanoid: a three.js viewport driven by live telemetry, manual joint control or the embedded animation clips, with per-joint motor data, alerts and history.

Vite, TypeScript (strict) and three.js. No UI framework.

## Run

```sh
npm install
npm run dev        # http://localhost:5173
npm run build      # type-checks, then builds to dist/
npm run preview    # serves dist/
```

The app runs without the model. Put the export at `public/models/worker_bot.glb` and it loads within 2 seconds, no reload needed. Until then the viewport says what is missing and telemetry keeps running.

No model yet? `npm run make-test-rig` writes a box-built stand-in with the same bone names, mesh prefixes, clips and axis conventions. Delete it before dropping in the real file, or overwrite it.

## Layout

| Area | What it holds |
| --- | --- |
| Top bar | Link state and source, mode (Live, Manual, Playback; keys 1, 2, 3), clock and session time |
| Viewport | Robot, subsystem status, joint markers, hover readout, frame stats |
| Inspector | Selection summary, every joint and axis as a clamped slider, reset and T-pose |
| Dock | Clips and timeline, joint telemetry table, trends and event log |

Click a body part to select its subsystem; click a joint marker, table row or inspector entry to select a joint. Sliders take arrow keys (1°), Shift+arrow or Page keys (10°), Home and End (limits). The timeline takes arrows (1 frame) and Shift+arrows (12 frames).

## Modes

- **Live**: the twin follows telemetry through a 70 ms exponential smoother. When frames include `commanded`, the inspector shows a tick at the commanded angle and the table shows the largest per-axis difference.
- **Manual**: sliders drive the bones directly. Moving a slider in another mode switches here, starting from the current pose.
- **Playback**: embedded clips through `AnimationMixer`, with crossfade, speed, loop and a scrubbable timeline. Sliders read back the clip pose.

## Real telemetry

Telemetry comes from a `TelemetrySource` (`src/telemetry/types.ts`):

```ts
interface TelemetrySource {
  readonly kind: 'simulated' | 'websocket';
  readonly label: string;
  readonly status: LinkStatus;
  connect(): void;
  disconnect(): void;
  onFrame(fn: (f: TelemetryFrame) => void): () => void;
  onStatus(fn: (s: LinkStatus) => void): () => void;
}
```

Two implementations ship: `SimulatedSource` (default) and `WebSocketSource`.

### WebSocket

Start the app with `?ws=ws://host:port`, set `VITE_TELEMETRY_WS` in `.env`, or pick WebSocket in the top bar (it then uses `ws://localhost:8765`). Each message is one JSON frame:

```json
{
  "t": 1730000000.123,
  "joints": { "upper_arm.L": [x, y, z], "root": [0, -0.01, 0] },
  "commanded": { "upper_arm.L": [x, y, z] },
  "motors": { "upper_arm.L": { "temp_c": 41.2, "current_a": 1.8, "torque_nm": 6.4 } },
  "system": { "battery_pct": 87, "latency_ms": 12, "controller_load_pct": 41 }
}
```

- `t` is seconds since the epoch.
- `joints` is degrees per Blender bone name, in the rig's logical axes (the delta convention below).
- `joints.root` is optional, in metres; only `y`, the vertical bob, is used.
- `commanded` is optional and enables tracking error.
- Any field can be missing. Unknown bone names are shown in the table header, and malformed frames are counted and skipped.
- If `latency_ms` is absent it is estimated as now minus `t`, which is only meaningful with synchronised clocks.

The source reconnects with backoff from 0.5 to 8 s and reports the link as stale after 1 s without frames.

`npm run telemetry:demo` starts a local sender at 50 Hz (`--port`, `--hz`) for checking this path.

### Another transport

For ROS bridge, MQTT, SSE and the like, extend `BaseSource`, translate messages into `TelemetryFrame`, call `this.emitFrame(frame)` and `this.setStatus(...)`, and return it from `App.createSource`. Nothing else changes.

## Alerts

Thresholds live in `DEFAULT_THRESHOLDS` in `src/config.ts`:

- motor temperature, current and torque as a fraction of each joint's rated torque
- tracking error and margin to joint limits
- battery, link latency and controller load

Override per session with a URL parameter, for example `?thresholds={"temp_c":{"warn":55,"fault":70}}` (URL-encode it).

Levels use 4% hysteresis so they do not chatter. A subsystem takes its worst joint's level. "Alert tint" colours that subsystem's meshes; markers on warning or fault joints stay coloured even with markers hidden. Rated torques per joint are in `JOINTS`.

## Rig conventions and checks

- **Bones:** looked up by name with dots and underscores ignored, because GLTFLoader turns `upper_arm.L` into `upper_armL`. Blender `.001` and loader `_1` suffixes and armature prefixes are tolerated. The console prints a found / not-found table, and missing bones appear in the viewport and the event log.
- **Pose:** `q = qRest * qDelta`, with the delta Euler in three.js order `ZYX` (Blender `XYZ`).
- **Axis check:** on load, each upper arm and shin is rotated about every axis and the hand or foot position is watched. Left upper arm +X must raise the arm (right: -X) and shin +X must move the foot backward. If the export disagrees, that bone's axis map is corrected and the event log says so. Results are in the console under `[axis-check]`.
- **Neutral pose:** the first frame of `Idle`, used by Reset pose. T-pose is all deltas zero.
- **Scale:** normalised to 1.8 m from the rest-pose bounding box, feet on the floor.
- **Accent colour:** sampled from the model's red materials, or textures if the red lives there. A lifted variant is used for text so it meets AA contrast.

Add `?debug` for a skeleton helper and axes.

## Re-exporting from Blender

Export glTF Binary with +Y up, Apply Modifiers on, Skinning on, Animation on. Use "NLA tracks" or "Actions" so each clip is a separate animation named Idle, Wave, Walk, Look_Around, Arms_Raise and TPose. Blender's `Armature|Idle` naming is handled.

- Keep bone names exactly as in the spec.
- Keep mesh names starting with `Head_`, `Torso_`, `Arm_` or `Leg_`, since subsystem shading depends on them.
- Arm and leg meshes can span both sides; per-side highlighting comes from the bone markers.

## Optimising the model

The raw export (about 117 skinned meshes, 435k triangles, sixteen 4096 px textures) is too heavy for the web. Run:

```sh
npm run optimize            # textures to 2048 px WebP, meshopt geometry
npm run optimize:1k         # 1024 px textures
npm run optimize -- --simplify 0.6   # also decimate to ~60% of triangles
```

The first run moves the untouched export to `models-src/worker_bot.original.glb`, and every run optimises from that copy, so repeated runs never re-compress compressed data. To start over, delete that copy and place a fresh export.

Steps run in order: dedup, prune, resample, weld, optional simplify, WebP resize, meshopt (quantise and compress). The app decodes meshopt itself.

The script deliberately skips join, flatten and palette, because those would merge or rename the meshes and bones the app depends on. That also means draw calls stay at roughly one per mesh. If profiling points there, merge meshes per subsystem in Blender while keeping the prefix.

Simplify is off by default; check the arm and leg deformation at shoulder, elbow and knee before keeping it.

## Code map

```
src/config.ts            joints, limits, axis names, thresholds, constants
src/app.ts               state, modes, model lifecycle, selection, event log
src/twin/                loader, skeleton-map, pose-driver, axis-check, clip-player,
                         subsystems (tint and rim shading), markers (joints and pick
                         proxies), contact-shadow, viewport
src/telemetry/           frame types and sources, store (history), alerts
src/ui/                  DOM components, one per area
src/styles/              tokens, base, layout, components
scripts/                 optimize-model, make-test-rig, ws-telemetry-demo
```

## Performance notes

- **Picking** uses low-poly proxies attached to bones. Ray-testing 435k skinned triangles on every pointer move would cost far more than a frame.
- **Frustum culling** is off for skinned meshes, because their rest-pose bounds are wrong once limbs move.
- **Pixel ratio** is capped at 2. Textures are uploaded and shaders compiled before the first visible frame.
- **Readouts** update at 10 Hz (table, charts) or 30 Hz (sliders, visible joints only), never per frame.
- **Cleanup:** geometry, materials, textures, render targets and listeners are disposed when the app is torn down (including Vite HMR).
