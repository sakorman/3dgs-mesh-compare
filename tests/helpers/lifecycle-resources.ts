import * as THREE from "three";

type ExtendedAttributes = {
  extArrays: readonly Uint32Array[];
  extra: Record<string, unknown>;
  textures: readonly THREE.Texture[];
};
export type GaussianResource = THREE.Object3D & {extSplats?: ExtendedAttributes};

export function attributeStorage(ext?: ExtendedAttributes) {
  const views = ext ? [...ext.extArrays, ...["sh1", "sh2", "sh3a", "sh3b"].map(key => ext.extra[key])]
    .filter((value): value is Uint32Array => value instanceof Uint32Array) : [];
  const buffers = new Set(views.map(view => view.buffer));
  return {
    viewBytes: views.reduce((sum, view) => sum + view.byteLength, 0),
    backingBufferBytes: [...buffers].reduce((sum, buffer) => sum + buffer.byteLength, 0),
    backingBuffers: buffers.size,
  };
}

function observeDisposals<T extends THREE.BufferGeometry | THREE.Material | THREE.Texture>(resources: Set<T>) {
  const counts = [...resources].map(resource => {
    const count = {value: 0};
    resource.addEventListener("dispose", () => count.value++);
    return count;
  });
  return () => counts.map(count => count.value);
}

/** Keep old objects so clearing the viewer's current pointers cannot pass the check. */
export function retainModelResources(gaussian: GaussianResource, mesh: THREE.Object3D) {
  const ext = gaussian.extSplats;
  if (!ext) throw new Error("Expected initialized extended attributes");
  const gaussianTextures = new Set(ext.textures.filter(texture => texture.source.data != null));
  for (const value of Object.values(ext.extra)) {
    const texture = (value as {value?: unknown} | undefined)?.value;
    if (texture instanceof THREE.Texture && texture.source.data != null) gaussianTextures.add(texture);
  }
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  const bitmaps = new Set<ImageBitmap>();
  mesh.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
  });
  for (const material of materials) for (const value of Object.values(material)) {
    if (value instanceof THREE.Texture) textures.add(value);
  }
  for (const texture of textures) {
    const images = Array.isArray(texture.source.data) ? texture.source.data : [texture.source.data];
    for (const image of images) if (typeof ImageBitmap !== "undefined" && image instanceof ImageBitmap) bitmaps.add(image);
  }
  const gaussianDisposals = observeDisposals(gaussianTextures);
  const geometryDisposals = observeDisposals(geometries);
  const materialDisposals = observeDisposals(materials);
  const textureDisposals = observeDisposals(textures);
  const initial = {
    attributes: attributeStorage(ext), gaussianTextures: gaussianTextures.size,
    meshGeometries: geometries.size, meshMaterials: materials.size,
    meshTextures: textures.size, meshBitmaps: bitmaps.size,
  };
  return {
    initial,
    inspect() {
      const state = {
        attributes: attributeStorage(ext),
        gaussianDetachedAttributes: gaussian.extSplats === undefined,
        gaussianTextureSourcesWithData: [...gaussianTextures].filter(texture => texture.source.data != null).length,
        gaussianTextureDisposals: gaussianDisposals(),
        meshGeometryDisposals: geometryDisposals(), meshMaterialDisposals: materialDisposals(),
        meshTextureDisposals: textureDisposals(),
        openBitmaps: [...bitmaps].filter(image => image.width > 0 || image.height > 0).length,
        gaussianRemovedFromScene: gaussian.parent === null, meshRemovedFromScene: mesh.parent === null,
      };
      return {
        passed: initial.attributes.viewBytes > 0 && initial.gaussianTextures > 0 && initial.meshBitmaps > 0 &&
          state.attributes.viewBytes === 0 && state.attributes.backingBufferBytes === 0 && state.gaussianDetachedAttributes &&
          state.gaussianTextureSourcesWithData === 0 && state.openBitmaps === 0 &&
          state.gaussianRemovedFromScene && state.meshRemovedFromScene &&
          [state.gaussianTextureDisposals, state.meshGeometryDisposals, state.meshMaterialDisposals, state.meshTextureDisposals]
            .every(counts => counts.length > 0 && counts.every(count => count === 1)),
        initial, ...state,
      };
    },
  };
}
