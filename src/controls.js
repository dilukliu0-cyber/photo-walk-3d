import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';

/**
 * First-person WASD + pointer lock (desktop) and touch joystick + look (mobile).
 */
export function createFPSControls(camera, domElement) {
  const controls = new PointerLockControls(camera, domElement);
  const velocity = new THREE.Vector3();
  const direction = new THREE.Vector3();

  const keys = {
    forward: false,
    back: false,
    left: false,
    right: false,
  };

  // Touch state
  const touchMove = { x: 0, y: 0 }; // -1..1
  let lookYaw = 0;
  let lookPitch = 0;
  const euler = new THREE.Euler(0, 0, 0, 'YXZ');
  let touchMode = false;

  const SPEED = 3.2;
  const LOOK_SENS = 0.0035;
  const TOUCH_LOOK_SENS = 0.0045;
  const Y_CLAMP = 1.6; // simple floor / eye height
  const Y_MIN = 0.4;
  const Y_MAX = 4.5;

  function onKeyDown(e) {
    switch (e.code) {
      case 'KeyW':
      case 'ArrowUp':
        keys.forward = true;
        break;
      case 'KeyS':
      case 'ArrowDown':
        keys.back = true;
        break;
      case 'KeyA':
      case 'ArrowLeft':
        keys.left = true;
        break;
      case 'KeyD':
      case 'ArrowRight':
        keys.right = true;
        break;
    }
  }

  function onKeyUp(e) {
    switch (e.code) {
      case 'KeyW':
      case 'ArrowUp':
        keys.forward = false;
        break;
      case 'KeyS':
      case 'ArrowDown':
        keys.back = false;
        break;
      case 'KeyA':
      case 'ArrowLeft':
        keys.left = false;
        break;
      case 'KeyD':
      case 'ArrowRight':
        keys.right = false;
        break;
    }
  }

  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', onKeyUp);

  // --- Touch joystick + look zone ---
  const joystick = document.getElementById('joystick');
  const stick = document.getElementById('stick');
  const lookZone = document.getElementById('look-zone');
  const touchLayer = document.getElementById('touch-layer');

  let joyActive = false;
  let joyId = null;
  let joyOrigin = { x: 0, y: 0 };
  let lookId = null;
  let lookLast = { x: 0, y: 0 };

  function isCoarse() {
    return window.matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
  }

  function enableTouchUI(on) {
    touchMode = on && isCoarse();
    if (!touchLayer) return;
    if (touchMode) {
      touchLayer.classList.remove('hidden');
      touchLayer.classList.add('active');
      // Sync euler from camera
      euler.setFromQuaternion(camera.quaternion);
      lookYaw = euler.y;
      lookPitch = euler.x;
    } else {
      touchLayer.classList.add('hidden');
      touchLayer.classList.remove('active');
    }
  }

  function setStick(dx, dy) {
    if (!stick) return;
    stick.style.transform = `translate(${dx}px, ${dy}px)`;
  }

  if (joystick) {
    joystick.addEventListener(
      'pointerdown',
      (e) => {
        joyActive = true;
        joyId = e.pointerId;
        joystick.setPointerCapture(e.pointerId);
        const rect = joystick.getBoundingClientRect();
        joyOrigin = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        e.preventDefault();
      },
      { passive: false }
    );

    joystick.addEventListener(
      'pointermove',
      (e) => {
        if (!joyActive || e.pointerId !== joyId) return;
        const maxR = 36;
        let dx = e.clientX - joyOrigin.x;
        let dy = e.clientY - joyOrigin.y;
        const len = Math.hypot(dx, dy) || 1;
        if (len > maxR) {
          dx = (dx / len) * maxR;
          dy = (dy / len) * maxR;
        }
        setStick(dx, dy);
        touchMove.x = dx / maxR;
        touchMove.y = -dy / maxR; // up = forward
      },
      { passive: false }
    );

    const endJoy = (e) => {
      if (e.pointerId !== joyId) return;
      joyActive = false;
      joyId = null;
      touchMove.x = 0;
      touchMove.y = 0;
      setStick(0, 0);
    };
    joystick.addEventListener('pointerup', endJoy);
    joystick.addEventListener('pointercancel', endJoy);
  }

  if (lookZone) {
    lookZone.addEventListener(
      'pointerdown',
      (e) => {
        lookId = e.pointerId;
        lookLast = { x: e.clientX, y: e.clientY };
        lookZone.setPointerCapture(e.pointerId);
        e.preventDefault();
      },
      { passive: false }
    );
    lookZone.addEventListener(
      'pointermove',
      (e) => {
        if (e.pointerId !== lookId) return;
        const dx = e.clientX - lookLast.x;
        const dy = e.clientY - lookLast.y;
        lookLast = { x: e.clientX, y: e.clientY };
        lookYaw -= dx * TOUCH_LOOK_SENS;
        lookPitch -= dy * TOUCH_LOOK_SENS;
        lookPitch = Math.max(-Math.PI / 2 + 0.05, Math.min(Math.PI / 2 - 0.05, lookPitch));
        euler.set(lookPitch, lookYaw, 0);
        camera.quaternion.setFromEuler(euler);
      },
      { passive: false }
    );
    const endLook = (e) => {
      if (e.pointerId !== lookId) return;
      lookId = null;
    };
    lookZone.addEventListener('pointerup', endLook);
    lookZone.addEventListener('pointercancel', endLook);
  }

  /**
   * @param {number} dt
   * @param {{ minZ?: number, maxZ?: number, minX?: number, maxX?: number }} bounds
   */
  function update(dt, bounds = {}) {
    const damp = Math.exp(-8 * dt);
    velocity.x *= damp;
    velocity.z *= damp;

    direction.set(0, 0, 0);

    if (touchMode) {
      direction.z = touchMove.y;
      direction.x = touchMove.x;
    } else {
      if (keys.forward) direction.z += 1;
      if (keys.back) direction.z -= 1;
      if (keys.left) direction.x -= 1;
      if (keys.right) direction.x += 1;
    }

    if (direction.lengthSq() > 0) {
      direction.normalize();
      // Move relative to camera yaw
      const forward = new THREE.Vector3();
      camera.getWorldDirection(forward);
      forward.y = 0;
      forward.normalize();
      const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();

      velocity.addScaledVector(forward, direction.z * SPEED * dt * 12);
      velocity.addScaledVector(right, direction.x * SPEED * dt * 12);
    }

    // Cap horizontal speed
    const hSpeed = Math.hypot(velocity.x, velocity.z);
    const maxSpeed = SPEED;
    if (hSpeed > maxSpeed) {
      velocity.x = (velocity.x / hSpeed) * maxSpeed;
      velocity.z = (velocity.z / hSpeed) * maxSpeed;
    }

    if (touchMode || controls.isLocked) {
      camera.position.x += velocity.x * dt;
      camera.position.z += velocity.z * dt;
    }

    // Simple y clamp (floor collision optional)
    camera.position.y = THREE.MathUtils.clamp(camera.position.y, Y_MIN, Y_MAX);
    // Keep eye height mostly fixed when walking
    if (!keys.up && !keys.down) {
      camera.position.y += (Y_CLAMP - camera.position.y) * Math.min(1, dt * 6);
    }

    if (bounds.minX != null) camera.position.x = Math.max(bounds.minX, camera.position.x);
    if (bounds.maxX != null) camera.position.x = Math.min(bounds.maxX, camera.position.x);
    if (bounds.minZ != null) camera.position.z = Math.max(bounds.minZ, camera.position.z);
    if (bounds.maxZ != null) camera.position.z = Math.min(bounds.maxZ, camera.position.z);
  }

  function lock() {
    if (!touchMode) controls.lock();
  }

  function unlock() {
    controls.unlock();
  }

  function reset(position, lookAt) {
    camera.position.copy(position);
    if (lookAt) {
      camera.lookAt(lookAt);
      euler.setFromQuaternion(camera.quaternion);
      lookYaw = euler.y;
      lookPitch = euler.x;
    }
    velocity.set(0, 0, 0);
  }

  function dispose() {
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('keyup', onKeyUp);
    controls.dispose();
  }

  return {
    controls,
    update,
    lock,
    unlock,
    reset,
    enableTouchUI,
    dispose,
    get isLocked() {
      return controls.isLocked;
    },
  };
}
