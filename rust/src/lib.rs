use serde::Serialize;
use wasm_bindgen::prelude::*;

const MAX_BYTES: usize = 8 * 1024 * 1024;
const MAX_POINTS: usize = 100_000;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Point {
    longitude: f64,
    latitude: f64,
    elevation: Option<f64>,
    distance_m: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Analysis {
    name: String,
    segments: Vec<Vec<Point>>,
    point_count: usize,
    distance_m: f64,
    ascent_m: f64,
    descent_m: f64,
    elevation_points: usize,
    elevation_pairs: usize,
    total_pairs: usize,
    min_elevation: Option<f64>,
    max_elevation: Option<f64>,
}

fn number(value: Option<&str>, label: &str) -> Result<f64, String> {
    let parsed = value
        .ok_or_else(|| format!("Missing {label}."))?
        .trim()
        .parse::<f64>()
        .map_err(|_| format!("Invalid {label}."))?;
    if !parsed.is_finite() {
        return Err(format!("{label} must be finite."));
    }
    Ok(parsed)
}

fn distance(a: &Point, b: &Point) -> f64 {
    let dlat = (b.latitude - a.latitude).to_radians();
    let dlon = (b.longitude - a.longitude).to_radians();
    let h = (dlat / 2.0).sin().powi(2)
        + a.latitude.to_radians().cos()
            * b.latitude.to_radians().cos()
            * (dlon / 2.0).sin().powi(2);
    6_371_008.8 * 2.0 * h.clamp(0.0, 1.0).sqrt().asin()
}

pub fn analyze(xml: &str) -> Result<Analysis, String> {
    if xml.len() > MAX_BYTES {
        return Err("GPX exceeds the 8 MiB limit.".into());
    }
    let document = roxmltree::Document::parse(xml).map_err(|e| format!("Invalid GPX XML: {e}"))?;
    let root = document.root_element();
    if root.tag_name().name() != "gpx" {
        return Err("Expected a GPX document, not another XML format.".into());
    }
    let mut result = Analysis {
        name: "Imported trail".into(),
        segments: vec![],
        point_count: 0,
        distance_m: 0.0,
        ascent_m: 0.0,
        descent_m: 0.0,
        elevation_points: 0,
        elevation_pairs: 0,
        total_pairs: 0,
        min_elevation: None,
        max_elevation: None,
    };
    let tracks: Vec<_> = root.children().filter(|n| n.has_tag_name("trk")).collect();
    let has_tracks = !tracks.is_empty();
    let containers: Vec<_> = if has_tracks {
        tracks
            .iter()
            .flat_map(|track| track.children().filter(|n| n.has_tag_name("trkseg")))
            .collect()
    } else {
        root.children().filter(|n| n.has_tag_name("rte")).collect()
    };
    let name_parent = if has_tracks {
        tracks.first().copied()
    } else {
        containers.first().copied()
    };
    if let Some(name) = name_parent.and_then(|parent| {
        parent
            .children()
            .find(|n| n.has_tag_name("name"))
            .and_then(|n| n.text())
    }) {
        result.name = name.trim().chars().take(160).collect();
        if result.name.is_empty() {
            result.name = "Imported trail".into();
        }
    }
    for container in containers {
        let mut segment: Vec<Point> = vec![];
        let point_tag = if has_tracks { "trkpt" } else { "rtept" };
        for node in container.children().filter(|n| n.has_tag_name(point_tag)) {
            result.point_count += 1;
            if result.point_count > MAX_POINTS {
                return Err("GPX exceeds the 100,000 point limit.".into());
            }
            let longitude = number(node.attribute("lon"), "longitude")?;
            let latitude = number(node.attribute("lat"), "latitude")?;
            if !(-180.0..=180.0).contains(&longitude) || !(-90.0..=90.0).contains(&latitude) {
                return Err("Coordinates are outside valid longitude/latitude ranges.".into());
            }
            let elevation = node
                .children()
                .find(|n| n.has_tag_name("ele"))
                .map(|n| number(n.text(), "elevation"))
                .transpose()?;
            if elevation.is_some_and(|value| !(-12_000.0..=10_000.0).contains(&value)) {
                return Err("Trail elevations must be between -12,000 and 10,000 meters.".into());
            }
            let mut point = Point {
                longitude,
                latitude,
                elevation,
                distance_m: result.distance_m,
            };
            if let Some(previous) = segment.last() {
                result.total_pairs += 1;
                result.distance_m += distance(previous, &point);
                point.distance_m = result.distance_m;
                if let (Some(a), Some(b)) = (previous.elevation, elevation) {
                    result.elevation_pairs += 1;
                    result.ascent_m += (b - a).max(0.0);
                    result.descent_m += (a - b).max(0.0);
                }
            }
            if let Some(e) = elevation {
                result.elevation_points += 1;
                result.min_elevation = Some(result.min_elevation.map_or(e, |v| v.min(e)));
                result.max_elevation = Some(result.max_elevation.map_or(e, |v| v.max(e)));
            }
            segment.push(point);
        }
        if !segment.is_empty() {
            result.segments.push(segment);
        }
    }
    if result.total_pairs == 0 {
        return Err("Include at least two points in a track segment or route. Waypoints alone are not a trail.".into());
    }
    Ok(result)
}

#[wasm_bindgen]
pub fn analyze_gpx(xml: &str) -> Result<String, JsValue> {
    let result = analyze(xml).map_err(|e| JsValue::from_str(&e))?;
    serde_json::to_string(&result).map_err(|e| JsValue::from_str(&e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_distance_and_climb() {
        let result = analyze(
            r#"<gpx><trk><name>Test</name><trkseg>
          <trkpt lat="0" lon="0"><ele>10</ele></trkpt>
          <trkpt lat="0" lon="1"><ele>110</ele></trkpt>
          <trkpt lat="0" lon="2"><ele>60</ele></trkpt>
        </trkseg></trk></gpx>"#,
        )
        .unwrap();
        assert!((result.distance_m - 222_390.16).abs() < 1.0);
        assert_eq!(result.ascent_m, 100.0);
        assert_eq!(result.descent_m, 50.0);
        assert_eq!(result.elevation_pairs, 2);
    }

    #[test]
    fn never_bridges_segments_or_missing_elevations() {
        let result = analyze(
            r#"<gpx><trk><trkseg>
          <trkpt lat="0" lon="0"><ele>0</ele></trkpt>
          <trkpt lat="0" lon="0.001"/>
          <trkpt lat="0" lon="0.002"><ele>100</ele></trkpt>
        </trkseg><trkseg>
          <trkpt lat="50" lon="50"><ele>900</ele></trkpt>
          <trkpt lat="50" lon="50.001"><ele>910</ele></trkpt>
        </trkseg></trk></gpx>"#,
        )
        .unwrap();
        assert!(result.distance_m < 400.0);
        assert_eq!(result.ascent_m, 10.0);
        assert_eq!(result.elevation_pairs, 1);
        assert_eq!(result.total_pairs, 3);
    }

    #[test]
    fn accepts_namespaced_routes_and_negative_elevation() {
        let result = analyze(
            r#"<gpx xmlns="http://www.topografix.com/GPX/1/1">
          <rte><rtept lat="0" lon="179.9"><ele>-5</ele></rtept>
          <rtept lat="0" lon="-179.9"><ele>0</ele></rtept></rte>
        </gpx>"#,
        )
        .unwrap();
        assert!(result.distance_m < 23_000.0);
        assert_eq!(result.min_elevation, Some(-5.0));
    }

    #[test]
    fn rejects_bad_data() {
        for xml in [
            "<not-gpx/>",
            "<gpx>",
            "<gpx><wpt lat=\"0\" lon=\"0\"/></gpx>",
            "<gpx><rte><rtept lat=\"91\" lon=\"0\"/></rte></gpx>",
            "<gpx><rte><rtept lat=\"NaN\" lon=\"0\"/></rte></gpx>",
            "<gpx><rte><rtept lat=\"0\" lon=\"0\"><ele>bad</ele></rtept></rte></gpx>",
            "<gpx><rte><rtept lat=\"0\" lon=\"0\"><ele>1e308</ele></rtept></rte></gpx>",
            "<!DOCTYPE gpx [<!ENTITY x 'bad'>]><gpx>&x;</gpx>",
        ] {
            assert!(analyze(xml).is_err(), "{xml}");
        }
    }

    #[test]
    fn enforces_limits() {
        assert!(analyze(&" ".repeat(MAX_BYTES + 1)).is_err());
        let xml = format!(
            "<gpx><rte>{}</rte></gpx>",
            r#"<rtept lat="0" lon="0"/>"#.repeat(MAX_POINTS + 1)
        );
        assert!(analyze(&xml).unwrap_err().contains("point limit"));
    }
}
