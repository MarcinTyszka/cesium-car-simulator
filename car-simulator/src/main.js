/**
 * Cesium Driving Simulator — main.js
 *
 * Requires: Vite + cesium vite plugin, VITE_CESIUM_ION_TOKEN in .env
 * Car model: /public/moje_auto/scene.gltf
 *
 * Camera modes:  CHASE (default) → BONNET → ORBIT   (press V to cycle)
 * Controls:      WASD / Arrows, Space = handbrake, R = respawn, Q/E = orbit cam
 */

import * as Cesium from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import './style.css';

// ─── Cesium init ──────────────────────────────────────────────────────────────
Cesium.Ion.defaultAccessToken = import.meta.env.VITE_CESIUM_ION_TOKEN;

const viewer = new Cesium.Viewer('app', {
    terrain:              Cesium.Terrain.fromWorldTerrain(),
    sceneMode:            Cesium.SceneMode.SCENE3D,
    animation:            false,
    timeline:             false,
    infoBox:              false,
    selectionIndicator:   false,
    navigationHelpButton: false,
    geocoder:             false,
    homeButton:           false,
    sceneModePicker:      false,
    baseLayerPicker:      false,
});

viewer.scene.screenSpaceCameraController.enableInputs = false;
viewer.scene.globe.depthTestAgainstTerrain = true;
viewer.canvas.setAttribute('tabindex', '-1');
viewer.canvas.blur();

Cesium.createOsmBuildingsAsync()
    .then(b => viewer.scene.primitives.add(b))
    .catch(e => console.warn('OSM Buildings:', e));

// ─── HUD ─────────────────────────────────────────────────────────────────────
const hudEl = document.createElement('div');
hudEl.id = 'hud';
hudEl.innerHTML = `
  <div id="hud-speed">
    <span id="spd-val">0</span>
    <span id="spd-unit">km/h</span>
  </div>
  <div id="hud-info">
    <span id="info-mode">CHASE CAM</span>
  </div>
  <div id="hud-controls">
    WASD / Arrows — Drive &nbsp;|&nbsp; Space — Handbrake &nbsp;|&nbsp;
    V — Camera &nbsp;|&nbsp; Q/E — Orbit &nbsp;|&nbsp; R — Respawn
  </div>
`;
document.getElementById('app').appendChild(hudEl);

// ─── Spawn ────────────────────────────────────────────────────────────────────
const SPAWN_LON = 11.4041;
const SPAWN_LAT = 47.2692;
const SPAWN_ALT = 600;

// ═══════════════════════════════════════════════════════════════════════════════
// PHYSICS CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════
const C = {
    // Longitudinal
    maxFwdSpeed:    55.5,       // m/s ≈ 200 km/h
    maxRevSpeed:    8.3,        // m/s ≈ 30 km/h
    engineForce:    16.0,       // m/s² peak acceleration
    brakeForce:     28.0,       // m/s²
    reverseForce:   9.0,
    dragCoeff:      0.004,      // aero drag  F = -k·v²
    rollingResist:  0.012,      // × g
    engineBrake:    3.5,        // m/s² decel off-throttle

    // Steering
    maxSteerAngle:  0.52,       // rad ≈ 30°
    steerSpeed:     4.5,
    steerReturn:    6.0,
    wheelBase:      2.7,        // m

    // Grip
    peakSlip:       0.35,       // rad — slip angle at max lateral force (≈ 20°)
    gripCorrection: 22.0,       // 1/s — how fast velocity heading chases car heading
    pastPeakGrip:   0.55,       // fraction of correction kept after peak slip
    handbrakeGrip:  0.08,       // fraction when handbrake is held
    slipDrag:       0.6,        // longitudinal speed loss from sliding (was 3.0)
    minSpeed:       0.05,

    // Camera spring
    camStiffness:   9.0,
    camDamping:     7.0,
    camMass:        1.0,
};

// ═══════════════════════════════════════════════════════════════════════════════
// CAR STATE
// ═══════════════════════════════════════════════════════════════════════════════
const car = {
    position:        Cesium.Cartesian3.fromDegrees(SPAWN_LON, SPAWN_LAT, SPAWN_ALT),
    heading:         0,      // rad — where nose points
    velocityHeading: 0,      // rad — where speed vector points
    pitch:           0,      // visual: terrain slope
    roll:            0,      // visual: steer lean + slip lean
    slipAngle:       0,      // smoothed visual slip
    rawSlip:         0,      // live slip angle

    speed:           0,      // m/s (positive = forward)
    throttle:        0,
    brake:           0,
    handbrake:       false,
    steerAngle:      0,      // current rack angle (rad)
    steerVel:        0,
};

// ═══════════════════════════════════════════════════════════════════════════════
// INPUT
// ═══════════════════════════════════════════════════════════════════════════════
const keys = {};

window.addEventListener('keydown', e => {
    keys[e.code] = true;
    if (e.code === 'KeyV') cycleCameraMode();
    if (e.code === 'KeyR') respawn();
    if (['Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.code)) {
        e.preventDefault();
    }
}, { capture: true });
window.addEventListener('keyup', e => { keys[e.code] = false; }, { capture: true });

const appEl = document.getElementById('app');
appEl.setAttribute('tabindex', '0');
appEl.focus();
appEl.addEventListener('click', () => {
    appEl.focus();
    appEl.requestPointerLock?.();
});

const mouse = { dx: 0, dy: 0 };
window.addEventListener('mousemove', e => {
    mouse.dx += e.movementX * 0.003;
    mouse.dy += e.movementY * 0.003;
});

// ═══════════════════════════════════════════════════════════════════════════════
// CAMERA
// ═══════════════════════════════════════════════════════════════════════════════
const CAMERA_MODES = ['CHASE', 'BONNET', 'ORBIT'];
let cameraModeIdx = 0;

const camSpring = {
    pos: Cesium.Cartesian3.fromDegrees(SPAWN_LON, SPAWN_LAT, SPAWN_ALT),
    vel: new Cesium.Cartesian3(),
    yaw: 0,
};

const freeLook = { yaw: 0, pitch: -0.12 };

function cycleCameraMode() {
    cameraModeIdx = (cameraModeIdx + 1) % CAMERA_MODES.length;
    document.getElementById('info-mode').textContent =
        CAMERA_MODES[cameraModeIdx] + ' CAM';
    freeLook.yaw   = 0;
    freeLook.pitch = -0.12;
    camSpring.yaw  = 0;
}

// ── ENU helpers ───────────────────────────────────────────────────────────────
const _enu   = new Cesium.Matrix4();
const _east  = new Cesium.Cartesian3();
const _north = new Cesium.Cartesian3();
const _up    = new Cesium.Cartesian3();

function getENUVectors(worldPos) {
    Cesium.Transforms.eastNorthUpToFixedFrame(worldPos, Cesium.Ellipsoid.WGS84, _enu);
    Cesium.Matrix4.getColumn(_enu, 0, _east);
    Cesium.Matrix4.getColumn(_enu, 1, _north);
    Cesium.Matrix4.getColumn(_enu, 2, _up);
    Cesium.Cartesian3.normalize(_east,  _east);
    Cesium.Cartesian3.normalize(_north, _north);
    Cesium.Cartesian3.normalize(_up,    _up);
}

function headingDir(heading, pos) {
    getENUVectors(pos);
    const s = Math.sin(heading), c = Math.cos(heading);
    return new Cesium.Cartesian3(
        _east.x * s + _north.x * c,
        _east.y * s + _north.y * c,
        _east.z * s + _north.z * c,
    );
}

function updateCamera(dt) {
    const mode = CAMERA_MODES[cameraModeIdx];
    const mDx  = mouse.dx;  mouse.dx = 0;
    const mDy  = mouse.dy;  mouse.dy = 0;
    const kDx  = (keys['KeyE'] ? 1 : 0) - (keys['KeyQ'] ? 1 : 0);

    if (mode === 'CHASE') {
        camSpring.yaw += mDx + kDx * 1.2 * dt;
        if (Math.abs(car.speed) > 2) {
            camSpring.yaw *= (1 - 2.0 * dt);
        }

        const absSpeed  = Math.abs(car.speed);
        const dist      = 13 + absSpeed * 0.20;
        const heightOff = 3.2 + absSpeed * 0.05;

        const behind = headingDir(car.heading + Math.PI + camSpring.yaw, car.position);
        getENUVectors(car.position);

        const target = new Cesium.Cartesian3(
            car.position.x + behind.x * dist + _up.x * heightOff,
            car.position.y + behind.y * dist + _up.y * heightOff,
            car.position.z + behind.z * dist + _up.z * heightOff,
        );

        const diff    = Cesium.Cartesian3.subtract(camSpring.pos, target, new Cesium.Cartesian3());
        const springF = Cesium.Cartesian3.multiplyByScalar(diff, -C.camStiffness, new Cesium.Cartesian3());
        const dampF   = Cesium.Cartesian3.multiplyByScalar(camSpring.vel, -C.camDamping, new Cesium.Cartesian3());
        const accel   = Cesium.Cartesian3.add(springF, dampF, new Cesium.Cartesian3());

        Cesium.Cartesian3.add(
            camSpring.vel,
            Cesium.Cartesian3.multiplyByScalar(accel, dt / C.camMass, new Cesium.Cartesian3()),
            camSpring.vel,
        );

        const mag = Cesium.Cartesian3.magnitude(camSpring.vel);
        if (mag > 80) Cesium.Cartesian3.multiplyByScalar(camSpring.vel, 80 / mag, camSpring.vel);

        Cesium.Cartesian3.add(
            camSpring.pos,
            Cesium.Cartesian3.multiplyByScalar(camSpring.vel, dt, new Cesium.Cartesian3()),
            camSpring.pos,
        );

        viewer.camera.setView({
            destination: camSpring.pos,
            orientation: {
                direction: Cesium.Cartesian3.normalize(
                    Cesium.Cartesian3.subtract(car.position, camSpring.pos, new Cesium.Cartesian3()),
                    new Cesium.Cartesian3()
                ),
                up: _up,
            },
        });

    } else if (mode === 'BONNET') {

        freeLook.yaw   += mDx + kDx * 1.2 * dt;
        freeLook.pitch += mDy;
        freeLook.pitch  = Math.max(-1.2, Math.min(0.5, freeLook.pitch));

        const fwd = headingDir(car.heading, car.position);
        getENUVectors(car.position);

        const bonnetPos = new Cesium.Cartesian3(
            car.position.x + fwd.x * 2.0 + _up.x * 1.6,
            car.position.y + fwd.y * 2.0 + _up.y * 1.6,
            car.position.z + fwd.z * 2.0 + _up.z * 1.6,
        );

        const lookH  = headingDir(car.heading + freeLook.yaw, bonnetPos);
        const cosP   = Math.cos(freeLook.pitch);
        const sinP   = Math.sin(freeLook.pitch);
        const lookDir = Cesium.Cartesian3.normalize(
            new Cesium.Cartesian3(
                lookH.x * cosP + _up.x * sinP,
                lookH.y * cosP + _up.y * sinP,
                lookH.z * cosP + _up.z * sinP,
            ),
            new Cesium.Cartesian3()
        );

        viewer.camera.setView({
            destination: bonnetPos,
            orientation: { direction: lookDir, up: _up },
        });

    } else {
        freeLook.yaw   += mDx + kDx * 1.2 * dt;
        freeLook.pitch += mDy;
        freeLook.pitch  = Math.max(-0.05, Math.min(-1.3, freeLook.pitch));

        const dist = 28;
        getENUVectors(car.position);

        const orbitDir = headingDir(freeLook.yaw, car.position);
        const orbitPos = new Cesium.Cartesian3(
            car.position.x + orbitDir.x * dist - _up.x * dist * freeLook.pitch,
            car.position.y + orbitDir.y * dist - _up.y * dist * freeLook.pitch,
            car.position.z + orbitDir.z * dist - _up.z * dist * freeLook.pitch,
        );

        viewer.camera.setView({
            destination: orbitPos,
            orientation: {
                direction: Cesium.Cartesian3.normalize(
                    Cesium.Cartesian3.subtract(car.position, orbitPos, new Cesium.Cartesian3()),
                    new Cesium.Cartesian3()
                ),
                up: _up,
            },
        });
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TERRAIN HELPERS
// ═══════════════════════════════════════════════════════════════════════════════
function getTerrainHeight(carto) {
    return viewer.scene.globe.getHeight(carto) ?? carto.height;
}

function sampleTerrainSlope(carto, heading) {
    const r      = 5 / 6371000;
    const cosLat = Math.cos(carto.latitude);
    const s = Math.sin(heading), c = Math.cos(heading);

    const hA = getTerrainHeight(new Cesium.Cartographic(carto.longitude + r * s / cosLat, carto.latitude + r * c, 0));
    const hB = getTerrainHeight(new Cesium.Cartographic(carto.longitude - r * s / cosLat, carto.latitude - r * c, 0));
    const hR = getTerrainHeight(new Cesium.Cartographic(carto.longitude + r * c / cosLat, carto.latitude - r * s, 0));
    const hL = getTerrainHeight(new Cesium.Cartographic(carto.longitude - r * c / cosLat, carto.latitude + r * s, 0));

    return { pitch: Math.atan2(hA - hB, 10), roll: Math.atan2(hR - hL, 10) };
}

// ═══════════════════════════════════════════════════════════════════════════════
// GRIP CORRECTION RATE
// ═══════════════════════════════════════════════════════════════════════════════
function gripCorrectionRate(slipAngle, handbrake) {
    if (handbrake) return C.gripCorrection * C.handbrakeGrip;

    const ns = Math.abs(slipAngle) / C.peakSlip;

    if (ns <= 1.0) {
        return C.gripCorrection * (0.4 + 0.6 * ns);
    } else {
        const factor = Math.max(C.pastPeakGrip, 1.0 - (ns - 1.0) * 0.45);
        return C.gripCorrection * factor;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHYSICS TICK
// ═══════════════════════════════════════════════════════════════════════════════
function physicsTick(dt) {
    dt = Math.min(dt, 0.05);

    // ── 1. Read inputs ────────────────────────────────────────────────────────
    car.throttle  = (keys['KeyW'] || keys['ArrowUp'])   ? 1 : 0;
    car.brake     = (keys['KeyS'] || keys['ArrowDown']) ? 1 : 0;
    car.handbrake = !!(keys['Space']);

    const steerTarget = (keys['KeyD'] || keys['ArrowRight'] ? 1 : 0)
                      - (keys['KeyA'] || keys['ArrowLeft']  ? 1 : 0);

    // ── 2. Steering spring ────────────────────────────────────────────────────
    const absSpeedKmh = Math.abs(car.speed) * 3.6;
    const speedFactor = 1.0 - Math.min(0.50, absSpeedKmh / 220);
    const targetAngle = steerTarget * C.maxSteerAngle * speedFactor;

    car.steerVel   += (targetAngle - car.steerAngle) * C.steerSpeed * dt * 60;
    car.steerVel   *= 0.72;
    car.steerAngle += car.steerVel * dt;
    if (steerTarget === 0) car.steerAngle *= (1 - C.steerReturn * dt);

    // ── 3. Longitudinal forces ────────────────────────────────────────────────

    let absSpeed = Math.abs(car.speed);
    let longAcc  = 0;

    if (car.throttle > 0) {
        if (car.speed > -0.5) {
            longAcc = C.engineForce * car.throttle * (1.0 - 0.45 * absSpeed / C.maxFwdSpeed);
        } else {
            longAcc = C.brakeForce * car.throttle; 
        }
    } else if (car.brake > 0) {
        if (car.speed > 0.5) {
            longAcc = -C.brakeForce * car.brake;
        } else {
            longAcc = -C.reverseForce * car.brake;
            if (car.speed < -C.maxRevSpeed) longAcc = 0;
        }
    } else if (absSpeed > C.minSpeed) {
        longAcc = -Math.sign(car.speed) *
            (C.engineBrake * absSpeed / C.maxFwdSpeed + C.rollingResist * 9.81);
    }

    longAcc += -Math.sign(car.speed) * C.dragCoeff * car.speed * car.speed;
    car.speed += longAcc * dt;

    absSpeed = Math.abs(car.speed);

    // ── 4. Lateral dynamics ───────────────────────────────────────────────────
    if (absSpeed > C.minSpeed) {
        const turnRate  = (car.speed / C.wheelBase) * Math.tan(car.steerAngle);
        car.heading    += turnRate * dt;

        let diff = car.heading - car.velocityHeading;
        while (diff >  Math.PI) diff -= 2 * Math.PI;
        while (diff < -Math.PI) diff += 2 * Math.PI;

        const rate       = gripCorrectionRate(diff, car.handbrake);
        const speedBlend = Math.min(1.0, absSpeed / 5.0);
        car.velocityHeading += diff * rate * speedBlend * dt;

        car.rawSlip = car.heading - car.velocityHeading;
        while (car.rawSlip >  Math.PI) car.rawSlip -= 2 * Math.PI;
        while (car.rawSlip < -Math.PI) car.rawSlip += 2 * Math.PI;

        const slipDrag = car.rawSlip * car.rawSlip * C.slipDrag * absSpeed;
        car.speed -= Math.sign(car.speed) *
            Math.min(Math.abs(slipDrag * dt), Math.abs(car.speed) * 0.3);

    } else {
        car.velocityHeading = car.heading;
        car.rawSlip         = 0;
        car.speed           = 0;
    }

    // ── 5. Position update ────────────────────────────────────────────────────
    const carto     = Cesium.Cartographic.fromCartesian(car.position);
    const dRatio    = car.speed / 6371000;

    carto.longitude += dRatio * dt * Math.sin(car.velocityHeading) / Math.cos(carto.latitude);
    carto.latitude  += dRatio * dt * Math.cos(car.velocityHeading);
    carto.height     = getTerrainHeight(carto);

    car.position = Cesium.Cartographic.toCartesian(carto);

    // ── 6. Terrain pitch/roll ─────────────────────────────────────────────────
    const slope = sampleTerrainSlope(carto, car.heading);
    car.pitch  += (slope.pitch - car.pitch) * Math.min(1, 8 * dt);

    // ── 7. Visual roll (lean) ─────────────────────────────────────────────────
    const bodyRoll   = (car.steerAngle / C.maxSteerAngle) * (absSpeed / C.maxFwdSpeed) * 0.12;
    const slipSmooth = Math.abs(car.rawSlip) > Math.abs(car.slipAngle) ? 0.25 : 0.04;
    car.slipAngle   += (car.rawSlip - car.slipAngle) * slipSmooth;
    const totalRoll  = Math.max(-0.22, Math.min(0.22, car.slipAngle * 1.4 + bodyRoll))
                     + slope.roll * 0.35;
    car.roll += (totalRoll - car.roll) * Math.min(1, 6 * dt);

    // ── 8. Entity orientation ─────────────────────────────────────────────────
    const hpr = new Cesium.HeadingPitchRoll(car.heading - Math.PI / 2, car.pitch, car.roll);
    orientationProperty.setValue(
        Cesium.Transforms.headingPitchRollQuaternion(car.position, hpr)
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// CAR ENTITY
// ═══════════════════════════════════════════════════════════════════════════════
const orientationProperty = new Cesium.ConstantProperty();

viewer.entities.add({
    name:        'Player Vehicle',
    position:    new Cesium.CallbackProperty(() => car.position, false),
    orientation: orientationProperty,
    model: {
        uri:             '/moje_auto/scene.gltf',
        scale:           1.0,
        heightReference: Cesium.HeightReference.NONE,
    },
});

// ═══════════════════════════════════════════════════════════════════════════════
// HUD — speed only
// ═══════════════════════════════════════════════════════════════════════════════
function updateHUD() {
    document.getElementById('spd-val').textContent =
        (Math.abs(car.speed) * 3.6).toFixed(0);
}

// ═══════════════════════════════════════════════════════════════════════════════
// RESPAWN
// ═══════════════════════════════════════════════════════════════════════════════
function respawn() {
    car.position        = Cesium.Cartesian3.fromDegrees(SPAWN_LON, SPAWN_LAT, SPAWN_ALT);
    car.speed           = 0;
    car.heading         = 0;
    car.velocityHeading = 0;
    car.pitch           = 0;
    car.roll            = 0;
    car.slipAngle       = 0;
    car.rawSlip         = 0;
    car.steerAngle      = 0;
    car.steerVel        = 0;
    camSpring.pos       = Cesium.Cartesian3.clone(car.position);
    camSpring.vel       = new Cesium.Cartesian3();
    camSpring.yaw       = 0;
    freeLook.yaw        = 0;
    freeLook.pitch      = -0.12;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN LOOP
// ═══════════════════════════════════════════════════════════════════════════════
let lastTime = performance.now();

viewer.clock.onTick.addEventListener(() => {
    const now = performance.now();
    const dt  = (now - lastTime) / 1000;
    lastTime  = now;

    physicsTick(dt);
    updateCamera(dt);
    updateHUD();
});

console.log('%cCesium Driving Simulator', 'color:#00e5ff;font-size:14px;font-weight:bold');
console.log('WASD/Arrows = drive | Space = handbrake | V = cam | Q/E = orbit | R = respawn');
