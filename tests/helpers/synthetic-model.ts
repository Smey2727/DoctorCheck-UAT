// Closed tetrahedron in binary STL format, used only for UAT workflow testing.
// Generated in memory so tests do not depend on external model files.
export function syntheticModel(name: string, size = 10) {
  const vertices = [
    [0, 0, 0],
    [size, 0, 0],
    [0, size, 0],
    [0, 0, size],
  ];
  const triangles = [
    [0, 2, 1],
    [0, 1, 3],
    [0, 3, 2],
    [1, 2, 3],
  ];
  // Binary STL: 80 header bytes, 4 bytes for the count, then 50 bytes per triangle.
  const headerSize = 84;
  const triangleSize = 50;
  const buffer = Buffer.alloc(headerSize + triangles.length * triangleSize);
  buffer.write('SYNTHETIC UAT - NOT FOR CLINICAL USE', 0, 'ascii');
  buffer.writeUInt32LE(triangles.length, 80);
  for (let triangleIndex = 0; triangleIndex < triangles.length; triangleIndex++) {
    const indices = triangles[triangleIndex];
    const a = vertices[indices[0]];
    const b = vertices[indices[1]];
    const c = vertices[indices[2]];

    // Two triangle edges give its outward-facing normal direction.
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const normal = [
      ab[1] * ac[2] - ab[2] * ac[1],
      ab[2] * ac[0] - ab[0] * ac[2],
      ab[0] * ac[1] - ab[1] * ac[0],
    ];
    const length = Math.hypot(...normal);
    const unitNormal = [normal[0] / length, normal[1] / length, normal[2] / length];
    const values = [...unitNormal, ...a, ...b, ...c];
    for (let index = 0; index < values.length; index++) {
      const offset = headerSize + triangleIndex * triangleSize + index * 4;
      buffer.writeFloatLE(values[index], offset);
    }
  }
  return { name, mimeType: 'model/stl', buffer };
}
