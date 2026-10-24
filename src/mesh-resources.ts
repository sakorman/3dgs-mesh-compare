import * as THREE from "three";

/** Release a GLTF root's exclusively owned resources, including decoded bitmaps.
 * The loader may share materials, textures and image sources inside the root.
 * Do not use this on resources shared with a different, still-active scene.
 */
export function disposeMeshResources(root: THREE.Object3D) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  const bitmaps = new Set<ImageBitmap>();

  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    geometries.add(object.geometry);
    for (const material of Array.isArray(object.material)
      ? object.material
      : [object.material]) {
      materials.add(material);
    }
  });

  for (const material of materials) {
    // GLTF material texture slots are direct properties (map, normalMap, etc.).
    for (const value of Object.values(material)) {
      if (value instanceof THREE.Texture) textures.add(value);
    }
  }
  for (const texture of textures) {
    const images = Array.isArray(texture.source.data)
      ? texture.source.data
      : [texture.source.data];
    for (const image of images) {
      if (typeof ImageBitmap !== "undefined" && image instanceof ImageBitmap) {
        bitmaps.add(image);
      }
    }
  }

  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  for (const texture of textures) texture.dispose();
  // Texture.dispose() releases GPU state, not its CPU-side ImageBitmap source.
  for (const bitmap of bitmaps) bitmap.close();

  return {
    geometries: geometries.size,
    materials: materials.size,
    textures: textures.size,
    bitmaps: bitmaps.size,
  };
}
