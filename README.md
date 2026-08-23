# @voxelkloud/wasm-proj

Coordinate reprojection for [voxelkloud](../../README.md), compiled to wasm from
[proj4rs](https://github.com/3liz/proj4rs). 940,821 bytes, 213,933 gzipped.

```sh
npm install @voxelkloud/wasm-proj
```

Opt-in and lazily loaded: nothing pulls this in until a cloud has to be placed
against another one. The bulk of it is the EPSG parameter table, which is not
optional — files declare codes and WKT, never proj4 strings.

## The problem

Two point clouds surveyed in different coordinate reference systems do not line
up, and no care in the loader fixes it: the numbers in the two files mean
different things. An Arizona survey in NAD83 / UTM zone 12N and a Rotterdam one
in Amersfoort / RD New are both "around 155,000 east", 8,000 km apart.

```ts
import { alignCrs, initProj, openCrs } from "@voxelkloud/wasm-proj";

await initProj();

const from = openCrs(second.crs!);   // whatever the driver read out of the file
const to = openCrs(first.crs!);
const fit = alignCrs(from, to, second.tightBoundingBox);

object.matrix.fromArray(fit.matrix);  // now they line up
```

## The interesting decision

**Reprojection is not affine.** Two map projections differ by a smooth but
curved warp, so no single matrix is exact — and a matrix is the only thing a
renderer can apply for free. The alternative, projecting every point, costs a
transform per point on a path that is already the bottleneck.

So `alignCrs` fits the matrix and **measures what it leaves behind**:

```ts
fit.residual;      // worst case over the extent, in target units
fit.meanResidual;  // what a typical point suffers
```

Across two adjacent UTM zones over a 3 km tile that is about **14 mm** — 5e-6 of
the extent, far below any LiDAR point spacing, and not zero. Compare it against
the cloud's own spacing: below, the placement is invisible; above, reach for
`reprojectingReader` and pay per point.

The residual is measured at points the fit **never saw** — a 4×4×4 lattice at
eighths, against a 3×3×3 fit at halves. Measuring at the fitted points instead
is the obvious mistake and it is silently catastrophic: least squares drives the
error there towards zero by construction, so a fit that is kilometres wrong
between them reports nanometres. A world-sized WGS84-to-Web-Mercator extent does
exactly that, and it is in the test suite because it caught this.

## What it does not do

**Datum grid shifts.** proj4rs supports NADCON and NTv2 grids, but they are
files, they are large, and fetching them is a transport decision this package
has no business making. Without them a datum transformation falls back to the
7-parameter Helmert the CRS declares — which is what proj4js does too, and which
is accurate to about a metre where a grid would give centimetres. Nothing here
can detect the difference, so a caller who needs survey-grade datum shifts
should know this is not it.

**Vertical datums.** Z is carried through the projection and never shifted. A
height above NAVD88 is not a height above NAP, and nothing in a horizontal CRS
declaration says how to convert between them — which is why
[`CrsDeclaration`](../core/) keeps `verticalEpsg` separate rather than folding it
into a compound code that would quietly stand in for a horizontal one.

**WKT parsing.** proj4rs reads proj4 strings and EPSG codes. A WKT is resolved
through the authority its horizontal node carries, which every real file names —
and which is *not* the last authority in the string. A compound WKT ends with
the code of the compound system, and projecting through that resolves to
nothing. `wktHorizontalEpsg` in `@voxelkloud/core` is the bracket-matching that
gets it right. A genuinely custom projection with no authority is the case this
cannot serve, and it says so.

## Angular units

Everything crossing this boundary is in **degrees**. proj4rs is radian-native;
the conversion happens at the wasm edge so no caller has to remember, which is
also what proj4js does.

## Building from source

Needs cargo, `rustup target add wasm32-unknown-unknown`, and
`cargo install wasm-bindgen-cli --version 0.2.127`.

MIT. See [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md).
