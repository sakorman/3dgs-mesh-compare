/** Count distinct backing stores, not overlapping typed-array views. No heap traversal. */
export function bufferOwnership(views: ArrayBufferView[]) {
  const buffers = new Set(views.map(view => view.buffer));
  return {
    views: views.length,
    viewBytes: views.reduce((sum, view) => sum + view.byteLength, 0),
    buffers: buffers.size,
    backingBytes: [...buffers].reduce((sum, buffer) => sum + buffer.byteLength, 0),
  };
}
