// Closed tetrahedron in binary STL format, used only for UAT workflow testing.
// Generated in memory so tests do not depend on external model files.
export function syntheticModel(name: string, size = 10) {
  const vertices = [[0, 0, 0], [size, 0, 0], [0, size, 0], [0, 0, size]];
  const triangles = [[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]];
  const buffer = Buffer.alloc(84 + triangles.length * 50);
  buffer.write('SYNTHETIC UAT - NOT FOR CLINICAL USE', 0, 'ascii');
  buffer.writeUInt32LE(triangles.length, 80);
  triangles.forEach((indices, triangleIndex) => {
    const [a, b, c] = indices.map(index => vertices[index]);
    const ab = b.map((value, axis) => value - a[axis]);
    const ac = c.map((value, axis) => value - a[axis]);
    const normal = [
      ab[1] * ac[2] - ab[2] * ac[1],
      ab[2] * ac[0] - ab[0] * ac[2],
      ab[0] * ac[1] - ab[1] * ac[0],
    ];
    const length = Math.hypot(...normal);
    [...normal.map(value => value / length), ...a, ...b, ...c].forEach((value, index) => {
      buffer.writeFloatLE(value, 84 + triangleIndex * 50 + index * 4);
    });
  });
  return { name, mimeType: 'model/stl', buffer };
}
