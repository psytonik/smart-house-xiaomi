import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inflateSync } from "node:zlib";
import { addDetail, decodeCloudMap, decodeLiveFrame, decodePiece, geometryOf, isGeometry, parsePath, renderMapPng, routeOf, toCells, VacuumMapError } from "../src/vacuumMap.js";
import { cloudFrame, cloudMapFile as cloudFile } from "./fakeCloud.js";

describe("cloud map file", () => {
  const cells = [
    0, 0, 0, 0,
    0, 129, 129, 0,
    0, 129, 1, 0,
    0, 0, 0, 0,
  ];

  it("reads size, cells, name and where the dock is", () => {
    // dock at 2 cells right of x=-100 and 3 cells below y=-200 (5 cm cells)
    const map = decodeCloudMap(cloudFile({ width: 4, height: 4, cells, name: "Милый дом", chargerMm: [0, -50] }));
    assert.equal(map.name, "Милый дом");
    assert.equal(map.mapId, 95);
    assert.equal(map.width, 4);
    assert.equal(map.height, 4);
    assert.equal(map.gridMm, 50);
    assert.deepEqual([...map.cells], cells);
    assert.deepEqual(map.charger, { x: 2, y: 3 });
    assert.equal(map.robot, undefined, "a zero position means unknown");
  });

  it("ignores a dock that is outside the map", () => {
    const map = decodeCloudMap(cloudFile({ width: 4, height: 4, cells, chargerMm: [5000, 5000] }));
    assert.equal(map.charger, undefined);
  });

  it("rejects files that are not maps", () => {
    assert.throws(() => decodeCloudMap("nope"), VacuumMapError);
    assert.throws(() => decodeCloudMap("{}"), VacuumMapError);
    assert.throws(() => decodeCloudMap(JSON.stringify({ mapstr: [{ map: "AAAA" }] })), VacuumMapError);
    // header says 40x40 but the cells are missing
    const short = cloudFile({ width: 40, height: 40, cells: [1, 1] });
    assert.throws(() => decodeCloudMap(short), VacuumMapError);
  });

  it("refuses a map that claims to be absurdly large, before drawing anything", () => {
    const huge = cloudFile({ width: 3000, height: 1500, cells: new Array(4_500_000).fill(1) });
    assert.throws(() => decodeCloudMap(huge), /too large/);
  });
});

describe("map picture", () => {
  const map = decodeCloudMap(
    cloudFile({ width: 3, height: 2, cells: [0, 129, 1, 1, 1, 0] }),
  );

  /** Pixel colour from a PNG made by renderMapPng (8-bit RGBA, filter 0). */
  function pixels(png: Buffer) {
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    const w = png.readUInt32BE(16);
    const h = png.readUInt32BE(20);
    assert.deepEqual([...png.subarray(24, 29)], [8, 6, 0, 0, 0]);
    const idatLen = png.readUInt32BE(33);
    assert.equal(png.subarray(37, 41).toString("ascii"), "IDAT");
    const raw = inflateSync(png.subarray(41, 41 + idatLen));
    const at = (x: number, y: number) => [...raw.subarray(y * (w * 4 + 1) + 1 + x * 4, y * (w * 4 + 1) + 1 + x * 4 + 4)];
    return { w, h, at };
  }

  it("draws outside transparent, walls light and floor dark, at the asked scale", () => {
    const { w, h, at } = pixels(renderMapPng(map, 2));
    assert.equal(w, 6);
    assert.equal(h, 4);
    // the file lists rows bottom-up (the robot's Y points up), so the picture shows them in reverse
    assert.equal(at(4, 0)[3], 0, "outside is see-through");
    assert.deepEqual(at(2, 2), [170, 190, 225, 255], "wall");
    assert.deepEqual(at(0, 0), [54, 70, 98, 255], "floor");
    assert.deepEqual(at(5, 3), [54, 70, 98, 255], "scale repeats the cell");
  });

  it("marks the dock", () => {
    const withDock = decodeCloudMap(cloudFile({ width: 20, height: 20, cells: new Array(400).fill(1), chargerMm: [0, 0 + 100] }));
    // (0,100)mm is not "unknown", so it lands in a cell
    assert.ok(withDock.charger);
    const { w, at } = pixels(renderMapPng(withDock, 4));
    const x = Math.round((withDock.charger!.x + 0.5) * 4);
    const y = Math.round((withDock.height - 1 - withDock.charger!.y + 0.5) * 4); // rows are drawn bottom-up
    assert.ok(x < w);
    assert.deepEqual(at(x, y), [60, 200, 120, 255]);
  });
});

describe("live frames", () => {
  it("reads a trail: absolute points and steps from the last point", () => {
    assert.deepEqual(parsePath("M-3000,3400L10,-5L-4,2l-100,200"), [
      { x: -3000, y: 3400 },
      { x: -2990, y: 3395 },
      { x: -2994, y: 3397 },
      { x: -100, y: 200 },
    ]);
    assert.deepEqual(parsePath(""), []);
    assert.deepEqual(parsePath("nonsense"), []);
  });

  it("reads where the robot is and the trail from a frame; zero means unknown", () => {
    const frame = decodeLiveFrame(cloudFrame({ robotMm: [-2993, 3462], trail: "S-3000,3400L5,5", frameId: 7 }));
    assert.equal(frame.frameId, 7);
    assert.deepEqual(frame.robot, { x: -2993, y: 3462 });
    assert.equal(frame.path.length, 2);
    assert.equal(decodeLiveFrame(cloudFrame({})).robot, undefined);
    assert.deepEqual(decodeLiveFrame(cloudFrame({ robotMm: [1, 1] })).path, []);
  });

  it("places millimetres on the picture in cells", () => {
    const map = decodeCloudMap(cloudFile({ width: 4, height: 4, cells: new Array(16).fill(1) })); // origin (-100, -200), 5 cm cells
    const g = geometryOf(map);
    // Y is flipped: the map is 4 rows tall and the picture is drawn bottom-up
    assert.deepEqual(toCells(g, { x: -100, y: -200 }), { x: 0, y: 4 });
    assert.deepEqual(toCells(g, { x: 0, y: 100 }), { x: 2, y: -2 });
    assert.equal(isGeometry(g), true);
    assert.equal(isGeometry({ width: 1 }), false);
    assert.equal(isGeometry({ ...g, gridMm: 0 }), false);
    assert.equal(isGeometry(null), false);
  });
});

describe("detail from the robot's map pieces", () => {
  const base = () => decodeCloudMap(cloudFile({ width: 4, height: 4, cells: new Array(16).fill(1) })); // origin (-100, -200), 5 cm cells
  const piece = (leftMm: number, topMm: number, width: number, height: number, cells: number[], trail = "") =>
    decodePiece(cloudFrame({ piece: { leftMm, topMm, width, height, cells }, trail }));

  it("reads a piece: where it sits, its cells and its trail", () => {
    const p = piece(-50, -150, 2, 1, [8, 248], "M0,0L50,0");
    assert.equal(p.mapId, 5);
    assert.equal(p.gridMm, 50);
    assert.deepEqual([p.leftMm, p.topMm, p.width, p.height], [-50, -150, 2, 1]);
    assert.deepEqual([...p.cells], [8, 248]);
    assert.deepEqual(p.path, [{ x: 0, y: 0 }, { x: 50, y: 0 }]);
    assert.deepEqual(decodePiece(cloudFrame({})).cells.length, 0, "a piece without cells is fine");
  });

  it("lays objects and wall edges over the saved map, and ignores what does not fit or is not known", () => {
    // one cell right and one down from the origin: an object, a wall edge, a value nobody knows, then one off the map
    const saved = base();
    const m = addDetail(saved, [piece(-50, -150, 4, 1, [8, 248, 77, 252])]);
    assert.equal(m.obstacles![1 * 4 + 1], 1);
    assert.equal(m.cells[1 * 4 + 2], 129);
    assert.equal(m.cells[1 * 4 + 3], 1, "an unknown value changes nothing");
    assert.equal(m.cells.length, 16, "the one past the edge is dropped");
    assert.equal(saved.cells[1 * 4 + 1], 1, "the saved map itself is not touched");
  });

  it("lets a newer piece win: a wall edge replaces an object", () => {
    const m = addDetail(base(), [piece(-100, -200, 1, 1, [8]), piece(-100, -200, 1, 1, [4])]);
    assert.equal(m.cells[0], 129);
    assert.equal(m.obstacles![0], 0);
  });

  it("puts objects only on the floor, never outside the apartment or on a wall", () => {
    const outline = decodeCloudMap(cloudFile({ width: 3, height: 1, cells: [0, 129, 1] }));
    const m = addDetail(outline, [piece(-100, -200, 3, 1, [8, 8, 8])]);
    assert.deepEqual([...m.obstacles!], [0, 0, 1]);
  });

  it("does not take a room number for an object", () => {
    // in a map with several rooms the low bits of a cell say which room it is: room 2 is floor, not furniture
    const rooms = decodeCloudMap(cloudFile({ width: 2, height: 1, cells: [2, 3] }));
    const png = renderMapPng(addDetail(rooms, []), 1);
    const raw = inflateSync(png.subarray(41, 41 + png.readUInt32BE(33)));
    assert.deepEqual([...raw.subarray(1, 5)], [54, 70, 98, 255]);
    assert.deepEqual([...raw.subarray(5, 9)], [54, 70, 98, 255]);
  });

  it("draws objects grey and the route as a line", () => {
    const withObstacle = addDetail(base(), [piece(-100, -200, 1, 1, [8])]);
    // route: from (-100,-150) mm to (0,-150) mm = picture cells (0,3) to (2,3)
    const route = routeOf(geometryOf(withObstacle), [piece(0, 0, 0, 0, [], "M-100,-150L100,0")]);
    const png = renderMapPng(withObstacle, 4, undefined, route);
    const raw = inflateSync(png.subarray(41, 41 + png.readUInt32BE(33)));
    const w = png.readUInt32BE(16);
    const at = (x: number, y: number) => [...raw.subarray(y * (w * 4 + 1) + 1 + x * 4, y * (w * 4 + 1) + 1 + x * 4 + 4)];
    // file cell (0,0) is the bottom-left of the picture: pixels x 0-3, y 12-15
    assert.deepEqual(at(3, 15), [136, 148, 176, 255], "the object is grey");
    assert.deepEqual(at(6, 12), [225, 232, 255, 255], "the route is a light line");
    assert.deepEqual(at(10, 6), [54, 70, 98, 255], "floor elsewhere is unchanged");
  });

  it("starts a new line where the robot jumps inside one piece, so no straight line is drawn across the home", () => {
    const g = geometryOf(base());
    const lines = routeOf(g, [piece(0, 0, 0, 0, [], "M0,0M5000,0L50,0")]); // two absolute points far apart, then a step
    assert.equal(lines.length, 2);
    assert.equal(lines[0]!.length, 1);
    assert.equal(lines[1]!.length, 2);
  });

  it("joins pieces into one line unless the robot jumped more than a metre", () => {
    const g = geometryOf(base());
    const lines = routeOf(g, [piece(0, 0, 0, 0, [], "M0,0L100,0"), piece(0, 0, 0, 0, [], "M150,0L100,0"), piece(0, 0, 0, 0, [], "M5000,0")]);
    assert.equal(lines.length, 2);
    assert.equal(lines[0]!.length, 4, "the second piece continues the first line");
    assert.equal(lines[1]!.length, 1);
  });
});
