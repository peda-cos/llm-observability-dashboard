export function embed(text: string, dimensions = 128): Float64Array {
  const vector = new Float64Array(dimensions);
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1);
  const features = new Map<string, number>();
  for (let index = 0; index < tokens.length; index += 1) {
    features.set(tokens[index], (features.get(tokens[index]) ?? 0) + 1);
    if (index + 1 < tokens.length) {
      const bigram = `${tokens[index]} ${tokens[index + 1]}`;
      features.set(bigram, (features.get(bigram) ?? 0) + 1);
    }
  }
  for (const [feature, count] of features.entries()) {
    const hash = fnv1a(feature);
    const index = hash % dimensions;
    const sign = (hash & 0x8000_0000) === 0 ? 1 : -1;
    vector[index] += sign * (1 + Math.log(count));
  }
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let index = 0; index < vector.length; index += 1) vector[index] /= norm;
  }
  return vector;
}

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function cosine(left: Float64Array, right: Float64Array): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  const denominator = Math.sqrt(leftNorm) * Math.sqrt(rightNorm);
  return denominator === 0 ? 0 : dot / denominator;
}
