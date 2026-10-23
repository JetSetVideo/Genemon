/**
 * Pass-4 CONTRACT for the anatomy builders (types only). `body.ts`/`limbs.ts`/`wings.ts`/`loft.ts`
 * (lane body) and `face.ts`/`skin.ts` (lane face) produce these; `src/render/creature.ts` (orchestrator)
 * attaches them to the skeleton joint objects (one Object3D per joint, same order as Skeleton.joints).
 *
 * Frame convention (src/body/skeleton.ts): creature space, +Z forward, +Y up, side +1 = +X. Every mesh
 * returned for joint i is expressed in THAT JOINT's local frame (origin at the joint, bone along j.dir).
 */
import type * as THREE from "../../lib/three.ts";

/** The materials one creature shares (made by skin.ts makeSkinMaterials). */
export interface SkinMaterials {
  skin: THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial;
  accent: THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial;
  belly: THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial;
  /** Claws, teeth, horn tips: bone / keratin. */
  keratin: THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial;
  /** Wing membrane (double-sided, may be translucent). */
  membrane: THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial;
  /** Textures to dispose with the creature. */
  textures: THREE.Texture[];
  /** Base emissive intensity (charge glow adds on top). */
  baseEmissive: number;
}

/** Meshes to attach, keyed by joint index. */
export type JointMeshes = Map<number, THREE.Object3D[]>;

export interface BodyParts {
  perJoint: JointMeshes;
  /** Wing surfaces (for flap-driven deformation if the builder supports it). */
  wings: THREE.Mesh[];
  /** Triangle count of everything built (measured, for the QA snapshot). */
  triangles: number;
  /** Pass 6: extra materials the builder created (the maw's throat), to dispose with the creature. */
  materials?: THREE.Material[];
}

export interface FaceParts {
  /** Meshes for the head joint and the jaw joint (jaw may be absent on blobs). */
  head: THREE.Object3D[];
  jaw: THREE.Object3D[];
  /** Pupil objects (scaled by emotion: fear widens, anger narrows). */
  pupils: THREE.Object3D[];
  /** Eyelid objects (rotation.x closes them; used for blinks). */
  lids: THREE.Object3D[];
  /** Materials created for the eyes (disposed with the creature; emissive pulsed on charge). */
  eyeMaterials: THREE.Material[];
  /** Points in HEAD-joint space where eye auras (smoke, flame, spark...) are emitted. */
  auraEmitters: THREE.Vector3[];
  /** Mouth centre in HEAD-joint space and its forward direction: where breath cones start. */
  mouth: { origin: THREE.Vector3; dir: THREE.Vector3; width: number };
}

/** A hit volume in joint space (better hitboxes than one cylinder per body). */
export interface HitSphere {
  joint: number;
  offset: [number, number, number];
  r: number;
}
