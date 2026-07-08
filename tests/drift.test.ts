import assert from "node:assert/strict";
import test from "node:test";
import { loadPolicy } from "../src/config";
import { DriftDetector } from "../src/drift/detector";
import { cosine, embed } from "../src/drift/embed";
import { assign, kmeans } from "../src/drift/kmeans";
import { psiFromCounts } from "../src/drift/psi";
import { SQLiteStore } from "../src/storage/sqliteStore";
import { createClock, makeSpan, tempDb } from "./helpers";

test("hashed embeddings are deterministic and cosine ranks related prompts higher", () => {
  const refund = embed("refund policy billing invoice charge");
  assert.deepEqual([...embed("refund policy billing invoice charge")], [...refund]);
  const shipping = embed("shipping delivery tracking parcel");
  const unrelated = embed("kubernetes deployment cluster pod helm");
  assert.ok(cosine(refund, shipping) > cosine(refund, unrelated));
  assert.ok(cosine(refund, refund) > 0.999);
});

test("k-means separates two groups deterministically", () => {
  const left = Array.from({ length: 12 }, (_, index) => {
    const vector = new Float64Array(8);
    vector[0] = 1 + index * 0.01;
    vector[1] = index * 0.01;
    return vector;
  });
  const right = Array.from({ length: 12 }, (_, index) => {
    const vector = new Float64Array(8);
    vector[6] = 1 + index * 0.01;
    vector[7] = index * 0.01;
    return vector;
  });
  const vectors = [...left, ...right];
  const first = kmeans(vectors, 2, 7);
  const second = kmeans(vectors, 2, 7);
  assert.deepEqual(first.assignments, second.assignments);
  assert.equal(new Set(first.assignments).size, 2);
  assert.equal(first.centroids.length, 2);
  assert.equal(assign(left[0], first.centroids), assign(left[11], first.centroids));
  assert.notEqual(assign(left[0], first.centroids), assign(right[0], first.centroids));
});

test("PSI is zero for identical distributions and large for a shift", () => {
  const identical = psiFromCounts([30, 30, 30], [30, 30, 30]);
  assert.ok(identical.psi < 1e-9);
  const shifted = psiFromCounts([90, 5, 5], [5, 5, 90]);
  assert.ok(shifted.psi > 0.2, `psi ${shifted.psi}`);
  assert.ok(shifted.kl > 0);
  const empty = psiFromCounts([], []);
  assert.equal(empty.psi, 0);
});

test("drift detector isolates per-app shifts and records insufficient data", async () => {
  const { db, cleanup } = tempDb();
  try {
    const store = new SQLiteStore(db);
    const now = createClock().nowUs();
    const currentStart = now - 7 * 86_400_000_000;
    const baselineStart = currentStart - 28 * 86_400_000_000;
    const baselineTopics = [
      "refund policy billing invoice charge",
      "reset password sign in account",
      "shipping delivery tracking parcel",
    ];
    const newTopic = "kubernetes deployment cluster pod helm manifest";
    let sequence = 0;
    const add = (appId: string, topic: string, startUs: number) => {
      sequence += 1;
      store.insertSpans([
        makeSpan({
          traceId: sequence.toString(16).padStart(32, "0"),
          spanId: sequence.toString(16).padStart(16, "0"),
          appId,
          promptText: topic,
          completionText: "An answer.",
          startUs,
          ingestedAtUs: now,
        }),
      ]);
    };
    for (let index = 0; index < 90; index += 1) {
      const topic = baselineTopics[index % baselineTopics.length];
      add("stable-app", topic, baselineStart + index * 1_000_000);
      add("drift-app", topic, baselineStart + index * 1_000_000);
    }
    for (let index = 0; index < 90; index += 1) {
      add(
        "stable-app",
        baselineTopics[index % baselineTopics.length],
        currentStart + index * 1_000_000,
      );
      add("drift-app", newTopic, currentStart + index * 1_000_000);
    }
    for (let index = 0; index < 5; index += 1) {
      add("insufficient-app", newTopic, currentStart + index * 1_000_000);
    }

    const policy = loadPolicy().drift;
    const detector = new DriftDetector({ store, policy, nowUs: () => now });
    const runs = await detector.run({ nowUs: now });
    assert.ok(runs.length >= 4);
    const stable = runs.find((run) => run.appId === "stable-app");
    const drift = runs.find((run) => run.appId === "drift-app");
    const insufficient = runs.find((run) => run.appId === "insufficient-app");
    const all = runs.find((run) => run.appId === "__all__");
    assert.ok(stable && drift && insufficient && all);
    assert.ok(stable.psi < 0.2, `stable psi ${stable.psi}`);
    assert.equal(stable.alert, false);
    assert.ok(drift.psi > 0.2, `drift psi ${drift.psi}`);
    assert.equal(drift.alert, true);
    assert.equal(drift.status, "alert");
    assert.equal(insufficient.status, "insufficient_data");
    assert.equal(insufficient.alert, false);
    assert.ok(all.nCurrent > 0);
    assert.ok(JSON.parse(drift.detailJson).clusterProps.length > 0);

    const byApp = store.latestDriftByApp();
    assert.ok(byApp.some((run) => run.appId === "drift-app"));
    const before = store.latestDriftRuns(100).length;
    await detector.run({ nowUs: now });
    assert.equal(store.latestDriftRuns(100).length, before);

    const onlyDrift = await detector.run({ nowUs: now, appId: "drift-app" });
    assert.equal(onlyDrift.length, 1);
    assert.equal(onlyDrift[0].appId, "drift-app");
  } finally {
    cleanup();
  }
});
