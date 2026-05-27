# Cesium Driving Simulator

Full-featured car physics simulator built on CesiumJS + Vite.

## Setup

1. **Prerequisites** — same Vite + CesiumJS setup as before.

2. **Replace files:**
   Copy `main.js`, `audio.js`, `gamepad.js`, `style.css` into your `src/` directory,  
   replacing the originals.

3. **`.env`** — keep your existing token:
   ```
   VITE_CESIUM_ION_TOKEN=your_token_here
   ```

4. **Car model** — `/public/moje_auto/scene.gltf` — unchanged.

5. `npm run dev` → done.

---

## Controls

| Input              | Action              |
|--------------------|---------------------|
| W / Arrow Up       | Throttle            |
| S / Arrow Down     | Brake / Reverse     |
| A / Arrow Left     | Steer left          |
| D / Arrow Right    | Steer right         |
| Space              | Handbrake           |
| V                  | Cycle camera mode   |
| Q / E              | Orbit camera left/right |
| R                  | Respawn             |
| Mouse (click app)  | Camera look (pointer lock) |

**Gamepad (Xbox / PlayStation / generic HID):**
| Button             | Action              |
|--------------------|---------------------|
| Right Trigger (RT) | Throttle            |
| Left Trigger (LT)  | Brake               |
| Left Stick X       | Steer               |
| B / Circle         | Handbrake           |
| Right Stick        | Camera orbit        |

---

## Systems overview

### Physics (`main.js → physicsTick`)

**Steering spring model**  
Rather than snapping to the target angle, the steering rack is modelled as a spring–damper. This means quick direction reversals have a natural lag (like a real rack), and the wheel self-centres proportionally to speed. `steerSpeed` and `steerReturn` control responsiveness.

**Speed-sensitive steering**  
`speedSteerFactor` reduces maximum steering angle as speed increases, preventing the "forklift at 200 km/h" problem from the original. At 200 km/h the wheel can only turn ~45% of its maximum angle.

**Pacejka-inspired grip curve**  
`lateralGripFactor(slipAngle)` implements a simplified Magic Formula:
- Grip rises from 0 to peak as slip angle increases to `peakSlip` (~8.6°).
- Past peak, grip drops off (slides).
- Handbrake reduces grip to 4% (drift mode).

This means short slip → more steering response; excessive slip → oversteer / drift.

**Longitudinal force model**  
- Engine: `F = engineForce × throttle × torqueCurve` where `torqueCurve` peaks at ~0% speed and falls off toward top speed (like a real NA engine).
- Brake: immediate deceleration force.
- Engine braking: proportional to speed ratio (higher gear = more braking).
- Aerodynamic drag: `F = -k × v²` (quadratic, so matters most at high speed).

**Slip drag**  
Energy lost during a slide is converted to deceleration: `slipDrag ∝ slipAngle² × speed`. Handbrake reduces this (tyres are free to spin), allowing sustained drifts.

**Terrain slope alignment**  
Four terrain samples (ahead/behind/left/right of car) are taken every frame. Pitch and cross-slope roll are computed and smoothed, so the car visually rocks on hills.

**Weight transfer (simplified)**  
`brakeTransfer` is computed from CG height and wheelbase. Currently wires into the force model as a scalar; can be extended per-axle for full load transfer.

---

### Camera (`main.js → updateCamera`)

**Chase cam (default)**  
A spring–damper system with mass 1 kg, stiffness 8 N/m, damping 6 Ns/m.  
The target position is behind and above the car; the spring chases it.  
- At high speed, the target moves further back and higher (cinematic pull-out).
- Mouse drag rotates the camera around the car; yaw auto-returns to centre while driving forward.
- Velocity cap prevents overshoot when the car teleports (respawn).

**Hood cam**  
Camera fixed just behind the windscreen in the car's local frame. Mouse look is free (no auto-return).

**Orbit cam**  
Free orbit around the car controlled entirely by mouse. Good for screenshots and inspecting terrain.

Switch with `V`. The mode name is shown in the HUD (top left).

---

### Gamepad (`gamepad.js`)

Reads the [W3C Gamepad API](https://www.w3.org/TR/gamepad/) standard layout.  
Key features:
- **Dead zones** applied before curve: values below threshold are clamped to zero.
- **Input curves** (`steerCurve = 1.8`): raises the magnitude by a power, keeping fine control near centre while allowing full lock without fighting the stick.
- **PS4 axis triggers** auto-detected (axes 4 & 5 on `‑1..+1` range) with fallback to button values (Xbox).
- Connect notification shown as a toast.

---

### Audio (`audio.js`)

Synthesised entirely with Web Audio API — no external audio files required.

| Source         | How it works                                              |
|----------------|-----------------------------------------------------------|
| Engine         | Sawtooth + square harmonics → waveshaper distortion → master gain |
| Low rumble     | Sine at half-fundamental frequency                        |
| Tyre squeal    | White noise → bandpass filter, triggered above 8° slip   |
| Wind           | White noise → high-pass at 2 kHz, scales with v²         |

Engine pitch maps RPM linearly from 80 Hz (idle) to 260 Hz (redline). All parameters use `setTargetAtTime` for smooth interpolation — no clicks or zipper noise.

Starts silently and resumes the AudioContext on first user gesture (browser autoplay policy).

---

### HUD

| Element        | Data                                          |
|----------------|-----------------------------------------------|
| Speed (km/h)   | `car.speed × 3.6`                             |
| RPM gauge      | Canvas arc, red above 85% of redline          |
| Gear           | Simulated auto-gearbox (cosmetic, 6 fwd + R)  |
| Drift score    | Accumulates while `slip > 12°` AND `v > 8 m/s`|
| Grip / Slip    | Live `SLIP Xdeg  GRIP Y%` strip               |
| Camera mode    | Top-left indicator                            |

---

## Extension ideas

- **Wheel mesh animation** — expose wheel nodes in your glTF and rotate them by `car.wheelAngVel`
- **Particle systems** — tyre smoke when `slip > 20°`, dirt when off-road
- **Checkpoint system** — place `Cesium.Entity` billboards as gates, time each lap
- **Traffic / AI cars** — follow splines using the same physics model
- **Force feedback** — use `gamepad.vibrationActuator.playEffect()` on slip events
- **Post-processing** — Cesium post-process stages for speed blur, bloom
