import * as Cesium from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import './style.css';

Cesium.Ion.defaultAccessToken = import.meta.env.VITE_CESIUM_ION_TOKEN;

const viewer = new Cesium.Viewer('app', {
    terrain: Cesium.Terrain.fromWorldTerrain(),
    sceneMode: Cesium.SceneMode.SCENE3D,
    animation: false,
    timeline: false
});

viewer.scene.globe.depthTestAgainstTerrain = true;

// FIX 1: Add Cesium OSM 3D Buildings
Cesium.createOsmBuildingsAsync()
    .then(osmBuildings => viewer.scene.primitives.add(osmBuildings))
    .catch(err => console.warn('OSM Buildings failed to load:', err));

// FIX 3: Disable Cesium's built-in scroll zoom — we handle it ourselves
viewer.scene.screenSpaceCameraController.enableZoom = false;

// Innsbruck, Austria — surrounded by Alps, immediately shows 3D terrain
let currentPosition = Cesium.Cartesian3.fromDegrees(11.4041, 47.2692, 600);
let currentHeading  = 0;
let velocityHeading = 0;
let speed           = 0;
let visualSlipAngle = 0;
let visualRoll      = 0;
let visualPitch     = 0;   // FIX 4: smoothed terrain pitch for model
let steeringAngle   = 0;
let steeringVelocity = 0;

// FIX 3: camera zoom range — scroll wheel adjusts this
let cameraRange = 40;
window.addEventListener('wheel', (e) => {
    e.preventDefault();
    cameraRange += e.deltaY * 0.08;
    cameraRange = Math.max(10, Math.min(250, cameraRange));
}, { passive: false });

const keys = {};
document.addEventListener('keydown', (e) => {
    if (e.code === 'Space') keys['space'] = true;
    else keys[e.key.toLowerCase()] = true;
});
document.addEventListener('keyup', (e) => {
    if (e.code === 'Space') keys['space'] = false;
    else keys[e.key.toLowerCase()] = false;
});

// Reusable orientation property — never reallocated each frame
const orientationProperty = new Cesium.ConstantProperty();

const carEntity = viewer.entities.add({
    name: 'Player Vehicle',
    position: new Cesium.CallbackProperty(() => currentPosition, false),
    orientation: orientationProperty,
    model: {
        uri: '/moje_auto/scene.gltf',
        scale: 1.0,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND
    }
});

// Physics constants
const maxForwardSpeed  = 55.0;
const maxReverseSpeed  = -10.0;
const enginePower      = 0.025;
const reversePower     = 0.01;
const brakingPower     = 0.000000003;
const naturalFriction  = 0.9985;
const engineBraking    = 0.9993;
const baseTurnRate     = 0.015;

// Steering inertia
const steeringAccel    = 0.03;
const steeringReturn   = 0.10;
const steeringDamping  = 0.60;
const maxSteeringAngle = 1.0;

viewer.clock.onTick.addEventListener(() => {

    // ── Throttle / brake ──────────────────────────────────────────
    if (keys['w']) {
        speed += speed < 0
            ? brakingPower * 2.5
            : enginePower * (1.0 - speed / maxForwardSpeed);
    } else if (keys['s']) {
        if (speed > 0) speed -= brakingPower;
        else if (speed > maxReverseSpeed) speed -= reversePower;
    } else {
        speed *= engineBraking * naturalFriction;
    }

    let currentTurnRate = baseTurnRate;
    if (keys['space']) {
        speed *= 0.97;
        currentTurnRate *= 1.6;
    }

    if (Math.abs(speed) < 0.02 && !keys['w'] && !keys['s']) speed = 0;

    // ── Steering z bezwładnością ──────────────────────────────────
    let steeringInput = 0;
    if (keys['a']) steeringInput = -1;
    if (keys['d']) steeringInput =  1;

    if (steeringInput !== 0) {
        steeringVelocity += steeringInput * steeringAccel;
    } else {
        steeringVelocity -= steeringAngle * steeringReturn;
    }

    steeringVelocity *= steeringDamping;
    steeringAngle    += steeringVelocity;
    steeringAngle     = Math.max(-maxSteeringAngle, Math.min(maxSteeringAngle, steeringAngle));

    // ── Steering → heading ────────────────────────────────────────
    let rawSlipAngle = 0;

    if (Math.abs(speed) > 0.1) {
        const driveDir = speed > 0 ? 1 : -1;
        const absSpeed = Math.abs(speed);

        const speedScale   = Math.min(1.0, absSpeed / 15.0);
        const speedFactor  = Math.max(0.25, 1.0 - (absSpeed / maxForwardSpeed) * 0.8);
        const effectiveTurn = steeringAngle * currentTurnRate * speedScale * speedFactor;

        currentHeading += effectiveTurn * driveDir;

        // ── Grip ──────────────────────────────────────────────────
        let grip;
        if      (absSpeed < 8.0)  grip = 1.0;
        else if (absSpeed < 18.0) grip = 1.0 - ((absSpeed - 8.0)  / 10.0) * 0.75;
        else if (absSpeed < 35.0) grip = 0.25 - ((absSpeed - 18.0) / 17.0) * 0.22;
        else                      grip = 0.03;

        if (keys['space']) grip *= 0.08;
        grip = Math.max(0.003, grip);

        let angleDiff = currentHeading - velocityHeading;
        while (angleDiff >  Math.PI) angleDiff -= Math.PI * 2;
        while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;

        if (speed > 0) velocityHeading += angleDiff * grip;
        else           velocityHeading  = currentHeading;

        rawSlipAngle = currentHeading - velocityHeading;
        while (rawSlipAngle >  Math.PI) rawSlipAngle -= Math.PI * 2;
        while (rawSlipAngle < -Math.PI) rawSlipAngle += Math.PI * 2;

        const absSlip     = Math.abs(rawSlipAngle);
        const steeringDrag = Math.abs(steeringAngle) * speedScale * 0.0008;
        const slipDrag     = absSlip * absSlip * 0.012;

        if (speed > 0) {
            speed -= (steeringDrag + slipDrag);
            speed  = Math.max(0, speed);
        }

    } else {
        velocityHeading = currentHeading;
        rawSlipAngle    = 0;
    }

    // ── Ruch ──────────────────────────────────────────────────────
    if (Math.abs(speed) > 0.0) {
        const cartographic  = Cesium.Cartographic.fromCartesian(currentPosition);
        const distanceRatio = (speed / 60.0) / 6371000.0;

        cartographic.latitude  += distanceRatio * Math.cos(velocityHeading);
        cartographic.longitude += distanceRatio * Math.sin(velocityHeading) / Math.cos(cartographic.latitude);

        // Clamp height to actual terrain
        const terrainHeight = viewer.scene.globe.getHeight(cartographic) ?? cartographic.height;
        cartographic.height = terrainHeight;

        currentPosition = Cesium.Cartographic.toCartesian(cartographic);
    }

    // FIX 4: Compute terrain slope to pitch the car model correctly on hills.
    // Sample height 4 m ahead and 4 m behind along the heading direction.
    // Without this the car's nose sinks underground when climbing.
    {
        const cartoBase   = Cesium.Cartographic.fromCartesian(currentPosition);
        const sampleDist  = 4; // metres
        const sampleRatio = sampleDist / 6371000.0;
        const cosLat      = Math.cos(cartoBase.latitude);

        const cartoAhead  = new Cesium.Cartographic(
            cartoBase.longitude + sampleRatio * Math.sin(currentHeading) / cosLat,
            cartoBase.latitude  + sampleRatio * Math.cos(currentHeading),
            0
        );
        const cartoBehind = new Cesium.Cartographic(
            cartoBase.longitude - sampleRatio * Math.sin(currentHeading) / cosLat,
            cartoBase.latitude  - sampleRatio * Math.cos(currentHeading),
            0
        );

        const hAhead  = viewer.scene.globe.getHeight(cartoAhead)  ?? cartoBase.height;
        const hBehind = viewer.scene.globe.getHeight(cartoBehind) ?? cartoBase.height;

        // Positive pitch = nose up (Cesium HPR convention)
        const rawPitch = Math.atan2(hAhead - hBehind, sampleDist * 2);

        // Smooth pitch to avoid jitter from noisy terrain samples
        visualPitch += (rawPitch - visualPitch) * 0.12;
    }

    // ── Wygładzanie slip angle ────────────────────────────────────
    const slipSmoothing = Math.abs(rawSlipAngle) > Math.abs(visualSlipAngle) ? 0.35 : 0.06;
    visualSlipAngle += (rawSlipAngle - visualSlipAngle) * slipSmoothing;

    // ── Przechył nadwozia ─────────────────────────────────────────
    const targetRoll = (steeringAngle / maxSteeringAngle) * (Math.abs(speed) / maxForwardSpeed) * 0.22;
    visualRoll += (targetRoll - visualRoll) * 0.10;

    // ── Orientacja modelu ─────────────────────────────────────────
    const clampedSlip   = Math.max(-0.25, Math.min(0.25, visualSlipAngle * 1.8));
    const totalRoll     = clampedSlip + visualRoll;
    const headingOffset = currentHeading - (Math.PI / 2);

    // FIX 4: apply terrain pitch so the car sits flush on slopes
    const hpr = new Cesium.HeadingPitchRoll(headingOffset, visualPitch, totalRoll);

    orientationProperty.setValue(
        Cesium.Transforms.headingPitchRollQuaternion(currentPosition, hpr)
    );

    // ── Kamera ───────────────────────────────────────────────────
    // FIX 2: empirically determined — currentHeading (no extra offset) puts
    // the camera directly behind the car.
    // FIX 3: cameraRange is now controlled by the mouse scroll wheel.
    viewer.camera.lookAt(
        currentPosition,
        new Cesium.HeadingPitchRange(
            currentHeading,                 // behind the car
            Cesium.Math.toRadians(-15),     // 15° below horizontal
            cameraRange                     // scroll wheel zoom
        )
    );
});