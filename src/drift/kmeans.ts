export interface KMeansResult {
  centroids: Float64Array[];
  assignments: number[];
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function squaredDistance(left: Float64Array, right: Float64Array): number {
  const length = Math.min(left.length, right.length);
  let total = 0;
  for (let index = 0; index < length; index += 1) {
    const difference = left[index] - right[index];
    total += difference * difference;
  }
  return total;
}

export function assign(vector: Float64Array, centroids: Float64Array[]): number {
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < centroids.length; index += 1) {
    const distance = squaredDistance(vector, centroids[index]);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  }
  return best;
}

export function kmeans(
  vectors: Float64Array[],
  requestedClusters: number,
  seed = 42,
  maxIterations = 25,
): KMeansResult {
  if (vectors.length === 0) return { centroids: [], assignments: [] };
  const clusters = Math.max(1, Math.min(requestedClusters, vectors.length));
  const random = mulberry32(seed);
  const centroids: Float64Array[] = [vectors[Math.floor(random() * vectors.length)].slice()];

  while (centroids.length < clusters) {
    const distances = vectors.map((vector) => {
      let minimum = Number.POSITIVE_INFINITY;
      for (const centroid of centroids) minimum = Math.min(minimum, squaredDistance(vector, centroid));
      return minimum;
    });
    const total = distances.reduce((sum, distance) => sum + distance, 0);
    let chosen = 0;
    if (total <= 0) {
      chosen = (centroids.length * 7 + 3) % vectors.length;
    } else {
      let target = random() * total;
      for (let index = 0; index < distances.length; index += 1) {
        target -= distances[index];
        if (target <= 0) {
          chosen = index;
          break;
        }
      }
    }
    centroids.push(vectors[chosen].slice());
  }

  let previous: number[] = [];
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const assignments = vectors.map((vector) => assign(vector, centroids));
    const unchanged =
      previous.length === assignments.length &&
      assignments.every((value, index) => value === previous[index]);
    if (unchanged) break;
    previous = assignments;
    const sums = centroids.map(() => new Float64Array(vectors[0].length));
    const counts = new Array<number>(centroids.length).fill(0);
    for (let index = 0; index < vectors.length; index += 1) {
      const cluster = assignments[index];
      counts[cluster] += 1;
      const sum = sums[cluster];
      for (let dimension = 0; dimension < sum.length; dimension += 1) {
        sum[dimension] += vectors[index][dimension];
      }
    }
    for (let cluster = 0; cluster < centroids.length; cluster += 1) {
      if (counts[cluster] === 0) continue;
      for (let dimension = 0; dimension < centroids[cluster].length; dimension += 1) {
        centroids[cluster][dimension] = sums[cluster][dimension] / counts[cluster];
      }
    }
  }
  const assignments = vectors.map((vector) => assign(vector, centroids));
  return { centroids, assignments };
}
