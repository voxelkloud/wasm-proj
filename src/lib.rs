//! Coordinate reprojection for voxelkloud, compiled to wasm.
//!
//! Two point clouds surveyed in different coordinate reference systems do not
//! line up, and no amount of care in the loader fixes that: the numbers in the
//! two files mean different things. This is the crate that makes them mean the
//! same thing.
//!
//! Over [proj4rs](https://github.com/3liz/proj4rs), a Rust adaptation of proj4.
//! The alternative is PROJ itself through Emscripten — a C build, a multi-megabyte
//! artefact and a filesystem shim for the grid files. None of that is here.
//!
//! WHAT IS DELIBERATELY MISSING: datum grid shifts. proj4rs supports NADCON and
//! NTv2 grids, but they are files, they are large, and fetching them is a
//! transport decision this crate has no business making. Without them a datum
//! transformation falls back to the 7-parameter Helmert the CRS declares, which
//! is what proj4js does too, and which is accurate to a metre or so where a
//! grid would give centimetres. [`transform_coords`] cannot detect that
//! difference, so callers who need survey-grade datum shifts should know it is
//! not what they are getting.
//!
//! ANGULAR UNITS: proj4rs works in radians. Everything crossing this boundary
//! is in DEGREES, which is what a file, a user and proj4js all mean by a
//! longitude — the conversion happens here so no caller has to remember.

use proj4rs::transform::{transform, Transform, TransformClosure};
use proj4rs::Proj;
use wasm_bindgen::prelude::*;

fn err(e: impl std::fmt::Display) -> JsError {
    JsError::new(&e.to_string())
}

/// One coordinate reference system, ready to transform through.
///
/// Built once and reused: parsing a proj string means resolving an ellipsoid, a
/// datum and a projection, and doing it per node would dwarf the arithmetic.
#[wasm_bindgen]
pub struct Crs {
    proj: Proj,
}

#[wasm_bindgen]
impl Crs {
    /// Build from a proj4 string: `"+proj=utm +zone=12 +datum=NAD83"`.
    #[wasm_bindgen(js_name = fromProjString)]
    pub fn from_proj_string(definition: &str) -> Result<Crs, JsError> {
        Ok(Crs {
            proj: Proj::from_proj_string(definition).map_err(err)?,
        })
    }

    /// Build from an EPSG code.
    ///
    /// Codes come from the bundled table, which covers the EPSG registry's
    /// projected and geographic systems. A code the table does not have is an
    /// error naming the code rather than a silently wrong projection.
    #[wasm_bindgen(js_name = fromEpsg)]
    pub fn from_epsg(code: u32) -> Result<Crs, JsError> {
        // The table is indexed by u16. Codes above that exist in the registry
        // but none of them are a horizontal CRS a point cloud is stored in.
        let narrow = u16::try_from(code).map_err(|_| {
            JsError::new(&format!(
                "EPSG:{code} is outside the range of codes this table indexes (0-65535)."
            ))
        })?;
        Proj::from_epsg_code(narrow)
            .map(|proj| Crs { proj })
            .map_err(|_| {
                JsError::new(&format!(
                    "EPSG:{code} is not in the bundled EPSG table. Pass the proj4 \
                     string instead if you have it."
                ))
            })
    }

    /// `"utm"`, `"longlat"`, `"sterea"`. The projection's own short name.
    #[wasm_bindgen(getter)]
    pub fn projection(&self) -> String {
        self.proj.projname().to_string()
    }

    /// True when coordinates in this system are angles, not metres.
    #[wasm_bindgen(getter, js_name = isLatLong)]
    pub fn is_lat_long(&self) -> bool {
        self.proj.is_latlong()
    }

    /// `"m"`, `"degrees"`, `"us-ft"`. What one unit of this system is.
    #[wasm_bindgen(getter)]
    pub fn units(&self) -> String {
        self.proj.units().to_string()
    }

    /// Metres per unit. 1 for a metric projection, 0.3048006... for US feet.
    #[wasm_bindgen(getter, js_name = toMeter)]
    pub fn to_meter(&self) -> f64 {
        self.proj.to_meter()
    }
}

/// A run of XYZ triples, transformed in place.
///
/// The `Transform` implementations proj4rs ships are for single tuples. This is
/// the bulk one, and it differs in a way that matters: it does NOT stop at the
/// first point that fails. A point outside a projection's domain is a property
/// of that point, and aborting a whole node over one of them would turn a
/// blemish into a hole.
struct Triples<'a> {
    coords: &'a mut [f64],
    /// How many points could not be transformed. They are left as NaN.
    failed: u32,
}

impl Transform for Triples<'_> {
    fn transform_coordinates<F: TransformClosure>(
        &mut self,
        f: &mut F,
    ) -> proj4rs::errors::Result<()> {
        for point in self.coords.chunks_exact_mut(3) {
            match f(point[0], point[1], point[2]) {
                Ok((x, y, z)) => {
                    point[0] = x;
                    point[1] = y;
                    point[2] = z;
                }
                Err(_) => {
                    // NaN rather than the input value: a coordinate that could
                    // not be reprojected is not "approximately where it was",
                    // it is unknown, and a renderer drops NaN instead of
                    // drawing a point in the wrong country.
                    self.failed += 1;
                    point[0] = f64::NAN;
                    point[1] = f64::NAN;
                    point[2] = f64::NAN;
                }
            }
        }
        Ok(())
    }
}

const DEG_PER_RAD: f64 = 180.0 / std::f64::consts::PI;

/// Reproject XYZ triples from one system to another, in place.
///
/// `coords` is `[x, y, z, x, y, z, ...]`, and angular systems are in DEGREES on
/// both sides. Returns how many points could NOT be transformed; those come
/// back as NaN. A return of 0 means every point moved.
///
/// Z is carried through the projection but NOT datum-shifted vertically: a
/// height above one vertical datum is not a height above another, and nothing
/// in a horizontal CRS declaration says how to convert between them.
#[wasm_bindgen(js_name = transformCoords)]
pub fn transform_coords(
    from: &Crs,
    to: &Crs,
    coords: &mut [f64],
) -> Result<u32, JsError> {
    if coords.len() % 3 != 0 {
        return Err(JsError::new(&format!(
            "transformCoords wants whole XYZ triples; got {} values.",
            coords.len()
        )));
    }
    if coords.is_empty() {
        return Ok(0);
    }

    // Degrees in, radians through, degrees out. proj4rs is radian-native and
    // every caller of this is not.
    if from.proj.is_latlong() {
        for point in coords.chunks_exact_mut(3) {
            point[0] = point[0].to_radians();
            point[1] = point[1].to_radians();
        }
    }

    let mut triples = Triples { coords, failed: 0 };
    transform(&from.proj, &to.proj, &mut triples).map_err(err)?;
    let failed = triples.failed;

    if to.proj.is_latlong() {
        for point in coords.chunks_exact_mut(3) {
            point[0] *= DEG_PER_RAD;
            point[1] *= DEG_PER_RAD;
        }
    }

    Ok(failed)
}
