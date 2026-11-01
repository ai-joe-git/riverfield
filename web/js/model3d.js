// A GLB viewer for the 3D apps: three.js on a canvas, orbit + auto-rotate, disposed when it leaves the page.
// three and its addons are vendored in web/vendor/three (the import map in index.html points "three" there).
import * as THREE from "three";
import { GLTFLoader } from "/vendor/three/GLTFLoader.js";
import { OrbitControls } from "/vendor/three/OrbitControls.js";
import { el } from "./util.js";

/**
 * modelViewer(url, { height }) -> a div that renders the GLB at `url`.
 * Drag to orbit, wheel to zoom. Rendering stops when the element is off screen.
 */
export function modelViewer(url, { height = 460, cls = "" } = {}) {
  const wrap = el("div", { class: `model3d ${cls}`.trim(), style: {
    position: "relative", width: "100%", height: `${height}px`, borderRadius: "14px", overflow: "hidden",
    background: "radial-gradient(ellipse 70% 60% at 50% 18%, #10182a, #05070d 72%)",
    border: "1px solid var(--line)",
  } });
  const hint = el("span", { class: "faint", style: {
    position: "absolute", left: "12px", bottom: "10px", fontSize: "11px", letterSpacing: ".04em",
    textTransform: "uppercase", pointerEvents: "none", zIndex: 2,
  } }, "drag to orbit · wheel to zoom");

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, 1, 0.01, 200);
  camera.position.set(2.2, 1.6, 2.6);

  const key = new THREE.DirectionalLight(0xdfe8ff, 2.1);
  key.position.set(3, 5, 2.5);
  const rim = new THREE.DirectionalLight(0x8db4ff, 1.1);
  rim.position.set(-4, 2, -3);
  scene.add(key, rim, new THREE.HemisphereLight(0xbcd2ff, 0x0a0f18, 1.1));

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  } catch {
    return el("div", { class: "empty" }, "WebGL is not available in this browser");
  }
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  wrap.append(renderer.domElement, hint);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 1.6;
  controls.minDistance = 0.4;
  controls.maxDistance = 30;

  let disposed = false;
  let visible = true;
  let raf = 0;
  const fit = () => {
    const w = wrap.clientWidth || 640;
    const h = wrap.clientHeight || height;
    renderer.setSize(w, h, false);
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  new ResizeObserver(fit).observe(wrap);

  new GLTFLoader().load(url, (gltf) => {
    if (disposed) return;
    const root = gltf.scene;
    const box = new THREE.Box3().setFromObject(root);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    root.position.sub(center);
    const radius = Math.max(size.x, size.y, size.z) || 1;
    const dist = radius * 2.1;
    camera.position.set(dist * 0.8, dist * 0.55, dist);
    camera.near = radius / 100;
    camera.far = radius * 100;
    camera.updateProjectionMatrix();
    controls.target.set(0, 0, 0);
    controls.minDistance = radius * 0.6;
    controls.maxDistance = radius * 12;
    controls.update();
    scene.add(root);
    fit();
  }, undefined, () => {
    if (!disposed) wrap.append(el("div", { class: "empty", style: { position: "absolute", inset: 0, display: "grid", placeItems: "center" } },
      "the model could not be loaded"));
  });

  const io = new IntersectionObserver((entries) => {
    visible = entries.some((e) => e.isIntersecting);
    if (visible) loop();
  }, { threshold: 0.05 });
  io.observe(wrap);

  const loop = () => {
    if (disposed || !visible) return;
    raf = requestAnimationFrame(loop);
    controls.update();
    renderer.render(scene, camera);
  };

  // dispose when the page swaps it out (main.js replaces the view's DOM)
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(raf);
    io.disconnect();
    controls.dispose();
    scene.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
          for (const v of Object.values(m)) if (v && v.isTexture) v.dispose();
          m.dispose();
        }
      }
    });
    renderer.dispose();
  };
  wrap.addEventListener("DOMNodeRemovedFromDocument", dispose);
  new MutationObserver((_, obs) => {
    if (!wrap.isConnected) { dispose(); obs.disconnect(); }
  }).observe(document.body, { childList: true, subtree: true });

  requestAnimationFrame(() => { fit(); loop(); });
  return wrap;
}
