import * as Cesium from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import './style.css';

// Initialize setup and authentication
Cesium.Ion.defaultAccessToken = import.meta.env.VITE_CESIUM_ION_TOKEN;

// Create viewer instance with the updated 3D terrain syntax
const viewer = new Cesium.Viewer('app', {
    terrain: Cesium.Terrain.fromWorldTerrain(),
    animation: false,
    timeline: false
});

// Set initial camera view
viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(18.0, 54.0, 1000)
});