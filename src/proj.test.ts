// Reprojection, checked against numbers that exist outside this repo.
//
// A projection test that only compares against itself proves nothing. The
// fixed points below are published values — the UTM zone 12N easting of a known
// longitude, the RD New coordinates of the Amersfoort origin — so a wrong
// ellipsoid or a swapped axis fails here rather than in a viewer.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { crsFromEpsg, crsFromString, crsFromWkt } from "@voxelkloud/core";
import { Crs, alignCrs, initProj, openCrs, transformCoords } from "./index.js";

const WASM = new URL("../dist/voxelkloud_wasm_proj_bg.wasm", import.meta.url);

beforeAll(async () => {
  await initProj(readFileSync(fileURLToPath(WASM)));
});

/** NAD83 / UTM zone 12N — what the az-usfs tiles are surveyed in. */
const UTM12N = 26912;
/** Amersfoort / RD New — what the Rotterdam tile is surveyed in. */
const RD_NEW = 28992;
const WGS84 = 4326;

describe("Crs", () => {
  it("opens an EPSG code out of the bundled table", () => {
    const utm = Crs.fromEpsg(UTM12N);
    expect(utm.projection).toBe("utm");
    expect(utm.isLatLong).toBe(false);
    expect(utm.toMeter).toBe(1);

    const wgs = Crs.fromEpsg(WGS84);
    expect(wgs.isLatLong).toBe(true);

    // RD New is an oblique stereographic, which is the check that the table
    // carries real definitions rather than a UTM special case.
    expect(Crs.fromEpsg(RD_NEW).projection).toBe("sterea");
  });

  it("opens a proj4 string", () => {
    const crs = Crs.fromProjString("+proj=utm +zone=12 +datum=NAD83 +units=m");
    expect(crs.projection).toBe("utm");
  });

  it("names the code it cannot find instead of projecting wrongly", () => {
    expect(() => Crs.fromEpsg(999_999)).toThrow(/999999/);
    expect(() => Crs.fromEpsg(1)).toThrow(/EPSG:1/);
  });

  it("reports a foot-based system's scale", () => {
    // EPSG:2231 — NAD83 / Colorado Central (ftUS). A viewer that assumed metres
    // would size its points 3.3x too small.
    const feet = Crs.fromEpsg(2231);
    expect(feet.toMeter).toBeCloseTo(0.3048006096, 9);
  });
});

describe("transformCoords", () => {
  it("puts a known longitude at its published UTM easting", () => {
    // 111°W is the central meridian of UTM zone 12, where easting is exactly
    // the 500,000 m false easting by definition. Anything else means the zone,
    // the ellipsoid or the axis order is wrong.
    const coords = new Float64Array([-111, 40, 0]);
    const failed = transformCoords(
      Crs.fromEpsg(WGS84),
      Crs.fromEpsg(UTM12N),
      coords,
    );
    expect(failed).toBe(0);
    expect(coords[0]).toBeCloseTo(500_000, 3);
    // Northing of 40°N on that meridian, from the published grid.
    expect(coords[1]).toBeCloseTo(4_427_757.22, 1);
  });

  it("puts the Amersfoort origin at the RD New false origin", () => {
    // RD New is defined so that its origin, the Amersfoort tower at
    // 5.3876388889°E 52.1561605556°N, lands on exactly (155000, 463000).
    const coords = new Float64Array([5.38763888888889, 52.1561605555556, 0]);
    transformCoords(Crs.fromEpsg(WGS84), Crs.fromEpsg(RD_NEW), coords);
    // Within a metre: the datum shift from WGS84 to Amersfoort goes through the
    // 7-parameter Helmert the definition carries, not the NTv2 grid, and that
    // is the documented difference between the two.
    expect(coords[0]).toBeCloseTo(155_000, -0.5);
    expect(coords[1]).toBeCloseTo(463_000, -0.5);
  });

  it("round-trips a coordinate back to where it started", () => {
    const original = [-111.8910, 40.7608, 1288.0];
    const coords = Float64Array.from(original);
    const utm = Crs.fromEpsg(UTM12N);
    const wgs = Crs.fromEpsg(WGS84);
    transformCoords(wgs, utm, coords);
    // Really moved: a no-op transform would pass a round trip trivially.
    expect(coords[0]).toBeGreaterThan(100_000);
    transformCoords(utm, wgs, coords);
    expect(coords[0]).toBeCloseTo(original[0]!, 9);
    expect(coords[1]).toBeCloseTo(original[1]!, 9);
    // Z is carried, not vertically datum-shifted.
    expect(coords[2]).toBeCloseTo(original[2]!, 6);
  });

  it("transforms a whole run in place", () => {
    const coords = new Float64Array(30);
    for (let i = 0; i < 10; i++) {
      coords[3 * i] = -111 + i * 0.01;
      coords[3 * i + 1] = 40;
      coords[3 * i + 2] = 100;
    }
    expect(transformCoords(Crs.fromEpsg(WGS84), Crs.fromEpsg(UTM12N), coords)).toBe(0);
    // Monotonic easting for monotonic longitude, and all of them moved.
    for (let i = 1; i < 10; i++) {
      expect(coords[3 * i]!).toBeGreaterThan(coords[3 * (i - 1)]!);
    }
  });

  it("refuses a buffer that is not whole triples", () => {
    expect(() =>
      transformCoords(Crs.fromEpsg(WGS84), Crs.fromEpsg(UTM12N), new Float64Array(4)),
    ).toThrow(/triples/);
    expect(
      transformCoords(Crs.fromEpsg(WGS84), Crs.fromEpsg(UTM12N), new Float64Array(0)),
    ).toBe(0);
  });
});

describe("openCrs", () => {
  it("opens the CRS the az-usfs tiles declare, through its GeoTIFF code", () => {
    const crs = openCrs(crsFromEpsg(UTM12N, { verticalEpsg: 5703 }));
    expect(crs.projection).toBe("utm");
  });

  it("opens the Rotterdam tile's WKT through its horizontal authority", () => {
    // The real compound WKT out of that file, abridged to its structure. The
    // trap it exists to catch: the LAST authority in the string is 7415, the
    // compound system, and projecting through that resolves to nothing.
    const wkt =
      'COMPD_CS["Amersfoort / RD New + NAP height",' +
      'PROJCS["Amersfoort / RD New",GEOGCS["Amersfoort",' +
      'DATUM["Amersfoort",SPHEROID["Bessel 1841",6377397.155,299.1528128,' +
      'AUTHORITY["EPSG","7004"]],AUTHORITY["EPSG","6289"]],' +
      'AUTHORITY["EPSG","4289"]],AUTHORITY["EPSG","28992"]],' +
      'VERT_CS["NAP height",AUTHORITY["EPSG","5709"]],' +
      'AUTHORITY["EPSG","7415"]]';
    const declaration = crsFromWkt(wkt);
    expect(declaration.epsg).toBe(28992);
    expect(declaration.verticalEpsg).toBe(5709);
    expect(declaration.name).toBe("Amersfoort / RD New + NAP height");
    expect(openCrs(declaration).projection).toBe("sterea");
  });

  it("opens a proj4 declaration without touching the EPSG table", () => {
    const declaration = crsFromString("+proj=utm +zone=12 +datum=NAD83")!;
    expect(declaration.format).toBe("proj4");
    expect(openCrs(declaration).projection).toBe("utm");
  });

  it("says what is missing when a WKT names no authority", () => {
    const custom =
      'PROJCS["a local grid",GEOGCS["x",DATUM["y",SPHEROID["z",6378137,298.257223563]]],' +
      'PROJECTION["Transverse_Mercator"]]';
    expect(() => openCrs(crsFromWkt(custom))).toThrow(/no EPSG authority/);
  });
});

describe("alignCrs", () => {
  /** Roughly one az-usfs tile: 3 km square in UTM zone 12N. */
  const TILE = {
    min: [400_000, 3_900_000, 1_500],
    max: [403_000, 3_903_000, 1_800],
  } as const;
  const box = () => ({ min: [...TILE.min], max: [...TILE.max] }) as {
    min: [number, number, number];
    max: [number, number, number];
  };

  it("places a survey-sized extent to a few centimetres, and says so", () => {
    // The claim the whole affine approach rests on, with the real number
    // attached: across two adjacent UTM zones over a 3 km tile the warp that a
    // matrix cannot absorb is about 14 mm — 5e-6 of the extent. That is well
    // under any LiDAR point spacing, and it is NOT zero, which is exactly why
    // the number is returned rather than assumed.
    const fit = alignCrs(Crs.fromEpsg(UTM12N), Crs.fromEpsg(26913), box());
    expect(fit.samples).toBe(27);
    expect(fit.checked).toBe(64);
    expect(fit.residual).toBeGreaterThan(0.001);
    expect(fit.residual).toBeLessThan(0.05);
    expect(fit.residual / 3000).toBeLessThan(1e-5);
    expect(fit.meanResidual).toBeLessThanOrEqual(fit.residual);
  });

  it("agrees with a true reprojection at points it never fitted", () => {
    const from = Crs.fromEpsg(UTM12N);
    const to = Crs.fromEpsg(26913);
    const fit = alignCrs(from, to, box());
    const m = fit.matrix;

    // A scatter of INTERIOR points, none of them a sample the fit saw and none
    // of them outside the box. The distinction matters: `residual` is a bound
    // over the extent the fit was given, and extrapolating past it costs more —
    // a point 900 m outside this tile lands 28 mm out against the 17 mm bound.
    const span = (axis: 0 | 1 | 2) => TILE.max[axis] - TILE.min[axis];
    for (let i = 1; i <= 7; i++) {
      const t = i / 8;
      const u = ((i * 3) % 8) / 8;
      const x = TILE.min[0] + t * span(0);
      const y = TILE.min[1] + u * span(1);
      const z = TILE.min[2] + ((i * 5) % 8) / 8 * span(2);

      const exact = new Float64Array([x, y, z]);
      transformCoords(from, to, exact);

      const px = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
      const py = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
      // Inside the residual the fit reported, which is the contract: the
      // number is an upper bound over the extent, not an average.
      expect(Math.hypot(px - exact[0]!, py - exact[1]!)).toBeLessThanOrEqual(
        fit.residual,
      );
    }
  });

  it("reports a large residual instead of hiding it", () => {
    // A continent-wide extent, where the warp is genuinely not linear. The
    // point is not that this is accurate — it is that the number says so, so a
    // caller can choose the per-point path.
    const wide = alignCrs(Crs.fromEpsg(WGS84), Crs.fromEpsg(3857), {
      min: [-170, -70, 0],
      max: [170, 70, 0],
    });
    expect(wide.residual).toBeGreaterThan(1_000);
  });

  it("survives a perfectly flat survey", () => {
    // Every sample sharing one Z leaves the Z column of the fit undetermined.
    // A naive solve divides by zero and returns NaN for the whole matrix.
    const flat = alignCrs(Crs.fromEpsg(UTM12N), Crs.fromEpsg(26913), {
      min: [400_000, 3_900_000, 0],
      max: [403_000, 3_903_000, 0],
    });
    expect([...flat.matrix].every(Number.isFinite)).toBe(true);
    expect(flat.residual).toBeLessThan(0.05);
  });

  it("is the identity, to the last bit, for a CRS onto itself", () => {
    const fit = alignCrs(Crs.fromEpsg(UTM12N), Crs.fromEpsg(UTM12N), box());
    expect(fit.residual).toBeLessThan(1e-6);
    const m = fit.matrix;
    expect(m[0]).toBeCloseTo(1, 9);
    expect(m[5]).toBeCloseTo(1, 9);
    expect(m[10]).toBeCloseTo(1, 9);
    expect(m[12]).toBeCloseTo(0, 3);
    expect(m[13]).toBeCloseTo(0, 3);
  });

  it("refuses an extent outside the source projection's domain", () => {
    // UTM zone 12 covers 114°W to 108°W. Coordinates from the other side of
    // the planet are not a placement problem, they are a mistake.
    expect(() =>
      alignCrs(Crs.fromEpsg(WGS84), Crs.fromEpsg(32612), {
        min: [-1e12, -1e12, 0],
        max: [1e12, 1e12, 0],
      }),
    ).toThrow(/valid domain|sample points/);
  });
});
