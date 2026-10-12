/**
 * A small, dependency-free multilayer perceptron for Genemon's learned models: the match outcome
 * predictor today, the battle policy (and its neuroevolution) next. Pure: no DOM, no renderer.
 *
 *   - Plain backprop + mini-batch SGD (optional L2 weight decay), nothing hidden.
 *   - Init: Xavier/Glorot uniform drawn from an Rng, so the same seed always gives the same network
 *     (He-uniform for layers that feed a ReLU, the Xavier variant derived for that activation).
 *   - Losses: binary cross-entropy for a sigmoid output, MSE for a linear output. Both are MEANS over
 *     outputs and samples, so a learning rate transfers between models of different widths.
 *   - toJSON()/fromJSON() round-trip exactly (doubles survive JSON), so a trained model can be stored
 *     next to the ledger export it was trained on.
 * Doc: docs/AI-AND-DATA.md (outcome predictor, planned policy network).
 */
import { clamp, clamp01, sigmoid } from "../core/math.ts";
import { Rng } from "../core/rng.ts";

export type HiddenActivation = "tanh" | "relu";
export type OutputActivation = "linear" | "sigmoid";

export interface Sample {
  x: readonly number[];
  y: readonly number[];
}

export interface FitOptions {
  epochs: number;
  lr: number;
  batchSize: number;
  /** Shuffles the sample order every epoch (house rule: no Math.random). */
  rng: Rng;
  /** L2 weight decay (biases are not decayed). Default 0. */
  l2?: number;
}

export interface MLPJSON {
  kind: "genemon.mlp";
  version: 1;
  layers: number[];
  hidden: HiddenActivation;
  output: OutputActivation;
  /** [layer][out][in] */
  weights: number[][][];
  /** [layer][out] */
  biases: number[][];
}

export class MLP {
  readonly layers: readonly number[];
  readonly hidden: HiddenActivation;
  readonly output: OutputActivation;
  /** Per layer, row-major out x in. */
  #W: Float64Array[] = [];
  #b: Float64Array[] = [];

  constructor(
    layers: readonly number[],
    rng: Rng,
    hidden: HiddenActivation = "tanh",
    output: OutputActivation = "sigmoid",
  ) {
    if (layers.length < 2 || layers.some((n) => !Number.isInteger(n) || n < 1)) {
      throw new Error(`MLP: layers must be >= 2 positive integers, got [${layers.join(", ")}]`);
    }
    this.layers = [...layers];
    this.hidden = hidden;
    this.output = output;
    for (let l = 0; l + 1 < layers.length; l++) {
      const nIn = layers[l], nOut = layers[l + 1];
      const feedsRelu = hidden === "relu" && l + 2 < layers.length;
      const a = feedsRelu ? Math.sqrt(6 / nIn) : Math.sqrt(6 / (nIn + nOut));
      const W = new Float64Array(nIn * nOut);
      for (let i = 0; i < W.length; i++) W[i] = rng.range(-a, a);
      this.#W.push(W);
      this.#b.push(new Float64Array(nOut));
    }
  }

  /** Number of trainable parameters (weights + biases). */
  get paramCount(): number {
    let s = 0;
    for (let l = 0; l < this.#W.length; l++) s += this.#W[l].length + this.#b[l].length;
    return s;
  }

  forward(x: readonly number[]): number[] {
    const acts = this.#activations(x);
    return Array.from(acts[acts.length - 1]);
  }

  /** Mean loss over `data` without training (validation curves, model comparison). */
  loss(data: readonly Sample[]): number {
    if (data.length === 0) return NaN;
    let s = 0;
    for (const d of data) {
      this.#checkTarget(d.y);
      const acts = this.#activations(d.x);
      s += this.#sampleLoss(acts[acts.length - 1], d.y);
    }
    return s / data.length;
  }

  /**
   * One SGD step on the batch-averaged gradient. Returns the batch's mean loss measured BEFORE the
   * update (so a training curve built from it slightly lags the weights, as usual).
   */
  trainBatch(batch: readonly Sample[], lr: number, l2 = 0): number {
    if (batch.length === 0) throw new Error("MLP.trainBatch: empty batch");
    const L = this.#W.length;
    const gW = this.#W.map((w) => new Float64Array(w.length));
    const gb = this.#b.map((b) => new Float64Array(b.length));
    const outScale = this.output === "sigmoid" ? 1 : 2;
    let loss = 0;
    for (const s of batch) {
      this.#checkTarget(s.y);
      const acts = this.#activations(s.x);
      const out = acts[L];
      loss += this.#sampleLoss(out, s.y);
      // dLoss/dz at the output: (p - y) for sigmoid + BCE, 2 (p - y) for linear + MSE; / nOut (mean).
      let delta = new Float64Array(out.length);
      for (let k = 0; k < out.length; k++) delta[k] = (outScale * (out[k] - s.y[k])) / out.length;
      for (let l = L - 1; l >= 0; l--) {
        const nIn = this.layers[l], nOut = this.layers[l + 1];
        const aIn = acts[l], W = this.#W[l], gWl = gW[l], gbl = gb[l];
        for (let o = 0; o < nOut; o++) {
          const dO = delta[o];
          if (dO === 0) continue;
          gbl[o] += dO;
          const row = o * nIn;
          for (let i = 0; i < nIn; i++) gWl[row + i] += dO * aIn[i];
        }
        if (l === 0) break;
        const prev = new Float64Array(nIn);
        for (let i = 0; i < nIn; i++) {
          let g = 0;
          for (let o = 0; o < nOut; o++) g += W[o * nIn + i] * delta[o];
          const a = aIn[i];
          prev[i] = g * (this.hidden === "tanh" ? 1 - a * a : a > 0 ? 1 : 0);
        }
        delta = prev;
      }
    }
    const m = batch.length;
    for (let l = 0; l < L; l++) {
      const W = this.#W[l], b = this.#b[l], gWl = gW[l], gbl = gb[l];
      for (let i = 0; i < W.length; i++) W[i] -= lr * (gWl[i] / m + l2 * W[i]);
      for (let o = 0; o < b.length; o++) b[o] -= lr * (gbl[o] / m);
    }
    return loss / m;
  }

  /** Mini-batch SGD over `epochs`; returns the mean training loss of each epoch (the loss curve). */
  fit(data: readonly Sample[], opts: FitOptions): number[] {
    if (data.length === 0) return [];
    const n = data.length;
    const bs = clamp(Math.floor(opts.batchSize), 1, n);
    const order = Array.from({ length: n }, (_, i) => i);
    const curve: number[] = [];
    for (let e = 0; e < Math.floor(opts.epochs); e++) {
      const shuffled = opts.rng.shuffle(order);
      let total = 0;
      for (let start = 0; start < n; start += bs) {
        const batch = shuffled.slice(start, start + bs).map((i) => data[i]);
        total += this.trainBatch(batch, opts.lr, opts.l2 ?? 0) * batch.length;
      }
      curve.push(total / n);
    }
    return curve;
  }

  toJSON(): MLPJSON {
    const weights: number[][][] = [];
    const biases: number[][] = [];
    for (let l = 0; l < this.#W.length; l++) {
      const nIn = this.layers[l], nOut = this.layers[l + 1];
      const rows: number[][] = [];
      for (let o = 0; o < nOut; o++) rows.push(Array.from(this.#W[l].subarray(o * nIn, (o + 1) * nIn)));
      weights.push(rows);
      biases.push(Array.from(this.#b[l]));
    }
    return {
      kind: "genemon.mlp",
      version: 1,
      layers: [...this.layers],
      hidden: this.hidden,
      output: this.output,
      weights,
      biases,
    };
  }

  static fromJSON(j: MLPJSON): MLP {
    // The init draws are overwritten below; the fixed seed only keeps construction deterministic.
    const net = new MLP(j.layers, new Rng(0), j.hidden, j.output);
    if (j.weights.length !== net.#W.length || j.biases.length !== net.#b.length) {
      throw new Error("MLP.fromJSON: layer count does not match the weights");
    }
    for (let l = 0; l < net.#W.length; l++) {
      const nIn = j.layers[l], nOut = j.layers[l + 1];
      if (j.weights[l].length !== nOut || j.biases[l].length !== nOut) {
        throw new Error(`MLP.fromJSON: layer ${l} expected ${nOut} output rows`);
      }
      for (let o = 0; o < nOut; o++) {
        const row = j.weights[l][o];
        if (row.length !== nIn) throw new Error(`MLP.fromJSON: layer ${l} row ${o} expected ${nIn} inputs`);
        for (let i = 0; i < nIn; i++) net.#W[l][o * nIn + i] = row[i];
        net.#b[l][o] = j.biases[l][o];
      }
    }
    return net;
  }

  #checkTarget(y: readonly number[]): void {
    const nOut = this.layers[this.layers.length - 1];
    if (y.length !== nOut) throw new Error(`MLP: expected ${nOut} targets, got ${y.length}`);
  }

  #activations(x: readonly number[]): Float64Array[] {
    if (x.length !== this.layers[0]) {
      throw new Error(`MLP: expected ${this.layers[0]} inputs, got ${x.length}`);
    }
    const acts: Float64Array[] = [Float64Array.from(x)];
    const L = this.#W.length;
    for (let l = 0; l < L; l++) {
      const nIn = this.layers[l], nOut = this.layers[l + 1];
      const W = this.#W[l], b = this.#b[l], a = acts[l];
      const z = new Float64Array(nOut);
      const last = l === L - 1;
      for (let o = 0; o < nOut; o++) {
        let s = b[o];
        const row = o * nIn;
        for (let i = 0; i < nIn; i++) s += W[row + i] * a[i];
        if (last) z[o] = this.output === "sigmoid" ? sigmoid(s) : s;
        else z[o] = this.hidden === "tanh" ? Math.tanh(s) : s > 0 ? s : 0;
      }
      acts.push(z);
    }
    return acts;
  }

  #sampleLoss(p: Float64Array, y: readonly number[]): number {
    let s = 0;
    for (let k = 0; k < p.length; k++) {
      if (this.output === "sigmoid") {
        const q = clamp(p[k], 1e-12, 1 - 1e-12);
        s -= y[k] * Math.log(q) + (1 - y[k]) * Math.log(1 - q);
      } else {
        s += (p[k] - y[k]) * (p[k] - y[k]);
      }
    }
    return s / p.length;
  }
}

export interface OutcomeRow {
  /** Context features from side A's perspective (see Ladder / matchDataset). */
  features: readonly number[];
  /** 1 = side A won, 0 = lost, 0.5 = draw (a soft label under cross-entropy). */
  win: number;
}

export interface OutcomeModelOptions {
  hidden?: number;
  epochs?: number;
  lr?: number;
  batchSize?: number;
  l2?: number;
}

/**
 * Train a match-outcome predictor P(A wins | features): a [d, hidden, 1] tanh/sigmoid MLP fitted
 * by cross-entropy. Init and shuffling use independent forks of `rng`, so the model depends only
 * on the seed and the rows. Unlike the ladder's linear context model it can learn interactions
 * (type advantage that only matters in a given weather), which is why it is the benchmark the
 * ladder's own expectation is compared against on the Data screen.
 */
export function predictOutcomeModel(
  rows: readonly OutcomeRow[],
  rng: Rng,
  opts: OutcomeModelOptions = {},
): MLP {
  if (rows.length === 0) throw new Error("predictOutcomeModel: no rows");
  const d = rows[0].features.length;
  if (d === 0) throw new Error("predictOutcomeModel: rows have no features");
  const net = new MLP([d, opts.hidden ?? 8, 1], rng.fork("outcome.init"), "tanh", "sigmoid");
  const data: Sample[] = rows.map((r) => {
    if (r.features.length !== d) {
      throw new Error(`predictOutcomeModel: expected ${d} features, got ${r.features.length}`);
    }
    return { x: r.features, y: [clamp01(r.win)] };
  });
  net.fit(data, {
    epochs: opts.epochs ?? 200,
    lr: opts.lr ?? 0.1,
    batchSize: opts.batchSize ?? 32,
    rng: rng.fork("outcome.fit"),
    l2: opts.l2 ?? 1e-4,
  });
  return net;
}
