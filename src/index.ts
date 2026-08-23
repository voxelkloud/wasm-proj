// The JS side of reprojection.
//
// Two clouds surveyed in different coordinate reference systems do not line up,
// and this is what makes them. The wasm underneath is proj4rs; what is written
// here is the part that decides HOW a cloud gets moved, which is the only
// interesting decision in the task.

import init, {
  initSync,
  Crs,
  transformCoords,
} from "./generated/voxelkloud_wasm_proj.js";
import type {
  BoundingBox,
  CrsDeclaration,
  DecodedPointData,
  OpenPointsOptions,
  PointCloudNode,
  PointNodeRef,
  PointReader,
  ReadPointsOptions,
  Vec3,
} from "@voxelkloud/core";

export { Crs, transformCoords };

/**
 * Where the `.wasm` sits next to this module.
 *
 * A bundler that understands `new URL(..., import.meta.url)` will emit the file
 * and rewrite this to its hashed path.
 */
export const wasmUrl = new URL(
  "./voxelkloud_wasm_proj_bg.wasm",
  import.meta.url,
);

let ready: Promise<void> | undefined;

/**
 * Compile and instantiate the projection engine. Call once before anything else.
 *
 * As with `@voxelkloud/wasm-codecs`, everything here is a view onto one wasm
 * instance, so this is a process-wide switch rather than a handle you hold.
 */
export function initProj(
  source?: BufferSource | WebAssembly.Module | Response | URL | string,
): Promise<void> {
  ready ??= instantiate(source ?? wasmUrl).catch((error: unknown) => {
    ready = undefined;
    throw error;
  });
  return ready;
}

async function instantiate(
  source: BufferSource | WebAssembly.Module | Response | URL | string,
): Promise<void> {
  if (source instanceof WebAssembly.Module || isBufferSource(source)) {
    initSync({ module: source });
    return;
  }
  const bytes = await readFileUrl(source);
  if (bytes !== undefined) {
    initSync({ module: bytes });
    return;
  }
  await init({ module_or_path: source });
}

function isBufferSource(value: unknown): value is BufferSource {
  return value instanceof ArrayBuffer || ArrayBuffer.isView(value);
}

/** Read a `file:` URL through Node; see the same function in wasm-codecs. */
async function readFileUrl(
  source: Response | URL | string,
): Promise<Uint8Array | undefined> {
  if (source instanceof Response) return undefined;
  const href = source instanceof URL ? source.href : source;
  if (!href.startsWith("file:")) return undefined;
  try {
    const specifier = "node:fs/promises";
    const fs = (await import(/* @vite-ignore */ specifier)) as {
      readFile(path: URL): Promise<Uint8Array>;
    };
    return await fs.readFile(new URL(href));
  } catch {
    return undefined;
  }
}

/**
 * Turn a driver's CRS declaration into something you can project through.
 *
 * A WKT is resolved through the EPSG code its horizontal node carries, NOT by
 * parsing the WKT itself: proj4rs reads proj4 strings and EPSG codes, and a
 * full WKT parser is a project of its own for a gain of nothing on any file
 * that names its authority. A custom projection with no authority code is the
 * case this cannot serve, and it throws saying exactly that.
 *
 * @throws {Error} when the declaration names no system this can resolve. The
 *   message carries the declaration, because the fix is usually to pass the
 *   proj4 string by hand.
 */
export function openCrs(declaration: CrsDeclaration): Crs {
  if (declaration.format === "proj4") {
    return Crs.fromProjString(declaration.raw);
  }
  if (declaration.epsg !== undefined) {
    return Crs.fromEpsg(declaration.epsg);
  }
  const what =
    declaration.format === "wkt"
      ? `The WKT names no EPSG authority on its horizontal node`
      : `The declaration was not recognised as a proj4 string, an EPSG code or WKT`;
  throw new Error(
    `Cannot open a projection for ${JSON.stringify(
      declaration.name ?? declaration.raw.slice(0, 120),
    )}. ${what}. Build one with \`Crs.fromProjString(...)\` if you have the ` +
      `proj4 definition.`,
  );
}

/**
 * A rigid-plus-scale placement of one CRS inside another, and what it costs.
 *
 * Reprojection is not affine — two map projections differ by a smooth but
 * curved warp — so no single matrix is exact. Over the extent of one survey it
 * is very nearly exact, and a matrix is the only thing a renderer can apply for
 * free. So: fit the matrix, MEASURE what it leaves behind, and report it.
 *
 * {@link CrsAlignment.residual} is the honest number. Compare it against the
 * cloud's own point spacing: below it, the placement is invisible; above it,
 * reach for {@link reprojectingReader} and pay per point.
 */
export interface CrsAlignment {
  /**
   * Column-major 4x4, ready for `Matrix4.fromArray` or a `mat4` uniform.
   *
   * Maps a coordinate in the source CRS to one in the target CRS.
   */
  readonly matrix: Float64Array;
  /**
   * Worst-case distance, in TARGET units, between where this matrix puts a
   * point and where a true reprojection would.
   *
   * Measured at points the fit NEVER SAW. Measuring at the fitted points
   * instead is the obvious mistake and it is silently catastrophic: least
   * squares drives the error at those points towards zero by construction, so
   * a fit that is kilometres wrong between them can report nanometres. A
   * world-sized extent from WGS84 to Web Mercator does exactly that.
   */
  readonly residual: number;
  /** Mean over the same held-out points, which is what a typical point suffers. */
  readonly meanResidual: number;
  /** How many points the fit used. `checked` is how many verified it. */
  readonly samples: number;
  readonly checked: number;
}

/** A lattice over the box at the given fractions along each axis. */
function lattice(box: BoundingBox, fractions: readonly number[]): number[] {
  const out: number[] = [];
  for (const fx of fractions) {
    for (const fy of fractions) {
      for (const fz of fractions) {
        out.push(
          box.min[0] + fx * (box.max[0] - box.min[0]),
          box.min[1] + fy * (box.max[1] - box.min[1]),
          box.min[2] + fz * (box.max[2] - box.min[2]),
        );
      }
    }
  }
  return out;
}

/**
 * The 27 points the fit is built from: corners, edge and face midpoints, centre.
 *
 * Corners alone would fit a matrix that is exact at the extremes and worst in
 * the middle, which is where the points are.
 */
const FIT_FRACTIONS = [0, 0.5, 1] as const;

/**
 * The 64 points the fit is CHECKED against.
 *
 * Deliberately disjoint from the fit set — eighths, so no point coincides with
 * a half — because a residual measured where the least squares was minimised is
 * not a measurement of anything.
 */
const CHECK_FRACTIONS = [0.125, 0.375, 0.625, 0.875] as const;

/**
 * Fit the affine map that best takes `from` to `to` over `box`.
 *
 * Least squares over the sample set, solved per output axis: each row of the
 * matrix is four unknowns against a 4x4 normal-equation system, which is small
 * enough to solve by elimination and stable enough once the inputs are centred
 * — and they must be centred, because a UTM easting is ~500,000 and squaring it
 * in a normal equation throws away most of a double's mantissa.
 *
 * @throws {Error} when too few sample points survive the transform to determine
 *   a fit, which means the box does not lie inside the source projection's
 *   valid domain.
 */
export function alignCrs(
  from: Crs,
  to: Crs,
  box: BoundingBox,
): CrsAlignment {
  const source = lattice(box, FIT_FRACTIONS);
  const target = Float64Array.from(source);
  const failed = transformCoords(from, to, target);
  const count = source.length / 3;

  // Centre both sides before fitting. The offset goes back into the matrix at
  // the end.
  const keep: number[] = [];
  for (let i = 0; i < count; i++) {
    if (Number.isFinite(target[3 * i]!) && Number.isFinite(target[3 * i + 1]!)) {
      keep.push(i);
    }
  }
  if (keep.length < 4) {
    throw new Error(
      `Cannot align ${from.projection} to ${to.projection}: only ${keep.length} ` +
        `of ${count} sample points over this cloud's extent could be ` +
        `reprojected (${failed} failed). The extent is probably outside the ` +
        `source projection's valid domain.`,
    );
  }

  const centre = (values: ArrayLike<number>, axis: number): number => {
    let sum = 0;
    for (const i of keep) sum += values[3 * i + axis]!;
    return sum / keep.length;
  };
  const sc: Vec3 = [centre(source, 0), centre(source, 1), centre(source, 2)];
  const tc: Vec3 = [centre(target, 0), centre(target, 1), centre(target, 2)];

  // Normal equations: A is 4x4 over [dx, dy, dz, 1], shared by all three
  // output axes; b differs per axis.
  const a = new Float64Array(16);
  const b = [new Float64Array(4), new Float64Array(4), new Float64Array(4)];
  for (const i of keep) {
    const row = [
      source[3 * i]! - sc[0],
      source[3 * i + 1]! - sc[1],
      source[3 * i + 2]! - sc[2],
      1,
    ];
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) a[r * 4 + c] = a[r * 4 + c]! + row[r]! * row[c]!;
      for (let axis = 0; axis < 3; axis++) {
        b[axis]![r] = b[axis]![r]! + row[r]! * (target[3 * i + axis]! - tc[axis]!);
      }
    }
  }

  const coefficients = b.map((rhs) => solve4(a, rhs));

  // Assemble column-major, folding the two centres back in:
  //   out = M * (in - sc) + tc  =>  translation = tc - M * sc
  const m = new Float64Array(16);
  for (let axis = 0; axis < 3; axis++) {
    const k = coefficients[axis]!;
    m[axis] = k[0]!;
    m[4 + axis] = k[1]!;
    m[8 + axis] = k[2]!;
    m[12 + axis] =
      tc[axis]! + k[3]! - (k[0]! * sc[0] + k[1]! * sc[1] + k[2]! * sc[2]);
  }
  m[15] = 1;

  // Hold-out check. These points were not in the fit, so what they measure is
  // how the matrix behaves where the cloud's points actually are rather than
  // how well least squares did its job.
  const check = lattice(box, CHECK_FRACTIONS);
  const truth = Float64Array.from(check);
  transformCoords(from, to, truth);

  let worst = 0;
  let total = 0;
  let checked = 0;
  for (let i = 0; i < check.length / 3; i++) {
    if (!Number.isFinite(truth[3 * i]!) || !Number.isFinite(truth[3 * i + 1]!)) {
      continue;
    }
    const x = check[3 * i]!;
    const y = check[3 * i + 1]!;
    const z = check[3 * i + 2]!;
    const px = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
    const py = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
    const pz = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
    const d = Math.hypot(
      px - truth[3 * i]!,
      py - truth[3 * i + 1]!,
      pz - truth[3 * i + 2]!,
    );
    if (d > worst) worst = d;
    total += d;
    checked++;
  }

  return {
    matrix: m,
    residual: checked === 0 ? Number.POSITIVE_INFINITY : worst,
    meanResidual: checked === 0 ? Number.POSITIVE_INFINITY : total / checked,
    samples: keep.length,
    checked,
  };
}

/** Gaussian elimination with partial pivoting on a 4x4. */
function solve4(a: Float64Array, rhs: Float64Array): Float64Array {
  const m = Float64Array.from(a);
  const v = Float64Array.from(rhs);
  for (let col = 0; col < 4; col++) {
    let pivot = col;
    for (let r = col + 1; r < 4; r++) {
      if (Math.abs(m[r * 4 + col]!) > Math.abs(m[pivot * 4 + col]!)) pivot = r;
    }
    if (Math.abs(m[pivot * 4 + col]!) < 1e-12) {
      // A degenerate axis — every sample sharing one Z, which a flat survey
      // really does — leaves that column undetermined. Zero is the right answer
      // for it: the axis contributes nothing because it never varied.
      continue;
    }
    if (pivot !== col) {
      for (let c = 0; c < 4; c++) {
        const t = m[col * 4 + c]!;
        m[col * 4 + c] = m[pivot * 4 + c]!;
        m[pivot * 4 + c] = t;
      }
      const t = v[col]!;
      v[col] = v[pivot]!;
      v[pivot] = t;
    }
    for (let r = 0; r < 4; r++) {
      if (r === col) continue;
      const factor = m[r * 4 + col]! / m[col * 4 + col]!;
      if (factor === 0) continue;
      for (let c = col; c < 4; c++) m[r * 4 + c] = m[r * 4 + c]! - factor * m[col * 4 + c]!;
      v[r] = v[r]! - factor * v[col]!;
    }
  }
  const out = new Float64Array(4);
  for (let i = 0; i < 4; i++) {
    const d = m[i * 4 + i]!;
    out[i] = Math.abs(d) < 1e-12 ? 0 : v[i]! / d;
  }
  return out;
}

/**
 * Wrap a reader so every node comes back in a different CRS, point by point.
 *
 * The exact path, for when {@link alignCrs}'s residual is too large to accept —
 * a continent-sized extent, or two projections that genuinely disagree about
 * shape. It costs one f64 round trip and one projection per point, which is
 * real: budget it against the decode, not against nothing.
 *
 * The node BOXES are not reprojected, because the tree owns those and this only
 * sees payloads. A caller using this must reproject its tree's bounds too, or
 * culling will be done against boxes in the old CRS.
 */
export function reprojectingReader(
  reader: PointReader,
  options: {
    readonly from: Crs;
    readonly to: Crs;
    /** The origin decoded positions are relative to, in the SOURCE CRS. */
    readonly sourceOrigin: Vec3;
    /** The origin to emit relative to, in the TARGET CRS. */
    readonly targetOrigin: Vec3;
  },
): PointReader {
  const { from, to, sourceOrigin, targetOrigin } = options;
  return {
    hasPayload: (node: PointCloudNode) => reader.hasPayload(node),
    packingFor: (name: string) => reader.packingFor(name),
    dispose: () => {
      reader.dispose();
    },
    async read(
      node: PointNodeRef,
      read?: ReadPointsOptions,
    ): Promise<DecodedPointData> {
      const data = await reader.read(node, read);
      if (data.frame.format !== "float32") {
        throw new Error(
          `reprojectingReader needs float32 positions; this reader emits ` +
            `${data.frame.format}, whose integers are quantised about the ` +
            `source file's own offset and cannot be moved to another CRS ` +
            `without losing that meaning.`,
        );
      }

      const count = data.numPoints;
      const absolute = new Float64Array(3 * count);
      for (let i = 0; i < count; i++) {
        absolute[3 * i] = sourceOrigin[0] + data.positions[3 * i]!;
        absolute[3 * i + 1] = sourceOrigin[1] + data.positions[3 * i + 1]!;
        absolute[3 * i + 2] = sourceOrigin[2] + data.positions[3 * i + 2]!;
      }
      transformCoords(from, to, absolute);

      const positions = new Float32Array(3 * count);
      let lo: [number, number, number] = [Infinity, Infinity, Infinity];
      let hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < count; i++) {
        for (let axis = 0; axis < 3; axis++) {
          const v = absolute[3 * i + axis]!;
          positions[3 * i + axis] = v - targetOrigin[axis]!;
          if (v < lo[axis]!) lo[axis] = v;
          if (v > hi[axis]!) hi[axis] = v;
        }
      }

      const buffers = new Set<ArrayBuffer>(data.transferList);
      buffers.delete(data.positions.buffer as ArrayBuffer);
      buffers.add(positions.buffer);
      const transferList = [...buffers];

      return {
        ...data,
        positions,
        frame: {
          ...data.frame,
          origin: [targetOrigin[0], targetOrigin[1], targetOrigin[2]],
          // The old bound described error in the old CRS. Reprojection changes
          // the magnitudes the float32 has to hold, so it is recomputed rather
          // than carried across, and it is a measurement now: the largest
          // absolute coordinate this node reached, at float32's precision there.
          maxPositionError: float32ErrorAt(
            Math.max(
              ...([0, 1, 2] as const).map((a) =>
                Math.max(
                  Math.abs(lo[a] - targetOrigin[a]),
                  Math.abs(hi[a] - targetOrigin[a]),
                ),
              ),
            ),
          ),
        },
        ...(data.bounds !== undefined && count > 0
          ? { bounds: { min: [...lo] as Vec3, max: [...hi] as Vec3 } }
          : {}),
        transferList,
        byteLength: transferList.reduce((n, b) => n + b.byteLength, 0),
      };
    },
  };
}

/** Half a float32 ULP at this magnitude. */
function float32ErrorAt(reach: number): number {
  if (!(reach > 0)) return 0;
  return 2 ** (Math.floor(Math.log2(reach)) - 23) / 2;
}
