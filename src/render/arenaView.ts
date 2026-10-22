/**
 * ArenaView: the 3D arena from the pure Arena data - vertex-coloured heightmap (recoloured live when
 * reactions change the ground), water/lava sheet, props, stadium rim, gradient sky dome tied to
 * weather + real local hour, a sun whose elevation follows the hour, and weather particles.
 */
import * as THREE from "../lib/three.ts";
import { GROUND_IDS, GROUNDS } from "../data/grounds.ts";
import { type Weather, WEATHERS } from "../data/weather.ts";
import type { Arena } from "../world/arena.ts";
import { Rng } from "../core/rng.ts";
import { softDot } from "./textures.ts";

export interface SkyState {
  sunDir: THREE.Vector3;
  day: number;
}

/** Sun direction and daylight factor for a local hour (simple solar arc, east -> west). */
export function sunForHour(hour: number): SkyState {
  const t = ((hour - 6) / 12) * Math.PI;
  const elev = Math.sin(t) * 1.05;
  const az = t;
  const dir = new THREE.Vector3(Math.cos(az) * Math.cos(Math.max(elev, -0.3)), Math.sin(elev), -0.35).normalize();
  const day = THREE.MathUtils.clamp(Math.sin(t) * 1.6 + 0.15, 0, 1);
  return { sunDir: dir, day };
}

export class ArenaView {
  readonly group = new THREE.Group();
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  private terrain: THREE.Mesh;
  private colors: Float32Array;
  private water: THREE.Mesh | null = null;
  private sky: THREE.Mesh;
  private skyMat: THREE.ShaderMaterial;
  private version = -1;
  private weatherFx: THREE.Points | THREE.LineSegments | null = null;
  private weatherVel: Float32Array | null = null;
  private weatherId = "";
  private jitter: Float32Array;
  private dot = softDot();

  constructor(readonly arena: Arena, private scene: THREE.Scene, shadows: boolean) {
    const n = arena.n;
    const geo = new THREE.PlaneGeometry(arena.size, arena.size, n - 1, n - 1);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    for (let k = 0; k < pos.count; k++) {
      const x = pos.getX(k), z = pos.getZ(k);
      pos.setY(k, arena.heightAt(x, z));
    }
    geo.computeVertexNormals();
    this.colors = new Float32Array(pos.count * 3);
    this.jitter = new Float32Array(pos.count);
    const rng = new Rng(arena.spec.seed);
    for (let k = 0; k < pos.count; k++) this.jitter[k] = 0.9 + rng.next() * 0.18;
    geo.setAttribute("color", new THREE.BufferAttribute(this.colors, 3));
    this.terrain = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0.02 }));
    this.terrain.receiveShadow = shadows;
    this.group.add(this.terrain);
    this.recolor();

    if (GROUND_IDS.some((g, gi) => GROUNDS[g].liquid && arena.grounds.includes(gi))) {
      const lava = arena.spec.kind === "volcano";
      const wm = new THREE.MeshStandardMaterial({
        color: lava ? 0xff5a14 : 0x2b6db3,
        emissive: new THREE.Color(lava ? 0xff3a00 : 0x000000),
        emissiveIntensity: lava ? 0.9 : 0,
        transparent: true,
        opacity: lava ? 0.92 : 0.7,
        roughness: lava ? 0.6 : 0.08,
        metalness: 0.1,
      });
      // The lava sheet fills the CRATER only (crater > 0.45 <=> d < ~0.11 R): drawn arena-wide at the lava
      // level it hid 98 % of the walkable ash ground (arena-preview lane finding, pass 4).
      this.water = new THREE.Mesh(new THREE.CircleGeometry(lava ? arena.radius * 0.135 : arena.half * 1.05, 64).rotateX(-Math.PI / 2), wm);
      this.water.position.y = arena.waterLevel;
      this.water.receiveShadow = shadows;
      this.group.add(this.water);
    }
    this.addProps(shadows);
    // Stadium rim: a ring marking the playable circle + tiered stands.
    const ring = new THREE.Mesh(new THREE.TorusGeometry(arena.radius + 0.4, 0.08, 6, 96).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35 }));
    ring.position.y = 0.05 + Math.max(0, arena.waterLevel + 0.05);
    this.group.add(ring);
    const standMat = new THREE.MeshStandardMaterial({ color: 0x3a4250, roughness: 0.85 });
    for (let tier = 0; tier < 3; tier++) {
      const r = arena.half + 2 + tier * 2.2;
      const st = new THREE.Mesh(new THREE.CylinderGeometry(r + 2, r + 2, 1.2, 72, 1, true), standMat);
      st.position.y = 2.6 + tier * 1.3;
      st.material.side = THREE.DoubleSide;
      this.group.add(st);
    }

    this.skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: { top: { value: new THREE.Color() }, bottom: { value: new THREE.Color() }, sunDir: { value: new THREE.Vector3() }, glow: { value: new THREE.Color(0xfff2d0) } },
      vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position,1.0); p.z = p.w * 0.99999; gl_Position = p; }`,
      fragmentShader: `uniform vec3 top; uniform vec3 bottom; uniform vec3 sunDir; uniform vec3 glow; varying vec3 vDir;
        void main(){ float h = clamp(vDir.y*0.5+0.5,0.0,1.0); vec3 c = mix(bottom, top, smoothstep(0.42,0.95,h));
        float s = max(dot(normalize(vDir), normalize(sunDir)),0.0); c += glow * pow(s, 64.0) * 0.9 + glow * pow(s, 6.0) * 0.12; gl_FragColor = vec4(c,1.0); }`,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(400, 32, 16), this.skyMat);
    this.group.add(this.sky);

    this.hemi = new THREE.HemisphereLight(0xcfe6ff, 0x4a3f30, 0.7);
    this.sun = new THREE.DirectionalLight(0xffffff, 2.2);
    this.sun.castShadow = shadows;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = sc.bottom = -arena.half;
    sc.right = sc.top = arena.half;
    sc.near = 1;
    sc.far = 140;
    this.sun.shadow.bias = -0.0005;
    this.group.add(this.hemi, this.sun, this.sun.target);
    scene.add(this.group);
  }

  private addProps(shadows: boolean): void {
    const mats = {
      rock: new THREE.MeshStandardMaterial({ color: 0x7c7a74, roughness: 0.95, flatShading: true }),
      trunk: new THREE.MeshStandardMaterial({ color: 0x5b3d22, roughness: 0.9 }),
      leaves: new THREE.MeshStandardMaterial({ color: 0x2f6b32, roughness: 0.85, flatShading: true }),
      crystal: new THREE.MeshStandardMaterial({ color: 0xb59cff, emissive: 0x6a4cff, emissiveIntensity: 0.6, roughness: 0.2, metalness: 0.3, flatShading: true }),
      pillar: new THREE.MeshStandardMaterial({ color: 0x9aa0a8, roughness: 0.6, metalness: 0.3 }),
      reed: new THREE.MeshStandardMaterial({ color: 0x6f8a3a, roughness: 0.8 }),
      dune: new THREE.MeshStandardMaterial({ color: 0xd8c27a, roughness: 1 }),
    };
    for (const p of this.arena.props) {
      const g = new THREE.Group();
      const y = this.arena.heightAt(p.x, p.z);
      g.position.set(p.x, y, p.z);
      g.rotation.y = p.rot;
      g.scale.setScalar(p.scale);
      switch (p.kind) {
        case "rock": {
          const m = new THREE.Mesh(new THREE.DodecahedronGeometry(0.9, 0), mats.rock);
          m.scale.set(1.2, 0.8, 1);
          m.position.y = 0.3;
          g.add(m);
          break;
        }
        case "tree": {
          const t = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.28, 2.4, 7), mats.trunk);
          t.position.y = 1.2;
          const l = new THREE.Mesh(new THREE.ConeGeometry(1.4, 3.2, 8), mats.leaves);
          l.position.y = 3.4;
          g.add(t, l);
          break;
        }
        case "crystal": {
          for (let k = 0; k < 3; k++) {
            const c = new THREE.Mesh(new THREE.OctahedronGeometry(0.5 + k * 0.15, 0), mats.crystal);
            c.scale.set(0.6, 2 - k * 0.4, 0.6);
            c.position.set((k - 1) * 0.5, 0.8, (k % 2) * 0.3);
            c.rotation.z = (k - 1) * 0.3;
            g.add(c);
          }
          break;
        }
        case "pillar": {
          const c = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.55, 4, 10), mats.pillar);
          c.position.y = 2;
          g.add(c);
          break;
        }
        case "reed": {
          for (let k = 0; k < 6; k++) {
            const r = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.05, 1.6, 4), mats.reed);
            r.position.set(Math.sin(k * 2.1) * 0.4, 0.8, Math.cos(k * 1.7) * 0.4);
            r.rotation.z = Math.sin(k) * 0.2;
            g.add(r);
          }
          break;
        }
        case "dune": {
          const d = new THREE.Mesh(new THREE.SphereGeometry(1.6, 12, 8), mats.dune);
          d.scale.set(1.6, 0.35, 1);
          g.add(d);
          break;
        }
      }
      g.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) {
          o.castShadow = shadows;
          o.receiveShadow = shadows;
        }
      });
      this.group.add(g);
    }
  }

  /** Re-colour the terrain from the ground grid (called when reactions transform tiles). */
  recolor(): void {
    const a = this.arena;
    const pos = (this.terrain.geometry.attributes.position as THREE.BufferAttribute);
    const c = new THREE.Color();
    for (let k = 0; k < pos.count; k++) {
      const g = a.groundAt(pos.getX(k), pos.getZ(k));
      c.setHex(g.color).convertSRGBToLinear();
      const j = this.jitter[k];
      this.colors[k * 3] = c.r * j;
      this.colors[k * 3 + 1] = c.g * j;
      this.colors[k * 3 + 2] = c.b * j;
    }
    (this.terrain.geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    this.version = a.version;
  }

  setConditions(weather: Weather, hour: number): void {
    const { sunDir, day } = sunForHour(hour);
    const top = new THREE.Color(weather.sky[0]), bottom = new THREE.Color(weather.sky[1]);
    const night = new THREE.Color(0x070b1a), nightLow = new THREE.Color(0x1a2240);
    top.lerp(night, 1 - day);
    bottom.lerp(nightLow, 1 - day);
    const dusk = Math.max(0, 1 - Math.abs(sunDir.y) * 4) * day;
    bottom.lerp(new THREE.Color(0xff9a5a), dusk * 0.5);
    this.skyMat.uniforms.top.value.copy(top);
    this.skyMat.uniforms.bottom.value.copy(bottom);
    this.skyMat.uniforms.sunDir.value.copy(sunDir.y > -0.1 ? sunDir : sunDir.clone().negate());
    const sunPos = (sunDir.y > -0.05 ? sunDir : new THREE.Vector3(-sunDir.x, Math.abs(sunDir.y) + 0.4, -sunDir.z)).clone().multiplyScalar(60);
    this.sun.position.copy(sunPos);
    this.sun.target.position.set(0, 0, 0);
    const moon = sunDir.y <= -0.05;
    this.sun.color.setHex(moon ? 0x9fb4ff : dusk > 0.3 ? 0xffc48a : 0xfff4e6);
    this.sun.intensity = (moon ? 0.45 : 0.6 + 2.2 * day) * weather.light;
    this.hemi.intensity = (0.25 + 0.6 * day) * weather.light + 0.15;
    this.hemi.color.copy(top).lerp(new THREE.Color(0xffffff), 0.4);
    this.scene.fog = new THREE.FogExp2(bottom.getHex(), weather.fog * 0.9);
    if (weather.id !== this.weatherId) this.buildWeather(weather);
  }

  private buildWeather(w: Weather): void {
    this.weatherId = w.id;
    if (this.weatherFx) {
      this.weatherFx.geometry.dispose();
      (this.weatherFx.material as THREE.Material).dispose();
      this.weatherFx.removeFromParent();
      this.weatherFx = null;
    }
    if (w.particles === "none") return;
    const rng = new Rng(7);
    const N = w.particles === "rain" ? 1800 : 1400;
    const S = this.arena.size * 0.75;
    if (w.particles === "rain") {
      const p = new Float32Array(N * 6);
      this.weatherVel = new Float32Array(N);
      for (let k = 0; k < N; k++) {
        const x = rng.range(-S, S), y = rng.range(0, 22), z = rng.range(-S, S);
        p.set([x, y, z, x - 0.05, y - 0.7, z], k * 6);
        this.weatherVel[k] = rng.range(16, 22);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(p, 3));
      this.weatherFx = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: w.id === "acidRain" ? 0xc8ff8a : 0xaecdff, transparent: true, opacity: 0.45 }));
    } else {
      const p = new Float32Array(N * 3);
      this.weatherVel = new Float32Array(N);
      for (let k = 0; k < N; k++) {
        p.set([rng.range(-S, S), rng.range(0, 20), rng.range(-S, S)], k * 3);
        this.weatherVel[k] = rng.range(0.5, 1.5);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(p, 3));
      const color = { snow: 0xffffff, sand: 0xe0b878, ash: 0x5a4a44, sparkle: 0x9effd8, leaves: 0x7fbf4a }[w.particles] ?? 0xffffff;
      const size = { snow: 0.18, sand: 0.12, ash: 0.14, sparkle: 0.22, leaves: 0.2 }[w.particles] ?? 0.15;
      this.weatherFx = new THREE.Points(g, new THREE.PointsMaterial({ color, size, map: this.dot, transparent: true, depthWrite: false, opacity: 0.85, blending: w.particles === "sparkle" ? THREE.AdditiveBlending : THREE.NormalBlending }));
    }
    this.group.add(this.weatherFx);
  }

  update(dt: number, weather: Weather, t: number): void {
    if (this.arena.version !== this.version) this.recolor();
    if (this.water) {
      const m = this.water.material as THREE.MeshStandardMaterial;
      if (this.arena.spec.kind === "volcano") m.emissiveIntensity = 0.75 + Math.sin(t * 1.7) * 0.2;
      this.water.position.y = this.arena.waterLevel + Math.sin(t * 0.8) * 0.02;
    }
    if (!this.weatherFx || !this.weatherVel) return;
    const pos = this.weatherFx.geometry.attributes.position as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    const S = this.arena.size * 0.75;
    const wind = weather.wind;
    if (weather.particles === "rain") {
      for (let k = 0; k < this.weatherVel.length; k++) {
        const o = k * 6, v = this.weatherVel[k] * dt;
        arr[o + 1] -= v;
        arr[o + 4] -= v;
        arr[o] += wind * dt * 0.4;
        arr[o + 3] += wind * dt * 0.4;
        if (arr[o + 4] < -1) {
          arr[o + 1] = 22;
          arr[o + 4] = 21.3;
          arr[o] = ((arr[o] + S) % (2 * S)) - S;
          arr[o + 3] = arr[o] - 0.05;
        }
      }
    } else {
      for (let k = 0; k < this.weatherVel.length; k++) {
        const o = k * 3, v = this.weatherVel[k];
        arr[o + 1] -= v * dt * (weather.particles === "sparkle" ? 0.2 : 1);
        arr[o] += (wind * 0.5 + Math.sin(t + k) * 0.3) * dt;
        arr[o + 2] += Math.cos(t * 0.7 + k) * 0.2 * dt;
        if (arr[o + 1] < -0.5) arr[o + 1] = 20;
        if (arr[o] > S) arr[o] -= 2 * S;
      }
    }
    pos.needsUpdate = true;
  }

  dispose(): void {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
    });
    this.group.removeFromParent();
    this.scene.fog = null;
  }
}

export { WEATHERS };
